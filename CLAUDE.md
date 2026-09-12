# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**Capture the Hood: Toronto** — a photo-based territory game over the 25 City of Toronto
wards, for a private friend group of about six people. Node + SQLite backend, React PWA
frontend, deployed to the Raspberry Pi 5 (`shinobi`, 192.168.1.203) on port **8096** and
exposed at `cth.shintech.online` through the existing Cloudflare Tunnel.

`capture-the-hood-spec.md` is the design document this was built from and is kept in sync
with the code. If you change a rule, change the spec too.

This is a standalone project in the ShinTech workspace with its own deploy. It shares
nothing with `imq2`, `shinlink-os` or `port-manager` except the physical Pi and the house
visual style.

**Port 8096**, not the 8093 the spec asked for. On shinobi 8091 is Site Editor, 8092 is
shintech-forms and 8093 is MedFam (also `shinnode`'s default); elsewhere in ShinTech
8090, 8094 (imq2's HUD) and 8095 (the shinlink bridge) are taken. 8096 is free on the
box and unclaimed in every sibling's docs.

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
- **The adjacency cooldown is conquer-only and per-player.** Conquering an unclaimed Hood
  closes its neighbours to *that player* for 24h. It does not touch steals or reinforces,
  and it does not stop anyone else. Reverted conquers stop blocking. Several tests
  deliberately use Hoods 1, 13, 16 and 25 because those are pairwise non-adjacent — if you
  "tidy" them into 1, 2, 3 the suite fails, and correctly so.
- **`hood_neighbours` is the one piece of geometry that is not presentation.** Everything
  else about the boundaries is cosmetic; this table decides which claims are legal, so
  `import-hoods.js` computes it from the *unsimplified* source and replaces it wholesale.
- **Points come from the Hood, not a flat rate.** Conquering pays `hoods.unclaimed_value`
  (difficulty plus banked escalations); stealing pays `difficulty * STEAL_MULTIPLIER`;
  reinforcing pays a flat 25 everywhere. Tests read the prices out of the database
  rather than hardcoding them, so rebalancing the formula does not turn the suite red —
  keep it that way.
- **`unclaimed_value` is derived and has exactly one writer.** It is always
  `difficulty + escalations * ESCALATION_STEP`, capped, and `recomputeValues()` in
  `server/db.js` is the only thing allowed to write it. The rollover increments
  `escalations` and calls it; the importer refreshes `difficulty` and calls it. Never
  UPDATE that column directly.
- **Parkemon collections are claims too.** A park collection is a row in `claims` with
  `claim_kind = 'park'` and `park_id` set. That is deliberate: scoring, the feed, chat
  and flagging all work on it with no special cases. It must never touch `hood_state` —
  collecting a park takes nothing from anybody. Once-per-season is enforced both in
  `evaluateCollect()` and by a partial unique index that excludes reverted rows, so a
  claim the group threw out frees the park up again.
- **A card's art is seeded, not random.** `card_seed` is hashed from
  (player, park, season) and stored on the claim, so a card renders identically every
  time. `ParkCard.jsx` reads the seed for the hatch, foil and corners, the season for
  the palette, and the value for the rarity. Never generate card art from Math.random
  or a timestamp — the whole point is that it is stable.
- **XP is derived and never season-scoped.** `claims.xp_awarded` is frozen at claim
  time like `points_awarded`, and lifetime XP is `SUM(xp_awarded)` filtered only by
  `status != 'reverted'`. That is the whole of "persists forever" — do not add a
  counter on `players`, and never filter XP by `season_id`.
- **A level is an observation, not an event.** `levelOf(xp)` inverts the curve, and
  `withLevelUp()` detects a level-up by comparing the derived level either side of a
  write. There is no levels table and no level column.
- **XP deliberately does not track points.** Points scale with value, XP with activity
  and novelty, so the two tables say different things. The discovery bonuses are what
  make that true; drop them and XP becomes a rename of the Champion total.
- **Nothing mechanical hangs off a level** — it is a title and a number. A level that
  granted an advantage would compound, and early joiners could never be caught.
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
npm test        # 140 tests, no server needed, touches nothing in data/
```

- `test/game.test.js` — the rules, driving the game module directly. Time is simulated by
  winding `hood_state` clocks backwards, not by waiting.
- `test/api.test.js` — boots the real server on port 8199 against a temp database and
  walks the whole thing over HTTP, including real JPEGs through the sharp pipeline.
- `test/parks.test.js` — Parkemon GO. Seeds four parks by hand rather than importing
  1,513, so the suite never touches the network.
- `test/xp.test.js` — the level curve (asserted to invert exactly across 200 levels), the
  XP schedule, and that XP survives season rollovers, reversals and lost territory.
- `test/reproject.test.js` — the importer's coordinate maths, against fixtures lifted
  from the City's own files.

There is no linter and no CI. Validate frontend changes by running the app
(`npm run dev` + `npm run dev:web`).

## Gotchas

- **Schema changes need a migration.** `CREATE TABLE IF NOT EXISTS` does nothing to a
  table that already exists, so a new column needs an entry in the migrations block at the
  top of `server/db.js`. Keep those append-only and idempotent: they run on deploy against
  a live database with real claims in it.
- **Login and registration are the only endpoints a stranger can reach**, and argon2id
  makes every attempt cost real Pi CPU, so both are rate limited per IP (and login per
  handle too) in `server/lib/ratelimit.js`. The limits are env-tunable. If you add
  another unauthenticated route, it needs a limiter.
- **This repo is public.** No infrastructure identifiers in it — the Cloudflare tunnel id
  is read out of `/etc/cloudflared/config.yml` at run time rather than written down.
  Keep it that way.
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
