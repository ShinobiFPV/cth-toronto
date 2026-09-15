// The read-only observer: CTH_OBSERVER_TOKEN lets something that is not a player — a home
// assistant reading the standings out loud — GET the shared read routes and listen on /ws.
// It must never write, never read anything scoped to one player, never appear as a player,
// and never show up in presence. Boots its own server, like api.test.js, on its own port.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-observer-'));
const DB = path.join(tmp, 'observer.sqlite');
const MEDIA = path.join(tmp, 'media');
const PORT = 8197;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'observer-test-token-0123456789abcdefghijklmnop';

let server;

before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      CTH_PORT: String(PORT),
      CTH_HOST: '127.0.0.1',
      CTH_DB: DB,
      CTH_MEDIA: MEDIA,
      CTH_JWT_SECRET: 'observer-test-secret',
      CTH_OBSERVER_TOKEN: TOKEN,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start within 20s');
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(() => {
  server?.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows file locks */ }
});

const bearer = (token = TOKEN) => ({ authorization: `Bearer ${token}` });

function asObserver(p, { method = 'GET', body } = {}) {
  const headers = bearer();
  const init = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetch(`${BASE}/api${p}`, init);
}

function invite() {
  const db = new Database(DB);
  const code = `OBSV-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Date.now() % 10000}`;
  db.prepare('INSERT INTO invite_codes (code, created_at) VALUES (?, ?)')
    .run(code, new Date().toISOString());
  db.close();
  return code;
}

async function register(handle) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      invite_code: invite(), handle, display_name: handle, password: 'correct-horse-battery',
    }),
  });
  assert.equal(res.status, 201);
  const cookie = res.headers.getSetCookie()[0].split(';')[0];
  const { player } = await res.json();
  return { cookie, player };
}

/** Resolve with the next frame of `type`, or reject after `timeoutMs`. */
function nextFrame(ws, type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(frame);
    };
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`no ${type} frame within ${timeoutMs}ms`));
    }, timeoutMs);
    ws.on('message', onMessage);
  });
}

let alice;

describe('the read-only observer', () => {
  before(async () => {
    alice = await register('alice');
  });

  test('without the token, or with a wrong one, the shared routes stay closed', async () => {
    assert.equal((await fetch(`${BASE}/api/leaderboard`)).status, 401);
    assert.equal((await fetch(`${BASE}/api/leaderboard`, { headers: bearer('not-the-token') })).status, 401);
    // The token is a bearer credential, not a session: it does nothing as a cookie.
    assert.equal((await fetch(`${BASE}/api/leaderboard`, {
      headers: { cookie: `cth_token=${TOKEN}` },
    })).status, 401);
  });

  test('the token reads standings, seasons, the feed, chat, players and cars', async () => {
    for (const p of ['/leaderboard', '/leaderboard/champion', '/seasons', '/feed', '/chat', '/players', '/cars']) {
      assert.equal((await asObserver(p)).status, 200, `${p} should be readable by the observer`);
    }
  });

  test('Hoods arrive with no viewer block, so nothing owner-only can ride along', async () => {
    const { hoods } = await (await asObserver('/hoods')).json();
    assert.equal(hoods.length, 25);
    assert.ok(hoods.every((h) => !('viewer' in h)));
    const { hood } = await (await asObserver('/hoods/1')).json();
    assert.equal(hood.id, 1);
    assert.ok(!('viewer' in hood));
    assert.equal((await asObserver('/hoods/1/history')).status, 200);
  });

  test('a binder is read by player id, and there is no binder of its own', async () => {
    const res = await asObserver(`/cards?player=${alice.player.id}`);
    assert.equal(res.status, 200);
    const binder = await res.json();
    assert.equal(binder.player.handle, 'alice');
    assert.equal(binder.is_you, false);

    const own = await asObserver('/cards');
    assert.equal(own.status, 400);
    assert.equal((await own.json()).error, 'PLAYER_REQUIRED');
  });

  test('nothing scoped to one player is readable', async () => {
    for (const p of [
      '/me', '/trades', '/items', '/items/history', '/hunts', '/parks/map',
      '/cars/capacity', '/hoods/1/check', '/invites', '/admin/audio', '/audio/manifest',
    ]) {
      assert.equal((await asObserver(p)).status, 401, `${p} must refuse the observer`);
    }
    assert.equal((await fetch(`${BASE}/media/anything.jpg`, { headers: bearer() })).status, 401);
  });

  test('the token cannot write anything', async () => {
    assert.equal((await asObserver('/chat', { method: 'POST', body: { body: 'hello from nowhere' } })).status, 401);
    assert.equal((await asObserver('/invites', { method: 'POST', body: {} })).status, 401);
    assert.equal((await asObserver('/claims/1/flag', { method: 'POST', body: { reason: 'no' } })).status, 401);
    assert.equal((await asObserver('/trades', { method: 'POST', body: {} })).status, 401);

    const { messages } = await (await asObserver('/chat')).json();
    assert.ok(!messages.some((m) => m.body === 'hello from nowhere'));
  });

  test('the observer is not a player', async () => {
    const { players } = await (await asObserver('/players')).json();
    assert.deepEqual(players.map((p) => p.handle), ['alice']);
    const { standings } = await (await asObserver('/leaderboard')).json();
    assert.deepEqual(standings.map((row) => row.player.handle), ['alice']);
    const health = await (await fetch(`${BASE}/api/health`)).json();
    assert.equal(health.players, 1);
  });

  test('on /ws it hears every frame, cannot chat, and never joins presence', async () => {
    const observer = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: bearer() });
    const hello = await nextFrame(observer, 'hello');
    assert.equal(hello.payload.observer, true);
    assert.equal(hello.payload.player, null);
    assert.deepEqual(hello.payload.online, []);

    const player = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: alice.cookie } });
    const presence = await nextFrame(observer, 'presence');
    assert.deepEqual(presence.payload.online, ['alice']);

    // A chat frame from the observer's socket posts nothing; a real message still reaches it.
    // If the observer's line were accepted it would be the first chat_message to arrive, so
    // the body check below catches that too.
    observer.send(JSON.stringify({ type: 'chat', body: 'can anyone hear me' }));
    const heard = nextFrame(observer, 'chat_message');
    const posted = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'morning' }),
    });
    assert.equal(posted.status, 201);
    assert.equal((await heard).payload.body, 'morning');

    const { messages } = await (await asObserver('/chat')).json();
    assert.ok(!messages.some((m) => m.body === 'can anyone hear me'));

    // Leaving is as quiet as arriving.
    const quiet = nextFrame(player, 'presence', 600).then(() => 'presence', () => 'quiet');
    observer.close();
    assert.equal(await quiet, 'quiet');
    player.close();
  });

  test('/ws without a player or the token is closed as unauthorized', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: bearer('not-the-token') });
    const code = await new Promise((resolve) => ws.on('close', (c) => resolve(c)));
    assert.equal(code, 4001);
  });
});
