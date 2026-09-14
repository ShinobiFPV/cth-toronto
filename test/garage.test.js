// The Garage: what counts as the same car, what a car collection may and may not touch,
// and the one scarce thing in it — the season's hologram.
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-garage-'));
process.env.CTH_DB = path.join(tmp, 'test.sqlite');
process.env.CTH_JWT_SECRET = 'test-secret';

let db, nowIso, config, garage, vehicles, editions, parks, xp, views, game, seasons;

before(async () => {
  ({ db, nowIso } = await import('../server/db.js'));
  ({ config } = await import('../server/config.js'));
  garage = await import('../server/lib/garage.js');
  vehicles = await import('../server/lib/vehicles.js');
  editions = await import('../server/lib/editions.js');
  parks = await import('../server/lib/parks.js');
  xp = await import('../server/lib/xp.js');
  views = await import('../server/lib/views.js');
  game = await import('../server/lib/game.js');
  seasons = await import('../server/lib/seasons.js');
});

let alice, bob;
let seq = 0;

const photo = () => {
  seq += 1;
  return {
    path_original: `original/g${seq}.jpg`,
    path_display: `display/g${seq}.webp`,
    path_thumb: `thumb/g${seq}.webp`,
    width: 1600, height: 1200, bytes: 2048, exif_json: null,
  };
};

const makePlayer = (handle) => Number(db.prepare(`
  INSERT INTO players (handle, display_name, password_hash, colour, is_admin, created_at)
  VALUES (?, ?, 'x', '#fff', 0, ?)`).run(handle, handle, nowIso()).lastInsertRowid);

/** What the identifier would have said, resolved the way the route resolves it. */
const ident = (make, model, extra = {}) => vehicles.resolveIdentification({
  is_vehicle: true, in_situ: true, make, model, generation: null, trim: null,
  year_range: '2019-2024', body_style: 'sedan', confidence: 0.9, plates: [], ...extra,
});

const never = () => 1;
const always = (key) => {
  const want = editions.EDITIONS.find((e) => e.key === key);
  return (oneIn) => (want && oneIn === want.oneIn() ? 0 : 1);
};

const snap = (playerId, make, model, { hood = 13, rand = never, extra } = {}) =>
  garage.commitCar({ identification: ident(make, model, extra), playerId, hoodId: hood, photo: photo(), rand });

const count = (sql, ...args) => db.prepare(sql).get(...args).n;

/** Put a config lever back however the test leaves. */
const withConfig = (patch, fn) => {
  const was = Object.fromEntries(Object.keys(patch).map((k) => [k, config[k]]));
  Object.assign(config, patch);
  try { return fn(); } finally { Object.assign(config, was); }
};

beforeEach(() => {
  db.exec('DELETE FROM trades; DELETE FROM card_holdings');
  db.exec(`UPDATE hood_state SET owner_id = NULL, active_claim_id = NULL, photo_type = NULL,
           last_claim_at = NULL, locked_until = NULL`);
  db.exec('DELETE FROM flags; DELETE FROM claims; DELETE FROM photos; DELETE FROM messages');
  db.exec('DELETE FROM vehicles; DELETE FROM parks; DELETE FROM players');
  parks.forgetSetSize();

  seq += 1;
  alice = makePlayer(`alice${seq}`);
  bob = makePlayer(`bob${seq}`);
});

