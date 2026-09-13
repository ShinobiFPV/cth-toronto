// XP and levels — the one number in this game that never resets.
//
// Season points answer "who is winning right now". XP answers "how long have you been
// doing this", and it is deliberately a different axis:
//
//   • points scale with VALUE — a hard Hood, a far park, a steal off somebody
//   • XP scales with ACTIVITY and NOVELTY — showing up, and going somewhere new
//
// So a player who grinds four easy Hoods near home can out-point somebody in a given
// season, and still be a lower level than the person who has been everywhere once.
//
// Persistence is not a feature that had to be built: XP is derived from the claims
// ledger exactly like points are, with `xp_awarded` frozen onto each row at the moment
// it lands. Nothing filters by season, so it accumulates forever by construction, and
// there is no counter anywhere that can drift. A claim reverted by flags loses its XP
// along with its points, because `status != 'reverted'` is the only filter.
import { db } from '../db.js';
import { config } from '../config.js';
import { editionXp } from './editions.js';

/** Base XP per action. Stealing pays most; reinforcing is maintenance. */
export const ACTION_XP = {
  conquer: 50,
  steal: 70,
  reinforce: 20,
  park: 10,
  reversal: 0,
};

/**
 * A car package pays by edition and nothing else: flat, rising, never capped. Every
 * package is at least Steel. Env-tunable, unlike the rest of this schedule, because the
 * Garage is new enough that its balance is a guess — see server/config.js.
 */
export const carXp = (edition) => ({
  hologram: config.CAR_XP_HOLOGRAM,
  gold: config.CAR_XP_GOLD,
}[edition] ?? config.CAR_XP_STEEL);

/** Claim kinds that are territory. A discovery bonus for a Hood is about these only. */
const TERRITORY = "('conquer', 'steal', 'reinforce')";

/**
 * A special edition, rolled by chance when the photo lands (spec §1.8b). The numbers
 * live in lib/editions.js next to the roll that produces them.
 */

/** A rarer park card is a longer walk, so it carries a little more. */
export const RARITY_XP = {
  common: 0,
  uncommon: 5,
  rare: 15,
  legendary: 30,
};

/**
 * Going somewhere for the FIRST TIME EVER, per player, across every season. This is the
 * whole reason XP is not just a rename of the Champion total: it pays you to see the
 * city rather than to farm the corner of it you already know.
 */
export const DISCOVERY_XP = {
  hood: 100,
  park: 15,
};

/**
 * XP needed to have reached a level: 20 × L × (L−1).
 *
 *   L2 = 40        one conquer, so the first level-up is immediate and feels good
 *   L5 = 400
 *   L10 = 1,800
 *   L20 = 7,600
 *   L30 = 17,400   roughly a year of keen play
 *
 * Triangular rather than exponential, so it keeps being reachable — there is no cap and
 * no final level, because "forever" was the brief.
 */
export const xpForLevel = (level) => 20 * level * (level - 1);

/** The level a given lifetime XP total earns. Inverse of the curve above. */
export function levelOf(xp) {
  const safe = Math.max(0, Number(xp) || 0);
  // Solve 20·L·(L−1) ≤ xp for the largest integer L.
  return Math.max(1, Math.floor((1 + Math.sqrt(1 + safe / 5)) / 2));
}

/**
 * Titles per band. Levelling is mostly for the title — the number is the receipt, the
 * word is the thing you say in chat.
 */
const TITLES = [
  { at: 1, title: 'Tourist' },
  { at: 5, title: 'Local' },
  { at: 10, title: 'Regular' },
  { at: 15, title: 'Fixture' },
  { at: 20, title: 'Institution' },
  { at: 30, title: 'Landmark' },
  { at: 40, title: 'Legend' },
  { at: 55, title: 'Mythic' },
];

export const titleOf = (level) =>
  [...TITLES].reverse().find((t) => level >= t.at)?.title ?? 'Tourist';

/** Everything the UI needs to draw a level badge and a progress bar. */
export function progressOf(xp) {
  const total = Math.max(0, Number(xp) || 0);
  const level = levelOf(total);
  const floor = xpForLevel(level);
  const ceiling = xpForLevel(level + 1);
  const span = ceiling - floor;
  return {
    xp: total,
    level,
    title: titleOf(level),
    into_level: total - floor,
    level_span: span,
    to_next: ceiling - total,
    // 0..1 through the current level, for the bar.
    fraction: span > 0 ? (total - floor) / span : 0,
    next_level_at: ceiling,
  };
}

/** A player's lifetime XP. Every season, every claim kind, never reset. */
export const xpOf = (playerId) => db.prepare(`
  SELECT COALESCE(SUM(xp_awarded), 0) AS xp FROM claims
   WHERE player_id = ? AND status != 'reverted'`).get(playerId).xp;

export const progressFor = (playerId) => progressOf(xpOf(playerId));

/**
 * What a claim about to land is worth in XP, and why. Called inside the claim
 * transaction, before the row is written, so the discovery checks see the ledger as it
 * was immediately beforehand.
 *
 * @param {object} claim
 * @param {'conquer'|'steal'|'reinforce'|'park'} claim.kind
 * @param {number} claim.playerId
 * @param {number} [claim.hoodId]   for a territory claim
 * @param {number} [claim.parkId]   for a park collection
 * @param {string} [claim.rarity]   for a park collection
 */
export function xpFor({ kind, playerId, hoodId = null, parkId = null, rarity = null, edition = null }) {
  if (kind === 'car') {
    const xp = carXp(edition);
    return { xp, base: 0, bonus: 0, discovery: 0, discovered: null, edition, edition_xp: xp };
  }

  const base = ACTION_XP[kind] ?? 0;
  const bonus = kind === 'park' ? (RARITY_XP[rarity] ?? 0) : 0;
  // Luck, not value — see lib/editions.js for why this lands on XP and never on points.
  const special = kind === 'park' ? editionXp(edition) : 0;

  let discovery = 0;
  let discovered = null;

  if (kind === 'park' && parkId != null) {
    const seen = db.prepare(`
      SELECT 1 FROM claims
       WHERE player_id = ? AND park_id = ? AND status != 'reverted' LIMIT 1`)
      .get(playerId, parkId);
    if (!seen) { discovery = DISCOVERY_XP.park; discovered = 'park'; }
  } else if (kind !== 'park' && hoodId != null) {
    // Territory only. A car package also records the Hood it was snapped in, and it must
    // not count as having set foot there — "park_id IS NULL" used to mean territory, and
    // stopped meaning it the day cars joined the ledger.
    const seen = db.prepare(`
      SELECT 1 FROM claims
       WHERE player_id = ? AND hood_id = ? AND claim_kind IN ${TERRITORY}
         AND status != 'reverted' LIMIT 1`)
      .get(playerId, hoodId);
    if (!seen) { discovery = DISCOVERY_XP.hood; discovered = 'hood'; }
  }

  return {
    xp: base + bonus + discovery + special,
    base, bonus, discovery, discovered,
    edition: special > 0 ? edition : null,
    edition_xp: special,
  };
}

/**
 * Run `write`, and report any level-up it caused.
 *
 * Levels are derived, so a level-up is not an event to be stored — it is simply the
 * observation that the derived level is higher after the write than before. Returns
 * null when nothing changed, which is most of the time.
 */
export function withLevelUp(playerId, write) {
  const before = progressFor(playerId);
  const result = write();
  const after = progressFor(playerId);
  return {
    result,
    levelUp: after.level > before.level
      ? { from: before.level, to: after.level, title: after.title, xp: after.xp }
      : null,
    progress: after,
  };
}
