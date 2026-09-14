// Scavenger Blitz: five-item hunts, in a park or on the street.
//
//   park    five things to find in one park — at least two of its own amenities, the rest
//           things any green space has. The easy mode, made for doing with a kid.
//   street  five passenger vehicles by make, model and year window: three common, two
//           uncommon, so a hunt starts fast and keeps a tail worth a week.
//
// Three active hunts at a time, no time limit, and they survive season rollover. Completion
// writes an ordinary claims row — claim_kind = 'hunt' — so scoring, the feed, chat, flags
// and reversal all work with no special cases, exactly as parks and cars do.
//
// Rules worth keeping:
//
//   - **Confirm, don't gatekeep.** A photo the camera does not confirm can still be marked
//     found with "I'm sure", which raises it for the group like a disputed claim.
//   - **Hunt progress and card minting are independent.** A street photo can tick its slot
//     when the car is already in the binder or past the weekly car cap. They are separate
//     systems that happen to share a photo.
//   - **Rewards attribute to the season a hunt is COMPLETED in**, and the season points cap
//     applies there.
//   - **Hunt items are exempt from the weekly item cap**; hunts have their own weekly limit
//     on scoring completions instead. Past it, a hunt completes for XP only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { db, nowIso, isoPlusHours } from '../db.js';
import { config } from '../config.js';
import { GameError, badRequest, notFound } from './errors.js';
import { activeSeason } from './seasons.js';
import { hoodLabel } from './hood-seed.js';
import { weekKey, weekStartName } from './week.js';
import { humanUntil } from './time.js';
import { commitCar } from './cars.js';
import { makeKey, squash } from './vehicles.js';
import { grantHuntItems } from './items.js';
import { generateParkHunt, generateStreetHunt, seasonKeyFor } from './hunt-generate.js';
import { AMENITY_ITEMS } from './hunt-pool.js';

export const HUNT_KINDS = ['park', 'street'];

// ── the vehicle list ──────────────────────────────────────────────────────

