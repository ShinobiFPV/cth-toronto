// Parks: the sub-game inside each Hood, and the app's namesake.
//
// Every Toronto park has the same green sign with the park's name on it. You photograph
// the sign, you collect the park, you get a card. Each park is collectable once per
// season per player, and nobody competes over one — there is no owner, no stealing, no
// cooldown. The points simply add to your score.
//
// Collections ride in the same `claims` ledger as territory, with claim_kind = 'park'
// and park_id set. That is what makes scoring, the feed, chat and flagging work on them
// for free. They never touch hood_state: taking a park takes nothing from anybody.
import crypto from 'node:crypto';
import { db, nowIso } from '../db.js';
import { GameError, notFound } from './errors.js';
import { activeSeason } from './seasons.js';
import { hoodLabel } from './hood-seed.js';
import { xpFor } from './xp.js';
import { cleanCaption } from './captions.js';
import { rollEdition, editionLabel, editionCounts } from './editions.js';

/** Rarity tiers, driven by the park's value. Drives the card art, nothing mechanical. */
export const RARITIES = [
  { key: 'common', label: 'Common', min: 0 },
  { key: 'uncommon', label: 'Uncommon', min: 25 },
  { key: 'rare', label: 'Rare', min: 50 },
  { key: 'legendary', label: 'Legendary', min: 75 },
];

export const rarityOf = (value) =>
  [...RARITIES].reverse().find((r) => value >= r.min) ?? RARITIES[0];

/**
 * The card's art seed. Deterministic from player, park and season, so the same
 * collection always renders the same card — and two players collecting the same park in
 * the same season still get visibly different borders.
 *
 * The salt keeps the game's old name on purpose. It is a hash input, not a label: every
 * card_seed already stored on a claim was derived from this exact string, and changing
 * it would only mean future seeds come from a different one than past seeds for no
 * visible gain. Renaming Parkemon to Parkemans stopped here.
 */
export const cardSeed = (playerId, parkId, seasonId) =>
  crypto.createHash('sha256')
    .update(`cth-parkemon:${playerId}:${parkId}:${seasonId}`)
    .digest('hex')
    .slice(0, 16);

const PARK_SELECT = `
  SELECT p.*, h.name AS hood_name
    FROM parks p
    LEFT JOIN hoods h ON h.id = p.hood_id`;

export function getPark(parkId) {
  return db.prepare(`${PARK_SELECT} WHERE p.id = ?`).get(parkId) ?? null;
}

export function shapePark(row, collection = null) {
  return {
    id: row.id,
    name: row.name,
    hood_id: row.hood_id,
    hood_label: row.hood_id ? hoodLabel(row.hood_id, row.hood_name) : null,
    lat: row.lat,
    lng: row.lng,
    address: row.address,
    amenities: row.amenities ? row.amenities.split(',').map((a) => a.trim()).filter(Boolean) : [],
    url: row.url,
    value: row.value,
    distance_km: row.distance_km,
    set_number: row.set_number,
    rarity: rarityOf(row.value).key,
    rarity_label: rarityOf(row.value).label,
    collected: !!collection,
    collection: collection ?? null,
  };
}

/**
 * Every park in a Hood, with whether this player has collected it this season.
 * About 60 parks per Hood, so this is one cheap query rather than anything paginated.
 */
export function listParksInHood(hoodId, playerId, at = nowIso()) {
  const season = activeSeason(at);
  const parks = db.prepare(`${PARK_SELECT} WHERE p.hood_id = ? ORDER BY p.name`).all(hoodId);

  const mine = season ? new Map(db.prepare(`
    SELECT c.park_id, c.id, c.points_awarded, c.card_seed, c.created_at, c.status,
           c.edition,
           ph.path_thumb, ph.path_display, ph.caption
      FROM claims c
 LEFT JOIN photos ph ON ph.id = c.photo_id
     WHERE c.player_id = ? AND c.season_id = ? AND c.park_id IS NOT NULL
       AND c.status != 'reverted'`)
    .all(playerId, season.id)
    .map((r) => [r.park_id, shapeCollection(r)])) : new Map();

  return parks.map((p) => shapePark(p, mine.get(p.id) ?? null));
}

const shapeCollection = (r) => ({
  claim_id: r.id,
  points: r.points_awarded,
  card_seed: r.card_seed,
  edition: r.edition ?? null,
  edition_label: editionLabel(r.edition),
  created_at: r.created_at,
  status: r.status,
  thumb_url: r.path_thumb ? `/media/${r.path_thumb}` : null,
  display_url: r.path_display ? `/media/${r.path_display}` : null,
  caption: r.caption ?? null,
});