// ── the dedupe key ────────────────────────────────────────────────────────
describe('what counts as the same car', () => {
  // A wrapper, not a reference: this runs as the suite registers, before `before()` has
  // imported the module.
  const key = (...args) => vehicles.vehicleKey(...args);

  test('trim is stripped, so an Si and a base Civic are one package', () => {
    assert.equal(key('Honda', 'Civic'), 'honda|civic');
    assert.equal(key('Honda', 'Civic Si'), 'honda|civic');
    assert.equal(key('Honda', 'Civic Sport Touring'), 'honda|civic');
    assert.equal(key('Honda', 'Civic', { trim: 'Si' }), 'honda|civic');
  });

  test('trim the identifier reported separately is stripped from the model too', () => {
    // "S" is not a generic trim word — see the Model S case — but it was reported as trim.
    assert.equal(key('Porsche', '911 Carrera S', { trim: 'Carrera S' }), 'porsche|911');
  });

  test('generation, years, drivetrain and body style are not the model', () => {
    assert.equal(key('Porsche', '911 (992)', { generation: '992' }), 'porsche|911');
    assert.equal(key('Toyota', '2019 Corolla Hybrid'), 'toyota|corolla');
    assert.equal(key('Ford', 'F-150 Lariat SuperCrew 4x4'), 'ford|f150');
    assert.equal(key('Audi', 'A4 quattro Sedan'), 'audi|a4');
  });

  test('punctuation and a repeated make do not split a model', () => {
    assert.equal(key('Ford', 'F150'), key('Ford', 'F-150'));
    assert.equal(key('Mazda', 'CX-5'), key('Mazda', 'CX5'));
    assert.equal(key('Honda', 'Honda Civic'), 'honda|civic');
    assert.equal(key('Mercedes', 'C-Class'), key('Mercedes-Benz', 'C-Class'));
    assert.equal(key('Škoda', 'Octavia'), 'skoda|octavia', 'and accents do not either');
  });

  test('too coarse is as wrong as too fine', () => {
    // Every Toyota is not one package, and a single-letter model is not a trim.
    assert.notEqual(key('Toyota', 'Corolla'), key('Toyota', 'Camry'));
    assert.equal(key('Tesla', 'Model S'), 'tesla|models');
    assert.notEqual(key('Tesla', 'Model S'), key('Tesla', 'Model 3'));
    assert.notEqual(key('Ford', 'Mustang'), key('Ford', 'Mustang Mach-E'));
    assert.equal(key('Jeep', 'Grand Cherokee'), 'jeep|grandcherokee');
    assert.equal(key('Ford', 'Sport Trac'), 'ford|sporttrac', 'a trim word is only stripped from the end');
  });

  test('the model name is never stripped to nothing', () => {
    assert.equal(key('Chevrolet', 'SS'), 'chevrolet|ss');
  });
});

describe('resolving what the identifier said', () => {
  const code = (fn) => { try { fn(); } catch (err) { return err.code; } return null; };

  test('not a vehicle', () => {
    assert.equal(code(() => ident('Honda', 'Civic', { is_vehicle: false })), 'NOT_A_VEHICLE');
  });

  test('unsure, missing a model, or no answer at all', () => {
    assert.equal(code(() => ident('Honda', 'Civic', { confidence: 0.2 })), 'IDENTIFY_UNSURE');
    assert.equal(code(() => ident('Honda', null)), 'IDENTIFY_UNSURE');
    assert.equal(code(() => ident('Unknown', 'Unknown')), 'IDENTIFY_UNSURE');
    assert.equal(code(() => vehicles.resolveIdentification(null)), 'IDENTIFY_UNSURE');
  });

  test('a photo of a screen resolves — marked, not rejected', () => {
    const it = ident('Honda', 'Civic', { in_situ: false });
    assert.equal(it.in_situ, false);
    assert.equal(it.vehicle_key, 'honda|civic');
  });

  test('plate boxes are clamped to the frame', () => {
    const it = ident('Honda', 'Civic', {
      plates: [{ x: 0.9, y: -0.2, width: 3, height: 0.1 }, { x: 0.1, y: 0.1, width: 0, height: 0 }],
    });
    assert.deepEqual(it.plates, [{ x: 0.9, y: 0, width: 1, height: 0.1 }]);
  });
});

