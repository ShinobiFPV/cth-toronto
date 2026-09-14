// Sounds and music: seventeen fixed slots, repo defaults, and admin overrides on the Pi.
//
// Every file the app plays resolves in exactly one place, here:
//   - a slot with an override in AUDIO_DIR plays that file
//   - a slot without one plays the repo default (web/dist/audio, or web/public/audio in dev)
//   - an unknown slot resolves to nothing, and the client stays silent
//
// audio-manifest.json in AUDIO_DIR is the source of truth for overrides. Deploy never
// writes to that directory, so a swapped sound survives every deploy, and a slot reset
// falls straight back to whatever default the current build ships.
//
// The thing that will actually break is the service worker caching audio: swap a file and
// every phone keeps the old one for weeks. So every URL names its bytes —
// /audio/edition_holo.m4a?v=a1c3f9 — and a changed file is a URL no cache has seen. The
// manifest's top-level version changes whenever any URL would, so a client can tell it
// needs to re-resolve without diffing the slots.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { GameError, badRequest, notFound } from './errors.js';

const run = promisify(execFile);

/**
 * The slots. Fixed, so the admin board is a stable list and a client never has to guess
 * whether a key exists. `edition_holo` and `fortify_hit` are the ones that should land;
 * everything else is short and quiet, or people mute the app for good.
 */
export const AUDIO_SLOTS = [
  { key: 'conquer', label: 'Conquer', kind: 'effect', fires: 'taking an unclaimed Hood' },
  { key: 'steal', label: 'Steal', kind: 'effect', fires: 'taking a Hood from someone' },
  { key: 'lost', label: 'Hood lost', kind: 'effect', fires: 'your Hood being taken' },
  { key: 'reinforce', label: 'Reinforce', kind: 'effect', fires: 'reinforcing a Hood' },
  { key: 'collect_park', label: 'Park card', kind: 'effect', fires: 'collecting a park' },
  { key: 'collect_car', label: 'Car card', kind: 'effect', fires: 'collecting a car' },
  { key: 'edition_gold', label: 'Gold pull', kind: 'effect', fires: 'a Gold edition' },
  { key: 'edition_holo', label: 'Hologram pull', kind: 'effect', fires: 'a Hologram edition' },
  { key: 'item_grant', label: 'Item', kind: 'effect', fires: 'an item landing in your bag' },
  { key: 'fortify_hit', label: 'Fortify held', kind: 'effect', fires: 'your Fortify stopping a steal' },
  { key: 'fortify_blocked', label: 'Walked into a Fortify', kind: 'effect', fires: 'your steal bouncing off one' },
  { key: 'trade', label: 'Trade', kind: 'effect', fires: 'a trade going through' },
  { key: 'level_up', label: 'Level up', kind: 'effect', fires: 'reaching a new level' },
  { key: 'chat', label: 'Chat', kind: 'effect', fires: 'an incoming message' },
  { key: 'blocked', label: 'Blocked', kind: 'effect', fires: 'a cooldown or a refused action' },
  { key: 'rollover', label: 'Season change', kind: 'effect', fires: 'the season rolling over' },
  { key: 'music_main', label: 'Map music', kind: 'music', fires: 'looping on the map' },
];

const bySlot = new Map(AUDIO_SLOTS.map((s) => [s.key, s]));
export const audioSlot = (key) => bySlot.get(key) ?? null;

const defaultsDir = () => {
  if (config.AUDIO_DEFAULTS_DIR) return config.AUDIO_DEFAULTS_DIR;
  const built = path.join(config.webDist, 'audio');
  return fs.existsSync(path.join(built, 'defaults.json')) ? built : path.join(config.publicDir, 'audio');
};

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

const hashes = new Map();
/** The first 8 hex of a file's sha256, cached against its size and mtime. */
export function fileHash(file) {
  const st = fs.statSync(file);
  const key = `${file}:${st.size}:${st.mtimeMs}`;
  if (!hashes.has(key)) {
    hashes.set(key, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8));
  }
  return hashes.get(key);
}

const manifestPath = () => path.join(config.AUDIO_DIR, 'audio-manifest.json');

/** The Pi's override manifest. Missing or unreadable is simply "no overrides". */
export function readManifest() {
  const m = readJson(manifestPath(), null);
  return {
    version: Number.isInteger(m?.version) ? m.version : 0,
    slots: m && m.slots && typeof m.slots === 'object' ? m.slots : {},
  };
}

