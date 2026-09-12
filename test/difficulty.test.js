// The difficulty score: the formula, and how it composes with seasonal escalation.
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeDifficulty, haversineKm, CITY_CENTRE, MIN_DIFFICULTY, MAX_DIFFICULTY,
} from '../scripts/lib/difficulty.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-diff-'));
process.env.CTH_DB = path.join(tmp, 'test.sqlite');
process.env.CTH_JWT_SECRET = 'test-secret';

let db, recomputeValues, config, HOOD_SEED, NEIGHBOUR_SEED, DIFFICULTY_SEED;

before(async () => {
  ({ db, recomputeValues } = await import('../server/db.js'));
  ({ config } = await import('../server/config.js'));
  ({ HOOD_SEED, NEIGHBOUR_SEED, DIFFICULTY_SEED } = await import('../server/lib/hood-seed.js'));
});

describe('the difficulty formula', () => {
  const scores = () => computeDifficulty(HOOD_SEED.map((h) => ({
    id: h.id, lat: h.lat, lng: h.lng, borders: (NEIGHBOUR_SEED[h.id] ?? []).length,
  })));

  test('uses the full 5-50 range, end to end', () => {
    const values = [...scores().values()].map((s) => s.difficulty);
    assert.equal(Math.min(...values), MIN_DIFFICULTY);
    assert.equal(Math.max(...values), MAX_DIFFICULTY);
    assert.equal(values.length, 25);
    assert.ok(values.every((v) => Number.isInteger(v)), 'scores are whole points');
  });

  test('makes Rouge Park the most expensive Hood in Toronto', () => {
    // The spec itself jokes that nothing but points will get anyone out to Rouge Park.
    // If a change to the formula breaks this, the formula is wrong, not this test.
    const ranked = [...scores().entries()].sort((a, b) => b[1].difficulty - a[1].difficulty);
    assert.equal(ranked[0][0], 25, 'Hood 25, Scarborough-Rouge Park');
    assert.equal(ranked[0][1].difficulty, MAX_DIFFICULTY);
  });

  test('makes a downtown Hood with many borders the cheapest', () => {
    const ranked = [...scores().entries()].sort((a, b) => a[1].difficulty - b[1].difficulty);
    const [id, cheapest] = ranked[0];
    assert.equal(cheapest.difficulty, MIN_DIFFICULTY);
    assert.ok(cheapest.distance_km < 5, `Hood ${id} should be close in, got ${cheapest.distance_km} km`);
    assert.ok(cheapest.borders >= 5, `Hood ${id} should be well connected, got ${cheapest.borders}`);
  });

  test('rewards distance, all else being equal', () => {
    const near = computeDifficulty([
      { id: 1, lat: CITY_CENTRE.lat, lng: CITY_CENTRE.lng, borders: 4 },
      { id: 2, lat: CITY_CENTRE.lat + 0.2, lng: CITY_CENTRE.lng, borders: 4 },
    ]);
    assert.ok(near.get(2).difficulty > near.get(1).difficulty,
      'the further Hood should be worth more');
  });

  test('rewards isolation: fewer borders is harder', () => {
    const pair = computeDifficulty([
      { id: 1, lat: CITY_CENTRE.lat + 0.1, lng: CITY_CENTRE.lng, borders: 7 },
      { id: 2, lat: CITY_CENTRE.lat + 0.1, lng: CITY_CENTRE.lng, borders: 2 },
    ]);
    assert.ok(pair.get(2).difficulty > pair.get(1).difficulty,
      'a cul-de-sac should be worth more than a crossroads at the same distance');
  });

  test('is deterministic', () => {
    const a = [...scores().entries()].map(([id, s]) => `${id}:${s.difficulty}`).join(',');
    const b = [...scores().entries()].map(([id, s]) => `${id}:${s.difficulty}`).join(',');
    assert.equal(a, b);
  });

  test('survives degenerate input rather than producing NaN', () => {
    assert.equal(computeDifficulty([]).size, 0);

    const single = computeDifficulty([{ id: 1, lat: 43.7, lng: -79.4, borders: 3 }]);
    assert.equal(single.get(1).difficulty, MIN_DIFFICULTY, 'one Hood normalises to the floor');

    const identical = computeDifficulty([
      { id: 1, lat: 43.7, lng: -79.4, borders: 3 },
      { id: 2, lat: 43.7, lng: -79.4, borders: 3 },
    ]);
    for (const v of identical.values()) assert.ok(Number.isInteger(v.difficulty));
  });

  test('the committed seed matches what the formula produces', () => {
    // The seed exists so a fresh checkout is playable without a download. If it drifts
    // from the formula, a fresh install and an imported install disagree about prices.
    for (const [id, s] of scores()) {
      assert.equal(DIFFICULTY_SEED[id], s.difficulty,
        `DIFFICULTY_SEED[${id}] is stale — re-run npm run import-hoods -- --seed`);
    }
  });

  test('haversine agrees with a known distance', () => {
    // City Hall to Toronto Pearson is about 22 km as the crow flies.
    const pearson = { lat: 43.6777, lng: -79.6248 };
    const d = haversineKm(CITY_CENTRE, pearson);
    assert.ok(d > 18 && d < 25, `expected roughly 22 km, got ${d.toFixed(1)}`);
  });
});

