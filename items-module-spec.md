# Items module — ParkeMans GO!

Gold and Hologram pulls grant consumable items that manipulate cooldowns and, in Fortify's
case, block a theft outright. One item per Gold, three per Hologram.

Special cards are deliberately common — roughly **1 in 7** collections — and uncapped. Items
are not: once you stop earning points you stop earning items, and you keep pulling cards.

Items span the whole game, so this is its own module rather than part of the Garage.

Written against the invariants in `CLAUDE.md`.

---

## 1. Rates

### 1.1 The table

Single random draw mapped to ranges, not three sequential checks — sequential checks make
Clover's arithmetic hard to reason about and harder to test.

| Edition | Base | Under Clover |
|---|---|---|
| Hologram | 2% | 4% |
| Gold | 12% | 24% |
| Steel | 86% | 72% |

14% combined is 1 in 7.1. All three live in `server/config.js`; Steel is whatever remains
rather than a configured number, so the table can never sum to something other than 100.

**Keep the rarest-first ordering in `EDITIONS`.** It matters more now, not less — a higher
Hologram rate means the ordering is exercised constantly rather than a few times a season.

### 1.2 No edition is capped

The parks per-Hood Hologram cap is removed; cars never had one. See `core-rules-addendum.md`
§2 for what changes in `test/editions.test.js`.

Keep `rollEdition()`'s fall-through path and the rarest-first ordering even though nothing
exercises them now — re-adding a cap later becomes a config change rather than a rewrite,
and keep one synthetic-cap test so the path doesn't rot.

At 2% uncapped, expect roughly 8 Holograms per player per season, which is about 24 items
from Holograms alone. That is what makes the weekly item cap below load-bearing rather than
merely tidy.

---

## 2. The item cap, and where it doesn't reach

### 2.1 "No points, no items" now binds both sources

Cars are capped at 100 points a week; parks are capped per Hood (`core-rules-addendum.md`
§1). Past either ceiling a collection mints a card, rolls an edition and pays XP, but grants
no item. Both faucets are closed at the same valve.

**It binds loosely, though.** The park cap is per *Hood* — a player who travels can earn,
and therefore draw items, in all 25 of them. Travelling that much is real work, so this is
not an exploit so much as a soft ceiling, but it is not a number you control directly.

At 14% and 0.18 items per special pull, forty collections in a week is around **7 items**.
That is one a day, and Fortify stops being a story and becomes a tax on attacking.

### 2.2 So keep a direct ceiling as well

**Give items their own weekly ceiling**, independent of any points cap:

```
CTH_ITEM_WEEKLY_CAP      -- suggest 4
```

It expresses exactly what you want — play as much as you like, keep pulling special cards,
stop accruing power — and it binds parks and cars identically without unifying two points
systems that work fine apart. It also reuses the `week_key` column the car cap already
needs.

Past the cap, a Gold still mints a Gold card with Gold XP and Gold treatment. Only the grant
is withheld, and the chat message should say so plainly rather than silently dropping it.

This is the number to tune after a month. Card rate and item rate are now independent knobs,
which is the main thing the split buys you.

---

## 3. Clover

### 3.1 Effect

Doubles the Gold and Hologram rates for **6 hours** from activation. Steel absorbs the
remainder. Clamp the specials so they can never exceed 100% if somebody raises the base
rates later.

### 3.2 Its real payoff is XP, not items

Worth being clear about, because it changes how it should be balanced: with items on a
weekly cap, Clover mostly accelerates you *to* a ceiling you'd probably reach anyway. What
it actually multiplies is **XP** — Gold pays roughly 3× Steel and Hologram roughly 10×, so
six hours of doubled special rate is a genuine XP window, plus a faster-filling binder.

That's a good place for it. It's meaningful, it rewards planning a session around it, and it
doesn't touch points at all.

It does mean Clover is worth wildly different amounts to different players. Activated before
a long walk it's excellent; activated before bed it's nothing. That's a skill floor rather
than a flaw, but the UI should make the 6-hour window and its expiry very visible.

### 3.3 Clover must not grant Clover

Clover raises special pulls, special pulls grant items, and Clover is an item. **Rule: pulls
made inside an active Clover window never grant Clover.** Roll from the other five types
instead.

Without it the loop is self-sustaining in a way that's hard to reason about and easy to get
wrong. With it, the recursion is cut at the schema level and testable in one assertion.

### 3.4 No stacking

A second Clover while one is active is rejected with `CLOVER_ACTIVE`. Not extended, not
multiplied. Stacking is the obvious exploit and an extension is a second mechanic to
explain.

### 3.5 Derived, not stored

An active Clover is an `item_uses` row of type `clover` whose `created_at + 6h` is in the
future. Derive it at roll time; no mutable state, no expiry job, nothing to miss.

Read the clock **once** per claim and pass it down, so a roll can't straddle the boundary
between its own eligibility check and the roll itself.

---

## 4. Fortify

