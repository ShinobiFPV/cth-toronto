# ParkeMans GO! — Build Spec

A photo game for a small private friend group, in two halves.

**Parkemans** (§1.8) is the half it ended up named after: every Toronto park has the same
municipal sign with its name on it, there are 1,513 of them, and photographing one
collects that park and prints you a collectable card. Nobody competes over parks.

**Capture the Hood** (§1.1–1.7) is the other half, and the game's original name: players
conquer Toronto's 25 city wards ("Hoods") by posting recent photos taken inside them,
with a rock-paper-scissors layer based on what the photo is *of*. Points from both halves
land in the same total.

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
  `ADJACENT_CONQUER_COOLDOWN_HOURS` (default **6**, originally 24). This is the anti-drone lever: from
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

### 1.4a Captions

Every uploaded photo can carry one line of the player's own prose — territory claims and
Parkemans collections alike. Optional, free text, capped at `CAPTION_MAX_LENGTH` (200).

- **Written at upload time**, in the capture sheet once there is a photo to caption, and
  **editable afterwards by its author** — the only thing in the game a player can change
  after the fact. A caption you can't fix a typo in is a caption nobody writes.
- **It goes to chat with the claim**, quoted like a flag's reason. Chat is the activity
  feed (§7); announcing the claim but dropping the one line the player actually wrote
  would be the wrong half. An *edit* posts nothing — an edit is not an event.
- **On a park card it is the flavour text**, along the bottom edge, where a real
  collectable card puts it.
- Whitespace is collapsed to a single line, because a caption renders next to a thumbnail
  and inside a one-line chat message. Empty is stored as `NULL`, never as `''`.
- It **scores nothing**. No points, no XP, no bearing on ownership, cooldowns, or the
  counter rule. Nothing in the state machine reads it.

Stored on `photos.caption`, not on `claims`. The ledger is append-only and only ever
UPDATEs `status` and `flag_count`; an editable field has no business in it. A reversal row
carries no photo, so it cannot be captioned (`NO_PHOTO`), and only the author can write
one (`NOT_YOUR_CLAIM`) — including on a claim that has since been superseded or reverted,
since the photo is still theirs and still in the feed.

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

## 1.8 Parks, and the cards they print

A sub-game inside every Hood, and the only part of the game that nobody competes
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

Reached from the map: tap a Hood, then **Collect parks** on its sheet. That
opens the ~60 parks in that Hood as a list sorted by value, or as pins on a map.

**Cards and binders are public.** Any player can open any other player's binder, and any
card is viewable from the feed or a Hood's history by tapping the collection that printed
it. This follows from the sub-game's one rule: nobody competes over parks, so a card in
somebody's binder takes nothing from anybody, and there is nothing to gain by hiding it.
What is left is the part of a card game that is actually fun — seeing what everybody else
pulled. Two players who collect the same park in the same season get visibly different
cards, so a shared park is a comparison rather than a duplicate.

### 1.8b Special editions

A card's **rarity** comes from its park's value: how far out it is, knowable before you
leave the house, and the same for everybody who collects it. A card's **edition** is the
opposite — pure chance, rolled the moment the photo lands, and the reason it is worth
photographing a park somebody else already has.

| Edition | Chance | XP | Notes |
|---|---|---|---|
| Steel | 1 in 10 | +15 | brushed grey frame |
| Gold | 1 in 40 | +40 | gold frame, stronger foil |
| **Hologram** | 1 in 150 | **+100** | full spectrum, animated, **one per Hood per season** |

Everything about the design follows from two rules:

- **Editions pay XP, never points.** Points are the season race, and a race decided by
  dice is not a race. XP is lifetime and never resets (§1.9), so a lucky pull is a
  permanent little keepsake that leaves the table alone. A hologram is worth as much XP
  as walking into a Hood for the first time; there are at most 25 of them in a season.
