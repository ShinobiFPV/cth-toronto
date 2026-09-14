// XP and levels: the curve, the schedule, and the promise that none of it ever resets.
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-xp-'));
process.env.CTH_DB = path.join(tmp, 'test.sqlite');
process.env.CTH_JWT_SECRET = 'test-secret';

let db, nowIso, xp, commitClaim, revertClaim, parks, leaderboard, playerSummary;

before(async () => {
  ({ db, nowIso } = await import('../server/db.js'));
  xp = await import('../server/lib/xp.js');
  ({ commitClaim, revertClaim } = await import('../server/lib/game.js'));
  parks = await import('../server/lib/parks.js');
  ({ leaderboard, playerSummary } = await import('../server/lib/views.js'));
});

const PARKS = [
  { id: 8001, name: 'Cheap Parkette', hood_id: 13, lat: 43.65, lng: -79.38, value: 5, distance_km: 0.2, set_number: 1 },
  { id: 8002, name: 'Far Legendary Park', hood_id: 25, lat: 43.81, lng: -79.15, value: 100, distance_km: 26, set_number: 2 },
];

let alice, bob;
let seq = 0;
const photo = () => {
  seq += 1;
  return { path_original: `o/${seq}`, path_display: `d/${seq}`, path_thumb: `t/${seq}` };
};
const claim = (hoodId, playerId, type) =>
  commitClaim({ hoodId, playerId, declaredType: type, photo: photo() });
// Always Steel. A park card rolls its edition, and at one in seven a random Gold would add
// its XP to whichever side of a comparison it landed on.
const collect = (parkId, playerId) =>
  parks.commitCollect({ parkId, playerId, photo: photo(), rand: (n) => n - 1 });

const rewind = (hoodId, hours) => {
  const shift = (iso) => (iso ? new Date(Date.parse(iso) - hours * 3600_000).toISOString() : iso);
  const s = db.prepare('SELECT * FROM hood_state WHERE hood_id = ?').get(hoodId);
  db.prepare('UPDATE hood_state SET last_claim_at = ?, locked_until = ? WHERE hood_id = ?')
    .run(shift(s.last_claim_at), shift(s.locked_until), hoodId);
};
const ageConquers = (playerId) => db.prepare(`
  UPDATE claims SET created_at = ? WHERE claim_kind = 'conquer' AND player_id = ?`)
  .run(new Date(Date.now() - 48 * 3600_000).toISOString(), playerId);

const makePlayer = (handle) => Number(db.prepare(`
  INSERT INTO players (handle, display_name, password_hash, colour, is_admin, created_at)
  VALUES (?, ?, 'x', '#fff', 0, ?)`).run(handle, handle, nowIso()).lastInsertRowid);

beforeEach(() => {
  db.exec(`UPDATE hood_state SET owner_id = NULL, active_claim_id = NULL, photo_type = NULL,
           last_claim_at = NULL, locked_until = NULL`);
  // Item grants join to claims by id, and ids are reused once the table is emptied.
  db.exec('DELETE FROM item_uses; DELETE FROM item_armed; DELETE FROM item_grants');
  db.exec('DELETE FROM flags; DELETE FROM claims; DELETE FROM photos; DELETE FROM messages');
  db.exec('DELETE FROM parks; DELETE FROM players');
  db.exec('UPDATE hoods SET ever_conquered = 0, escalations = 0, unclaimed_value = difficulty');
  parks.forgetSetSize();
  const ins = db.prepare(`
    INSERT INTO parks (id, name, hood_id, lat, lng, value, distance_km, set_number)
    VALUES (@id, @name, @hood_id, @lat, @lng, @value, @distance_km, @set_number)`);
  for (const p of PARKS) ins.run(p);
  alice = makePlayer(`alice${++seq}`);
  bob = makePlayer(`bob${seq}`);
});

