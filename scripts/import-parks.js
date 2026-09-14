#!/usr/bin/env node
// Fetch Toronto's parks from Open Data and file each one under the Hood it sits in.
//
//   node scripts/import-parks.js [--file <path>] [--hoods <path>]
//
//   --file   use a local copy of the parks GeoJSON instead of fetching
//   --hoods  ward boundaries to assign against (default: web/public/hoods.min.geojson)
//
// The parks game needs three things per park: a name (it is on the sign, which is what you
// photograph), a location, and the Hood it belongs to. The city's
// `parks-and-recreation-facilities` dataset gives the first two directly; the third comes
// from a point-in-polygon test against the ward boundaries.
//
// Only TYPE = 'Park' is imported. The same dataset carries 277 community centres and
// 6 civic centres, and those do not have the green park sign with the name on it — which
// is the whole premise of the sub-game.
//
// Data: City of Toronto Open Data, `parks-and-recreation-facilities`, Open Government
// Licence – Toronto. Attributed in the app footer alongside the ward boundaries.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import pipMod from '@turf/boolean-point-in-polygon';
import { db } from '../server/db.js';
import { ROOT } from '../server/config.js';
import { haversineKm, CITY_CENTRE } from './lib/difficulty.js';

const pointInPolygon = pipMod.default ?? pipMod;

const CKAN = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show'
  + '?id=parks-and-recreation-facilities';

export const MIN_PARK_VALUE = 5;
export const MAX_PARK_VALUE = 100;

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function fetchParks() {
  const local = flag('--file');
  if (local) {
    console.log(`[parks] reading ${local}`);
    return JSON.parse(await fsp.readFile(local, 'utf8'));
  }
  console.log('[parks] asking CKAN which resources exist…');
  const pkg = await getJson(CKAN);
  const geo = (pkg?.result?.resources ?? []).filter((r) => /geojson/i.test(r.format ?? ''));
  // The 4326 resource is already WGS84. The datastore dump is the same data but the
  // 2952 variant is projected, and there is no reason to reproject when a lat/lng copy
  // is published right beside it.
  const pick = geo.find((r) => /4326/.test(r.name ?? '')) ?? geo[0];
  if (!pick) throw new Error('No GeoJSON resource in parks-and-recreation-facilities');
  console.log(`[parks] downloading "${pick.name}"`);
  return getJson(pick.url);
}

/** MultiPoint, Point, or a degenerate polygon — return one representative lat/lng. */
function coordsOf(geometry) {
  let c = geometry?.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) && Number.isFinite(c[0]) ? { lng: c[0], lat: c[1] } : null;
}

/**
 * Title-case the city's SHOUTING names: "ERINGATE PARK" -> "Eringate Park".
 * Keeps the small words small, and leaves anything with digits or an apostrophe-S
 * alone enough to stay readable on a card.
 */
