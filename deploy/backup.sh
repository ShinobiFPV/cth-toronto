#!/usr/bin/env bash
# Nightly backup. Run by cth-backup.timer; safe to run by hand at any time.
#
# The database MUST be snapshotted through SQLite's online backup API, not copied with
# cp. It runs in WAL mode, so a plain copy of cth.sqlite without its -wal sidecar
# silently loses every write since the last checkpoint — you get a file that opens fine
# and is missing a week of claims.
#
# The snapshot is taken with better-sqlite3's backup(), which is the same API as
# `sqlite3 .backup` but needs nothing installed: node and better-sqlite3 are already
# here because the app depends on them, and the sqlite3 CLI is not on this box.
set -euo pipefail

APP_DIR="${CTH_APP_DIR:-/home/shinobi/cth}"
SRC_DB="${CTH_DB:-/srv/cth/cth.sqlite}"
SRC_MEDIA="${CTH_MEDIA:-/srv/cth/media}"
DEST="${CTH_BACKUP_DIR:-/srv/backups/cth}"
KEEP_DAYS="${CTH_BACKUP_KEEP_DAYS:-30}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DEST/db"
out="$DEST/db/cth-$stamp.sqlite"

# Consistent snapshot of a live database, no downtime, no torn WAL.
node --input-type=module -e "
import Database from '$APP_DIR/node_modules/better-sqlite3/lib/index.js';
const db = new Database(process.argv[1], { readonly: true });
await db.backup(process.argv[2]);
db.close();
" "$SRC_DB" "$out"

gzip -f "$out"

# Media is append-only in practice — nothing is ever deleted from the ledger — so a
# plain mirror is enough, and cheap after the first run.
rsync -a --delete "$SRC_MEDIA/" "$DEST/media/"

find "$DEST/db" -name 'cth-*.sqlite.gz' -mtime "+$KEEP_DAYS" -delete

echo "[cth-backup] $stamp -> $DEST ($(du -sh "$DEST" | cut -f1))"
