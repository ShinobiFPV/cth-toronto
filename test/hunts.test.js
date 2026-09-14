// Scavenger Blitz: how a hunt is drawn, what it may ask for, what counts as finding it, and
// what finishing one pays — including the two rules most likely to break in the first week:
// a street slot ticks even when the car refuses to mint, and hunt rewards land in the
// season a hunt is completed in.
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-hunts-'));
process.env.CTH_DB = path.join(tmp, 'test.sqlite');
process.env.CTH_JWT_SECRET = 'test-secret';

let db, nowIso, isoPlusHours, config, hunts, gen, pool, cars, vehicles, items, views, seasons;

before(async () => {
  ({ db, nowIso, isoPlusHours } = await import('../server/db.js'));
  ({ config } = await import('../server/config.js'));
  hunts = await import('../server/lib/hunts.js');
  gen = await import('../server/lib/hunt-generate.js');
  pool = await import('../server/lib/hunt-pool.js');
  cars = await import('../server/lib/cars.js');
  vehicles = await import('../server/lib/vehicles.js');
  items = await import('../server/lib/items.js');
  views = await import('../server/lib/views.js');
  seasons = await import('../server/lib/seasons.js');
});

let alice;
let seq = 0;

const photo = () => {
  seq += 1;
  return { path_original: `o/h${seq}.jpg`, path_display: `d/h${seq}.webp`, path_thumb: `t/h${seq}.webp`,
    width: 10, height: 10, bytes: 10, exif_json: null };
};

const withConfig = (patch, fn) => {
  const was = Object.fromEntries(Object.keys(patch).map((k) => [k, config[k]]));
  Object.assign(config, patch);
  try { return fn(); } finally { Object.assign(config, was); }
};

const code = (fn) => { try { fn(); } catch (err) { return err.code; } return null; };
const steel = (n) => n - 1;

const PARK = 9901;
const addPark = (id, amenities = []) => {
  db.prepare(`INSERT INTO parks (id, name, hood_id, lat, lng, value, distance_km, set_number)
              VALUES (?, ?, 13, 43.65, -79.38, 20, 1, ?)`).run(id, `Hunt Park ${id}`, id);
  for (const a of amenities) db.prepare('INSERT INTO park_amenities (park_id, amenity) VALUES (?, ?)').run(id, a);
};

// A small street list, so a test knows exactly which targets a hunt can draw.
const POOL = [
  { key: 'honda|civic|2016-2021', make: 'Honda', model: 'Civic', years: [2016, 2021], tier: 'common', body_style: 'sedan' },
  { key: 'toyota|corolla|2020-2025', make: 'Toyota', model: 'Corolla', years: [2020, 2025], tier: 'common', body_style: 'sedan' },
  { key: 'toyota|rav4|2019-2025', make: 'Toyota', model: 'RAV4', years: [2019, 2025], tier: 'common', body_style: 'suv' },
  { key: 'subaru|wrx|2015-2021', make: 'Subaru', model: 'WRX', years: [2015, 2021], tier: 'uncommon', body_style: 'sedan' },
  { key: 'mazda|mx5|2016-2025', make: 'Mazda', model: 'MX-5', years: [2016, 2025], tier: 'uncommon', body_style: 'convertible' },
];

const identify = (make, model, extra = {}) => vehicles.resolveIdentification({
  is_vehicle: true, in_situ: true, make, model, generation: null, trim: null,
  year_range: '2016-2021', body_style: 'sedan', confidence: 0.9, plates: [], ...extra,
});

const startPark = (playerId = alice, seed = `p${seq += 1}`) =>
  hunts.startHunt({ playerId, kind: 'park', parkId: PARK, seed });
const startStreet = (playerId = alice) =>
  hunts.startHunt({ playerId, kind: 'street', vehicles: POOL, seed: `s${seq += 1}` });
const slotFor = (hunt, key) => hunt.items.find((i) => i.target_key === key).slot;

/** Find every item of a park hunt; returns the completion. */
const finishPark = (hunt, playerId = alice) => {
  let last = null;
  for (const item of hunt.items) {
    last = hunts.submitParkPhoto({ playerId, huntId: hunt.id, slot: item.slot, photo: photo(), found: true });
  }
  return last.completion;
};

