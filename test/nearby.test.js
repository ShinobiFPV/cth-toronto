// Location: Find a Park's arithmetic, what it lists, whether its "XP only" is telling the
// truth — and the guarantee the whole feature rests on, that no position ever reaches the
// server.
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  haversineMetres, nearestParks, awardFor, capacityByHood, formatDistance, accuracyWarning,
  directionsUrl, locateFailure, LOCATE_OPTIONS,
} from '../web/src/lib/nearby.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-nearby-'));
process.env.CTH_DB = path.join(tmp, 'test.sqlite');
process.env.CTH_JWT_SECRET = 'test-secret';

let db, nowIso, config, parks, views, privacy, parkIndexRows;

before(async () => {
  ({ db, nowIso } = await import('../server/db.js'));
  ({ config } = await import('../server/config.js'));
  parks = await import('../server/lib/parks.js');
  views = await import('../server/lib/views.js');
  privacy = await import('../server/lib/privacy.js');
  ({ parkIndexRows } = await import('../scripts/build-park-index.js'));
});

const CITY_HALL = { lat: 43.6534, lng: -79.3841 };

// Real-ish parks around downtown, plus one far out in Scarborough.
const PARKS = [
  { id: 8101, name: 'City Hall Parkette', hood_id: 13, lat: 43.6536, lng: -79.3843, value: 10 },
  { id: 8102, name: 'Bay Green', hood_id: 13, lat: 43.6500, lng: -79.3800, value: 30 },
  { id: 8103, name: 'Queen Park', hood_id: 13, lat: 43.6600, lng: -79.3900, value: 20 },
  { id: 8104, name: 'Harbour Square', hood_id: 10, lat: 43.6400, lng: -79.3790, value: 15 },
  { id: 8105, name: 'Midtown Commons', hood_id: 12, lat: 43.7000, lng: -79.4000, value: 25 },
  { id: 8106, name: 'Far East Park', hood_id: 25, lat: 43.8000, lng: -79.1500, value: 90 },
];

let alice;
let seq = 0;
const photo = () => {
  seq += 1;
  return { path_original: `o/n${seq}.jpg`, path_display: `d/n${seq}.webp`, path_thumb: `t/n${seq}.webp`,
    width: 10, height: 10, bytes: 10, exif_json: null };
};

const withConfig = (patch, fn) => {
  const was = Object.fromEntries(Object.keys(patch).map((k) => [k, config[k]]));
  Object.assign(config, patch);
  try { return fn(); } finally { Object.assign(config, was); }
};

const steel = (n) => n - 1;
const collect = (parkId) => parks.commitCollect({ parkId, playerId: alice, photo: photo(), rand: steel });

/** What the phone would hold: the static index, the map payload, and the Hood list. */
const phone = () => {
  const map = parks.parksForMap(alice);
  return {
    index: parkIndexRows(db),
    state: new Map(map.parks.map((p) => [p.i, { v: p.v, c: p.c }])),
    capacity: capacityByHood(views.listHoods(alice)),
  };
};

beforeEach(() => {
  db.exec('DELETE FROM item_uses; DELETE FROM item_armed; DELETE FROM item_grants');
  db.exec('DELETE FROM trades; DELETE FROM card_holdings');
  db.exec('DELETE FROM flags; DELETE FROM claims; DELETE FROM photos; DELETE FROM messages');
  db.exec('DELETE FROM parks; DELETE FROM players');
  const ins = db.prepare(`INSERT INTO parks (id, name, hood_id, lat, lng, value, distance_km, set_number)
                          VALUES (@id, @name, @hood_id, @lat, @lng, @value, 1, @id)`);
  for (const p of PARKS) ins.run(p);
  seq += 1;
  alice = Number(db.prepare(`INSERT INTO players (handle, display_name, password_hash, colour, is_admin, created_at)
                             VALUES (?, ?, 'x', '#fff', 0, ?)`).run(`alice${seq}`, 'Alice', nowIso()).lastInsertRowid);
});

