// Special editions: Steel, Gold, Hologram.
//
// Two things here are worth guarding. The hologram cap, because it is the only scarce
// thing in a sub-game that otherwise has nothing to fight over — and the fact that an
// edition pays XP and never points, because a season decided by dice is not a season.
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-editions-'));
process.env.CTH_DB = path.join(tmp, 'test.sqlite');
process.env.CTH_JWT_SECRET = 'test-secret';

let db, nowIso, config, parks, editions, xpOf, xpFor, leaderboard, revertClaim;

before(async () => {
  ({ db, nowIso } = await import('../server/db.js'));
  ({ config } = await import('../server/config.js'));
  parks = await import('../server/lib/parks.js');
  editions = await import('../server/lib/editions.js');
  ({ xpOf, xpFor } = await import('../server/lib/xp.js'));
  ({ leaderboard } = await import('../server/lib/views.js'));
  ({ revertClaim } = await import('../server/lib/game.js'));
});

// Two Hoods, so the per-Hood cap has somewhere to not apply.
const PARKS = [
  { id: 5001, name: 'Alpha Park', hood_id: 13, value: 10, distance_km: 1.0, set_number: 1 },
  { id: 5002, name: 'Beta Park', hood_id: 13, value: 60, distance_km: 9.0, set_number: 2 },
  { id: 5003, name: 'Gamma Park', hood_id: 13, value: 100, distance_km: 25.0, set_number: 3 },
  { id: 5004, name: 'Delta Park', hood_id: 25, value: 100, distance_km: 26.0, set_number: 4 },
];

let alice, bob;
let seq = 0;

const photo = () => {
  seq += 1;
  return {
    path_original: `original/e${seq}.jpg`,
    path_display: `display/e${seq}.webp`,
    path_thumb: `thumb/e${seq}.webp`,
    width: 1200, height: 900, bytes: 2048, exif_json: null,
  };
};

const makePlayer = (handle) => Number(db.prepare(`
  INSERT INTO players (handle, display_name, password_hash, colour, is_admin, created_at)
  VALUES (?, ?, 'x', '#fff', 0, ?)`).run(handle, handle, nowIso()).lastInsertRowid);

const collect = (parkId, playerId) =>
  parks.commitCollect({ parkId, playerId, photo: photo() });

/**
 * Force the roll. rollEdition asks `rand(oneIn)` for each edition rarest-first and
 * treats 0 as a hit, so returning 0 only for the wanted edition's own denominator
 * pins the outcome.
 */
const always = (key) => {
  const want = editions.EDITIONS.find((e) => e.key === key);
  return (oneIn) => (want && oneIn === want.oneIn() ? 0 : 1);
};
const never = () => 1;

const editionOf = (claimId) =>
  db.prepare('SELECT edition FROM claims WHERE id = ?').get(claimId).edition;

beforeEach(() => {
  db.exec('DELETE FROM trades; DELETE FROM card_holdings');
  db.exec(`UPDATE hood_state SET owner_id = NULL, active_claim_id = NULL, photo_type = NULL,
           last_claim_at = NULL, locked_until = NULL`);
  db.exec('DELETE FROM flags; DELETE FROM claims; DELETE FROM photos; DELETE FROM messages');
  db.exec('DELETE FROM parks; DELETE FROM players');
  parks.forgetSetSize();

  const ins = db.prepare(`
    INSERT INTO parks (id, name, hood_id, lat, lng, value, distance_km, set_number)
    VALUES (@id, @name, @hood_id, 43.65, -79.38, @value, @distance_km, @set_number)`);
  for (const p of PARKS) ins.run(p);

  seq += 1;
  alice = makePlayer(`alice${seq}`);
  bob = makePlayer(`bob${seq}`);
});

