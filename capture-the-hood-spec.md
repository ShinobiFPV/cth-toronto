# Capture the Hood: Toronto — Build Spec

A photo-based territory game for a small private friend group. Players conquer Toronto's
25 city wards ("Hoods") by posting recent photos taken inside them, with a
rock-paper-scissors layer based on what the photo is *of*.

**The game runs on the honour system.** The server does not verify where or when a photo
was taken. Players police each other through flagging. This is a deliberate design choice
that removes most of the hard engineering from the project.

Target: Node backend on Raspberry Pi 5 (`shinobi`, 192.168.1.203), React PWA frontend,
exposed via the existing Cloudflare Tunnel at `cth.shintech.online`.

---

## 1. Game rules

### 1.1 The Hoods

The 25 City of Toronto wards, referred to in all UI copy as **Hoods**. Never say "ward"
in player-facing text. Display as `Hood 13 — Toronto Centre`.

### 1.2 Photo subjects and the counter system

The counter layer is **camera-agnostic** — phone, drone, SLR, disposable, all equal.
What matters is the subject, declared by the player on submission:

| Subject | Covers | Beats | Beaten by |
|---|---|---|---|
| `landmark` | buildings, monuments, streets, local businesses | `animal` | `person` |
| `person` | selfies, friends, willing strangers | `landmark` | `animal` |
| `animal` | anything with a pulse that isn't a person | `person` | `landmark` |

Animal beats person, person beats landmark, landmark beats animal.

### 1.2a The difficulty score

Every Hood carries a **difficulty score from 5 to 50**: what it is worth to take. It is
computed once from the boundary data, from two things:

| Input | Weight | Why |
|---|---|---|
| Distance from the city centre | 65% | The dominant cost. Every claim is a trip somebody has to actually make, and the gap between Rouge Park and University-Rosedale is an afternoon. Measured from Nathan Phillips Square. |
| How few Hoods border it | 35% | A Hood with two neighbours is a cul-de-sac you commit a dedicated journey to; one with seven has approaches from everywhere and you will pass through it anyway. |

Both inputs are normalised across the 25 Hoods, combined, then normalised again and
mapped onto 5–50 — so the easiest Hood is always exactly 5 and the hardest always
exactly 50, whatever shape the city happens to be.

The result, at the extremes:

| | Hood | Distance | Borders |
|---|---|---|---|
| **50** | 25 Scarborough-Rouge Park | 23.6 km | 2 |
| 39 | 23 Scarborough North | 20.7 km | 4 |
| 31 | 3 Etobicoke-Lakeshore | 10.6 km | 2 |
| 14 | 13 Toronto Centre | 1.8 km | 3 |
| **5** | 11 University-Rosedale | 2.6 km | 6 |

Etobicoke-Lakeshore scoring above what its distance alone suggests is the isolation term
doing its job: it is a long thin waterfront strip with two ways in.

Sanity check: this spec already joked that nothing but points would get anybody out to
Rouge Park in February. The formula, written from distance and borders alone, prices it
at exactly 50 — the most expensive Hood in Toronto. If a change to the formula stops
that being true, the change is wrong.

### 1.3 The three claim actions

**Conquer** — target Hood is unclaimed. Any photo subject works. Awards the Hood's current
`unclaimed_value`, which starts at its **difficulty score** and escalates while nobody
has ever taken it — see 1.5.

**Steal** — target Hood is held by another player. Your photo subject must *beat* theirs.
Awards the Hood's **difficulty score × `STEAL_MULTIPLIER`** (default 2), so 10 to 100.
Stealing is always worth about double conquering the same Hood, and taking the hardest
Hood in the city off somebody pays 100 — what a steal was worth when it was a flat rate.

**Reinforce** — target Hood is held by *you*, and at least **72 hours** have passed since
its last claim of any kind. You must upload the photo subject that beats your own current
photo. Awards **25 points**, flat, forever — the same on every Hood however hard, and it
never escalates. Reinforcing is maintenance, not conquest; scaling it with difficulty
would turn holding the far Hoods into passive income.

Reinforce is mechanically identical to a steal against yourself: same counter rule, lower
payout, time-gated. It rotates what you're vulnerable to. Hold a Hood with a `landmark`
shot and you're exposed to `person`; reinforce with `person` and you're now only exposed
to `animal`.

