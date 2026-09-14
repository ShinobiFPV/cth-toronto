// The parts of the sound layer that can be decided without a speaker: preferences, the
// mixer's starting levels, and how a slot resolves. Pure, so the tests can hold them.

export const AUDIO_PREFS_KEY = 'cth.audio';
export const MANIFEST_CACHE_KEY = 'cth.audio.manifest';

/**
 * Music off, effects on. Somebody opening the app with their own music playing and getting
 * a loop over the top of it is a bad first impression — and the effects are where the
 * game's personality lives anyway.
 */
export const DEFAULT_AUDIO_PREFS = Object.freeze({ music: false, effects: true });

/** The saved preferences, or the defaults. Tolerant of a private window that throws. */
export function readAudioPrefs(storage) {
  try {
    const raw = storage?.getItem(AUDIO_PREFS_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    return {
      music: typeof saved.music === 'boolean' ? saved.music : DEFAULT_AUDIO_PREFS.music,
      effects: typeof saved.effects === 'boolean' ? saved.effects : DEFAULT_AUDIO_PREFS.effects,
    };
  } catch {
    return { ...DEFAULT_AUDIO_PREFS };
  }
}

export function writeAudioPrefs(storage, prefs) {
  const clean = { music: !!prefs.music, effects: !!prefs.effects };
  try { storage?.setItem(AUDIO_PREFS_KEY, JSON.stringify(clean)); } catch { /* per device, best effort */ }
  return clean;
}

/** A toggle is a volume, not a teardown. */
export const channelLevels = (prefs) => ({ music: prefs.music ? 1 : 0, effects: prefs.effects ? 1 : 0 });

/**
 * The mixer: a gain per channel into a master. Built with the saved levels already set, so
 * nothing can play at the wrong level before the preference applies.
 */
export function createMixer(ctx, prefs) {
  const master = ctx.createGain();
  const music = ctx.createGain();
  const effects = ctx.createGain();
  const levels = channelLevels(prefs);
  music.gain.value = levels.music;
  effects.gain.value = levels.effects;
  music.connect(master);
  effects.connect(master);
  master.connect(ctx.destination);
  return { master, music, effects };
}

/**
 * A slot from the manifest, or null. An unknown slot, a slot with no file, or a garbled
 * entry all come back null, and the caller plays nothing — silent is the safe failure.
 */
export function resolveClip(manifest, slot) {
  const entry = manifest?.slots?.[slot];
  if (!entry || typeof entry.url !== 'string' || !entry.url) return null;
  const gain = Number(entry.gain);
  return {
    url: entry.url,
    gain: Number.isFinite(gain) ? Math.max(0, Math.min(1.5, gain)) : 1,
    kind: entry.kind === 'music' ? 'music' : 'effect',
  };
}

/** Network first, the last good copy second. */
export const pickManifest = (fresh, cached) =>
  (fresh?.slots ? fresh : cached?.slots ? cached : null);