/**
 * Every park in the city, for the dots on the main map: where it is, what it pays, and
 * whether this player already has it this season.
 *
 * Keys are short because there are 1,513 of them and this is the one payload in the app
 * where that matters — `{i, la, ln, v, h, c}` is id, lat, lng, value, hood, collected.
 * Names are left out: on a phone there is no hover, so a dot is tapped rather than
 * peeked at, and the park's own screen has the name.
 */
export function parksForMap(playerId, at = nowIso()) {
  const season = activeSeason(at);
  // The once-per-season unique index makes this join 1:1, so no DISTINCT is needed.
  const rows = db.prepare(`
    SELECT p.id, p.lat, p.lng, p.value, p.hood_id,
           CASE WHEN c.id IS NULL THEN 0 ELSE 1 END AS collected
      FROM parks p
 LEFT JOIN claims c ON c.park_id = p.id AND c.player_id = ? AND c.season_id = ?
                   AND c.status != 'reverted'
     ORDER BY p.id`).all(playerId, season?.id ?? -1);

  return {
    season_id: season?.id ?? null,
    total: rows.length,
    collected: rows.reduce((n, r) => n + r.collected, 0),
    parks: rows.map((r) => ({
      i: r.id, la: r.lat, ln: r.lng, v: r.value, h: r.hood_id, c: r.collected,
    })),
  };
}

/** How a Hood's parks progress looks in one line, for the Hood sheet and the map. */
export function parkProgress(hoodId, playerId, at = nowIso()) {
  const season = activeSeason(at);
  const total = db.prepare('SELECT COUNT(*) AS n FROM parks WHERE hood_id = ?').get(hoodId).n;
  const collected = season ? db.prepare(`
    SELECT COUNT(*) AS n FROM claims c
      JOIN parks p ON p.id = c.park_id
     WHERE c.player_id = ? AND c.season_id = ? AND p.hood_id = ? AND c.status != 'reverted'`)
    .get(playerId, season.id, hoodId).n : 0;
  const points = season ? db.prepare(`
    SELECT COALESCE(SUM(c.points_awarded), 0) AS pts FROM claims c
      JOIN parks p ON p.id = c.park_id
     WHERE c.player_id = ? AND c.season_id = ? AND p.hood_id = ? AND c.status != 'reverted'`)
    .get(playerId, season.id, hoodId).pts : 0;

  return { total, collected, points, remaining: total - collected };
}

/**
 * Can this player collect this park right now? Pure, no writes — the park sheet calls
 * it so the button can be right before the camera opens.
 */
export function evaluateCollect({ parkId, playerId, at = nowIso() }) {
  const park = getPark(parkId);
  if (!park) throw notFound('PARK_NOT_FOUND', 'No park with that id.');

  const season = activeSeason(at);
  const base = {
    park_id: park.id,
    park_name: park.name,
    hood_id: park.hood_id,
    points: park.value,
    rarity: rarityOf(park.value).key,
    // The card's palette comes from the season, so the sheet needs it even when the
    // answer is "you already have this one".
    season: season ? { id: season.id, name: season.name } : null,
  };

  if (!season) {
    return { ...base, ok: false, error: 'NO_ACTIVE_SEASON',
      message: 'The game is between seasons — no collecting right now.' };
  }

  const existing = db.prepare(`
    SELECT id FROM claims
     WHERE player_id = ? AND park_id = ? AND season_id = ? AND status != 'reverted'`)
    .get(playerId, parkId, season.id);

  if (existing) {
    return { ...base, ok: false, error: 'ALREADY_COLLECTED',
      message: `You already have ${park.name} this season. Each park is once a season — `
        + `it comes back in ${season.name === 'Summer 2027' ? 'the next game' : 'the next season'}.`,
      claim_id: existing.id };
  }

  return { ...base, ok: true, error: null, message: null, season_id: season.id };
}

/**
 * Collect a park. One transaction: photo row, ledger row, done. Nothing to update in
 * hood_state, because nothing changed hands.
 */