function titleCase(raw) {
  const small = new Set(['of', 'the', 'and', 'at', 'on', 'in', 'de', 'la']);
  return String(raw).toLowerCase().split(/(\s+|-)/).map((word, i) => {
    if (/^\s+$/.test(word) || word === '-') return word;
    if (i > 0 && small.has(word)) return word;
    return word.replace(/^[a-z]/, (c) => c.toUpperCase())
      // McCowan, O'Connor
      .replace(/^(mc|o')([a-z])/i, (_, p, c) => p.replace(/^m/, 'M') + c.toUpperCase());
  }).join('');
}

async function main() {
  const raw = await fetchParks();
  if (raw?.type !== 'FeatureCollection') throw new Error('That file is not a FeatureCollection');

  const hoodsPath = flag('--hoods', path.join(ROOT, 'web', 'public', 'hoods.min.geojson'));
  if (!fs.existsSync(hoodsPath)) {
    throw new Error(`No ward boundaries at ${hoodsPath}. Run npm run import-hoods first.`);
  }
  const hoods = JSON.parse(await fsp.readFile(hoodsPath, 'utf8')).features;
  console.log(`[parks] assigning against ${hoods.length} Hood boundaries`);

  const parks = [];
  let skipped = 0;
  let nearest = 0;

  for (const f of raw.features) {
    if ((f.properties?.TYPE ?? '') !== 'Park') continue;
    const at = coordsOf(f.geometry);
    const name = String(f.properties.ASSET_NAME ?? '').trim();
    const id = Number(f.properties.ASSET_ID);
    if (!at || !name || !Number.isFinite(id)) { skipped++; continue; }

    // Point-in-polygon against the wards. A handful of parks sit a metre outside every
    // boundary — a spit, an island, or simplification error — so those fall back to the
    // nearest Hood centroid rather than being dropped from the game.
    let hood = hoods.find((h) => pointInPolygon([at.lng, at.lat], h));
    if (!hood) {
      nearest++;
      hood = hoods.reduce((best, h) => {
        const d = haversineKm(at, { lat: h.properties.lat, lng: h.properties.lng });
        return !best || d < best.d ? { h, d } : best;
      }, null).h;
    }

    parks.push({
      id,
      name: titleCase(name),
      hood_id: hood.properties.id,
      lat: Math.round(at.lat * 1e6) / 1e6,
      lng: Math.round(at.lng * 1e6) / 1e6,
      address: f.properties.ADDRESS ? String(f.properties.ADDRESS).trim() : null,
      amenities: f.properties.AMENITIES ? String(f.properties.AMENITIES).trim() : null,
      url: f.properties.URL ? String(f.properties.URL).trim() : null,
      distance_km: Math.round(haversineKm(CITY_CENTRE, at) * 100) / 100,
    });
  }

  if (!parks.length) throw new Error('No parks survived filtering — check the source dataset');

  // Value: 5-100, purely by distance from the city centre, normalised across every park
  // so both ends of the range are actually used. No isolation term, unlike a Hood's
  // difficulty — a park is somewhere you go, not something you hold against anyone.
  const distances = parks.map((p) => p.distance_km);
  const lo = Math.min(...distances);
  const hi = Math.max(...distances);
  const span = MAX_PARK_VALUE - MIN_PARK_VALUE;
  for (const p of parks) {
    const t = hi === lo ? 0 : (p.distance_km - lo) / (hi - lo);
    p.value = Math.round(MIN_PARK_VALUE + t * span);
  }

  // Set numbers, alphabetical. A collectable needs a number on it, and alphabetical
  // is both stable and how a real set index reads.
  const ordered = [...parks].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  ordered.forEach((p, i) => { p.set_number = i + 1; });

  const write = db.transaction(() => {
    const ins = db.prepare(`
      INSERT INTO parks (id, name, hood_id, lat, lng, address, amenities, url, value,
                         distance_km, set_number)
      VALUES (@id, @name, @hood_id, @lat, @lng, @address, @amenities, @url, @value,
              @distance_km, @set_number)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                                    hood_id = excluded.hood_id,
                                    lat = excluded.lat,
                                    lng = excluded.lng,
                                    address = excluded.address,
                                    amenities = excluded.amenities,
                                    url = excluded.url,
                                    value = excluded.value,
                                    distance_km = excluded.distance_km,
                                    set_number = excluded.set_number`);
    for (const p of parks) ins.run(p);
  });
  write();

  const perHood = db.prepare(
    'SELECT hood_id, COUNT(*) AS n FROM parks GROUP BY hood_id ORDER BY hood_id').all();
  const counts = perHood.map((r) => r.n);
  const values = parks.map((p) => p.value);

  console.log(`[parks] ${parks.length} parks imported`
    + (skipped ? `, ${skipped} skipped for missing name/location` : '')
    + (nearest ? `, ${nearest} placed by nearest Hood` : ''));
  console.log(`[parks] value ${Math.min(...values)}-${Math.max(...values)}`
    + `, ${lo.toFixed(1)}-${hi.toFixed(1)} km from Nathan Phillips Square`);
  console.log(`[parks] per Hood: min ${Math.min(...counts)}, max ${Math.max(...counts)},`
    + ` mean ${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1)}`);

  const richest = parks.reduce((a, b) => (b.value > a.value ? b : a));
  const closest = parks.reduce((a, b) => (b.value < a.value ? b : a));
  console.log(`[parks] most valuable: ${richest.name} (Hood ${richest.hood_id}) = ${richest.value}`);
  console.log(`[parks] least valuable: ${closest.name} (Hood ${closest.hood_id}) = ${closest.value}`);

  // Find a Park searches a static index on the phone. Rebuilt from what was just written,
  // so it can never describe a different set of parks than the game has.
  const { buildParkIndex } = await import('./build-park-index.js');
  console.log(`[parks] ${buildParkIndex(db)} parks written to web/public/parks.index.json`);

  // Park hunts draw from each park's amenities. They came in on the same records, keyed by
  // the same ASSET_ID, so they are rebuilt from what was just written.
  const { rebuildAmenitiesFromParks } = await import('../server/lib/amenities.js');
  const amenities = rebuildAmenitiesFromParks(db);
  console.log(`[parks] ${amenities.rows} amenities recorded across ${amenities.parks} parks, for park hunts`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('[parks] failed:', err.message);
  process.exit(1);
});
