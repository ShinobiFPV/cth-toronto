// The car cards' weekly points cap, and the calendar arithmetic underneath it.
//
// Time is simulated the way test/game.test.js winds hood_state clocks back: by writing
// week_key and timestamps directly. Nothing here waits.
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-carcap-'));
process.env.CTH_DB = path.join(tmp, 'test.sqlite');
process.env.CTH_JWT_SECRET = 'test-secret';

let db, nowIso, config, cars, vehicles, week, views, game, seasons, xp;

before(async () => {
  ({ db, nowIso } = await import('../server/db.js'));
  ({ config } = await import('../server/config.js'));
  cars = await import('../server/lib/cars.js');
  vehicles = await import('../server/lib/vehicles.js');
  week = await import('../server/lib/week.js');
  views = await import('../server/lib/views.js');
  game = await import('../server/lib/game.js');
  seasons = await import('../server/lib/seasons.js');
  xp = await import('../server/lib/xp.js');
});

let alice, bob;
let seq = 0;

const photo = () => {
  seq += 1;
  return {
    path_original: `original/w${seq}.jpg`,
    path_display: `display/w${seq}.webp`,
    path_thumb: `thumb/w${seq}.webp`,
    width: 1600, height: 1200, bytes: 2048, exif_json: null,
  };
};

const makePlayer = (handle) => Number(db.prepare(`
  INSERT INTO players (handle, display_name, password_hash, colour, is_admin, created_at)
  VALUES (?, ?, 'x', '#fff', 0, ?)`).run(handle, handle, nowIso()).lastInsertRowid);

// Every car in these tests is a different model of the same make, so the dedupe rule
// never gets in the way of the arithmetic.
let carNo = 0;
const nextCar = () => vehicles.resolveIdentification({
  is_vehicle: true, in_situ: true, make: 'Testmake', model: `Model${++carNo}`,
  generation: null, trim: null, year_range: null, body_style: null, confidence: 0.9, plates: [],
});

// The last draw of the roll is always Steel, whatever the rate table says.
const never = (n) => n - 1;
const snap = (playerId, identification = nextCar()) =>
  cars.commitCar({ identification, playerId, hoodId: 13, photo: photo(), rand: never });

const withConfig = (patch, fn) => {
  const was = Object.fromEntries(Object.keys(patch).map((k) => [k, config[k]]));
  Object.assign(config, patch);
  try { return fn(); } finally { Object.assign(config, was); }
};

const seasonPoints = (seasonId, playerId) =>
  views.leaderboard(seasonId).find((r) => r.player.id === playerId).points;

beforeEach(() => {
  db.exec('DELETE FROM trades; DELETE FROM card_holdings');
  // Item grants join to claims by id, and ids are reused once the table is emptied.
  db.exec('DELETE FROM item_uses; DELETE FROM item_armed; DELETE FROM item_grants');
  db.exec('DELETE FROM flags; DELETE FROM claims; DELETE FROM photos; DELETE FROM messages');
  db.exec('DELETE FROM vehicles; DELETE FROM players');
  seq += 1;
  alice = makePlayer(`alice${seq}`);
  bob = makePlayer(`bob${seq}`);
});

