# Setting up Capture the Hood on shinobi

One-time install. After this, `.\deploy.ps1` from ScarlettWitch does everything.

`deploy.ps1` deliberately does **not** install systemd units or the nginx vhost — same
convention as `shintech-forms`. If you edit anything in `deploy/` later, re-run the
`daemon-reload` yourself.

---

## 1 · Node

The Pi needs Node 20 or newer. Check first:

```bash
node --version
```

If it is older than 20, install a current LTS (NodeSource or nvm — the other ShinTech
services on this box do not depend on the system Node, so upgrading is safe).

`sharp`, `better-sqlite3` and `argon2` are native modules. They ship arm64 prebuilds and
should install without a toolchain; if any of them tries to compile, install
`build-essential python3` and let it.

## 2 · Storage

The database and every photo ever posted live under `/srv/cth`, which
`deploy/install.sh` creates in step 7 — nothing to do here unless you have external
storage.

**You should.** A season of drone stills on an SD card is how SD cards die, and as of
this writing shinobi's 59 GB card is 93% full with about 4 GB free, shared with every
other service on the box. There is a lot of reclaimable space on it if you need more —
`sudo apt-get clean` alone frees ~2 GB — but none of that changes the underlying
problem, which is that this game only grows. If you have a USB SSD mounted at, say,
`/mnt/ssd`, make `/srv/cth` a symlink to it *before* running the install:

```bash
sudo mkdir -p /mnt/ssd/cth/media
sudo chown -R shinobi:shinobi /mnt/ssd/cth
sudo ln -s /mnt/ssd/cth /srv/cth
```

`install.sh` leaves an existing `/srv/cth` alone, symlink included.

## 3 · Timezone

Season boundaries and the rollover timer are Toronto local time.

```bash
timedatectl set-timezone America/Toronto
```

## 4 · First push

From ScarlettWitch:

```powershell
cd D:\Projects\ShinTech\CTH-Toronto
.\deploy.ps1
```

The first run will fail at the restart step because the service does not exist yet —
that is expected. The files and `node_modules` will be in place.

## 5 · Environment file

```bash
cd /home/shinobi/cth
cp .env.example .env
node -e "console.log('CTH_JWT_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))" >> .env
nano .env          # delete the empty CTH_JWT_SECRET= line the copy left behind
chmod 600 .env
```

`.env` is never committed and never copied by `deploy.ps1`.

## 6 · Hood boundaries

```bash
cd /home/shinobi/cth
node scripts/import-hoods.js
```

Downloads the 25-ward GeoJSON from City of Toronto Open Data, simplifies it to ~65 kB
for the map layer, and fills in the `hoods` table. Safe to re-run at any time — it never
touches game state.

Then the parks for Parkemans GO — 1,513 of them, assigned to Hoods by point-in-polygon,
so this must run *after* the boundaries:

```bash
node scripts/import-parks.js
```

Unlike the Hoods there is no committed seed for parks (1,513 rows is not a source file),
so this step is required rather than a convenience. `deploy/install.sh` runs it for you on
a fresh install; re-run it by hand if the city ever revises the dataset.

> The boundary import writes `web/public/hoods.min.geojson`, but the app serves `web/dist/`. Either run
> it once on the Pi **and** once locally before a deploy (the built copy is what ships),
> or just run it locally and let `deploy.ps1` carry the result. Running it locally is the
> normal path; it is listed here so a from-scratch Pi install is self-sufficient.

## 7 · Install the service, nginx and the tunnel

Everything from here needs root, which is why it is not part of `deploy.ps1`.
`deploy/install.sh` does the lot and is idempotent — re-run it any time you change a
file in `deploy/`.

Run it from a **real terminal**, not through a tool that pipes stdin, or sudo has
nothing to prompt on:

```bash
ssh -t shinobi@192.168.1.203 'sudo bash /home/shinobi/cth/deploy/install.sh --all'
```

| Flag | Adds |
|---|---|
| *(none)* | `/srv/cth`, the five systemd units, the sudoers grant, and starts the service |
| `--nginx` | the LAN vhost (not needed for the tunnel, which points straight at the app) |
| `--tunnel` | the `cth.shintech.online` ingress rule and its DNS route |
| `--all` | both of the above |

It will:

1. create `/srv/cth/media` and `/srv/backups/cth` and hand them to `shinobi` — the data
   **must** live outside `/home`, because `cth.service` sets `ProtectHome=read-only`
2. migrate an existing database out of `/home/shinobi/cth-data` if one is there, taking
   the `-wal` and `-shm` sidecars with it
3. repoint `CTH_DB` / `CTH_MEDIA` / `CTH_BACKUP_DIR` in `.env`, and refuse to continue if
   `CTH_JWT_SECRET` is empty
4. install the five units, `daemon-reload`, and grant `shinobi` a passwordless
   `systemctl restart cth` (validated with `visudo -c` first — a broken file in
   `sudoers.d` locks sudo for everybody)
5. enable and start `cth` plus the rollover and backup timers, then poll
   `/api/health` and dump the journal if it does not come up
6. with `--nginx`, unlink the vhost again if `nginx -t` fails, so a bad config can never
   take the other sites down with it
7. with `--tunnel`, back up `config.yml`, insert the ingress rule **above** the
   `http_status:404` catch-all, and restart `cloudflared`

## 8 · First player

```bash
cd /home/shinobi/cth
node scripts/make-invite.js 6
```

The first person to register with one of those codes becomes the admin and can mint the
rest from inside the app (tap the wordmark → Invites).

Then open `https://cth.shintech.online` on a phone and use **Add to Home Screen** — the
capture flow is the only place the game is actually played.

---

## Checking on it

```bash
systemctl status cth
journalctl -u cth -f
systemctl list-timers 'cth-*'
curl -s localhost:8096/api/health

# What the rollover would do, without doing it
cd /home/shinobi/cth && node scripts/rollover.js --dry-run
```

## Restoring a backup

```bash
sudo systemctl stop cth
gunzip -c /srv/backups/cth/db/cth-<stamp>.sqlite.gz > /srv/cth/cth.sqlite
rm -f /srv/cth/cth.sqlite-wal /srv/cth/cth.sqlite-shm
rsync -a /srv/backups/cth/media/ /srv/cth/media/
sudo chown -R shinobi:shinobi /srv/cth
sudo systemctl start cth
```

Each backup is a consistent single-file snapshot with no WAL sidecar to reunite —
`deploy/backup.sh` takes it through SQLite's online backup API via better-sqlite3,
because the `sqlite3` CLI is not installed on this box and node already is. Never back
this database up with `cp`: in WAL mode that silently drops every write since the last
checkpoint.

## Testing HEIC on a real iPhone

Do this early; it is the single most likely thing to derail the upload path.

1. On the iPhone: Settings → Camera → Formats → **High Efficiency** (the bad case).
2. Shoot and claim a Hood.
3. The web client converts HEIC to JPEG before uploading. If that fails, the server
   retries with `heic-convert`. If both fail you get a clear message telling you to
   switch to Most Compatible.
4. Check which path ran: `journalctl -u cth -n 50`.

To skip the whole problem, tell everyone to set Formats → **Most Compatible** once, and
set `CTH_HEIC_SERVER_FALLBACK=false` so the server stops burning Pi CPU on conversions.
