# Garage module — Park-E-Mans GO!

Photograph cars on the street; the Pi identifies the vehicle with a Claude API vision call
and mints a **Not Wheels** package. Packages live in your **Case**.

- **Points** — a flat **5** per car, capped at **100 per week** (20 scoring cars).
- **XP** — from the edition roll (Steel / Gold / Hologram), flat and rising. **Never capped.**

Past the weekly cap you keep collecting: the package is minted, the edition rolls, the XP
lands, and the claim is worth 0 points.

Written against the invariants in `CLAUDE.md`. Where this document and that one disagree,
`CLAUDE.md` wins, and this should be folded into `parkemans-go-spec.md` once settled.

---

## 1. Why this version is architecturally boring, and that's the point

A flat value with a cap is fully knowable at claim time, so `points_awarded` is computed
once inside `commitCar()` and frozen there like every other claim in the game. No new
scoring path, no derived second term on the leaderboard, no mutable ledger field, nothing
scheduled. `SUM(points_awarded)` remains the whole story.

That is worth more than it sounds. Every earlier version of this module either broke the
frozen-at-claim-time rule or forced scoring to read from outside the ledger. This one
doesn't touch either.

---

## 2. The cap

### 2.1 Define the week as a stored string

Don't compute a rolling 168-hour window, and don't do date arithmetic at query time.
Compute a **week key** in `America/Toronto` at claim time and store it on the claim:

```sql
ALTER TABLE claims ADD COLUMN week_key TEXT;   -- '2026-W38'
```

The cap check is then an exact string match and a SUM, which is the same trick the codebase
already relies on with lexicographically sortable ISO-8601 timestamps.

Weeks start **Monday 00:00 America/Toronto**. Convert from the stored UTC timestamp with a
real timezone conversion, never by adding a fixed offset — Toronto shifts twice a year and
naive arithmetic puts two different weeks either side of the March and November transitions.
Worth a test with fixtures on both transition dates.

A fixed calendar week also gives the game a rhythm: capacity resets Monday, and Sunday night
is the scramble. A rolling window trickles capacity back a few points at a time and nobody
can ever tell where they stand.

### 2.2 Award

Inside `evaluateCar()`, pure and no writes:

```
spent     = SUM(points_awarded) for this player's car claims
            WHERE week_key = <current> AND status != 'reverted'
remaining = max(0, CAR_WEEKLY_CAP - spent)
award     = min(CAR_POINTS, remaining)
```

`min()` rather than an all-or-nothing check. At 5 and 100 it divides evenly and never
matters, but both are env vars and the first time somebody sets the cap to 90 or the value
to 7, a straight `spent >= cap` test either overshoots the cap or silently drops a whole
award. Cheap insurance against a config change.

`commitCar()` re-runs `evaluateCar()` inside the transaction, as `commitClaim()` does — two
collections racing at 95 points spent cannot both be awarded 5.

### 2.3 A reverted claim frees capacity

Filtering the cap sum on `status != 'reverted'` means a car the group throws out returns its
slot, exactly as a reverted park collection frees the park up again. Same principle, no
extra code, and it falls out of the filter you already need.

Reverting an old claim frees capacity in a week that has already passed, which is useless
but harmless. Don't special-case it.

### 2.4 Season boundaries

Points belong to the claim's `season_id`. A week straddling a rollover therefore splits its
100 points across two seasons, which is correct — each claim scores in the season it was
made. The week key is independent of the season and should stay that way; tying them
together buys nothing and creates a stub week at every rollover.

### 2.5 What actually binds

The cap is 20 cars a week. The **once per vehicle per player per season** rule is the other
limit, and by midseason it will be the one that bites — after a couple of months the hard
part is finding a car you don't already have, not staying under 100 points.

That is a good arc and worth leaving alone. It does mean the cap matters most in the first
few weeks of a season, which is exactly when you'd want a brake on it.

---

## 3. UI

The tab bar is full — five labels to 320px. The Cards screen gains a segmented control,
**Parks | Garage**; Garage shows the Case, a view over `card_holdings` filtered by
`claim_kind`. Packages trade through the existing system alongside park cards.

**Show remaining capacity before the shutter, not after.** The capture sheet carries
`75 / 100 this week`, and past the cap it reads **XP only — resets Monday**. A player who
snaps three cars and sees no points move will file it as a bug otherwise.

The system chat message should say which it was: a scoring collection and a post-cap one are
different events and the feed is where everyone reads the game.

---

## 4. Cars are claims

`claim_kind = 'car'`, `vehicle_id` set, `points_awarded` = 5 or 0, `xp_awarded` from the
edition, `week_key` set. **Never touches `hood_state`.**

In `server/lib/game.js`, beside `evaluateCollect()`:

