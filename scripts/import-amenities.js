#!/usr/bin/env node
// Refresh which parks have which amenities, for Scavenger Blitz park hunts.
//
//   node scripts/import-amenities.js                 # fetch the city's records and match them
//   node scripts/import-amenities.js --file <path>   # a local copy of the GeoJSON instead
//   node scripts/import-amenities.js --from-db       # rebuild from parks.amenities, no network
//
// Source: City of Toronto Open Data, `parks-and-recreation-facilities` — the same records the
// parks themselves came from. Park hunts are built from this, never from a model's guess:
// asked to invent items from a park's name, a model will put a splash pad in a parkette that
// is a bench and two trees, and a child gets sent to look for something that is not there.
//
// Matching. A record matches a park by ASSET_ID first — the parks table's id is the city's
// ASSET_ID, so almost everything lands there. What does not falls back to name plus
// proximity (same normalised name within 300 m), never name alone: Toronto has several
// parks with near-identical names. What still does not match is logged, and written to
// build/amenities-unmatched.json to be resolved by hand, rather than silently dropped —
// an unmatched park quietly becomes one that can only ever generate generic hunts. A park
// with no amenity record still works; its hunts draw from the universal pool.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db } from '../server/db.js';
import { ROOT } from '../server/config.js';
import { amenitySlugs, rebuildAmenitiesFromParks } from '../server/lib/amenities.js';
import { haversineKm } from './lib/difficulty.js';

const CKAN = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show'
  + '?id=parks-and-recreation-facilities';
const NEAR_KM = 0.3;

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function fetchFacilities() {
  const local = flag('--file');
  if (local) return JSON.parse(await fsp.readFile(local, 'utf8'));
  const pkg = await getJson(CKAN);
  const geo = (pkg?.result?.resources ?? []).filter((r) => /geojson/i.test(r.format ?? ''));
  const pick = geo.find((r) => /4326/.test(r.name ?? '')) ?? geo[0];
  if (!pick) throw new Error('No GeoJSON resource in parks-and-recreation-facilities');
  console.log(`[amenities] downloading "${pick.name}"`);
  return getJson(pick.url);
}

function coordsOf(geometry) {
  let c = geometry?.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) && Number.isFinite(c[0]) ? { lng: c[0], lat: c[1] } : null;
}

/** "EDWARDS GARDENS" and "Edwards Gardens Park" are the same name here. */
const normaliseName = (name) => String(name ?? '').toLowerCase()
  .replace(/\b(park|parkette|parkland|gardens?|square|green|playground|the)\b/g, '')
  .replace(/[^a-z0-9]+/g, '');

async function main() {
  if (args.includes('--from-db')) {
    const r = rebuildAmenitiesFromParks(db);
    console.log(`[amenities] ${r.rows} amenities across ${r.parks} parks, rebuilt from the parks table`);
    return;
  }

  const raw = await fetchFacilities();
  if (raw?.type !== 'FeatureCollection') throw new Error('That is not a FeatureCollection');

  const parks = db.prepare('SELECT id, name, lat, lng FROM parks').all();
  const byId = new Map(parks.map((p) => [p.id, p]));
  const matched = new Map();
  const unmatched = [];
  let viaId = 0;
  let viaName = 0;

  for (const f of raw.features) {
    const props = f.properties ?? {};
    const text = props.AMENITIES ? String(props.AMENITIES).trim() : '';
    if (!amenitySlugs(text).length) continue;
    const id = Number(props.ASSET_ID);
    const name = String(props.ASSET_NAME ?? '').trim();
    const at = coordsOf(f.geometry);

    let park = byId.get(id) ?? null;
    if (park) {
      viaId += 1;
    } else if (at) {
      const key = normaliseName(name);
      park = key ? parks.find((p) => normaliseName(p.name) === key && haversineKm(at, p) <= NEAR_KM) ?? null : null;
      if (park) viaName += 1;
    }

    if (!park) {
      // Community and civic centres are not parks in this game, so only a park is a miss.
      if ((props.TYPE ?? '') === 'Park') {
        unmatched.push({ asset_id: id, name, lat: at?.lat ?? null, lng: at?.lng ?? null, amenities: text });
      }
      continue;
    }
    matched.set(park.id, text);
  }

  db.transaction(() => {
    const set = db.prepare('UPDATE parks SET amenities = ? WHERE id = ?');
    for (const [parkId, text] of matched) set.run(text, parkId);
  })();
  const rebuilt = rebuildAmenitiesFromParks(db);

  console.log(`[amenities] ${matched.size} parks matched: ${viaId} by ASSET_ID, ${viaName} by name and proximity`);
  console.log(`[amenities] ${rebuilt.rows} amenities recorded across ${rebuilt.parks} parks`);
  console.log(`[amenities] ${parks.length - rebuilt.parks} parks have no amenity on record — their hunts draw from the universal pool`);

  if (unmatched.length) {
    const out = path.join(ROOT, 'build', 'amenities-unmatched.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(unmatched, null, 2)}\n`);
    console.log(`[amenities] ${unmatched.length} park records matched nothing — listed in ${path.relative(ROOT, out)}:`);
    for (const u of unmatched.slice(0, 15)) console.log(`    #${u.asset_id} ${u.name}`);
    if (unmatched.length > 15) console.log(`    …and ${unmatched.length - 15} more`);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('[amenities] failed:', err.message);
  process.exit(1);
});