// ── the curve ─────────────────────────────────────────────────────────────
describe('the level curve', () => {
  test('starts everyone at level 1 with no XP', () => {
    assert.equal(xp.levelOf(0), 1);
    assert.equal(xp.xpForLevel(1), 0);
    assert.equal(xp.progressOf(0).title, 'Tourist');
  });

  test('inverts exactly, for 200 levels', () => {
    for (let level = 1; level <= 200; level++) {
      const need = xp.xpForLevel(level);
      assert.equal(xp.levelOf(need), level, `xpForLevel(${level}) should read back as ${level}`);
      if (level > 1) {
        assert.equal(xp.levelOf(need - 1), level - 1, `one XP short of ${level} is ${level - 1}`);
      }
    }
  });

  test('never caps out', () => {
    assert.ok(xp.levelOf(1_000_000) > 200, 'a million XP keeps going');
    assert.ok(xp.xpForLevel(500) > xp.xpForLevel(499), 'the curve is still rising at 500');
  });

  test('gives the first level-up away for one conquer, then slows down', () => {
    assert.equal(xp.xpForLevel(2), 40, 'one conquer is 50, so level 2 lands immediately');
    assert.ok(xp.xpForLevel(11) - xp.xpForLevel(10) > xp.xpForLevel(3) - xp.xpForLevel(2),
      'later levels cost more than earlier ones');
  });

  test('hands out a title per band', () => {
    assert.equal(xp.titleOf(1), 'Tourist');
    assert.equal(xp.titleOf(4), 'Tourist');
    assert.equal(xp.titleOf(5), 'Local');
    assert.equal(xp.titleOf(10), 'Regular');
    assert.equal(xp.titleOf(20), 'Institution');
    assert.equal(xp.titleOf(999), 'Mythic');
  });

  test('reports progress the UI can draw a bar from', () => {
    const p = xp.progressOf(xp.xpForLevel(10) + 100);
    assert.equal(p.level, 10);
    assert.equal(p.into_level, 100);
    assert.equal(p.level_span, xp.xpForLevel(11) - xp.xpForLevel(10));
    assert.equal(p.into_level + p.to_next, p.level_span);
    assert.ok(p.fraction > 0 && p.fraction < 1);
  });

  test('survives rubbish input instead of producing NaN', () => {
    for (const bad of [null, undefined, -50, NaN, 'nonsense']) {
      const p = xp.progressOf(bad);
      assert.equal(p.level, 1);
      assert.ok(Number.isFinite(p.fraction));
    }
  });
});

// ── earning it ────────────────────────────────────────────────────────────
describe('earning XP', () => {
  test('pays per action, with stealing worth most', () => {
    assert.ok(xp.ACTION_XP.steal > xp.ACTION_XP.conquer);
    assert.ok(xp.ACTION_XP.conquer > xp.ACTION_XP.reinforce);
  });

  test('freezes the amount onto the claim row', () => {
    const { claim: c } = claim(13, alice, 'landmark');
    const row = db.prepare('SELECT xp_awarded FROM claims WHERE id = ?').get(c.id);
    assert.equal(row.xp_awarded, xp.ACTION_XP.conquer + xp.DISCOVERY_XP.hood);
  });

  test('pays a discovery bonus the first time you claim a given Hood, once', () => {
    const first = claim(13, alice, 'landmark');
    assert.equal(first.xp.discovery, xp.DISCOVERY_XP.hood);
    assert.equal(first.xp.discovered, 'hood');

    rewind(13, 80);
    const second = claim(13, alice, 'person');   // reinforce, same Hood
    assert.equal(second.xp.discovery, 0, 'the second visit is not a discovery');
    assert.equal(second.xp.xp, xp.ACTION_XP.reinforce);
  });

  test('discovery is per player — bob still gets his own first time', () => {
    claim(13, alice, 'landmark');
    rewind(13, 24);
    const bobs = claim(13, bob, 'person');
    assert.equal(bobs.xp.discovery, xp.DISCOVERY_XP.hood);
  });

  test('pays more for a rarer park card', () => {
    const cheap = collect(8001, alice);
    const dear = collect(8002, alice);
    assert.equal(cheap.xp.bonus, xp.RARITY_XP.common);
    assert.equal(dear.xp.bonus, xp.RARITY_XP.legendary);
    assert.ok(dear.xp.xp > cheap.xp.xp);
  });

  test('pays a smaller discovery bonus for a park never collected before', () => {
    const first = collect(8002, alice);
    assert.equal(first.xp.discovery, xp.DISCOVERY_XP.park);
    assert.equal(first.xp.discovered, 'park');
  });

  test('rewards activity over value, which is the whole point', () => {
    // Hood 11 is worth 5 points; Hood 25 is worth 50. Both are one conquer of XP.
    const cheap = claim(11, alice, 'landmark');
    const dear = claim(25, bob, 'landmark');
    assert.ok(dear.claim.points_awarded > cheap.claim.points_awarded * 5, 'points differ wildly');
    assert.equal(dear.xp.xp, cheap.xp.xp, 'XP does not');
  });
});