beforeEach(() => {
  db.exec('DELETE FROM item_uses; DELETE FROM item_armed; DELETE FROM item_grants');
  db.exec('DELETE FROM hunts; DELETE FROM hunt_items; DELETE FROM park_amenities');
  db.exec('DELETE FROM trades; DELETE FROM card_holdings');
  db.exec('DELETE FROM flags; DELETE FROM claims; DELETE FROM photos; DELETE FROM messages');
  db.exec('DELETE FROM vehicles; DELETE FROM parks; DELETE FROM players');
  addPark(PARK, ['playground', 'tennis_court', 'picnic_site']);
  seq += 1;
  alice = Number(db.prepare(`INSERT INTO players (handle, display_name, password_hash, colour, is_admin, created_at)
                             VALUES (?, 'Alice', 'x', '#fff', 0, ?)`).run(`alice${seq}`, nowIso()).lastInsertRowid);
});

// ── drawing a park hunt ───────────────────────────────────────────────────
describe('a park hunt', () => {
  const amenities = ['playground', 'tennis_court', 'picnic_site'];

  test('is the same five items for the same seed, and different for another', () => {
    const a = gen.generateParkHunt({ seed: 'abc', amenities, season: 'summer' });
    const b = gen.generateParkHunt({ seed: 'abc', amenities: [...amenities].reverse(), season: 'summer' });
    assert.deepEqual(a, b, 'the order the amenities arrive in cannot change the draw');
    const others = ['x1', 'x2', 'x3', 'x4'].map((seed) => JSON.stringify(gen.generateParkHunt({ seed, amenities, season: 'summer' })));
    assert.ok(others.some((o) => o !== JSON.stringify(a)));
  });

  test('draws at least two amenities the park actually has, and none it does not', () => {
    for (let i = 0; i < 200; i += 1) {
      const hunt = gen.generateParkHunt({ seed: `a${i}`, amenities, season: 'summer' });
      const specific = hunt.filter((it) => it.target_type === 'amenity');
      assert.ok(specific.length >= 2, `seed a${i} drew ${specific.length} park amenities`);
      for (const it of specific) assert.ok(amenities.includes(it.target_key), `${it.target_key} is not in this park`);
      assert.equal(hunt.length, 5);
      assert.equal(new Set(hunt.map((it) => it.target_key)).size, 5, 'five different things');
      assert.deepEqual(hunt.map((it) => it.slot), [0, 1, 2, 3, 4]);
    }
  });

  test('a park with no amenity record still gets a full hunt', () => {
    const hunt = gen.generateParkHunt({ seed: 'bare', amenities: [], season: 'fall' });
    assert.equal(hunt.length, 5);
    assert.ok(hunt.every((it) => it.target_type !== 'amenity'));
    const one = gen.generateParkHunt({ seed: 'one', amenities: ['playground'], season: 'fall' });
    assert.equal(one.filter((it) => it.target_type === 'amenity').length, 1, 'fewer than two on record: fill from universal');
    assert.equal(one.length, 5);
  });

  test('never asks for more than two animals', () => {
    for (const season of pool.HUNT_SEASONS) {
      for (let i = 0; i < 200; i += 1) {
        const hunt = gen.generateParkHunt({ seed: `w${season}${i}`, amenities: [], season });
        assert.ok(hunt.filter((it) => it.target_type === 'wildlife').length <= pool.MAX_WILDLIFE);
      }
    }
  });

  test('is filtered to the season: no splash pad in winter, no rink in summer', () => {
    const seasonal = ['splash_pad', 'ice_rink', 'wading_pool', 'playground', 'beach'];
    for (let i = 0; i < 200; i += 1) {
      const winter = gen.generateParkHunt({ seed: `s${i}`, amenities: seasonal, season: 'winter' }).map((it) => it.target_key);
      const summer = gen.generateParkHunt({ seed: `s${i}`, amenities: seasonal, season: 'summer' }).map((it) => it.target_key);
      assert.ok(!winter.includes('splash_pad') && !winter.includes('wading_pool'), `winter ${winter}`);
      assert.ok(!winter.includes('flower') && !winter.includes('bug'));
      assert.ok(!summer.includes('ice_rink') && !summer.includes('snow'), `summer ${summer}`);
    }
  });

  test('uses the game season, or the calendar between seasons', () => {
    assert.equal(gen.seasonKeyFor(nowIso(), { name: 'Winter 2026–27' }), 'winter');
    assert.equal(gen.seasonKeyFor('2027-07-10T16:00:00Z', null), 'summer');
    assert.equal(gen.seasonKeyFor('2027-12-01T16:00:00Z', null), 'winter');
  });

  test('is frozen when it starts: labels live on the rows', () => {
    const hunt = startPark();
    const row = db.prepare('SELECT label FROM hunt_items WHERE hunt_id = ? AND slot = 0').get(hunt.id);
    assert.equal(row.label, hunt.items[0].label);
    assert.equal(hunt.park.id, PARK);
    assert.ok(hunt.items.filter((it) => it.target_type === 'amenity').length >= 2);
  });
});

