// Sound: how a slot resolves, why a swapped file is a new URL, what an upload may not be,
// and the client's side — preferences that apply before anything can play, and silence for
// anything it does not recognise.
//
// No test needs ffmpeg: the transcoder is swapped for a stub that reads a fake duration out
// of the "file" and copies it through.
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-audio-'));
const AUDIO_DIR = path.join(tmp, 'overrides');
const DEFAULTS_DIR = path.join(tmp, 'defaults');
process.env.CTH_DB = path.join(tmp, 'test.sqlite');
process.env.CTH_JWT_SECRET = 'test-secret';
process.env.CTH_AUDIO_DIR = AUDIO_DIR;
process.env.CTH_AUDIO_DEFAULTS_DIR = DEFAULTS_DIR;

let audio, config, core;

before(async () => {
  fs.mkdirSync(DEFAULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DEFAULTS_DIR, 'conquer.m4a'), 'default-conquer');
  fs.writeFileSync(path.join(DEFAULTS_DIR, 'music_main.m4a'), 'default-loop');
  fs.writeFileSync(path.join(DEFAULTS_DIR, 'defaults.json'), JSON.stringify({
    slots: {
      conquer: { file: 'conquer.m4a', gain: 0.8, licence: 'CC0 test', duration_s: 0.3 },
      music_main: { file: 'music_main.m4a', gain: 0.5, licence: 'CC0 test', duration_s: 38.4 },
      // Listed, but the file is not there: this slot must resolve silent, not crash.
      chat: { file: 'chat.m4a', gain: 0.6, licence: 'CC0 test' },
    },
  }));

  ({ config } = await import('../server/config.js'));
  audio = await import('../server/lib/audio.js');
  core = await import('../web/src/lib/audio-core.js');

  audio.setTranscoder({
    // A test "file" is the text dur:<seconds>:<tag>.
    async probe(input) {
      const seconds = Number(fs.readFileSync(input, 'utf8').split(':')[1]);
      return Number.isFinite(seconds) ? seconds : null;
    },
    async transcode(input, output) { fs.copyFileSync(input, output); },
  });
});

beforeEach(() => {
  fs.rmSync(AUDIO_DIR, { recursive: true, force: true });
});

const clip = (seconds, tag = 'a') => Buffer.from(`dur:${seconds}:${tag}`);
const code = async (fn) => { try { await fn(); } catch (err) { return err.code; } return null; };
const withConfig = async (patch, fn) => {
  const was = Object.fromEntries(Object.keys(patch).map((k) => [k, config[k]]));
  Object.assign(config, patch);
  try { return await fn(); } finally { Object.assign(config, was); }
};

