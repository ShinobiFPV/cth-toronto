// SQLite handle, migrations, first-run seeding. better-sqlite3 is synchronous, which
// for six players is a feature: every claim is one transaction with no interleaving.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config, ROOT } from './config.js';
import { HOOD_SEED, NEIGHBOUR_SEED, DIFFICULTY_SEED } from './lib/hood-seed.js';
import { SEASON_SEED } from './lib/season-seed.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8'));

// ── Migrations ────────────────────────────────────────────────────────────
// CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so columns
// added after a database went live need adding explicitly. Keep these append-only and
// idempotent: a deploy runs them against a database with real claims in it.

const columns = (table) => new Set(db.pragma(`table_info(${table})`).map((c) => c.name));

const addColumn = (table, name, definition) => {
  if (columns(table).has(name)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  console.log(`[cth] migrated: ${table}.${name} added`);
  return true;
};

const migrations = db.transaction(() => {
  // The difficulty score (5-50) and the seasonal escalation counter behind it.
  const addedDifficulty = addColumn('hoods', 'difficulty', 'INTEGER NOT NULL DEFAULT 25');
  addColumn('hoods', 'escalations', 'INTEGER NOT NULL DEFAULT 0');

  // Parkemans GO rides in the claims ledger, so park collections need two columns there.
  addColumn('claims', 'park_id', 'INTEGER REFERENCES parks(id)');
  addColumn('claims', 'card_seed', 'TEXT');
  addColumn('parks', 'set_number', 'INTEGER');

  // Captions. On `photos` rather than `claims` because they are editable and the ledger
  // is not; null means "not captioned", which is what every pre-existing photo is.
  addColumn('photos', 'caption', 'TEXT');

  // Special editions. Null means a standard card, which is what every card collected
  // before this existed is.
  addColumn('claims', 'edition', 'TEXT');

  // XP and levels.
  const addedXp = addColumn('claims', 'xp_awarded', 'INTEGER NOT NULL DEFAULT 0');

  if (addedXp) {
    // Backfill so nobody's history is worth nothing. Derived from what each claim was,
    // using the same schedule as a fresh claim — minus the discovery bonuses, which
    // depend on ordering this migration cannot reconstruct cheaply and which would
    // only ever inflate the result.
    db.exec(`
      UPDATE claims SET xp_awarded = CASE claim_kind
        WHEN 'conquer'   THEN 50
        WHEN 'steal'     THEN 70
        WHEN 'reinforce' THEN 20
        WHEN 'park'      THEN 10
        ELSE 0 END
      WHERE xp_awarded = 0 AND claim_kind IS NOT NULL`);
    const n = db.prepare('SELECT COUNT(*) AS c FROM claims WHERE xp_awarded > 0').get().c;
    if (n) console.log(`[cth] migrated: XP backfilled onto ${n} existing claims`);
  }

  if (addedDifficulty) {
    // Backfill from the seed, then work out how many escalations each Hood had already
    // banked under the old flat-25 scheme so nobody silently loses value they had
    // accrued: whatever unclaimed_value was above 25 came from rollovers.
    const set = db.prepare('UPDATE hoods SET difficulty = ?, escalations = ? WHERE id = ?');
    for (const row of db.prepare('SELECT id, unclaimed_value FROM hoods').all()) {
      const banked = Math.max(0,
        Math.round((row.unclaimed_value - config.BASE_UNCLAIMED_VALUE) / config.ESCALATION_STEP));
      set.run(DIFFICULTY_SEED[row.id] ?? config.BASE_UNCLAIMED_VALUE, banked, row.id);
    }
    console.log('[cth] migrated: difficulty scores backfilled from the seed');
  }
});
migrations();

/**
 * Indexes that reference migrated columns. These have to run after migrations(), which
 * is why they are not in schema.sql: that file executes first, and on a database created
 * before a column existed it cannot index it.
 */
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_claims_park ON claims(park_id, player_id, season_id);

  -- The hologram cap is checked on every park collection, so it gets an index. Partial,
  -- because it only ever asks about one edition.
  CREATE INDEX IF NOT EXISTS idx_claims_holo ON claims(hood_id, season_id)
    WHERE edition = 'hologram' AND status != 'reverted';

  -- One collection per player per park per season. Partial so it governs only park rows,
  -- and excludes reverted ones so a claim the group threw out frees the park up again.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_park_once_per_season
    ON claims(player_id, park_id, season_id)
    WHERE park_id IS NOT NULL AND status != 'reverted';
`);

// ── Values ────────────────────────────────────────────────────────────────

/**
 * Bring `unclaimed_value` back in line with difficulty and escalations. The single
 * place that writes that column, so it can never drift from its inputs. Called after
 * seeding, after an import, and after a season rollover.
 */
export const recomputeValues = db.transaction(() => {
  const cap = config.ESCALATION_CAP;
  const update = db.prepare('UPDATE hoods SET unclaimed_value = ? WHERE id = ?');
  for (const h of db.prepare('SELECT id, difficulty, escalations FROM hoods').all()) {
    const raw = h.difficulty + h.escalations * config.ESCALATION_STEP;
    update.run(cap == null ? raw : Math.min(raw, cap), h.id);
  }
});

// ── Seeding ───────────────────────────────────────────────────────────────
// The 25 Hoods, their adjacency, their difficulty and the four seasons are facts about
// the game rather than user data, so they are seeded on first run.
// `scripts/import-hoods.js` recomputes all of it from the City of Toronto open-data
// file; the seed just means a fresh checkout is playable before anyone downloads a
// megabyte of GeoJSON.

const seedHoods = db.transaction(() => {
  const insert = db.prepare(`
    INSERT INTO hoods (id, name, centroid_lat, centroid_lng, ever_conquered,
                       difficulty, escalations, unclaimed_value)
    VALUES (?, ?, ?, ?, 0, ?, 0, ?)
    ON CONFLICT(id) DO NOTHING`);
  const state = db.prepare('INSERT INTO hood_state (hood_id) VALUES (?) ON CONFLICT DO NOTHING');
  for (const h of HOOD_SEED) {
    const difficulty = DIFFICULTY_SEED[h.id] ?? config.BASE_UNCLAIMED_VALUE;
    insert.run(h.id, h.name, h.lat, h.lng, difficulty, difficulty);
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
recomputeValues();

export const nowIso = () => new Date().toISOString();
export const isoPlusHours = (iso, hours) =>
  new Date(new Date(iso).getTime() + hours * 3600_000).toISOString();

export default db;
