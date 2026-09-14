# Park-E-Mans GO! — Build Spec

A photo game for a small private friend group, in two halves.

**The parks** (§1.8) are the half it ended up named after: every Toronto park has the same
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
park collections alike. Optional, free text, capped at `CAPTION_MAX_LENGTH` (200).

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
- **Park points are capped per player per Hood** — `PARK_HOOD_CAP` (300) per **week** by
  default, or per season with `CTH_PARK_CAP_PERIOD=season`. Past a Hood's ceiling a collection
  still succeeds — card, edition, XP — worth **0 points and no item**. To keep earning, go to
  a different Hood. Same machinery as the car cap: `spent = SUM(points_awarded)` over this
  player's park claims in this Hood for the period, `award = min(park value, cap − spent)`,
  computed in `evaluateCollect()` and re-run inside `commitCollect()`'s transaction. Not an
  error: there is no `HOOD_CAP_REACHED` code, and the Hood sheet says "XP only" before the
  shutter. A reverted collection gives its capacity back. Park claims carry `week_key` for
  this; the ones collected before it existed were backfilled from `created_at`.
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

| Edition | Chance | Under Clover | XP | Items | Notes |
|---|---|---|---|---|---|
| Steel | 86% (the remainder) | 72% | +15 | none | brushed grey frame |
| Gold | 12% | 24% | +40 | 1 | gold frame, stronger foil |
| **Hologram** | 2% | 4% | **+100** | 3 | full spectrum, animated |

Every card is at least Steel. Special cards — Gold and Hologram — are deliberately common,
about one collection in seven, and **no edition is capped anywhere**. What is scarce is the
power they carry: items (§1.8d), which have a weekly cap of their own.

The roll is **one draw mapped to ranges**, not three sequential one-in-N checks: a draw in
`[0, 1,000,000)` against cumulative bounds laid out rarest first. Sequential checks make
Clover's "double the specials" arithmetic hard to reason about and harder to test. Gold and
Hologram percentages live in `server/config.js`; Steel is not configured, it is whatever
remains, so the table can never sum to anything but 100. Under Clover the specials double
and are clamped so they can never ask for more than the whole draw.

Everything about the design follows from two rules:

- **Editions pay XP, never points.** Points are the season race, and a race decided by
  dice is not a race. XP is lifetime and never resets (§1.9), so a lucky pull is a
  permanent little keepsake that leaves the table alone. A hologram is worth as much XP
  as walking into a Hood for the first time.
- **The roll uses fresh randomness, not `card_seed`.** Deriving it from the seed would
  have been tidier, but the seed is `sha256('cth-parkemon:player:park:season')` and that
  salt is in a public repo — anybody could precompute which parks would hand them a Gold
  this season and go collect exactly those. A chance prize you can shop for is not a
  chance prize. So the edition is rolled with `crypto.randomInt` and frozen onto
  `claims.edition`, as immutable as `points_awarded`.

**There used to be a cap of one hologram per Hood per season. It is gone.** At 2% uncapped
a keen player pulls roughly eight a season, so Holograms go from genuinely scarce to about
one every ten days each — still special, no longer the thing you show people. If a prestige
tier is wanted back, the lever is a fourth edition above Hologram rather than re-capping it.

`EDITIONS` stays ordered rarest-first and `rollEdition()` keeps its fall-through path even
though nothing exercises it now: it takes an optional `capped(key)` hook, and a hit on a
capped edition lands on the next edition down, never below Steel. Putting a cap back is a
config change rather than a rewrite, and one test drives the path with a synthetic cap so
it does not rot before then.

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

## 1.8c Car cards

Photograph cars on the street. The server identifies the vehicle with a Claude vision call
and prints a card — its face is the **Not Wheels** design — which goes in the same **binder**
as your park cards. There is one binder, holding every kind of card (see *One binder, every
kind of card* below).

- **Points** — a flat **5** per car, capped at **100 per player per week** (20 scoring cars).
- **XP** — by edition, flat and rising, **never capped**.
- **Past the weekly cap you keep collecting.** The card mints, the edition rolls, the XP
  lands, and the claim is worth 0 points. Being over the cap is a success, never an error —
  there is no `WEEKLY_CAP_REACHED` code.

Architecturally boring on purpose. A flat value with a cap is fully knowable at claim time,
so `points_awarded` is computed once inside `commitCar()` and frozen like every other claim.
No second scoring path, nothing scheduled, and `SUM(points_awarded)` is still the whole story.

### The week

Weeks start **Monday 00:00 America/Toronto** (`CTH_WEEK_START`; the older
`CTH_CAR_WEEK_START` still works). The same week is used by every weekly cap in the game —
cars, the per-Hood park cap and items. A **week key**
(`2026-W38`, ISO numbering) is computed at claim time with a real timezone conversion and
stored on the claim, so the cap is an exact string match and a sum:

```
spent     = SUM(points_awarded) over this player's car claims
            WHERE week_key = <current> AND status != 'reverted'
remaining = max(0, CAR_WEEKLY_CAP - spent)
award     = min(CAR_POINTS, remaining)
```

`min()` rather than an all-or-nothing test, so a cap that does not divide by the value is
neither overshot nor short-changed. `commitCar()` re-runs the evaluation inside its
transaction: two collections racing at 95 spent cannot both be awarded 5. A reverted claim
gives its slot back. The week key is independent of the season — a week straddling a
rollover splits its 100 across both, and each claim scores in the season it was made.

A calendar week gives the game a rhythm: capacity resets Monday, and Sunday night is the
scramble. By midseason the binding limit is not the cap but the dedupe rule — the hard part
becomes finding a car you have not got — so the cap matters most in the first weeks of a
season, which is exactly when a brake is wanted.

