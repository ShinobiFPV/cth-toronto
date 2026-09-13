# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**Park-E-Mans GO!** — collect the 1,513 park signs of Toronto, and hold its 25 wards
("Hoods") with your camera. For a private friend group of about six people. Node +
SQLite backend, React PWA frontend, deployed to the Raspberry Pi 5 (`shinobi`,
192.168.1.203) on port **8096** and exposed at `cth.shintech.online` through the
existing Cloudflare Tunnel.

It was called **Capture the Hood: Toronto** and was renamed once the parks turned out to
be the best part of it. The territory half is unchanged and still speaks of Hoods,
conquering and stealing — only the product name moved.

**Every infrastructure identifier is still `cth`** and must stay that way unless somebody
deliberately migrates them: the systemd units (`cth.service`, `cth-backup`,
`cth-rollover`), `/srv/cth` and `/srv/backups/cth`, every `CTH_*` env var, and the
hostname `cth.shintech.online`. The hostname especially: a PWA's identity is its origin,
so changing it would orphan every installed copy on everybody's phone — new origin, new
app, no session, no stored appearance.

`parkemans-go-spec.md` is the design document this was built from and is kept in sync
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
  closes its neighbours to *that player* for 6h. It does not touch steals or reinforces,
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
- **Park collections are claims too.** A park collection is a row in `claims` with
  `claim_kind = 'park'` and `park_id` set. That is deliberate: scoring, the feed, chat
  and flagging all work on it with no special cases. It must never touch `hood_state` —
  collecting a park takes nothing from anybody. Once-per-season is enforced both in
  `evaluateCollect()` and by a partial unique index that excludes reverted rows, so a
  claim the group threw out frees the park up again.
- **A trade moves the card and never the score.** `points_awarded` and `xp_awarded` stay
  on the claim with whoever walked to the park, and `claims.player_id` is never
  reassigned. Holding lives in `card_holdings` — sparse, so the holder of a card is
  `COALESCE(card_holdings.holder_id, claims.player_id)` and an untraded card has no row
  at all. If you ever find yourself moving a score to follow a card, stop: that turns
  trading into a points laundry, and XP is defined as activity, which is not
  transferable. `test/trades.test.js` asserts points, XP and the whole leaderboard are
  byte-identical across a trade.
- **A binder lists holdings; the summary counts collections.** `cardsOf()` filters on
  the holder, `collectionSummary()`'s `season_collected` / `season_points` count claims.
  Both are correct and they are different questions — the UI labels them, or a binder
  holding a traded card reads as "0 collected" above a card.
- **Accepting a trade re-checks both holdings inside its transaction**, like
  `commitClaim` re-runs `evaluateClaim`. The stale marking deliberately happens
  *outside* that transaction: better-sqlite3 rolls a transaction back when it throws, so
  marking and then throwing in the same one silently loses the mark. A test caught that.
- **Cards and binders are public, deliberately.** `GET /cards?player=` reads anybody's
  binder and `GET /cards/:claimId` is not scoped to the owner. That is not an oversight:
  nobody competes over parks, so a card takes nothing from anybody, and comparing pulls
  is most of what makes a card game fun. Territory claims are a different matter — do
  not copy this openness onto anything anyone can lose.
- **The app is called Park-E-Mans GO!** It was Parkemon, then Parkemans, then ParkeMans
  GO!. Every name a player can see uses the current spelling. Older spellings survive
  only where renaming would break something or buys nothing: the `cth-parkemon:` salt
  inside `cardSeed()`, a hash input already baked into every stored `card_seed` — leave
  it — and the identifiers `parkemans-go` (npm name and GitHub repo),
  `parkemans-go-spec.md`, the `Parkemans` screen component and `.btn-parkemans`.
- **An edition is rolled with fresh randomness, never derived from `card_seed`.** The
  seed's salt is in a public repo, so a seed-derived edition would let anybody
  precompute which parks hand them a Gold and go collect exactly those. `rollEdition()`
  uses `crypto.randomInt` and the result is frozen onto `claims.edition`. It takes an
  injectable `rand` purely so tests can force an outcome.
- **Editions pay XP and never points.** Points are the season race; a race decided by
  dice is not a race. `test/editions.test.js` asserts the leaderboard cannot move.
