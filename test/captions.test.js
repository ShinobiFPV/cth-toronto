// Captions: the only player-authored prose in the game, and the only thing a player can
// change after the fact. Both of those make it worth pinning down — a caption must never
// be able to move a number, and editing one must never touch the ledger.
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-captions-'));
process.env.CTH_DB = path.join(tmp, 'test.sqlite');
process.env.CTH_JWT_SECRET = 'test-secret';

let db, nowIso, config, commitClaim, commitCollect, cleanCaption, setCaption;
let hoodDetail, feed, claimSummary;

before(async () => {
  ({ db, nowIso } = await import('../server/db.js'));
  ({ config } = await import('../server/config.js'));
  ({ commitClaim } = await import('../server/lib/game.js'));
  ({ commitCollect } = await import('../server/lib/parks.js'));
  ({ cleanCaption, setCaption } = await import('../server/lib/captions.js'));
  ({ hoodDetail, feed, claimSummary } = await import('../server/lib/views.js'));
});

let alice, bob;
let seq = 0;

const photo = () => {
  seq += 1;
  return {
    path_original: `original/c${seq}.jpg`,
    path_display: `display/c${seq}.webp`,
    path_thumb: `thumb/c${seq}.webp`,
    width: 1600, height: 1200, bytes: 2048, exif_json: null,
  };
};

const makePlayer = (handle, name) => Number(db.prepare(`
  INSERT INTO players (handle, display_name, password_hash, colour, is_admin, created_at)
  VALUES (?, ?, 'x', '#fff', 0, ?)`).run(handle, name, nowIso()).lastInsertRowid);

const conquer = (hoodId, playerId, caption) => commitClaim({
  hoodId, playerId, declaredType: 'landmark', photo: photo(), caption,
});

const captionOf = (claimId) => db.prepare(`
  SELECT ph.caption FROM claims c JOIN photos ph ON ph.id = c.photo_id
   WHERE c.id = ?`).get(claimId).caption;

beforeEach(() => {
  db.exec(`UPDATE hood_state SET owner_id = NULL, active_claim_id = NULL, photo_type = NULL,
           last_claim_at = NULL, locked_until = NULL`);
  // Item grants join to claims by id, and ids are reused once the table is emptied.
  db.exec('DELETE FROM item_uses; DELETE FROM item_armed; DELETE FROM item_grants');
  db.exec('DELETE FROM flags; DELETE FROM claims; DELETE FROM photos; DELETE FROM messages');
  db.exec('DELETE FROM parks; DELETE FROM players');

  db.prepare(`INSERT INTO parks (id, name, hood_id, lat, lng, value, distance_km, set_number)
              VALUES (8001, 'Test Parkette', 13, 43.65, -79.38, 25, 3.0, 1)`).run();

  seq += 1;
  alice = makePlayer(`alice${seq}`, 'Alice');
  bob = makePlayer(`bob${seq}`, 'Bob');
});

// ── shaping the text ──────────────────────────────────────────────────────
describe('cleanCaption', () => {
  test('keeps an ordinary caption as written', () => {
    assert.equal(cleanCaption('Raccoon, 6am, absolutely feral'), 'Raccoon, 6am, absolutely feral');
  });

  test('turns nothing into null, so the column is never an empty string', () => {
    for (const empty of [null, undefined, '', '   ', '\n\t ']) {
      assert.equal(cleanCaption(empty), null, `${JSON.stringify(empty)} should be null`);
    }
  });

  test('collapses newlines, because a caption is rendered on one line', () => {
    assert.equal(cleanCaption('line one\nline two\n\n\nline three'), 'line one line two line three');
    assert.equal(cleanCaption('  padded   out  '), 'padded out');
  });

  test('caps the length and does not leave a trailing space behind the cut', () => {
    const max = config.CAPTION_MAX_LENGTH;
    const long = `${'a'.repeat(max - 1)} ${'b'.repeat(50)}`;
    const out = cleanCaption(long);
    assert.equal(out.length, max - 1, 'the cut landed on a space, which is then trimmed');
    assert.ok(!out.endsWith(' '));
    assert.ok(cleanCaption('x'.repeat(max + 500)).length === max);
  });

  test('does not try to escape anything — that is the renderer\'s job', () => {
    // React escapes on output and nothing is rendered as HTML. Mangling the text here
    // would only corrupt a caption that legitimately contains an angle bracket.
    assert.equal(cleanCaption('<b>bold</b> & "quoted"'), '<b>bold</b> & "quoted"');
  });

  test('a number or an object does not throw', () => {
    assert.equal(cleanCaption(42), '42');
    assert.equal(typeof cleanCaption({}), 'string');
  });
});

