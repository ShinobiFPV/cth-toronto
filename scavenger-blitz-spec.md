# Scavenger Blitz — ParkeMans GO!

Five-item scavenger hunts in two flavours. **Park** hunts are built from real amenity data
for a chosen nearby park and are easy enough to do with a four-year-old. **Street** hunts
are five passenger vehicles, each specified by make, model and year window.

Three active hunts at a time, no time limit. Completion pays XP, 10 points (capped at 200
per season), and three items.

Written against the invariants in `CLAUDE.md`.

---

## 1. Two constraints that shape everything

### 1.1 Park hunts need real amenity data, not a language model

"Monarch Park has an ice rink, Memorial Gardens doesn't" is only true if the app knows it.
Ask Claude to invent hunt items from a park's name and it will confidently put a splash pad
in a parkette that's a bench and two trees — the same failure mode as asking it to value a
car, and worse here because a child is being sent to look for something that isn't there.

**Source: City of Toronto Open Data, `parks-and-recreation-facilities`.** Roughly 1,500
records, each a park or community recreation centre with location plus a flagged list of
about twenty amenities — sports facilities, playgrounds, picnic areas, dog off-leash areas
and so on. That record count lines up closely with your 1,513 park signs.

- Portal: `https://open.toronto.ca/dataset/parks-and-recreation-facilities/`
- Same CKAN `package_show` fetch pattern as the ward import.

Write `scripts/import-amenities.js` alongside the existing importers. The join back to your
parks is the fiddly part: match on name plus proximity, not name alone — Toronto has
several parks with near-identical names and the amenity dataset's naming won't match your
sign data exactly. Expect to hand-resolve a tail of failures, and **log the unmatched rather
than silently dropping them**, because an unmatched park quietly becomes a park that can
only ever generate generic hunts.

If a park has no amenity record, it still works — the hunt just draws entirely from the
universal pool (§2.2). Don't block hunt generation on a missing join.

### 1.2 The verifier can't see model years

Every street target now carries a year window, so this constraint governs the whole pool
rather than one tier. A vision model can reliably tell a Civic from a Corolla, and an
FK-generation Civic from an FE — it cannot tell a 2019 Civic from a 2020 one. Nothing
visible changed.

So **write every window to a generation or facelift boundary**:

- Good: *Honda Civic Si, 2017–2021* — one generation, visually distinct from what came before
  and after.
- Bad: *Honda Civic Si, 2019* — not verifiable, and the hunt sits open forever.

Write the windows to generation boundaries when you build the list. The effect is the same
for the player (they see a year range on the card) and it's the difference between a hunt
that completes and one that doesn't.

---

## 2. Park hunts

### 2.1 Flow

Tap **Scavenger Blitz** → **Park** → nearest parks from the client-side index (§Location
spec; collected or not is irrelevant here) → pick one → five items generated and pinned.

### 2.2 Composition

Five items, drawn deterministically from a seed:

- **At least 2 park-specific**, from that park's amenity flags, so the hunt feels tied to
  the place: the ice rink, the splash pad, the playground, a tennis court, a baseball
  diamond, the dog off-leash area, a picnic table, the wading pool.
- **The rest universal**, safe in any green space: a bench, a garbage bin, a water fountain,
  a fence, a gate, a path, a big tree, a leaf, a flower.
- **Wildlife, kept general** as you asked: a dog, a bird, a bug, a squirrel. Never a
  specific species — "a robin" fails on a January afternoon and a five-year-old doesn't
  deserve that.

If a park has fewer than two amenities on record, fill from universal. Cap wildlife at two
per hunt so a hunt can't come out as five animals on a day when nothing's moving.

### 2.3 Season-filter the amenity pool

A splash pad in January and an ice rink in July are both *there*, and both make for a
miserable hunt item. Tag the amenity types with the seasons they're worth photographing and
filter on the active season.

Cheap to add at import time, and it's the difference between the module feeling
hand-made and feeling generated.

### 2.4 Difficulty

Park hunts have no difficulty selector. They're the easy mode by design — kids, short
distances, nothing that requires reading a sign or crossing a road.