- **The roll uses fresh randomness, not `card_seed`.** Deriving it from the seed would
  have been tidier, but the seed is `sha256('cth-parkemon:player:park:season')` and that
  salt is in a public repo — anybody could precompute which parks would hand them a Gold
  this season and go collect exactly those. A chance prize you can shop for is not a
  chance prize. So the edition is rolled with `crypto.randomInt` and frozen onto
  `claims.edition`, as immutable as `points_awarded`.

The hologram cap is checked inside the collection's transaction, so two simultaneous
collections cannot both mint a Hood's last one. It is **global rather than per player**:
once Hood 13's hologram is out there, it is out there. That is the only scarce thing in a
sub-game that otherwise has nothing to fight over, and nobody loses anything when
somebody else pulls it — a Hood whose hologram has gone still yields Gold and Steel,
because a hit falls through to the next edition down rather than being thrown away. A
hologram reverted by flags frees its Hood again, like every other kind of claim.

Editions travel with the card when it is traded (§1.8a): the edition belongs to the card,
the XP stays with whoever pulled it.

### 1.8a Trading

Players trade cards. **A trade moves the card and never the score**, and everything else
about the design follows from that one line.

- `points_awarded` and `xp_awarded` stay on the claim, with whoever earned them by
  walking to the park. If they moved, six friends handing each other 100-pointers would
  be a points laundry and the season table would stop meaning anything. XP is worse
  still: §1.9 defines it as how long you have been doing this, and trading away your own
  activity is not a coherent idea.
- So holding is tracked in `card_holdings`, not by reassigning `claims.player_id` —
  mutable state beside the append-only ledger, the same relationship `hood_state` has
  with `claims`. The table is **sparse**: a row exists only for a card that has moved,
  so the holder of a card is `COALESCE(card_holdings.holder_id, claims.player_id)`.
- **A binder shows what you hold; the summary shows what you collected.** After a trade
  those are different questions, and both are worth showing — one is your shelf, the
  other is what scored. A card keeps the collector's name on it, because that is who
  actually went there.
- **Duplicates are allowed.** In a card game duplicates are the entire currency of
  trading. What stays capped is *collecting*: still once per park per season per player.

An offer is one card for one card, or one card for nothing, which is a **gift**. Nothing
is escrowed — both cards stay where they are until the offer is accepted, and accepting
re-checks both holdings inside its transaction. The preflight is a courtesy, the accept
is the ruling, exactly as with a claim. An offer whose cards have moved on becomes
**stale** rather than sitting pending forever.

| Code | Condition |
|---|---|
| `CARD_NOT_HELD` | offering a card you do not hold, or asking for one they do not |
| `CARD_REVERTED` | the group threw that photo out, so it is not a card |
| `TRADE_WITH_SELF` | not a trade |
| `TRADE_ALREADY_OFFERED` | that exact offer is already on the table |
| `TRADE_NOT_PENDING` | already accepted, declined, withdrawn or lapsed |
| `NOT_YOUR_TRADE` | accepting or declining somebody else's offer |
| `TRADE_STALE` | a card in the offer has since moved on |

Offers and acceptances post to chat, because chat is the activity feed and, for six
players with no push notifications, it is also how anybody learns an offer is waiting.
Declines and withdrawals do not: a public "X said no to Y" is not something this game
needs.

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

## 1.9 XP and levels

Season points answer *who is winning right now*. XP answers *how long have you been doing
this*, and it is deliberately a different axis:

- **points** scale with **value** — a hard Hood, a far park, a steal off somebody
- **XP** scales with **activity and novelty** — showing up, and going somewhere new

So a player who farms four easy Hoods near home can out-point somebody in a season and
still be a lower level than the person who has been everywhere once.

**XP never resets.** Not at a season rollover, not ever. That is not a feature that had to
be built: XP is derived from the claims ledger exactly like points are, with `xp_awarded`
frozen onto each row when it lands, and nothing anywhere filters it by `season_id`. There
is no counter to drift. A claim reverted by flags loses its XP with its points, because
`status != 'reverted'` is the only filter applied.

### The schedule