export const commitCollect = db.transaction((
  // `rand` exists so a test can force an edition; production never passes it and gets
  // crypto.randomInt. See lib/editions.js.
  { parkId, playerId, photo, caption = null, rand = undefined },
) => {
  const at = nowIso();
  const evaluation = evaluateCollect({ parkId, playerId, at });
  if (!evaluation.ok) {
    throw new GameError(evaluation.error, evaluation.message, { claim_id: evaluation.claim_id });
  }

  const park = getPark(parkId);
  const seasonId = evaluation.season_id;

  // Luck, rolled once, here, and frozen onto the row — a card's edition is as immutable
  // as its points. Inside this transaction, so two collections cannot both mint the
  // last hologram in a Hood.
  const edition = rollEdition({ hoodId: park.hood_id, seasonId, ...(rand ? { rand } : {}) });

  const earned = xpFor({
    kind: 'park', playerId, parkId: park.id, rarity: rarityOf(park.value).key, edition,
  });

  const photoRow = db.prepare(`
    INSERT INTO photos (player_id, photo_type, path_original, path_display, path_thumb,
                        width, height, bytes, exif_json, caption, created_at)
    VALUES (@player_id, 'park_sign', @path_original, @path_display, @path_thumb,
            @width, @height, @bytes, @exif_json, @caption, @created_at)`)
    .run({
      player_id: playerId,
      caption: cleanCaption(caption),
      path_original: photo.path_original,
      path_display: photo.path_display,
      path_thumb: photo.path_thumb,
      width: photo.width ?? null,
      height: photo.height ?? null,
      bytes: photo.bytes ?? null,
      exif_json: photo.exif_json ?? null,
      created_at: at,
    });

  const row = db.prepare(`
    INSERT INTO claims (hood_id, player_id, season_id, photo_id, claim_kind, photo_type,
                        points_awarded, xp_awarded, status, flag_count, park_id,
                        card_seed, edition, created_at)
    VALUES (?, ?, ?, ?, 'park', 'park_sign', ?, ?, 'active', 0, ?, ?, ?, ?)`)
    .run(park.hood_id, playerId, seasonId, photoRow.lastInsertRowid,
         park.value, earned.xp, park.id, cardSeed(playerId, park.id, seasonId),
         edition, at);

  return {
    claim: getCardByClaim(Number(row.lastInsertRowid)),
    park,
    season_id: seasonId,
    xp: earned,
  };
});

// `holder_id` is COALESCE(the holdings override, whoever collected it) — see
// lib/trades.js. A card that has never been traded has no holdings row at all.
const CARD_SELECT = `
  SELECT c.id AS claim_id, c.player_id, c.season_id, c.points_awarded, c.card_seed,
         c.created_at, c.status, c.flag_count, c.edition,
         p.id AS park_id, p.name AS park_name, p.value, p.hood_id, p.address,
         p.distance_km, p.set_number,
         h.name AS hood_name,
         s.name AS season_name,
         pl.handle, pl.display_name, pl.colour,
         ph.path_thumb, ph.path_display, ph.caption,
         COALESCE(hold.holder_id, c.player_id) AS holder_id,
         hold.acquired_at,
         hd.handle AS holder_handle, hd.display_name AS holder_name, hd.colour AS holder_colour
    FROM claims c
    JOIN parks   p  ON p.id = c.park_id
    JOIN players pl ON pl.id = c.player_id
    LEFT JOIN hoods   h  ON h.id = p.hood_id
    LEFT JOIN seasons s  ON s.id = c.season_id
    LEFT JOIN photos  ph ON ph.id = c.photo_id
    LEFT JOIN card_holdings hold ON hold.claim_id = c.id
    LEFT JOIN players hd ON hd.id = hold.holder_id`;

/**
 * How many parks are in the set. Printed on every card as "#0123/1513", so it is read
 * constantly and changes only when someone re-runs the importer — hence the cache.
 */
let setSizeCache = null;
export const setSize = () => {
  if (setSizeCache == null) setSizeCache = db.prepare('SELECT COUNT(*) AS n FROM parks').get().n;
  return setSizeCache;
};
export const forgetSetSize = () => { setSizeCache = null; };

export function shapeCard(r) {
  const rarity = rarityOf(r.value);
  return {
    kind: 'park',
    claim_id: r.claim_id,
    set_size: setSize(),
    park: {
      id: r.park_id,
      name: r.park_name,
      value: r.value,
      hood_id: r.hood_id,
      hood_label: r.hood_id ? hoodLabel(r.hood_id, r.hood_name) : null,
      address: r.address,
      distance_km: r.distance_km,
      set_number: r.set_number,
    },
    // Who photographed the sign. Printed on the card, and never changes — a trade
    // moves the card, not the credit for having gone there.
    player: { id: r.player_id, handle: r.handle, display_name: r.display_name, colour: r.colour },
    // Who has it now. Equal to `player` on a card that has never been traded.
    holder: r.holder_id === r.player_id
      ? { id: r.player_id, handle: r.handle, display_name: r.display_name, colour: r.colour }
      : { id: r.holder_id, handle: r.holder_handle, display_name: r.holder_name, colour: r.holder_colour },
    traded: r.holder_id !== r.player_id,
    acquired_at: r.acquired_at ?? null,
    season: { id: r.season_id, name: r.season_name },
    points: r.points_awarded,
    rarity: rarity.key,
    rarity_label: rarity.label,
    // Rarity is the park; edition is the luck. Null on a standard card.
    edition: r.edition ?? null,
    edition_label: editionLabel(r.edition),
    card_seed: r.card_seed,
    status: r.status,
    flag_count: r.flag_count,
    collected_at: r.created_at,
    thumb_url: r.path_thumb ? `/media/${r.path_thumb}` : null,
    display_url: r.path_display ? `/media/${r.path_display}` : null,
    // Flavour text, in the same place a real card puts it.
    caption: r.caption ?? null,
  };
}