// ── distance ──────────────────────────────────────────────────────────────
describe('distance', () => {
  test('a degree of latitude is 111.2 km, and distance is symmetric and zero to itself', () => {
    const a = { lat: 43, lng: -79 };
    const b = { lat: 44, lng: -79 };
    assert.ok(Math.abs(haversineMetres(a, b) - 111195) < 2);
    assert.equal(haversineMetres(a, b), haversineMetres(b, a));
    assert.equal(haversineMetres(a, a), 0);
  });

  test('a short east–west hop in Toronto matches the flat-earth figure', () => {
    const expected = 111195.08 * Math.cos((43.65 * Math.PI) / 180) * 0.01;
    const got = haversineMetres({ lat: 43.65, lng: -79.39 }, { lat: 43.65, lng: -79.38 });
    assert.ok(Math.abs(got - expected) < 0.5, `${got} vs ${expected}`);
  });

  test('City Hall to the CN Tower is about 1.22 km', () => {
    const tower = { lat: 43.6426, lng: -79.3871 };
    const dLat = (CITY_HALL.lat - tower.lat) * 111195.08;
    const dLng = (tower.lng - CITY_HALL.lng) * 111195.08 * Math.cos((43.648 * Math.PI) / 180);
    const flat = Math.hypot(dLat, dLng);
    assert.ok(Math.abs(haversineMetres(CITY_HALL, tower) - flat) < 2);
    assert.ok(flat > 1200 && flat < 1250);
  });

  test('the nearest five come back nearest first, however the index is ordered', () => {
    const index = [7, 2, 5, 1, 8, 3, 6, 4].map((k) => ({ i: k, n: `P${k}`, h: 1, la: CITY_HALL.lat + k * 0.001, ln: CITY_HALL.lng }));
    const rows = nearestParks({ origin: CITY_HALL, index, count: 5, includeCollected: true });
    assert.deepEqual(rows.map((r) => r.id), [1, 2, 3, 4, 5]);
    for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i].distance_m >= rows[i - 1].distance_m);
  });

  test('distances read like a person would say them', () => {
    assert.equal(formatDistance(4), '10 m');
    assert.equal(formatDistance(84), '80 m');
    assert.equal(formatDistance(1440), '1.4 km');
    assert.equal(formatDistance(12_300), '12 km');
  });

  test('a vague fix is said out loud', () => {
    assert.equal(accuracyWarning(35, 200), null);
    assert.match(accuracyWarning(650, 200), /650 m/);
  });
});

// ── what the list shows ───────────────────────────────────────────────────
describe('which parks are listed', () => {
  test('collected parks are left out by default, and the toggle brings them back', () => {
    collect(8101);
    const { index, state, capacity } = phone();

    const fresh = nearestParks({ origin: CITY_HALL, index, state, capacity, count: 10 });
    assert.ok(!fresh.some((r) => r.id === 8101), 'a park already in the binder is not offered');
    assert.equal(fresh.length, PARKS.length - 1);

    const all = nearestParks({ origin: CITY_HALL, index, state, capacity, count: 10, includeCollected: true });
    assert.equal(all.length, PARKS.length);
    assert.equal(all[0].id, 8101, 'and it is the nearest, flagged as collected');
    assert.equal(all[0].collected, true);
  });

  test('"collected" means this season', () => {
    const { claim } = collect(8101);
    const other = db.prepare('SELECT id FROM seasons WHERE id != ? LIMIT 1').get(claim.season.id).id;
    db.prepare('UPDATE claims SET season_id = ? WHERE id = ?').run(other, claim.claim_id);

    const { index, state, capacity } = phone();
    const rows = nearestParks({ origin: CITY_HALL, index, state, capacity, count: 10 });
    assert.ok(rows.some((r) => r.id === 8101), 'last season’s card does not hide this season’s park');
  });

  test('the index is the parks table, in the shape the phone reads', () => {
    const rows = parkIndexRows(db);
    assert.equal(rows.length, PARKS.length);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['h', 'i', 'la', 'ln', 'n']);
  });
});

// ── the scoring flag ──────────────────────────────────────────────────────
describe('the XP only flag agrees with evaluateCollect', () => {
  // If these two ever disagree, the list is lying — worse than not showing it.
  for (const cap of [0, 45, 30]) {
    test(`with a park cap of ${cap || 'none'}`, () => {
      withConfig({ PARK_HOOD_CAP: cap }, () => {
        collect(8102);                       // 30 points into Hood 13
        const { index, state, capacity } = phone();
        const rows = nearestParks({ origin: CITY_HALL, index, state, capacity, count: 10 });
        assert.ok(rows.length >= 4);
        for (const row of rows) {
          const ev = parks.evaluateCollect({ parkId: row.id, playerId: alice });
          assert.equal(row.award, ev.points, `${row.name}: the list says +${row.award}, the server says +${ev.points}`);
          assert.equal(row.xp_only, ev.capacity.xp_only, `${row.name}: XP only disagrees`);
        }
        if (cap === 30) {
          assert.ok(rows.filter((r) => r.hood_id === 13).every((r) => r.xp_only), 'Hood 13 is spent');
          assert.ok(rows.filter((r) => r.hood_id !== 13).every((r) => !r.xp_only), 'and nowhere else is');
        }
      });
    });
  }

  test('the award is the server’s min()', () => {
    assert.equal(awardFor(30, null), 30);
    assert.equal(awardFor(30, 12), 12);
    assert.equal(awardFor(30, 0), 0);
  });
});