---

## 3. Street hunts

One tier. Five targets, each a **make + model + year window**.

**In:** passenger cars, SUVs, crossovers, and pickups (assumed — say if you want those out).
**Out:** motorcycles, buses, streetcars, subway trains, work vehicles, delivery bikes.

That last exclusion costs you the DoorDash bike, which you were emphatic about. If you want
it back it's the one non-passenger item worth a carve-out — it's a Toronto icon and it's
the only target on any list that's genuinely funny. Easy to keep as a single flagged
exception in the pool rather than reopening the whole category.

### 3.1 Commonality replaces difficulty

Losing the tiers removes the thing that made a hunt easy or hard. Put that variation
*inside* each hunt instead: draw **3 common + 2 uncommon** targets.

A hunt then starts fast — a Corolla and a RAV4 inside ten minutes — and has a tail worth
working for. That's a better shape than a player picking a tier up front, because the
easy targets pull you outside and the hard ones keep the hunt alive for a week.

Tag every entry in `server/data/hunt-vehicles.json` with `common` or `uncommon`, and keep
the file versioned. It needs a top-up every couple of years and shouldn't need a deploy.

### 3.2 The pool

A starter set, all windows written to generation boundaries.

**Common** — the hunt-starters, genuinely everywhere in Toronto:

| | |
|---|---|
| Honda Civic 2016–2021 | Toyota Corolla 2020–2025 |
| Toyota RAV4 2019–2025 | Honda CR-V 2017–2022 |
| Mazda CX-5 2017–2024 | Nissan Rogue 2021–2025 |
| Hyundai Elantra 2021–2025 | Hyundai Tucson 2022–2025 |
| Ford Escape 2020–2025 | Chevrolet Equinox 2018–2024 |
| Toyota Camry 2018–2024 | Volkswagen Jetta 2019–2025 |
| Kia Forte 2019–2024 | Tesla Model 3 2017–2023 |
| Ford F-150 2021–2025 | Toyota Highlander 2020–2025 |

**Uncommon** — the tail:

| | |
|---|---|
| Subaru WRX 2015–2021 | Honda Civic Type R 2017–2021 |
| Mazda MX-5 2016–2025 | Toyota GR86 2022–2025 |
| Subaru BRZ 2022–2025 | Volkswagen Golf GTI 2015–2021 |
| BMW M340i 2019–2025 | Audi S4 2017–2024 |
| Kia Stinger 2018–2023 | Genesis G70 2019–2025 |
| Hyundai Elantra N 2022–2025 | Acura Integra 2023–2025 |
| Dodge Challenger R/T 2015–2023 | Ford Mustang GT 2015–2023 |
| Lexus IS 2021–2025 | Volvo XC60 2018–2025 |
| Land Rover Defender 2020–2025 | Porsche Macan 2019–2025 |
| Mini Cooper 2014–2024 | Toyota Camry XSE 2018–2024 |

### 3.3 Crossovers are harder for the verifier than sports cars

A Mustang GT is unmistakable. A RAV4, CR-V, Rogue and Tucson from three-quarter rear at
dusk are not — they're the same silhouette with different badges, and the identifier will
be less confident here than anywhere else in the app.

Two mitigations, both cheap: lean on the `body_style` and `generation` fields already coming
back from the identifier rather than the model string alone, and make sure §4.1's override
path is prominent on street hunts. A player standing next to a car they can read the badge
on should not lose to a model that's hedging.

### 3.4 XP: Park versus Street

With tiers gone, there are two hunt kinds and they should not pay the same. Finding five
specific models is materially harder than photographing a bench and a squirrel.

Points stay flat at 10 for both — they're capped at 200 a season anyway, so the variable
reward belongs in XP, exactly as everywhere else in the app. **Street XP > Park XP**, by
enough that a street hunt reads as the bigger undertaking it is.

Park hunts should still be worth doing on their own terms. They're the ones you do with a
kid on a Saturday, and that's the point of them.

---

## 4. Verification

### 4.1 Confirm, don't gatekeep