### 4.1 Pre-armed and hidden

The owner arms Fortify on a Hood in advance; the first steal attempt consumes it.

- One armed Fortify per Hood. No stacking — three on one Hood is a fortress that never
  resolves.
- Persists until consumed or season rollover.
- Arming and disarming are free; only consumption spends the item.
- **Never visible to anyone but the owner.** Visible, nobody attacks a fortified Hood, and
  it becomes a permanent wall rather than a one-shot trap.

### 4.2 Resolution

Inside `evaluateClaim()` / `commitClaim()`, same transaction as the steal it blocks:

1. Attempt is a steal and passes every other check — subject counter, cooldowns, all of it.
2. An armed Fortify exists on the target Hood.
3. Fortify is consumed; the steal fails; `hood_state` is untouched.
4. A 1-hour cooldown applies to **that attacker against that Hood** — not all their steals,
   not all attackers.
5. A system message posts to chat.

**No claim row is written.** The ledger is for claims that happened. The audit trail lives in
`item_uses`, which is where you'll look when somebody argues.

The attacker's photo is spent — stored, no card, no points. That's the cost of walking into
it. The chat message names the defender and the Hood but not the attacker's subject type;
let them decide whether to admit what they brought.

---

## 5. The item list

| Item | Effect | Hooks |
|---|---|---|
| **Fortify** | Blocks one steal on a Hood you hold; attacker gets 1h cooldown on that Hood | steal path |
| **Recon** | Reveals whether a target Hood is fortified, before you travel | Fortify |
| **Crowbar** | Ignore the 12h post-handover steal lock on one Hood | `hood_state.locked_until` |
| **Sprint** | Clear your own adjacency conquer cooldown immediately | adjacency cooldown |
| **Tune-Up** | Drop the 72h reinforce gate to zero on one Hood you hold | `last_claim_at` gate |
| **Clover** | Double special-card rate for 6 hours | `rollEdition()` |

Weight the grant roll rather than distributing flat. Fortify is the only item that denies
another player points, so it should be the rarest; Clover affects nobody else at all, so it
can be the most common. Suggested starting weights, all in config:

```
fortify 10 | recon 20 | crowbar 15 | sprint 20 | tuneup 15 | clover 20
```

Deliberately not on the list: anything revealing another player's inventory, anything that
steals items, and anything faking your Hood's subject type to bait a wasted trip. All three
are fun for a week and poisonous for a season among six friends.

---

## 6. Data model

Items are consumable, which means mutation, and the ledger is append-only. Same resolution
as scoring: **two append-only tables, inventory derived.**

```sql
item_grants(
  id INTEGER PRIMARY KEY,
  claim_id INTEGER,          -- the pull that produced it
  player_id INTEGER,         -- the puller, permanently (§7)
  season_id INTEGER,
  week_key TEXT,             -- for the weekly item cap
  item_type TEXT,
  created_at TEXT
)

item_uses(
  id INTEGER PRIMARY KEY,
  grant_id INTEGER UNIQUE,   -- one use per grant, enforced by the schema
  player_id INTEGER,
  item_type TEXT,
  target_hood_id INTEGER,
  target_player_id INTEGER,  -- the thwarted attacker, for Fortify
  expires_at TEXT,           -- Clover only; null otherwise
  context_json TEXT,
  created_at TEXT
)

item_armed(                  -- the only mutable table, Fortify only
  hood_id INTEGER PRIMARY KEY,
  grant_id INTEGER UNIQUE,
  player_id INTEGER,
  armed_at TEXT
)
```

`grant_id UNIQUE` on `item_uses` makes double-spending impossible at the schema level rather
than in application logic. Inventory is `grants - uses`, derived, never stored.

`item_armed` is a small staging table rather than a ledger, which is honest about what it is:
arming isn't an event worth keeping, only consumption is.

Item type is rolled with fresh `crypto.randomInt` at claim time, like `rollEdition()` and for
the same reason — never derived from `card_seed`, or a player reads their next item off a
card they already hold.

Index `item_grants(player_id, week_key)` for the cap check; it runs on every special pull.

---

## 7. Items do not trade

Grants attach to the **player who pulled the card**, permanently, never to the card's current
holder. Trading a card moves the card and nothing else — no points, no XP, no items.

Otherwise trading is item laundering: two players shuttle one Gold back and forth and argue
about who the items belonged to. Same rule as the existing trade invariant, extended;
`test/trades.test.js` should assert it.

Whether items themselves become tradeable is a separate question worth leaving closed for a
season. Six players with a working item market is a different game.

---

## 8. Seasons

**Unspent items expire at rollover** and armed Fortifies disarm. No carry.

Points reset and Hood ownership persists; items follow points, because they exist to
influence the season race. Carrying them would mean banking a stack through a season you've
written off and dumping five Fortifies into the one you're contesting.

