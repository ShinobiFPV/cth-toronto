// Special editions: Steel, Gold, Hologram — and Clover, the one item that touches the roll.
//
// Three things here are worth guarding. The rate table, because an off-by-one in the range
// mapping is invisible until somebody notices Holograms feel wrong in March. Clover, whose
// loop has to be cut somewhere. And the fact that an edition pays XP and never points,
// because a season decided by dice is not a season.
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-editions-'));
process.env.CTH_DB = path.join(tmp, 'test.sqlite');
process.env.CTH_JWT_SECRET = 'test-secret';

let db, nowIso, isoPlusHours, config, parks, editions, items, xpOf, xpFor, leaderboard;

before(async () => {
  ({ db, nowIso, isoPlusHours } = await import('../server/db.js'));
  ({ config } = await import('../server/config.js'));
  parks = await import('../server/lib/parks.js');
  editions = await import('../server/lib/editions.js');
  items = await import('../server/lib/items.js');
  ({ xpOf, xpFor } = await import('../server/lib/xp.js'));
  ({ leaderboard } = await import('../server/lib/views.js'));
  // The weekly item cap has its own suite. Here it would only get in the way of handing a
  // player the Clover a test needs.
  config.ITEM_WEEKLY_CAP = 0;
});

const PARKS = [
  { id: 5001, name: 'Alpha Park', hood_id: 13, value: 10, distance_km: 1.0, set_number: 1 },
  { id: 5002, name: 'Beta Park', hood_id: 13, value: 60, distance_km: 9.0, set_number: 2 },
  { id: 5003, name: 'Gamma Park', hood_id: 13, value: 100, distance_km: 25.0, set_number: 3 },
  { id: 5004, name: 'Delta Park', hood_id: 25, value: 100, distance_km: 26.0, set_number: 4 },
];

let alice, bob;
let seq = 0;
let parkSeq = 5100;

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

/** Another cheap park, for tests that need more collections than the fixtures hold. */
const addPark = (hoodId = 13, value = 5) => {
  parkSeq += 1;
  db.prepare(`INSERT INTO parks (id, name, hood_id, lat, lng, value, distance_km, set_number)
              VALUES (?, ?, ?, 43.65, -79.38, ?, 1, ?)`)
    .run(parkSeq, `Extra Park ${parkSeq}`, hoodId, value, parkSeq);
  return parkSeq;
};

const withConfig = (patch, fn) => {
  const was = Object.fromEntries(Object.keys(patch).map((k) => [k, config[k]]));
  Object.assign(config, patch);
  try { return fn(); } finally { Object.assign(config, was); }
};

/**
 * Force the roll. A draw of 0 is the first Hologram slot, the draw just past the Hologram
 * range is the first Gold one, and the last draw is Steel — read off the live rate table,
 * so rebalancing the rates does not turn this file red.
 */
const force = (key, { clover = false } = {}) => (n) => {
  const r = editions.editionRates({ clover });
  if (key === 'hologram') return 0;
  if (key === 'gold') return Math.round((r.hologram / 100) * n);
  return n - 1;
};

/** Force which item a grant is, by landing on the start of that type's weight range. */
const pick = (type) => () => {
  let offset = 0;
  for (const t of items.ITEM_TYPES) {
    if (t === type) return offset;
    offset += Math.round(config.ITEM_WEIGHTS[t] * 1000);
  }
  throw new Error(`no item type ${type}`);
};

/** mulberry32: a small, seedable PRNG, adapted to crypto.randomInt's (n) => [0, n). */
function seeded(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (n) => Math.floor(next() * n);
}

/** Pull a Gold card that grants a Clover, and pop it. */
const popClover = (playerId) => {
  const { items: granted } = parks.commitCollect({
    parkId: addPark(), playerId, photo: photo(), rand: force('gold'), itemRand: pick('clover'),
  });
  return items.useItem({ playerId, grantId: granted.items[0].grant_id });
};

const editionOf = (claimId) =>
  db.prepare('SELECT edition FROM claims WHERE id = ?').get(claimId).edition;

