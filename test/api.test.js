// End-to-end over real HTTP: registration, the claim endpoint with a real JPEG through
// the sharp pipeline, chat, flags and reversal.
//
// Spec §9 step 3 says to exercise the claim endpoint before any capture UI exists.
// This is that walkthrough, made repeatable — it boots the actual server on a spare
// port against a throwaway database and media directory.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-api-'));
const DB = path.join(tmp, 'api.sqlite');
const MEDIA = path.join(tmp, 'media');
const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}`;

let server;

before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      CTH_PORT: String(PORT),
      CTH_HOST: '127.0.0.1',
      CTH_DB: DB,
      CTH_MEDIA: MEDIA,
      CTH_JWT_SECRET: 'api-test-secret',
      // Generous enough that the rest of the suite never trips it, low enough that the
      // rate-limit test can reach it without a hundred argon2 hashes.
      CTH_LOGIN_MAX_ATTEMPTS: '25',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  // Wait for the port to answer rather than sleeping a fixed amount.
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

// ── a tiny client that keeps its own cookie jar, so two players can coexist ──
function client() {
  let cookie = '';
  return async function call(path, { method = 'GET', body, raw } = {}) {
    const init = { method, headers: {} };
    if (cookie) init.headers.cookie = cookie;
    if (raw) init.body = raw;
    else if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${BASE}/api${path}`, init);
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) cookie = c.split(';')[0];
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
    return { status: res.status, data };
  };
}

/** A real JPEG, so sharp actually runs — solid colour, a different one each time. */
async function jpeg(hue = 200) {
  return sharp({
    create: { width: 1200, height: 900, channels: 3, background: { r: hue % 255, g: 120, b: 90 } },
  }).jpeg({ quality: 70 }).toBuffer();
}

async function claimForm(buffer, photoType, name = 'shot.jpg') {
  const form = new FormData();
  form.append('photo', new Blob([buffer], { type: 'image/jpeg' }), name);
  form.append('photo_type', photoType);
  return form;
}

const invite = () => {
  // The server owns the DB; WAL lets this open a second connection to mint a code,
  // which is exactly what scripts/make-invite.js does in production.
  const db = new Database(DB);
  const code = `TEST-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Date.now() % 10000}`;
  db.prepare('INSERT INTO invite_codes (code, created_at) VALUES (?, ?)')
    .run(code, new Date().toISOString());
  db.close();
  return code;
};

/** Wind a Hood's clocks back through a second connection, standing in for real time. */
function rewind(hoodId, hours) {
  const db = new Database(DB);
  const shift = (iso) => (iso ? new Date(Date.parse(iso) - hours * 3600_000).toISOString() : iso);
  const s = db.prepare('SELECT * FROM hood_state WHERE hood_id = ?').get(hoodId);
  db.prepare('UPDATE hood_state SET last_claim_at = ?, locked_until = ? WHERE hood_id = ?')
    .run(shift(s.last_claim_at), shift(s.locked_until), hoodId);
  db.close();
}

let alice, bob, carol;