// ── drawing a street hunt ─────────────────────────────────────────────────
describe('a street hunt', () => {
  test('the shipped list is passenger vehicles only, every one with a year window', () => {
    const list = hunts.loadHuntVehicles();
    assert.ok(list.version, 'the list is versioned');
    const keys = new Set();
    for (const v of list.vehicles) {
      assert.ok(gen.validHuntVehicle(v), `${v.key} is not a valid target`);
      assert.ok(pool.PASSENGER_BODY_STYLES.includes(v.body_style), `${v.key}: ${v.body_style}`);
      assert.ok(v.years[1] > v.years[0], `${v.key}: a single model year cannot be seen`);
      assert.ok(!keys.has(v.key), `${v.key} is listed twice`);
      keys.add(v.key);
    }
    assert.ok(list.vehicles.filter((v) => v.tier === 'common').length >= 3);
    assert.ok(list.vehicles.filter((v) => v.tier === 'uncommon').length >= 2);
  });

  test('is always three common and two uncommon, from passenger vehicles', () => {
    const { vehicles: list } = hunts.loadHuntVehicles();
    for (let i = 0; i < 200; i += 1) {
      const hunt = gen.generateStreetHunt({ seed: `v${i}`, vehicles: list });
      const tiers = hunt.map((it) => it.target.tier).sort();
      assert.deepEqual(tiers, ['common', 'common', 'common', 'uncommon', 'uncommon']);
      assert.equal(new Set(hunt.map((it) => it.target_key)).size, 5);
      for (const it of hunt) {
        assert.match(it.label, /\d{4}–\d{4}$/, 'every target carries its year window');
        assert.ok(pool.PASSENGER_BODY_STYLES.includes(it.target.body_style));
      }
    }
  });

  test('ignores anything in the list that is not a passenger vehicle', () => {
    const polluted = [...POOL,
      { key: 'ttc|streetcar|2019-2025', make: 'TTC', model: 'Flexity', years: [2019, 2025], tier: 'uncommon', body_style: 'streetcar' },
      { key: 'honda|grom|2017-2025', make: 'Honda', model: 'Grom', years: [2017, 2025], tier: 'common', body_style: 'motorcycle' }];
    for (let i = 0; i < 50; i += 1) {
      const keys = gen.generateStreetHunt({ seed: `x${i}`, vehicles: polluted }).map((it) => it.target_key);
      assert.ok(!keys.includes('ttc|streetcar|2019-2025') && !keys.includes('honda|grom|2017-2025'));
    }
  });

  test('a target matches generously: the make, the model anywhere, an overlapping window', () => {
    const civic = { make: 'Honda', model: 'Civic', years: [2016, 2021] };
    const typeR = { make: 'Honda', model: 'Civic Type R', years: [2017, 2021] };
    assert.equal(hunts.matchesTarget(identify('Honda', 'Civic'), civic), true);
    assert.equal(hunts.matchesTarget(identify('Honda', 'Civic', { trim: 'Type R' }), typeR), true, 'model plus trim');
    assert.equal(hunts.matchesTarget(identify('Honda', 'Civic'), typeR), false, 'a plain Civic is not a Type R');
    assert.equal(hunts.matchesTarget(identify('Honda', 'Civic', { year_range: '2022-2024' }), civic), false, 'wrong generation');
    assert.equal(hunts.matchesTarget(identify('Honda', 'Civic', { year_range: null }), civic), true, 'no year given: generous');
    assert.equal(hunts.matchesTarget(identify('Chevy', 'Equinox'), { make: 'Chevrolet', model: 'Equinox', years: [2018, 2024] }), true);
    assert.equal(hunts.matchesTarget(identify('Toyota', 'Corolla'), civic), false);
  });
});