### Cars are claims

`claim_kind = 'car'`, `vehicle_id` set, `points_awarded` 5 or 0, `xp_awarded` from the
edition, `week_key` set, and the Hood it was snapped in recorded for the feed. **A car never
touches `hood_state`**, and does not count as having set foot in a Hood for the discovery bonus.

**Once per vehicle per player per season**, enforced in `evaluateCar()` and by a partial
unique index that excludes reverted rows, so a card the group throws out frees the vehicle
up again. A repeat is `ALREADY_COLLECTED` and mints nothing. `CTH_CAR_REPEAT_XP` turns on a
small trickle instead — a `sighting` claim worth that much XP, once per vehicle per week,
never a second card.

### Editions

The same `rollEdition()` as a park card — the same table, Clover included — with fresh
randomness and never `card_seed`. Every card is at least **Steel** — plain stock is what
snapping a car is worth.

| Edition | Backing | XP | Items |
|---|---|---|---|
| Steel | plain stock | 25 | none |
| Gold | foil | 75 | 1 |
| **Hologram** | holographic, animated | **250** | 3 |

No edition is capped (there was once one car hologram per season; it went with the park
cap). The roll ignores the points cap — a hologram on your 40th car of the week is still a
hologram, which is what makes collecting past the cap worth doing — but a car worth 0 points
grants no items: no points, no items.

### Identification

Its job is the card face and the **dedupe key**. It does not touch scoring, so accuracy
barely matters for fairness and consistency matters enormously. The key is **make + model with
trim and generation stripped** — `honda|civic` is one card whether it was an Si or a base
sedan — normalised in `server/lib/vehicles.js` as a second line of defence behind the prompt.
Generation, trim and year ride on the claim as sighting detail.

```
upload → sharp → identify (2–5s) → evaluateCar() → commitCar()
```

The call runs in the route, never inside the transaction. Structured JSON output: `is_vehicle`,
`in_situ`, `make`, `model`, `generation`, `trim`, `year_range`, `body_style`, `confidence`,
and `plates`.

| Code | Condition |
|---|---|
| `IDENTIFY_UNAVAILABLE` | the identifier is down, disabled or has no key — nothing written, retry |
| `IDENTIFY_UNSURE` | confidence under `CTH_IDENTIFY_MIN_CONFIDENCE` or no model — try a better angle |
| `NOT_A_VEHICLE` | not a vehicle |
| `ALREADY_COLLECTED` | you have that car this season |
| `HOOD_REQUIRED` | the upload did not say which Hood |

`in_situ` false (a screen, a magazine, a diecast, game footage) **marks** the card for
flaggers and never rejects it. The honour system and flagging remain the enforcement model.
The identifier is swappable (`setIdentifier()`), so no test touches the network.

**Licence plates are blurred** in the display and thumbnail derivatives before the claim is
written (`CTH_CAR_BLUR_PLATES`), using the boxes the identifier returns, padded. A park sign is
nobody's; a plate is traceable to a person. The original, behind the login for disputes, is
left untouched. A blur that fails fails the collection rather than publishing the plate.

### The card

`NotWheelsCard.jsx`: a printed backing carrying the edition (plain stock, foil or
holographic), the "Not Wheels" mark over the vehicle's name in Inter Tight Bold, the photo
in a plain window, and a spec strip with make, model, year, Hood and date. Seeded from
(player, vehicle, season) like a park card; every colour a token. It began as a blister
pack — hang tab, punched slot, a plastic bubble over the photo — and the packaging was
removed because underneath it was already a card. No flame, no red and yellow, no
reproduction of anybody's trade dress.

The capture sheet shows **this week's capacity before the shutter** — `75 / 100 this week`, or
**XP only — resets Monday** — and says "Identifying…" across the round trip. It opens from the
map or from your own binder.

### One binder, every kind of card

Players collect **cards for their binder**, and a park card and a car card are two kinds of
that one thing. They were once separate — a binder for parks, a "Garage" with a "Case" for
cars — and that split is gone from the game, the copy and the API.

Every kind of card obeys the same rules: it is a row in `claims` whose `claim_kind` names the
kind, it never touches `hood_state`, its holder is `COALESCE(card_holdings.holder_id,
claims.player_id)`, it rolls an edition, pays XP, grants items only if it scored, and trades
without moving its points. Every card's shape carries `kind`, `claim_id`, `name`, `edition`,
`player`, `holder`, `traded` and `season`, whatever else it adds.

Because of that, everything that *reads* cards goes through one registry and never branches
on a kind:

- **Server** — `server/lib/collectables.js`. `GET /api/cards` returns every kind of card a
  player holds, newest first (`?kind=` narrows it), with a summary whose totals span every
  kind and whose `kinds` carry each kind's own detail (a park's set size, a car's weekly cap).
  `GET /api/cards/:claimId` resolves any kind. A trade side is the card itself. Every
  card-printing claim in the feed carries `card: { kind }`.
- **Client** — `web/src/lib/collectables.js`: each kind's face, icon, list tag, summary rows
  and optional collect flow. The binder, the card lightbox, the feed and trades render from it.

**Adding a kind of card** is its own module (collect flow, card shape, summary), a
`claim_kind`, and one entry in each registry. The binder, trading, the feed and the lightbox
do not change.

---

## 1.8d Items

Gold and Hologram pulls grant consumable **items** that bend the cooldowns and, in
Fortify's case, block a theft outright. **One item per Gold, three per Hologram.** Items
span the whole game, so they are their own module (`server/lib/items.js`) rather than part
of parks or cars.

### Where they come from, and where they stop

- **No points, no items.** A collection worth 0 — past the car cap, past a Hood's park cap —
  grants nothing, whatever edition it rolled.