// ── resolution ────────────────────────────────────────────────────────────
describe('how a slot resolves', () => {
  test('every slot the spec names is in the manifest, and nothing else', () => {
    const keys = Object.keys(audio.publicManifest().slots);
    assert.equal(keys.length, 17);
    for (const key of ['conquer', 'steal', 'lost', 'reinforce', 'collect_park', 'collect_car',
      'edition_gold', 'edition_holo', 'item_grant', 'fortify_hit', 'fortify_blocked', 'trade',
      'level_up', 'chat', 'blocked', 'rollover', 'music_main']) {
      assert.ok(keys.includes(key), `missing ${key}`);
    }
  });

  test('with no override, a slot plays the repo default', () => {
    const slot = audio.resolveSlot('conquer');
    assert.equal(slot.source, 'default');
    assert.equal(slot.gain, 0.8);
    assert.match(slot.url, /^\/audio\/conquer\.m4a\?v=[0-9a-f]{8}$/);
  });

  test('an override wins, and a reset falls back to the default', async () => {
    const before = audio.resolveSlot('conquer');
    await audio.uploadSlot({ key: 'conquer', buffer: clip(0.5), licence: 'CC0 / freesound 1' });
    const custom = audio.resolveSlot('conquer');
    assert.equal(custom.source, 'override');
    assert.equal(custom.licence, 'CC0 / freesound 1');
    assert.notEqual(custom.url, before.url);

    audio.resetSlot('conquer');
    const back = audio.resolveSlot('conquer');
    assert.equal(back.source, 'default');
    assert.equal(back.url, before.url);
    assert.deepEqual(fs.readdirSync(AUDIO_DIR).filter((f) => f.endsWith('.m4a')), [], 'the override file is gone');
  });

  test('a slot whose file is missing is silent rather than broken', () => {
    assert.equal(audio.resolveSlot('chat').source, 'none');
    assert.equal(audio.publicManifest().slots.chat.url, null);
    assert.equal(audio.publicManifest().slots.steal.url, null, 'and so is one with no default at all');
  });

  test('an unknown slot resolves to nothing and cannot be written to', async () => {
    assert.equal(audio.resolveSlot('kazoo'), null);
    assert.ok(!('kazoo' in audio.publicManifest().slots));
    assert.equal(await code(() => audio.uploadSlot({ key: 'kazoo', buffer: clip(1) })), 'AUDIO_UNKNOWN_SLOT');
    assert.equal(await code(() => audio.setSlotMeta('kazoo', { gain: 1 })), 'AUDIO_UNKNOWN_SLOT');
  });
});

// ── the cache ─────────────────────────────────────────────────────────────
describe('a swapped sound is a new URL', () => {
  test('a changed file changes the URL and the version', async () => {
    const first = audio.publicManifest();
    await audio.uploadSlot({ key: 'edition_holo', buffer: clip(1.2, 'one') });
    const second = audio.publicManifest();
    await audio.uploadSlot({ key: 'edition_holo', buffer: clip(1.2, 'two') });
    const third = audio.publicManifest();

    const urls = [first, second, third].map((m) => m.slots.edition_holo.url);
    assert.equal(urls[0], null);
    assert.notEqual(urls[1], urls[2], 'same slot, new bytes, new URL');
    assert.equal(new Set([first.version, second.version, third.version]).size, 3);
    assert.equal(fs.readdirSync(AUDIO_DIR).filter((f) => f.startsWith('edition_holo-')).length, 1,
      'and the file it replaced is cleaned up');
  });

  test('a gain change moves the version but keeps the URL, and is clamped', () => {
    const before = audio.publicManifest();
    audio.setSlotMeta('conquer', { gain: 1.2 });
    const after = audio.publicManifest();
    assert.equal(after.slots.conquer.url, before.slots.conquer.url);
    assert.notEqual(after.version, before.version);
    assert.equal(after.slots.conquer.gain, 1.2);
    assert.equal(audio.setSlotMeta('conquer', { gain: 9 }).gain, 1.5);
    assert.equal(audio.setSlotMeta('conquer', { gain: -1 }).gain, 0);
  });

  test('a file is only cacheable forever under its own hash', () => {
    const slot = audio.resolveSlot('conquer');
    const send = (file, v) => {
      const res = {
        headers: {}, code: 200, sent: null,
        setHeader(k, val) { this.headers[k.toLowerCase()] = val; },
        status(c) { this.code = c; return this; },
        end() { return this; },
        sendFile(p, cb) { this.sent = p; cb?.(); },
      };
      audio.sendAudio({ params: { file }, query: { v } }, res, (err) => { throw err; });
      return res;
    };
    assert.match(send('conquer.m4a', slot.hash).headers['cache-control'], /immutable/);
    assert.equal(send('conquer.m4a', 'stale000').headers['cache-control'], 'no-cache');
    assert.equal(send('kazoo.m4a', 'x').code, 404);
    assert.equal(send('../defaults.json', 'x').code, 404);
  });
});