// ── the cap ───────────────────────────────────────────────────────────────
describe('the weekly cap', () => {
  test('a full week of scoring cars reaches the cap; the next is worth 0 and full XP', () => {
    const scoring = Math.ceil(config.CAR_WEEKLY_CAP / config.CAR_POINTS);
    const awards = Array.from({ length: scoring }, () => snap(alice).points);
    assert.equal(awards.reduce((a, b) => a + b, 0), config.CAR_WEEKLY_CAP);

    const past = snap(alice);
    assert.equal(past.points, 0, 'worth nothing past the cap');
    assert.equal(past.xp.xp, config.CAR_XP_STEEL, 'and every bit of the XP');
    assert.equal(past.card.status, 'active', 'it is a collection, not a failure');
    assert.equal(past.capacity.xp_only, true);
    assert.equal(past.capacity.remaining, 0);
  });

  test('at the defaults that is 20 cars and 100 points', () => {
    // The spec's own numbers, pinned only while they are still the defaults.
    if (config.CAR_POINTS !== 5 || config.CAR_WEEKLY_CAP !== 100) return;
    for (let i = 0; i < 20; i += 1) assert.equal(snap(alice).points, 5);
    assert.equal(snap(alice).points, 0);
  });

  test('the last award is clamped when the cap does not divide evenly', () => {
    withConfig({ CAR_POINTS: 5, CAR_WEEKLY_CAP: 12 }, () => {
      assert.deepEqual([snap(alice), snap(alice), snap(alice), snap(alice)].map((r) => r.points),
        [5, 5, 2, 0], 'the cap is never overshot and the remainder is not dropped');
    });
    withConfig({ CAR_POINTS: 7, CAR_WEEKLY_CAP: 20 }, () => {
      assert.deepEqual([snap(bob), snap(bob), snap(bob), snap(bob)].map((r) => r.points),
        [7, 7, 6, 0]);
    });
  });

  test('the cap is per player', () => {
    withConfig({ CAR_WEEKLY_CAP: config.CAR_POINTS }, () => {
      snap(alice);
      assert.equal(snap(alice).points, 0);
      assert.equal(snap(bob).points, config.CAR_POINTS, 'alice\'s week is not bob\'s');
    });
  });

  test('capacity is known before the shutter', () => {
    withConfig({ CAR_WEEKLY_CAP: config.CAR_POINTS * 2 }, () => {
      assert.equal(cars.capacityFor(alice).next_award, config.CAR_POINTS);
      snap(alice);
      snap(alice);
      const cap = cars.capacityFor(alice);
      assert.equal(cap.spent, config.CAR_POINTS * 2);
      assert.equal(cap.xp_only, true);
      assert.equal(cap.resets_on, week.weekStartName());
      assert.ok(cap.resets_at > nowIso(), 'and when it comes back');
    });
  });

  test('a reverted claim frees its slot in the same week', () => {
    withConfig({ CAR_WEEKLY_CAP: config.CAR_POINTS * 2 }, () => {
      const first = snap(alice);
      snap(alice);
      assert.equal(snap(alice).points, 0);

      game.revertClaim(first.card.claim_id);
      assert.equal(cars.capacityFor(alice).remaining, config.CAR_POINTS);
      assert.equal(snap(alice).points, config.CAR_POINTS);
    });
  });

  test('two collections racing at the last slot cannot both be awarded it', () => {
    withConfig({ CAR_WEEKLY_CAP: config.CAR_POINTS * 3 }, () => {
      snap(alice);
      snap(alice);

      // Both preflights say "5 points"...
      const a = nextCar();
      const b = nextCar();
      assert.equal(cars.evaluateCar({ identification: a, playerId: alice }).points, config.CAR_POINTS);
      assert.equal(cars.evaluateCar({ identification: b, playerId: alice }).points, config.CAR_POINTS);

      // ...and the transactions decide.
      assert.deepEqual([snap(alice, a).points, snap(alice, b).points], [config.CAR_POINTS, 0]);
      assert.equal(cars.pointsInWeek(alice, cars.capacityFor(alice).week_key), config.CAR_WEEKLY_CAP);
    });
  });

  test('capacity comes back in a new week', () => {
    withConfig({ CAR_WEEKLY_CAP: config.CAR_POINTS }, () => {
      snap(alice);
      assert.equal(cars.capacityFor(alice).xp_only, true);
      // Wind that claim back into a week that has already passed.
      db.prepare("UPDATE claims SET week_key = '2020-W01' WHERE player_id = ?").run(alice);
      assert.equal(cars.capacityFor(alice).spent, 0);
      assert.equal(snap(alice).points, config.CAR_POINTS);
    });
  });

  test('a week straddling a season rollover scores each claim in its own season', () => {
    const now = seasons.activeSeason();
    const other = db.prepare('SELECT id FROM seasons WHERE id != ? ORDER BY id LIMIT 1').get(now.id).id;

    withConfig({ CAR_WEEKLY_CAP: config.CAR_POINTS * 2 }, () => {
      // Last season's car, same week.
      const earlier = snap(alice);
      db.prepare('UPDATE claims SET season_id = ? WHERE id = ?').run(other, earlier.card.claim_id);

      const later = snap(alice);
      assert.equal(later.points, config.CAR_POINTS,
        'the cap counts the week, whichever season its claims landed in');
      assert.equal(snap(alice).points, 0, 'and that week is now full');

      assert.equal(seasonPoints(other, alice), config.CAR_POINTS, 'one car scored in the old season');
      assert.equal(seasonPoints(now.id, alice), config.CAR_POINTS, 'one in the new');
      assert.equal(seasonPoints(null, alice), config.CAR_POINTS * 2, 'and both in the Champion total');
    });
  });

  test('XP is never capped', () => {
    withConfig({ CAR_WEEKLY_CAP: 0 }, () => {
      for (let i = 0; i < 5; i += 1) snap(alice);
      assert.equal(xp.xpOf(alice), config.CAR_XP_STEEL * 5);
    });
  });
});

