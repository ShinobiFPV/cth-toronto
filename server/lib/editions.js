// Special editions: Steel, Gold, Hologram.
//
// A card already has a *rarity*, which comes from the park's value — how far out it is,
// knowable before you leave the house, and the same for everybody who collects it.
// An *edition* is the other thing entirely: pure luck, rolled at the moment the photo
// lands, and the reason it is worth photographing a park somebody else already has.
//
// Three decisions worth keeping:
//
//   1. **The roll uses fresh randomness, not `card_seed`.** Deriving it from the seed
//      would have been tidy — deterministic, no new column — but the seed is
//      sha256('cth-parkemon:player:park:season') and that salt lives in a public repo.
//      Anybody could precompute which parks would hand them a Gold this season and go
//      collect exactly those. A chance prize you can shop for is not a chance prize.
//
//   2. **Editions pay XP, never points.** Points are the season race, and a race decided
//      by luck is not a race. XP is lifetime and never resets, so a lucky pull is a
//      permanent little keepsake that leaves the table alone. (Gold and Hologram also
//      grant items — see lib/items.js — which is why those have their own weekly cap.)
//
//   3. **One draw mapped to ranges, not three sequential checks.** Sequential one-in-N
//      checks make Clover's "double the specials" arithmetic hard to reason about and
//      harder to test. A single draw against a table that sums to 100 is the table.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';

/** The resolution of one draw. Fine enough that a 0.5% rate is still exact. */
export const ROLL_SCALE = 1_000_000;

/**
 * Rarest first. That is the order the ranges are laid out in — so an all-hits roll (a
 * draw of 0) is a Hologram rather than being demoted — and the order the fall-through
 * walks when a cap says an edition is gone.
 */
export const EDITIONS = [
  { key: 'hologram', label: 'Hologram', xp: 100 },
  { key: 'gold', label: 'Gold', xp: 40 },
  { key: 'steel', label: 'Steel', xp: 15 },
];

const byKey = Object.fromEntries(EDITIONS.map((e) => [e.key, e]));

/** XP a card's edition adds on top of its action and rarity XP. */
export const editionXp = (edition) => byKey[edition]?.xp ?? 0;

export const editionLabel = (edition) => byKey[edition]?.label ?? null;

/**
 * The rate table, in percent, at base or under an active Clover. Steel is the remainder,
 * so the three always sum to exactly 100. The specials are clamped so a raised base rate
 * multiplied by Clover can never ask for more than the whole draw.
 */
export function editionRates({ clover = false } = {}) {
  const m = clover ? Math.max(1, config.CLOVER_MULTIPLIER) : 1;
  const sane = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const hologram = Math.min(100, sane(config.EDITION_HOLOGRAM_PCT) * m);
  const gold = Math.min(100 - hologram, sane(config.EDITION_GOLD_PCT) * m);
  return { hologram, gold, steel: 100 - hologram - gold };
}

/**
 * Roll a card's edition. Every card is at least Steel.
 *
 * `rand(n)` must return an integer in [0, n), which is crypto.randomInt's contract; it is
 * injectable so tests can force an outcome or run a seeded sample. `clover` doubles the
 * specials. The caller reads the clock once and decides `clover` from it, so a roll can
 * never straddle a Clover's expiry between the check and the draw.
 *
 * `capped(key)` is the fall-through hook. Nothing passes one today — no edition is capped
 * anywhere — but it is kept, and tested with a synthetic cap, so putting a cap back is a
 * config change rather than a rewrite. A hit on a capped edition is not thrown away: it
 * lands on the next edition down, and Steel can never be capped.
 */
export function rollEdition({ rand = crypto.randomInt, clover = false, capped = () => false } = {}) {
  const rates = editionRates({ clover });
  const draw = rand(ROLL_SCALE);

  // Cumulative bounds rounded once each, so rounding can never open a gap or an overlap.
  let cumulative = 0;
  let hit = EDITIONS.length - 1;
  for (let i = 0; i < EDITIONS.length; i += 1) {
    cumulative += rates[EDITIONS[i].key];
    if (draw < Math.round((cumulative / 100) * ROLL_SCALE)) { hit = i; break; }
  }

  for (let i = hit; i < EDITIONS.length; i += 1) {
    const { key } = EDITIONS[i];
    if (key === 'steel' || !capped(key)) return key;
  }
  return 'steel';
}

/**
 * How many of each edition a player holds. Drives the binder's chips and filter, and the
 * Case's — `kind` says which shelf.
 */
export function editionCounts(playerId, { seasonId = null, kind = 'park' } = {}) {
  const rows = db.prepare(`
    SELECT c.edition, COUNT(*) AS n FROM claims c
      LEFT JOIN card_holdings hold ON hold.claim_id = c.id
     WHERE COALESCE(hold.holder_id, c.player_id) = ?
       AND ${kind === 'car' ? "c.claim_kind = 'car'" : 'c.park_id IS NOT NULL'}
       AND c.status != 'reverted' AND c.edition IS NOT NULL
       ${seasonId ? 'AND c.season_id = ?' : ''}
     GROUP BY c.edition`)
    .all(...(seasonId ? [playerId, seasonId] : [playerId]));
  return Object.fromEntries(rows.map((r) => [r.edition, r.n]));
}
