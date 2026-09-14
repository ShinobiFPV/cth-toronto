// The Garage: photograph cars on the street, and each one prints a Not Wheels package.
//
// Architecturally boring on purpose. A car pays a flat CAR_POINTS, capped at
// CAR_WEEKLY_CAP per player per calendar week, and that is fully knowable at claim time
// — so points_awarded is computed once inside commitCar() and frozen there like every
// other claim in the game. No second scoring path, nothing derived on the leaderboard,
// nothing scheduled. SUM(points_awarded) is still the whole story.
//
// Past the cap you keep collecting: the package mints, the edition rolls, the XP lands,
// and the claim is worth 0. That is a success, never an error — a WEEKLY_CAP_REACHED
// code would turn a good collection into something the UI has to apologise for.
//
// Cars are claims: claim_kind = 'car', vehicle_id set, and they never touch hood_state.
// The Hood is recorded because it gives the feed its flavour, not because snapping a car
// takes any ground.
//
// Like parks, packages and Cases are public. Nobody loses anything when you photograph a
// car, and comparing pulls is most of the fun.
import crypto from 'node:crypto';
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import { GameError, notFound } from './errors.js';
import { activeSeason } from './seasons.js';
import { hoodLabel } from './hood-seed.js';
import { xpFor } from './xp.js';
import { cleanCaption } from './captions.js';
import { rollEdition, editionLabel, editionCounts } from './editions.js';
import { weekKey, weekResetsAt, weekStartName } from './week.js';
import { withArticle } from './vehicles.js';
import { activeClover, grantItems } from './items.js';

/**
 * The package's art seed, from (player, vehicle, season) — the same collection always
 * renders the same package. Never the edition: that is fresh randomness, because this
 * salt is public and a seed-derived edition could be shopped for.
 */
export const packSeed = (playerId, vehicleId, seasonId) =>
  crypto.createHash('sha256')
    .update(`cth-notwheels:${playerId}:${vehicleId}:${seasonId}`)
    .digest('hex')
    .slice(0, 16);

const vehicleName = (v) => `${v.make} ${v.model}`;

// ── the weekly cap ─────────────────────────────────────────────────────────

/** Points this player's car claims have scored in a week. Reverted claims give theirs back. */
export const pointsInWeek = (playerId, week) => db.prepare(`
  SELECT COALESCE(SUM(points_awarded), 0) AS pts FROM claims
   WHERE player_id = ? AND week_key = ? AND claim_kind = 'car' AND status != 'reverted'`)
  .get(playerId, week).pts;

/**
 * Where a player stands this week. The capture sheet shows this before the shutter, so
 * a player who snaps three cars past the cap already knows why no points moved.
 */
export function capacityFor(playerId, at = nowIso()) {
  const week = weekKey(at);
  const spent = pointsInWeek(playerId, week);
  const remaining = Math.max(0, config.CAR_WEEKLY_CAP - spent);
  // min(), not an all-or-nothing test: at 5 and 100 it never matters, but the first time
  // somebody sets the cap to 90 or the value to 7, `spent >= cap` either overshoots the
  // cap or silently drops a whole award.
  const next = Math.max(0, Math.min(config.CAR_POINTS, remaining));
  return {
    week_key: week,
    spent,
    cap: config.CAR_WEEKLY_CAP,
    remaining,
    car_points: config.CAR_POINTS,
    next_award: next,
    xp_only: next === 0,
    resets_at: weekResetsAt(at),
    resets_on: weekStartName(),
  };
}

// ── evaluate / commit ──────────────────────────────────────────────────────

const findVehicle = (key) => db.prepare('SELECT * FROM vehicles WHERE vehicle_key = ?').get(key) ?? null;

/**
 * Can this player collect this car, and for how many points — or why not?
 *
 * Pure: no writes and no network. It takes an identification that has already been
 * resolved (lib/vehicles.js), so the slow, fallible part is over before the rules run.
 */