// ── week keys ─────────────────────────────────────────────────────────────
describe('week keys, in Toronto', () => {
  const tz = 'America/Toronto';
  const key = (iso, start = 'MO') => week.weekKey(iso, { tz, start });

  test('the week turns over at Monday 00:00 local, not UTC', () => {
    // Sunday 23:59:59 EDT and Monday 00:00 EDT, 13-14 September 2026.
    assert.equal(key('2026-09-14T03:59:59.000Z'), '2026-W37');
    assert.equal(key('2026-09-14T04:00:00.000Z'), '2026-W38');
  });

  test('across the March transition (DST begins Sunday 8 March 2026)', () => {
    // 01:30 EST and 03:30 EDT on the transition Sunday are the same week...
    assert.equal(key('2026-03-08T06:30:00.000Z'), '2026-W10');
    assert.equal(key('2026-03-08T07:30:00.000Z'), '2026-W10');
    // ...and Monday midnight is now at UTC-4. A fixed -5 offset would say 23:00 Sunday.
    assert.equal(key('2026-03-09T03:59:59.000Z'), '2026-W10');
    assert.equal(key('2026-03-09T04:00:00.000Z'), '2026-W11');
    assert.equal(week.weekResetsAt('2026-03-05T12:00:00.000Z', { tz }), '2026-03-09T04:00:00.000Z');
  });

  test('across the November transition (DST ends Sunday 1 November 2026)', () => {
    // 01:30 happens twice that night, once in each offset; both are Sunday.
    assert.equal(key('2026-11-01T05:30:00.000Z'), '2026-W44');
    assert.equal(key('2026-11-01T06:30:00.000Z'), '2026-W44');
    // Monday midnight is back at UTC-5. A fixed -4 offset would call 04:30Z Monday.
    assert.equal(key('2026-11-02T04:30:00.000Z'), '2026-W44');
    assert.equal(key('2026-11-02T04:59:59.000Z'), '2026-W44');
    assert.equal(key('2026-11-02T05:00:00.000Z'), '2026-W45');
    assert.equal(week.weekResetsAt('2026-10-28T12:00:00.000Z', { tz }), '2026-11-02T05:00:00.000Z');
  });

  test('ISO numbering holds at the year boundary', () => {
    // 1 January 2027 is a Friday, so it belongs to the 53rd week of 2026.
    assert.equal(key('2027-01-01T17:00:00.000Z'), '2026-W53');
    assert.equal(key('2027-01-04T05:00:00.000Z'), '2027-W01');
    // And New Year's Eve evening in Toronto is already the next UTC day.
    assert.equal(key('2027-01-01T03:00:00.000Z'), '2026-W53');
  });

  test('another start day keeps seven-day weeks', () => {
    // Sunday 13 September 2026, 12:00 EDT.
    assert.equal(key('2026-09-13T16:00:00.000Z', 'SU'), '2026-W38', 'a Sunday opens the week');
    assert.equal(key('2026-09-12T16:00:00.000Z', 'SU'), '2026-W37', 'the Saturday before closes the last');
    assert.equal(week.weekResetsAt('2026-09-13T16:00:00.000Z', { tz, start: 'SU' }), '2026-09-20T04:00:00.000Z');
    assert.equal(week.weekStartName('SU'), 'Sunday');
  });

  test('a claim stores the week it landed in', () => {
    const { card: pack } = snap(alice);
    const row = db.prepare('SELECT week_key, created_at FROM claims WHERE id = ?').get(pack.claim_id);
    assert.equal(row.week_key, week.weekKey(row.created_at));
  });
});
