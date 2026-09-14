#!/usr/bin/env node
// Synthesises the default sound set: sixteen cues and one map loop.
//
//   node scripts/make-sounds.js                     # WAVs to build/sounds, encode if ffmpeg is here
//   node scripts/make-sounds.js --wav-dir <dir>     # WAVs somewhere else
//   node scripts/make-sounds.js --no-encode         # WAVs only, even if ffmpeg exists
//
// Why synthesised: the repo is public, and anything under CC-BY drags an attribution
// obligation into it. Every sound here is generated from arithmetic in this file, so the
// set is our own work and released CC0 — and the licence is written into defaults.json
// per file, so a future you can prove it.
//
// It writes 16-bit WAVs, and web/public/audio/defaults.json (file names, gains, durations,
// licence). If ffmpeg is on PATH (or CTH_FFMPEG), it also encodes them to AAC in .m4a —
// mono 96k for cues, stereo 128k for the loop — straight into web/public/audio. Without
// ffmpeg it prints the commands; any machine with ffmpeg (the Pi has it) can run them.
//
// Every cue starts on its first sample — leading silence reads as input lag — and the set
// is normalised to peak levels chosen per cue: the chat blip is quiet, the Hologram pull and
// the Fortify hit are the loudest things in the app.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO_DIR = path.join(ROOT, 'web', 'public', 'audio');
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const WAV_DIR = path.resolve(flag('--wav-dir', path.join(ROOT, 'build', 'sounds')));
const LICENCE = 'CC0 — synthesised for Park-E-Mans GO! by scripts/make-sounds.js';

const SR = 44100;
const TAU = Math.PI * 2;
const midi = (m) => 440 * 2 ** ((m - 69) / 12);

// A fixed noise table, so a render is identical every time.
const NOISE = (() => {
  const table = new Float32Array(SR * 2);
  let s = 0x2545F491;
  for (let i = 0; i < table.length; i += 1) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    table[i] = ((s >>> 0) / 4294967296) * 2 - 1;
  }
  return table;
})();

const wave = {
  sine: (p) => Math.sin(TAU * p),
  tri: (p) => { const x = p - Math.floor(p); return 1 - 4 * Math.abs(x - 0.5); },
  square: (p) => ((p - Math.floor(p)) < 0.5 ? 0.7 : -0.7),
  saw: (p) => 2 * (p - Math.floor(p)) - 1,
};

/**
 * One voice: a note (or a sweep) with an attack and an exponential decay. Returns a
 * function of absolute time, zero outside its own window.
 */
function voice({ at = 0, len, f, f2 = f, shape = 'sine', amp = 1, attack = 0.003, decay = len, vibrato = 0 }) {
  const tail = decay * 4;
  return (t) => {
    const u = t - at;
    if (u < 0 || u > len + tail) return 0;
    const k = Math.min(u, len);
    // Integrated linear sweep, so the pitch glides without clicks.
    let phase = f * k + ((f2 - f) * k * k) / (2 * len) + (u > len ? f2 * (u - len) : 0);
    if (vibrato) phase += (vibrato / 6) * Math.sin(TAU * 6 * u);
    const env = (u < attack ? u / attack : Math.exp(-(u - attack) / decay))
      * (u > len ? Math.exp(-(u - len) / 0.015) : 1);
    return amp * env * wave[shape](phase);
  };
}

/** A burst of noise, optionally smoothed (darker) or differenced (brighter). */
function noise({ at = 0, len, amp = 1, decay = len, smooth = 1, bright = false }) {
  return (t) => {
    const u = t - at;
    if (u < 0 || u > len) return 0;
    const i = Math.floor(u * SR);
    let v = 0;
    for (let k = 0; k < smooth; k += 1) v += NOISE[(i + k) % NOISE.length];
    v /= smooth;
    if (bright) v -= NOISE[(i + 1) % NOISE.length] * 0.9;
    return amp * Math.exp(-u / decay) * v;
  };
}