- `evaluateCar()` — pure, no writes, no network. Takes a resolved identification, answers
  whether this player may collect it and for how many points, or why not.
- `commitCar()` — one transaction. Re-runs `evaluateCar()` inside it, rolls the edition
  inside it, writes the claim.

`collectionSummary()` needs a decision: cars get their own counters or are excluded from
`season_collected`. Don't let them inflate the parks number.

---

## 5. XP and editions

| Edition | Shape |
|---|---|
| Steel | baseline — what going outside and snapping a car is worth |
| Gold | roughly 3× Steel |
| Hologram | roughly 10× Steel |

Calibrate against the existing park XP schedule in `server/config.js`; Steel should feel
comparable to a park collection, since the effort is comparable.

Reuse `rollEdition()` unchanged — fresh `crypto.randomInt`, never derived from `card_seed`,
frozen onto `claims.edition`. `EDITIONS` stays ordered rarest-first so an all-hits roll
cannot be demoted.

**Hologram cap:** one per season globally is the natural analogue of the parks per-Hood cap,
checked inside `commitCar()`'s transaction with the same fall-through to Gold when exhausted.
Lever if too scarce at six players: per-player-per-season. Config either way.

The edition roll is unaffected by the weekly points cap. A Hologram pulled on your 40th car
of the week is still a Hologram — that separation is what makes collecting past the cap
worth doing at all.

---

## 6. Identification

Its job is the package face and the dedupe key. It does not touch scoring, so accuracy
barely matters for fairness and **consistency matters enormously**.

Dedupe on **make + model with trim and generation stripped** — `honda|civic` is one package
whether it was an Si or a base sedan. Generation, trim and year ride along on the claim as
sighting detail and appear on the package. This is the easiest thing in the module to get
wrong by being too specific: too fine and the Case fills with near-identical Civics, too
coarse and every Toyota is one package.

Prompt for strict JSON, base model name without trim:

```json
{
  "is_vehicle": true, "in_situ": true,
  "make": "Porsche", "model": "911",
  "generation": "992", "trim": "Carrera S",
  "year_range": "2019-2024", "body_style": "coupe",
  "confidence": 0.86
}
```

The call runs in the route handler, **before** `commitCar()`, never inside the transaction:

```
upload → sharp pipeline → identify (2–5s) → evaluateCar() → commitCar()
```

- unreachable → `IDENTIFY_UNAVAILABLE`, no claim written, player retries
- low confidence / no model name → `IDENTIFY_UNSURE`, offer a retry with a better angle
- `is_vehicle` false → `NOT_A_VEHICLE`

The client shows an "Identifying…" state across the round trip; it is noticeably slower than
a park collection, so say so rather than leaving a dead spinner.

`in_situ` catches photographs of screens, magazines, diecast and game footage — it matters
more here than for parks, because a Not Wheels package of a photographed Hot Wheels car is
an obvious joke somebody will attempt in week one. Low plausibility **marks** the package for
flaggers; it does not reject it. The honour system and flagging remain the enforcement model.

**This repo is public.** The key comes from an env var through `server/config.js` and is
never written down, same rule as the tunnel id.

The identify client must be injectable, the way `rollEdition()` takes a `rand`. Tests never
touch the network.

---

## 7. Duplicates

Once per `vehicle_key` per player per season, enforced in `evaluateCar()` **and** by a partial
unique index excluding reverted rows — the parks pattern, so a package the group throws out
frees the vehicle up again:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS ux_car_once
  ON claims(player_id, season_id, vehicle_id)
  WHERE claim_kind = 'car' AND status != 'reverted';