- **The hologram cap is one per Hood per season, global, and checked inside the
  collection's transaction** so two collections cannot both mint the last one. A hit in
  a Hood whose hologram has gone falls through to the next edition down rather than
  being discarded — `EDITIONS` is ordered rarest-first for exactly that reason, and so
  that an all-hits roll cannot be demoted to Steel.
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
- **The Garage is claims too, and the dullest possible scoring.** A car is a row with
  `claim_kind = 'car'` and `vehicle_id` set; it never touches `hood_state`. It pays a flat
  `CAR_POINTS` clamped by `min()` against what is left of `CAR_WEEKLY_CAP`, computed once
  in `commitCar()` and frozen. Past the cap the claim still lands, worth 0 — that is a
  success, and there must never be a `WEEKLY_CAP_REACHED` error. `commitCar()` re-runs
  `evaluateCar()` inside its transaction, like `commitClaim`.
- **The week is a stored string.** `week_key` is computed at claim time in
  `America/Toronto` by `server/lib/week.js`, with a real timezone conversion, and the cap
  is an exact match on it. Never compute a rolling window and never add a fixed offset —
  `test/carcap.test.js` pins both DST transitions. The week is independent of the season.
- **`park_id IS NULL` no longer means territory.** Car claims have no park either. The Hood
  discovery bonus now filters on `claim_kind IN ('conquer','steal','reinforce')`, and
  `holosInHood()` filters to parks so a car hologram cannot use up a Hood's park hologram.
  Any new query that means "territory claims" has to say so by kind.
- **The dedupe key is make + model, trim and generation stripped.** `vehicleKey()` in
  `server/lib/vehicles.js` is the only place one is made. Too fine and the Case fills with
  Civics; too coarse and every Toyota is one package. Single letters are never stripped as
  trim unless the identifier reported them as trim — "Model S" is a model.
- **The identify call happens in the route, never in the transaction**, and is swappable
  with `setIdentifier()`. Tests never touch the network; `CTH_IDENTIFY_STUB` exists for the
  end-to-end suite and is ignored unless `NODE_ENV=test`. `in_situ` false marks a package
  as suspect for flaggers and never rejects it.
- **Plates are blurred before the claim is written**, in the display and thumbnail only.
  A blur that throws fails the collection; do not catch it and publish the plate.
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
- **A caption is the one mutable thing in the game, and it lives on `photos`.** Not on
  `claims` — the ledger only ever UPDATEs `status` and `flag_count`, and an editable
  field in there would be the exception that rots the rule. `photos.caption` is null or
  content, never `''`; `cleanCaption()` is the only way text gets in, from both upload
  routes and the edit route, so collapsing and the length cap cannot be bypassed. A
  caption scores nothing and the state machine never reads it.
- **A caption edit posts no chat message.** The claim already announced itself, and an
  edit is not an event — it broadcasts `caption_changed`, which the client uses to patch
  the one field rather than refetching 25 Hoods.
- **A reinforce's `beaten_player_id` is yourself.** `shapeClaim()` deliberately exposes
  `beaten` only for steals, and `replaced_photo_type` for reinforces, so no card ever
  says you beat yourself.

## Conventions

- **The tab bar is Map / Cards / Feed / Standings / Chat**, and `Tab` takes a `badge`.
  Two are wired: unread chat, and `session.trades_pending` for offers waiting on you.
  The offers badge is live — the store calls `refreshMe()` on a `trade_offered` /
  `trade_resolved` frame addressed to this player, because a notification badge that
  only appears on reload is not a notification. Five labels fit down to 320px; check
  that before adding a sixth.
- **The Garage lives inside the Cards tab** as a **Parks | Garage** control, carried in
  the URL as `?kind=car`, because the tab bar has no room for a sixth label. The shelf is
  the **Case**, the collectable is a **Not Wheels package** (`NotWheelsPack.jsx`), and a
  card component that might receive either branches on `card.kind`.
- **The app is Park-E-Mans GO! — the sub-game inside it is just "parks".** A button reading
  "Play Parkemans GO" inside an app of that name is a button offering to launch the app
  you are already in, so the Hood sheet says **Collect parks** and the parks screen is
  titled **Parks**. The *card* and the *binder* keep their own names.

- **Never say "ward" in player-facing text.** They are Hoods, rendered as
  `Hood 13 — Toronto Centre` via `hoodLabel()`.
- All timestamps are ISO-8601 UTC strings. They sort lexicographically, so string
  comparison is a valid time comparison — the whole codebase relies on this.
- Every failure the client might act on gets a stable error code (`HOOD_LOCKED`,
  `REINFORCE_TOO_SOON`, `WEAK_TYPE`, `SAME_TYPE`, `NOT_YOUR_CLAIM`, …) via `GameError`.
  The UI branches on the code, never on the message text.
- Every tunable lives in `server/config.js`, driven by env vars. The spec's §10 "open
  decisions" are all levers there — escalation cap, reinforce season cap, flag threshold,
  whether the displaced holder's flag counts.