describe('the API end to end', () => {
  test('health reports the active season before anyone has registered', async () => {
    const res = await fetch(`${BASE}/api/health`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.season, 'a season should be active');
  });

  test('everything real is behind the login', async () => {
    const anon = client();
    for (const path of ['/hoods', '/feed', '/leaderboard', '/chat', '/me']) {
      const { status } = await anon(path);
      assert.equal(status, 401, `${path} should require auth`);
    }
  });

  test('registration needs a valid invite code, and the first player is admin', async () => {
    alice = client();
    const bad = await alice('/auth/register',
      { method: 'POST', body: { invite_code: 'NOPE', handle: 'alice', password: 'hunter2hunter2' } });
    assert.equal(bad.data.error, 'BAD_INVITE');

    const ok = await alice('/auth/register', {
      method: 'POST',
      body: { invite_code: invite(), handle: 'alice', display_name: 'Alice', password: 'hunter2hunter2' },
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.player.is_admin, true, 'the first player runs the game');
    assert.ok(ok.data.player.colour.startsWith('#'));

    bob = client();
    const two = await bob('/auth/register', {
      method: 'POST',
      body: { invite_code: invite(), handle: 'bob', display_name: 'Bob', password: 'hunter2hunter2' },
    });
    assert.equal(two.status, 201);
    assert.equal(two.data.player.is_admin, false);
    assert.notEqual(two.data.player.colour, ok.data.player.colour, 'players get distinct colours');

    carol = client();
    await carol('/auth/register', {
      method: 'POST',
      body: { invite_code: invite(), handle: 'carol', display_name: 'Carol', password: 'hunter2hunter2' },
    });
  });

  test('an invite code burns on use', async () => {
    const code = invite();
    const a = client();
    await a('/auth/register', { method: 'POST', body: { invite_code: code, handle: 'dave', password: 'hunter2hunter2' } });
    const b = client();
    const second = await b('/auth/register',
      { method: 'POST', body: { invite_code: code, handle: 'erin', password: 'hunter2hunter2' } });
    assert.equal(second.data.error, 'INVITE_USED');
  });

  test('the Hood list arrives with 25 Hoods and per-viewer guidance', async () => {
    const { data } = await alice('/hoods');
    assert.equal(data.hoods.length, 25);
    const h13 = data.hoods.find((h) => h.id === 13);
    assert.equal(h13.label, 'Hood 13 — Toronto Centre');
    assert.equal(h13.owner, null);
    assert.equal(h13.viewer.claim_kind, 'conquer');
    assert.equal(h13.viewer.can_claim, true);
    assert.equal(h13.difficulty, 14, 'Toronto Centre: 1.8 km out but only three borders');
    assert.equal(h13.conquer_value, 14);
    assert.equal(h13.steal_value, 28, 'a steal pays double the difficulty');
    assert.equal(h13.viewer.action_label, 'Conquer (+14)');
    assert.deepEqual([...h13.viewer.required_types].sort(), ['animal', 'landmark', 'person']);
  });

  test('the dry-run endpoint agrees with the list', async () => {
    const { data } = await alice('/hoods/13/check?photo_type=landmark');
    assert.equal(data.ok, true);
    assert.equal(data.claim_kind, 'conquer');
    assert.equal(data.points, 14);
    assert.equal(data.difficulty, 14);
  });

  test('a claim without a photo type is refused before the upload', async () => {
    const form = new FormData();
    form.append('photo', new Blob([await jpeg()], { type: 'image/jpeg' }), 'x.jpg');
    const { status, data } = await alice('/hoods/13/claim', { method: 'POST', raw: form });
    assert.equal(status, 400);
    assert.equal(data.error, 'BAD_TYPE');
  });

  test('conquering runs the photo through sharp and writes three derivatives', async () => {
    const { status, data } = await alice('/hoods/13/claim',
      { method: 'POST', raw: await claimForm(await jpeg(10), 'landmark') });
    assert.equal(status, 201);
    assert.equal(data.claim.claim_kind, 'conquer');
    assert.equal(data.claim.points, 14, 'Hood 13 difficulty');
    assert.match(data.claim.summary, /^Alice conquered Hood 13 — Toronto Centre with a landmark photo \(\+14\)$/);

    for (const dir of ['original', 'display', 'thumb']) {
      const files = fs.readdirSync(path.join(MEDIA, dir));
      assert.equal(files.length, 1, `${dir}/ should hold one file`);
    }
    const thumb = fs.readdirSync(path.join(MEDIA, 'thumb'))[0];
    const meta = await sharp(path.join(MEDIA, 'thumb', thumb)).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 400);
  });

  test('the claim announced itself in chat', async () => {
    const { data } = await bob('/chat');
    const system = data.messages.filter((m) => m.kind === 'system');
    assert.ok(system.some((m) => /Alice conquered Hood 13/.test(m.body)),
      'chat should carry the claim');
  });

  test('media is served to players and refused to strangers', async () => {
    const { data } = await alice('/hoods/13');
    const url = data.hood.thumb_url;
    assert.ok(url.startsWith('/media/thumb/'));

    const anon = await fetch(`${BASE}${url}`);
    assert.equal(anon.status, 401, 'photos must not be public');
  });

  test('a weak subject is rejected without consuming the upload', async () => {
    rewind(13, 24);
    const before = fs.readdirSync(path.join(MEDIA, 'original')).length;
    const { status, data } = await bob('/hoods/13/claim',
      { method: 'POST', raw: await claimForm(await jpeg(80), 'animal') });
    assert.equal(status, 409);
    assert.equal(data.error, 'WEAK_TYPE');
    assert.deepEqual(data.required_types, ['person']);
    assert.equal(fs.readdirSync(path.join(MEDIA, 'original')).length, before,
      'a rejected claim must not leave files behind');
  });

  test('the adjacent-conquer cooldown is enforced over HTTP, and the list shows it', async () => {
    // Alice conquered Hood 13 earlier in this walkthrough. 13 borders 10, 11 and 14.
    const blocked = await alice('/hoods/11/claim',
      { method: 'POST', raw: await claimForm(await jpeg(55), 'animal') });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.error, 'ADJACENT_COOLDOWN');
    assert.ok(blocked.data.available_at, 'the client is told when it opens');

    // The Hood list must say the same thing, so the sheet can grey it out up front.
    const { data } = await alice('/hoods');
    const h11 = data.hoods.find((h) => h.id === 11);
    assert.equal(h11.owner, null, 'still unclaimed');
    assert.equal(h11.viewer.can_claim, false);
    assert.equal(h11.viewer.adjacent_blocked, true);
    assert.equal(h11.viewer.blocked_by_hood_id, 13);
    assert.deepEqual(h11.neighbours, [9, 10, 12, 13, 14, 15]);

    // And it binds only alice.
    const h11bob = (await bob('/hoods')).data.hoods.find((h) => h.id === 11);
    assert.equal(h11bob.viewer.adjacent_blocked, false);
    assert.equal(h11bob.viewer.can_claim, true);
  });

  test('the steal cooldown is enforced over HTTP', async () => {
    // Hood 16, not 14: 14 borders 13, which alice has already conquered, so the
    // adjacent-conquer cooldown would reject this before the steal lock could.
    const fresh = await alice('/hoods/16/claim',
      { method: 'POST', raw: await claimForm(await jpeg(30), 'person') });
    assert.equal(fresh.status, 201);

    const tooSoon = await bob('/hoods/16/claim',
      { method: 'POST', raw: await claimForm(await jpeg(40), 'animal') });
    assert.equal(tooSoon.status, 409);
    assert.equal(tooSoon.data.error, 'HOOD_LOCKED');
    assert.ok(tooSoon.data.available_at);
  });

  test('a beating subject takes the Hood and the ledger records who lost it', async () => {
    const { status, data } = await bob('/hoods/13/claim',
      { method: 'POST', raw: await claimForm(await jpeg(120), 'person') });
    assert.equal(status, 201);
    assert.equal(data.claim.claim_kind, 'steal');
    assert.equal(data.claim.points, 28, 'Hood 13 difficulty 14, doubled');
    assert.equal(data.claim.beaten.handle, 'alice');

    const hoods = await alice('/hoods');
    const h13 = hoods.data.hoods.find((h) => h.id === 13);
    assert.equal(h13.owner.handle, 'bob');
    assert.equal(h13.photo_type, 'person');
    assert.equal(h13.viewer.required_types[0], 'animal', 'alice now needs an animal');
  });

  test('standings are derived, and losing a Hood costs no points', async () => {
    const { data } = await alice('/leaderboard');
    const byHandle = Object.fromEntries(data.standings.map((r) => [r.player.handle, r]));
    // Hood 13 difficulty 14 + Hood 16 difficulty 15 = 29 for alice's two conquers;
    // bob stole Hood 13 for 14 x 2.
    assert.equal(byHandle.alice.points, 29, 'two conquers, priced by difficulty');
    assert.equal(byHandle.bob.points, 28, 'one steal, double difficulty');
    assert.equal(byHandle.alice.hoods_held, 1, 'alice lost Hood 13 but kept Hood 16');
    assert.equal(byHandle.bob.hoods_held, 1);

    const champion = await alice('/leaderboard/champion');
    assert.equal(champion.data.standings.find((r) => r.player.handle === 'bob').points, 28);
  });

  test('the feed carries the claims newest first', async () => {
    const { data } = await alice('/feed');
    assert.ok(data.feed.length >= 3);
    assert.equal(data.feed[0].claim_kind, 'steal');
    assert.ok(data.feed[0].thumb_url);
  });

  test('a reinforce reports the subject it replaced, not a player it "beat"', async () => {
    rewind(16, 80);
    const { status, data } = await alice('/hoods/16/claim',
      { method: 'POST', raw: await claimForm(await jpeg(200), 'animal') });
    assert.equal(status, 201);
    assert.equal(data.claim.claim_kind, 'reinforce');
    assert.equal(data.claim.beaten, null, 'you do not beat yourself');
    assert.equal(data.claim.replaced_photo_type, 'person');
    assert.match(data.claim.summary, /Alice reinforced Hood 16 .* with an animal photo \(\+25\)/);
  });

  test('you cannot flag your own claim', async () => {
    const { data: feed } = await bob('/feed');
    const bobsClaim = feed.feed.find((c) => c.player.handle === 'bob');
    const { status, data } = await bob(`/claims/${bobsClaim.id}/flag`,
      { method: 'POST', body: { reason: 'nice one me' } });
    assert.equal(status, 403);
    assert.equal(data.error, 'OWN_CLAIM');
  });

  test('two flags revert a claim, return the Hood and cancel the points', async () => {
    const { data: feed } = await alice('/feed');
    const target = feed.feed.find((c) => c.player.handle === 'bob' && c.claim_kind === 'steal');

    const first = await alice(`/claims/${target.id}/flag`,
      { method: 'POST', body: { reason: 'that is a stock photo' } });
    assert.equal(first.data.flag_count, 1);
    assert.equal(first.data.reverted, false);

    const dup = await alice(`/claims/${target.id}/flag`, { method: 'POST', body: { reason: 'again' } });
    assert.equal(dup.data.error, 'ALREADY_FLAGGED', 'one flag per player');

    const second = await carol(`/claims/${target.id}/flag`,
      { method: 'POST', body: { reason: 'agreed' } });
    assert.equal(second.data.flag_count, 2);
    assert.equal(second.data.reverted, true);

    const hoods = await alice('/hoods');
    const h13 = hoods.data.hoods.find((h) => h.id === 13);
    assert.equal(h13.owner.handle, 'alice', 'the Hood went back to alice');
    assert.equal(h13.photo_type, 'landmark');

    const board = await alice('/leaderboard');
    const bobRow = board.data.standings.find((r) => r.player.handle === 'bob');
    assert.equal(bobRow.points, 0, 'the reverted steal is cancelled exactly once');

    const chat = await alice('/chat');
    assert.ok(chat.data.messages.some((m) => /flagged/.test(m.body)), 'flags are public');
    assert.ok(chat.data.messages.some((m) => /reverted by 2 flags/.test(m.body)));
  });

  test('a flag cannot be withdrawn once the claim is already reverted', async () => {
    const { data: feed } = await alice('/feed');
    const reverted = feed.feed.find((c) => c.status === 'reverted');
    const { data } = await alice(`/claims/${reverted.id}/flag`, { method: 'DELETE' });
    assert.equal(data.error, 'ALREADY_REVERTED');
  });

  test('chat accepts a message over REST and hands it back', async () => {
    const said = await bob('/chat', { method: 'POST', body: { body: 'that was my nephew' } });
    assert.equal(said.status, 201);
    const { data } = await carol('/chat');
    assert.ok(data.messages.some((m) => m.body === 'that was my nephew' && m.handle === 'bob'));
  });

  test('a non-image upload is refused', async () => {
    const form = new FormData();
    form.append('photo', new Blob([Buffer.from('this is not a photo')], { type: 'image/jpeg' }), 'fake.jpg');
    form.append('photo_type', 'animal');
    const { status, data } = await carol('/hoods/20/claim', { method: 'POST', raw: form });
    assert.equal(status, 400);
    assert.equal(data.error, 'BAD_IMAGE');
  });

  test('logging out closes the door', async () => {
    const tmpClient = client();
    await tmpClient('/auth/login', { method: 'POST', body: { handle: 'alice', password: 'hunter2hunter2' } });
    assert.equal((await tmpClient('/me')).status, 200);
    await tmpClient('/auth/logout', { method: 'POST' });
    assert.equal((await tmpClient('/me')).status, 401);
  });

  test('a wrong password is refused with the same message as a wrong handle', async () => {
    const c = client();
    const wrongPass = await c('/auth/login', { method: 'POST', body: { handle: 'alice', password: 'nope' } });
    const noSuchUser = await c('/auth/login', { method: 'POST', body: { handle: 'nobody', password: 'nope' } });
    assert.equal(wrongPass.status, 401);
    assert.equal(noSuchUser.status, 401);
    assert.equal(wrongPass.data.message, noSuchUser.data.message);
  });
  test('the sign-in endpoint stops accepting guesses after ten', async () => {
    // The only door an anonymous stranger can knock on, and argon2 makes every knock
    // cost about 100ms of Pi CPU — so unlimited guessing is both a password risk and a
    // way to peg a box that is running other people's services too.
    // Deliberately not asserting a specific attempt number: this shares one IP bucket
    // with every other test in the file, so how much budget is left depends on what ran
    // before. What matters is that the door does eventually shut, and stays shut.
    const guesser = client();
    let blockedAt = null;
    for (let i = 1; i <= 40 && blockedAt === null; i++) {
      const r = await guesser('/auth/login',
        { method: 'POST', body: { handle: 'alice', password: `wrong-${i}` } });
      if (r.status === 429) blockedAt = i;
      else assert.equal(r.status, 401, `attempt ${i} should be a plain rejection`);
    }
    assert.ok(blockedAt, 'the endpoint should stop accepting guesses');

    const again = await guesser('/auth/login',
      { method: 'POST', body: { handle: 'alice', password: 'wrong-again' } });
    assert.equal(again.status, 429, 'and stay shut');

    const blocked = await guesser('/auth/login',
      { method: 'POST', body: { handle: 'alice', password: 'hunter2hunter2' } });
    assert.equal(blocked.status, 429, 'even the right password waits its turn');
    assert.equal(blocked.data.error, 'TOO_MANY_ATTEMPTS');
    assert.ok(blocked.data.retry_after > 0, 'and it says how long');
  });

});