// ── the photo and the card are separate systems ───────────────────────────
describe('a street slot and the car card are independent', () => {
  test('a car already collected this season still completes its slot', () => {
    cars.commitCar({ identification: identify('Honda', 'Civic'), playerId: alice, hoodId: 13, photo: photo(), rand: steel });
    const hunt = startStreet();
    const slot = slotFor(hunt, 'honda|civic|2016-2021');

    const out = hunts.submitStreetPhoto({
      playerId: alice, huntId: hunt.id, slot, photo: photo(), hoodId: 13,
      raw: { target_match: null }, identification: identify('Honda', 'Civic'),
    });
    assert.equal(out.car_error.code, 'ALREADY_COLLECTED', 'no second card');
    assert.equal(out.verified, true);
    assert.equal(out.hunt.items[slot].done, true, 'but the hunt slot ticks');
  });

  test('a car past the weekly points cap still completes its slot', () => {
    withConfig({ CAR_WEEKLY_CAP: 0 }, () => {
      const hunt = startStreet();
      const slot = slotFor(hunt, 'honda|civic|2016-2021');
      const out = hunts.submitStreetPhoto({
        playerId: alice, huntId: hunt.id, slot, photo: photo(), hoodId: 13,
        identification: identify('Honda', 'Civic'), rand: steel,
      });
      assert.equal(out.car.points, 0, 'the card mints for nothing');
      assert.ok(out.car.card, 'but it mints');
      assert.equal(out.hunt.items[slot].done, true);
    });
  });

  test('the identifier saying "that is the target" counts, even when it could not name the car', () => {
    const hunt = startStreet();
    const out = hunts.submitStreetPhoto({
      playerId: alice, huntId: hunt.id, slot: 0, photo: photo(), hoodId: 13,
      raw: { target_match: true }, identification: null,
      identifyError: { code: 'IDENTIFY_UNSURE', message: 'not sure' },
    });
    assert.equal(out.verified, true);
    assert.equal(out.car, null);
    assert.equal(out.hunt.items[0].done, true);
  });

  test('an unreadable street photo is kept, so it can be marked by hand', () => {
    const hunt = startStreet();
    const out = hunts.submitStreetPhoto({
      playerId: alice, huntId: hunt.id, slot: 1, photo: photo(), hoodId: 13,
      identifyError: { code: 'IDENTIFY_UNSURE', message: 'not sure' },
    });
    assert.equal(out.verified, false);
    assert.equal(out.hunt.items[1].pending, true);
    assert.equal(code(() => hunts.submitStreetPhoto({ playerId: alice, huntId: hunt.id, slot: 1, photo: photo(), hoodId: null })),
      'HOOD_REQUIRED');
  });
});

// ── I'm sure ──────────────────────────────────────────────────────────────
describe('marking it anyway', () => {
  test('marks the slot, unverified, and raises it for the group', () => {
    const hunt = startPark();
    const sent = hunts.submitParkPhoto({ playerId: alice, huntId: hunt.id, slot: 3, photo: photo(), found: false });
    assert.equal(sent.verified, false);
    assert.equal(sent.hunt.items[3].pending, true);

    const marked = hunts.overrideSlot({ playerId: alice, huntId: hunt.id, slot: 3 });
    const row = db.prepare('SELECT * FROM hunt_items WHERE hunt_id = ? AND slot = 3').get(hunt.id);
    assert.equal(marked.hunt.items[3].done, true);
    assert.equal(row.verified, 0);
    assert.equal(row.overridden, 1);
    assert.equal(row.flagged, 1);
  });

  test('needs a photo to have been sent first', () => {
    const hunt = startPark();
    assert.equal(code(() => hunts.overrideSlot({ playerId: alice, huntId: hunt.id, slot: 0 })), 'NO_ATTEMPT');
  });

  test('a completed hunt with a hand-marked item says so, and its claim can be flagged', () => {
    const hunt = startPark();
    for (const item of hunt.items.slice(0, 4)) {
      hunts.submitParkPhoto({ playerId: alice, huntId: hunt.id, slot: item.slot, photo: photo(), found: true });
    }
    hunts.submitParkPhoto({ playerId: alice, huntId: hunt.id, slot: hunt.items[4].slot, photo: photo(), found: false });
    const { completion } = hunts.overrideSlot({ playerId: alice, huntId: hunt.id, slot: hunt.items[4].slot });
    assert.equal(completion.self_confirmed, 1);
    const [feedItem] = views.feed({ viewerId: 999999 });
    assert.equal(feedItem.claim_kind, 'hunt');
    assert.equal(feedItem.flaggable, true);
    assert.match(feedItem.summary, /finished a Scavenger Blitz at Hunt Park/);
  });
});