// ── what an upload may not be ─────────────────────────────────────────────
describe('upload limits', () => {
  test('an oversized file is refused before anything is written', async () => {
    // About 5 bytes, against a 9-byte test file.
    await withConfig({ AUDIO_MAX_UPLOAD_MB: 0.000005 }, async () => {
      assert.equal(await code(() => audio.uploadSlot({ key: 'chat', buffer: clip(0.1) })), 'AUDIO_TOO_BIG');
    });
    assert.equal(fs.existsSync(AUDIO_DIR), false);
  });

  test('an over-long sound is refused, and music gets a longer limit than a cue', async () => {
    assert.equal(await code(() => audio.uploadSlot({ key: 'chat', buffer: clip(config.AUDIO_MAX_DURATION_S + 1) })),
      'AUDIO_TOO_LONG');
    const loop = await audio.uploadSlot({ key: 'music_main', buffer: clip(60) });
    assert.equal(loop.source, 'override');
    assert.equal(await code(() => audio.uploadSlot({ key: 'music_main', buffer: clip(config.AUDIO_MAX_MUSIC_DURATION_S + 1) })),
      'AUDIO_TOO_LONG');
  });

  test('something that is not audio is refused', async () => {
    assert.equal(await code(() => audio.uploadSlot({ key: 'chat', buffer: Buffer.from('nonsense') })), 'AUDIO_UNREADABLE');
    assert.equal(await code(() => audio.uploadSlot({ key: 'chat', buffer: Buffer.alloc(0) })), 'AUDIO_MISSING');
  });
});

// ── the client ────────────────────────────────────────────────────────────
describe('on the phone', () => {
  const storage = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  };

  test('music is off and effects on until somebody says otherwise, and the choice persists', () => {
    const s = storage();
    assert.deepEqual(core.readAudioPrefs(s), { music: false, effects: true });
    core.writeAudioPrefs(s, { music: true, effects: false });
    assert.deepEqual(core.readAudioPrefs(s), { music: true, effects: false });
  });

  test('garbage in storage, or storage that throws, falls back to the defaults', () => {
    const s = storage();
    s.setItem(core.AUDIO_PREFS_KEY, '{nope');
    assert.deepEqual(core.readAudioPrefs(s), core.DEFAULT_AUDIO_PREFS);
    const throwing = { getItem() { throw new Error('private window'); } };
    assert.deepEqual(core.readAudioPrefs(throwing), core.DEFAULT_AUDIO_PREFS);
  });

  test('the mixer starts at the saved levels, before anything can play', () => {
    const made = [];
    const ctx = {
      destination: {},
      createGain() {
        const node = { gain: { value: 1 }, connect() {} };
        made.push(node);
        return node;
      },
    };
    const mixer = core.createMixer(ctx, { music: false, effects: true });
    assert.equal(mixer.music.gain.value, 0, 'music muted from the first moment');
    assert.equal(mixer.effects.gain.value, 1);
    assert.equal(made.length, 3);
  });

  test('an unknown or broken slot is silent', () => {
    const manifest = { slots: {
      conquer: { url: '/audio/conquer.m4a?v=ab', gain: 0.8, kind: 'effect' },
      chat: { url: null, gain: 1 },
      loud: { url: '/audio/loud.m4a?v=cd', gain: 'very' },
    } };
    assert.deepEqual(core.resolveClip(manifest, 'conquer'), { url: '/audio/conquer.m4a?v=ab', gain: 0.8, kind: 'effect' });
    assert.equal(core.resolveClip(manifest, 'chat'), null);
    assert.equal(core.resolveClip(manifest, 'kazoo'), null);
    assert.equal(core.resolveClip(null, 'conquer'), null);
    assert.equal(core.resolveClip(manifest, 'loud').gain, 1);
  });

  test('the manifest is network first, the cached copy second', () => {
    const fresh = { version: '2.x', slots: {} };
    const cached = { version: '1.x', slots: {} };
    assert.equal(core.pickManifest(fresh, cached), fresh);
    assert.equal(core.pickManifest(null, cached), cached);
    assert.equal(core.pickManifest(null, null), null);
  });
});