beforeEach(() => {
  db.exec('DELETE FROM item_uses; DELETE FROM item_armed; DELETE FROM item_grants');
  db.exec('DELETE FROM trades; DELETE FROM card_holdings');
  db.exec(`UPDATE hood_state SET owner_id = NULL, active_claim_id = NULL, photo_type = NULL,
           last_claim_at = NULL, locked_until = NULL`);
  db.exec('DELETE FROM flags; DELETE FROM claims; DELETE FROM photos; DELETE FROM messages');
  db.exec('DELETE FROM parks; DELETE FROM players');
  parks.forgetSetSize();
  parkSeq = 5100;

  const ins = db.prepare(`
    INSERT INTO parks (id, name, hood_id, lat, lng, value, distance_km, set_number)
    VALUES (@id, @name, @hood_id, 43.65, -79.38, @value, @distance_km, @set_number)`);
  for (const p of PARKS) ins.run(p);

  seq += 1;
  alice = makePlayer(`alice${seq}`);
  bob = makePlayer(`bob${seq}`);
});

// ── the rate table ────────────────────────────────────────────────────────
describe('the rate table', () => {
  test('sums to 100 with Steel as the remainder, at base and under Clover', () => {
    for (const clover of [false, true]) {
      const r = editions.editionRates({ clover });
      assert.equal(r.hologram + r.gold + r.steel, 100, `clover=${clover}`);
      assert.equal(r.steel, 100 - r.hologram - r.gold, 'Steel is whatever is left');
    }
    const base = editions.editionRates();
    const doubled = editions.editionRates({ clover: true });
    assert.equal(doubled.hologram, base.hologram * config.CLOVER_MULTIPLIER);
    assert.equal(doubled.gold, base.gold * config.CLOVER_MULTIPLIER);
  });

  test('the defaults are the spec’s: 2 / 12 / 86, and 4 / 24 / 72 under Clover', () => {
    assert.deepEqual(editions.editionRates(), { hologram: 2, gold: 12, steel: 86 });
    assert.deepEqual(editions.editionRates({ clover: true }), { hologram: 4, gold: 24, steel: 72 });
  });

  test('Clover is clamped, so raised base rates can never ask for more than the whole draw', () => {
    withConfig({ EDITION_HOLOGRAM_PCT: 40, EDITION_GOLD_PCT: 45 }, () => {
      assert.deepEqual(editions.editionRates({ clover: true }), { hologram: 80, gold: 20, steel: 0 });
    });
    withConfig({ EDITION_HOLOGRAM_PCT: 60, EDITION_GOLD_PCT: 30 }, () => {
      assert.deepEqual(editions.editionRates({ clover: true }), { hologram: 100, gold: 0, steel: 0 });
    });
  });

  test('the range boundaries are exact, at base and doubled', () => {
    const n = editions.ROLL_SCALE;
    const at = (draw, clover = false) => editions.rollEdition({ rand: () => draw, clover });
    for (const clover of [false, true]) {
      const r = editions.editionRates({ clover });
      const holoEnd = Math.round((r.hologram / 100) * n);
      const goldEnd = Math.round(((r.hologram + r.gold) / 100) * n);
      assert.equal(at(0, clover), 'hologram', 'an all-hits draw is the rarest, not demoted');
      assert.equal(at(holoEnd - 1, clover), 'hologram');
      assert.equal(at(holoEnd, clover), 'gold');
      assert.equal(at(goldEnd - 1, clover), 'gold');
      assert.equal(at(goldEnd, clover), 'steel');
      assert.equal(at(n - 1, clover), 'steel');
    }
  });

  test('a disabled edition is simply skipped', () => {
    withConfig({ EDITION_HOLOGRAM_PCT: 0 }, () => {
      assert.equal(editions.rollEdition({ rand: () => 0 }), 'gold',
        'with holograms off, the first draw lands on the next one down');
    });
  });

  test('rarest first, and they pay XP in the same order', () => {
    assert.deepEqual(editions.EDITIONS.map((e) => e.key), ['hologram', 'gold', 'steel']);
    const [holo, gold, steel] = editions.EDITIONS;
    assert.ok(holo.xp > gold.xp && gold.xp > steel.xp);
  });

  test('a seeded sample lands on the configured rates, at base and doubled', () => {
    // The assertion that catches an off-by-one in the range mapping. 200,000 draws puts
    // one standard deviation of the 2% bucket at about 0.03 points, so 0.25 is generous
    // and still far tighter than any real mistake.
    const N = 200_000;
    for (const clover of [false, true]) {
      const rand = seeded(clover ? 9 : 7);
      const counts = { hologram: 0, gold: 0, steel: 0 };
      for (let i = 0; i < N; i += 1) counts[editions.rollEdition({ rand, clover })] += 1;
      const want = editions.editionRates({ clover });
      for (const key of Object.keys(counts)) {
        const got = (counts[key] / N) * 100;
        assert.ok(Math.abs(got - want[key]) < 0.25,
          `${key} came out ${got.toFixed(2)}%, configured ${want[key]}% (clover=${clover})`);
      }
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
});

// ── caps: none, but the path stays ────────────────────────────────────────
describe('no edition is capped', () => {
  test('a Hood yields as many holograms as the dice hand out', () => {
    const first = parks.commitCollect({ parkId: 5001, playerId: alice, photo: photo(), rand: force('hologram') });
    const second = parks.commitCollect({ parkId: 5002, playerId: bob, photo: photo(), rand: force('hologram') });
    const third = parks.commitCollect({ parkId: 5003, playerId: alice, photo: photo(), rand: force('hologram') });
    assert.deepEqual([first, second, third].map((r) => r.claim.edition),
      ['hologram', 'hologram', 'hologram'], 'the per-Hood hologram cap is gone');
  });

  test('the fall-through still works, for the day a cap comes back', () => {
    // A synthetic cap injected into the roll. Nothing in the game passes one; this test is
    // what stops the path rotting before anybody wants it again.
    const roll = (capped) => editions.rollEdition({ rand: () => 0, capped });
    assert.equal(roll((k) => k === 'hologram'), 'gold', 'a hit on a capped edition lands one down');
    assert.equal(roll((k) => k === 'hologram' || k === 'gold'), 'steel');
    assert.equal(roll(() => true), 'steel', 'and Steel can never be capped');
    assert.equal(editions.rollEdition({ rand: force('gold'), capped: (k) => k === 'hologram' }), 'gold',
      'a cap on a rarer edition does not touch a lesser hit');
  });
});

// ── Clover ────────────────────────────────────────────────────────────────
describe('Clover', () => {
  test('doubles the special rates for the player who popped it, and nobody else', () => {
    // A draw just past the base Gold range: Steel for anybody, Gold under a Clover.
    const r = editions.editionRates();
    const draw = () => Math.round(((r.hologram + r.gold) / 100) * editions.ROLL_SCALE);

    popClover(alice);
    const lucky = parks.commitCollect({ parkId: 5001, playerId: alice, photo: photo(), rand: draw });
    const plain = parks.commitCollect({ parkId: 5001, playerId: bob, photo: photo(), rand: draw });
    assert.equal(lucky.claim.edition, 'gold');
    assert.equal(plain.claim.edition, 'steel');
  });

  test('a pull inside an active Clover window never grants Clover', () => {
    // The last slot in the weight table is Clover's. Inside a window it is excluded, so
    // the same draw has to land on something else.
    const last = (total) => total - 1;
    const outside = parks.commitCollect({
      parkId: 5001, playerId: bob, photo: photo(), rand: force('hologram'), itemRand: last,
    });
    assert.ok(outside.items.items.every((i) => i.item_type === 'clover'), 'the draw is Clover normally');

    popClover(alice);
    const inside = parks.commitCollect({
      parkId: 5002, playerId: alice, photo: photo(), rand: force('hologram', { clover: true }), itemRand: last,
    });
    assert.equal(inside.items.items.length, 3);
    assert.ok(inside.items.items.every((i) => i.item_type !== 'clover'), 'and never inside the window');

    const rand = seeded(3);
    for (let i = 0; i < 5000; i += 1) {
      assert.notEqual(items.rollItemType({ rand, exclude: ['clover'] }), 'clover');
    }
  });

  test('a second Clover while one is running is CLOVER_ACTIVE, and is not spent', () => {
    popClover(alice);
    const { items: granted } = parks.commitCollect({
      parkId: addPark(), playerId: alice, photo: photo(), rand: force('gold', { clover: true }), itemRand: pick('recon'),
    });
    assert.equal(granted.items[0].item_type, 'recon');

    // A second Clover, pulled before the first one was popped so the exclusion does not apply.
    const spare = Number(db.prepare(`
      INSERT INTO item_grants (claim_id, player_id, season_id, week_key, item_type, created_at)
      SELECT claim_id, player_id, season_id, week_key, 'clover', created_at FROM item_grants
       WHERE id = ?`).run(granted.items[0].grant_id).lastInsertRowid);

    assert.throws(() => items.useItem({ playerId: alice, grantId: spare }),
      (err) => { assert.equal(err.code, 'CLOVER_ACTIVE'); assert.ok(err.expires_at); return true; });
    assert.equal(items.inventoryOf(alice).counts.clover, 1, 'not extended, not stacked, not spent');
  });

  test('expires exactly six hours in', () => {
    popClover(alice);
    const at = nowIso();
    // Wind the clock back rather than waiting: it was popped six hours ago, to the ms.
    db.prepare(`UPDATE item_uses SET created_at = ?, expires_at = ? WHERE item_type = 'clover'`)
      .run(isoPlusHours(at, -config.CLOVER_HOURS), at);

    assert.equal(items.activeClover(alice, at), null, 'at six hours it is over');
    const justBefore = new Date(Date.parse(at) - 1).toISOString();
    assert.ok(items.activeClover(alice, justBefore), 'a millisecond earlier it was still running');

    // And a new one can be popped the moment the old one ends.
    popClover(alice);
    assert.ok(items.activeClover(alice));
  });
});

// ── what an edition does not touch ────────────────────────────────────────
describe('an edition is XP, never points', () => {
  test('two identical parks pay the same points whatever their edition', () => {
    const plain = parks.commitCollect({ parkId: 5003, playerId: alice, photo: photo(), rand: force('steel') });
    const holo = parks.commitCollect({ parkId: 5004, playerId: bob, photo: photo(), rand: force('hologram') });
    assert.equal(plain.claim.points, 100);
    assert.equal(holo.claim.points, 100, 'the park is worth what the park is worth');
    const [hologram, , steel] = editions.EDITIONS;
    assert.equal(holo.xp.xp - plain.xp.xp, hologram.xp - steel.xp, 'but the hologram pays more XP');
  });

  test('the season table cannot be moved by luck', () => {
    parks.commitCollect({ parkId: 5003, playerId: alice, photo: photo(), rand: force('steel') });
    const before = leaderboard().find((r) => r.player.id === alice).points;

    db.exec('DELETE FROM item_grants; DELETE FROM claims; DELETE FROM photos');
    parks.commitCollect({ parkId: 5003, playerId: alice, photo: photo(), rand: force('hologram') });
    const after = leaderboard().find((r) => r.player.id === alice).points;

    assert.equal(after, before, 'same park, same points, hologram or not');
  });

  test('the XP is frozen onto the row like every other kind', () => {
    const { claim } = parks.commitCollect({ parkId: 5001, playerId: alice, photo: photo(), rand: force('gold') });
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
    const { claim } = parks.commitCollect({ parkId: 5001, playerId: alice, photo: photo(), rand: force('steel') });
    assert.equal(claim.edition, 'steel');
    assert.equal(claim.edition_label, 'Steel');

    const card = parks.getCardByClaim(claim.claim_id);
    assert.equal(card.edition, 'steel');
    assert.equal(card.edition_label, 'Steel');
  });

  test('every new card is at least Steel; one collected before that says nothing', () => {
    const { claim } = parks.commitCollect({ parkId: 5001, playerId: alice, photo: photo(), rand: force('steel') });
    assert.equal(editionOf(claim.claim_id), 'steel', 'nothing new rolls below Steel');

    // A card from before the rate table changed has no edition, and still renders.
    db.prepare('UPDATE claims SET edition = NULL WHERE id = ?').run(claim.claim_id);
    const old = parks.getCardByClaim(claim.claim_id);
    assert.equal(old.edition, null);
    assert.equal(old.edition_label, null);
  });

  test('the binder counts them', () => {
    parks.commitCollect({ parkId: 5001, playerId: alice, photo: photo(), rand: force('steel') });
    parks.commitCollect({ parkId: 5002, playerId: alice, photo: photo(), rand: force('steel') });
    parks.commitCollect({ parkId: 5003, playerId: alice, photo: photo(), rand: force('gold') });
    parks.commitCollect({ parkId: 5004, playerId: alice, photo: photo(), rand: force('steel') });

    assert.deepEqual(parks.collectionSummary(alice).by_edition, { steel: 3, gold: 1 });
    assert.deepEqual(parks.collectionSummary(bob).by_edition, {});
  });

  test('editions follow the card when it is traded', () => {
    // The edition is a property of the card, not of who is holding it.
    const { claim } = parks.commitCollect({ parkId: 5004, playerId: alice, photo: photo(), rand: force('gold') });
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
