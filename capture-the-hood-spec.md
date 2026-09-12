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

### 1.3 The three claim actions

**Conquer** — target Hood is unclaimed. Any photo subject works. Awards the Hood's current
`unclaimed_value` (25 in Season 1, escalating — see 1.5).

**Steal** — target Hood is held by another player. Your photo subject must *beat* theirs.
Awards **100 points**.

**Reinforce** — target Hood is held by *you*, and at least **72 hours** have passed since
its last claim of any kind. You must upload the photo subject that beats your own current
photo. Awards **25 points**, flat, forever — this value never escalates across seasons.

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
  increased by 25.
- Reinforce stays at 25 and steal stays at 100. Neither escalates.

So a Hood untouched all game is worth 25 → 50 → 75 → 100. Note that by Season 4 an
untouched Hood is worth exactly as much as a steal — that's intentional, it's what finally
makes someone drive out to Rouge Park in February.

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

Port **8094**. (The spec originally called for 8093, but MedFam already listens there
and it is also `shinnode`'s documented default; 8091 is Site Editor, 8092 is
shintech-forms.)

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
  unclaimed_value      -- INTEGER, starts at 25
)

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

- systemd unit `cth.service` running `node server/index.js` on port 8094, `Restart=always`.
- nginx vhost proxying `/` → 8094 with `proxy_set_header Upgrade`/`Connection` for the
  WebSocket, and `client_max_body_size 60M` for drone files.
- Add `cth.shintech.online` as an ingress hostname on the existing Cloudflare Tunnel
  (`d8cc689f-a605-4400-95b8-b2e3b059e325`) → `http://localhost:8094`. WebSockets traverse
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
- **Escalation cap** — an untouched Hood hits 100 in Season 4, equal to a steal. Leave it,
  or cap at 75.
- **Flag threshold** — 2 corroborating flags reverts. With a small group this is a low bar;
  consider requiring the flaggers to be neither the claimant nor the displaced holder, so a
  grudge pair can't revert at will.
- **Shot-data panel** — read-only EXIF display to inform disputes, or leave it fully blind.
- **Subject edge cases** — a storefront with a dog outside it satisfies two subjects at
  once, and the declaring player picks whichever is tactically useful. That is either a
  fun bit of angle-shooting or the thing that makes every claim a dispute. Watch it in
  Season 1; the lever if it distorts is a stated convention that the subject must fill the
  frame.