// ── collecting ────────────────────────────────────────────────────────────
describe('collecting a car', () => {
  test('is a claim: kind car, the vehicle, the week, and the flat value', () => {
    const { package: pack, points } = snap(alice, 'Honda', 'Civic Si', { extra: { trim: 'Si' } });
    const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(pack.claim_id);

    assert.equal(row.claim_kind, 'car');
    assert.equal(row.points_awarded, config.CAR_POINTS);
    assert.equal(points, config.CAR_POINTS);
    assert.ok(row.vehicle_id);
    assert.match(row.week_key, /^\d{4}-W\d{2}$/);
    assert.equal(row.vehicle_trim, 'Si', 'sighting detail rides on the claim');
    assert.equal(pack.vehicle.name, 'Honda Civic', 'while the package is the base model');
    assert.ok(JSON.parse(row.identify_json).make, 'and what the identifier said is kept for flaggers');
    assert.equal(row.park_id, null);
  });

  test('never touches hood_state', () => {
    const photoOf = () => ({ ...photo() });
    game.commitClaim({ hoodId: 13, playerId: bob, declaredType: 'landmark', photo: photoOf() });
    const before = db.prepare('SELECT * FROM hood_state ORDER BY hood_id').all();

    snap(alice, 'Honda', 'Civic', { hood: 13 });
    snap(alice, 'Mazda', 'CX-5', { hood: 1 });

    assert.deepEqual(db.prepare('SELECT * FROM hood_state ORDER BY hood_id').all(), before,
      'snapping a car in a Hood takes nothing from anybody');
  });

  test('a car in a Hood does not use up that Hood\'s discovery bonus', () => {
    // A car claim has park_id NULL, which used to be how the XP code recognised territory.
    snap(alice, 'Honda', 'Civic', { hood: 13 });
    const { xp: earned } = game.commitClaim({
      hoodId: 13, playerId: alice, declaredType: 'landmark', photo: photo(),
    });
    assert.equal(earned.discovered, 'hood', 'her first conquer here is still a first visit');
  });

  test('the first sighting of a vehicle starts its catalogue entry; later ones share it', () => {
    const first = snap(alice, 'Honda', 'Civic');
    const second = snap(bob, 'Honda', 'Civic LX');
    assert.equal(first.first_sighting, true);
    assert.equal(second.first_sighting, false);
    assert.equal(first.vehicle.id, second.vehicle.id);
    assert.equal(count('SELECT COUNT(*) AS n FROM vehicles'), 1);
    assert.equal(db.prepare('SELECT first_seen_claim_id AS id FROM vehicles').get().id,
      first.package.claim_id);
  });

  test('the package art is seeded, not random', () => {
    const { package: pack } = snap(alice, 'Honda', 'Civic');
    const season = seasons.activeSeason().id;
    assert.equal(pack.card_seed, garage.packSeed(alice, pack.vehicle.id, season));
    assert.equal(garage.getPackageByClaim(pack.claim_id).card_seed, pack.card_seed);
  });

  test('a suspect photo is collected, and says so', () => {
    const { package: pack } = snap(alice, 'Honda', 'Civic', { extra: { in_situ: false } });
    assert.equal(pack.suspect, true);
    assert.equal(pack.status, 'active');
  });
});

// ── duplicates ────────────────────────────────────────────────────────────
describe('once per vehicle per player per season', () => {
  test('a repeat sighting mints nothing — no package, no XP, no points', () => {
    snap(alice, 'Honda', 'Civic');
    const claims = count('SELECT COUNT(*) AS n FROM claims');
    const photos = count('SELECT COUNT(*) AS n FROM photos');
    const xpBefore = xp.xpOf(alice);

    assert.throws(() => snap(alice, 'Honda', 'Civic Si'),
      (err) => { assert.equal(err.code, 'ALREADY_COLLECTED'); assert.ok(err.claim_id); return true; });

    assert.equal(count('SELECT COUNT(*) AS n FROM claims'), claims);
    assert.equal(count('SELECT COUNT(*) AS n FROM photos'), photos, 'the transaction rolled back');
    assert.equal(xp.xpOf(alice), xpBefore);
  });

  test('somebody else can still collect the same car', () => {
    snap(alice, 'Honda', 'Civic');
    assert.equal(snap(bob, 'Honda', 'Civic').package.player.id, bob);
  });

  test('a package the group threw out frees the vehicle up again', () => {
    const { package: pack } = snap(alice, 'Honda', 'Civic');
    game.revertClaim(pack.claim_id);
    const again = snap(alice, 'Honda', 'Civic');
    assert.equal(again.package.vehicle.id, pack.vehicle.id);
    assert.equal(again.points, config.CAR_POINTS);
  });

  test('the database enforces it too, not just the evaluator', () => {
    const { package: pack } = snap(alice, 'Honda', 'Civic');
    assert.throws(() => db.prepare(`
      INSERT INTO claims (hood_id, player_id, season_id, claim_kind, points_awarded, status,
                          vehicle_id, created_at)
      SELECT hood_id, player_id, season_id, 'car', 0, 'active', vehicle_id, created_at
        FROM claims WHERE id = ?`).run(pack.claim_id), /UNIQUE/);
  });

  test('with the repeat trickle on, a repeat pays a little XP once a week, and still no package', () => {
    withConfig({ CAR_REPEAT_XP: 10 }, () => {
      snap(alice, 'Honda', 'Civic');
      const before = xp.xpOf(alice);

      const repeat = snap(alice, 'Honda', 'Civic');
      assert.equal(repeat.repeat, true);
      assert.equal(repeat.points, 0);
      assert.equal(xp.xpOf(alice), before + 10);

      assert.throws(() => snap(alice, 'Honda', 'Civic'),
        (err) => err.code === 'ALREADY_COLLECTED', 'once per car per week');
      assert.equal(garage.packagesOf(alice).length, 1, 'never a second package');
    });
  });
});

