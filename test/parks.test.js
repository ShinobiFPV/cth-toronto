// Parks: the collection rules, the card seed, and how park points join the score.
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-parks-'));
process.env.CTH_DB = path.join(tmp, 'test.sqlite');
process.env.CTH_JWT_SECRET = 'test-secret';

let db, nowIso, parks, leaderboard, revertClaim, config, commitClaim, weekKey, editionRates;

before(async () => {
  ({ db, nowIso } = await import('../server/db.js'));
  parks = await import('../server/lib/parks.js');
  ({ leaderboard } = await import('../server/lib/views.js'));
  ({ revertClaim, commitClaim } = await import('../server/lib/game.js'));
  ({ config } = await import('../server/config.js'));
  ({ weekKey } = await import('../server/lib/week.js'));
  ({ editionRates } = await import('../server/lib/editions.js'));
});

// ── fixtures ──────────────────────────────────────────────────────────────
// Parks are seeded by hand rather than imported: the suite must not need the network,
// and a handful of known values is easier to reason about than 1,513 real ones.
const PARKS = [
  { id: 9001, name: 'Downtown Parkette', hood_id: 13, lat: 43.653, lng: -79.384, value: 5, distance_km: 0.2, set_number: 1 },
  { id: 9002, name: 'Midtown Green', hood_id: 13, lat: 43.700, lng: -79.390, value: 30, distance_km: 5.3, set_number: 2 },
  { id: 9003, name: 'Far Ravine Park', hood_id: 25, lat: 43.810, lng: -79.150, value: 70, distance_km: 22.0, set_number: 3 },
  { id: 9004, name: 'Edge of the World Park', hood_id: 25, lat: 43.820, lng: -79.130, value: 100, distance_km: 26.0, set_number: 4 },
];

let alice, bob;
let seq = 0;

const photo = () => {
  seq += 1;
  return {
    path_original: `original/p${seq}.jpg`,
    path_display: `display/p${seq}.webp`,
    path_thumb: `thumb/p${seq}.webp`,
    width: 1600, height: 1200, bytes: 2048, exif_json: null,
  };
};

const collect = (parkId, playerId) => parks.commitCollect({ parkId, playerId, photo: photo() });

const makePlayer = (handle) => Number(db.prepare(`
  INSERT INTO players (handle, display_name, password_hash, colour, is_admin, created_at)
  VALUES (?, ?, 'x', '#fff', 0, ?)`).run(handle, handle, nowIso()).lastInsertRowid);

const points = (playerId) => db.prepare(`
  SELECT COALESCE(SUM(points_awarded), 0) AS p FROM claims
   WHERE player_id = ? AND status != 'reverted'`).get(playerId).p;

beforeEach(() => {
  db.exec(`UPDATE hood_state SET owner_id = NULL, active_claim_id = NULL, photo_type = NULL,
           last_claim_at = NULL, locked_until = NULL`);
  // Item grants join to claims by id, and ids are reused once the table is emptied.
  db.exec('DELETE FROM item_uses; DELETE FROM item_armed; DELETE FROM item_grants');
  db.exec('DELETE FROM flags; DELETE FROM claims; DELETE FROM photos; DELETE FROM messages');
  db.exec('DELETE FROM parks');
  db.exec('DELETE FROM players');
  parks.forgetSetSize();

  const ins = db.prepare(`
    INSERT INTO parks (id, name, hood_id, lat, lng, value, distance_km, set_number)
    VALUES (@id, @name, @hood_id, @lat, @lng, @value, @distance_km, @set_number)`);
  for (const p of PARKS) ins.run(p);

  alice = makePlayer(`alice${++seq}`);
  bob = makePlayer(`bob${seq}`);
});

