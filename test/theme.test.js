// The appearance engine. Everything here is pure colour maths, which is exactly why it
// is worth testing: the accent is player-chosen, so the readability of half the UI is
// decided by these functions rather than by anything a designer looked at.
//
// theme.js touches `document` and `localStorage` only inside functions, so it imports
// cleanly under `node --test` with no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCENTS, MODES, DEFAULT_APPEARANCE, accentTokens, textSafe, loadAppearance,
} from '../web/src/lib/theme.js';

const AA = 4.5;
const LIGHT_PAPER = '#FFFFFF';
const DARK_PAPER = '#14181D';   // --surface, the panel accent text actually sits on

const toRgb = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const luminance = ([r, g, b]) => {
  const c = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
const ratio = (a, b) => {
  const [lo, hi] = [luminance(toRgb(a)), luminance(toRgb(b))].sort((x, y) => x - y);
  return (hi + 0.05) / (lo + 0.05);
};
const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v);

test('the accent list is well formed and has no duplicates', () => {
  assert.ok(ACCENTS.length >= 4, 'a one-colour "customizer" is not one');
  for (const a of ACCENTS) {
    assert.ok(isHex(a.hex), `${a.key} is not a 6-digit hex: ${a.hex}`);
    assert.ok(a.name && a.key, 'every accent needs a key and a human name');
  }
  assert.equal(new Set(ACCENTS.map((a) => a.key)).size, ACCENTS.length);
  assert.equal(new Set(ACCENTS.map((a) => a.hex.toLowerCase())).size, ACCENTS.length);
  assert.ok(ACCENTS.some((a) => a.key === DEFAULT_APPEARANCE.accent), 'the default must exist');
  assert.ok(MODES.includes(DEFAULT_APPEARANCE.mode));
});

test('accentTokens returns every variable the stylesheet expects', () => {
  const tokens = accentTokens('#FFB020', 'dark');
  for (const name of ['--accent', '--accent-rgb', '--accent-text', '--accent-deep', '--accent-ink']) {
    assert.ok(name in tokens, `missing ${name}`);
  }
  assert.equal(tokens['--accent'], '#FFB020', 'the raw accent is passed through untouched');
  assert.equal(tokens['--accent-rgb'], '255, 176, 32', 'needed for rgba() tints');
  assert.ok(isHex(tokens['--accent-text']));
  assert.ok(isHex(tokens['--accent-deep']));
});

// The whole point of the feature: an arbitrary accent must stay legible. Amber is the
// hard case — gorgeous on black, 1.8:1 on white.
test('every accent clears AA as text in both themes', () => {
  for (const a of ACCENTS) {
    const onPaper = accentTokens(a.hex, 'light')['--accent-text'];
    const onDark = accentTokens(a.hex, 'dark')['--accent-text'];
    assert.ok(ratio(onPaper, LIGHT_PAPER) >= AA,
      `${a.key} as text on paper: ${ratio(onPaper, LIGHT_PAPER).toFixed(2)}:1`);
    assert.ok(ratio(onDark, DARK_PAPER) >= AA,
      `${a.key} as text after dark: ${ratio(onDark, DARK_PAPER).toFixed(2)}:1`);
  }
});

test('every accent clears AA as a button label on its own fill', () => {
  for (const a of ACCENTS) {
    const ink = accentTokens(a.hex, 'light')['--accent-ink'];
    assert.ok(ratio(ink, a.hex) >= AA,
      `${a.key} label on fill: ${ratio(ink, a.hex).toFixed(2)}:1 (picked ${ink})`);
  }
});

test('accent-ink is picked by measurement, not by a luminance guess', () => {
  // A naive `luminance > 0.45 ? black : white` split puts white on teal, which measures
  // 2.57:1. Mid-tones want black far further up the scale than they look like they do.
  assert.equal(accentTokens('#12B5A6', 'dark')['--accent-ink'], '#0B0D10', 'teal wants black');
  assert.equal(accentTokens('#FFB020', 'dark')['--accent-ink'], '#0B0D10', 'amber wants black');
  assert.equal(accentTokens('#3B2A6E', 'dark')['--accent-ink'], '#FFFFFF', 'deep indigo wants white');
});

test('accent-text deepens on paper and lifts after dark', () => {
  const amber = toRgb('#FFB020');
  const onPaper = toRgb(accentTokens('#FFB020', 'light')['--accent-text']);
  assert.ok(luminance(onPaper) < luminance(amber), 'on paper, bright means deeper');

  // A dark accent has to go the other way to be readable on a dark surface.
  const indigo = toRgb('#3B2A6E');
  const lifted = toRgb(accentTokens('#3B2A6E', 'dark')['--accent-text']);
  assert.ok(luminance(lifted) > luminance(indigo), 'after dark, deep means lighter');
});

test('a colour already contrasty enough is left alone', () => {
  // No pointless mangling: white on a dark surface passes at 6:1 already.
  assert.equal(accentTokens('#FFFFFF', 'dark')['--accent-text'].toLowerCase(), '#ffffff');
});

test('accentTokens accepts 3-digit hex', () => {
  assert.equal(accentTokens('#fb0', 'dark')['--accent-rgb'], '255, 187, 0');
});

// textSafe is the same maths aimed at a different problem: player colours come from the
// server, were chosen for a dark map, and have to carry a Hood number on light paper.
test('textSafe makes every player colour readable on the light desk', () => {
  const DESK = '#E9E9E6';
  // The server's palette, the bright end first.
  for (const colour of ['#FFD400', '#43D9AD', '#5AC8FA', '#FF6B6B', '#B388FF', '#FF9F1C']) {
    const safe = textSafe(colour, 'light');
    assert.ok(ratio(safe, DESK) >= AA,
      `${colour} -> ${safe} on the desk: ${ratio(safe, DESK).toFixed(2)}:1`);
  }
});

test('textSafe keeps the hue so you can still tell whose Hood it is', () => {
  const safe = toRgb(textSafe('#FFD400', 'light'));   // yellow
  assert.ok(safe[0] > safe[2] && safe[1] > safe[2], 'still warm, not muddied to grey');
});

test('loadAppearance falls back cleanly with no storage at all', () => {
  // Under node there is no localStorage, which is the same code path as a private window
  // or a browser set to block site data. It must not throw.
  const loaded = loadAppearance();
  assert.ok(MODES.includes(loaded.mode));
  assert.ok(ACCENTS.some((a) => a.key === loaded.accent));
});

test('loadAppearance rejects junk from storage instead of applying it', () => {
  const original = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  try {
    store.set('cth.appearance', JSON.stringify({ mode: 'neon', accent: 'chartreuse' }));
    assert.deepEqual(loadAppearance(), DEFAULT_APPEARANCE, 'unknown values fall back per field');

    store.set('cth.appearance', JSON.stringify({ mode: 'light', accent: 'chartreuse' }));
    assert.equal(loadAppearance().mode, 'light', 'a valid field survives beside a bad one');
    assert.equal(loadAppearance().accent, DEFAULT_APPEARANCE.accent);

    store.set('cth.appearance', 'not json at all');
    assert.deepEqual(loadAppearance(), DEFAULT_APPEARANCE, 'a corrupt blob is not fatal');
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
});