**Rules:**
- You cannot steal from yourself, and you cannot reinforce a Hood you don't hold.
- The 72-hour reinforce clock runs from the Hood's **last claim event** — conquer, steal,
  or a previous reinforce. Each reinforce resets it.
- After a Hood changes hands between players, it is locked from stealing for
  `STEAL_COOLDOWN_HOURS` (default **12**) to prevent instant revenge ping-pong.
- **Conquering an unclaimed Hood closes that Hood's neighbours to you** for
  `ADJACENT_CONQUER_COOLDOWN_HOURS` (default **24**). This is the anti-drone lever: from
  one vantage point a drone pilot can plausibly shoot several adjacent Hoods in an
  afternoon, and without this the whole west end goes to whoever owns a Mavic. It is
  deliberately narrow:
  - **per-player** — anyone else may still conquer that neighbour immediately
  - **conquer only** — your steals and reinforces next door are unaffected, so it slows
    land-grabs without making you defenceless inside your own territory
  - **it chains** — each conquer opens a fresh window around its own Hood, so walking
    the map outward is gated at every step
  - a claim reverted by flags stops blocking; a thrown-out claim should not fence you off
  - adjacency comes from the boundary file, so it is real geography, not a guess
- **A reinforce does not apply the steal lock.** If it did, a player could shield a Hood
  indefinitely. Reinforcing changes what type beats you, which is defence enough.
- A player who loses a Hood **does not lose points**. The claims ledger is append-only.
  Territory changes, score does not.
- A Hood can only be held by one player at a time.

### 1.4 Photo validity — honour system

The stated rules of play, enforced socially rather than by software:

- The photo must be **recent** — the group's convention, stated in the UI, is within the
  last few days. Not checked.
- The photo must have been **taken inside the Hood being claimed**. Not checked; the player
  picks the Hood from the map.
- The photo must actually **show the declared subject**. Not checked — and this is the
  rule most worth arguing about, since "is a pigeon on a storefront an animal or a
  landmark" is exactly the kind of dispute the flagging system exists for. The group's
  convention: the declared subject has to be the obvious point of the photo.

The server validates only what it can know for certain: that the Hood exists, that the
counter rule is satisfied, that cooldowns have elapsed, and that you aren't claiming your
own Hood outside of a reinforce.

Optionally, read EXIF on upload and display it read-only on the photo detail page as a
"shot data" panel (camera make/model, timestamp, GPS if present). The server ignores it
entirely — it just gives flaggers something concrete to argue about, mostly about the
"recent" and "inside the Hood" rules, since the counter layer no longer cares what took
the shot. Cheap to add, easy to cut.

### 1.5 Seasons

Four seasons. Suggested schedule (meteorological seasons, starting now):

| # | Season | Starts | Ends |
|---|---|---|---|
| 1 | Fall 2026 | Sep 1, 2026 | Nov 30, 2026 |
| 2 | Winter 2026–27 | Dec 1, 2026 | Feb 28, 2027 |
| 3 | Spring 2027 | Mar 1, 2027 | May 31, 2027 |
| 4 | Summer 2027 | Jun 1, 2027 | Aug 31, 2027 |

Store these in a `seasons` table — do not hardcode.

**At each rollover:**
- Seasonal point tallies reset to zero (achieved by scoping queries to `season_id`; nothing
  is deleted).
- Hood ownership **persists**. Whoever holds a Hood at season end still holds it.
- Every Hood that has **never been conquered by anyone** has its `unclaimed_value`
  increased by 25 — on top of its difficulty score, not instead of it.
- Reinforce stays flat at 25, and a steal is always difficulty × the multiplier. Neither
  escalates.

So an untouched Hood climbs from its difficulty score in 25-point steps, and the hard
ones stay ahead of the easy ones the whole way:

| Hood | S1 | S2 | S3 | S4 |
|---|---|---|---|---|
| 25 Scarborough-Rouge Park | 50 | 75 | 100 | 125 |
| 18 Willowdale | 27 | 52 | 77 | 102 |
| 11 University-Rosedale | 5 | 30 | 55 | 80 |

Escalation is now doing a narrower job than it used to: difficulty already makes the far
Hoods worth the trip on day one, so escalation exists to make a Hood nobody could be
bothered with — a cheap, well-connected one — eventually worth going to anyway.

### 1.6 Scoring and prizes

- **Season winner**: highest points within a single season. Four of these.
- **Champion**: highest sum across all four seasons, ignoring the seasonal resets.