// ── forever ───────────────────────────────────────────────────────────────
describe('XP is forever', () => {
  test('is not scoped to a season', () => {
    claim(13, alice, 'landmark');
    const before = xp.xpOf(alice);

    // Shove that claim into a past season, as a rollover effectively would.
    db.prepare('UPDATE claims SET season_id = 1 WHERE player_id = ?').run(alice);
    assert.equal(xp.xpOf(alice), before, 'still counted');

    // And a season nobody is playing yet.
    db.prepare('UPDATE claims SET season_id = 4 WHERE player_id = ?').run(alice);
    assert.equal(xp.xpOf(alice), before, 'still counted');
  });

  test('reads the same on the season table and the champion table', () => {
    claim(13, alice, 'landmark');
    const season = leaderboard(1).find((r) => r.player.id === alice);
    const champion = leaderboard(null).find((r) => r.player.id === alice);
    assert.equal(season.xp, champion.xp);
    assert.equal(season.level, champion.level);
    assert.ok(season.xp > 0);
  });

  test('survives a Hood being taken off you', () => {
    claim(13, alice, 'landmark');
    const earned = xp.xpOf(alice);
    rewind(13, 24);
    claim(13, bob, 'person');
    assert.equal(xp.xpOf(alice), earned, 'losing territory does not lose XP');
  });

  test('is cancelled by a reversal, like points', () => {
    const { claim: c } = claim(13, alice, 'landmark');
    assert.ok(xp.xpOf(alice) > 0);
    revertClaim(c.id);
    assert.equal(xp.xpOf(alice), 0, 'a claim the group threw out earns nothing');
  });

  test('and the discovery bonus comes back after a reversal', () => {
    const { claim: c } = claim(13, alice, 'landmark');
    revertClaim(c.id);
    // The reverted claim no longer counts as having been there.
    const again = claim(13, alice, 'animal');
    assert.equal(again.xp.discovery, xp.DISCOVERY_XP.hood);
  });
});

// ── levelling up ──────────────────────────────────────────────────────────
describe('levelling up', () => {
  test('reports a level-up exactly when the level changes', () => {
    const first = xp.withLevelUp(alice, () => claim(13, alice, 'landmark'));
    assert.ok(first.levelUp, 'one conquer with a discovery bonus clears level 2');
    assert.equal(first.levelUp.from, 1);
    assert.ok(first.levelUp.to >= 2);
    assert.equal(first.levelUp.title, xp.titleOf(first.levelUp.to));

    rewind(13, 80);
    const second = xp.withLevelUp(alice, () => claim(13, alice, 'person'));
    assert.equal(second.levelUp, null, 'a 20 XP reinforce does not level you again');
    assert.equal(second.progress.level, first.levelUp.to);
  });

  test('can jump more than one level at once', () => {
    // Park alice one XP short of level 2, where the level spans are still narrow
    // enough that a single 150 XP discovery conquer clears two of them.
    db.prepare(`
      INSERT INTO claims (hood_id, player_id, season_id, claim_kind, points_awarded,
                          xp_awarded, status, flag_count, created_at)
      VALUES (13, ?, 1, 'conquer', 0, ?, 'active', 0, ?)`)
      .run(alice, xp.xpForLevel(2) - 1, nowIso());
    assert.equal(xp.levelOf(xp.xpOf(alice)), 1, 'starting at level 1');

    const jump = xp.withLevelUp(alice, () => claim(25, alice, 'landmark'));
    assert.equal(jump.levelUp.from, 1);
    assert.ok(jump.levelUp.to >= 3,
      `expected to clear two thresholds, landed on ${jump.levelUp.to}`);
  });

  test('the player summary carries the level for the header badge', () => {
    claim(13, alice, 'landmark');
    const summary = playerSummary(alice);
    assert.ok(summary.xp, 'playerSummary exposes xp');
    assert.equal(summary.xp.level, xp.levelOf(xp.xpOf(alice)));
    assert.equal(summary.xp.title, xp.titleOf(summary.xp.level));
    assert.ok(summary.xp.to_next > 0);
  });

  test('a level is lifetime, so it outlives the seasonal score', () => {
    claim(13, alice, 'landmark');
    ageConquers(alice);
    claim(25, alice, 'landmark');
    const level = xp.levelOf(xp.xpOf(alice));

    // A rollover: season points go to zero because the queries are scoped, XP does not.
    db.prepare("UPDATE claims SET season_id = 1 WHERE player_id = ?").run(alice);
    assert.equal(leaderboard(2).find((r) => r.player.id === alice).points, 0);
    assert.equal(leaderboard(2).find((r) => r.player.id === alice).level, level);
  });
});