export const getCardByClaim = (claimId) => {
  const row = db.prepare(`${CARD_SELECT} WHERE c.id = ?`).get(claimId);
  return row ? shapeCard(row) : null;
};

/**
 * A player's binder: the cards they **hold**, which after a trade is not the same set
 * as the cards they collected. Newest first, optionally scoped to one season.
 *
 * Scored totals are a separate question and stay with the collector — see
 * collectionSummary, which counts claims rather than holdings.
 */
export function cardsOf(playerId, { seasonId = null, limit = 500 } = {}) {
  const held = "COALESCE(hold.holder_id, c.player_id) = ?";
  const rows = seasonId
    ? db.prepare(`${CARD_SELECT} WHERE ${held} AND c.season_id = ? AND c.status != 'reverted'
                  ORDER BY c.id DESC LIMIT ?`).all(playerId, seasonId, limit)
    : db.prepare(`${CARD_SELECT} WHERE ${held} AND c.status != 'reverted'
                  ORDER BY c.id DESC LIMIT ?`).all(playerId, limit);
  return rows.map(shapeCard);
}

/** Collection totals for a player: how much of Toronto they have in the binder. */
export function collectionSummary(playerId, at = nowIso()) {
  const season = activeSeason(at);
  const total = db.prepare('SELECT COUNT(*) AS n FROM parks').get().n;
  const setSize = total;

  const seasonRow = season ? db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(points_awarded), 0) AS pts FROM claims
     WHERE player_id = ? AND season_id = ? AND park_id IS NOT NULL AND status != 'reverted'`)
    .get(playerId, season.id) : { n: 0, pts: 0 };

  const allTime = db.prepare(`
    SELECT COUNT(DISTINCT park_id) AS parks, COALESCE(SUM(points_awarded), 0) AS pts
      FROM claims
     WHERE player_id = ? AND park_id IS NOT NULL AND status != 'reverted'`).get(playerId);

  // Held rather than collected, because these chips label the card grid and the grid
  // shows holdings. The collected figures above are the ones that scored.
  const byRarity = db.prepare(`
    SELECT p.value FROM claims c
      JOIN parks p ON p.id = c.park_id
      LEFT JOIN card_holdings hold ON hold.claim_id = c.id
     WHERE COALESCE(hold.holder_id, c.player_id) = ?
       AND c.park_id IS NOT NULL AND c.status != 'reverted'
       ${season ? 'AND c.season_id = ?' : ''}`)
    .all(...(season ? [playerId, season.id] : [playerId]))
    .reduce((acc, r) => {
      const key = rarityOf(r.value).key;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

  // Holdings, which trading makes a different question from collections. Kept
  // separate on purpose: the collected numbers are the ones that scored.
  const held = db.prepare(`
    SELECT COUNT(*) AS n FROM claims c
      LEFT JOIN card_holdings hold ON hold.claim_id = c.id
     WHERE COALESCE(hold.holder_id, c.player_id) = ?
       AND c.park_id IS NOT NULL AND c.status != 'reverted'`).get(playerId).n;

  const traded = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM card_holdings h JOIN claims c ON c.id = h.claim_id
        WHERE h.holder_id = ? AND c.player_id != ? AND c.park_id IS NOT NULL
          AND c.status != 'reverted') AS received,
      (SELECT COUNT(*) FROM card_holdings h JOIN claims c ON c.id = h.claim_id
        WHERE c.player_id = ? AND h.holder_id != ? AND c.park_id IS NOT NULL
          AND c.status != 'reverted') AS given`)
    .get(playerId, playerId, playerId, playerId);

  return {
    parks_total: total,
    set_size: setSize,
    season_collected: seasonRow.n,
    season_points: seasonRow.pts,
    distinct_parks_all_time: allTime.parks,
    all_time_points: allTime.pts,
    by_rarity: byRarity,
    cards_held: held,
    cards_received: traded.received,
    cards_given_away: traded.given,
    by_edition: editionCounts(playerId, { seasonId: season?.id ?? null }),
    season,
  };
}