Both are computed from the same append-only `claims` ledger — season points are
`SUM(points_awarded) WHERE season_id = ?`, total is the same without the filter. Never
store a denormalized running total.

### 1.7 Disputes

Any player can flag another player's active claim, with a reason. If **2 or more** other
players flag it, the claim is reverted: the Hood returns to its previous holder (or to
unclaimed), and the points are cancelled with a compensating `reversal` entry in the
ledger. A reverted claim also restores the previous `last_claim_at`, so a bogus reinforce
doesn't reset anyone's 72-hour clock.

This is the only enforcement mechanism in the game. Make it a one-tap action on every
photo, visible to everyone, with the flag count shown publicly — the social pressure of a
visible first flag is most of what makes it work.

---

## 1.8 Parkemon GO

A sub-game inside every Hood, and the only part of Capture the Hood that nobody competes
over.

Every Toronto park has the same municipal sign with the park's name on it. Photograph one
and you **collect** that park: it pays points and prints you a collectable card.

- **1,513 parks**, from the City of Toronto `parks-and-recreation-facilities` dataset,
  each filed under the Hood its coordinates fall inside.
- Each park is worth **5 to 100 points**, purely by distance from the city centre. No
  isolation term, unlike a Hood's difficulty score: a park is somewhere you go, not
  something you hold against anybody.
- **Each park is collectable once per season per player.** Everyone can collect the same
  park; there is no owner, no stealing, no cooldown, and nothing to lose.
- Park points go into the **same total** as territory. Somebody can top the table without
  holding a single Hood.
- Collections ride in the same `claims` ledger with `claim_kind = 'park'`, which is what
  makes scoring, the feed, chat and **flagging** work on them unchanged. A collection
  reverted by flags cancels its points and frees the park to be collected again.

Reached from the map: tap a Hood, then the **Parkemon GO** button on its sheet. That
opens the ~60 parks in that Hood as a list sorted by value, or as pins on a map.

### The card

Each collection renders a collectable card — the photo of the sign in the window, the
park's name on the plate, its value where a Pokémon card puts HP, and a **border unique to
that card**.

Unique is procedural, not random. The server stores a `card_seed` hashed from
(player, park, season), so:

- the **season** picks the palette — Fall is amber and rust, Winter ice blue, Spring
  green, Summer teal, so a card is identifiable across the room
- the **seed** picks the hatch angle and spacing, the foil sweep, the corner motif and a
  few degrees of hue drift
- the **value** picks the rarity, which decides how much the frame shows off: Common
  (5–24), Uncommon (25–49), Rare (50–74), Legendary (75–100)

Because the seed is stored rather than generated on the fly, a card looks the same every
time you open the binder — and two players who collect the same park in the same season
still get visibly different borders.

All of it is inline SVG and CSS. Nothing is rasterised and the Pi never renders a pixel.

### Data

```sql
parks(
  id,            -- the city's ASSET_ID, stable across imports
  name, hood_id, lat, lng, address, amenities, url,
  value,         -- 5-100 by distance from the city centre
  distance_km,
  set_number     -- 1..N alphabetically, printed on the card as "#0123/1513"
)

claims(... park_id, card_seed)   -- set on claim_kind = 'park' only
```

`scripts/import-parks.js` fetches the dataset, keeps only `TYPE = 'Park'` (the 277
community centres and 6 civic centres have no park sign), assigns each to a Hood by
point-in-polygon against the ward boundaries, and scores them. One park in the city falls
a few metres outside every ward boundary and is placed by nearest Hood instead of being
dropped.

A partial unique index enforces once-per-season at the database level:

```sql
CREATE UNIQUE INDEX idx_park_once_per_season
  ON claims(player_id, park_id, season_id)
  WHERE park_id IS NOT NULL AND status != 'reverted';
```

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 20 LTS | Already the Pi norm |
| HTTP | Express 4 | Boring, fine |
| DB | SQLite via `better-sqlite3` | Single file, synchronous, perfect for 6 players |
| Realtime | `ws` | Chat + live map updates; no socket.io needed |
| Images | `sharp` | Resize/transcode on the Pi 5 — fast enough |
| Geo | `@turf/simplify`, `@turf/centroid` | Build-time only, for the map layer |
| Auth | `argon2` + JWT in httpOnly cookie | Invite-code registration |
| Frontend | React 18 + Vite | |
| Map | Leaflet + OSM/CARTO raster tiles | Zero API keys, 25 polygons is nothing |
| PWA | `vite-plugin-pwa` | Manifest + service worker, add-to-home-screen |
| Process | systemd unit `cth.service` | Matches the other Pi services |