- **A weekly item cap**, `ITEM_WEEKLY_CAP` (4), independent of any points cap. The park cap
  is per Hood, so a player who travels can keep earning in all 25; the item cap is the
  direct ceiling. Past it a Gold still mints a Gold with Gold XP and Gold treatment — only the
  grant is withheld, clamped with `min()` like every other cap (a Hologram with one slot left
  grants one), and chat says so plainly. Hitting the cap is announced once, the first time it
  withholds something that week. Card rate and item rate are now independent knobs.
- **Items follow the puller, never the card.** A grant carries the player who pulled it,
  permanently. A trade moves the card and nothing else — no points, no XP, no items — or
  two players could shuttle one Gold back and forth laundering them.
- A grant off a card later **reverted by flags** is void, and gives its weekly slot back.
- The item type is a weighted draw with fresh `crypto.randomInt`, never `card_seed`, or a
  player could read their next item off a card they already hold.

| Item | Effect | Spent | Weight |
|---|---|---|---|
| **Fortify** | Armed on a Hood you hold. The first steal attempt bounces off, and that attacker is shut out of that Hood for 1h | by the steal it stops | 10 |
| **Recon** | Reveals whether somebody else's Hood is fortified, before you travel | on use | 20 |
| **Crowbar** | Steal through the 12h post-handover lock on one Hood | by the steal it opens | 15 |
| **Sprint** | Conquer past your own 6h adjacency cooldown | by the conquer it opens | 20 |
| **Tune-Up** | Open the 72h reinforce gate on a Hood you hold, now | on use; the reinforce consumes its effect | 15 |
| **Clover** | Double the Gold and Hologram rates for 6h | on use | 20 |

Fortify is rarest because it is the only item that denies somebody else points; Clover is
commonest because it touches nobody. Deliberately not on the list: anything revealing
another player's inventory, anything that steals items, and anything faking a Hood's
subject to bait a wasted trip.

### Fortify

Pre-armed and **hidden**. The owner arms it on a Hood in advance; arming and disarming are
free, and only consumption spends it. One armed Fortify per Hood (`HOOD_ALREADY_ARMED`).
**Nobody but the owner ever sees it** — `/api/hoods` carries `viewer.fortified` for the
Hood's owner and omits the key entirely for everyone else. It persists until it fires, the
owner disarms it, the Hood goes back to somebody else by reversal, or the season ends.

Resolution happens last, inside `commitClaim()`, once a steal has passed every other check:
the Fortify is spent (an `item_uses` row naming the attacker), the attacker's photo is kept
and earns nothing, `hood_state` is untouched, and **no claim row is written** — the ledger is
for claims that happened, and the audit trail is the use row. It is not thrown as an error,
because a throw would roll back the very row that records it. The route answers 409
`FORTIFY_COOLDOWN` with `fortified: true`, and chat names the attacker, the defender and the
Hood but never the subject the attacker brought. The copy reads like getting caught: the
error is the only way an attacker learns a Fortify was there.

The **1h cooldown** is that attacker against that Hood only — not their other steals, not
other attackers. It is derived from the Fortify's own use row, exactly as the adjacency
cooldown is derived from the conquer that caused it: two per-player cooldowns of one shape,
and no third mechanism to shadow either.

### Crowbar and Sprint

Spent **as part of the claim they enable** — `use_grant_id` on `POST /api/hoods/:id/claim`
— so item and claim commit in one transaction. `evaluateClaim()` takes a `bypass` of
`{ lock }` or `{ adjacency }`, and nothing else is skipped. An item is spent only if the claim
lands *and* it actually opened something: a claim that fails validation costs nothing, and a
lock that ran out on the walk over leaves you your Crowbar. A crowbarred steal can still hit a
Fortify, which keeps the Crowbar, because the claim never landed. The Hood sheet offers each
item at the gate it opens (`viewer.bypassable_with`).

### Tune-Up

Spent against the Hood's current `last_claim_at`, which it records. The reinforce gate is open
while a Tune-Up exists for exactly that `last_claim_at`; the reinforce it enables moves
`last_claim_at` on, which is what uses it up. A reversal that rewinds `last_claim_at` brings it
back, correctly, since the reinforce it paid for was thrown out. It never writes `hood_state`.

### Clover

Doubles the special rates (§1.8b) for 6 hours. **An active Clover is derived, not stored:** a
`clover` use whose `expires_at` is still ahead. The collection reads the clock once and hands
the same instant to the Clover check, the roll and the grant, so a roll cannot straddle the
expiry. Rules:

- **Pulls inside a Clover window never grant Clover.** Roll from the other five instead.
  Without it the loop is self-sustaining.
- **No stacking.** A second Clover while one runs is `CLOVER_ACTIVE`, and is not spent.

Its real payoff is XP rather than items — a Gold pays ~3× Steel and a Hologram ~10× on a car —
so six doubled hours before a long walk are a genuine XP window, and before bed they are
nothing. The capture sheets count it down.

### Validation order

`evaluateClaim()` checks the time gates in a fixed order so a player gets one clear reason:
**post-handover lock → Fortify cooldown → adjacency → reinforce gate**, then the subject
counter, and a Fortify itself fires last of all in `commitClaim()`. (The items spec suggested
the counter first; the existing rule that a player who merely has to wait should not be told
their subject is wrong was kept.)

### Seasons

**Unspent items expire at rollover and armed Fortifies disarm.** No carry. Expiry is derived:
a grant is only spendable in the season it was granted in. The rollover disarms and posts a
chat message listing what expired per player, guarded by `seasons.items_expired` the way
escalation is guarded by `escalation_applied`, so a double run posts nothing twice.

### Data

Two append-only tables and one staging table. Inventory is grants minus uses, derived, never
stored; `grant_id UNIQUE` on `item_uses` makes spending a grant twice impossible at the schema
level.