const chord = (notes, opts) => notes.map((n, idx) => voice({ ...opts, f: midi(n), at: (opts.at ?? 0) + (opts.strum ?? 0) * idx }));
const arp = (notes, step, opts) => notes.map((n, idx) => voice({ ...opts, f: midi(n), at: (opts.at ?? 0) + idx * step }));

function renderMono(duration, parts, peak) {
  const n = Math.ceil(duration * SR);
  const out = new Float32Array(n);
  const fns = parts.flat();
  for (let i = 0; i < n; i += 1) {
    const t = i / SR;
    let s = 0;
    for (const fn of fns) s += fn(t);
    out[i] = s;
  }
  normalise([out], peak);
  // A 6ms fade at the very end so nothing ends on a click. None at the start: that is lag.
  const fade = Math.floor(0.006 * SR);
  for (let i = 0; i < fade; i += 1) out[n - 1 - i] *= i / fade;
  return [out];
}

function normalise(channels, peak) {
  let max = 0;
  for (const ch of channels) for (const v of ch) max = Math.max(max, Math.abs(v));
  if (!max) return;
  const g = peak / max;
  for (const ch of channels) for (let i = 0; i < ch.length; i += 1) ch[i] *= g;
}

// ── the cues ──────────────────────────────────────────────────────────────

