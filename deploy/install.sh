#!/usr/bin/env bash
# One-time privileged install for ParkeMans GO! on shinobi.
#
# Everything in here needs root, which is why it is not part of deploy.ps1 — same
# convention as the other ShinTech services. Run it once, from a real terminal so sudo
# can prompt:
#
#   ssh -t shinobi@192.168.1.203 'sudo bash /home/shinobi/cth/deploy/install.sh'
#
# Idempotent: every step checks before acting, so re-running it after a change to
# anything in deploy/ is the normal way to apply that change.
#
# What it does NOT do: the nginx vhost (LAN access only — the tunnel points straight at
# the app) and the Cloudflare Tunnel ingress. Those are --nginx and --tunnel.
set -euo pipefail

APP_DIR=/home/shinobi/cth
DATA_DIR=/srv/cth
BACKUP_DIR=/srv/backups/cth
OLD_DATA=/home/shinobi/cth-data
SVC_USER=shinobi
PORT=8096
# Read from cloudflared's own config at run time rather than hardcoding it, so this
# repo carries no infrastructure identifiers. Override with CTH_TUNNEL_ID if needed.
TUNNEL_ID="${CTH_TUNNEL_ID:-}"
HOSTNAME_PUBLIC="${CTH_HOSTNAME:-cth.shintech.online}"

do_nginx=false
do_tunnel=false
for arg in "$@"; do
  case "$arg" in
    --nginx)  do_nginx=true ;;
    --tunnel) do_tunnel=true ;;
    --all)    do_nginx=true; do_tunnel=true ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "This needs root. Run: sudo bash $0 $*" >&2
  exit 1
fi

say() { printf '\n== %s\n' "$1"; }
ok()  { printf '   %s\n' "$1"; }

# ── Data directory ───────────────────────────────────────────────────────────
# It has to live outside /home: cth.service sets ProtectHome=read-only, so a database
# under /home/shinobi would be unwritable to the service no matter who owns it.
say "Data directory"
if [ -d "$DATA_DIR" ]; then
  ok "$DATA_DIR already exists"
else
  mkdir -p "$DATA_DIR/media"
  ok "created $DATA_DIR/media"
fi
mkdir -p "$BACKUP_DIR"
chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR" "$BACKUP_DIR"
ok "owner is $SVC_USER, backups at $BACKUP_DIR"

if [ -f "$DATA_DIR/cth.sqlite" ]; then
  ok "database already in place — not touching it"
elif [ -f "$OLD_DATA/cth.sqlite" ]; then
  # Move the -wal and -shm sidecars too, or the move loses recent writes.
  mv "$OLD_DATA"/cth.sqlite* "$DATA_DIR/"
  [ -d "$OLD_DATA/media" ] && rsync -a "$OLD_DATA/media/" "$DATA_DIR/media/"
  chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"
  ok "migrated the database and media from $OLD_DATA"
else
  ok "no database yet — the app creates and seeds one on first start"
fi

# ── .env ─────────────────────────────────────────────────────────────────────
say "Environment file"
if [ ! -f "$APP_DIR/.env" ]; then
  echo "   !! $APP_DIR/.env is missing. See SETUP.md section 5." >&2
  exit 1
fi
if grep -q "$OLD_DATA" "$APP_DIR/.env"; then
  sudo -u "$SVC_USER" sed -i \
    -e "s#$OLD_DATA#$DATA_DIR#g" \
    -e "s#^CTH_BACKUP_DIR=.*#CTH_BACKUP_DIR=$BACKUP_DIR#" \
    "$APP_DIR/.env"
  ok "repointed CTH_DB / CTH_MEDIA / CTH_BACKUP_DIR at $DATA_DIR"
else
  ok "already points outside /home"
fi
grep -q '^CTH_JWT_SECRET=.\+' "$APP_DIR/.env" \
  || { echo "   !! CTH_JWT_SECRET is empty in .env — the app refuses to start in production." >&2; exit 1; }
ok "CTH_JWT_SECRET is set"