// ── editions ──────────────────────────────────────────────────────────────
describe('editions on a package', () => {
  test('nothing is less than Steel', () => {
    const { package: pack, xp: earned } = snap(alice, 'Honda', 'Civic', { rand: never });
    assert.equal(pack.edition, 'steel');
    assert.equal(earned.xp, config.CAR_XP_STEEL);
  });

  test('XP rises with the edition and points do not move', () => {
    const steel = snap(alice, 'Honda', 'Civic', { rand: never });
    const gold = snap(alice, 'Mazda', 'CX-5', { rand: always('gold') });
    const holo = snap(alice, 'Audi', 'A4', { rand: always('hologram') });
    assert.deepEqual([steel.package.edition, gold.package.edition, holo.package.edition],
      ['steel', 'gold', 'hologram']);
    assert.deepEqual([steel.xp.xp, gold.xp.xp, holo.xp.xp],
      [config.CAR_XP_STEEL, config.CAR_XP_GOLD, config.CAR_XP_HOLOGRAM]);
    assert.ok(config.CAR_XP_STEEL < config.CAR_XP_GOLD && config.CAR_XP_GOLD < config.CAR_XP_HOLOGRAM);
    assert.equal(new Set([steel.points, gold.points, holo.points]).size, 1);
  });

  test('an all-hits roll is a hologram, not demoted', () => {
    assert.equal(snap(alice, 'Honda', 'Civic', { rand: () => 0 }).package.edition, 'hologram');
  });
});

describe('the hologram cap', () => {
  test('one per season, globally — the next one falls through to Gold', () => {
    assert.equal(snap(alice, 'Honda', 'Civic', { rand: always('hologram') }).package.edition, 'hologram');
    assert.notEqual(snap(bob, 'Mazda', 'CX-5', { rand: always('hologram') }).package.edition, 'hologram');
    assert.equal(snap(bob, 'Audi', 'A4', { rand: () => 0 }).package.edition, 'gold',
      'a hit is still a hit; it lands one tier down');
  });

  test('two collections in flight cannot both mint it', () => {
    // Both preflights see the hologram still out there...
    const a = ident('Honda', 'Civic');
    const b = ident('Mazda', 'CX-5');
    assert.equal(garage.carHolos(alice, seasons.activeSeason().id), 0);
    assert.ok(garage.evaluateCar({ identification: a, playerId: alice }).ok);
    assert.ok(garage.evaluateCar({ identification: b, playerId: bob }).ok);

    // ...and the commits re-check inside their transactions.
    const first = garage.commitCar({ identification: a, playerId: alice, hoodId: 13, photo: photo(), rand: () => 0 });
    const second = garage.commitCar({ identification: b, playerId: bob, hoodId: 13, photo: photo(), rand: () => 0 });
    assert.deepEqual([first.package.edition, second.package.edition], ['hologram', 'gold']);
    assert.equal(count("SELECT COUNT(*) AS n FROM claims WHERE edition = 'hologram'"), 1);
  });

  test('a reverted hologram frees the slot', () => {
    const { package: pack } = snap(alice, 'Honda', 'Civic', { rand: always('hologram') });
    game.revertClaim(pack.claim_id);
    assert.equal(snap(bob, 'Mazda', 'CX-5', { rand: always('hologram') }).package.edition, 'hologram');
  });

  test('per player per season is one lever away', () => {
    withConfig({ CAR_HOLOGRAM_CAP_SCOPE: 'player-season' }, () => {
      snap(alice, 'Honda', 'Civic', { rand: always('hologram') });
      assert.equal(snap(bob, 'Mazda', 'CX-5', { rand: always('hologram') }).package.edition, 'hologram');
      assert.notEqual(snap(alice, 'Audi', 'A4', { rand: always('hologram') }).package.edition, 'hologram');
    });
  });

  test('a car hologram does not use up the Hood\'s park hologram', () => {
    db.prepare(`INSERT INTO parks (id, name, hood_id, lat, lng, value, distance_km, set_number)
                VALUES (8801, 'Garage Test Park', 13, 43.65, -79.38, 10, 1, 1)`).run();
    snap(alice, 'Honda', 'Civic', { hood: 13, rand: always('hologram') });
    assert.equal(editions.holosInHood(13, seasons.activeSeason().id), 0);
    const card = parks.commitCollect({ parkId: 8801, playerId: bob, photo: photo(), rand: always('hologram') });
    assert.equal(card.claim.edition, 'hologram', 'the Hood 13 park hologram is still out there');
  });
});