```sql
item_grants(id, claim_id, player_id, season_id, week_key, item_type, created_at)
item_uses(id, grant_id UNIQUE, player_id, item_type, target_hood_id, target_player_id,
          expires_at,            -- Clover only, frozen when popped
          context_json, created_at)
item_armed(hood_id PRIMARY KEY, grant_id UNIQUE, player_id, armed_at)   -- Fortify only
```

| Code | Condition |
|---|---|
| `ITEM_NOT_HELD` | not yours, voided by flags, or from a season that has ended |
| `ITEM_ALREADY_USED` | spent already, or armed somewhere (disarm first) |
| `ITEM_WRONG_TARGET` | the wrong item for that action, or the wrong Hood for that item |
| `HOOD_ALREADY_ARMED` | that Hood already has a Fortify on it |
| `FORTIFY_COOLDOWN` | a steal on a Hood whose Fortify caught you in the last hour — or the one that just did |
| `CLOVER_ACTIVE` | a Clover is already running |

---

## 1.8e Location — Find a Park

An optional device location, used for two things: a **Find a park** list, and a dot on the
map. Neither is ever used to verify anything.

### Location never leaves the device

The nearest-park search runs **entirely on the phone**. The browser gets a fix, the client
already holds every park's position in `parks.index.json`, and haversine over 1,513 points is
sub-millisecond work. No endpoint takes a position, no request carries one, and nothing about
where anybody is ends up in a server log.

That matters more than it looks in a six-player game where one player runs the server: "the
app knows where I am" and "the admin's Pi has a record of where I was on Tuesday" are very
different things, and the second is easy to create by accident. It is also simply better — no
round trip on bad LTE, and it works offline.

It is enforced, not just intended. `server/lib/privacy.js` refuses, with `COORDINATES_REFUSED`,
any API request whose query or JSON body carries a key that looks like a coordinate (`lat`,
`lng`, `latitude`, `coords`, `accuracy`, …, at any depth) — so a "convenient" endpoint added
later fails loudly rather than quietly starting to collect positions.

(Photo EXIF, read for the shot-data panel in §1.7, is a separate and older matter: it rides
inside the image file. It is the obvious next place to look if this guarantee is ever
extended.)

### The park index

`web/public/parks.index.json`, one entry per park — `{"i":412,"n":"Trinity Bellwoods Park",
"h":9,"la":43.6469,"ln":-79.4131}` — about 100 kB, precached by the service worker. Generated
from the parks table by `scripts/build-park-index.js`, which `import-parks.js` runs after every
import, so it cannot drift from the game. Committed, like the Hood geometry.

### Asking, and failing

- **Never on load.** A prompt on cold start is dismissed on reflex, and once a browser has a
  denial recorded the app cannot ask again. The prompt is only triggered by tapping **Find a
  park** or the locate button — gestures where the reason is obvious.
- **HTTPS only.** Geolocation needs a secure context: `cth.shintech.online` is fine, the LAN
  address is not, and there it fails without saying so.
- **Every failure has a way forward.** Denied, timed out, unavailable, insecure or unsupported
  each get a short explanation — denial says where the setting lives — and a **Hood picker**
  that leads to the same parks by hand. Never an empty state.

### Find a park

One fix: `getCurrentPosition()` with `enableHighAccuracy: true, timeout: 10000, maximumAge:
30000` — at street level, GPS versus tower trilateration is the right park or the next one over.

The nearest **five** (`CTH_NEARBY_PARK_COUNT`), nearest first. Two rules make it worth opening
in October:

- **Uncollected by default.** Filtered to parks this player has not collected this season, with
  a toggle to show all. By midseason everything near home is in the binder.
- **Say which ones will score.** Each row shows its Hood and, where the per-Hood park cap is
  spent, a quiet **XP only** — the same `min()` the server's `parkAward()` uses, and
  `test/nearby.test.js` asserts the two agree for every row. That is what turns the cap from a
  confusing silence into a visible reason to travel.

Each row: name, distance, Hood, collected state, scoring state, and **Directions**, which hands
off to the phone's maps app (Apple Maps, a `geo:` URI, or Google Maps) — no routing is built.
Tapping a row flies the map there and shows a card with **Open park**. A fix worse than
`CTH_NEARBY_ACCURACY_WARN_M` (200 m) says so rather than returning five parks that may be wrong.

### The dot

`watchPosition()`, only while the map is up, in front, and the dot is switched on — it drains a
battery the way one fix does not. Stopped on leaving the map, on hiding the tab, and on turning
it off. Drawn as a marker plus an **accuracy circle**, because downtown GPS is routinely
±20–50 m and a precise dot would be a lie. It **never recentres on its own** — a map that
chases every update fights the player's panning — only when the locate button is tapped. The
dot is neutral (`--you`), never a hue a player or the accent could be wearing. **It shows you
only.** Live location is the one thing in this game that is not public, and there is no setting
to change that, so there is nothing to misconfigure.

### Placement

**Find a park** is a floating button beside **Snap a car**, bottom right — two primary buttons,
the limit before it would need a speed-dial. The locate button is small map furniture above
them, not a third primary action. None of it is on the Hood sheet.

### This is not verification

Location is a convenience. **Nothing gates a collection on proximity**, and nothing should:
the game is honour-based and enforced by flagging. "You must be within 100 m to collect" is a
very natural-looking next commit that would quietly replace the social system the whole game
rests on. There is a comment saying so in the code, for whoever is about to write it.

---

## 1.8f Sound

Sound effects and a map loop, with an admin board for swapping the files.

### Two systems