const CUES = {
  conquer: { gain: 1, dur: 0.34, peak: 0.7, parts: [
    voice({ at: 0, len: 0.09, f: midi(72), shape: 'square', amp: 0.5, decay: 0.08 }),
    voice({ at: 0.09, len: 0.2, f: midi(79), shape: 'square', amp: 0.55, decay: 0.12 }),
    voice({ at: 0.09, len: 0.2, f: midi(91), shape: 'sine', amp: 0.25, decay: 0.1 }),
  ] },
  steal: { gain: 1, dur: 0.38, peak: 0.72, parts: [
    voice({ at: 0, len: 0.16, f: 1100, f2: 260, shape: 'saw', amp: 0.45, decay: 0.12 }),
    noise({ at: 0, len: 0.08, amp: 0.25, decay: 0.03, bright: true }),
    voice({ at: 0.16, len: 0.16, f: midi(84), shape: 'square', amp: 0.45, decay: 0.08 }),
  ] },
  lost: { gain: 1, dur: 0.85, peak: 0.8, parts: [
    voice({ at: 0, len: 0.18, f: midi(76), shape: 'tri', amp: 0.6, decay: 0.14, vibrato: 0.4 }),
    voice({ at: 0.18, len: 0.18, f: midi(72), shape: 'tri', amp: 0.6, decay: 0.14, vibrato: 0.4 }),
    voice({ at: 0.36, len: 0.42, f: midi(69), f2: midi(67), shape: 'tri', amp: 0.7, decay: 0.3, vibrato: 0.6 }),
    voice({ at: 0.36, len: 0.3, f: 90, f2: 55, shape: 'sine', amp: 0.6, decay: 0.2 }),
  ] },
  reinforce: { gain: 1, dur: 0.26, peak: 0.62, parts: [
    voice({ at: 0, len: 0.18, f: 160, f2: 90, shape: 'sine', amp: 0.9, decay: 0.08 }),
    noise({ at: 0, len: 0.02, amp: 0.4, decay: 0.006, bright: true }),
    voice({ at: 0.03, len: 0.12, f: midi(67), shape: 'tri', amp: 0.2, decay: 0.06 }),
  ] },
  collect_park: { gain: 1, dur: 0.62, peak: 0.62, parts: [
    voice({ at: 0, len: 0.5, f: midi(88), shape: 'sine', amp: 0.6, decay: 0.22 }),
    voice({ at: 0, len: 0.5, f: midi(100), shape: 'sine', amp: 0.18, decay: 0.12 }),
    voice({ at: 0.06, len: 0.45, f: midi(95), shape: 'sine', amp: 0.35, decay: 0.2 }),
  ] },
  collect_car: { gain: 1, dur: 0.32, peak: 0.6, parts: [
    noise({ at: 0, len: 0.035, amp: 0.8, decay: 0.01, bright: true }),
    noise({ at: 0.05, len: 0.03, amp: 0.5, decay: 0.01, bright: true }),
    voice({ at: 0.09, len: 0.12, f: midi(84), shape: 'square', amp: 0.35, decay: 0.07 }),
    voice({ at: 0.09, len: 0.12, f: midi(96), shape: 'sine', amp: 0.2, decay: 0.05 }),
  ] },
  edition_gold: { gain: 1, dur: 1.0, peak: 0.78, parts: [
    arp([84, 88, 91, 96], 0.07, { len: 0.5, shape: 'tri', amp: 0.45, decay: 0.3 }),
    arp([84.1, 88.1, 91.1, 96.1], 0.07, { len: 0.5, shape: 'sine', amp: 0.3, decay: 0.35 }),
    voice({ at: 0.28, len: 0.6, f: midi(108), shape: 'sine', amp: 0.12, decay: 0.3, vibrato: 0.5 }),
  ] },
  // The best sound in the app. A two-octave rising sparkle into a shimmering chord.
  edition_holo: { gain: 1, dur: 1.7, peak: 0.95, parts: [
    arp([72, 76, 79, 83, 84, 88, 91, 95, 96, 100, 103, 108], 0.05,
      { len: 0.35, shape: 'sine', amp: 0.38, decay: 0.25 }),
    arp([72.12, 76.12, 79.12, 83.12, 84.12, 88.12, 91.12, 95.12, 96.12, 100.12, 103.12, 108.12], 0.05,
      { len: 0.35, shape: 'tri', amp: 0.18, decay: 0.2 }),
    chord([84, 88, 91, 96], { at: 0.6, len: 1.0, shape: 'sine', amp: 0.28, decay: 0.45, vibrato: 1.2 }),
    chord([96.08, 100.08, 103.08], { at: 0.64, len: 0.9, shape: 'tri', amp: 0.1, decay: 0.35, vibrato: 1.6 }),
    noise({ at: 0.58, len: 0.5, amp: 0.05, decay: 0.2, bright: true }),
  ] },
  item_grant: { gain: 1, dur: 0.3, peak: 0.55, parts: [
    voice({ at: 0, len: 0.1, f: 380, f2: 980, shape: 'sine', amp: 0.8, decay: 0.07 }),
    voice({ at: 0.09, len: 0.16, f: midi(93), shape: 'tri', amp: 0.35, decay: 0.08 }),
  ] },
  // The other one that should land: a big metallic clang, then a low, satisfied fifth.
  fortify_hit: { gain: 1, dur: 1.1, peak: 0.95, parts: [
    noise({ at: 0, len: 0.08, amp: 0.9, decay: 0.02, bright: true }),
    voice({ at: 0, len: 0.9, f: 220, shape: 'sine', amp: 0.6, decay: 0.35 }),
    voice({ at: 0, len: 0.7, f: 563, shape: 'sine', amp: 0.45, decay: 0.22 }),
    voice({ at: 0, len: 0.6, f: 912, shape: 'sine', amp: 0.35, decay: 0.16 }),
    voice({ at: 0, len: 0.5, f: 1331, shape: 'sine', amp: 0.25, decay: 0.1 }),
    chord([43, 50], { at: 0.25, len: 0.75, shape: 'tri', amp: 0.45, decay: 0.35 }),
  ] },
  fortify_blocked: { gain: 1, dur: 0.55, peak: 0.7, parts: [
    voice({ at: 0, len: 0.22, f: 120, f2: 60, shape: 'sine', amp: 1, decay: 0.1 }),
    noise({ at: 0, len: 0.05, amp: 0.5, decay: 0.015, smooth: 6 }),
    voice({ at: 0.12, len: 0.3, f: 110, f2: 98, shape: 'square', amp: 0.35, decay: 0.15 }),
  ] },
  trade: { gain: 1, dur: 0.46, peak: 0.55, parts: [
    noise({ at: 0, len: 0.22, amp: 0.35, decay: 0.12, smooth: 4 }),
    voice({ at: 0.12, len: 0.1, f: midi(79), shape: 'tri', amp: 0.45, decay: 0.07 }),
    voice({ at: 0.22, len: 0.16, f: midi(84), shape: 'tri', amp: 0.5, decay: 0.1 }),
  ] },
  level_up: { gain: 1, dur: 1.0, peak: 0.75, parts: [
    arp([72, 76, 79, 84], 0.08, { len: 0.12, shape: 'square', amp: 0.4, decay: 0.08 }),
    chord([84, 88, 91], { at: 0.34, len: 0.55, shape: 'tri', amp: 0.35, decay: 0.3 }),
  ] },
  // Quiet on purpose. A chat blip as loud as a Hologram is how apps get muted for good.
  chat: { gain: 0.6, dur: 0.08, peak: 0.35, parts: [
    voice({ at: 0, len: 0.06, f: midi(93), shape: 'sine', amp: 1, decay: 0.025 }),
  ] },
  blocked: { gain: 0.8, dur: 0.2, peak: 0.45, parts: [
    voice({ at: 0, len: 0.07, f: 196, shape: 'square', amp: 0.6, decay: 0.05 }),
    voice({ at: 0.09, len: 0.08, f: 175, shape: 'square', amp: 0.6, decay: 0.05 }),
  ] },
  rollover: { gain: 1, dur: 1.7, peak: 0.8, parts: [
    arp([72, 76, 79], 0.13, { len: 0.12, shape: 'square', amp: 0.35, decay: 0.1 }),
    chord([72, 76, 79, 84], { at: 0.42, len: 1.1, shape: 'tri', amp: 0.3, decay: 0.5 }),
    chord([60, 67], { at: 0.42, len: 1.1, shape: 'sine', amp: 0.35, decay: 0.5 }),
  ] },
};