export function evaluateCar({ identification, playerId, at = nowIso() }) {
  const season = activeSeason(at);
  const vehicle = findVehicle(identification.vehicle_key);
  const capacity = capacityFor(playerId, at);
  const name = `${identification.make} ${identification.model}`;

  const base = {
    vehicle_key: identification.vehicle_key,
    vehicle_id: vehicle?.id ?? null,
    name,
    week_key: capacity.week_key,
    spent: capacity.spent,
    cap: capacity.cap,
    points: 0,
    season: season ? { id: season.id, name: season.name } : null,
  };

  if (!season) {
    return { ...base, ok: false, error: 'NO_ACTIVE_SEASON',
      message: 'The game is between seasons — no collecting right now.' };
  }

  if (vehicle) {
    const existing = db.prepare(`
      SELECT id FROM claims
       WHERE player_id = ? AND season_id = ? AND vehicle_id = ?
         AND claim_kind = 'car' AND status != 'reverted'`)
      .get(playerId, season.id, vehicle.id);

    if (existing) {
      // The trickle for a repeat sighting, if it is switched on: once per vehicle per
      // week, or snapping the neighbour's car every morning becomes an XP tap.
      const trickled = config.CAR_REPEAT_XP > 0 && !!db.prepare(`
        SELECT 1 FROM claims
         WHERE player_id = ? AND vehicle_id = ? AND claim_kind = 'sighting'
           AND week_key = ? AND status != 'reverted' LIMIT 1`)
        .get(playerId, vehicle.id, capacity.week_key);

      return { ...base, ok: false, error: 'ALREADY_COLLECTED', claim_id: existing.id,
        repeat_xp: config.CAR_REPEAT_XP > 0 && !trickled ? config.CAR_REPEAT_XP : 0,
        message: `You already have ${withArticle(vehicleName(vehicle))} this season. `
          + 'One card per car per season — the hard part is finding one you have not got.' };
    }
  }

  return { ...base, ok: true, error: null, message: null, season_id: season.id,
    points: capacity.next_award, xp_only: capacity.next_award === 0 };
}

const insertPhoto = (playerId, photo, caption, at) => db.prepare(`
  INSERT INTO photos (player_id, photo_type, path_original, path_display, path_thumb,
                      width, height, bytes, exif_json, caption, created_at)
  VALUES (@player_id, 'car', @path_original, @path_display, @path_thumb,
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
  }).lastInsertRowid;

// What the identifier said, minus the plate boxes: those did their job on the pixels and
// are not something a flagger needs to read.
const identifyJson = (identification) => {
  const { plates, ...said } = identification.raw ?? {};
  return JSON.stringify(said);
};

/**
 * Collect a car. One transaction, which re-runs evaluateCar() inside itself — two
 * collections racing at 95 points spent cannot both be awarded 5, and two pulls racing at
 * the item cap cannot both be granted the last slot. The preflight is a courtesy; this is
 * the ruling.
 */
export const commitCar = db.transaction((
  { identification, playerId, hoodId, photo, caption = null, rand = undefined, itemRand = undefined },
) => {
  const at = nowIso();
  const hood = db.prepare('SELECT id, name FROM hoods WHERE id = ?').get(hoodId);
  if (!hood) throw notFound('HOOD_NOT_FOUND', `There is no Hood ${hoodId}.`);

  const evaluation = evaluateCar({ identification, playerId, at });
  if (!evaluation.ok) {
    if (evaluation.error === 'ALREADY_COLLECTED' && evaluation.repeat_xp > 0) {
      return commitSighting({ identification, playerId, hood, photo, caption, at, evaluation });
    }
    throw new GameError(evaluation.error, evaluation.message, { claim_id: evaluation.claim_id });
  }

  let vehicle = findVehicle(identification.vehicle_key);
  const firstSighting = !vehicle;
  if (!vehicle) {
    db.prepare(`INSERT INTO vehicles (vehicle_key, make, model, body_style, created_at)
                VALUES (?, ?, ?, ?, ?)`)
      .run(identification.vehicle_key, identification.make, identification.model,
           identification.body_style, at);
    vehicle = findVehicle(identification.vehicle_key);
  }

  const seasonId = evaluation.season_id;
  const clover = !!activeClover(playerId, at);

  // The same roll as a park card — same table, same rarest-first order, Clover and all.
  // Unaffected by the points cap: a hologram on your 40th car of the week is still a
  // hologram, which is what makes collecting past the cap worth doing at all. Nothing is
  // ever less than Steel.
  const edition = rollEdition({ clover, ...(rand ? { rand } : {}) });

  const earned = xpFor({ kind: 'car', playerId, edition });
  const photoId = insertPhoto(playerId, photo, caption, at);

  const row = db.prepare(`
    INSERT INTO claims (hood_id, player_id, season_id, photo_id, claim_kind, photo_type,
                        points_awarded, xp_awarded, status, flag_count, card_seed, edition,
                        vehicle_id, vehicle_year, vehicle_trim, vehicle_generation,
                        identify_json, identify_confidence, week_key, created_at)
    VALUES (?, ?, ?, ?, 'car', 'car', ?, ?, 'active', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(hood.id, playerId, seasonId, photoId, evaluation.points, earned.xp,
         packSeed(playerId, vehicle.id, seasonId), edition, vehicle.id,
         identification.year_range, identification.trim, identification.generation,
         identifyJson(identification), identification.confidence, evaluation.week_key, at);
  const claimId = Number(row.lastInsertRowid);

  if (firstSighting) {
    db.prepare('UPDATE vehicles SET first_seen_claim_id = ? WHERE id = ?').run(claimId, vehicle.id);
  }

  // No points, no items: a car past the weekly cap grants nothing, whatever it rolled.
  const items = grantItems({
    claimId, playerId, seasonId, edition, points: evaluation.points, at, clover,
    ...(itemRand ? { rand: itemRand } : {}),
  });

  return {
    repeat: false,
    package: getPackageByClaim(claimId),
    vehicle,
    hood,
    season_id: seasonId,
    points: evaluation.points,
    xp: earned,
    items,
    first_sighting: firstSighting,
    capacity: capacityFor(playerId, at),
  };
});