- **Effects** — short, overlapping, latency-sensitive. Decoded once into `AudioBuffer`s after the
  first tap and fired through `AudioBufferSourceNode`s. `new Audio()` lags and overlaps badly.
- **Music** — one 38-second loop through Web Audio with `loop = true`, the only way a loop has
  no seam.

Both run through a `GainNode` per channel, so the toggles are volume changes.

### The unlock

An `AudioContext` starts suspended and resumes only inside a real gesture, so the context is
resumed on **the first tap anywhere** in a session. Music cannot autoplay; a silent first moment
is correct. On an iPhone the **silent switch mutes Web Audio entirely** — the first thing to
check when somebody reports broken sounds, and said on the options screen.

### Two toggles

**Music** and **Sound effects**, separately: people want the Hologram sting while listening to
their own music. **Music defaults off, effects on.** Both persist per device and are read before
the first frame (`web/src/lib/audio.js` loads them at import, ahead of `createRoot`), so nothing
plays at the wrong level. Music plays while the map is on screen.

### The slots

Fixed, so the admin board is a stable list:

| Key | Fires on |
|---|---|
| `conquer` / `steal` / `reinforce` | the claim landing |
| `lost` | **your** Hood being taken, wherever you are in the app |
| `collect_park` / `collect_car` | a card printed |
| `edition_gold` / `edition_holo` | a Gold or Hologram pull, just after the card sound |
| `item_grant` | an item landing in your bag |
| `fortify_hit` | your Fortify stopping a steal (a `fortify_triggered` frame) |
| `fortify_blocked` | your steal bouncing off one |
| `trade` | a trade you are part of going through |
| `level_up` | a level threshold crossed |
| `chat` | a message from somebody else, quiet |
| `blocked` | a cooldown or a refused action |
| `rollover` | the season changing |
| `music_main` | the map loop |

`edition_holo` and `fortify_hit` carry the weight; everything else is short and quiet.

### The defaults

Synthesised by `scripts/make-sounds.js` from arithmetic — so the set is our own work, released
**CC0**, with the licence recorded per file in `defaults.json`. The repo is public; anything
CC-BY would drag an attribution obligation into it. AAC in `.m4a`, mono 96k for cues, stereo
128k for the loop, no leading silence, levels set per cue. The script writes WAVs and encodes
them if ffmpeg is present; otherwise it prints the commands (the Pi has ffmpeg).

### Admin swaps

**Pi-authoritative files plus a manifest, repo defaults as the fallback.**

- Defaults ship in the repo at `web/public/audio/` (served from `web/dist/audio/`).
- Overrides live in `CTH_AUDIO_DIR` — `/srv/cth/audio` on the Pi, beside the media, keeping the
  `cth` infrastructure name — which deploy never touches.
- `audio-manifest.json` there is the source of truth. A slot with no override resolves to the
  default; a slot with neither is silent; an unknown slot resolves to nothing.

The admin board, on the profile screen for `players.is_admin`: every slot with its source
(default or custom), **Preview** on each, **Replace** (uploaded, then transcoded on the Pi with
ffmpeg — loudness-normalised, leading silence trimmed from cues — so a 40 MB WAV never reaches a
phone), **Reset to default**, a **gain** slider, and a **licence** note. Uploads are capped at
`CTH_AUDIO_MAX_UPLOAD_MB` and the decoded duration is checked server-side: `CTH_AUDIO_MAX_DURATION_S`
for cues, `CTH_AUDIO_MAX_MUSIC_DURATION_S` for music.

| Code | Condition |
|---|---|
| `AUDIO_UNKNOWN_SLOT` | not one of the seventeen |
| `AUDIO_TOO_BIG` | over the upload cap |
| `AUDIO_TOO_LONG` | longer than the slot allows |
| `AUDIO_UNREADABLE` / `AUDIO_MISSING` | not audio, or no file |
| `AUDIO_TRANSCODER_MISSING` | ffmpeg is not installed on the server |

### The thing that would actually break

**The service worker caches audio.** Swap a file on the Pi and every phone keeps the old one,
possibly for weeks. So every URL names its bytes — `/audio/edition_holo.m4a?v=a1c3f9`, the
first eight hex of the file's sha256 — and a changed file is a URL no cache has seen. Audio is
never precached; it is cached at runtime, cache-first, which is safe only because the URLs are
versioned. `/audio/:slot.m4a` is `immutable` only when `?v=` matches the current hash and
`no-cache` otherwise. The manifest is fetched network-first with the last good copy as the
fallback, and its top-level `version` changes whenever any URL or gain would, so a client can
tell it needs to re-resolve without diffing. An admin change also broadcasts `audio_changed`.

---

## 1.8g Scavenger Blitz

A hunt is five things to find. Two kinds:

- **Park hunt** — five things in one park you pick: at least two amenities the park actually
  has (a third half the time, when it has three), the rest things any green space has — a
  bench, a big tree, a squirrel. At most two animals. The easy mode, made for doing with a kid.
- **Street hunt** — five passenger vehicles by make, model and year window: three common, two
  uncommon, from `server/data/hunt-vehicles.json` (versioned). Worth three times the XP.

Three hunts at a time, no time limit, and they survive season rollover. Reached from the
map's small **Blitz** button and the profile; the screen is `/hunts`.

### Generation

`server/lib/hunt-generate.js`, pure. A hunt is drawn from a fresh random seed and **frozen**:
every item's label is written onto its `hunt_items` row, so a hunt issued in October still
reads the same after the vehicle list changes. The seed is stored and regenerates the same
five items, which makes "why did I get this hunt" answerable. Pools are season-filtered —
no splash pad in winter, no rink or snow in summer — using the game season's name, or the
Toronto calendar between seasons.