Add `exifr` only if you want the read-only shot-data panel from 1.4.

Port **8096**. (This spec originally said 8093, but MedFam already listens there and it
is `shinnode`'s documented default too. 8094 and 8095 are claimed by imq2's HUD and the
shinlink bridge. 8096 is free on shinobi and unclaimed across the workspace.)

Media lives at `/srv/cth/media/`. **Put this on external storage if you have it** — a
season of drone photos will grind the SD card.

---

## 3. Hood boundary data

Source: City of Toronto Open Data, dataset `city-wards` (25-ward 2018 boundaries, still
current).

- Portal page: `https://open.toronto.ca/dataset/city-wards/`
- CKAN API: `https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=city-wards`
  — enumerate `result.resources`, find the GeoJSON resource, download it.
- Licence: Open Government Licence – Toronto. Attribute it in the app footer.

Write a one-shot script `scripts/import-hoods.js` that:
1. Fetches the GeoJSON.
2. Normalizes to WGS84 (EPSG:4326) — reproject if the source ships in MTM/UTM.
3. Extracts ward number + name into the `hoods` table.
4. Emits a simplified `public/hoods.min.geojson` (turf `simplify`, tolerance ~0.0001) plus
   centroids for map labelling — the raw file is several MB and will hurt on mobile data.
5. Computes the **adjacency graph** into `hood_neighbours`, from the unsimplified geometry
   (simplification moves vertices). The city publishes a proper topological coverage, so
   two Hoods are neighbours when they share at least two exact vertices — two, not one, so
   a pair meeting at a single corner is not treated as a shared border. Unlike the
   boundaries themselves this is *not* presentation only: it decides which conquers the
   adjacency cooldown blocks.

Since claims are no longer geofenced, the boundaries are presentation only. They still need
to be correct enough that nobody's confused about which Hood they're standing in, but a
few metres of simplification error costs nothing now.

---

## 4. Photo capture

### 4.1 Capture path (mobile)

Use a file input with the capture attribute:

```html
<input type="file" accept="image/*" capture="environment" />
```

This hands off to the native camera app on both iOS and Android and is far less code than
a `getUserMedia` viewfinder. It also preserves EXIF, which matters only if you build the
optional shot-data panel.

Shots from a drone or a standalone camera are ordinary uploads (same input, without
`capture`), transferred to the phone or posted from desktop. The counter system does not
care which one you used — only what is in the frame — so the capture screen offers both
paths and never asks about the device.

### 4.2 HEIC

iPhones will hand you `.heic` unless the user sets Camera → Formats → Most Compatible.
`sharp` on the Pi frequently ships without libheif compiled in. Decide up front:
- Convert server-side with `heic-convert` (pure JS, slow but reliable), **or**
- Convert client-side with `heic2any` before upload, **or**
- Reject HEIC with a clear message telling players to switch to Most Compatible.

Test this on an actual iPhone early. It is now the single most likely thing to derail the
upload path.

### 4.3 Processing pipeline

On upload, after the claim passes validation, transcode with sharp to:
- `original/` — untouched, for dispute review
- `display/` — max 1600px long edge, WebP q80
- `thumb/` — 400px square cover, WebP q70

Strip EXIF from the derived files served publicly.

---

## 5. Data model

```sql
players(id, handle, display_name, password_hash, colour, is_admin, created_at)

hoods(
  id,                  -- ward number 1-25, primary key
  name,                -- "Toronto Centre"
  centroid_lat, centroid_lng,
  ever_conquered,      -- BOOLEAN, drives seasonal escalation
  difficulty,          -- INTEGER 5-50, what the Hood is worth to take
  escalations,         -- INTEGER, season rollovers survived unconquered
  unclaimed_value      -- INTEGER, = difficulty + escalations * step, capped
)

hood_neighbours(hood_id, neighbour_id)   -- both directions; drives the adjacency cooldown

seasons(id, name, starts_at, ends_at, escalation_applied)

photos(
  id, player_id, photo_type,     -- landmark | person | animal (the declared subject)
  path_original, path_display, path_thumb,
  exif_json,                     -- optional, display only, nullable
  created_at
)

claims(                          -- append-only ledger; never UPDATE points
  id, hood_id, player_id, season_id, photo_id,
  claim_kind,                    -- conquer | steal | reinforce | reversal
  photo_type,
  beaten_player_id, beaten_photo_type,
  points_awarded,                -- 25 / 100 / 25 / negative
  status,                        -- active | superseded | reverted
  flag_count,
  created_at
)

hood_state(
  hood_id PK, owner_id, active_claim_id, photo_type,
  last_claim_at,                 -- drives the 72h reinforce gate
  locked_until                   -- drives the 12h steal cooldown
)

messages(id, player_id, body, kind, meta_json, created_at)   -- kind: user | system

flags(id, claim_id, player_id, reason, created_at)
```