// ── when location fails ───────────────────────────────────────────────────
describe('when location fails', () => {
  const cases = [
    [{ code: 1 }, {}, 'denied'],
    [{ code: 2 }, {}, 'unavailable'],
    [{ code: 3 }, {}, 'timeout'],
    [{ code: 'insecure' }, { secure: false }, 'insecure'],
    [null, { supported: false }, 'unsupported'],
  ];

  test('every failure explains itself and falls back to the Hood picker', () => {
    const seen = new Set();
    for (const [error, context, code] of cases) {
      const f = locateFailure(error, context);
      assert.equal(f.code, code);
      assert.ok(f.title && f.message, `${code} needs words`);
      assert.equal(f.fallback, 'hood-picker', `${code} must not be a dead end`);
      seen.add(f.code);
    }
    assert.equal(seen.size, cases.length);
  });

  test('a denial says how to turn it back on', () => {
    assert.match(locateFailure({ code: 1 }).message, /Settings/);
    assert.match(locateFailure({ code: 3 }).message, /try again/i);
  });

  test('one fix, high accuracy, as the spec asks', () => {
    assert.deepEqual({ ...LOCATE_OPTIONS }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  });

  test('directions hand off to the phone’s own maps app', () => {
    const park = { lat: 43.65, lng: -79.38, name: 'Bay Green' };
    assert.match(directionsUrl(park, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)'), /^https:\/\/maps\.apple\.com\//);
    assert.match(directionsUrl(park, 'Mozilla/5.0 (Linux; Android 15)'), /^geo:43\.65,-79\.38/);
    assert.match(directionsUrl(park, 'Mozilla/5.0 (Windows NT 10.0)'), /google\.com\/maps\/dir/);
  });

  test('the permission is only ever asked for by a tap, never on load', () => {
    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    for (const file of ['web/src/main.jsx', 'web/src/App.jsx', 'web/src/lib/store.jsx']) {
      assert.ok(!/geolocation|getFix|watchFix/.test(read(file)), `${file} must not touch location`);
    }
    const map = read('web/src/screens/MapScreen.jsx');
    assert.match(map, /const \[tracking, setTracking\] = useState\(false\);/, 'the dot starts off');
    assert.match(map, /if \(!map \|\| !tracking\) return undefined;/, 'and the watch starts only once it is on');
    // One fix, only from the components a tap mounts: Find a Park, and the park hunt picker.
    const callers = [
      'web/src/components/FindPark.jsx', 'web/src/components/HuntParkPicker.jsx',
      'web/src/screens/MapScreen.jsx', 'web/src/screens/Hunts.jsx',
    ].filter((f) => /\bgetFix\(/.test(read(f)));
    assert.deepEqual(callers, ['web/src/components/FindPark.jsx', 'web/src/components/HuntParkPicker.jsx']);
    const hunts = read('web/src/screens/Hunts.jsx');
    assert.match(hunts, /const \[picking, setPicking\] = useState\(false\);/, 'the picker opens on a tap');
  });
});

// ── the privacy guarantee ─────────────────────────────────────────────────
describe('a location never leaves the phone', () => {
  const fakeRes = () => ({
    code: 200, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  });

  test('the API refuses any request carrying a coordinate', () => {
    const cases = [
      { query: { lat: '43.6' }, body: {} },
      { query: {}, body: { lng: -79.4 } },
      { query: {}, body: { where: { coords: [1, 2] } } },
      { query: {}, body: { fix: { Latitude: 43 } } },
    ];
    for (const req of cases) {
      const res = fakeRes();
      let passed = false;
      privacy.refuseCoordinates(req, res, () => { passed = true; });
      assert.equal(passed, false, JSON.stringify(req));
      assert.equal(res.code, 400);
      assert.equal(res.body.error, 'COORDINATES_REFUSED');
    }
    let passed = false;
    privacy.refuseCoordinates({ query: { season: '1' }, body: { caption: 'at the lake' } }, fakeRes(), () => { passed = true; });
    assert.equal(passed, true, 'an ordinary request goes straight through');
  });

  test('no server route reads a coordinate from a request', () => {
    const dir = path.join(ROOT, 'server', 'routes');
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.ok(!/req\.(query|body|params)\??\.(lat|lng|lon|latitude|longitude|coords|accuracy)\b/.test(src),
        `server/routes/${file} reads a coordinate from a request`);
    }
  });

  test('the client’s location code never talks to the network', () => {
    for (const file of ['web/src/lib/location.js', 'web/src/lib/nearby.js']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|from '\.\/api\.js'/.test(src),
        `${file} must not reach the network`);
    }
    const api = fs.readFileSync(path.join(ROOT, 'web/src/lib/api.js'), 'utf8');
    assert.ok(!/\b(lat|lng|latitude|longitude|coords)\b/.test(api), 'and no API call takes a position');
  });
});