// ── the roll ──────────────────────────────────────────────────────────────
describe('rolling an edition', () => {
  test('most cards are standard', () => {
    assert.equal(editions.rollEdition({ hoodId: 13, seasonId: 1, rand: never }), null);
  });

  test('each edition can come up', () => {
    for (const key of ['steel', 'gold', 'hologram']) {
      assert.equal(editions.rollEdition({ hoodId: 13, seasonId: 1, rand: always(key) }), key);
    }
  });

  test('the rarest hit wins, not the last one checked', () => {
    // A roll that satisfies everything must be a hologram, not demoted to steel.
    assert.equal(editions.rollEdition({ hoodId: 13, seasonId: 1, rand: () => 0 }), 'hologram');
  });

  test('a disabled edition is simply skipped', () => {
    const was = config.EDITION_HOLO_ONE_IN;
    config.EDITION_HOLO_ONE_IN = 0;
    try {
      assert.equal(editions.rollEdition({ hoodId: 13, seasonId: 1, rand: () => 0 }), 'gold',
        'with holograms off, an all-hits roll lands on the next one down');
    } finally {
      config.EDITION_HOLO_ONE_IN = was;
    }
  });

  test('XP is added per edition, on top of rarity', () => {
    const plain = xpFor({ kind: 'park', playerId: alice, parkId: 5001, rarity: 'common' });
    for (const e of editions.EDITIONS) {
      const special = xpFor({
        kind: 'park', playerId: alice, parkId: 5001, rarity: 'common', edition: e.key,
      });
      assert.equal(special.xp, plain.xp + e.xp, `${e.key} should add ${e.xp}`);
      assert.equal(special.edition_xp, e.xp);
    }
    assert.equal(editions.editionXp(null), 0, 'a standard card adds nothing');
    assert.equal(editions.editionXp('platinum'), 0, 'and an unknown one is not a crash');
  });

  test('holograms are the rarest and steel the least rare', () => {
    const [holo, gold, steel] = editions.EDITIONS;
    assert.equal(holo.key, 'hologram');
    assert.ok(holo.oneIn() > gold.oneIn(), 'hologram must be rarer than gold');
    assert.ok(gold.oneIn() > steel.oneIn(), 'gold must be rarer than steel');
    assert.ok(holo.xp > gold.xp && gold.xp > steel.xp, 'and pay in the same order');
  });
});

// ── one hologram per Hood per season ──────────────────────────────────────
describe('the hologram cap', () => {
  test('a Hood yields one, and then no more that season', () => {
    const first = parks.commitCollect({
      parkId: 5001, playerId: alice, photo: photo(), rand: always('hologram'),
    });
    assert.equal(first.claim.edition, 'hologram');

    // Same Hood, another park, a roll that would otherwise be a hologram.
    const second = parks.commitCollect({
      parkId: 5002, playerId: alice, photo: photo(), rand: always('hologram'),
    });
    assert.notEqual(second.claim.edition, 'hologram', 'the Hood 13 hologram is gone');
    assert.equal(editions.holosInHood(13, first.season_id), 1);
  });

  test('the luck is not wasted — it falls through to the next edition down', () => {
    parks.commitCollect({ parkId: 5001, playerId: alice, photo: photo(), rand: always('hologram') });
    // A roll that hits everything, in a Hood whose hologram has gone.
    const next = parks.commitCollect({
      parkId: 5002, playerId: alice, photo: photo(), rand: () => 0,
    });
    assert.equal(next.claim.edition, 'gold', 'a hit is a hit; it lands one tier down');
  });

  test('another Hood still has its own', () => {
    parks.commitCollect({ parkId: 5001, playerId: alice, photo: photo(), rand: always('hologram') });
    const other = parks.commitCollect({
      parkId: 5004, playerId: alice, photo: photo(), rand: always('hologram'),
    });
    assert.equal(other.claim.edition, 'hologram', 'Hood 25 is a different Hood');
  });

  test('the cap is global, not per player', () => {
    // The only scarce thing in the parks game. Once it is out, it is out.
    parks.commitCollect({ parkId: 5001, playerId: alice, photo: photo(), rand: always('hologram') });
    const theirs = parks.commitCollect({
      parkId: 5002, playerId: bob, photo: photo(), rand: always('hologram'),
    });
    assert.notEqual(theirs.claim.edition, 'hologram');
  });

  test('a hologram thrown out by flags frees the Hood again', () => {
    const first = parks.commitCollect({
      parkId: 5001, playerId: alice, photo: photo(), rand: always('hologram'),
    });
    revertClaim(first.claim.claim_id);
    assert.equal(editions.holosInHood(13, first.season_id), 0,
      'a reverted claim is not a card, so it does not hold the slot');

    const again = parks.commitCollect({
      parkId: 5002, playerId: bob, photo: photo(), rand: always('hologram'),
    });
    assert.equal(again.claim.edition, 'hologram');
  });
});

