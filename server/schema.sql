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
  unclaimed_value INTEGER NOT NULL DEFAULT 25
);

-- Which Hoods border which, both directions. Presentation data derived from the
-- boundary file, except that it also drives the adjacent-conquer cooldown.
CREATE TABLE IF NOT EXISTS hood_neighbours (
  hood_id      INTEGER NOT NULL REFERENCES hoods(id),
  neighbour_id INTEGER NOT NULL REFERENCES hoods(id),
  PRIMARY KEY (hood_id, neighbour_id)
);

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
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claims_hood    ON claims(hood_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claims_season  ON claims(season_id, status);
CREATE INDEX IF NOT EXISTS idx_claims_player  ON claims(player_id, status);
CREATE INDEX IF NOT EXISTS idx_claims_created ON claims(created_at DESC);

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
