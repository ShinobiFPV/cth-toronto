#!/usr/bin/env node
// Fetch the 25 Hood boundaries from City of Toronto Open Data and build the map layer.
//
//   node scripts/import-hoods.js [--file <path>] [--tolerance 0.0001] [--seed]
//
//   --file        use a local GeoJSON instead of fetching (offline / a pinned copy)
//   --tolerance   turf simplify tolerance in degrees (default 0.0001, ~8 m)
//   --seed        also rewrite server/lib/hood-seed.js from the fetched data
//
// Claims are not geofenced — the boundaries are presentation only (spec §3) — but
// they still have to be right enough that nobody is confused about which Hood they
// are standing in. The raw file is over a megabyte, which hurts on mobile data, so
// what ships to the client is simplified and stripped of the city's 20 metadata
// columns.
//
// Data: City of Toronto Open Data, dataset `city-wards` (25-ward 2018 boundaries),
// Open Government Licence – Toronto. Attributed in the app footer.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import simplifyMod from '@turf/simplify';
import centroidMod from '@turf/centroid';
import { db } from '../server/db.js';
import { config, ROOT } from '../server/config.js';
import { reprojectToWgs84, detectCrs } from './lib/reproject.js';

const simplify = simplifyMod.default ?? simplifyMod;
const centroid = centroidMod.default ?? centroidMod;

const CKAN = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=city-wards';
const OUT = path.join(ROOT, 'web', 'public', 'hoods.min.geojson');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(name);

const tolerance = Number(flag('--tolerance', '0.0001'));

async function fetchGeoJson() {
  const local = flag('--file');
  if (local) {
    console.log(`[hoods] reading ${local}`);
    return JSON.parse(await fsp.readFile(local, 'utf8'));
  }

  console.log('[hoods] asking CKAN which resources exist…');
  const pkg = await getJson(CKAN);
  const resources = pkg?.result?.resources ?? [];
  if (!resources.length) throw new Error('CKAN returned no resources for city-wards');

  // Prefer an explicitly WGS84 (EPSG:4326) GeoJSON. The dataset also ships the same
  // geometry in MTM and UTM, which we can reproject but would rather not have to.
  const geo = resources.filter((r) => /geojson/i.test(r.format ?? ''));
  const pick = geo.find((r) => /4326/.test(r.name ?? '') || /4326/.test(r.url ?? ''))
    ?? geo.find((r) => r.datastore_active === false)
    ?? geo[0];
  if (!pick) throw new Error('No GeoJSON resource in the city-wards dataset');

  console.log(`[hoods] downloading "${pick.name}"`);
  return getJson(pick.url);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

function wardNumber(props) {
  const raw = props.AREA_SHORT_CODE ?? props.AREA_LONG_CODE ?? props.WARD ?? props.ward;
  const n = parseInt(String(raw ?? '').replace(/\D/g, ''), 10);
  if (Number.isFinite(n) && n >= 1 && n <= 25) return n;
  // Fall back to the number in "Toronto Centre (13)".
  const m = /\((\d{1,2})\)\s*$/.exec(String(props.AREA_DESC ?? ''));
  return m ? Number(m[1]) : null;
}

const wardName = (props) =>
  String(props.AREA_NAME ?? props.AREA_DESC ?? '').replace(/\s*\(\d+\)\s*$/, '').trim();

async function main() {
  const raw = await fetchGeoJson();
  if (raw?.type !== 'FeatureCollection' || !Array.isArray(raw.features)) {
    throw new Error('That file is not a GeoJSON FeatureCollection');
  }

  const crs = detectCrs(raw);
  const collection = crs === 'wgs84' ? raw : reprojectToWgs84(raw, crs);
  if (crs !== 'wgs84') console.log(`[hoods] reprojected from ${crs} to EPSG:4326`);

  // Adjacency, computed from the unsimplified geometry. simplify() moves vertices, which
  // would break the exact-match test below, so this has to happen first.
  const adjacency = computeAdjacency(collection);

  const features = [];
  for (const f of collection.features) {
    const id = wardNumber(f.properties ?? {});
    const name = wardName(f.properties ?? {});
    if (!id || !name) {
      console.warn('[hoods] skipping a feature with no usable ward number/name');
      continue;
    }
    const [lng, lat] = centroid(f).geometry.coordinates;
    const simplified = simplify(
      { type: 'Feature', properties: {}, geometry: f.geometry },
      { tolerance, highQuality: true, mutate: false },
    );
    features.push({
      type: 'Feature',
      properties: { id, name, lat: round(lat), lng: round(lng), neighbours: adjacency.get(id) ?? [] },
      geometry: roundGeometry(simplified.geometry),
    });
  }

  features.sort((a, b) => a.properties.id - b.properties.id);
  if (features.length !== 25) {
    console.warn(`[hoods] expected 25 Hoods, got ${features.length} — check the source dataset`);
  }

  const out = {
    type: 'FeatureCollection',
    name: 'Capture the Hood — Toronto Hoods',
    attribution: 'Contains information licensed under the Open Government Licence – Toronto.',
    source: 'City of Toronto Open Data, dataset city-wards (25-ward model, 2018)',
    generated_at: new Date().toISOString(),
    features,
  };

  await fsp.mkdir(path.dirname(OUT), { recursive: true });
  await fsp.writeFile(OUT, JSON.stringify(out));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`[hoods] wrote ${OUT} — ${features.length} Hoods, ${kb} kB (tolerance ${tolerance})`);

  // Names and centroids into the DB. unclaimed_value and ever_conquered are game
  // state and are never touched here, so this is safe to re-run mid-season.
  const upsert = db.transaction(() => {
    const ins = db.prepare(`
      INSERT INTO hoods (id, name, centroid_lat, centroid_lng, ever_conquered, unclaimed_value)
      VALUES (?, ?, ?, ?, 0, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                                    centroid_lat = excluded.centroid_lat,
                                    centroid_lng = excluded.centroid_lng`);
    const state = db.prepare('INSERT INTO hood_state (hood_id) VALUES (?) ON CONFLICT DO NOTHING');
    for (const f of features) {
      const p = f.properties;
      ins.run(p.id, p.name, p.lat, p.lng, config.BASE_UNCLAIMED_VALUE);
      state.run(p.id);
    }

    // Replace the adjacency wholesale: a boundary revision could remove an edge, and a
    // stale edge would keep blocking conquers that ought to be legal.
    db.prepare('DELETE FROM hood_neighbours').run();
    const edge = db.prepare(
      'INSERT INTO hood_neighbours (hood_id, neighbour_id) VALUES (?, ?) ON CONFLICT DO NOTHING');
    for (const f of features) {
      for (const n of f.properties.neighbours) edge.run(f.properties.id, n);
    }
  });
  upsert();
  const edges = features.reduce((n, f) => n + f.properties.neighbours.length, 0);
  console.log(`[hoods] database updated (${config.dbPath}) — ${edges} adjacency edges`);

  if (has('--seed')) {
    const seedPath = path.join(ROOT, 'server', 'lib', 'hood-seed.js');
    const body = features.map((f) => {
      const p = f.properties;
      return `  { id: ${String(p.id).padStart(2, ' ')}, name: ${JSON.stringify(p.name)}, lat: ${p.lat}, lng: ${p.lng} },`;
    }).join('\n');
    const neighbourBody = features.map((f) =>
      `  ${String(f.properties.id).padStart(2, ' ')}: [${f.properties.neighbours.join(', ')}],`,
    ).join('\n');

    const src = await fsp.readFile(seedPath, 'utf8');
    const next = src
      .replace(/export const HOOD_SEED = \[[\s\S]*?\n\];/,
        `export const HOOD_SEED = [\n${body}\n];`)
      .replace(/export const NEIGHBOUR_SEED = \{[\s\S]*?\n\};/,
        `export const NEIGHBOUR_SEED = {\n${neighbourBody}\n};`);

    if (!next.includes('NEIGHBOUR_SEED = {')) {
      throw new Error('hood-seed.js has no NEIGHBOUR_SEED block to rewrite');
    }
    await fsp.writeFile(seedPath, next);
    console.log(`[hoods] rewrote ${seedPath} (names, centroids and adjacency)`);
  }
}