describe('the edition roll is unaffected by the points cap', () => {
  test('a hologram past the cap is still a hologram, worth 0 points and full XP', () => {
    withConfig({ CAR_WEEKLY_CAP: config.CAR_POINTS }, () => {
      snap(alice, 'Honda', 'Civic');
      const past = snap(alice, 'Mazda', 'CX-5', { rand: always('hologram') });
      assert.equal(past.points, 0);
      assert.equal(past.package.edition, 'hologram');
      assert.equal(past.xp.xp, config.CAR_XP_HOLOGRAM);
      assert.equal(db.prepare('SELECT xp_awarded AS x FROM claims WHERE id = ?')
        .get(past.package.claim_id).x, config.CAR_XP_HOLOGRAM);
    });
  });
});

// ── the Case and everything that reads it ─────────────────────────────────
describe('the Case, and what it does not inflate', () => {
  test('cars have their own counters and never count as parks', () => {
    db.prepare(`INSERT INTO parks (id, name, hood_id, lat, lng, value, distance_km, set_number)
                VALUES (8802, 'Counter Park', 13, 43.65, -79.38, 40, 5, 1)`).run();
    // rand: never, or one run in ten the park rolls its own Steel and by_edition is not {}.
    parks.commitCollect({ parkId: 8802, playerId: alice, photo: photo(), rand: never });
    snap(alice, 'Honda', 'Civic', { rand: always('gold') });
    snap(alice, 'Mazda', 'CX-5');

    const binder = parks.collectionSummary(alice);
    assert.equal(binder.season_collected, 1);
    assert.equal(binder.season_points, 40);
    assert.equal(binder.cards_held, 1);
    assert.deepEqual(binder.by_edition, {}, 'a gold package is not a gold park card');

    const shelf = garage.garageSummary(alice);
    assert.equal(shelf.season_collected, 2);
    assert.equal(shelf.season_points, config.CAR_POINTS * 2);
    assert.equal(shelf.packages_held, 2);
    assert.deepEqual(shelf.by_edition, { gold: 1, steel: 1 });

    assert.equal(parks.cardsOf(alice).length, 1);
    assert.equal(garage.packagesOf(alice).length, 2);
  });

  test('a package is not a park card, and a park card is not a package', () => {
    const { package: pack } = snap(alice, 'Honda', 'Civic');
    assert.equal(parks.getCardByClaim(pack.claim_id), null);
    assert.equal(garage.getPackageByClaim(pack.claim_id).kind, 'car');
  });

  test('car points join the one total, and the standings split them out', () => {
    snap(alice, 'Honda', 'Civic');
    const row = views.leaderboard(seasons.activeSeason().id).find((r) => r.player.id === alice);
    assert.equal(row.points, config.CAR_POINTS);
    assert.equal(row.cars, 1);
    assert.equal(row.car_points, config.CAR_POINTS);
    assert.equal(row.territory_points, 0);
    assert.equal(row.park_points, 0);
  });

  test('the feed says what it was', () => {
    snap(alice, 'Audi', 'A4');
    const [item] = views.feed({ viewerId: bob });
    assert.equal(item.claim_kind, 'car');
    assert.equal(item.vehicle.name, 'Audi A4');
    assert.match(item.summary, /snapped an Audi A4 in Hood 13/);
    assert.equal(item.flaggable, true, 'the honour system covers cars too');
  });

  test('the catalogue lists every vehicle and who holds a package of it', () => {
    snap(alice, 'Honda', 'Civic');
    snap(bob, 'Honda', 'Civic');
    snap(bob, 'Mazda', 'CX-5');
    const cat = garage.catalogue();
    assert.equal(cat.total, 2);
    const civic = cat.vehicles.find((v) => v.key === 'honda|civic');
    assert.deepEqual(civic.packages.map((p) => p.holder.id).sort(), [alice, bob].sort());
    assert.equal(garage.vehicleHistory(civic.id).sightings.length, 2);
  });
});