// ── collecting ────────────────────────────────────────────────────────────
describe('collecting a park', () => {
  test('pays the park\'s value and files it under claim_kind park', () => {
    const { claim } = collect(9004, alice);
    assert.equal(claim.points, 100);
    assert.equal(claim.park.name, 'Edge of the World Park');

    const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(claim.claim_id);
    assert.equal(row.claim_kind, 'park');
    assert.equal(row.park_id, 9004);
    assert.equal(row.points_awarded, 100);
  });

  test('never touches territory — a park is not a Hood', () => {
    collect(9004, alice);
    const state = db.prepare('SELECT * FROM hood_state WHERE hood_id = 25').get();
    assert.equal(state.owner_id, null, 'collecting a park must not claim the Hood');
    assert.equal(state.active_claim_id, null);
    assert.equal(state.locked_until, null);
  });

  test('is refused a second time in the same season', () => {
    collect(9001, alice);
    assert.throws(() => collect(9001, alice), (err) => {
      assert.equal(err.code, 'ALREADY_COLLECTED');
      return true;
    });
  });

  test('does not stop anybody else collecting the same park', () => {
    collect(9001, alice);
    const { claim } = collect(9001, bob);
    assert.equal(claim.points, 5, 'no competition, no scarcity, same points');
  });

  test('comes back around in the next season', () => {
    collect(9001, alice);
    // Same park, next season: a different season_id, so the once-per-season rule frees up.
    db.prepare('UPDATE claims SET season_id = 1 WHERE park_id = 9001').run();
    const seasonTwo = db.prepare('SELECT * FROM seasons WHERE id = 2').get();
    assert.ok(seasonTwo, 'the fixture database has four seasons');

    // evaluateCollect works off the ACTIVE season, so assert through the ledger instead:
    // there is no row for this park in season 2, which is what makes it collectable again.
    const inSeasonTwo = db.prepare(`
      SELECT COUNT(*) AS n FROM claims
       WHERE player_id = ? AND park_id = 9001 AND season_id = 2 AND status != 'reverted'`)
      .get(alice).n;
    assert.equal(inSeasonTwo, 0);
  });

  test('a park that does not exist is refused', () => {
    assert.throws(() => collect(424242, alice), /PARK_NOT_FOUND|No park/);
  });

  test('the database refuses a duplicate even if the check is bypassed', () => {
    const { claim } = collect(9002, alice);
    const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(claim.claim_id);
    assert.throws(() => {
      db.prepare(`
        INSERT INTO claims (hood_id, player_id, season_id, claim_kind, points_awarded,
                            status, flag_count, park_id, created_at)
        VALUES (?, ?, ?, 'park', 30, 'active', 0, 9002, ?)`)
        .run(row.hood_id, alice, row.season_id, nowIso());
    }, /UNIQUE|constraint/i, 'the partial unique index is the backstop');
  });
});