```

A repeat sighting returns `ALREADY_COLLECTED` and mints nothing — no package, no XP, no
points. Consider a small XP trickle for it, the equivalent of walking past a park you already
have, but never a second package.

---

## 8. The package

`NotWheelsPack.jsx`, sibling to `ParkCard.jsx`:

- **`card_seed`** hashed from (player, vehicle, season), stored on the claim; renders
  identically every time. Never `Math.random`, never a timestamp.
- **Colours are tokens in `styles.css`.** No hex literals in the component.
- **Kolker Brush on the vehicle name**, the way `.pcard-name` uses it.

Blister anatomy, all CSS/SVG over the photo: hang tab with a punched hole carrying the
wordmark; a rounded blister bubble over the photograph with a specular highlight along one
edge and a soft shadow onto the backing; the backing card behind it carrying the edition
(plain stock / foil / holographic); a footer strip with make, model, year, Hood and date.
Photo in a fixed aspect box, cover-cropped — packages tile in a Case grid and phone photos
arrive in both orientations.

On the name: the repo is public and Mattel's packaging trade dress is distinctive. Evoke the
*format* — blister, hang tab, punch hole — in the Arctic Classified house style rather than
reproducing the flame logo, the red-and-yellow scheme or the card layout. It will sit better
beside the park cards anyway.

---

## 9. API

```
POST   /api/cars/collect        multipart: photo, caption, hood_id
GET    /api/cars                catalogue + who holds what
GET    /api/cars/:vehicleId     sighting history
GET    /api/cards?player=&kind= existing route, add the kind filter
```

The collect response returns the awarded points and the remaining weekly capacity, so the
client never has to compute the cap itself.

Error codes via `GameError`: `ALREADY_COLLECTED`, `IDENTIFY_UNAVAILABLE`, `IDENTIFY_UNSURE`,
`NOT_A_VEHICLE`. **Being over the cap is not an error** — the collection succeeds and is
worth 0 points. Don't reach for a `WEEKLY_CAP_REACHED` code; that would turn a successful
collection into a failure the UI has to apologise for.

Every collection posts a system message through `postMessage()`. A Hologram pull should read
like an event — it is one per season.

Catalogue and Cases are public, like binders: nobody loses anything when you photograph a
car, and comparing pulls is most of the fun.

---

## 10. Data model

Migrations at the top of `server/db.js`, append-only and idempotent — they run on deploy
against a live database with real claims in it.

```sql
vehicles(
  id INTEGER PRIMARY KEY,
  vehicle_key TEXT UNIQUE,      -- 'honda|civic', normalised, trim stripped
  make TEXT, model TEXT, body_style TEXT,
  first_seen_claim_id INTEGER,
  created_at TEXT
)

ALTER TABLE claims ADD COLUMN vehicle_id INTEGER;
ALTER TABLE claims ADD COLUMN vehicle_year TEXT;
ALTER TABLE claims ADD COLUMN vehicle_trim TEXT;
ALTER TABLE claims ADD COLUMN vehicle_generation TEXT;
ALTER TABLE claims ADD COLUMN identify_json TEXT;
ALTER TABLE claims ADD COLUMN identify_confidence REAL;
ALTER TABLE claims ADD COLUMN week_key TEXT;
```

Index `claims(player_id, week_key)` for the cap sum — it runs on every collection.

Keep `identify_json`. When somebody disputes a package the flaggers want to see what the
model actually said, and you will want it when tuning the prompt.

Record `hood_id` on the claim — free, gives the feed its flavour, enables a per-Hood Garage
stat later. It does not make the claim territorial.

---

## 11. Config

```
CTH_IDENTIFY_ENABLED / _MODEL / _TIMEOUT_MS / _MIN_CONFIDENCE
CTH_CAR_POINTS              -- 5
CTH_CAR_WEEKLY_CAP          -- 100
CTH_CAR_WEEK_START          -- MO
CTH_CAR_XP_STEEL / _GOLD / _HOLOGRAM
CTH_CAR_HOLOGRAM_CAP_SCOPE  -- season | player-season
CTH_CAR_REPEAT_XP           -- 0 = nothing for a duplicate
```

`CTH_` prefix stays, per the infrastructure-identifier rule. Tests read these out of config
rather than hardcoding them, so rebalancing doesn't turn the suite red.

---

## 12. Tests

`test/garage.test.js`:

- Dedupe, including that a reverted claim frees the vehicle.
- `vehicle_key` normalisation — the trim-stripping cases specifically.
- A car collection never touches `hood_state`.
- The hologram cap, its fall-through to Gold, and that two in-flight collections cannot both
  mint it.
- The edition roll is unaffected by the points cap.

`test/carcap.test.js` — the new arithmetic:

- 20 collections in a week award 100 points; the 21st awards 0 and full XP.
- The partial-award clamp, with a cap that doesn't divide evenly by the car value.
- A reverted claim frees a slot in the same week.
- Two collections racing at 95 spent cannot both be awarded — the transaction re-check.
- Week keys roll over correctly at Monday 00:00 Toronto, **including both DST transitions**,
  against fixtures on those dates.
- A week straddling a season rollover attributes each claim to its own season.
- Time is simulated by writing `week_key` and timestamps directly, the way `test/game.test.js`
  winds `hood_state` clocks backwards. Nothing waits.

Extend `test/trades.test.js` with a car package — a trade moves no points, no XP and no
standings, across collection types.

---

## 13. Open decisions

- **Hologram cap scope** — one per season globally, or per player per season.
- **Dedupe granularity** — make + model with trim stripped is the recommendation.
- **Repeat sightings** — silent `ALREADY_COLLECTED`, or a small XP trickle.
- **Case across seasons** — everything ever pulled, or filtered to one. Match the parks
  binder.
- **Licence plates.** In frame constantly, and unlike a park sign a car is traceable to a
  person. Decide whether display and thumb derivatives get plates blurred before anything
  ships — far easier as a rule now than as a retrofit across a season of stored images.