**Amenities come from the City's data, never a model's guess.** A model asked to invent
items for a park by its name puts a splash pad in a parkette that is a bench and two trees,
and a child goes looking for it. `park_amenities` is rebuilt from `parks.amenities` — the
same `parks-and-recreation-facilities` records the parks came from, keyed by the same
ASSET_ID — by `import-parks.js`, by `scripts/import-amenities.js`, and on boot when it is
empty. A park with no amenity record still gets a full hunt from the universal pool. Ice
rinks, splash pads and wading pools are in the item pool but not in that dataset, so they
come up only if a later import adds them.

### Finding things

`POST /api/hunts/:id/submit` with one photo for one slot.

- **Park**: a vision call (`server/lib/hunt-verify.js`) asks whether the item is in the
  photo, generously. One billed call per photo.
- **Street**: the car identifier, with the slot's target named in the same call — one call,
  both answers. The slot ticks if the model says `target_match`, or if its identification
  matches the target: same make, the target's model anywhere in model, trim or generation,
  and an overlapping year window when it gave one.

**Confirm, don't gatekeep.** A photo the camera does not confirm is kept, and the sheet
offers **"I'm sure — mark it anyway"** (`POST /override`), which marks the item unverified,
flags it, and says so in chat. Once the hunt completes, its claim can be flagged like any
other. It never tells the player they were wrong.

**Hunt progress and card minting are independent.** A street photo also goes through the
ordinary car pipeline. A car already in the binder refuses with `ALREADY_COLLECTED` and the
slot still ticks; a car past the weekly car cap mints for 0 and the slot still ticks.

### Rewards

Completion writes a claim, `claim_kind = 'hunt'` with `hunt_id` set, so scoring, the feed,
chat, flags and reversal need no special cases. It never touches `hood_state`, and it uses
`hunt_id` rather than `park_id` so it cannot collide with the once-per-season park index.

| | |
|---|---|
| Points | `CTH_HUNT_POINTS` 10, clamped by `min()` against what is left of `CTH_HUNT_SEASON_POINTS_CAP` 200 |
| XP | 80 park, 240 street |
| Items | `CTH_HUNT_ITEMS` 3, source `hunt`, **exempt from the weekly item cap** |
| Cards | whatever the street photos mint through the normal pipeline |

**Rewards attribute to the season the hunt is completed in**, and that season's cap applies.

**The item problem, §5.2 of the draft, resolved as its recommendation:** hunt items do not
count against `CTH_ITEM_WEEKLY_CAP`. Instead the first `CTH_HUNT_WEEKLY_SCORING_LIMIT` (3)
completions a week score; past that a hunt completes for XP only — no points, no items. A
completion reverted by flags gives its place back.

Park hunt photos stay with the player: they are not on the claim, and the chat line carries
no thumbnails, unless `CTH_HUNT_PARK_PHOTOS_PUBLIC`. A five-photo log of a child's afternoon
in a park is a different thing from a binder. Street hunts post a strip of their five
thumbnails with the completion line.

### Slots and abandoning

`HUNT_SLOTS_FULL` past three. Abandoning frees the slot with no reward, and starts a 6-hour
`ABANDON_COOLDOWN` on abandoning again — derived from the last abandoned hunt's `ended_at`,
not a table — because abandoning is a reroll.

### Data

```sql
hunts(id, player_id, kind, park_id, seed, pool_version, status, started_at, ended_at,
      completed_at, season_id, week_key, claim_id, scoring)
hunt_items(id, hunt_id, slot, target_type, target_key, label, target_json, photo_id, hood_id,
           verified, overridden, flagged, attempted_at, completed_at, UNIQUE(hunt_id, slot))
park_amenities(park_id, amenity, PRIMARY KEY (park_id, amenity))
-- plus claims.hunt_id and item_grants.source ('pull' | 'hunt')
```

| Code | Condition |
|---|---|
| `BAD_HUNT_KIND` | not `park` or `street` |
| `HUNT_SLOTS_FULL` | three hunts already going |
| `PARK_NOT_FOUND` | a park hunt without a real park |
| `HUNT_NOT_FOUND` | no hunt of yours with that id |
| `HUNT_COMPLETE` / `HUNT_NOT_ACTIVE` | finished, or abandoned |
| `BAD_SLOT` / `SLOT_ALREADY_DONE` | not 0–4, or already found |
| `HOOD_REQUIRED` | a street photo without its Hood |
| `NO_ATTEMPT` | "I'm sure" before any photo was sent |
| `ABANDON_COOLDOWN` | abandoned another inside 6h — returns `available_at` |

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
| Snap a car | **25 Steel / 75 Gold / 250 Hologram**, nothing else (§1.8c) |
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

seasons(id, name, starts_at, ends_at, escalation_applied,
        items_expired)             -- §1.8d: the rollover's second idempotency flag

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

vehicles(                        -- §1.8c: every car anybody has a card of, one row per make + model
  id, vehicle_key,               --   'honda|civic', trim and generation stripped
  make, model, body_style,
  first_seen_claim_id, created_at
)

claims(... vehicle_id,           -- §1.8c, on claim_kind = 'car' | 'sighting'
  vehicle_year, vehicle_trim, vehicle_generation,
  identify_json,                 --   what the identifier said, for flaggers
  identify_confidence,
  week_key)                      --   '2026-W38' in Toronto; set on park claims too, where
                                 --   the per-Hood park cap sums on it

item_grants(id, claim_id, player_id, season_id, week_key, item_type, created_at)   -- §1.8d
item_uses(id, grant_id UNIQUE, player_id, item_type, target_hood_id, target_player_id,
          expires_at, context_json, created_at)
item_armed(hood_id PK, grant_id UNIQUE, player_id, armed_at)   -- the one mutable item table

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
POST   /api/hoods/:id/claim        multipart: photo, declared_type, caption (optional),
                                   use_grant_id (optional: a Crowbar or Sprint, §1.8d)