// ── the card ──────────────────────────────────────────────────────────────
describe('the card', () => {
  test('gets a seed that is stable for the same player, park and season', () => {
    const a = parks.cardSeed(7, 9001, 1);
    const b = parks.cardSeed(7, 9001, 1);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  test('gets a different seed per player, per park and per season', () => {
    const base = parks.cardSeed(7, 9001, 1);
    assert.notEqual(base, parks.cardSeed(8, 9001, 1), 'another player');
    assert.notEqual(base, parks.cardSeed(7, 9002, 1), 'another park');
    assert.notEqual(base, parks.cardSeed(7, 9001, 2), 'another season');
  });

  test('carries its seed, rarity, season and set position', () => {
    const { claim } = collect(9003, alice);
    assert.match(claim.card_seed, /^[0-9a-f]{16}$/);
    assert.equal(claim.rarity, 'rare');
    assert.equal(claim.rarity_label, 'Rare');
    assert.equal(claim.park.set_number, 3);
    assert.equal(claim.set_size, PARKS.length);
    assert.ok(claim.season?.name, 'the season names the palette');
  });

  test('rarity comes off the value at the documented thresholds', () => {
    assert.equal(parks.rarityOf(5).key, 'common');
    assert.equal(parks.rarityOf(24).key, 'common');
    assert.equal(parks.rarityOf(25).key, 'uncommon');
    assert.equal(parks.rarityOf(49).key, 'uncommon');
    assert.equal(parks.rarityOf(50).key, 'rare');
    assert.equal(parks.rarityOf(74).key, 'rare');
    assert.equal(parks.rarityOf(75).key, 'legendary');
    assert.equal(parks.rarityOf(100).key, 'legendary');
  });
});

// ── the Hood view ─────────────────────────────────────────────────────────
describe('a Hood\'s parks', () => {
  test('lists every park with whether it is in your binder', () => {
    collect(9001, alice);
    const list = parks.listParksInHood(13, alice);
    assert.equal(list.length, 2);
    const got = list.find((p) => p.id === 9001);
    assert.equal(got.collected, true);
    assert.ok(got.collection.card_seed);
    assert.equal(list.find((p) => p.id === 9002).collected, false);
  });

  test('is per-player: bob sees an empty binder in the same Hood', () => {
    collect(9001, alice);
    assert.equal(parks.listParksInHood(13, bob).every((p) => !p.collected), true);
  });

  test('progress hangs off the Hood itself, which is where the sheet reads it', async () => {
    // Regression: this lived on hood.viewer.parks for one release, and the
    // parks button — which reads hood.parks — silently never rendered.
    const { listHoods } = await import('../server/lib/views.js');
    collect(9003, alice);

    const hood = listHoods(alice).find((h) => h.id === 25);
    assert.ok(hood.parks, 'hood.parks must exist, not hood.viewer.parks');
    assert.equal(hood.parks.total, 2);
    assert.equal(hood.parks.collected, 1);
    assert.equal(hood.parks.points, 70);
    assert.equal(hood.viewer.parks, undefined, 'and not be duplicated onto viewer');

    // Every Hood carries a total, so the button never has a reason to hide.
    for (const h of listHoods(alice)) {
      assert.ok(Number.isInteger(h.parks?.total), `Hood ${h.id} has no park total`);
    }
  });

  test('reports progress for the Hood sheet', () => {
    collect(9003, alice);
    const progress = parks.parkProgress(25, alice);
    assert.equal(progress.total, 2);
    assert.equal(progress.collected, 1);
    assert.equal(progress.remaining, 1);
    assert.equal(progress.points, 70);
  });
});

// ── scoring ───────────────────────────────────────────────────────────────
describe('park points and the score', () => {
  test('add to the same total as territory', () => {
    collect(9004, alice);                 // +100
    collect(9001, alice);                 // +5
    assert.equal(points(alice), 105);

    const row = leaderboard(1).find((r) => r.player.id === alice);
    assert.equal(row.points, 105);
    assert.equal(row.parks, 2);
    assert.equal(row.park_points, 105);
    assert.equal(row.territory_points, 0);
  });

  test('are reported separately from territory, but summed into one figure', () => {
    const territory = commitClaim({
      hoodId: 13, playerId: alice, declaredType: 'landmark', photo: photo(),
    }).claim.points_awarded;
    collect(9004, alice);

    const row = leaderboard(1).find((r) => r.player.id === alice);
    assert.equal(row.territory_points, territory);
    assert.equal(row.park_points, 100);
    assert.equal(row.points, territory + 100);
  });

  test('a park collection can be flagged away like any other claim', () => {
    const { claim } = collect(9004, alice);
    assert.equal(points(alice), 100);

    revertClaim(claim.claim_id);
    assert.equal(points(alice), 0, 'the points are cancelled');

    // And the park frees up again, because the unique index excludes reverted rows.
    const { claim: again } = collect(9004, alice);
    assert.equal(again.points, 100);
  });

  test('reverting a park claim leaves the Hood alone', () => {
    commitClaim({ hoodId: 25, playerId: bob, declaredType: 'landmark', photo: photo() });
    const before = db.prepare('SELECT * FROM hood_state WHERE hood_id = 25').get();

    const { claim } = collect(9004, alice);
    revertClaim(claim.claim_id);

    const after = db.prepare('SELECT * FROM hood_state WHERE hood_id = 25').get();
    assert.equal(after.owner_id, before.owner_id, 'bob still holds Hood 25');
    assert.equal(after.active_claim_id, before.active_claim_id);
  });
});

// ── the binder ────────────────────────────────────────────────────────────
describe('the binder', () => {
  test('returns the cards newest first with a summary', () => {
    collect(9001, alice);
    collect(9004, alice);

    const cards = parks.cardsOf(alice);
    assert.equal(cards.length, 2);
    assert.equal(cards[0].park.id, 9004, 'newest first');

    const summary = parks.collectionSummary(alice);
    assert.equal(summary.season_collected, 2);
    assert.equal(summary.season_points, 105);
    assert.equal(summary.parks_total, PARKS.length);
    assert.equal(summary.distinct_parks_all_time, 2);
    assert.deepEqual(summary.by_rarity, { common: 1, legendary: 1 });
  });

  test('excludes reverted cards', () => {
    const { claim } = collect(9004, alice);
    revertClaim(claim.claim_id);
    assert.equal(parks.cardsOf(alice).length, 0);
    assert.equal(parks.collectionSummary(alice).season_collected, 0);
  });

  test('is empty for a player who has collected nothing', () => {
    const summary = parks.collectionSummary(bob);
    assert.equal(summary.season_collected, 0);
    assert.equal(summary.season_points, 0);
    assert.deepEqual(summary.by_rarity, {});
  });

  // Binders are public: nobody competes over parks, so a collection is something to
  // show off rather than protect, and one player's binder never leaks another's.
  test('a binder holds only its own player’s cards', () => {
    collect(9001, alice);
    collect(9002, alice);
    collect(9001, bob);

    assert.equal(parks.cardsOf(alice).length, 2);
    assert.equal(parks.cardsOf(bob).length, 1);
    assert.deepEqual(parks.cardsOf(bob).map((c) => c.park.id), [9001]);
    assert.equal(parks.collectionSummary(bob).season_collected, 1);
  });

  test('a card says whose it is, so a binder can be read by somebody else', () => {
    const { claim } = collect(9004, bob);
    const card = parks.getCardByClaim(claim.claim_id);
    assert.equal(card.player.id, bob);
    assert.ok(card.player.display_name, 'the feed needs a name to put on it');
    assert.ok(card.player.colour);
  });

  test('the same park collected by two players gives two different cards', () => {
    // The whole reason looking at somebody else's binder is interesting.
    const mine = collect(9002, alice).claim;
    const theirs = collect(9002, bob).claim;
    assert.notEqual(mine.card_seed, theirs.card_seed, 'the art is seeded per player');
    assert.equal(mine.points, theirs.points, 'but the park is worth the same to both');
  });
});

// ── the per-Hood points cap ───────────────────────────────────────────────
// Past a Hood's ceiling a collection still succeeds: card, edition, XP, and 0 points. To
// keep earning, go to a different Hood. Hood 25 holds 9003 (70) and 9004 (100) above.
describe('the per-Hood points cap', () => {
  let extra = 9100;
  const addPark = (hoodId, value) => {
    extra += 1;
    db.prepare(`INSERT INTO parks (id, name, hood_id, lat, lng, value, distance_km, set_number)
                VALUES (?, ?, ?, 43.7, -79.4, ?, 5, ?)`).run(extra, `Cap Park ${extra}`, hoodId, value, extra);
    return extra;
  };
  const withConfig = (patch, fn) => {
    const was = Object.fromEntries(Object.keys(patch).map((k) => [k, config[k]]));
    Object.assign(config, patch);
    try { return fn(); } finally { Object.assign(config, was); }
  };
  const gold = (n) => Math.round((editionRates().hologram / 100) * n);

  test('pays up to the ceiling, clamps the last award, then pays 0 — and still collects', () => {
    withConfig({ PARK_HOOD_CAP: 150 }, () => {
      assert.equal(collect(9004, alice).claim.points, 100);
      // 150 does not divide by 70: min() pays the 50 that is left rather than all or nothing.
      assert.equal(collect(9003, alice).claim.points, 50);

      const past = collect(addPark(25, 40), alice);
      assert.equal(past.claim.points, 0);
      const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(past.claim.claim_id);
      assert.equal(row.status, 'active', 'a success, not an error');
      assert.ok(row.xp_awarded > 0, 'with its XP');
      assert.ok(row.edition, 'and its edition');

      const next = parks.evaluateCollect({ parkId: addPark(25, 60), playerId: alice });
      assert.equal(next.ok, true);
      assert.equal(next.points, 0);
      assert.equal(next.capacity.xp_only, true, 'so the sheet can say XP only before the shutter');
      assert.equal(points(alice), 150, 'the ceiling is never overshot');
    });
  });

  test('a cap that does not divide the park’s value is neither overshot nor short-changed', () => {
    withConfig({ PARK_HOOD_CAP: 12 }, () => {
      const awards = [addPark(13, 5), addPark(13, 5), addPark(13, 5), addPark(13, 5)]
        .map((id) => collect(id, alice).claim.points);
      assert.deepEqual(awards, [5, 5, 2, 0]);
    });
  });

  test('a capped player collecting in a different Hood earns normally', () => {
    withConfig({ PARK_HOOD_CAP: 100 }, () => {
      collect(9004, alice);
      assert.equal(collect(9003, alice).claim.points, 0, 'Hood 25 is spent');
      assert.equal(collect(9002, alice).claim.points, 30, 'Hood 13 is not — that is the whole rule');
    });
  });

  test('the cap is per player', () => {
    withConfig({ PARK_HOOD_CAP: 100 }, () => {
      collect(9004, alice);
      assert.equal(collect(9004, bob).claim.points, 100);
    });
  });

  test('a reverted collection frees its capacity in that Hood', () => {
    withConfig({ PARK_HOOD_CAP: 100 }, () => {
      const { claim } = collect(9004, alice);
      revertClaim(claim.claim_id);
      assert.equal(parks.parkCapacity(alice, 25).remaining, 100);
      assert.equal(collect(9003, alice).claim.points, 70);
    });
  });

  test('two collections racing at the ceiling: the commit re-checks', () => {
    withConfig({ PARK_HOOD_CAP: 120 }, () => {
      collect(9004, alice);
      const a = addPark(25, 70);
      const b = addPark(25, 70);
      // Both preflights see 20 left...
      assert.equal(parks.evaluateCollect({ parkId: a, playerId: alice }).points, 20);
      assert.equal(parks.evaluateCollect({ parkId: b, playerId: alice }).points, 20);
      // ...and only one of them is paid it.
      assert.deepEqual([collect(a, alice).claim.points, collect(b, alice).claim.points], [20, 0]);
    });
  });

  test('past the cap: full XP, the edition rolled, zero points, and no item', () => {
    withConfig({ PARK_HOOD_CAP: 100 }, () => {
      collect(9004, alice);
      const past = parks.commitCollect({ parkId: 9003, playerId: alice, photo: photo(), rand: gold });
      assert.equal(past.claim.points, 0);
      assert.equal(past.claim.edition, 'gold');
      assert.ok(past.xp.edition_xp > 0);
      assert.deepEqual(past.items.items, []);
      assert.equal(past.items.reason, 'no_points');
      // Scoped to this claim: the collection before it rolled its own edition, and one
      // run in seven that is a Gold with a grant of its own.
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_grants WHERE claim_id = ?')
        .get(past.claim.claim_id).n, 0);
    });
  });

  test('by week: each claim stores its Toronto week, and last week does not count', () => {
    withConfig({ PARK_HOOD_CAP: 100, PARK_CAP_PERIOD: 'week' }, () => {
      const { claim } = collect(9004, alice);
      const row = db.prepare('SELECT week_key, created_at FROM claims WHERE id = ?').get(claim.claim_id);
      // weekKey is the function carcap.test.js pins across both DST transitions.
      assert.equal(row.week_key, weekKey(row.created_at));

      db.prepare("UPDATE claims SET week_key = '2000-W01' WHERE id = ?").run(claim.claim_id);
      assert.equal(collect(9003, alice).claim.points, 70, 'capacity came back with the new week');
    });
  });

  test('by season: the same sum grouped by season, so a new week does not reset it', () => {
    withConfig({ PARK_HOOD_CAP: 100, PARK_CAP_PERIOD: 'season' }, () => {
      const { claim } = collect(9004, alice);
      db.prepare("UPDATE claims SET week_key = '2000-W01' WHERE id = ?").run(claim.claim_id);
      assert.equal(parks.parkCapacity(alice, 25).remaining, 0, 'a new week hands nothing back');

      const other = db.prepare('SELECT id FROM seasons WHERE id != ? LIMIT 1').get(claim.season.id).id;
      db.prepare('UPDATE claims SET season_id = ? WHERE id = ?').run(other, claim.claim_id);
      assert.equal(parks.parkCapacity(alice, 25).remaining, 100, 'and it does not carry across seasons');
    });
  });

  test('the Hood sheet can show where you stand', () => {
    withConfig({ PARK_HOOD_CAP: 150 }, () => {
      collect(9004, alice);
      const { capacity } = parks.parkProgress(25, alice);
      assert.equal(capacity.cap, 150);
      assert.equal(capacity.spent, 100);
      assert.equal(capacity.remaining, 50);
      assert.ok(capacity.resets_at);
      assert.equal(parks.parkProgress(25, bob).capacity.spent, 0);
    });
  });
});
