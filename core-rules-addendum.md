# Core rules addendum — park points cap, Hologram cap removal

Two changes to shipped behaviour in `parkemans-go-spec.md`. Both touch code that already has
tests against it, so neither is additive.

---

## 1. Per-Hood points cap on park collections

### 1.1 The rule

Park collections earn points up to a ceiling **per Hood**. Past that Hood's ceiling the
collection still succeeds — card minted, edition rolled, XP awarded — and is worth 0 points.
To keep earning, go to a different Hood.

Same shape as the car weekly cap, and it should share its machinery:

```
spent     = SUM(points_awarded) for this player's park claims in this Hood
            WHERE <period matches> AND status != 'reverted'
remaining = max(0, PARK_HOOD_CAP - spent)
award     = min(park_points, remaining)
```

`min()` rather than all-or-nothing, for the same reason as the car cap: both values are env
vars and the first non-dividing combination either overshoots the ceiling or silently drops
a whole award.

Computed in `evaluateCollect()`, re-run inside `commitCollect()`'s transaction. Filtering on
`status != 'reverted'` means a thrown-out collection returns its capacity, consistent with
everything else.

### 1.2 Per week, or per season?

This is the decision, and the two answers produce different games.

**Per week per Hood** — group by `week_key`, the column the car cap already needs. Capacity
resets Monday everywhere in the app, one rhythm, minimal new code. It paces you: cap out at
home, travel for the rest of the week, come back Monday.

**Per season per Hood** — group by `season_id`. A hard ceiling on what any one Hood can ever
be worth to you.

The difference matters because **Hoods are not equally parky**. 1,513 parks across 25 Hoods
averages 60, but the spread is wide, and right now living in a park-dense Hood is a standing
advantage that compounds all season. If that's what you're trying to fix, only the seasonal
version fixes it — a weekly cap paces the advantage without removing it, since Monday hands
the dense Hood back every time.

If you just want to push people to travel and keep the weekly rhythm consistent with cars,
weekly is the simpler and friendlier choice.

My read: you said "keep earning if they travel," which is a pacing goal, so **weekly**. But
if the park-density imbalance is the real irritant, say so and make it seasonal — it's the
same query with a different GROUP BY, so this is cheap to change later and worth not
agonising over now.

### 1.3 Dedupe already does some of this

Parks are once per park per player per season, so a Hood's parks are a finite resource
regardless. The points cap is a rate limit on top of a supply limit.

Worth checking before you pick a number: in a park-sparse Hood the cap may never bind at
all, because you run out of uncollected parks first. A cap that only ever fires in the three
densest Hoods is still doing its job — just don't be surprised when most Hoods never hit it.

### 1.4 Past the cap

Collection succeeds. Card, edition, XP. Zero points, and **no item grant**, per the "no
points, no items" rule.

**Not an error.** No `HOOD_CAP_REACHED` code — that turns a successful collection into a
failure the UI has to apologise for. Show remaining capacity on the Hood sheet before the
shutter, and read **XP only in this Hood** past it, with whatever the reset is.

### 1.5 Schema

Nothing new. Park claims already carry `hood_id`, and `week_key` is arriving with the car
cap. Index `claims(player_id, hood_id, week_key)` — or `(player_id, hood_id, season_id)` —
for the cap sum; it runs on every collection.

### 1.6 Tests

In `test/parks.test.js`:

- Collections in one Hood award points to the ceiling, then 0.
- The partial-award clamp with a cap that doesn't divide evenly by the park value.
- A capped player collecting in a *different* Hood earns normally. This is the whole point
  of the rule and the assertion that proves it.
- A reverted collection frees capacity in that Hood.
- Two collections racing at the ceiling — the transaction re-check.
- Past the cap: full XP, edition rolled, zero points, **no item grant**.
- If weekly: the Monday boundary in `America/Toronto`, including both DST transitions.
- If seasonal: capacity resets at rollover and does not carry.

---

## 2. No Hologram cap

### 2.1 What's being removed

The parks per-Hood one-Hologram-per-season cap goes. Cars never had one. No edition is
capped anywhere.

### 2.2 Keep the fall-through code

`EDITIONS` stays ordered rarest-first, and `rollEdition()` keeps its fall-through path even
though nothing exercises it now. Re-adding a cap later becomes a config change rather than a
rewrite, and the ordering guarantee is what makes the rate table correct in the first place.

Untested code rots, so keep **one** test that drives the fall-through with a synthetic cap
injected into the roll. Otherwise it will be quietly broken the day you want it back.

### 2.3 What this does to Hologram scarcity

At 2% uncapped, a player making ~30 collections a week across a 13-week season pulls roughly
**8 Holograms**. Across six players, about 47 a season.

The old cap made 25 the absolute group maximum, and in practice far fewer. So Holograms go
from genuinely scarce to roughly one every ten days per player.

Two consequences worth naming:

- **Item supply.** Each Hologram is 3 items, so Holograms alone now produce more items per
  season than the weekly item cap should allow through. That cap is doing real work — this
  is the change that makes it load-bearing rather than tidy.
- **Flavour.** Hologram is the top treatment in the binder and the Case. At one in fifty it
  is still special, but it is no longer the thing you show people. If you want a prestige
  tier back later, the lever is a fourth edition above Hologram rather than re-capping
  Hologram — capping it again would put back the fall-through behaviour you're removing now.

### 2.4 Tests to change

`test/editions.test.js` currently asserts the cap and its fall-through. Change rather than
delete: keep the rate-table assertions, keep one synthetic-cap fall-through test per §2.2,
and remove the parks-specific per-Hood cap assertions.

---

## 3. Items expire at rollover

Settled. Unspent grants expire at season rollover and armed Fortifies disarm. No carry, no
cap-and-carry.

The rollover script already exists and is idempotent via `escalation_applied`; the item
expiry belongs in it, guarded the same way so a double run doesn't double-post.

Post a chat message listing what expired, per player. People should feel it — it's what
teaches everyone to spend items in week 12 instead of hoarding them into a season that
resets.

Test: items granted in season N are unspendable in N+1, armed Fortifies are gone, and a
second run of the rollover changes nothing.