# ── Game data ────────────────────────────────────────────────────────────────
# The 25 Hoods ship as a seed, but the 1,513 parks do not — the parks game is simply
# missing until the importer has run once. Safe to skip if they are already there.
say "Parks"
park_count=$(sudo -u "$SVC_USER" node -e "
  const D = require('$APP_DIR/node_modules/better-sqlite3');
  try {
    const db = new D(process.argv[1], { readonly: true });
    process.stdout.write(String(db.prepare('SELECT COUNT(*) AS n FROM parks').get().n));
    db.close();
  } catch { process.stdout.write('0'); }
" "$DATA_DIR/cth.sqlite" 2>/dev/null || echo 0)

if [ "${park_count:-0}" -gt 0 ]; then
  ok "$park_count parks already imported"
else
  if sudo -u "$SVC_USER" env CTH_DB="$DATA_DIR/cth.sqlite"        node "$APP_DIR/scripts/import-parks.js" >/tmp/cth-parks.log 2>&1; then
    ok "$(tail -3 /tmp/cth-parks.log | head -1)"
  else
    ok "park import failed — the parks game will be empty until you re-run it:"
    ok "  cd $APP_DIR && node scripts/import-parks.js"
    tail -3 /tmp/cth-parks.log >&2 || true
  fi
  rm -f /tmp/cth-parks.log
fi

# ── systemd ──────────────────────────────────────────────────────────────────
say "systemd units"
units=(cth.service cth-rollover.service cth-rollover.timer cth-backup.service cth-backup.timer)
changed=false
for u in "${units[@]}"; do
  if ! cmp -s "$APP_DIR/deploy/$u" "/etc/systemd/system/$u"; then
    install -m 644 "$APP_DIR/deploy/$u" "/etc/systemd/system/$u"
    ok "installed $u"
    changed=true
  fi
done
$changed || ok "all five units already current"
chmod +x "$APP_DIR/deploy/backup.sh"
systemctl daemon-reload
ok "daemon-reload done"

# ── sudoers ──────────────────────────────────────────────────────────────────
# So deploy.ps1 can restart the service without a prompt. Both paths, because sudo's
# secure_path puts /usr/bin ahead of /bin and an entry for only one never matches.
say "Passwordless restart for deploy.ps1"
sudoers_line="$SVC_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart cth, /bin/systemctl restart cth"
if [ -f /etc/sudoers.d/cth ] && grep -qF "$sudoers_line" /etc/sudoers.d/cth; then
  ok "already granted"
else
  tmp=$(mktemp)
  printf '%s\n' "$sudoers_line" > "$tmp"
  # Validate before installing: a broken file in sudoers.d locks sudo for everyone.
  visudo -c -f "$tmp" >/dev/null
  install -m 440 "$tmp" /etc/sudoers.d/cth
  rm -f "$tmp"
  ok "granted and validated"
fi

# ── Start ────────────────────────────────────────────────────────────────────
say "Starting"
systemctl enable --now cth >/dev/null 2>&1 || systemctl enable --now cth
systemctl restart cth
systemctl enable --now cth-rollover.timer >/dev/null
systemctl enable --now cth-backup.timer >/dev/null
ok "cth enabled, rollover and backup timers armed"

for i in $(seq 1 20); do
  health=$(curl -sf --max-time 3 "http://127.0.0.1:$PORT/api/health" || true)
  [ -n "$health" ] && break
  sleep 1
done
if [ -z "${health:-}" ]; then
  echo "   !! cth did not answer on $PORT. Last 30 journal lines:" >&2
  journalctl -u cth -n 30 --no-pager >&2
  exit 1
fi
ok "health: $health"

# ── Optional: nginx ──────────────────────────────────────────────────────────
if $do_nginx; then
  say "nginx vhost (LAN access)"
  install -m 644 "$APP_DIR/deploy/nginx-cth.conf" /etc/nginx/sites-available/cth
  ln -sf /etc/nginx/sites-available/cth /etc/nginx/sites-enabled/cth
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    ok "installed and nginx reloaded"
  else
    rm -f /etc/nginx/sites-enabled/cth
    echo "   !! nginx -t failed, so the vhost was unlinked again and nginx left alone:" >&2
    nginx -t >&2 || true
    exit 1
  fi
fi

# ── Optional: Cloudflare Tunnel ──────────────────────────────────────────────
if $do_tunnel; then
  say "Cloudflare Tunnel ingress"
  cfg=/etc/cloudflared/config.yml
  if [ -z "$TUNNEL_ID" ] && [ -f "$cfg" ]; then
    TUNNEL_ID=$(awk '/^[[:space:]]*tunnel:[[:space:]]*/ {print $2; exit}' "$cfg")
  fi
  if [ -z "$TUNNEL_ID" ]; then
    echo "   !! No tunnel id. Set CTH_TUNNEL_ID, or add a 'tunnel:' line to $cfg." >&2
    exit 1
  fi
  ok "tunnel $TUNNEL_ID"
  if grep -q "$HOSTNAME_PUBLIC" "$cfg"; then
    ok "$HOSTNAME_PUBLIC already routed"
  else
    cp "$cfg" "$cfg.bak.$(date -u +%Y%m%d%H%M%S)"
    # The new rule must go ABOVE the catch-all, or the 404 swallows it.
    awk -v host="$HOSTNAME_PUBLIC" -v port="$PORT" '
      /^[[:space:]]*-[[:space:]]*service:[[:space:]]*http_status:404/ && !done {
        printf "  - hostname: %s\n    service: http://localhost:%s\n", host, port
        done = 1
      }
      { print }
    ' "$cfg" > "$cfg.new"
    grep -q "$HOSTNAME_PUBLIC" "$cfg.new" \
      || { echo "   !! could not find the http_status:404 catch-all to insert above. Edit $cfg by hand." >&2; rm -f "$cfg.new"; exit 1; }
    mv "$cfg.new" "$cfg"
    ok "added the ingress rule (previous config kept as a .bak)"
    systemctl restart cloudflared
    ok "cloudflared restarted"
  fi
  # The DNS route is an account-level operation and needs the tunnel credentials,
  # which live in the service user's home.
  sudo -u "$SVC_USER" cloudflared tunnel route dns "$TUNNEL_ID" "$HOSTNAME_PUBLIC" \
    && ok "DNS route confirmed" \
    || ok "DNS route not changed (usually means it already exists)"
fi

say "Done"
systemctl --no-pager --lines=0 status cth | head -4
echo
echo "   LAN:    http://192.168.1.203:$PORT"
$do_tunnel && echo "   Public: https://$HOSTNAME_PUBLIC"
echo
echo "   Next:   cd $APP_DIR && node scripts/make-invite.js 6"