| Action | XP |
|---|---|
| Steal | 70 |
| Conquer | 50 |
| Reinforce | 20 |
| Collect a park | 10 + rarity (0 / 5 / 15 / 30) |
| **A special edition** | **+15 Steel / +40 Gold / +100 Hologram** (§1.8b) |
| **First time ever in a Hood** | **+100** |
| **First time ever at a park** | **+15** |

The discovery bonuses are the reason XP is not just a rename of the Champion total: they
pay you to see the city rather than to farm the corner you already know. They are
per-player and lifetime — everyone gets their own first visit, and a claim reverted by
flags makes that Hood undiscovered again.

### The curve

XP required to have reached level *L* is **20 × L × (L−1)**:

| Level | XP | Title |
|---|---|---|
| 1 | 0 | Tourist |
| 2 | 40 | Tourist |
| 5 | 400 | Local |
| 10 | 1,800 | Regular |
| 15 | 4,200 | Fixture |
| 20 | 7,600 | Institution |
| 30 | 17,400 | Landmark |
| 40 | 31,200 | Legend |
| 55 | 59,400 | Mythic |

Triangular rather than exponential, so it keeps being reachable, and **uncapped** — there
is no final level, because "persistent forever" was the brief. Level 2 costs less than one
conquer, so the first level-up is immediate; by level 30 you are looking at roughly a year
of keen play.

A level-up is not an event that gets stored. It is the observation that the derived level
is higher after a claim than it was before — see `withLevelUp()` — and it announces itself
in chat like everything else in this game.

### Data

```sql
claims(... xp_awarded)   -- frozen at claim time, immutable, never season-scoped

-- lifetime XP
SELECT SUM(xp_awarded) FROM claims WHERE player_id = ? AND status != 'reverted';
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
  caption,                       -- §1.4a: the player's own line. Editable, so it lives
                                 --   here and not on the append-only claims row.
  created_at
)

card_holdings(                   -- §1.8a: who holds a traded card. Sparse: a row
  claim_id, holder_id,           --   exists only for a card that has moved, so the
  from_player_id, acquired_at    --   holder is COALESCE(holder_id, claims.player_id).
)

trades(                          -- offers. Append-only apart from status.
  id, from_player_id, to_player_id,
  offer_claim_id, want_claim_id, -- a null want side is a gift
  message, status,               -- pending | accepted | declined | cancelled | stale
  created_at, resolved_at
)

claims(                          -- append-only ledger; never UPDATE points
  ...                            -- §1.8b: `edition` is null | steel | gold | hologram,
  edition,                       --   rolled by chance at collection time and frozen
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
POST   /api/hoods/:id/claim        multipart: photo, declared_type, caption (optional)
GET    /api/hoods/:id/history

GET    /api/leaderboard?season=    current season standings (carries xp/level/title)
GET    /api/leaderboard/champion   all-season totals
GET    /api/seasons                schedule + which is active

GET    /api/parks/map              every park in the city + what you have collected (~70 kB)
GET    /api/hoods/:id/parks        every park in a Hood + your collection state
GET    /api/parks/:id             one park + whether you can collect it
GET    /api/parks/:id/check       dry run
POST   /api/parks/:id/collect     multipart: photo of the sign, caption (optional)
GET    /api/cards?season=&player= a binder — yours by default, anybody's with ?player=
GET    /api/cards/:claimId        one card, whoever collected it (the feed opens these)

GET    /api/trades                 offers you are part of, incoming and outgoing
POST   /api/trades                 to_player_id, offer_claim_id, want_claim_id?, message?
POST   /api/trades/:id/accept      recipient only; re-checks both holdings (§1.8a)
POST   /api/trades/:id/decline     recipient only
DELETE /api/trades/:id             withdraw your own offer

GET    /api/feed                   recent claims, paginated
PUT    /api/claims/:id/caption     caption — author only; empty clears it (§1.4a)
POST   /api/claims/:id/flag        reason
DELETE /api/claims/:id/flag        let people withdraw a flag

GET    /api/chat?before=           message history, paginated
WS     /ws                         chat + live hood_changed / claim_created / caption_changed
```

One endpoint handles all three actions — the server infers `claim_kind` from who holds the
Hood. Validate in this order, returning a specific error code for each failure so the UI
can reject before wasting the upload:

