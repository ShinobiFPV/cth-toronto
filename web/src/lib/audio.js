// The sound layer. Effects and music are different systems that share one mixer.
//
//   - Effects: short, overlapping, latency-sensitive. Decoded once into AudioBuffers and
//     fired through AudioBufferSourceNodes; new Audio() lags and overlaps badly.
//   - Music: one short loop through Web Audio with loop = true, which is the only way a
//     loop has no seam.
//
// Both go through a gain per channel, so the toggles are volume changes.
//
// The unlock: an AudioContext starts suspended and only resumes inside a real gesture, so
// nothing plays until the first tap of a session. Music cannot autoplay and should not
// try — a silent first moment is correct behaviour, not a bug. And on an iPhone the silent
// switch mutes Web Audio entirely; when somebody reports the sounds are broken, that is
// the first thing to ask about.
//
// Cache: every clip URL carries its file's hash, so a sound the admin swapped is a new
// URL and no service worker can keep playing the old one. The manifest itself is fetched
// network-first with the last good copy as the fallback.
import {
  readAudioPrefs, writeAudioPrefs, createMixer, channelLevels, resolveClip, pickManifest,
  MANIFEST_CACHE_KEY,
} from './audio-core.js';

const storage = () => { try { return window.localStorage; } catch { return null; } };

// Read at import, which main.jsx does before the first frame: no burst of sound can come
// out ahead of the preference.
let prefs = readAudioPrefs(storage());
let ctx = null;
let mixer = null;
let manifest = null;
let manifestLoad = null;
let music = null;             // { url, token, source }
let musicWanted = false;
const buffers = new Map();    // url → Promise<AudioBuffer>
const listeners = new Set();

export const getAudioPrefs = () => prefs;
export const onAudioPrefs = (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

function context() {
  if (ctx) return ctx;
  const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
  if (!AC) return null;
  ctx = new AC();
  mixer = createMixer(ctx, prefs);
  return ctx;
}

async function unlock() {
  const c = context();
  if (!c) return;
  if (c.state === 'suspended') { try { await c.resume(); } catch { /* try again next tap */ } }
  await loadManifest();
  preloadEffects();
  syncMusic();
}

/** Arm the first-gesture unlock. Called once, from main.jsx. */
export function initAudio() {
  if (typeof window === 'undefined') return;
  const once = () => {
    window.removeEventListener('pointerdown', once, true);
    window.removeEventListener('keydown', once, true);
    unlock();
  };
  window.addEventListener('pointerdown', once, true);
  window.addEventListener('keydown', once, true);
}

export function loadManifest({ force = false } = {}) {
  if (manifestLoad && !force) return manifestLoad;
  manifestLoad = (async () => {
    let cached = null;
    try { cached = JSON.parse(storage()?.getItem(MANIFEST_CACHE_KEY) ?? 'null'); } catch { /* none */ }
    let fresh = null;
    try {
      const res = await fetch('/api/audio/manifest', { credentials: 'same-origin', cache: 'no-store' });
      if (res.ok) fresh = await res.json();
    } catch { /* offline: the cached copy will do */ }
    if (fresh) { try { storage()?.setItem(MANIFEST_CACHE_KEY, JSON.stringify(fresh)); } catch { /* fine */ } }
    manifest = pickManifest(fresh, cached);
    return manifest;
  })();
  return manifestLoad;
}

function bufferFor(url) {
  if (!buffers.has(url)) {
    const job = fetch(url)
      .then((res) => { if (!res.ok) throw new Error(`audio ${res.status}`); return res.arrayBuffer(); })
      // The callback form, because older Safari has no promise form.
      .then((bytes) => new Promise((resolve, reject) => ctx.decodeAudioData(bytes, resolve, reject)))
      .catch((err) => { buffers.delete(url); throw err; });
    buffers.set(url, job);
  }
  return buffers.get(url);
}

function preloadEffects() {
  if (!manifest || !ctx) return;
  for (const slot of Object.keys(manifest.slots ?? {})) {
    const clip = resolveClip(manifest, slot);
    if (clip?.kind === 'effect') bufferFor(clip.url).catch(() => {});
  }
}

/** Fire a sound effect. Silent before the first tap, with effects off, or for an unknown slot. */
export async function playSound(slot) {
  if (!prefs.effects || !ctx || ctx.state !== 'running' || !manifest) return;
  const clip = resolveClip(manifest, slot);
  if (!clip || clip.kind !== 'effect') return;
  try {
    const buffer = await bufferFor(clip.url);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = clip.gain;
    source.connect(gain).connect(mixer.effects);
    source.start();
  } catch { /* a sound that will not play is not worth an error */ }
}

/**
 * The sounds a collection earns, in order: the card, then its edition, then any item —
 * spaced so the Hologram sting is not buried under the card it came on.
 */
export function playCollection(slot, { edition = null, items = null } = {}) {
  playSound(slot);
  if (edition === 'hologram') setTimeout(() => playSound('edition_holo'), 320);
  else if (edition === 'gold') setTimeout(() => playSound('edition_gold'), 320);
  if (items?.items?.length) setTimeout(() => playSound('item_grant'), edition === 'hologram' ? 1500 : 900);
}

/** The map asks for its loop while it is on screen. */
export function setMusicWanted(want) {
  musicWanted = want;
  syncMusic();
}

async function syncMusic() {
  const play = musicWanted && prefs.music && ctx && ctx.state === 'running' && manifest;
  const clip = play ? resolveClip(manifest, 'music_main') : null;
  if (!clip) { stopMusic(); return; }
  if (music?.url === clip.url) return;
  stopMusic();
  const token = {};
  music = { url: clip.url, token, source: null };
  try {
    const buffer = await bufferFor(clip.url);
    if (music?.token !== token) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = clip.gain;
    source.connect(gain).connect(mixer.music);
    source.start();
    music.source = source;
  } catch { music = null; }
}

function stopMusic() {
  if (music?.source) { try { music.source.stop(); } catch { /* already stopped */ } }
  music = null;
}

/** Change the toggles. Applied as volumes first, then music is started or stopped. */
export function setAudioPrefs(patch) {
  prefs = writeAudioPrefs(storage(), { ...prefs, ...patch });
  if (mixer && ctx) {
    const levels = channelLevels(prefs);
    mixer.music.gain.setTargetAtTime(levels.music, ctx.currentTime, 0.05);
    mixer.effects.gain.setTargetAtTime(levels.effects, ctx.currentTime, 0.02);
  }
  for (const fn of listeners) fn(prefs);
  // Flipping a toggle is itself a tap, so this is a legitimate moment to unlock.
  unlock();
  return prefs;
}

/**
 * Play any clip once, whatever the toggles say — the admin board's preview. Stops a long
 * track after twelve seconds; nobody needs three minutes to judge a loop.
 */
export async function previewClip(url, gain = 1) {
  const c = context();
  if (!c || !url) return;
  if (c.state === 'suspended') { try { await c.resume(); } catch { return; } }
  try {
    const buffer = await bufferFor(url);
    const source = c.createBufferSource();
    source.buffer = buffer;
    const g = c.createGain();
    g.gain.value = gain;
    source.connect(g).connect(c.destination);
    source.start();
    if (buffer.duration > 12) setTimeout(() => { try { source.stop(); } catch { /* done */ } }, 12_000);
  } catch { /* nothing to hear */ }
}

/** A sound was swapped somewhere. Re-resolve, and restart the loop if its file changed. */
export function audioChanged() {
  loadManifest({ force: true }).then(() => { preloadEffects(); syncMusic(); });
}