The expiry belongs in the existing rollover script, guarded the same way as
`escalation_applied` so a double run doesn't double-post. Post a chat message listing what
expired, per player — people should feel it, and it teaches everyone to spend in week 12
rather than hoard into a reset.

---

## 9. Cooldowns: don't add a third mechanism

| Cooldown | Scope | Source |
|---|---|---|
| Post-handover steal lock, 12h | per Hood | `hood_state.locked_until` |
| Adjacency conquer cooldown, 6h | per player per Hood | existing table |
| Fortify cooldown, 1h | per player per Hood | new |

Fortify's is the same shape as the adjacency one, so **put it in that table with a `reason`
column** rather than inventing a third mechanism. Three independent cooldown systems is how
one silently shadows another and you get a bug you can't reproduce.

`evaluateClaim()` now checks all three. Fix the precedence explicitly and test it — a player
needs one clear reason why they can't act. Suggested order: subject counter → post-handover
lock → Fortify cooldown → adjacency. Fortify's resolution comes last, since it fires only
when everything else passed.

---

## 10. API

```
GET    /api/items                  derived inventory, what's armed, Clover time remaining
POST   /api/items/arm              { grant_id, hood_id }        -- Fortify only
POST   /api/items/disarm           { hood_id }
POST   /api/items/use              { grant_id, target_hood_id } -- Recon, Tune-Up, Clover
GET    /api/items/history          grants and uses, for arguments
```

Crowbar and Sprint are consumed **as part of the claim they enable**, not as a separate call
— pass `use_grant_id` on the claim request so item and claim commit in one transaction. An
item spent on a claim that then fails validation is exactly the bug report you don't want.

New `GameError` codes: `ITEM_NOT_HELD`, `ITEM_ALREADY_USED`, `ITEM_WRONG_TARGET`,
`HOOD_ALREADY_ARMED`, `FORTIFY_COOLDOWN`, `CLOVER_ACTIVE`.

`FORTIFY_COOLDOWN` needs careful copy. The attacker learns a Fortify exists only by hitting
it — the error text is the reveal, and it should read like getting caught, not like a
validation failure.

---

## 11. UI

- **Inventory** on the profile or as a sheet off Cards, not a sixth tab.
- **Clover's window is a countdown**, visible wherever you'd see it while out collecting —
  the capture sheet is the honest place. An expired Clover nobody noticed is a wasted item
  and a bad feeling.
- **Arming** is an action on the Hood sheet for Hoods you hold.
- **An armed Fortify is visible only to its owner.** Worth an explicit test that
  `/api/hoods` contains no armed state for other players' Hoods — this is the kind of thing
  that leaks through a serialiser six months later.
- **Crowbar and Sprint** surface on the blocked action: when a cooldown stops you and you
  hold the item, offer it there rather than making the player go find it.
- Item grants post to chat. So does hitting the weekly item cap, once, the first time it
  happens in a week.

---

## 12. Tests

`test/items.test.js`:

- Gold grants exactly one item, Hologram three, Steel none.
- **Past the weekly item cap: no grant, but full XP and edition treatment.**
- Double-spend impossible: two concurrent uses of one grant, one succeeds.
- Fortify consumes on the first steal attempt, leaves `hood_state` untouched, writes no
  claim row, applies the attacker cooldown.
- A second steal on the same Hood after a consumed Fortify goes through — one Fortify, one
  block.
- The attacker cooldown is scoped to that attacker and that Hood: another player steals
  immediately, the same player steals elsewhere.
- Armed state absent from another player's `/api/hoods` payload.
- Crowbar bypasses `locked_until` and is consumed only on a claim that commits; a claim
  failing validation consumes nothing.
- Items expire at rollover; armed Fortifies disarm.
- Cooldown precedence: two active, the error names the right one.

`test/editions.test.js` extensions:

- The rate table sums to 100 with Steel as remainder, at base and under Clover.
- **A pull inside an active Clover window never grants Clover.**
- A second Clover while one is active is `CLOVER_ACTIVE`.
- Clover expires exactly 6 hours in, by winding `created_at` backwards rather than waiting.
- A seeded RNG over a large sample lands within tolerance of the configured rates, at base
  and doubled. This is the assertion that catches an off-by-one in the range mapping, which
  is otherwise invisible until somebody notices Holograms feel wrong in March.
- The parks per-Hood Hologram cap still holds and still falls through to Gold.

Extend `test/trades.test.js`: trading a Gold card moves no items.

---

## 13. Open decisions

- **Weekly item cap value.** 4 is a guess. It is the one number that decides whether Fortify
  is an event or a tax, and the only one here worth revisiting after a month of play.
- **Park cap period** — weekly or seasonal (`core-rules-addendum.md` §1.2). Affects item
  supply as well as park scoring.
- **Grant weights** — Fortify rarest, Clover commonest is the recommendation.
- **Clover duration and multiplier** — 6h and 2× are yours; the pair is what makes it either
  a session-planner or a shrug.

Settled: no edition caps, items expire at rollover, Clover cannot grant Clover.
