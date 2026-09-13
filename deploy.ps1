# Deploy Park-E-Mans GO! to shinobi (192.168.1.203).
#
#   .\deploy.ps1              build the web client, push, reinstall deps if needed, restart
#   .\deploy.ps1 -SkipBuild   push the existing web/dist as-is
#   .\deploy.ps1 -Restart     restart the service without pushing anything
#   .\deploy.ps1 -ForceInstall  reinstall node_modules even if the lockfile is unchanged
#
# Like the other ShinTech deploys, this does NOT install systemd units or the nginx
# vhost — those are one-time manual steps, see SETUP.md. If you edit anything in
# deploy/, run the daemon-reload yourself.
#
# Native modules (better-sqlite3, sharp, argon2) are built for the Pi's architecture,
# so node_modules is never copied from Windows — npm install runs on the Pi.

param(
    [switch]$SkipBuild,
    [switch]$Restart,
    [switch]$ForceInstall,
    [string]$Target = 'shinobi@192.168.1.203',
    [string]$RemoteDir = '/home/shinobi/cth'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# Build from the real on-disk path, not whatever junction, symlink or mapped drive the
# script was reached through. Vite resolves index.html to its real path and compares it
# with the working directory; when the two disagree the build dies with "The fileName or
# name properties of emitted chunks and assets must be strings that are neither absolute
# nor relative paths".
$real = node -e "console.log(require('fs').realpathSync.native(process.argv[1]))" $here
if ($LASTEXITCODE -eq 0 -and $real) { $here = $real.Trim() }
Set-Location $here

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "!!  $msg" -ForegroundColor Red; exit 1 }

if ($Restart) {
    Step 'Restarting cth'
    ssh $Target 'sudo -n systemctl restart cth && sleep 1 && systemctl is-active cth'
    exit $LASTEXITCODE
}

# ── Build ────────────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
    Step 'Building the web client'
    npm --prefix web run build
    if ($LASTEXITCODE -ne 0) { Fail 'web build failed — nothing was pushed' }
}
if (-not (Test-Path 'web/dist/index.html')) {
    Fail 'web/dist/index.html is missing. Run without -SkipBuild.'
}

# ── Push ─────────────────────────────────────────────────────────────────────
Step "Pushing to ${Target}:${RemoteDir}"
ssh $Target "mkdir -p $RemoteDir/web"

$paths = @('server', 'scripts', 'deploy', 'package.json', 'package-lock.json')
foreach ($p in $paths) { if (-not (Test-Path $p)) { Fail "missing $p" } }

# Tarballs go to a file and across with scp, never through a pipe. Windows PowerShell
# 5.1 (and pwsh before 7.4) re-encodes anything piped between two native commands as
# text, so `tar -czf - | ssh ... tar -xzf -` arrives as "stdin: not in gzip format".
$serverTgz = Join-Path $env:TEMP 'cth-deploy-server.tgz'
$distTgz = Join-Path $env:TEMP 'cth-deploy-dist.tgz'
tar -czf $serverTgz $paths
if ($LASTEXITCODE -ne 0) { Fail 'packing the server tree failed' }
tar -czf $distTgz -C web dist
if ($LASTEXITCODE -ne 0) { Fail 'packing web/dist failed' }

scp -q $serverTgz $distTgz "${Target}:/tmp/"
if ($LASTEXITCODE -ne 0) { Fail 'copying the bundles to the Pi failed' }

# web/dist is replaced wholesale so a renamed bundle never leaves a stale twin behind.
ssh $Target "tar -xzf /tmp/cth-deploy-server.tgz -C $RemoteDir && rm -rf $RemoteDir/web/dist && tar -xzf /tmp/cth-deploy-dist.tgz -C $RemoteDir/web"
$unpacked = $LASTEXITCODE
ssh $Target 'rm -f /tmp/cth-deploy-server.tgz /tmp/cth-deploy-dist.tgz'
Remove-Item -Force $serverTgz, $distTgz -ErrorAction SilentlyContinue
if ($unpacked -ne 0) { Fail 'unpacking on the Pi failed' }

ssh $Target "chmod +x $RemoteDir/deploy/backup.sh"

# ── Dependencies ─────────────────────────────────────────────────────────────
# npm ci is the only thing that installs the native modules correctly for arm64, but it
# always deletes and rebuilds node_modules — about two minutes on the Pi even when
# nothing changed. So it runs only when the lockfile has actually moved, tracked by a
# hash stamped next to the installed tree.
$lockHash = (Get-FileHash -Algorithm SHA256 package-lock.json).Hash.ToLower()
$stampPath = "$RemoteDir/node_modules/.cth-lock-hash"
$remoteHash = (ssh $Target "cat $stampPath 2>/dev/null || true").Trim()

if ($remoteHash -eq $lockHash -and -not $ForceInstall) {
    Step 'Dependencies unchanged — skipping npm ci'
} else {
    Step 'Installing production dependencies on the Pi (lockfile changed)'
    ssh $Target "cd $RemoteDir && npm ci --omit=dev --no-audit --no-fund && printf '%s' '$lockHash' > $stampPath"
    if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed on the Pi — the old build is still running' }
}

# ── Restart and verify ───────────────────────────────────────────────────────
Step 'Restarting cth'
ssh $Target 'sudo -n systemctl restart cth'
if ($LASTEXITCODE -ne 0) { Fail 'systemctl restart failed' }

Start-Sleep -Seconds 2
$health = ssh $Target 'curl -sf --max-time 5 http://127.0.0.1:8096/api/health || echo FAILED'
if ($health -match 'FAILED' -or -not $health) {
    Write-Host $health
    ssh $Target 'sudo -n journalctl -u cth -n 40 --no-pager'
    Fail 'cth did not come back healthy — journal above'
}

Write-Host "Deployed Park-E-Mans GO! to shinobi" -ForegroundColor Green
Write-Host $health
Write-Host "https://cth.shintech.online" -ForegroundColor Green