- Chat is the activity feed. Every claim and every flag posts a system message through
  `postMessage()`. Nothing in this game happens quietly — that is the enforcement model.

## Testing

```bash
npm test        # 311 tests, no server needed, touches nothing in data/
```

- `test/game.test.js` — the rules, driving the game module directly. Time is simulated by
  winding `hood_state` clocks backwards, not by waiting.
- `test/api.test.js` — boots the real server on port 8199 against a temp database and
  walks the whole thing over HTTP, including real JPEGs through the sharp pipeline.
- `test/parks.test.js` — parks and cards. Seeds four parks by hand rather than importing
  1,513, so the suite never touches the network.
- `test/editions.test.js` — Steel / Gold / Hologram: the roll, the per-Hood hologram cap,
  and that none of it can move a single point.
- `test/trades.test.js` — trading. The first suite in it exists only to assert that a
  trade changes no points, no XP and no standings; the rest covers the rules, stale
  offers and the inbox.
- `test/garage.test.js` — the Garage: the dedupe key, what a car may not touch, the
  season hologram and its fall-through, and that cars never inflate the parks numbers.
- `test/carcap.test.js` — the weekly points cap and the week-key arithmetic, including
  both Toronto DST transitions and the ISO year boundary.
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
- **The Garage needs an Anthropic API key on the Pi** — `CTH_ANTHROPIC_API_KEY` in
  `/home/shinobi/cth/.env`. Without it every car collection is `IDENTIFY_UNAVAILABLE` and
  nothing is written, which is safe but looks broken. Every collection is one billed vision
  call, made after the cheap checks (Hood, season) and before the dedupe check, because the
  dedupe key comes out of the identification.
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
  The darkening is `--map-filter`, so it switches itself off in light mode with no JS —
  `.map-osm` is applied unconditionally and the token decides.
- **Never hardcode a colour outside `styles.css`.** Every colour is a custom property, and
  a literal hex in a component is a light-mode bug waiting to be reported. If Leaflet
  needs a real string, read the token with `cssVar()`. The one legitimate exception is a
  player colour from the server, and even then the map label runs it through `textSafe()`
  so the number stays readable on paper while the fill keeps the server's exact hue.
- **The chrome bars are black in both themes**, so their children need `--on-chrome` /
  `--on-chrome-dim`, never `--text` / `--dim`. This was the source of most of the 72
  contrast failures light mode shipped with in its first hour: the header stats, the tab
  bar, the chat composer and Leaflet's own zoom buttons all inherited paper-coloured text
  onto black.
- **`applyAppearance()` runs in `main.jsx` before `createRoot`**, not in a `useEffect`.
  Moving it into React gives every load a flash of the wrong theme.
- **`sw.js` and the app shell must be served `no-store`.** Express sends `max-age=0`,
  which Cloudflare replaces with its own four-hour TTL on anything ending in `.js`.
  `sw.js` *is* the precache manifest, so a stale copy pins every phone to the previous
  build for four hours — in Safari and the installed app alike, because they share one
  worker. This actually happened: two rounds of a layout fix looked deployed and never
  reached the reporter's phone. `server/index.js` now sets `no-store` on
  `sw.js` / `registerSW.js` / `index.html` / the manifest, and `immutable` on the
  content-hashed `/assets/`. If you add another unhashed file the shell depends on, it
  belongs in `NEVER_CACHE`.
- **The build stamp is not decoration.** `__BUILD__` is injected by `vite.config.js`,
  logged on boot and printed on the profile screen, so "which build is your phone
  actually running" is a readable fact. It is how the caching bug above was confirmed.
- **A bottom sheet is a flex column, and its action button lives in `.sheet-actions`
  outside the scrolling body.** Sheet content has no fixed height — a 4:3 preview, a
  caption being typed, a banner and an error can all be on screen at once — which
  pushed Collect and Conquer clean past the bottom edge. `min-height: 0` on
  `.bottom-sheet > .sheet-body` is what lets the body shrink and scroll instead of
  growing and shoving the footer out; without it the bug returns exactly as it was.
  Both actions on the Hood sheet belong there too — the claim *and* the parks button,
  which sits under it and was therefore the first thing to disappear.