The hunt's whole pleasure is the app saying *found it*. So AI verification is worth having —
and "is there a bench in this photo?" is a far easier question than anything the Garage asks.

But this game is honour-based and enforcement is flagging. So:

- Vision call checks the photo against the item, generously.
- **A failed check never blocks completion.** It offers "I'm sure — mark it anyway", which
  marks the item complete and flags it for the group, exactly like a disputed claim.
- A confident pass is celebratory. That's the whole feature.

A four-year-old's photo of a bird is a grey smudge in the corner of the frame. Rejecting it
would be both wrong and unkind.

### 4.2 Street hunts reuse the Garage identifier

The same vision call that identifies a vehicle for a Not Wheels package answers the hunt
question — one call, both outcomes. Pass the hunt item's target alongside the identification
request rather than making two calls.

### 4.3 Hunt progress and card minting are independent

A Street hunt item can tick even when the collection doesn't mint anything:

- Already collected that vehicle this season → `ALREADY_COLLECTED`, no package, **hunt item
  still completes**.
- Past the weekly car points cap → package mints, zero points, **hunt item still completes**.

These are separate systems that happen to share a photo. Getting this wrong means a player
whose hunt targets a car already in their Case can never finish, which will happen in the
first week.

---

## 5. Rewards, and the item problem

### 5.1 Per completed hunt

| Reward | Value |
|---|---|
| Points | 10, capped at **200 per season** (20 scoring hunts) |
| XP | scaled by difficulty (§3.4) |
| Items | **3** |
| Cards | whatever the photos mint through the normal pipeline |

The points cap is clean and self-limiting. The items are the problem.

### 5.2 Three items per hunt versus a cap of four per week

`CTH_ITEM_WEEKLY_CAP` is currently 4. **One completed hunt is three of them**, and an Easy
street hunt is a twenty-minute walk. Two hunts in a day would blow through a week's ceiling
before any normal collecting.

Two coherent answers:

- **Hunt items count against the weekly cap**, like every other grant. The cap stays the one
  true control on the item economy. But it makes the "three items" reward largely notional,
  since you'd have hit 4 anyway — and it will feel like the game is taking back what it just
  gave.
- **Hunt items are exempt, and hunts get their own weekly completion limit instead.** Say
  three scoring completions a week. Hunts become the intended, deliberate path to items, and
  the grind path stays capped.

I'd take the second. It matches what hunts are *for* — a designed activity with a designed
payout, rather than a faster way to farm the same faucet — and it keeps the weekly item cap
doing its actual job of limiting passive accumulation. It also means the two caps can be
tuned independently, which you'll want after a month.

Either way, raise `CTH_ITEM_WEEKLY_CAP` if hunts are meant to be routine. Four was sized for
a world without them.

### 5.3 Season attribution

Points and XP attribute to the season the hunt was **completed** in, not started. A hunt
straddling rollover pays into the new season, and the 200 cap applies there. Worth a test.

---

## 6. Slots, abandoning, and reroll scumming

Three active hunts, no expiry.

**Abandoning has to exist** or a Hard hunt with an unlucky draw blocks a third of your
capacity permanently. No reward, frees the slot.

**But abandoning is a reroll**, and a player will otherwise cycle until they draw five easy
targets. Put a cooldown on it — 6 hours per abandon, reusing the same cooldown table as
Fortify and adjacency with its own `reason` — or cap abandons per week. Cooldown is cleaner;
it costs nothing to honest play and makes scumming slower than just doing the hunt.

Hunts survive season rollover. "Unlimited time" should mean it.

---

## 7. Data model

