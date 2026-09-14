#!/usr/bin/env node
// Writes web/public/parks.index.json: every park's id, name, Hood and position, for Find a
// Park to search on the phone.
//
//   node scripts/build-park-index.js
//
// Generated from the parks table — the same data the import put there — so the index
// cannot drift from the game. import-parks.js runs it after every import. Committed, like
// hoods.min.geojson, because the app should not need anyone to run a script to work.
//
// Short keys because there are 1,513 of them: {"i":412,"n":"Trinity Bellwoods Park",
// "h":9,"la":43.6469,"ln":-79.4131}. Five decimal places is about a metre, which is more
// than a park sign needs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PARK_INDEX_PATH = path.join(ROOT, 'web', 'public', 'parks.index.json');

const round5 = (n) => Math.round(n * 1e5) / 1e5;

/** The index rows, in id order. Pure over a database handle, so tests can use it. */
export function parkIndexRows(db) {
  return db.prepare('SELECT id, name, hood_id, lat, lng FROM parks ORDER BY id').all()
    .map((p) => ({ i: p.id, n: p.name, h: p.hood_id, la: round5(p.lat), ln: round5(p.lng) }));
}

export function buildParkIndex(db, out = PARK_INDEX_PATH) {
  const rows = parkIndexRows(db);
  fs.writeFileSync(out, `${JSON.stringify(rows)}\n`);
  return rows.length;
}

// Run directly: read the configured database without running the server's migrations.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { default: Database } = await import('better-sqlite3');
  const { config } = await import('../server/config.js');
  const db = new Database(config.dbPath, { readonly: true });
  const n = buildParkIndex(db);
  const kb = (fs.statSync(PARK_INDEX_PATH).size / 1024).toFixed(0);
  console.log(`[park-index] ${n} parks → ${path.relative(ROOT, PARK_INDEX_PATH)} (${kb} kB)`);
  db.close();
}