GET    /api/hoods/:id/history

GET    /api/players                every player + the colour palette
PUT    /api/players/:id/colour     admin only; palette colour nobody else wears (§7.1)

GET    /api/leaderboard?season=    current season standings (carries xp/level/title)
GET    /api/leaderboard/champion   all-season totals
GET    /api/seasons                schedule + which is active

GET    /api/parks/map              every park in the city + what you have collected (~70 kB)
GET    /api/hoods/:id/parks        every park in a Hood + your collection state
GET    /api/parks/:id             one park + whether you can collect it
GET    /api/parks/:id/check       dry run
POST   /api/parks/:id/collect     multipart: photo of the sign, caption (optional)
GET    /api/cards?season=&player=&kind= a binder: every kind of card, or one — yours by default
GET    /api/cards/:claimId        one park card or car card, whoever collected it (the feed opens these)

GET    /api/cars/capacity          this week's points so far, the cap, when it resets
GET    /api/cars                   the catalogue: every vehicle pulled, and who holds what
GET    /api/cars/:vehicleId        every sighting of one vehicle
POST   /api/cars/collect           multipart: photo, hood_id, caption (optional)

GET    /api/items                  your inventory, what is armed, Clover time left, the weekly cap
POST   /api/items/arm              grant_id, hood_id — Fortify only
POST   /api/items/disarm           hood_id
POST   /api/items/use              grant_id, target_hood_id — Recon, Tune-Up, Clover
GET    /api/items/history          grants and uses, for arguments

GET    /api/audio/manifest         every sound slot's hashed URL and gain, plus a version (§1.8f)
GET    /audio/:slot.m4a?v=hash     a sound, override or default; immutable under its own hash
GET    /api/admin/audio            admin only: every slot, its source, gain, licence, limits
POST   /api/admin/audio/:slot      admin only: multipart file (+ licence); transcoded on the Pi
PATCH  /api/admin/audio/:slot      admin only: gain, licence
DELETE /api/admin/audio/:slot      admin only: back to the repo default

(No endpoint takes a location. Any API request carrying a coordinate is COORDINATES_REFUSED — §1.8e.)

GET    /api/trades                 offers you are part of, incoming and outgoing
POST   /api/trades                 to_player_id, offer_claim_id, want_claim_id?, message?
POST   /api/trades/:id/accept      recipient only; re-checks both holdings (§1.8a)
POST   /api/trades/:id/decline     recipient only
DELETE /api/trades/:id             withdraw your own offer

GET    /api/feed                   recent claims, paginated
PUT    /api/claims/:id/caption     caption — author only; empty clears it (§1.4a)
POST   /api/claims/:id/flag        reason
DELETE /api/claims/:id/flag        let people withdraw a flag

GET    /api/hunts                  active hunts, recent ones, and every limit (§1.8g)
GET    /api/hunts/parks            in-season amenities per park, for the picker — no positions
POST   /api/hunts                  kind, park_id? — a new hunt, generated and frozen
POST   /api/hunts/:id/submit       multipart: photo, slot, hood_id (street)
POST   /api/hunts/:id/override     slot — "I'm sure": marks, flags, posts to chat
POST   /api/hunts/:id/abandon      no reward; starts the abandon cooldown