```sql
hunts(
  id INTEGER PRIMARY KEY,
  player_id INTEGER,
  kind TEXT,                -- park | street
  park_id INTEGER,          -- park hunts only
  seed TEXT,                -- regenerates the item list identically
  status TEXT,              -- active | complete | abandoned
  started_at TEXT,
  completed_at TEXT,
  season_id INTEGER,        -- season at completion, null while active
  week_key TEXT             -- set at completion, for the weekly completion limit
)

hunt_items(
  id INTEGER PRIMARY KEY,
  hunt_id INTEGER,
  slot INTEGER,             -- 0..4
  target_type TEXT,         -- amenity | universal | wildlife | vehicle_make | vehicle_model
  target_key TEXT,          -- 'ice_rink', 'bird', 'honda|civic|2016-2021'
  label TEXT,               -- display string, frozen at generation
  photo_id INTEGER,
  verified INTEGER,         -- 0 unverified/overridden, 1 AI-confirmed
  completed_at TEXT
)

park_amenities(
  park_id INTEGER,
  amenity TEXT,
  PRIMARY KEY (park_id, amenity)
)
```

`label` is frozen at generation, not rendered from `target_key` at read time. The vehicle
list is versioned and will change; a hunt issued in October must still read the same in
December.

`seed` means the item list is reproducible — same pattern as `card_seed`, and it makes
"why did I get this hunt" answerable.

Hunt completion writes a claim-shaped row for the points, or attaches to the existing ledger
with a `claim_kind = 'hunt'` — the latter, so scoring, the feed, chat and reversal keep
working with no special cases. Same reasoning as parks and cars.

---

## 8. API

```
POST   /api/hunts               { kind, park_id? } -> generated hunt
GET    /api/hunts               active + recent
POST   /api/hunts/:id/submit    multipart: photo, slot
POST   /api/hunts/:id/override  { slot }   -- "I'm sure", marks + flags
POST   /api/hunts/:id/abandon
GET    /api/hunts/parks         nearby parks for the picker
```

Error codes: `HUNT_SLOTS_FULL`, `ABANDON_COOLDOWN`, `HUNT_COMPLETE`, `SLOT_ALREADY_DONE`.

A completed hunt posts to chat. Five photos in one message is a lot of feed — post the
completion with the hunt's title and a strip of thumbnails rather than five separate items.

---

## 9. Tests

`test/hunts.test.js`:

- Generation is deterministic from the seed; the same seed produces the same five items.
- A park hunt draws at least two amenities the park actually has, and zero it doesn't.
- A park with no amenity record still generates a valid five-item hunt.
- Wildlife capped at two per hunt.
- Season filtering removes splash pads in winter and rinks in summer.
- A street hunt draws only passenger vehicles — no motorcycles, buses, transit or work
  vehicles — and every target carries a year window.
- Every street hunt is 3 common + 2 uncommon.
- **A vehicle already collected this season completes its hunt slot** despite
  `ALREADY_COLLECTED`.
- **A vehicle collected past the weekly points cap completes its hunt slot.**
- The failed-verification override marks the slot and raises a flag.
- Slots: a fourth hunt is `HUNT_SLOTS_FULL`; abandoning frees one; a second abandon inside
  the cooldown is refused.
- The 200-point season cap, including the partial clamp on the hunt that crosses it.
- A hunt started in season N and completed in N+1 pays into N+1 and counts against N+1's cap.
- Item grants respect whichever §5.2 rule you pick — assert the chosen one explicitly.

---

## 10. Open decisions

- **§5.2 — hunt items exempt with a weekly completion limit, or counted against the item
  cap.** The one that matters. Everything else here is tuning.
- **`CTH_ITEM_WEEKLY_CAP`** almost certainly needs raising from 4 now.
- **Street vs Park XP gap** — big enough that a street hunt reads as the bigger undertaking,
  without making park hunts feel like a consolation prize.
- **The DoorDash bike** — in as a flagged exception, or out with the rest of the
  non-passenger vehicles.
- **The common/uncommon split** — 3/2 is a guess; 4/1 makes hunts finish noticeably faster.
- **Abandon cooldown** — 6h is a guess.
- **Does a park hunt need the player to be at the park?** Everything else in the app is
  honour-based, so no — but the park picker being location-driven implies presence, and
  someone will generate hunts for parks across the city to shop for easy ones. A cooldown on
  generation is the lighter fix if that happens.
- **Whether hunt photos are public.** Binders and Cases are; a five-photo hunt log of a
  child's afternoon in a park is a different thing. Worth deciding deliberately rather than
  inheriting the default.