let vehicleCache = null;
/** The street target list, re-read whenever the file changes. */
export function loadHuntVehicles(file = config.HUNT_VEHICLES_FILE) {
  const stat = fs.statSync(file);
  if (vehicleCache?.file !== file || vehicleCache.mtime !== stat.mtimeMs) {
    vehicleCache = { file, mtime: stat.mtimeMs, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  return vehicleCache.data;
}

// ── reading ───────────────────────────────────────────────────────────────

export const parkAmenityKeys = (parkId) => db.prepare(
  'SELECT amenity FROM park_amenities WHERE park_id = ? ORDER BY amenity').all(parkId).map((r) => r.amenity);

export const huntTitle = (hunt) => (hunt.kind === 'park'
  ? `Scavenger Blitz at ${hunt.park_name ?? 'the park'}`
  : 'Street Blitz');

const HUNT_SELECT = `
  SELECT h.*, p.name AS park_name, p.hood_id AS park_hood_id, hd.name AS park_hood_name
    FROM hunts h
    LEFT JOIN parks p  ON p.id = h.park_id
    LEFT JOIN hoods hd ON hd.id = p.hood_id`;

const huntRow = (id) => db.prepare(`${HUNT_SELECT} WHERE h.id = ?`).get(id) ?? null;

/**
 * A hunt as the client sees it. Photos are the owner's own: another player's view of a hunt
 * never carries its thumbnails.
 */
export function getHunt(huntId, viewerId = null) {
  const h = huntRow(huntId);
  if (!h) return null;
  const items = db.prepare(`
    SELECT i.*, ph.path_thumb FROM hunt_items i
      LEFT JOIN photos ph ON ph.id = i.photo_id
     WHERE i.hunt_id = ? ORDER BY i.slot`).all(h.id);
  const mine = viewerId != null && viewerId === h.player_id;
  return {
    id: h.id,
    kind: h.kind,
    title: huntTitle(h),
    status: h.status,
    player_id: h.player_id,
    seed: h.seed,
    pool_version: h.pool_version,
    park: h.park_id ? {
      id: h.park_id, name: h.park_name, hood_id: h.park_hood_id,
      hood_label: h.park_hood_id ? hoodLabel(h.park_hood_id, h.park_hood_name) : null,
    } : null,
    started_at: h.started_at,
    completed_at: h.completed_at,
    ended_at: h.ended_at,
    season_id: h.season_id,
    claim_id: h.claim_id,
    scoring: !!h.scoring,
    found: items.filter((i) => i.completed_at).length,
    total: items.length,
    items: items.map((i) => ({
      slot: i.slot,
      target_type: i.target_type,
      target_key: i.target_key,
      label: i.label,
      tier: i.target_json ? JSON.parse(i.target_json).tier ?? null : null,
      done: !!i.completed_at,
      verified: !!i.verified,
      overridden: !!i.overridden,
      // A photo was sent and the camera did not confirm it: "I'm sure" is available.
      pending: !!i.photo_id && !i.completed_at,
      completed_at: i.completed_at,
      thumb_url: mine && i.path_thumb ? `/media/${i.path_thumb}` : null,
    })),
  };
}

/** What the feed needs to name a hunt claim. */
export function huntBrief(huntId) {
  const h = huntId ? huntRow(huntId) : null;
  return h ? { id: h.id, kind: h.kind, title: huntTitle(h) } : null;
}

const activeCount = (playerId) => db.prepare(
  "SELECT COUNT(*) AS n FROM hunts WHERE player_id = ? AND status = 'active'").get(playerId).n;

/** When this player may abandon another hunt, or null if they may now. */
export function abandonCooldown(playerId, at = nowIso()) {
  const hours = config.HUNT_ABANDON_COOLDOWN_HOURS;
  if (!(hours > 0)) return null;
  const last = db.prepare(`
    SELECT ended_at FROM hunts WHERE player_id = ? AND status = 'abandoned'
     ORDER BY ended_at DESC LIMIT 1`).get(playerId);
  if (!last?.ended_at) return null;
  const until = isoPlusHours(last.ended_at, hours);
  return until > at ? until : null;
}

/** Hunt points already scored this season. Reverted completions give theirs back. */
export const huntPointsInSeason = (playerId, seasonId) => db.prepare(`
  SELECT COALESCE(SUM(points_awarded), 0) AS pts FROM claims
   WHERE player_id = ? AND season_id = ? AND claim_kind = 'hunt' AND status != 'reverted'`)
  .get(playerId, seasonId).pts;

/** Scoring completions this week. A completion thrown out by flags frees its place. */
export const scoringCompletionsInWeek = (playerId, week) => db.prepare(`
  SELECT COUNT(*) AS n FROM hunts h JOIN claims c ON c.id = h.claim_id
   WHERE h.player_id = ? AND h.week_key = ? AND h.scoring = 1 AND c.status != 'reverted'`)
  .get(playerId, week).n;

/** Active hunts, the last few finished ones, and where the player stands on every limit. */
export function huntsFor(playerId, at = nowIso()) {
  const ids = db.prepare(`
    SELECT id FROM hunts WHERE player_id = ? AND status = 'active'
    UNION ALL
    SELECT id FROM (SELECT id FROM hunts WHERE player_id = ? AND status != 'active'
                     ORDER BY COALESCE(completed_at, ended_at) DESC LIMIT 10)`).all(playerId, playerId);
  const hunts = ids.map((r) => getHunt(r.id, playerId));
  const season = activeSeason(at);
  const week = weekKey(at);
  const active = hunts.filter((h) => h.status === 'active');
  return {
    active,
    recent: hunts.filter((h) => h.status !== 'active'),
    limits: {
      slots: config.HUNT_ACTIVE_LIMIT,
      used: active.length,
      abandon_available_at: abandonCooldown(playerId, at),
      week_scoring: scoringCompletionsInWeek(playerId, week),
      week_limit: config.HUNT_WEEKLY_SCORING_LIMIT,
      resets_on: weekStartName(),
      season_points: season ? huntPointsInSeason(playerId, season.id) : 0,
      season_cap: config.HUNT_SEASON_POINTS_CAP,
      points_per_hunt: config.HUNT_POINTS,
      items_per_hunt: config.HUNT_ITEMS,
      xp_park: config.HUNT_XP_PARK,
      xp_street: config.HUNT_XP_STREET,
    },
  };
}

/**
 * For the park picker: which parks have amenities worth hunting this season. Positions are
 * not here — the picker already holds them, and a location never comes to the server.
 */
export function amenityIndex(at = nowIso()) {
  const season = seasonKeyFor(at, activeSeason(at));
  const parks = {};
  for (const { park_id: parkId, amenity } of db.prepare('SELECT park_id, amenity FROM park_amenities').all()) {
    const item = AMENITY_ITEMS[amenity];
    if (!item || !item.seasons.includes(season)) continue;
    (parks[parkId] ??= []).push(item.label);
  }
  return { season, parks };
}

// ── starting and abandoning ───────────────────────────────────────────────

/**
 * Start a hunt. The five items are generated from a fresh seed and frozen, labels and all.
 * `seed` and `vehicles` are injectable for tests.
 */
export const startHunt = db.transaction(({
  playerId, kind, parkId = null, at = nowIso(),
  seed = crypto.randomBytes(8).toString('hex'), vehicles = null,
}) => {
  if (!HUNT_KINDS.includes(kind)) throw badRequest('BAD_HUNT_KIND', 'A hunt is either a park hunt or a street hunt.');
  if (activeCount(playerId) >= config.HUNT_ACTIVE_LIMIT) {
    throw new GameError('HUNT_SLOTS_FULL',
      `You already have ${config.HUNT_ACTIVE_LIMIT} hunts going. Finish or abandon one to start another.`);
  }

  let items;
  let park = null;
  let poolVersion = null;
  if (kind === 'park') {
    park = db.prepare('SELECT id, name FROM parks WHERE id = ?').get(Number(parkId));
    if (!park) throw notFound('PARK_NOT_FOUND', 'Pick a park for the hunt.');
    items = generateParkHunt({
      seed, amenities: parkAmenityKeys(park.id), season: seasonKeyFor(at, activeSeason(at)),
    });
  } else {
    const list = vehicles ? { vehicles, version: 'test' } : loadHuntVehicles();
    poolVersion = String(list.version ?? '');
    items = generateStreetHunt({
      seed, vehicles: list.vehicles, common: config.HUNT_COMMON, uncommon: config.HUNT_UNCOMMON,
    });
  }

  const huntId = Number(db.prepare(`
    INSERT INTO hunts (player_id, kind, park_id, seed, pool_version, status, started_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)`).run(playerId, kind, park?.id ?? null, seed, poolVersion, at).lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO hunt_items (hunt_id, slot, target_type, target_key, label, target_json)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const item of items) {
    insert.run(huntId, item.slot, item.target_type, item.target_key, item.label,
      item.target ? JSON.stringify(item.target) : null);
  }
  return getHunt(huntId, playerId);
});

/** Give up on a hunt: no reward, the slot back — and a cooldown, because it is a reroll. */
export const abandonHunt = db.transaction(({ playerId, huntId, at = nowIso() }) => {
  const hunt = db.prepare('SELECT * FROM hunts WHERE id = ?').get(Number(huntId));
  if (!hunt || hunt.player_id !== playerId) throw notFound('HUNT_NOT_FOUND', 'No hunt of yours with that id.');
  if (hunt.status === 'complete') throw new GameError('HUNT_COMPLETE', 'That hunt is already finished.');
  if (hunt.status !== 'active') throw new GameError('HUNT_NOT_ACTIVE', 'That hunt was already abandoned.');
  const until = abandonCooldown(playerId, at);
  if (until) {
    throw new GameError('ABANDON_COOLDOWN',
      `You abandoned a hunt recently. You can abandon another in ${humanUntil(at, until)} — or finish this one.`,
      { available_at: until });
  }
  db.prepare("UPDATE hunts SET status = 'abandoned', ended_at = ? WHERE id = ?").run(at, hunt.id);
  return getHunt(hunt.id, playerId);
});

// ── finding things ────────────────────────────────────────────────────────

/** The hunt and the slot a photo is for, or why it cannot be sent. */
export function openSlot({ playerId, huntId, slot }) {
  const hunt = db.prepare('SELECT * FROM hunts WHERE id = ?').get(Number(huntId));
  if (!hunt || hunt.player_id !== playerId) throw notFound('HUNT_NOT_FOUND', 'No hunt of yours with that id.');
  if (hunt.status === 'complete') throw new GameError('HUNT_COMPLETE', 'That hunt is already finished.');
  if (hunt.status !== 'active') throw new GameError('HUNT_NOT_ACTIVE', 'That hunt was abandoned.');
  const n = Number(slot);
  const item = Number.isInteger(n)
    ? db.prepare('SELECT * FROM hunt_items WHERE hunt_id = ? AND slot = ?').get(hunt.id, n)
    : null;
  if (!item) throw badRequest('BAD_SLOT', 'A hunt has five items, numbered 0 to 4.');
  if (item.completed_at) {
    throw new GameError('SLOT_ALREADY_DONE', `You have already found ${item.label.toLowerCase()} on this hunt.`);
  }
  return { hunt, item, target: item.target_json ? JSON.parse(item.target_json) : null };
}

const yearsIn = (text) => {
  const found = String(text ?? '').match(/(19|20)\d{2}/g);
  if (!found) return null;
  const years = found.map(Number);
  return [Math.min(...years), Math.max(...years)];
};

/**
 * Does an identified vehicle match a street target? Generous, because the camera is a
 * confirmation and not a gate: the make, the target's model somewhere in what was seen
 * (model, trim or generation — "Civic" plus trim "Type R" is a Civic Type R), and a year
 * window that overlaps when the identifier gave one at all. Years inside a generation
 * cannot be seen, which is why every window runs to a generation boundary.
 */
export function matchesTarget(identification, target) {
  if (!identification || !target) return false;
  if (makeKey(identification.make) !== makeKey(target.make)) return false;
  const seen = squash([identification.model, identification.trim, identification.generation, identification.raw?.model]
    .filter(Boolean).join(' '));
  if (!seen.includes(squash(target.model))) return false;
  const years = yearsIn(identification.year_range);
  if (years && Array.isArray(target.years)) {
    const [from, to] = target.years;
    if (years[1] < from || years[0] > to) return false;
  }
  return true;
}

const insertPhoto = (playerId, photo, at) => Number(db.prepare(`
  INSERT INTO photos (player_id, photo_type, path_original, path_display, path_thumb,
                      width, height, bytes, exif_json, caption, created_at)
  VALUES (?, 'hunt', ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
  .run(playerId, photo.path_original, photo.path_display, photo.path_thumb,
       photo.width ?? null, photo.height ?? null, photo.bytes ?? null, photo.exif_json ?? null, at)
  .lastInsertRowid);

/**
 * Record a photo against a slot, inside its own transaction. Confirmed, the slot is found;
 * not, the photo is kept so "I'm sure" can mark it without sending it again.
 */
const recordAttempt = db.transaction(({ playerId, huntId, slot, photo, verified, hoodId, at }) => {
  const { hunt, item } = openSlot({ playerId, huntId, slot });
  const photoId = insertPhoto(playerId, photo, at);
  if (verified) {
    db.prepare(`UPDATE hunt_items SET photo_id = ?, hood_id = ?, attempted_at = ?, completed_at = ?,
                       verified = 1, overridden = 0 WHERE id = ?`).run(photoId, hoodId, at, at, item.id);
  } else {
    db.prepare('UPDATE hunt_items SET photo_id = ?, hood_id = ?, attempted_at = ?, verified = 0 WHERE id = ?')
      .run(photoId, hoodId, at, item.id);
  }
  return { completion: verified ? completeIfDone(hunt.id, at) : null, label: item.label };
});

/** A park hunt photo, already checked by lib/hunt-verify.js in the route. */
export function submitParkPhoto({ playerId, huntId, slot, photo, found, at = nowIso() }) {
  const { hunt } = openSlot({ playerId, huntId, slot });
  if (hunt.kind !== 'park') throw badRequest('WRONG_HUNT_KIND', 'That is a street hunt.');
  const hoodId = db.prepare('SELECT hood_id FROM parks WHERE id = ?').get(hunt.park_id)?.hood_id ?? null;
  const verified = found === true;
  const result = recordAttempt({ playerId, huntId: hunt.id, slot, photo, verified, hoodId, at });
  return { verified, label: result.label, completion: result.completion, hunt: getHunt(hunt.id, playerId) };
}

/**
 * A street hunt photo: the car identifier has already run in the route, with this slot's
 * target named. Two independent things happen with the one photo:
 *
 *   1. the car card, through the ordinary pipeline — which may mint, mint for 0 points past
 *      the weekly cap, or refuse with ALREADY_COLLECTED;
 *   2. the hunt slot, which ticks if the car is the target, whatever (1) said.
 *
 * `raw` is the identifier's answer and `identification` its resolved form (null when it was
 * unsure). The model's own target_match counts, and so does our generous matcher.
 */
export function submitStreetPhoto({
  playerId, huntId, slot, photo, hoodId, raw = null, identification = null, identifyError = null,
  caption = null, rand = undefined, itemRand = undefined, at = nowIso(),
}) {
  const { hunt, target } = openSlot({ playerId, huntId, slot });
  if (hunt.kind !== 'street') throw badRequest('WRONG_HUNT_KIND', 'That is a park hunt.');
  if (!db.prepare('SELECT 1 FROM hoods WHERE id = ?').get(Number(hoodId))) {
    throw badRequest('HOOD_REQUIRED', 'Say which Hood the car was in.');
  }

  const verified = raw?.target_match === true || matchesTarget(identification, target);

  let car = null;
  let carError = identifyError;
  if (identification) {
    try {
      car = commitCar({ identification, playerId, hoodId: Number(hoodId), photo, caption, rand, itemRand });
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
      carError = { code: err.code, message: err.message };
    }
  }

  try {
    const result = recordAttempt({ playerId, huntId: hunt.id, slot, photo, verified, hoodId: Number(hoodId), at });
    return {
      verified, label: result.label, completion: result.completion,
      car, car_error: carError, hunt: getHunt(hunt.id, playerId),
    };
  } catch (err) {
    // The card may already have been written from these files; the route must keep them.
    if (car) err.carCommitted = true;
    throw err;
  }
}

/**
 * "I'm sure — mark it anyway." The slot is found, unverified, and raised for the group:
 * the route posts it to chat, and once the hunt completes its claim can be flagged like any
 * other. Only after a photo was actually sent for this item.
 */
export const overrideSlot = db.transaction(({ playerId, huntId, slot, at = nowIso() }) => {
  const { hunt, item } = openSlot({ playerId, huntId, slot });
  if (!item.photo_id) {
    throw new GameError('NO_ATTEMPT', 'Send a photo for this one first — then you can mark it found.');
  }
  db.prepare(`UPDATE hunt_items SET completed_at = ?, verified = 0, overridden = 1, flagged = 1 WHERE id = ?`)
    .run(at, item.id);
  return {
    label: item.label,
    completion: completeIfDone(hunt.id, at),
    hunt: getHunt(hunt.id, playerId),
  };
});

// ── completing ────────────────────────────────────────────────────────────

/**
 * If every slot is found, complete the hunt and pay it. Runs inside the transaction that
 * found the last item, so a completion cannot be paid twice.
 *
 * Points: HUNT_POINTS, clamped to what is left of the season cap, and only for a scoring
 * completion. Scoring means inside this week's HUNT_WEEKLY_SCORING_LIMIT; past it the hunt
 * completes for XP only, no points and no items. XP by kind, always. Items: HUNT_ITEMS for a
 * scoring completion, exempt from the weekly item cap.
 */
function completeIfDone(huntId, at) {
  const left = db.prepare('SELECT COUNT(*) AS n FROM hunt_items WHERE hunt_id = ? AND completed_at IS NULL')
    .get(huntId).n;
  if (left > 0) return null;

  const hunt = huntRow(huntId);
  const season = activeSeason(at);
  const week = weekKey(at);
  const hoodId = hunt.park_hood_id ?? db.prepare(`
    SELECT hood_id FROM hunt_items WHERE hunt_id = ? AND hood_id IS NOT NULL
     ORDER BY completed_at DESC LIMIT 1`).get(huntId)?.hood_id ?? null;
  const selfConfirmed = db.prepare('SELECT COUNT(*) AS n FROM hunt_items WHERE hunt_id = ? AND overridden = 1')
    .get(huntId).n;
  const title = huntTitle(hunt);

  // Between seasons there is no season to pay into: the hunt is finished, and that is all.
  if (!season || hoodId == null) {
    db.prepare("UPDATE hunts SET status = 'complete', completed_at = ?, week_key = ? WHERE id = ?")
      .run(at, week, huntId);
    return { claim_id: null, title, kind: hunt.kind, points: 0, xp: 0, scoring: false, items: [],
      self_confirmed: selfConfirmed, reason: 'no_season' };
  }

  const limit = config.HUNT_WEEKLY_SCORING_LIMIT;
  const scoring = !(limit > 0) || scoringCompletionsInWeek(hunt.player_id, week) < limit;
  const spent = huntPointsInSeason(hunt.player_id, season.id);
  const cap = config.HUNT_SEASON_POINTS_CAP;
  const points = scoring
    ? Math.max(0, Math.min(config.HUNT_POINTS, cap > 0 ? cap - spent : config.HUNT_POINTS))
    : 0;
  const xp = hunt.kind === 'street' ? config.HUNT_XP_STREET : config.HUNT_XP_PARK;

  // The claim carries a photo only where hunt photos are public: street hunts (car photos),
  // or park hunts when the admin has chosen to share them.
  const publicPhoto = hunt.kind === 'street' || config.HUNT_PARK_PHOTOS_PUBLIC;
  const photoId = publicPhoto
    ? db.prepare(`SELECT photo_id FROM hunt_items WHERE hunt_id = ? AND photo_id IS NOT NULL
                   ORDER BY completed_at DESC LIMIT 1`).get(huntId)?.photo_id ?? null
    : null;

  const claimId = Number(db.prepare(`
    INSERT INTO claims (hood_id, player_id, season_id, photo_id, claim_kind, photo_type,
                        points_awarded, xp_awarded, status, flag_count, hunt_id, week_key, created_at)
    VALUES (?, ?, ?, ?, 'hunt', 'hunt', ?, ?, 'active', 0, ?, ?, ?)`)
    .run(hoodId, hunt.player_id, season.id, photoId, points, xp, huntId, week, at).lastInsertRowid);

  db.prepare(`UPDATE hunts SET status = 'complete', completed_at = ?, season_id = ?, week_key = ?,
                     claim_id = ?, scoring = ? WHERE id = ?`)
    .run(at, season.id, week, claimId, scoring ? 1 : 0, huntId);

  const items = scoring
    ? grantHuntItems({ claimId, playerId: hunt.player_id, seasonId: season.id, count: config.HUNT_ITEMS, at })
    : [];

  return {
    claim_id: claimId, title, kind: hunt.kind, points, xp, scoring, items,
    self_confirmed: selfConfirmed,
    season_points: spent + points, season_cap: cap,
    week_limit: limit, resets_on: weekStartName(),
    reason: !scoring ? 'weekly_limit' : points < config.HUNT_POINTS ? 'season_cap' : null,
  };
}