describe('what a Hood is worth', () => {
  beforeEach(() => {
    db.exec('UPDATE hoods SET ever_conquered = 0, escalations = 0');
    recomputeValues();
  });

  const hood = (id) => db.prepare('SELECT * FROM hoods WHERE id = ?').get(id);

  test('an untouched Hood is worth exactly its difficulty', () => {
    for (const h of db.prepare('SELECT * FROM hoods').all()) {
      assert.equal(h.unclaimed_value, h.difficulty);
    }
  });

  test('each escalation adds a step on top of the difficulty', () => {
    db.prepare('UPDATE hoods SET escalations = 2 WHERE id = 25').run();
    recomputeValues();
    assert.equal(hood(25).unclaimed_value,
      hood(25).difficulty + 2 * config.ESCALATION_STEP);
  });

  test('the hardest and easiest Hoods escalate from different floors', () => {
    db.prepare('UPDATE hoods SET escalations = 3').run();
    recomputeValues();
    // Three rollovers: Rouge Park 50 -> 125, University-Rosedale 5 -> 80.
    assert.equal(hood(25).unclaimed_value, 50 + 3 * config.ESCALATION_STEP);
    assert.equal(hood(11).unclaimed_value, 5 + 3 * config.ESCALATION_STEP);
    assert.ok(hood(25).unclaimed_value > hood(11).unclaimed_value,
      'the hard Hood stays ahead no matter how long both sit there');
  });

  test('recomputing is idempotent', () => {
    db.prepare('UPDATE hoods SET escalations = 1').run();
    recomputeValues();
    const first = db.prepare('SELECT id, unclaimed_value FROM hoods ORDER BY id').all();
    recomputeValues();
    recomputeValues();
    assert.deepEqual(db.prepare('SELECT id, unclaimed_value FROM hoods ORDER BY id').all(), first);
  });

  test('an escalation cap clamps the value without touching the difficulty', () => {
    const original = config.ESCALATION_CAP;
    config.ESCALATION_CAP = 60;
    try {
      db.prepare('UPDATE hoods SET escalations = 4').run();
      recomputeValues();
      for (const h of db.prepare('SELECT * FROM hoods').all()) {
        assert.ok(h.unclaimed_value <= 60, `Hood ${h.id} exceeded the cap`);
        assert.ok(h.difficulty <= MAX_DIFFICULTY, 'the difficulty score itself is untouched');
      }
    } finally {
      config.ESCALATION_CAP = original;
      recomputeValues();
    }
  });

  test('stealing is priced off difficulty, so escalation never inflates it', () => {
    db.prepare('UPDATE hoods SET escalations = 3').run();
    recomputeValues();
    for (const h of db.prepare('SELECT * FROM hoods').all()) {
      assert.equal(h.difficulty * config.STEAL_MULTIPLIER, h.difficulty * 2);
      assert.ok(h.difficulty * config.STEAL_MULTIPLIER <= 100,
        'the steal ceiling stays at 100 however long a Hood sits unclaimed');
    }
  });
});