| Code | Condition |
|---|---|
| `HOOD_LOCKED` | Steal attempted inside the 12h cooldown |
| `ADJACENT_COOLDOWN` | Conquer attempted on a Hood bordering one you conquered inside the cooldown — returns the eligible timestamp and the Hood responsible |
| `REINFORCE_TOO_SOON` | Own Hood, less than 72h since `last_claim_at` — return the eligible timestamp |
| `WEAK_TYPE` | Declared subject does not beat the current holder's (applies to steal *and* reinforce) |
| `SAME_TYPE` | Declared subject equals the current holder's |

The client should know all of this before the file picker even opens: the Hood sheet
displays "needs an animal photo" or "reinforce available in 14h" up front.

---

## 7. Screens

0. **Sign in** — the wordmark and nothing else to look at.
1. **Map** — full-bleed Leaflet map, 25 Hoods filled in their owner's player colour,
   unclaimed Hoods in neutral grey with their point value at the centroid. Tap a Hood →
   bottom sheet with holder, their photo, the subject you need, and the action button,
   which reads **Conquer (+25)**, **Steal (+100)**, **Reinforce (+25)**, or a countdown.
2. **Capture** — camera launch, subject selector, target Hood confirmation. The action
   button sits in a **sticky footer** at the bottom of the sheet: the content above it
   varies in height (preview, caption, banners) and on a small phone the button
   otherwise falls off the bottom edge, where it is technically scrollable to and
   practically invisible.
3. **Standings** — current season table + Champion table, toggled.
4. **Feed** — reverse-chronological claims with thumbnails and a flag button on each.
5. **Chat** — persistent global room. Auto-post system messages for every claim:
   *"shinobi stole Hood 13 — Toronto Centre from kaz with an animal photo (+100)"*. This makes
   chat double as the activity feed and is most of the game's social energy. Post flags to
   chat too — visible accusations are the enforcement mechanism.
6. **Hood detail** — full claim history with every photo ever posted there. This becomes a
   genuinely nice artifact by the end of the year.
7. **Cards** — the binder, reachable from the tab bar because the collection is what the
   app is named after. Anybody's binder (§1.8), and the way into offers (§1.8a).
8. **Offers** — incoming and outgoing trades.

The map also carries **every park in the city as a dot** once you zoom past the whole-city
view: the accent for one you have not collected this season, **green** and a shade larger
for one you have. The
legend's park count doubles as the switch that hides them. They are deliberately not
tappable — tapping a Hood is the map's one interaction, and 1,513 hit targets laid over it
would fight with that.

The tab bar is Map / Cards / Feed / Standings / Chat, and carries two badges: unread chat,
and trade offers waiting on you. The offers badge is fed by `trades_pending` on `/me` and
moves the moment an offer arrives over the WebSocket — with six players and no push
notifications, a badge is the only way somebody learns an offer is sitting there.

Design direction: dark UI, high-contrast player colours, map is the hero. Match the
ShinTech house style — pick an accent colour for this one the way the product pages each
have theirs. (Amber was the pick; it is now the *default* rather than the only option —
see §7.1.)

A **reinforce-ready indicator** on the map is worth building: a subtle pulse on your own
Hoods once they cross 72 hours. It's free points sitting there, and players will forget.

### 7.1 Appearance

Two controls on the profile screen: **mode** (System / Light / Dark) and **accent** (eight
swatches). Both are cosmetic, both are per-device, and neither touches the game.

- **Light mode is not a second design.** It is the original ShinTech house style — Arctic
  Classified on paper: off-white desk, white panels, 2px black ink borders, hard offset
  shadows. Dark is the after-dark variant the app was built in. The chrome bars stay black
  in both, so the header and tab bar are the one constant.
- **The accent only ever dresses the chrome.** Player colours are handed out by the server
  and are unaffected, so nobody's territory can be recoloured out from under them — which
  also means the accent can never be confused with a player.