GET    /api/chat?before=           message history, paginated
WS     /ws                         chat + live hood_changed / claim_created / caption_changed
```

One endpoint handles all three actions — the server infers `claim_kind` from who holds the
Hood. Validate in this order, returning a specific error code for each failure so the UI
can reject before wasting the upload:

| Code | Condition |
|---|---|
| `HOOD_LOCKED` | Steal attempted inside the 12h cooldown — `bypassable_with: crowbar` |
| `FORTIFY_COOLDOWN` | Steal on a Hood whose Fortify caught you in the last hour (§1.8d) |
| `ADJACENT_COOLDOWN` | Conquer attempted on a Hood bordering one you conquered inside the cooldown — returns the eligible timestamp and the Hood responsible — `bypassable_with: sprint` |
| `REINFORCE_TOO_SOON` | Own Hood, less than 72h since `last_claim_at` — return the eligible timestamp — `bypassable_with: tuneup` |
| `WEAK_TYPE` | Declared subject does not beat the current holder's (applies to steal *and* reinforce) |
| `SAME_TYPE` | Declared subject equals the current holder's |

The client should know all of this before the file picker even opens: the Hood sheet
displays "needs an animal photo" or "reinforce available in 14h" up front.

---

## 7. Screens

0. **Sign in** — the wordmark and nothing else to look at.
1. **Map** — full-bleed Leaflet map, 25 Hoods filled in their owner's player colour,
   unclaimed Hoods in neutral grey with their point value at the centroid. Tap a Hood →
   a sheet dropping from the top with holder, their photo, the subject you need, and the action button,
   which reads **Conquer (+25)**, **Steal (+100)**, **Reinforce (+25)**, or a countdown.
2. **Capture** — camera launch, subject selector, target Hood confirmation. The action
   button sits in a footer at the end of the sheet, outside its scrolling body: the
   content above it varies in height (preview, caption, banners). **Sheets drop down from
   the top of the screen** and are capped at the visible height, because the bottom edge
   belongs to the browser toolbar and the keyboard — a sheet rising from there kept
   losing its button underneath them.
3. **Standings** — current season table + Champion table, toggled.
4. **Feed** — reverse-chronological claims with thumbnails and a flag button on each.
5. **Chat** — persistent global room. Auto-post system messages for every claim:
   *"shinobi stole Hood 13 — Toronto Centre from kaz with an animal photo (+100)"*. This makes
   chat double as the activity feed and is most of the game's social energy. Post flags to
   chat too — visible accusations are the enforcement mechanism.
6. **Hood detail** — full claim history with every photo ever posted there. This becomes a
   genuinely nice artifact by the end of the year.
7. **Cards** — the binder, reachable from the tab bar because the collection is what the
   app is named after: every kind of card in one grid, with an **All cards / Parks / Cars**
   filter (§1.8c). Anybody's binder (§1.8), the way into offers (§1.8a), and on your own, a
   **Snap a car** button.
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
  and are unaffected, so no appearance setting can recolour anybody's territory — which
  also means the accent can never be confused with a player.
- **The admin can repaint a player** from the profile screen: any colour in the server's
  eight-colour player palette that nobody else is wearing. Never an arbitrary hex (the
  palette is what stays clear of every accent) and never a shared colour (the map would
  lie). Enforced server-side, broadcast as `player_updated` so every map follows at once,
  and announced in chat, because a Hood changing colour with no explanation reads as a
  steal.

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
  chat. Make it idempotent via `escalation_applied`. It also expires the ended season's
  items and disarms its Fortifies, posting what expired per player, idempotent via
  `items_expired` (§1.8d).

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
- **Location and sound (§1.8e, §1.8f)**:
  - *Two sound toggles, not one* — built as two, music defaulting off.
  - *Seasonal music* — one loop per season would be a nice touch. The manifest does not need to
    change for it; it is a question of whether anybody wants to make four loops.
  - *Does the dot show other players?* — **No, settled.** Everything else in the game is public;
    live location is the one thing that must not be, and there is no setting for it.
  - *Photo EXIF GPS* — the shot-data panel still reads a photo's GPS from its EXIF for disputes.
    It predates the location feature and sits inside the image rather than in a request, but it
    is the obvious next thing to decide if "location never reaches the server" is to be total.
- **Scavenger Blitz (§1.8g)** — built on these defaults, every one a lever in `server/config.js`:
  - *Hunt items versus the item cap* — **exempt, with a weekly limit of 3 scoring hunts**, as
    the draft recommended. `CTH_ITEM_WEEKLY_CAP` was left at 4; it now limits pulls only.
  - *XP gap* — 80 park, 240 street. Big enough that a street hunt reads as the bigger outing.
  - *Common/uncommon* — 3/2. `CTH_HUNT_COMMON` / `CTH_HUNT_UNCOMMON`; 4/1 finishes faster.
  - *Abandon cooldown* — 6h.
  - *The DoorDash bike* — **out**, with the rest of the non-passenger vehicles. Pickups are in.
  - *Presence at the park* — not required; the picker suggests nearby parks and any Hood's
    parks can be picked by hand. If players shop across the city for easy hunts, a cooldown
    on generation is the lighter fix.
  - *Park hunt photos* — **private** by default (`CTH_HUNT_PARK_PHOTOS_PUBLIC`).
  - *Cost* — every park hunt photo is one billed vision call, like every street one.
- **Items (§1.8d)** — built on these defaults, every one a lever in `server/config.js`:
  - *Weekly item cap* — **4** is a guess. It is the one number that decides whether Fortify
    is an event or a tax, and the first thing worth revisiting after a month of play.
  - *Park cap period* — **weekly** per Hood (`CTH_PARK_HOOD_CAP=300`), because the brief was
    "keep earning if they travel", which is pacing. If the real irritant turns out to be that
    living in a park-dense Hood is a standing advantage — Hood 25's parks total about 6,000
    points, Hood 13's about 560 — only `CTH_PARK_CAP_PERIOD=season` fixes that; a weekly cap
    hands the dense Hood back every Monday. Most Hoods may never hit either, because the
    once-per-season park rule runs out first; that is fine.
  - *Grant weights* — Fortify rarest (10), Clover commonest (20).
  - *Clover* — 6h and 2×. The pair is what makes it a session-planner or a shrug.
  - *Every park card now rolls at least Steel*, so every collection earns the +15 Steel XP that
    only one in ten used to. Worth watching whether that shifts the XP table.
  Settled: no edition caps, items expire at rollover, Clover cannot grant Clover.
- **Car cards (§1.8c)** — built on these defaults, every one a lever in `server/config.js`:
  - *Dedupe granularity* — make + model, trim and generation stripped. If binders fill
    with things players consider different cars (a Mustang and a Shelby), the fix is in
    `server/lib/vehicles.js`, and it re-keys nothing already collected.
  - *Repeat sightings* — silent `ALREADY_COLLECTED` by default; `CTH_CAR_REPEAT_XP` is the
    trickle, once per vehicle per week.
  - *Across seasons* — car cards follow the binder: this season by default, all time a toggle.
  - *Licence plates* — **blurred** in everything the app serves, from the identifier's boxes.
    Approximate boxes mean the occasional plate may survive at an odd angle; the original is
    never altered. Revisit if flaggers find that happening.
  - *Cost* — every collection attempt is one billed vision call, including ones that end
    `ALREADY_COLLECTED`, because the dedupe key comes out of the identification.
- **Do parks swamp territory?** 1,513 parks at 5–100 points each is a far bigger pool than
  25 Hoods, and an afternoon of walking a dense Hood could out-earn a hard-won steal. The
  levers, if it distorts: scale park values down, cap park points per season, or count
  them toward a separate parks standing rather than the main total. Watch it in
  Season 1 — it is the single most likely thing about this build to need rebalancing.
- **Subject edge cases** — a storefront with a dog outside it satisfies two subjects at
  once, and the declaring player picks whichever is tactically useful. That is either a
  fun bit of angle-shooting or the thing that makes every claim a dispute. Watch it in
  Season 1; the lever if it distorts is a stated convention that the subject must fill the
  frame.