// ── slots and abandoning ──────────────────────────────────────────────────
describe('slots and abandoning', () => {
  test('three at a time; abandoning frees one; a second abandon waits out the cooldown', () => {
    const first = startPark();
    startPark();
    startStreet();
    assert.equal(code(() => startPark()), 'HUNT_SLOTS_FULL');

    hunts.abandonHunt({ playerId: alice, huntId: first.id });
    const fourth = startPark();
    assert.equal(code(() => hunts.abandonHunt({ playerId: alice, huntId: fourth.id })), 'ABANDON_COOLDOWN');

    db.prepare("UPDATE hunts SET ended_at = ? WHERE status = 'abandoned'")
      .run(isoPlusHours(nowIso(), -config.HUNT_ABANDON_COOLDOWN_HOURS));
    assert.equal(hunts.abandonHunt({ playerId: alice, huntId: fourth.id }).status, 'abandoned');
  });

  test('a found slot cannot be found again, and a finished hunt takes nothing more', () => {
    const hunt = startPark();
    hunts.submitParkPhoto({ playerId: alice, huntId: hunt.id, slot: 0, photo: photo(), found: true });
    assert.equal(code(() => hunts.submitParkPhoto({ playerId: alice, huntId: hunt.id, slot: 0, photo: photo(), found: true })),
      'SLOT_ALREADY_DONE');
    finishPark(getRemaining(hunt));
    assert.equal(code(() => hunts.submitParkPhoto({ playerId: alice, huntId: hunt.id, slot: 1, photo: photo(), found: true })),
      'HUNT_COMPLETE');
    assert.equal(code(() => hunts.abandonHunt({ playerId: alice, huntId: hunt.id })), 'HUNT_COMPLETE');
  });

  test('somebody else cannot send photos to your hunt', () => {
    const hunt = startPark();
    assert.equal(code(() => hunts.submitParkPhoto({ playerId: alice + 1000, huntId: hunt.id, slot: 0, photo: photo(), found: true })),
      'HUNT_NOT_FOUND');
  });
});

/** The not-yet-found items of a hunt, as a hunt-shaped object finishPark() can walk. */
function getRemaining(hunt) {
  const fresh = hunts.getHunt(hunt.id, alice);
  return { ...fresh, items: fresh.items.filter((i) => !i.done) };
}

