# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**Capture the Hood: Toronto** — a photo-based territory game over the 25 City of Toronto
wards, for a private friend group of about six people. Node + SQLite backend, React PWA
frontend, deployed to the Raspberry Pi 5 (`shinobi`, 192.168.1.203) on port **8094** and
exposed at `cth.shintech.online` through the existing Cloudflare Tunnel.

`capture-the-hood-spec.md` is the design document this was built from and is kept in sync
with the code. If you change a rule, change the spec too.

This is a standalone project in the ShinTech workspace with its own deploy. It shares
nothing with `imq2`, `shinlink-os` or `port-manager` except the physical Pi and the house
visual style. On shinobi, 8091 is Site Editor, 8092 is shintech-forms, 8093 is MedFam
(and the default for port-manager's shinnode agent), 8094 is this.

## The one thing that matters

`server/lib/game.js` is the claim state machine — conquer / steal / reinforce, the
counter rule, the cooldowns. **It is the only code in the repo that decides who owns a
Hood.** Everything else is presentation over it. Two entry points:

- `evaluateClaim()` — pure, no writes. Answers "can this player claim this Hood, with
  what subject, for how many points, and if not, why not?" Both the claim endpoint and
  the Hood list call it, which is why the map sheet and the server can never disagree.
- `commitClaim()` — one transaction. Re-runs `evaluateClaim()` **inside** the
  transaction; the client's preflight is a courtesy, this is the ruling.

Never add a second place that mutates `hood_state`.

## Rules that are easy to get wrong

Every one of these is covered by a test in `test/game.test.js`. If you find yourself
changing one, read the test first — it says why.

- **The counter layer is about subject matter, not camera.** `landmark` / `person` /
  `animal`; animal beats person, person beats landmark, landmark beats animal. Any
  camera is legal. The DB column is still `photo_type` because it is literally the type
  of photo; the values changed, the column name did not.
- **A reinforce does not arm the steal lock.** A conquer and a steal do. If a reinforce
  locked the Hood, a player could shield one indefinitely on a 72-hour timer.
- **Losing a Hood costs no points.** The superseded claim keeps its `points_awarded` and
  is marked `superseded`, never `reverted`.
- **Reverting cancels points exactly once.** The original row is marked `reverted` and
  every scoring query excludes that status — *that* is what cancels the points. The
  compensating `reversal` row therefore carries **0**, not `-N`; doing both would
  subtract the score twice. The reversal row exists to make the cancellation visible in
  the feed and the Hood's history. The spec's §1.7 wording implies both mechanisms; this
  is the resolution, and it is asserted in the tests.
- **A reversal restores the previous `last_claim_at`**, so a bogus reinforce cannot reset
  somebody's 72-hour clock. That is why `claims` carries `prev_*` columns the spec's
  schema does not list — they are the snapshot a reversal rewinds to.
- **A reverted first-ever conquer un-sets `ever_conquered`**, so seasonal escalation
  resumes for that Hood. Otherwise one bogus claim freezes its value at 25 forever.
- **Scores are always derived** — `SUM(points_awarded)` over the ledger, filtered by
  `season_id` for a season and unfiltered for the Champion table. There is no
  denormalised running total anywhere and there must never be one.
- **A reinforce's `beaten_player_id` is yourself.** `shapeClaim()` deliberately exposes
  `beaten` only for steals, and `replaced_photo_type` for reinforces, so no card ever
  says you beat yourself.

## Conventions

- **Never say "ward" in player-facing text.** They are Hoods, rendered as
  `Hood 13 — Toronto Centre` via `hoodLabel()`.
- All timestamps are ISO-8601 UTC strings. They sort lexicographically, so string
  comparison is a valid time comparison — the whole codebase relies on this.
- Every failure the client might act on gets a stable error code (`HOOD_LOCKED`,
  `REINFORCE_TOO_SOON`, `WEAK_TYPE`, `SAME_TYPE`, …) via `GameError`. The UI branches on
  the code, never on the message text.
- Every tunable lives in `server/config.js`, driven by env vars. The spec's §10 "open
  decisions" are all levers there — escalation cap, reinforce season cap, flag threshold,
  whether the displaced holder's flag counts.
- Chat is the activity feed. Every claim and every flag posts a system message through
  `postMessage()`. Nothing in this game happens quietly — that is the enforcement model.

## Testing

```bash
npm test        # 66 tests, no server needed, touches nothing in data/
```

- `test/game.test.js` — the rules, driving the game module directly. Time is simulated by
  winding `hood_state` clocks backwards, not by waiting.
- `test/api.test.js` — boots the real server on port 8199 against a temp database and
  walks the whole thing over HTTP, including real JPEGs through the sharp pipeline.
- `test/reproject.test.js` — the importer's coordinate maths, against fixtures lifted
  from the City's own files.

There is no linter and no CI. Validate frontend changes by running the app
(`npm run dev` + `npm run dev:web`).

## Gotchas

- **Native modules** (`better-sqlite3`, `sharp`, `argon2`) are built per-architecture.
  `deploy.ps1` never copies `node_modules`; it runs `npm ci` on the Pi.
- **Never back up the database with `cp`.** It runs in WAL mode — a plain copy without
  the `-wal` sidecar silently loses every write since the last checkpoint, and the result
  opens cleanly while missing a week of claims. `deploy/backup.sh` uses SQLite's online
  backup API through better-sqlite3 — not the `sqlite3` CLI, which is not installed on
  shinobi.
- **HEIC.** sharp on the Pi usually has no HEIC decoder. The web client converts with
  `heic2any` before upload; the server falls back to `heic-convert`; if both fail the
  player gets a "switch to Most Compatible" message. `heic2any` is 1.3 MB and is
  deliberately excluded from the service worker precache — do not add it back.
- **Map tiles need no API key and it must stay that way.** CARTO's dark basemap now
  watermarks every tile; the app uses plain OSM raster darkened with a CSS filter on the
  tile pane only. `VITE_MAP_TILES` / `VITE_MAP_ATTRIB` / `VITE_MAP_DARKEN` override it.
- **Leaflet sizing.** The map lives in a grid row and is measured before layout settles,
  so `MapScreen` calls `invalidateSize()` on the next frame and keeps a `ResizeObserver`.
  Removing that leaves Toronto fitted to the wrong viewport.
- The reinforce pulse is a CSS class toggled on the polygon's SVG path element, which is
  why the map uses the SVG renderer (`preferCanvas: false`). Canvas leaves nothing to
  animate.
- `web/public/hoods.min.geojson` is generated by `npm run import-hoods` and committed —
  the app is unusable without it and nobody should need network access to run it.

## Visual style

"Arctic Classified after dark" — the shintech.online house style inverted for a map-first
app used outdoors at night. The rules carry over unchanged and `web/src/styles.css`
states them at the top: no radii, 2px structural borders, 1px hairlines only inside
containers, hard offset shadows instead of glows, Rubik Mono One for display only, Space
Mono for everything else. This project's accent is **hazard amber `#FFB020`** — chosen
because the map already spends every other colour on player territory, so nothing in the
chrome may take a hue a player could be wearing.