function writeManifest(manifest) {
  fs.mkdirSync(config.AUDIO_DIR, { recursive: true });
  // Written aside and renamed into place, so a crash mid-write never leaves a torn file.
  const tmp = `${manifestPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tmp, manifestPath());
}

const clampGain = (value, fallback = 1) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1.5, Math.max(0, Math.round(n * 100) / 100)) : fallback;
};

const cleanLicence = (text) => {
  const s = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ').slice(0, 160) : '';
  return s || null;
};

/** The URL that names one exact file. A different hash is a different URL. */
export const audioUrl = (key, hash) => `/audio/${key}.m4a?v=${hash}`;

/**
 * One slot, resolved: where its bytes come from, how loud, and the URL that names those
 * bytes. Null for a key that is not a slot.
 */
export function resolveSlot(key, manifest = readManifest()) {
  const slot = audioSlot(key);
  if (!slot) return null;
  const fallback = readJson(path.join(defaultsDir(), 'defaults.json'), null)?.slots?.[key] ?? null;
  const override = manifest.slots[key] ?? null;

  let file = null;
  let source = 'none';
  let licence = null;
  let duration = null;
  if (override?.file) {
    const p = path.join(config.AUDIO_DIR, path.basename(override.file));
    if (fs.existsSync(p)) {
      file = p; source = 'override'; licence = override.licence ?? null; duration = override.duration_s ?? null;
    }
  }
  if (!file && fallback?.file) {
    const p = path.join(defaultsDir(), path.basename(fallback.file));
    if (fs.existsSync(p)) {
      file = p; source = 'default'; licence = fallback.licence ?? null; duration = fallback.duration_s ?? null;
    }
  }

  const hash = file ? fileHash(file) : null;
  const defaultGain = clampGain(fallback?.gain, 1);
  return {
    ...slot,
    source,
    file,
    hash,
    url: file ? audioUrl(key, hash) : null,
    // A gain can be overridden without the file: fixing one loud cue should not mean
    // re-exporting it.
    gain: clampGain(override?.gain, defaultGain),
    default_gain: defaultGain,
    licence,
    duration_s: duration,
    uploaded_at: source === 'override' ? override.uploaded_at ?? null : null,
  };
}

/** What every client fetches: each slot's URL and gain, and one version for all of it. */
export function publicManifest() {
  const manifest = readManifest();
  const slots = {};
  for (const { key } of AUDIO_SLOTS) {
    const r = resolveSlot(key, manifest);
    slots[key] = { kind: r.kind, url: r.url, gain: r.gain };
  }
  // The stored version moves on every admin change; the digest moves when a deploy
  // changes a default. Together they change whenever any URL or gain would.
  const digest = crypto.createHash('sha256').update(JSON.stringify(slots)).digest('hex').slice(0, 6);
  return { version: `${manifest.version}.${digest}`, slots };
}

/** The admin board: every slot, resolved, without the server's file paths. */
export function listSlots() {
  const manifest = readManifest();
  return AUDIO_SLOTS.map(({ key }) => {
    const { file, ...rest } = resolveSlot(key, manifest);
    return rest;
  });
}

export const audioLimits = () => ({
  max_upload_mb: config.AUDIO_MAX_UPLOAD_MB,
  max_effect_s: config.AUDIO_MAX_DURATION_S,
  max_music_s: config.AUDIO_MAX_MUSIC_DURATION_S,
});

// ── transcoding ───────────────────────────────────────────────────────────

const missing = (tool) => new GameError('AUDIO_TRANSCODER_MISSING',
  `${tool} is not installed on the server, so sounds cannot be replaced.`, {}, 503);

/**
 * ffprobe for the duration, ffmpeg to the standard format: AAC in .m4a, mono 96k for a cue,
 * stereo 128k for music, leading silence trimmed from cues (it reads as input lag), and
 * everything loudness-normalised so one upload cannot be twice as loud as the set.
 * Swappable with setTranscoder(), so no test needs ffmpeg installed.
 */
const ffmpegTranscoder = {
  async probe(input) {
    try {
      const { stdout } = await run(config.FFPROBE,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input]);
      const seconds = Number(stdout.trim());
      return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    } catch (err) {
      if (err.code === 'ENOENT') throw missing('ffprobe');
      return null;
    }
  },
  async transcode(input, output, { kind }) {
    const music = kind === 'music';
    const filters = music
      ? 'loudnorm=I=-18:TP=-2:LRA=11'
      : 'silenceremove=start_periods=1:start_threshold=-50dB,loudnorm=I=-16:TP=-1.5:LRA=11';
    try {
      await run(config.FFMPEG, ['-y', '-v', 'error', '-i', input, '-vn', '-af', filters,
        '-ac', music ? '2' : '1', '-ar', '44100', '-c:a', 'aac', '-b:a', music ? '128k' : '96k',
        output], { timeout: 120_000 });
    } catch (err) {
      if (err.code === 'ENOENT') throw missing('ffmpeg');
      throw badRequest('AUDIO_UNREADABLE', 'That file could not be read as audio.');
    }
  },
};

let transcoder = ffmpegTranscoder;
export const setTranscoder = (next) => { transcoder = next ?? ffmpegTranscoder; };

// ── the admin actions ─────────────────────────────────────────────────────

const requireSlot = (key) => {
  const slot = audioSlot(key);
  if (!slot) throw notFound('AUDIO_UNKNOWN_SLOT', `There is no sound slot called ${key}.`);
  return slot;
};

const publicSlot = (key) => {
  const { file, ...rest } = resolveSlot(key);
  return rest;
};

/**
 * Replace a slot's sound. Checked for size and for decoded duration before anything is
 * written, then transcoded to the standard format and stored under its own hash.
 */
export async function uploadSlot({ key, buffer, licence = null, playerId = null }) {
  const slot = requireSlot(key);
  if (!buffer?.length) throw badRequest('AUDIO_MISSING', 'Attach a sound file.');
  if (buffer.length > config.AUDIO_MAX_UPLOAD_MB * 1048576) {
    throw badRequest('AUDIO_TOO_BIG', `That file is over the ${config.AUDIO_MAX_UPLOAD_MB} MB limit.`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-audio-'));
  try {
    const input = path.join(work, 'input');
    fs.writeFileSync(input, buffer);

    const duration = await transcoder.probe(input);
    if (duration == null) throw badRequest('AUDIO_UNREADABLE', 'That file could not be read as audio.');
    const max = slot.kind === 'music' ? config.AUDIO_MAX_MUSIC_DURATION_S : config.AUDIO_MAX_DURATION_S;
    if (duration > max) {
      throw badRequest('AUDIO_TOO_LONG',
        `That is ${duration.toFixed(1)}s long, and ${slot.label} takes at most ${max}s.`,
        { duration_s: duration, max_s: max });
    }

    const output = path.join(work, 'output.m4a');
    await transcoder.transcode(input, output, { kind: slot.kind });
    const hash = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex').slice(0, 8);
    const name = `${key}-${hash}.m4a`;
    fs.mkdirSync(config.AUDIO_DIR, { recursive: true });
    fs.copyFileSync(output, path.join(config.AUDIO_DIR, name));

    const manifest = readManifest();
    const previous = manifest.slots[key] ?? {};
    manifest.slots[key] = {
      ...previous,
      file: name,
      hash,
      licence: cleanLicence(licence) ?? previous.licence ?? null,
      duration_s: Math.round(duration * 100) / 100,
      uploaded_at: new Date().toISOString(),
      uploaded_by: playerId,
    };
    manifest.version += 1;
    writeManifest(manifest);

    if (previous.file && previous.file !== name) {
      fs.rmSync(path.join(config.AUDIO_DIR, path.basename(previous.file)), { force: true });
    }
    return publicSlot(key);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Change a slot's gain or licence note without touching its file. */
export function setSlotMeta(key, { gain, licence } = {}) {
  requireSlot(key);
  const manifest = readManifest();
  const entry = { ...(manifest.slots[key] ?? {}) };
  if (gain !== undefined) entry.gain = clampGain(gain, entry.gain ?? 1);
  if (licence !== undefined) entry.licence = cleanLicence(licence);
  manifest.slots[key] = entry;
  manifest.version += 1;
  writeManifest(manifest);
  return publicSlot(key);
}

/** Back to the repo default: the override file, its gain and its licence note all go. */
export function resetSlot(key) {
  requireSlot(key);
  const manifest = readManifest();
  const entry = manifest.slots[key];
  if (entry?.file) fs.rmSync(path.join(config.AUDIO_DIR, path.basename(entry.file)), { force: true });
  delete manifest.slots[key];
  manifest.version += 1;
  writeManifest(manifest);
  return publicSlot(key);
}

/**
 * GET /audio/:slot.m4a. Immutable only when the request names the file's current hash —
 * any other request gets revalidated, so an old ?v= can never pin a stale sound.
 */
export function sendAudio(req, res, next) {
  const match = /^([a-z_]+)\.m4a$/.exec(req.params.file ?? '');
  const slot = match ? resolveSlot(match[1]) : null;
  if (!slot?.file) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/mp4');
  res.setHeader('Cache-Control', req.query.v === slot.hash
    ? 'public, max-age=31536000, immutable'
    : 'no-cache');
  return res.sendFile(slot.file, (err) => (err ? next(err) : undefined));
}