Scores are always derived:
```sql
-- season leaderboard
SELECT player_id, SUM(points_awarded) FROM claims
WHERE season_id = ? AND status != 'reverted' GROUP BY player_id;

-- champion standings
SELECT player_id, SUM(points_awarded) FROM claims
WHERE status != 'reverted' GROUP BY player_id;
```

---

## 6. API surface

```
POST   /api/auth/register          invite_code, handle, password
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/me

GET    /api/hoods                  25 Hoods + owner, photo type, value, lock + reinforce state
GET    /api/hoods/:id              detail + claim history + current photo
POST   /api/hoods/:id/claim        multipart: photo, declared_type
GET    /api/hoods/:id/history

GET    /api/leaderboard?season=    current season standings
GET    /api/leaderboard/champion   all-season totals
GET    /api/seasons                schedule + which is active

GET    /api/hoods/:id/parks        Parkemon: every park in a Hood + your collection state
GET    /api/parks/:id             one park + whether you can collect it
GET    /api/parks/:id/check       dry run
POST   /api/parks/:id/collect     multipart: photo of the sign
GET    /api/cards?season=         your binder
GET    /api/cards/:claimId        one card

GET    /api/feed                   recent claims, paginated
POST   /api/claims/:id/flag        reason
DELETE /api/claims/:id/flag        let people withdraw a flag

GET    /api/chat?before=           message history, paginated
WS     /ws                         chat + live hood_changed / claim_created events
```

One endpoint handles all three actions — the server infers `claim_kind` from who holds the
Hood. Validate in this order, returning a specific error code for each failure so the UI
can reject before wasting the upload:

| Code | Condition |
|---|---|
| `HOOD_LOCKED` | Steal attempted inside the 12h cooldown |
| `ADJACENT_COOLDOWN` | Conquer attempted on a Hood bordering one you conquered in the last 24h — returns the eligible timestamp and the Hood responsible |
| `REINFORCE_TOO_SOON` | Own Hood, less than 72h since `last_claim_at` — return the eligible timestamp |
| `WEAK_TYPE` | Declared subject does not beat the current holder's (applies to steal *and* reinforce) |
| `SAME_TYPE` | Declared subject equals the current holder's |

The client should know all of this before the file picker even opens: the Hood sheet
displays "needs an animal photo" or "reinforce available in 14h" up front.

---

## 7. Screens

1. **Map** — full-bleed Leaflet map, 25 Hoods filled in their owner's player colour,
   unclaimed Hoods in neutral grey with their point value at the centroid. Tap a Hood →
   bottom sheet with holder, their photo, the subject you need, and the action button,
   which reads **Conquer (+25)**, **Steal (+100)**, **Reinforce (+25)**, or a countdown.
2. **Capture** — camera launch, subject selector, target Hood confirmation.
3. **Standings** — current season table + Champion table, toggled.
4. **Feed** — reverse-chronological claims with thumbnails and a flag button on each.
5. **Chat** — persistent global room. Auto-post system messages for every claim:
   *"shinobi stole Hood 13 — Toronto Centre from kaz with an animal photo (+100)"*. This makes
   chat double as the activity feed and is most of the game's social energy. Post flags to
   chat too — visible accusations are the enforcement mechanism.
6. **Hood detail** — full claim history with every photo ever posted there. This becomes a
   genuinely nice artifact by the end of the year.

Design direction: dark UI, high-contrast player colours, map is the hero. Match the
ShinTech house style — pick an accent colour for this one the way the product pages each
have theirs.

A **reinforce-ready indicator** on the map is worth building: a subtle pulse on your own
Hoods once they cross 72 hours. It's free points sitting there, and players will forget.

---

## 8. Deployment

