#!/usr/bin/env bash
# Nightly backup. Run by cth-backup.timer; safe to run by hand at any time.
#
# The database MUST be copied with sqlite3 .backup, not cp. It runs in WAL mode, so a
# plain copy of cth.sqlite without its -wal sidecar silently loses every write since
# the last checkpoint — you get a file that opens fine and is missing a week of claims.
set -euo pipefail

SRC_DB="${CTH_DB:-/srv/cth/cth.sqlite}"
SRC_MEDIA="${CTH_MEDIA:-/srv/cth/media}"
DEST="${CTH_BACKUP_DIR:-/srv/backups/cth}"
KEEP_DAYS="${CTH_BACKUP_KEEP_DAYS:-30}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DEST/db"

# Consistent snapshot of a live database, no downtime, no torn WAL.
sqlite3 "$SRC_DB" ".backup '$DEST/db/cth-$stamp.sqlite'"
gzip -f "$DEST/db/cth-$stamp.sqlite"

# Media is append-only in practice — nothing is ever deleted from the ledger — so a
# plain mirror is enough and cheap after the first run.
rsync -a --delete "$SRC_MEDIA/" "$DEST/media/"

find "$DEST/db" -name 'cth-*.sqlite.gz' -mtime "+$KEEP_DAYS" -delete

echo "[cth-backup] $stamp -> $DEST ($(du -sh "$DEST" | cut -f1))"