// ── rewards ───────────────────────────────────────────────────────────────
describe('finishing a hunt', () => {
  test('writes a hunt claim with points, XP by kind, and three items', () => {
    const completion = finishPark(startPark());
    assert.equal(completion.points, config.HUNT_POINTS);
    assert.equal(completion.xp, config.HUNT_XP_PARK);
    assert.equal(completion.items.length, config.HUNT_ITEMS);

    const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(completion.claim_id);
    assert.equal(claim.claim_kind, 'hunt');
    assert.equal(claim.park_id, null, 'never park_id, or it would collide with the park card rule');
    assert.ok(claim.hunt_id);
    const hunt = db.prepare('SELECT * FROM hunts WHERE id = ?').get(claim.hunt_id);
    assert.equal(hunt.status, 'complete');
    assert.equal(hunt.season_id, seasons.activeSeason().id);
    assert.ok(hunt.week_key);

    const row = views.leaderboard(seasons.activeSeason().id).find((r) => r.player.id === alice);
    assert.equal(row.hunts, 1);
    assert.equal(row.hunt_points, config.HUNT_POINTS);
  });

  test('a street hunt pays more XP than a park hunt', () => {
    assert.ok(config.HUNT_XP_STREET > config.HUNT_XP_PARK);
  });

  test('hunt points stop at the season cap, clamping the hunt that crosses it', () => {
    withConfig({ HUNT_SEASON_POINTS_CAP: 25, HUNT_WEEKLY_SCORING_LIMIT: 0, HUNT_ACTIVE_LIMIT: 10 }, () => {
      const paid = [1, 2, 3, 4].map(() => finishPark(startPark()));
      assert.deepEqual(paid.map((c) => c.points), [10, 10, 5, 0]);
      assert.equal(paid[3].reason, 'season_cap');
      assert.equal(paid[3].items.length, config.HUNT_ITEMS, 'the items are the week limit’s business, not the points cap’s');
    });
  });

  test('a hunt started before this season and finished in it pays into this season', () => {
    const season = seasons.activeSeason();
    const other = db.prepare('SELECT id FROM seasons WHERE id != ? LIMIT 1').get(season.id).id;
    const insertHuntClaim = (seasonId, points) => db.prepare(`
      INSERT INTO claims (hood_id, player_id, season_id, claim_kind, photo_type, points_awarded, xp_awarded,
                          status, flag_count, created_at)
      VALUES (13, ?, ?, 'hunt', 'hunt', ?, 0, 'active', 0, ?)`).run(alice, seasonId, points, nowIso());

    withConfig({ HUNT_SEASON_POINTS_CAP: 200 }, () => {
      insertHuntClaim(other, 195);     // another season's hunts do not count here
      insertHuntClaim(season.id, 195); // this season's do

      const hunt = startPark();
      db.prepare('UPDATE hunts SET started_at = ? WHERE id = ?').run('2026-08-20T12:00:00.000Z', hunt.id);
      const completion = finishPark(hunt);

      assert.equal(completion.points, 5, 'clamped by this season’s cap');
      assert.equal(db.prepare('SELECT season_id FROM claims WHERE id = ?').get(completion.claim_id).season_id, season.id);
    });
  });

  test('hunt items do not count against the weekly item cap', () => {
    withConfig({ ITEM_WEEKLY_CAP: 1 }, () => {
      // One ordinary pull grant, filling the week.
      const claim = Number(db.prepare(`
        INSERT INTO claims (hood_id, player_id, season_id, claim_kind, photo_type, points_awarded, status, flag_count, created_at)
        VALUES (13, ?, ?, 'park', 'park_sign', 5, 'active', 0, ?)`).run(alice, seasons.activeSeason().id, nowIso()).lastInsertRowid);
      db.prepare(`INSERT INTO item_grants (claim_id, player_id, season_id, week_key, item_type, created_at, source)
                  VALUES (?, ?, ?, ?, 'recon', ?, 'pull')`)
        .run(claim, alice, seasons.activeSeason().id, items.itemCapacity(alice).week_key, nowIso());
      assert.equal(items.itemCapacity(alice).remaining, 0);

      const completion = finishPark(startPark());
      assert.equal(completion.items.length, config.HUNT_ITEMS, 'a full item cap does not stop a hunt’s items');
      assert.equal(items.itemCapacity(alice).granted, 1, 'and they do not use it up');
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM item_grants WHERE source = 'hunt'").get().n, config.HUNT_ITEMS);
    });
  });

  test('past the weekly scoring limit a hunt completes for XP only', () => {
    withConfig({ HUNT_WEEKLY_SCORING_LIMIT: 2, HUNT_ACTIVE_LIMIT: 10 }, () => {
      const [one, two, three] = [1, 2, 3].map(() => finishPark(startPark()));
      assert.equal(one.scoring && two.scoring, true);
      assert.equal(three.scoring, false);
      assert.equal(three.points, 0);
      assert.deepEqual(three.items, []);
      assert.equal(three.xp, config.HUNT_XP_PARK, 'the XP still lands');
      assert.equal(three.reason, 'weekly_limit');
    });
  });

  test('the hunt list reports every limit', () => {
    finishPark(startPark());
    startStreet();
    const list = hunts.huntsFor(alice);
    assert.equal(list.active.length, 1);
    assert.equal(list.recent.length, 1);
    assert.equal(list.limits.used, 1);
    assert.equal(list.limits.week_scoring, 1);
    assert.equal(list.limits.season_points, config.HUNT_POINTS);
  });
});