- **Sheets drop down from the top. Never anchor one to the bottom again.** The bottom
  of a phone screen is not yours: a `position: fixed; bottom: 0` element anchors to the
  **layout** viewport, which on iOS Safari continues underneath the toolbar, and the
  keyboard covers the same strip. Sheets rose from there for a long time, and every fix
  was a better guess at the covered height — `position: sticky`, a fixed 3.5rem of
  clearance, then measuring it into `--vv-bottom` — and players still reported buttons
  cut off. So `.bottom-sheet` (the class kept its name) now sits at
  `top: calc(var(--vv-top) + var(--safe-top))` with
  `max-height: calc(var(--vv-height) - var(--safe-top) - var(--sheet-gap))`.
  `lib/viewport.js` measures the visible top and height from `visualViewport`, so
  whatever covers the bottom — toolbar or keyboard — only ever shortens the sheet, and
  its footer stays on screen. `test/sheets.test.js` holds that in place, including the
  arithmetic and a check that the rule has no `bottom:` at all.
- **The park dots live in their own Leaflet pane, at z-index 450 with
  `pointer-events: none`.** Both halves are load-bearing. 450 puts them above the Hood
  polygons (overlayPane, 400) so a dot draws over a Hood's translucent fill, and below
  the Hood numbers (markerPane, 600) so a dot never hides one. `pointer-events: none` is
  what keeps the map usable at all: the browser dispatches a click to the topmost
  element, and a canvas covering the map swallows every tap meant for a Hood — marking
  the markers non-interactive does *not* make its canvas transparent. Without that line,
  tapping a Hood anywhere on the map silently did nothing, which is the map's entire
  interaction gone. They are also **canvas, not SVG**: 1,513 SVG circles would be 1,513
  more DOM nodes, and the Hood polygons need SVG only because the reinforce pulse
  animates a path.
- **Dots are deliberately not clickable.** Tapping a Hood is the map's whole interaction
  and a field of 1,513 hit targets over it competes with that; the route to a park is
  still Hood → Collect parks. `dotRadius()` also drops them entirely below zoom 10.5,
  where 1,513 specks read as a grey haze over the city rather than as information.
- **Leaflet sizing.** The map lives in a grid row and is measured before layout settles,
  so `MapScreen` calls `invalidateSize()` on the next frame and keeps a `ResizeObserver`.
  Removing that leaves Toronto fitted to the wrong viewport.
- The reinforce pulse is a CSS class toggled on the polygon's SVG path element, which is
  why the map uses the SVG renderer (`preferCanvas: false`). Canvas leaves nothing to
  animate.
- `web/public/hoods.min.geojson` is generated by `npm run import-hoods` and committed —
  the app is unusable without it and nobody should need network access to run it.

## Visual style

**Kolker Brush is for the wordmark and the card titles, and nothing else.** `--wordmark`
holds the brush face; `--display` (Rubik Mono One) still sets every heading, the map's
Hood numbers and every `.num`, because a brush face on a table header or a two-digit map
label would be unreadable. The card title is the other place a script belongs: it is the
name of the object you are holding, it echoes the app's own mark, and park names arrive
from the City in title case, which is what a script wants — so `.pcard-name` also drops
the tracking and any uppercasing. It is set at roughly twice the size the blocky face
was, since a script sits small on its em box; `0.9rem` on a compact card is the largest
that still fits the longest park name in the set across two lines. The font is
self-hosted in `web/public/fonts` with its OFL licence beside the other two — nothing
here fetches a font at run time.

"Arctic Classified after dark" — the shintech.online house style inverted for a map-first
app used outdoors at night. The rules carry over unchanged and `web/src/styles.css`
states them at the top: no radii, 2px structural borders, 1px hairlines only inside
containers, hard offset shadows instead of glows, Rubik Mono One for display only, Space
Mono for everything else. This project's accent is **hazard amber `#FFB020`** — chosen
because the map already spends every other colour on player territory, so nothing in the
chrome may take a hue a player could be wearing.

Amber is now the **default**, not the only option. Players pick a mode and an accent on
the profile screen (spec §7.1, `web/src/lib/theme.js`), and light mode is the *original*
uninverted house style rather than a new design. Two consequences for anything you build:

- **An accent is five tokens, not one** — `--accent`, `--accent-rgb`, `--accent-text`,
  `--accent-deep`, `--accent-ink` — because a player-chosen hue has to survive being text
  on paper and a label on its own fill. Use `--accent-text` for accent-coloured *words* on
  a panel and `--accent` only on fills, borders, and the black chrome. `--accent-ink` is
  chosen by measuring both candidates; a luminance threshold picks white for mid-tones and
  puts 2.5:1 labels on the teal button.
- **The accent never touches a player colour.** That separation is the reason an arbitrary
  accent is safe at all: the chrome and the territory can't be confused for one another.

`test/theme.test.js` unit-tests the colour maths and asserts all eight accents clear AA in
both themes. It is mutation-checked against the two bugs that actually shipped here (the
`--accent-ink` threshold, and `forContrast` ignoring the background it was passed), so if
you change that file, re-run it before trusting it.