// ── the map loop ──────────────────────────────────────────────────────────

/**
 * 16 bars at 100 BPM, 38.4 seconds, rendered so it loops without a seam: every note's
 * tail that runs past the end is written back into the start. Am–F–C–G, twice: a soft
 * pad, a bass on the one and the three, and a plucked arpeggio panned from side to side.
 */
function renderLoop() {
  const beat = 60 / 100;
  const bars = 16;
  const n = Math.round(bars * 4 * beat * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const add = (startSec, lenSec, fn, panL, panR) => {
    const s0 = Math.round(startSec * SR);
    const count = Math.ceil(lenSec * SR);
    for (let k = 0; k < count; k += 1) {
      const v = fn(k / SR);
      const idx = (s0 + k) % n;
      L[idx] += v * panL;
      R[idx] += v * panR;
    }
  };

  const progression = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
  for (let bar = 0; bar < bars; bar += 2) {
    const tones = progression[(bar / 2) % 4];
    const at = bar * 4 * beat;
    const len = 8 * beat;
    // Pad: a slow swell, slightly detuned left against right.
    for (const m of tones) {
      const padL = voice({ len, f: midi(m) * 0.998, shape: 'tri', amp: 0.09, attack: 0.9, decay: 3 });
      const padR = voice({ len, f: midi(m) * 1.002, shape: 'tri', amp: 0.09, attack: 0.9, decay: 3 });
      add(at, len + 1.2, padL, 1, 0.35);
      add(at, len + 1.2, padR, 0.35, 1);
    }
    // Bass on beats one and three of both bars.
    for (let b = 0; b < 8; b += 2) {
      add(at + b * beat, 0.9, voice({ len: 0.5, f: midi(tones[0] - 12), shape: 'sine', amp: 0.34, decay: 0.35 }), 1, 1);
      add(at + b * beat, 0.9, voice({ len: 0.5, f: midi(tones[0] - 12), shape: 'tri', amp: 0.08, decay: 0.2 }), 1, 1);
    }
    // Arpeggio in eighths, up an octave, rocking left and right.
    const pattern = [0, 1, 2, 1, 0, 2, 1, 2];
    for (let e = 0; e < 16; e += 1) {
      const m = tones[pattern[e % 8]] + 12 + (e % 8 === 7 ? 12 : 0);
      const left = e % 2 === 0;
      add(at + e * beat / 2, 0.6, voice({ len: 0.25, f: midi(m), shape: 'sine', amp: 0.1, decay: 0.16 }),
        left ? 1 : 0.45, left ? 0.45 : 1);
    }
    // A barely-there tick on the off-beats.
    for (let e = 1; e < 16; e += 2) {
      add(at + e * beat / 2, 0.05, noise({ len: 0.05, amp: 0.035, decay: 0.012, bright: true }), 0.7, 0.7);
    }
  }

  // Gentle saturation, then normalise quietly: it is background.
  for (const ch of [L, R]) for (let i = 0; i < n; i += 1) ch[i] = Math.tanh(ch[i] * 1.2);
  normalise([L, R], 0.62);
  return { channels: [L, R], duration: n / SR };
}

// ── files ─────────────────────────────────────────────────────────────────

function writeWav(file, channels) {
  const ch = channels.length;
  const n = channels[0].length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * ch * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i += 1) {
    for (let c = 0; c < ch; c += 1) {
      buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, channels[c][i])) * 32767), o);
      o += 2;
    }
  }
  fs.writeFileSync(file, buf);
}