// ── what an edition does not touch ────────────────────────────────────────
describe('an edition is XP, never points', () => {
  test('two identical parks pay the same points whatever their edition', () => {
    const plain = parks.commitCollect({
      parkId: 5003, playerId: alice, photo: photo(), rand: never,
    });
    const holo = parks.commitCollect({
      parkId: 5004, playerId: bob, photo: photo(), rand: always('hologram'),
    });
    assert.equal(plain.claim.points, 100);
    assert.equal(holo.claim.points, 100, 'the park is worth what the park is worth');
    assert.ok(holo.xp.xp > plain.xp.xp, 'but the hologram pays more XP');
    assert.equal(holo.xp.xp - plain.xp.xp, 100);
  });

  test('the season table cannot be moved by luck', () => {
    parks.commitCollect({ parkId: 5003, playerId: alice, photo: photo(), rand: never });
    const before = leaderboard().find((r) => r.player.id === alice).points;

    db.exec('DELETE FROM claims; DELETE FROM photos');
    parks.commitCollect({ parkId: 5003, playerId: alice, photo: photo(), rand: () => 0 });
    const after = leaderboard().find((r) => r.player.id === alice).points;

    assert.equal(after, before, 'same park, same points, hologram or not');
  });

  test('the XP is frozen onto the row like every other kind', () => {
    const { claim } = parks.commitCollect({
      parkId: 5001, playerId: alice, photo: photo(), rand: always('gold'),
    });
    const row = db.prepare('SELECT edition, xp_awarded, points_awarded FROM claims WHERE id = ?')
      .get(claim.claim_id);
    assert.equal(row.edition, 'gold');
    // 10 base + 0 rarity (common) + 15 discovery + 40 gold.
    assert.equal(row.xp_awarded, 65);
    assert.equal(xpOf(alice), 65);
  });
});

// ── how it shows up ──────────────────────────────────────────────────────
describe('editions on the card', () => {
  test('a card carries its edition and a label', () => {
    const { claim } = parks.commitCollect({
      parkId: 5001, playerId: alice, photo: photo(), rand: always('steel'),
    });
    assert.equal(claim.edition, 'steel');
    assert.equal(claim.edition_label, 'Steel');

    const card = parks.getCardByClaim(claim.claim_id);
    assert.equal(card.edition, 'steel');
    assert.equal(card.edition_label, 'Steel');
  });

  test('a standard card says so by saying nothing', () => {
    const { claim } = parks.commitCollect({
      parkId: 5001, playerId: alice, photo: photo(), rand: never,
    });
    assert.equal(claim.edition, null);
    assert.equal(claim.edition_label, null);
    assert.equal(editionOf(claim.claim_id), null);
  });

  test('the binder counts them', () => {
    parks.commitCollect({ parkId: 5001, playerId: alice, photo: photo(), rand: always('steel') });
    parks.commitCollect({ parkId: 5002, playerId: alice, photo: photo(), rand: always('steel') });
    parks.commitCollect({ parkId: 5003, playerId: alice, photo: photo(), rand: always('gold') });
    parks.commitCollect({ parkId: 5004, playerId: alice, photo: photo(), rand: never });

    assert.deepEqual(parks.collectionSummary(alice).by_edition, { steel: 2, gold: 1 });
    assert.deepEqual(parks.collectionSummary(bob).by_edition, {});
  });

  test('editions follow the card when it is traded', () => {
    // The edition is a property of the card, not of who is holding it.
    const { claim } = parks.commitCollect({
      parkId: 5004, playerId: alice, photo: photo(), rand: always('gold'),
    });
    db.prepare(`INSERT INTO card_holdings (claim_id, holder_id, from_player_id, acquired_at)
                VALUES (?, ?, ?, ?)`).run(claim.claim_id, bob, alice, nowIso());

    assert.deepEqual(parks.collectionSummary(bob).by_edition, { gold: 1 });
    assert.deepEqual(parks.collectionSummary(alice).by_edition, {});
    assert.equal(parks.cardsOf(bob)[0].edition, 'gold');
    // 10 base + 30 legendary + 15 discovery + 40 gold. Delta Park is worth 100.
    assert.equal(xpOf(alice), 95, 'and the XP stays with whoever pulled it');
    assert.equal(xpOf(bob), 0);
  });
});
