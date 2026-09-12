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

The database and every photo ever posted live under `/srv/cth`. **Put this on external
storage if you have one.** A season of drone stills on an SD card is how SD cards die.

```bash
sudo mkdir -p /srv/cth/media /srv/backups/cth
sudo chown -R shinobi:shinobi /srv/cth /srv/backups/cth
```

If you have a USB SSD mounted at, say, `/mnt/ssd`, point `/srv/cth` at it instead:

```bash
sudo mkdir -p /mnt/ssd/cth
sudo chown -R shinobi:shinobi /mnt/ssd/cth
sudo ln -s /mnt/ssd/cth /srv/cth
```

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

> This writes `web/public/hoods.min.geojson`, but the app serves `web/dist/`. Either run
> it once on the Pi **and** once locally before a deploy (the built copy is what ships),
> or just run it locally and let `deploy.ps1` carry the result. Running it locally is the
> normal path; it is listed here so a from-scratch Pi install is self-sufficient.

## 7 · systemd

```bash
cd /home/shinobi/cth
sudo cp deploy/cth.service deploy/cth-rollover.service deploy/cth-rollover.timer \
        deploy/cth-backup.service deploy/cth-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cth
sudo systemctl enable --now cth-rollover.timer
sudo systemctl enable --now cth-backup.timer
systemctl status cth --no-pager
curl -s localhost:8093/api/health
```

Let `shinobi` restart the service without a password prompt, the same way the other
services do:

```bash
echo 'shinobi ALL=(ALL) NOPASSWD: /bin/systemctl restart cth' | sudo tee /etc/sudoers.d/cth
sudo chmod 440 /etc/sudoers.d/cth
```

## 8 · nginx

```bash
sudo tee /etc/nginx/conf.d/upgrade-map.conf >/dev/null <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
EOF
sudo cp /home/shinobi/cth/deploy/nginx-cth.conf /etc/nginx/sites-available/cth
sudo ln -sf /etc/nginx/sites-available/cth /etc/nginx/sites-enabled/cth
sudo nginx -t && sudo systemctl reload nginx
```

If `upgrade-map.conf` collides with an existing `map $http_upgrade` block on this box,
delete the new one and keep the existing one — there can only be one.

## 9 · Cloudflare Tunnel

Add `cth.shintech.online` as an ingress hostname on the existing tunnel
(`d8cc689f-a605-4400-95b8-b2e3b059e325`), pointing at `http://localhost:8093`.

In `/etc/cloudflared/config.yml`, **above** the catch-all 404 rule:

```yaml
  - hostname: cth.shintech.online
    service: http://localhost:8093
```

```bash
sudo systemctl restart cloudflared
```

Then add the DNS route (once, from anywhere with the tunnel credentials):

```bash
cloudflared tunnel route dns d8cc689f-a605-4400-95b8-b2e3b059e325 cth.shintech.online
```

WebSockets traverse the tunnel without extra configuration. Note Cloudflare's free-plan
100 MB request body cap — the app's own limit is 60 MB, so that is the one that bites
first.

## 10 · First player

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
curl -s localhost:8093/api/health

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

The backups are made with `sqlite3 .backup`, so each one is already a consistent
single-file snapshot with no WAL sidecar to reunite. Never back this database up with
`cp` — in WAL mode that silently drops every write since the last checkpoint.

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