const ffmpeg = process.env.CTH_FFMPEG || 'ffmpeg';
const haveFfmpeg = () => {
  if (args.includes('--no-encode')) return false;
  try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
};

fs.mkdirSync(WAV_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const defaults = { licence: LICENCE, slots: {} };
const encodes = [];

for (const [key, cue] of Object.entries(CUES)) {
  const channels = renderMono(cue.dur, cue.parts, cue.peak);
  const wav = path.join(WAV_DIR, `${key}.wav`);
  writeWav(wav, channels);
  defaults.slots[key] = { file: `${key}.m4a`, gain: cue.gain, duration_s: cue.dur, licence: LICENCE };
  encodes.push({ wav, out: path.join(AUDIO_DIR, `${key}.m4a`), args: ['-ac', '1', '-b:a', '96k'] });
}

const loop = renderLoop();
const loopWav = path.join(WAV_DIR, 'music_main.wav');
writeWav(loopWav, loop.channels);
defaults.slots.music_main = {
  file: 'music_main.m4a', gain: 0.55, duration_s: Math.round(loop.duration * 100) / 100, licence: LICENCE,
};
encodes.push({ wav: loopWav, out: path.join(AUDIO_DIR, 'music_main.m4a'), args: ['-ac', '2', '-b:a', '128k'] });

fs.writeFileSync(path.join(AUDIO_DIR, 'defaults.json'), `${JSON.stringify(defaults, null, 2)}\n`);
console.log(`[sounds] ${encodes.length} WAVs → ${WAV_DIR}`);
console.log(`[sounds] defaults.json → ${path.relative(ROOT, AUDIO_DIR)}`);

if (haveFfmpeg()) {
  for (const e of encodes) {
    execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', e.wav, '-ar', '44100', ...e.args, '-c:a', 'aac', e.out]);
  }
  console.log(`[sounds] encoded ${encodes.length} files into ${path.relative(ROOT, AUDIO_DIR)}`);
} else {
  console.log('[sounds] no ffmpeg here — encode on a machine that has it:');
  for (const e of encodes) {
    console.log(`  ffmpeg -y -i ${path.basename(e.wav)} -ar 44100 ${e.args.join(' ')} -c:a aac ${path.basename(e.out)}`);
  }
}
