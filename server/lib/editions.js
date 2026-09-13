// Special editions: Steel, Gold, Hologram.
//
// A card already has a *rarity*, which comes from the park's value — how far out it is,
// knowable before you leave the house, and the same for everybody who collects it.
// An *edition* is the other thing entirely: pure luck, rolled at the moment the photo
// lands, and the reason it is worth photographing a park somebody else already has.
//
// Two decisions worth keeping:
//
//   1. **The roll uses fresh randomness, not `card_seed`.** Deriving it from the seed
//      would have been tidy — deterministic, no new column — but the seed is
//      sha256('cth-parkemon:player:park:season') and that salt lives in a public repo.
//      Anybody could precompute which parks would hand them a Gold this season and go
//      collect exactly those. A chance prize you can shop for is not a chance prize.
//
//   2. **Editions pay XP, never points.** Points are the season race, and a race decided
//      by luck is not a race. XP is lifetime and never resets, so a lucky pull is a
//      permanent little keepsake that leaves the table alone.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';

/**
 * Rarest first, because that is the order the roll checks them in — a card that came up
 * Hologram must not then be demoted by a later, easier test.
 */
export const EDITIONS = [
  // A hologram is worth as much XP as setting foot in a Hood for the first time. It
  // should be: there are at most 25 of them in a season.
  { key: 'hologram', label: 'Hologram', xp: 100, oneIn: () => config.EDITION_HOLO_ONE_IN },
  { key: 'gold', label: 'Gold', xp: 40, oneIn: () => config.EDITION_GOLD_ONE_IN },
  { key: 'steel', label: 'Steel', xp: 15, oneIn: () => config.EDITION_STEEL_ONE_IN },
];

const byKey = Object.fromEntries(EDITIONS.map((e) => [e.key, e]));

/** XP a card's edition adds on top of its action and rarity XP. */
export const editionXp = (edition) => byKey[edition]?.xp ?? 0;

export const editionLabel = (edition) => byKey[edition]?.label ?? null;

/**
 * How many park holograms a Hood has already yielded this season. Parks only: a car
 * package pulled in Hood 13 carries that hood_id too, and must not use up the Hood 13
 * park hologram — the Garage has its own cap (lib/garage.js).
 */
export const holosInHood = (hoodId, seasonId) => db.prepare(`
  SELECT COUNT(*) AS n FROM claims
   WHERE hood_id = ? AND season_id = ? AND edition = 'hologram' AND status != 'reverted'
     AND park_id IS NOT NULL`)
  .get(hoodId, seasonId).n;

/**
 * Roll a card's edition. Returns null for a standard card, which is most of them.
 *
 * `rand` is injectable so tests can force an outcome; in production it is
 * crypto.randomInt, which is uniform and not seedable from outside.
 *
 * The hologram cap is enforced here rather than by simply making holograms rarer,
 * because the two say different things: the 1-in-N is "did you get lucky", and the cap
 * is "is this Hood's hologram still out there". A Hood whose hologram has gone can still
 * produce Gold and Steel — the roll falls through to the next edition down, which is
 * another reason EDITIONS is ordered rarest first.
 *
 * Call this inside the collection's transaction. The cap is a read followed by a write,
 * and better-sqlite3 is synchronous, so inside one transaction there is no window for
 * two collections to both mint the last hologram.
 */
export function rollEdition({
  hoodId, seasonId, rand = crypto.randomInt,
  // Is the hologram this roll could mint already gone? Parks ask per Hood; the Garage
  // passes its own question. The roll itself — odds, order, fall-through — is shared.
  holoTaken = () => holosInHood(hoodId, seasonId) >= config.HOLO_PER_HOOD_PER_SEASON,
}) {
  for (const edition of EDITIONS) {
    const oneIn = edition.oneIn();
    if (!Number.isFinite(oneIn) || oneIn < 1) continue;   // 0 or nonsense disables it
    if (rand(oneIn) !== 0) continue;

    if (edition.key === 'hologram' && holoTaken()) {
      // This Hood's hologram is already out there. Keep going rather than returning
      // null: the luck was real, so let it land on the next edition down.
      continue;
    }
    return edition.key;
  }
  return null;
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
