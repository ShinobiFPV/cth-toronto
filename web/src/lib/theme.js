// Appearance: light/dark, and the accent colour.
//
// Two things make this more than a class toggle.
//
// The palette is entirely CSS custom properties on :root, with a [data-theme="light"]
// block overriding the tokens — so switching mode is one attribute and the browser does
// the rest. Light mode is not a new design: it is the original ShinTech house style,
// Arctic Classified on paper. Dark is the after-dark variant this app was built in.
//
// The accent is four derived values, not one. A hard offset shadow needs a darker shade
// of the accent, and text sitting on an accent fill has to flip between black and white
// depending on what the player picked — so `--accent-deep` and `--accent-ink` are
// computed from the hex rather than hand-listed, which is what makes an arbitrary
// accent safe.
//
// Stored per device in localStorage: appearance is a property of the screen you are
// looking at, not of your account, and it never needs to reach the server.

const KEY = 'cth.appearance';

export const MODES = ['system', 'light', 'dark'];

/**
 * Accents chosen to hold up on paper AND after dark, which rules out anything very pale
 * or very deep. Player colours are handed out by the server and are not affected by
 * this — the accent only ever dresses the chrome.
 */
export const ACCENTS = [
  { key: 'amber', name: 'Hazard amber', hex: '#FFB020' },
  { key: 'red', name: 'Signal red', hex: '#E4453C' },
  { key: 'azure', name: 'Azure', hex: '#2E9BE0' },
  { key: 'teal', name: 'Teal', hex: '#12B5A6' },
  { key: 'lime', name: 'Lime', hex: '#8CC63F' },
  { key: 'violet', name: 'Violet', hex: '#9B6BE0' },
  { key: 'pink', name: 'Hot pink', hex: '#FF4FA3' },
  { key: 'slate', name: 'Ice', hex: '#7FA8C9' },
];

export const DEFAULT_APPEARANCE = { mode: 'dark', accent: 'amber' };

const accentByKey = (key) => ACCENTS.find((a) => a.key === key) ?? ACCENTS[0];

// ── colour maths ──────────────────────────────────────────────────────────

const toRgb = (hex) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};

