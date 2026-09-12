// SQLite handle + first-run seeding. better-sqlite3 is synchronous, which for six
// players is a feature: every claim is one transaction with no interleaving.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config, ROOT } from './config.js';
import { HOOD_SEED, NEIGHBOUR_SEED } from './lib/hood-seed.js';
import { SEASON_SEED } from './lib/season-seed.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8'));

// ── Seeding ───────────────────────────────────────────────────────────────
// The 25 Hoods and the four seasons are facts about the game, not user data, so
// they are seeded on first run. `scripts/import-hoods.js` later overwrites the
// names and centroids from the City of Toronto open-data file; the seed just means
// a fresh checkout has a playable database before anyone downloads 1 MB of GeoJSON.

const seedHoods = db.transaction(() => {
  const insert = db.prepare(`
    INSERT INTO hoods (id, name, centroid_lat, centroid_lng, ever_conquered, unclaimed_value)
    VALUES (?, ?, ?, ?, 0, ?)
    ON CONFLICT(id) DO NOTHING`);
  const state = db.prepare('INSERT INTO hood_state (hood_id) VALUES (?) ON CONFLICT DO NOTHING');
  for (const h of HOOD_SEED) {
    insert.run(h.id, h.name, h.lat, h.lng, config.BASE_UNCLAIMED_VALUE);
    state.run(h.id);
  }

  const edge = db.prepare(
    'INSERT INTO hood_neighbours (hood_id, neighbour_id) VALUES (?, ?) ON CONFLICT DO NOTHING');
  for (const [id, neighbours] of Object.entries(NEIGHBOUR_SEED)) {
    for (const n of neighbours) edge.run(Number(id), n);
  }
});

const seedSeasons = db.transaction(() => {
  const insert = db.prepare(`
    INSERT INTO seasons (id, name, starts_at, ends_at, escalation_applied)
    VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(id) DO NOTHING`);
  for (const s of SEASON_SEED) insert.run(s.id, s.name, s.starts_at, s.ends_at);
});

seedHoods();
seedSeasons();

export const nowIso = () => new Date().toISOString();
export const isoPlusHours = (iso, hours) =>
  new Date(new Date(iso).getTime() + hours * 3600_000).toISOString();

export default db;
