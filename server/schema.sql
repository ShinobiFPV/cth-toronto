-- Capture the Hood: Toronto — schema.
-- All timestamps are ISO-8601 UTC strings ('2026-09-11T18:04:00.000Z'), which sort
-- lexicographically, so plain string comparison is a valid time comparison.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS players (
  id            INTEGER PRIMARY KEY,
  handle        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  colour        TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invite_codes (
  code       TEXT PRIMARY KEY,
  created_by INTEGER REFERENCES players(id),
  note       TEXT,
  used_by    INTEGER REFERENCES players(id),
  used_at    TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hoods (
  id             INTEGER PRIMARY KEY,      -- ward number, 1-25
  name           TEXT NOT NULL,
  centroid_lat   REAL,
  centroid_lng   REAL,
  ever_conquered INTEGER NOT NULL DEFAULT 0,
  -- What this Hood is worth to take: 5-50, from distance to the city centre and how
  -- many Hoods border it. Immutable game data, recomputed only by import-hoods.js.
  difficulty     INTEGER NOT NULL DEFAULT 25,
  -- How many season rollovers this Hood has survived without ever being conquered.
  escalations    INTEGER NOT NULL DEFAULT 0,
  -- Always difficulty + escalations * ESCALATION_STEP, capped. Stored rather than
  -- computed per-query only because every read wants it; recomputeValues() is the one
  -- place that maintains it, so it cannot drift.
  unclaimed_value INTEGER NOT NULL DEFAULT 25
);

-- Which Hoods border which, both directions. Presentation data derived from the
-- boundary file, except that it also drives the adjacent-conquer cooldown.
CREATE TABLE IF NOT EXISTS hood_neighbours (
  hood_id      INTEGER NOT NULL REFERENCES hoods(id),
  neighbour_id INTEGER NOT NULL REFERENCES hoods(id),
  PRIMARY KEY (hood_id, neighbour_id)
);

-- ── Parkemon GO ───────────────────────────────────────────────────────────
-- The sub-game inside each Hood: every Toronto park has a sign with its name on it,
-- and players collect them. Nobody owns a park and nobody competes over one — each
-- player may collect each park once per season, and the points just add up.
CREATE TABLE IF NOT EXISTS parks (
  id        INTEGER PRIMARY KEY,        -- the city's ASSET_ID, stable across imports
  name      TEXT NOT NULL,
  hood_id   INTEGER REFERENCES hoods(id),
  lat       REAL NOT NULL,
  lng       REAL NOT NULL,
  address   TEXT,
  amenities TEXT,
  url       TEXT,
  -- 5-100, purely by distance from the city centre. Unlike a Hood there is no
  -- isolation term: a park is a destination, not a thing you fight over.
  value     INTEGER NOT NULL DEFAULT 5,
  distance_km REAL,
  -- Position in the set, 1..N alphabetically. Printed on the card as "#0123/1513",
  -- which is the only reason it exists: a collectable needs a number.
  set_number INTEGER
);
CREATE INDEX IF NOT EXISTS idx_parks_hood ON parks(hood_id, name);

CREATE TABLE IF NOT EXISTS seasons (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL,
  starts_at          TEXT NOT NULL,   -- inclusive
  ends_at            TEXT NOT NULL,   -- exclusive; equals the next season's starts_at
  escalation_applied INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS photos (
  id            INTEGER PRIMARY KEY,
  player_id     INTEGER NOT NULL REFERENCES players(id),
  photo_type    TEXT NOT NULL,        -- drone | camera | phone (as declared)
  path_original TEXT NOT NULL,
  path_display  TEXT NOT NULL,
  path_thumb    TEXT NOT NULL,
  width         INTEGER,
  height        INTEGER,
  bytes         INTEGER,
  exif_json     TEXT,                 -- display only; the server never reads it back
  caption       TEXT,                 -- player-authored flavour; editable, never scored
  created_at    TEXT NOT NULL
);

-- Append-only ledger. Rows are never UPDATEd except for `status` and `flag_count`.
-- points_awarded is immutable once written.
CREATE TABLE IF NOT EXISTS claims (
  id                INTEGER PRIMARY KEY,
  hood_id           INTEGER NOT NULL REFERENCES hoods(id),
  player_id         INTEGER NOT NULL REFERENCES players(id),
  season_id         INTEGER NOT NULL REFERENCES seasons(id),
  photo_id          INTEGER REFERENCES photos(id),    -- null on reversal rows
  claim_kind        TEXT NOT NULL,    -- conquer | steal | reinforce | reversal
  photo_type        TEXT,
  beaten_player_id  INTEGER REFERENCES players(id),
  beaten_photo_type TEXT,
  points_awarded    INTEGER NOT NULL,
  -- XP frozen onto the row at the moment it landed, exactly like points_awarded.
  -- Lifetime XP is SUM(xp_awarded) with no season filter, which is what makes levels
  -- persist forever without a counter anywhere that could drift.
  xp_awarded        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,    -- active | superseded | reverted
  flag_count        INTEGER NOT NULL DEFAULT 0,
  -- Snapshot of hood_state immediately before this claim landed, so a reversal can
  -- put the Hood back exactly as it was (spec §1.7: "restores the previous
  -- last_claim_at, so a bogus reinforce doesn't reset anyone's 72-hour clock").
  prev_owner_id     INTEGER REFERENCES players(id),
  prev_photo_type   TEXT,
  prev_claim_id     INTEGER,
  prev_last_claim_at TEXT,
  prev_locked_until  TEXT,
  reverts_claim_id  INTEGER REFERENCES claims(id),    -- set on reversal rows only
  -- Set on claim_kind = 'park' only. A park collection rides in this same ledger so
  -- that scoring, the feed, chat and flagging all work on it for free, but it never
  -- touches hood_state: collecting a park takes nothing from anybody.
  park_id           INTEGER REFERENCES parks(id),
  card_seed         TEXT,                           -- drives the collectable card art
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claims_hood    ON claims(hood_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claims_season  ON claims(season_id, status);
CREATE INDEX IF NOT EXISTS idx_claims_player  ON claims(player_id, status);
CREATE INDEX IF NOT EXISTS idx_claims_created ON claims(created_at DESC);

-- NOTE: indexes over claims.park_id are NOT here. This file runs before the migrations
-- in db.js, and on a database that predates that column `CREATE TABLE IF NOT EXISTS` is
-- a no-op — so an index naming park_id would fail with "no such column". They are
-- created in db.js instead, after the column exists. Anything indexing a migrated
-- column belongs there, not here.

CREATE TABLE IF NOT EXISTS hood_state (
  hood_id        INTEGER PRIMARY KEY REFERENCES hoods(id),
  owner_id       INTEGER REFERENCES players(id),
  active_claim_id INTEGER REFERENCES claims(id),
  photo_type     TEXT,
  last_claim_at  TEXT,   -- drives the 72h reinforce gate
  locked_until   TEXT    -- drives the 12h steal cooldown
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  player_id  INTEGER REFERENCES players(id),   -- null for system messages
  body       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'user',     -- user | system
  meta_json  TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(id DESC);

CREATE TABLE IF NOT EXISTS flags (
  id         INTEGER PRIMARY KEY,
  claim_id   INTEGER NOT NULL REFERENCES claims(id),
  player_id  INTEGER NOT NULL REFERENCES players(id),
  reason     TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(claim_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_flags_claim ON flags(claim_id);