/**
 * Which Hoods border which, as id -> sorted ids.
 *
 * The city publishes a proper topological coverage, so adjacent wards share exact
 * vertices — no tolerance, no buffering, no floating-point guesswork. Two Hoods count as
 * neighbours when they share at least TWO vertices: one alone is a pair meeting at a
 * single corner, which is not a shared border and should not close a Hood off.
 *
 * Verified against the real geography: Toronto Centre borders 10, 11 and 14;
 * Rouge Park borders 23 and 24; the graph is symmetric with no isolated Hoods.
 */
function computeAdjacency(collection) {
  const vertexSets = new Map();
  for (const f of collection.features) {
    const id = wardNumber(f.properties ?? {});
    if (!id || !f.geometry) continue;
    const set = new Set();
    const walk = (c) => (typeof c[0] === 'number'
      ? set.add(`${c[0].toFixed(7)},${c[1].toFixed(7)}`)
      : c.forEach(walk));
    walk(f.geometry.coordinates);
    vertexSets.set(id, set);
  }

  const ids = [...vertexSets.keys()].sort((a, b) => a - b);
  const adjacency = new Map(ids.map((id) => [id, []]));

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = vertexSets.get(ids[i]);
      const b = vertexSets.get(ids[j]);
      let shared = 0;
      for (const v of a) {
        if (b.has(v) && ++shared === 2) break;
      }
      if (shared >= 2) {
        adjacency.get(ids[i]).push(ids[j]);
        adjacency.get(ids[j]).push(ids[i]);
      }
    }
  }

  const isolated = ids.filter((id) => adjacency.get(id).length === 0);
  if (isolated.length) {
    console.warn(`[hoods] these Hoods came out with no neighbours, which is almost certainly wrong: ${isolated.join(', ')}`);
  }
  for (const id of ids) adjacency.get(id).sort((x, y) => x - y);
  return adjacency;
}

const round = (n) => Math.round(n * 1e5) / 1e5;   // ~1 m, well under the simplify error

function roundGeometry(geom) {
  const walk = (c) => (typeof c[0] === 'number' ? [round(c[0]), round(c[1])] : c.map(walk));
  return { type: geom.type, coordinates: walk(geom.coordinates) };
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('[hoods] failed:', err.message);
  process.exit(1);
});