Implemented as CSS custom properties on `:root`, with a `[data-theme="light"]` block
overriding the tokens. Switching mode is one attribute; there is no second stylesheet and
no per-component branching. `applyAppearance()` runs before React mounts, so there is no
flash of the wrong theme. `system` subscribes to `prefers-color-scheme` and follows the OS
live. Stored in `localStorage` under `cth.appearance` — appearance belongs to the screen
you are looking at, not to your account, and never reaches the server. Every read and
write is wrapped, because a private window throws on access rather than returning null.

**An arbitrary accent has to stay readable, and that is the actual work.** Hazard amber is
perfect on black and 1.83:1 on white — unusable as text. So an accent is not one colour
but five derived ones (`web/src/lib/theme.js`):

| Token | What it is |
|---|---|
| `--accent` | the raw hex — fills, borders, and text on the black chrome |
| `--accent-rgb` | channels, for `rgba()` tints |
| `--accent-text` | the same hue pushed until it clears **6:1** on this theme's paper |
| `--accent-deep` | darkened, for the hard offset shadow under a primary button |
| `--accent-ink` | black or white for a label sitting **on** an accent fill |

Two of those are load-bearing in ways that are easy to get wrong:

- `--accent-text` targets 6:1 rather than the 4.5:1 minimum on purpose. Accent text is
  often small and does not always sit on pure white — the off-white desk and the
  accent-tinted "this is you" row each eat about half a point.
- `--accent-ink` is chosen by **measuring** both candidates, not by a luminance threshold.
  A `> 0.45` split picks white for every mid-tone and puts 2.57:1 labels on the teal
  button. Black wins much further up the scale than it looks like it should.

The same maths, at 4.5:1, is applied to player colours as `textSafe()` — but only to the
Hood **number** drawn on the map. Territory fills keep the exact colour the server sent.

Verified with a Puppeteer pass that walks every screen in both themes with several
accents, composites `rgba()` layers over their ancestors, and checks every text node
against WCAG AA. The colour maths itself is unit-tested in `test/theme.test.js`.

---

## 8. Deployment

- systemd unit `cth.service` running `node server/index.js` on port 8096, `Restart=always`.
- nginx vhost proxying `/` → 8096 with `proxy_set_header Upgrade`/`Connection` for the
  WebSocket, and `client_max_body_size 60M` for drone files.
- Add `cth.shintech.online` as an ingress hostname on the existing Cloudflare Tunnel
  → `http://localhost:8096`. WebSockets traverse
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
- **Adjacent-conquer cooldown** — **settled at 6h**, down from the 24h it launched with.
  This section predicted the failure: "if it turns out to punish walkers more than
  pilots, the levers are a shorter window or counting only Hoods conquered on the same
  day." It did, and the shorter window is the lever that was pulled. A full day meant two
  adjacent Hoods could not be walked in one afternoon, which gated exactly the people the
  rule was never aimed at; six hours still stops one drone flight becoming a contiguous
  block, and opens the neighbour up by the evening. It remains uneven by geography —
  Rouge Park borders two Hoods, Don Valley West borders seven — which is inherent to
  using real adjacency and is the price of the rule meaning anything.
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
- **Does XP want to unlock anything?** Right now a level is a title and a number, and
  nothing mechanical hangs off it — deliberately, because a level that granted an in-game
  advantage would compound and the early joiners would never be caught. If it ever should
  do something, cosmetic is the safe direction: a card frame, a map colour, a chat flourish.
- **Do parks swamp territory?** 1,513 parks at 5–100 points each is a far bigger pool than
  25 Hoods, and an afternoon of walking a dense Hood could out-earn a hard-won steal. The
  levers, if it distorts: scale park values down, cap park points per season, or count
  them toward a separate Parkemans standing rather than the main total. Watch it in
  Season 1 — it is the single most likely thing about this build to need rebalancing.
- **Subject edge cases** — a storefront with a dog outside it satisfies two subjects at
  once, and the declaring player picks whichever is tactically useful. That is either a
  fun bit of angle-shooting or the thing that makes every claim a dispute. Watch it in
  Season 1; the lever if it distorts is a stated convention that the subject must fill the
  frame.