/**
 * A car you already have, when CAR_REPEAT_XP is on: a small XP trickle and nothing
 * else. No package — duplicates of a package come from trading, never from snapping the
 * same car twice — and no points.
 */
function commitSighting({ identification, playerId, hood, photo, caption, at, evaluation }) {
  const vehicle = findVehicle(identification.vehicle_key);
  const photoId = insertPhoto(playerId, photo, caption, at);
  const row = db.prepare(`
    INSERT INTO claims (hood_id, player_id, season_id, photo_id, claim_kind, photo_type,
                        points_awarded, xp_awarded, status, flag_count,
                        vehicle_id, vehicle_year, vehicle_trim, vehicle_generation,
                        identify_json, identify_confidence, week_key, created_at)
    VALUES (?, ?, ?, ?, 'sighting', 'car', 0, ?, 'active', 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(hood.id, playerId, evaluation.season.id, photoId, evaluation.repeat_xp, vehicle.id,
         identification.year_range, identification.trim, identification.generation,
         identifyJson(identification), identification.confidence, evaluation.week_key, at);

  return {
    repeat: true,
    claim_id: Number(row.lastInsertRowid),
    package: getPackageByClaim(evaluation.claim_id),
    vehicle,
    hood,
    season_id: evaluation.season.id,
    points: 0,
    xp: { xp: evaluation.repeat_xp, edition: null, edition_xp: 0 },
    first_sighting: false,
    capacity: capacityFor(playerId, at),
  };
}

// ── reading packages ───────────────────────────────────────────────────────

// Holder is COALESCE(the holdings override, whoever snapped it), as for park cards.
const PACK_SELECT = `
  SELECT c.id AS claim_id, c.player_id, c.season_id, c.points_awarded, c.xp_awarded,
         c.card_seed, c.created_at, c.status, c.flag_count, c.edition, c.hood_id, c.week_key,
         c.vehicle_year, c.vehicle_trim, c.vehicle_generation, c.identify_json,
         c.identify_confidence,
         v.id AS vehicle_id, v.vehicle_key, v.make, v.model, v.body_style,
         h.name AS hood_name,
         s.name AS season_name,
         pl.handle, pl.display_name, pl.colour,
         ph.path_thumb, ph.path_display, ph.caption,
         COALESCE(hold.holder_id, c.player_id) AS holder_id,
         hold.acquired_at,
         hd.handle AS holder_handle, hd.display_name AS holder_name, hd.colour AS holder_colour
    FROM claims c
    JOIN vehicles v  ON v.id = c.vehicle_id
    JOIN players  pl ON pl.id = c.player_id
    LEFT JOIN hoods   h  ON h.id = c.hood_id
    LEFT JOIN seasons s  ON s.id = c.season_id
    LEFT JOIN photos  ph ON ph.id = c.photo_id
    LEFT JOIN card_holdings hold ON hold.claim_id = c.id
    LEFT JOIN players hd ON hd.id = hold.holder_id`;

const parse = (json) => { try { return json ? JSON.parse(json) : null; } catch { return null; } };

export function shapePackage(r) {
  const said = parse(r.identify_json);
  const person = (id, handle, name, colour) => ({ id, handle, display_name: name, colour });
  return {
    kind: 'car',
    claim_id: r.claim_id,
    vehicle: {
      id: r.vehicle_id,
      key: r.vehicle_key,
      make: r.make,
      model: r.model,
      name: `${r.make} ${r.model}`,
      body_style: r.body_style,
      // Sighting detail: this car, not the package's model.
      year: r.vehicle_year,
      trim: r.vehicle_trim,
      generation: r.vehicle_generation,
    },
    hood: { id: r.hood_id, label: r.hood_id ? hoodLabel(r.hood_id, r.hood_name) : null },
    player: person(r.player_id, r.handle, r.display_name, r.colour),
    holder: r.holder_id === r.player_id
      ? person(r.player_id, r.handle, r.display_name, r.colour)
      : person(r.holder_id, r.holder_handle, r.holder_name, r.holder_colour),
    traded: r.holder_id !== r.player_id,
    acquired_at: r.acquired_at ?? null,
    season: { id: r.season_id, name: r.season_name },
    points: r.points_awarded,
    xp: r.xp_awarded,
    week_key: r.week_key,
    edition: r.edition ?? 'steel',
    edition_label: editionLabel(r.edition ?? 'steel'),
    card_seed: r.card_seed,
    status: r.status,
    flag_count: r.flag_count,
    collected_at: r.created_at,
    thumb_url: r.path_thumb ? `/media/${r.path_thumb}` : null,
    display_url: r.path_display ? `/media/${r.path_display}` : null,
    caption: r.caption ?? null,
    confidence: r.identify_confidence,
    // The identifier thought this was a screen, a magazine or a diecast. Marked for
    // flaggers; never a rejection.
    suspect: said?.in_situ === false,
    identified_as: said,
  };
}

export const getPackageByClaim = (claimId) => {
  const row = db.prepare(`${PACK_SELECT} WHERE c.id = ? AND c.claim_kind = 'car'`).get(claimId);
  return row ? shapePackage(row) : null;
};

/** A player's Case: the packages they hold, newest first, optionally one season. */
export function packagesOf(playerId, { seasonId = null, limit = 500 } = {}) {
  const where = `COALESCE(hold.holder_id, c.player_id) = ? AND c.claim_kind = 'car'
                 AND c.status != 'reverted'`;
  const rows = seasonId
    ? db.prepare(`${PACK_SELECT} WHERE ${where} AND c.season_id = ? ORDER BY c.id DESC LIMIT ?`)
      .all(playerId, seasonId, limit)
    : db.prepare(`${PACK_SELECT} WHERE ${where} ORDER BY c.id DESC LIMIT ?`).all(playerId, limit);
  return rows.map(shapePackage);
}

/**
 * The Case's totals. Its own counters rather than a share of the binder's: cars must not
 * inflate the parks number, and "collected" and "held" stay separate questions for the
 * same reason they are for park cards.
 */
export function garageSummary(playerId, at = nowIso()) {
  const season = activeSeason(at);
  const seasonRow = season ? db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(points_awarded), 0) AS pts FROM claims
     WHERE player_id = ? AND season_id = ? AND claim_kind = 'car' AND status != 'reverted'`)
    .get(playerId, season.id) : { n: 0, pts: 0 };

  const allTime = db.prepare(`
    SELECT COUNT(DISTINCT vehicle_id) AS vehicles FROM claims
     WHERE player_id = ? AND claim_kind = 'car' AND status != 'reverted'`).get(playerId);

  const held = db.prepare(`
    SELECT COUNT(*) AS n FROM claims c
      LEFT JOIN card_holdings hold ON hold.claim_id = c.id
     WHERE COALESCE(hold.holder_id, c.player_id) = ?
       AND c.claim_kind = 'car' AND c.status != 'reverted'`).get(playerId).n;

  const traded = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM card_holdings h JOIN claims c ON c.id = h.claim_id
        WHERE h.holder_id = ? AND c.player_id != ? AND c.claim_kind = 'car'
          AND c.status != 'reverted') AS received,
      (SELECT COUNT(*) FROM card_holdings h JOIN claims c ON c.id = h.claim_id
        WHERE c.player_id = ? AND h.holder_id != ? AND c.claim_kind = 'car'
          AND c.status != 'reverted') AS given`)
    .get(playerId, playerId, playerId, playerId);

  return {
    season_collected: seasonRow.n,
    season_points: seasonRow.pts,
    distinct_vehicles_all_time: allTime.vehicles,
    catalogue_size: db.prepare('SELECT COUNT(*) AS n FROM vehicles').get().n,
    packages_held: held,
    packages_received: traded.received,
    packages_given_away: traded.given,
    by_edition: editionCounts(playerId, { seasonId: season?.id ?? null, kind: 'car' }),
    capacity: capacityFor(playerId, at),
    season,
  };
}

/** Every vehicle anybody has ever pulled, and who holds a package of it now. */
export function catalogue() {
  const vehicles = db.prepare(`
    SELECT v.*, fp.display_name AS first_by
      FROM vehicles v
      LEFT JOIN claims  fc ON fc.id = v.first_seen_claim_id
      LEFT JOIN players fp ON fp.id = fc.player_id
     ORDER BY v.make COLLATE NOCASE, v.model COLLATE NOCASE`).all();

  const packages = db.prepare(`
    SELECT c.id AS claim_id, c.vehicle_id, c.edition, c.season_id,
           p.id AS holder_id, p.handle, p.display_name, p.colour
      FROM claims c
      LEFT JOIN card_holdings hold ON hold.claim_id = c.id
      JOIN players p ON p.id = COALESCE(hold.holder_id, c.player_id)
     WHERE c.claim_kind = 'car' AND c.status != 'reverted'
     ORDER BY c.id`).all();

  const byVehicle = new Map();
  for (const p of packages) {
    if (!byVehicle.has(p.vehicle_id)) byVehicle.set(p.vehicle_id, []);
    byVehicle.get(p.vehicle_id).push({
      claim_id: p.claim_id,
      edition: p.edition ?? 'steel',
      season_id: p.season_id,
      holder: { id: p.holder_id, handle: p.handle, display_name: p.display_name, colour: p.colour },
    });
  }

  return {
    total: vehicles.length,
    vehicles: vehicles.map((v) => ({
      id: v.id,
      key: v.vehicle_key,
      make: v.make,
      model: v.model,
      name: `${v.make} ${v.model}`,
      body_style: v.body_style,
      first_seen_at: v.created_at,
      first_seen_by: v.first_by ?? null,
      packages: byVehicle.get(v.id) ?? [],
    })),
  };
}

/** Every sighting of one vehicle, reverted ones included — this is the dispute record. */
export function vehicleHistory(vehicleId) {
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(vehicleId);
  if (!vehicle) return null;
  const rows = db.prepare(`
    SELECT c.id, c.claim_kind, c.status, c.points_awarded, c.xp_awarded, c.edition,
           c.vehicle_year, c.vehicle_trim, c.created_at, c.hood_id, c.flag_count,
           h.name AS hood_name, p.id AS player_id, p.handle, p.display_name, p.colour,
           ph.path_thumb, ph.caption
      FROM claims c
      JOIN players p ON p.id = c.player_id
      LEFT JOIN hoods h ON h.id = c.hood_id
      LEFT JOIN photos ph ON ph.id = c.photo_id
     WHERE c.vehicle_id = ?
     ORDER BY c.id DESC`).all(vehicleId);

  return {
    vehicle: { id: vehicle.id, key: vehicle.vehicle_key, make: vehicle.make, model: vehicle.model,
      name: vehicleName(vehicle), body_style: vehicle.body_style, first_seen_at: vehicle.created_at },
    sightings: rows.map((r) => ({
      claim_id: r.id,
      kind: r.claim_kind,
      status: r.status,
      points: r.points_awarded,
      xp: r.xp_awarded,
      edition: r.claim_kind === 'car' ? (r.edition ?? 'steel') : null,
      year: r.vehicle_year,
      trim: r.vehicle_trim,
      hood_label: r.hood_id ? hoodLabel(r.hood_id, r.hood_name) : null,
      flag_count: r.flag_count,
      player: { id: r.player_id, handle: r.handle, display_name: r.display_name, colour: r.colour },
      thumb_url: r.path_thumb ? `/media/${r.path_thumb}` : null,
      caption: r.caption ?? null,
      created_at: r.created_at,
    })),
  };
}