const toHex = ([r, g, b]) =>
  `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

/** WCAG relative luminance, for deciding whether text on this colour is black or white. */
function luminance([r, g, b]) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast between two relative luminances. */
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

const darken = (rgb, amount) => rgb.map((v) => v * (1 - amount));
const lighten = (rgb, amount) => rgb.map((v) => v + (255 - v) * amount);

/**
 * Nudge a colour until it clears `ratio` against a background of luminance `bgLum`,
 * moving whichever direction there is room in.
 *
 * This is what makes an arbitrary accent safe as TEXT. Hazard amber is perfect on black
 * and all but invisible on white — 1.9:1 — so on paper the accent has to be deepened
 * before it can carry a word rather than a fill. The house style puts it more briefly:
 * "on paper, bright means deeper".
 */
function forContrast(rgb, bgLum, ratio = 4.5) {
  const needsDarker = bgLum > 0.35;
  // Both branches solve the WCAG ratio against the background ACTUALLY given. An earlier
  // version hardcoded white in the darken branch, which was invisible while the only
  // caller passed white and then quietly under-darkened player colours against the
  // off-white desk.
  const target = needsDarker
    ? ((bgLum + 0.05) / ratio) - 0.05   // brightest that still passes on this paper
    : ratio * (bgLum + 0.05) - 0.05;    // dimmest that passes on this dark surface
  let out = rgb;
  for (let i = 0; i < 24; i++) {
    const lum = luminance(out);
    if (needsDarker ? lum <= target : lum >= target) break;
    out = needsDarker ? darken(out, 0.08) : lighten(out, 0.08);
  }
  return out;
}

/**
 * Every value an accent needs, for a given resolved theme.
 *
 * `--accent` is the raw colour: fills, borders, and text on the black chrome bars.
 * `--accent-text` is the same colour adjusted to read as text on this theme's paper,
 * which on a light theme means noticeably deeper.
 */
export function accentTokens(hex, resolved = 'dark') {
  const rgb = toRgb(hex);
  const lum = luminance(rgb);
  // Luminance of the surface that accent-coloured text actually sits on, per theme.
  const paperLum = resolved === 'light' ? 1.0 : 0.0086;
  return {
    '--accent': hex,
    '--accent-rgb': rgb.join(', '),
    // Targeted at 6:1 rather than the 4.5:1 minimum, deliberately. Accent-coloured
    // text is often small (10-11px map labels, table cells) and does not always sit on
    // pure white — the off-white desk and the accent-tinted "this is you" table row
    // both eat about half a point of contrast. 6:1 against white leaves enough headroom
    // that every one of those still clears AA.
    '--accent-text': toHex(forContrast(rgb, paperLum, 6)),
    // The hard offset shadow under a primary button. Deeper for a light accent so the
    // shadow still reads, gentler for one that is already dark.
    '--accent-deep': toHex(darken(rgb, lum > 0.45 ? 0.38 : 0.28)),
    // Text ON the accent fill — a primary button's label. Measured rather than guessed:
    // an earlier version picked by a luminance threshold and chose white for every
    // mid-tone accent, which put 2.5:1 labels on the teal and azure buttons. Black is
    // the better choice far further up the scale than it looks like it should be.
    '--accent-ink': contrast(lum, 0) >= contrast(lum, 1) ? '#0B0D10' : '#FFFFFF',
  };
}

// ── storage ───────────────────────────────────────────────────────────────

export function loadAppearance() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    const saved = JSON.parse(raw);
    return {
      mode: MODES.includes(saved.mode) ? saved.mode : DEFAULT_APPEARANCE.mode,
      accent: ACCENTS.some((a) => a.key === saved.accent) ? saved.accent : DEFAULT_APPEARANCE.accent,
    };
  } catch {
    // Private windows, cleared site data, and browsers set to block storage all land
    // here. The app has to render correctly with no stored value.
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(appearance) {
  try {
    localStorage.setItem(KEY, JSON.stringify(appearance));
  } catch { /* not being able to remember is not worth breaking the toggle over */ }
}

// ── applying ──────────────────────────────────────────────────────────────

const systemPrefersDark = () => {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
};

/** 'system' resolved against the OS setting; 'light'/'dark' pass straight through. */
export const resolveMode = (mode) =>
  (mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode);

/**
 * Write the appearance onto <html>. Called before React mounts as well as on every
 * change, so there is no flash of the wrong theme on load.
 */
export function applyAppearance(appearance) {
  const root = document.documentElement;
  const resolved = resolveMode(appearance.mode);

  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-accent', appearance.accent);
  root.style.colorScheme = resolved;

  for (const [name, value] of
       Object.entries(accentTokens(accentByKey(appearance.accent).hex, resolved))) {
    root.style.setProperty(name, value);
  }

  // The PWA's status bar and task-switcher colour should follow the theme too.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content',
      getComputedStyle(root).getPropertyValue('--chrome').trim() || (resolved === 'dark' ? '#05070A' : '#000000'));
  }

  return resolved;
}

/**
 * A player's colour, deepened just enough to be readable as TEXT on this theme's
 * background. Same hue, so you can still tell whose Hood it is at a glance.
 *
 * Player colours come from the server and were picked for a dark map, so on paper the
 * brighter ones land around 2.7:1 as a label. Territory FILLS keep the exact colour the
 * server sent — this is only ever applied to the number drawn on top of them.
 */
export const textSafe = (hex, resolved = 'dark') =>
  toHex(forContrast(toRgb(hex), resolved === 'light' ? 0.8 : 0.0086, 4.5));

/** Read a CSS custom property, for the places Leaflet needs a real colour string. */
export const cssVar = (name, fallback = '') =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/**
 * Watch the OS setting, so 'system' actually follows it while the app is open.
 * Returns an unsubscribe.
 */
export function onSystemThemeChange(handler) {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  } catch {
    return () => {};
  }
}