- systemd unit `cth.service` running `node server/index.js` on port 8096, `Restart=always`.
- nginx vhost proxying `/` → 8096 with `proxy_set_header Upgrade`/`Connection` for the
  WebSocket, and `client_max_body_size 60M` for drone files.
- Add `cth.shintech.online` as an ingress hostname on the existing Cloudflare Tunnel
  (`d8cc689f-a605-4400-95b8-b2e3b059e325`) → `http://localhost:8096`. WebSockets traverse
  the tunnel fine. Note the Cloudflare free-plan 100 MB request body cap — not a problem
  for stills.
- Nightly `sqlite3 .backup` of the DB plus an rsync of `/srv/cth/media` to wherever your Pi
  backups already go.
- Season rollover as a `node scripts/rollover.js` run by a systemd timer daily at 00:05
  Toronto time; it checks whether the active season has ended, and if so flips the season,
  applies the +25 escalation to `ever_conquered = 0` Hoods, and posts a system message to
  chat. Make it idempotent via `escalation_applied`.

---

## 9. Build order

1. Schema + auth + invite codes.
2. `import-hoods.js`, and a map screen that renders all 25 Hoods correctly.
3. The claim endpoint with the full state machine — conquer / steal / reinforce, cooldowns,
   counter rule. Test it via curl before any capture UI exists. **This is the core of the
   app**; everything else is presentation.
4. Capture flow on a real phone. Budget time for HEIC.
5. Chat + WebSocket + system messages.
6. Flags and reversal.
7. Standings, feed, Hood detail.
8. Season rollover timer.

Ship 1–5 and play a weekend on it before building the rest. The rules will change once you
see how people actually behave.

---

## 10. Open decisions

- **Reinforce farming.** 25 points per Hood per 72 hours is 750 points per Hood over a
  90-day season if somebody actually grinds it. Holding four nearby Hoods and rotating
  through them is worth ~3,000 points a season for zero risk. That may be exactly the
  "defend your turf" incentive you want, or it may quietly make aggression pointless. Watch
  it in Season 1; the levers if it distorts are a longer gate (96h/7d) or a cap on
  reinforce points per season.
- **Steal cooldown** — 12h default. Without one, two players will trade the same Hood back
  and forth all afternoon.
- **Adjacent-conquer cooldown** — 24h default. Watch whether it over-corrects. It bites
  unevenly by geography: Rouge Park borders only two Hoods, Don Valley West borders seven,
  and the dense downtown Hoods have few neighbours each — so a walker downtown is barely
  inconvenienced while someone working the inner suburbs is heavily gated. If it turns out
  to punish walkers more than pilots, the levers are a shorter window or counting only
  Hoods conquered on the same day.
- **Escalation cap** — with difficulty as the floor, an untouched Rouge Park reaches 125
  by Season 4 while an untouched University-Rosedale reaches 80. `CTH_ESCALATION_CAP`
  clamps the top if that runs away.
- **Difficulty weighting** — 65% distance, 35% isolation. Worth revisiting after a season
  of watching where people actually go. If everyone ignores the middle of the map, the
  distance term is too weak; if nobody ever leaves Scarborough, it is too strong.
- **Does the steal multiplier want to be 2?** At 2 the ceiling lands neatly on the old
  flat 100, and aggression pays double picking up the same Hood free. Raising it makes
  the game about fighting over held Hoods rather than expanding into empty ones.
- **Flag threshold** — 2 corroborating flags reverts. With a small group this is a low bar;
  consider requiring the flaggers to be neither the claimant nor the displaced holder, so a
  grudge pair can't revert at will.
- **Shot-data panel** — read-only EXIF display to inform disputes, or leave it fully blind.
- **Do parks swamp territory?** 1,513 parks at 5–100 points each is a far bigger pool than
  25 Hoods, and an afternoon of walking a dense Hood could out-earn a hard-won steal. The
  levers, if it distorts: scale park values down, cap park points per season, or count
  them toward a separate Parkemon standing rather than the main total. Watch it in
  Season 1 — it is the single most likely thing about this build to need rebalancing.
- **Subject edge cases** — a storefront with a dog outside it satisfies two subjects at
  once, and the declaring player picks whichever is tactically useful. That is either a
  fun bit of angle-shooting or the thing that makes every claim a dispute. Watch it in
  Season 1; the lever if it distorts is a stated convention that the subject must fill the
  frame.