// ── writing one at upload time ────────────────────────────────────────────
describe('captioning an upload', () => {
  test('a claim stores its caption and hands it straight back', () => {
    const { claim } = conquer(13, alice, '  the CN Tower,  obviously ');
    assert.equal(claim.caption, 'the CN Tower, obviously');
    assert.equal(captionOf(claim.id), 'the CN Tower, obviously');
  });

  test('no caption is null, not an empty string', () => {
    const { claim } = conquer(13, alice);
    assert.equal(claim.caption, null);
  });

  test('a park collection can be captioned too', () => {
    const { claim } = commitCollect({
      parkId: 8001, playerId: alice, photo: photo(), caption: 'sign was half eaten by a hedge',
    });
    assert.equal(claim.caption, 'sign was half eaten by a hedge');
  });

  test('a caption changes nothing that scores', () => {
    const plain = conquer(13, alice);
    db.exec(`UPDATE hood_state SET owner_id = NULL, active_claim_id = NULL, photo_type = NULL,
             last_claim_at = NULL, locked_until = NULL WHERE hood_id = 13`);
    db.exec('DELETE FROM item_grants; DELETE FROM claims; DELETE FROM photos');
    const captioned = conquer(13, alice, 'a very long and witty remark');

    assert.equal(captioned.claim.points, plain.claim.points);
    assert.equal(captioned.xp.xp, plain.xp.xp);
    assert.equal(captioned.claim.claim_kind, plain.claim.claim_kind);
  });

  test('the caption reaches the feed and the Hood shape', () => {
    conquer(13, alice, 'held with a hot dog cart');
    assert.equal(feed({ viewerId: alice })[0].caption, 'held with a hot dog cart');
    assert.equal(hoodDetail(13, alice).caption, 'held with a hot dog cart');
  });

  test('chat quotes the caption, because chat is the activity feed', () => {
    const { claim } = conquer(13, alice, 'raccoon with a slice');
    const row = db.prepare(`
      SELECT c.*, p.handle, p.display_name, h.name AS hood_name, ph.caption
        FROM claims c JOIN players p ON p.id = c.player_id
        JOIN hoods h ON h.id = c.hood_id
   LEFT JOIN photos ph ON ph.id = c.photo_id
       WHERE c.id = ?`).get(claim.id);
    assert.match(claimSummary(row), /\(\+\d+\) — "raccoon with a slice"$/);

    // And says nothing extra when there is no caption.
    assert.match(claimSummary({ ...row, caption: null }), /\(\+\d+\)$/);
  });
});

// ── editing one afterwards ────────────────────────────────────────────────
describe('editing a caption', () => {
  test('the owner can rewrite it', () => {
    const { claim } = conquer(13, alice, 'frist try');
    assert.equal(setCaption({ claimId: claim.id, playerId: alice, caption: 'first try' }), 'first try');
    assert.equal(captionOf(claim.id), 'first try');
  });

  test('the owner can clear it', () => {
    const { claim } = conquer(13, alice, 'regrettable');
    assert.equal(setCaption({ claimId: claim.id, playerId: alice, caption: '   ' }), null);
    assert.equal(captionOf(claim.id), null);
  });

  test('nobody else can', () => {
    const { claim } = conquer(13, alice, 'mine');
    assert.throws(() => setCaption({ claimId: claim.id, playerId: bob, caption: 'not yours' }),
      (err) => { assert.equal(err.code, 'NOT_YOUR_CLAIM'); return true; });
    assert.equal(captionOf(claim.id), 'mine', 'and the original survives the attempt');
  });

  test('an edit leaves the ledger row completely untouched', () => {
    const { claim } = conquer(13, alice, 'before');
    const before = db.prepare('SELECT * FROM claims WHERE id = ?').get(claim.id);

    setCaption({ claimId: claim.id, playerId: alice, caption: 'after' });

    const after = db.prepare('SELECT * FROM claims WHERE id = ?').get(claim.id);
    assert.deepEqual(after, before, 'a caption edit must not move anything in claims');
  });

  test('an edit is normalised exactly like a fresh one', () => {
    const { claim } = conquer(13, alice);
    const max = config.CAPTION_MAX_LENGTH;
    assert.equal(setCaption({ claimId: claim.id, playerId: alice, caption: 'a\n\nb' }), 'a b');
    assert.equal(
      setCaption({ claimId: claim.id, playerId: alice, caption: 'z'.repeat(max + 20) }).length, max);
  });

  test('a claim that is no longer standing can still be captioned', () => {
    // The photo is still yours and still in the feed, so fixing a typo on it should not
    // depend on still holding the Hood.
    const { claim } = conquer(13, alice, 'mine for now');
    // Let the anti-ping-pong lock lapse, then take it off her with the subject that
    // actually beats a landmark.
    db.exec('UPDATE hood_state SET locked_until = NULL WHERE hood_id = 13');
    commitClaim({ hoodId: 13, playerId: bob, declaredType: 'person', photo: photo() });
    assert.equal(db.prepare('SELECT status FROM claims WHERE id = ?').get(claim.id).status,
      'superseded');
    assert.equal(setCaption({ claimId: claim.id, playerId: alice, caption: 'mine briefly' }),
      'mine briefly');
  });

  test('a missing claim and a photoless one are told apart', () => {
    assert.throws(() => setCaption({ claimId: 999999, playerId: alice, caption: 'x' }),
      (err) => { assert.equal(err.code, 'CLAIM_NOT_FOUND'); return true; });

    // A reversal row carries no photo, so there is nothing to caption.
    const id = Number(db.prepare(`
      INSERT INTO claims (hood_id, player_id, season_id, photo_id, claim_kind, points_awarded,
                          xp_awarded, status, flag_count, created_at)
      VALUES (13, ?, 1, NULL, 'reversal', 0, 0, 'active', 0, ?)`)
      .run(alice, nowIso()).lastInsertRowid);
    assert.throws(() => setCaption({ claimId: id, playerId: alice, caption: 'x' }),
      (err) => { assert.equal(err.code, 'NO_PHOTO'); return true; });
  });

  test('can_caption is true only on your own photo', () => {
    conquer(13, alice, 'mine');
    assert.equal(feed({ viewerId: alice })[0].can_caption, true);
    assert.equal(feed({ viewerId: bob })[0].can_caption, false);
    assert.equal(feed({})[0].can_caption, false, 'no viewer, no pencil');
  });
});
