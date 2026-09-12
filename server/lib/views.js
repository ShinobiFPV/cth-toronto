// Read models. Everything the client renders is assembled here, so the map, the
// Hood sheet and the claim endpoint can never disagree about who holds what.
//
// Scores are always derived from the claims ledger (spec §1.6) — there is no
// denormalised running total anywhere in this codebase, and there should never be.
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import { evaluateClaim, humanUntil, article } from './game.js';
import { activeSeason } from './seasons.js';
import { hoodLabel, neighboursOf } from './hood-seed.js';
import { publicPlayer } from './auth.js';
import { parkProgress } from './parks.js';

/** Every Hood with its holder and, if a viewer is given, what that viewer can do. */
export function listHoods(viewerId = null, at = nowIso()) {
  const rows = db.prepare(`
    SELECT h.*, s.owner_id, s.active_claim_id, s.photo_type, s.last_claim_at, s.locked_until,
           p.handle AS owner_handle, p.display_name AS owner_name, p.colour AS owner_colour,
           ph.path_thumb, ph.path_display,
           c.created_at AS claimed_at, c.claim_kind, c.flag_count
      FROM hoods h
      JOIN hood_state s ON s.hood_id = h.id
 LEFT JOIN players p    ON p.id = s.owner_id
 LEFT JOIN claims  c    ON c.id = s.active_claim_id
 LEFT JOIN photos  ph   ON ph.id = c.photo_id
     ORDER BY h.id`).all();

  return rows.map((r) => shapeHood(r, viewerId, at));
}

function shapeHood(r, viewerId, at) {
  const hood = {
    id: r.id,
    name: r.name,
    label: hoodLabel(r.id, r.name),
    centroid: { lat: r.centroid_lat, lng: r.centroid_lng },
    unclaimed_value: r.unclaimed_value,
    difficulty: r.difficulty,
    escalations: r.escalations,
    // What each action on this Hood pays, so the map can price it without guessing.
    conquer_value: r.unclaimed_value,
    steal_value: r.difficulty * config.STEAL_MULTIPLIER,
    ever_conquered: !!r.ever_conquered,
    owner: r.owner_id ? {
      id: r.owner_id, handle: r.owner_handle, display_name: r.owner_name, colour: r.owner_colour,
    } : null,
    photo_type: r.photo_type,
    active_claim_id: r.active_claim_id,
    claim_kind: r.claim_kind,
    flag_count: r.flag_count ?? 0,
    claimed_at: r.claimed_at ?? null,
    last_claim_at: r.last_claim_at,
    locked_until: r.locked_until && r.locked_until > at ? r.locked_until : null,
    thumb_url: r.path_thumb ? `/media/${r.path_thumb}` : null,
    display_url: r.path_display ? `/media/${r.path_display}` : null,
    neighbours: neighboursOf(r.id),
    // Parkemon progress belongs on the Hood, not on hood.viewer: the sheet reads
    // hood.parks, and burying it in viewer is what stopped the button rendering.
    // Safe with a null viewer — the per-player counts just come back as 0.
    parks: parkProgress(r.id, viewerId, at),
  };

  if (viewerId == null) return hood;

  const ev = evaluateClaim({ hoodId: r.id, playerId: viewerId, at });
  hood.viewer = {
    is_mine: r.owner_id === viewerId,
    claim_kind: ev.claim_kind,
    can_claim: ev.ok,
    error: ev.error,
    message: ev.message,
    points: ev.points,
    required_types: ev.required_types,
    available_at: ev.available_at,
    countdown: ev.available_at ? humanUntil(at, ev.available_at) : null,
    // Drives the map's reinforce pulse (spec §7) — free points sitting there.
    reinforce_ready: ev.claim_kind === 'reinforce' && ev.ok,
    // Unclaimed, but closed to this player because they just took a Hood next door.
    adjacent_blocked: ev.error === 'ADJACENT_COOLDOWN',
    blocked_by_hood_id: ev.blocked_by_hood_id ?? null,
    action_label: actionLabel(ev),
  };
  return hood;
}

/** "Conquer (+25)", "Steal (+100)", "Reinforce (+25)", or a countdown. */
function actionLabel(ev) {
  if (ev.ok) {
    const verb = ev.claim_kind[0].toUpperCase() + ev.claim_kind.slice(1);
    return `${verb} (+${ev.points})`;
  }
  if (ev.error === 'HOOD_LOCKED') return `Locked · ${humanUntil(nowIso(), ev.available_at)}`;
  if (ev.error === 'REINFORCE_TOO_SOON') return `Reinforce in ${humanUntil(nowIso(), ev.available_at)}`;
  if (ev.error === 'ADJACENT_COOLDOWN') return `Next door · ${humanUntil(nowIso(), ev.available_at)}`;
  return 'Unavailable';
}

export function hoodDetail(hoodId, viewerId = null, at = nowIso()) {
  const r = db.prepare(`
    SELECT h.*, s.owner_id, s.active_claim_id, s.photo_type, s.last_claim_at, s.locked_until,
           p.handle AS owner_handle, p.display_name AS owner_name, p.colour AS owner_colour,
           ph.path_thumb, ph.path_display,
           c.created_at AS claimed_at, c.claim_kind, c.flag_count
      FROM hoods h
      JOIN hood_state s ON s.hood_id = h.id
 LEFT JOIN players p    ON p.id = s.owner_id
 LEFT JOIN claims  c    ON c.id = s.active_claim_id
 LEFT JOIN photos  ph   ON ph.id = c.photo_id
     WHERE h.id = ?`).get(hoodId);
  if (!r) return null;
  return { ...shapeHood(r, viewerId, at), history: hoodHistory(hoodId, viewerId) };
}

/** Every claim ever made on a Hood, newest first. This is the year-end artifact. */
export function hoodHistory(hoodId, viewerId = null) {
  const rows = db.prepare(`
    SELECT c.*, p.handle, p.display_name, p.colour,
           b.handle AS beaten_handle, b.display_name AS beaten_name,
           ph.path_thumb, ph.path_display, ph.exif_json, ph.width, ph.height,
           h.name AS hood_name,
           pk.name AS park_name, pk.value AS park_value
      FROM claims c
      JOIN players p ON p.id = c.player_id
      JOIN hoods   h ON h.id = c.hood_id
 LEFT JOIN players b ON b.id = c.beaten_player_id
 LEFT JOIN photos ph ON ph.id = c.photo_id
 LEFT JOIN parks  pk ON pk.id = c.park_id
     WHERE c.hood_id = ?
     ORDER BY c.id DESC`).all(hoodId);
  return rows.map((r) => shapeClaim(r, viewerId));
}

export function shapeClaim(r, viewerId = null) {
  const flaggedByMe = viewerId != null && !!db
    .prepare('SELECT 1 FROM flags WHERE claim_id = ? AND player_id = ?').get(r.id, viewerId);
  return {
    id: r.id,
    hood_id: r.hood_id,
    hood_name: r.hood_name,
    hood_label: hoodLabel(r.hood_id, r.hood_name),
    season_id: r.season_id,
    claim_kind: r.claim_kind,
    photo_type: r.photo_type,
    points: r.points_awarded,
    status: r.status,
    flag_count: r.flag_count,
    flagged_by_me: flaggedByMe,
    flaggable: r.status === 'active' && r.claim_kind !== 'reversal' && r.player_id !== viewerId,
    created_at: r.created_at,
    player: { id: r.player_id, handle: r.handle, display_name: r.display_name, colour: r.colour },
    // Only a steal takes a Hood off somebody. A reinforce also carries a
    // beaten_player_id — yourself — and surfacing that as "beat shinobi" on your own
    // reinforce is nonsense, so it comes back as the subject you replaced instead.
    beaten: r.claim_kind === 'steal' && r.beaten_player_id
      ? { id: r.beaten_player_id, handle: r.beaten_handle, display_name: r.beaten_name,
          photo_type: r.beaten_photo_type }
      : null,
    replaced_photo_type: r.claim_kind === 'reinforce' ? r.beaten_photo_type : null,
    thumb_url: r.path_thumb ? `/media/${r.path_thumb}` : null,
    display_url: r.path_display ? `/media/${r.path_display}` : null,
    shot_data: r.exif_json ? JSON.parse(r.exif_json) : null,
    reverts_claim_id: r.reverts_claim_id ?? null,
    park: r.park_id ? { id: r.park_id, name: r.park_name, value: r.park_value } : null,
    card_seed: r.card_seed ?? null,
    summary: claimSummary(r),
  };
}

/** The one sentence that goes in chat and on the feed card. */
export function claimSummary(r) {
  const who = r.display_name || r.handle;
  const where = hoodLabel(r.hood_id, r.hood_name);
  switch (r.claim_kind) {
    case 'conquer':
      return `${who} conquered ${where} with ${article(r.photo_type)} photo (+${r.points_awarded})`;
    case 'steal':
      return `${who} stole ${where} from ${r.beaten_name || r.beaten_handle} with ${article(r.photo_type)} photo (+${r.points_awarded})`;
    case 'reinforce':
      return `${who} reinforced ${where} with ${article(r.photo_type)} photo (+${r.points_awarded})`;
    case 'park':
      return `${who} collected ${r.park_name ?? 'a park'} in ${where} (+${r.points_awarded})`;
    case 'reversal':
      return `${who}'s claim on ${where} was reverted by flags — points cancelled`;
    default:
      return `${who} — ${where}`;
  }
}

export function feed({ before = null, limit = 30, viewerId = null } = {}) {
  const rows = before
    ? db.prepare(`${FEED_SQL} WHERE c.id < ? ORDER BY c.id DESC LIMIT ?`).all(before, limit)
    : db.prepare(`${FEED_SQL} ORDER BY c.id DESC LIMIT ?`).all(limit);
  return rows.map((r) => shapeClaim(r, viewerId));
}

const FEED_SQL = `
  SELECT c.*, p.handle, p.display_name, p.colour,
         b.handle AS beaten_handle, b.display_name AS beaten_name,
         ph.path_thumb, ph.path_display, ph.exif_json,
         h.name AS hood_name,
         pk.name AS park_name, pk.value AS park_value
    FROM claims c
    JOIN players p ON p.id = c.player_id
    JOIN hoods   h ON h.id = c.hood_id
LEFT JOIN players b ON b.id = c.beaten_player_id
LEFT JOIN photos ph ON ph.id = c.photo_id
LEFT JOIN parks  pk ON pk.id = c.park_id`;

/**
 * Standings. `seasonId` null means the Champion table — the same ledger, without the
 * season filter (spec §1.6). Reverted claims are excluded, which is exactly how a
 * successful flag cancels the points.
 */
export function leaderboard(seasonId = null) {
  const players = db.prepare('SELECT * FROM players ORDER BY id').all();
  const points = seasonId
    ? db.prepare(`
        SELECT player_id, SUM(points_awarded) AS pts, COUNT(*) AS claims
          FROM claims WHERE season_id = ? AND status != 'reverted' GROUP BY player_id`)
        .all(seasonId)
    : db.prepare(`
        SELECT player_id, SUM(points_awarded) AS pts, COUNT(*) AS claims
          FROM claims WHERE status != 'reverted' GROUP BY player_id`).all();

  const byKind = seasonId
    ? db.prepare(`
        SELECT player_id, claim_kind, COUNT(*) AS n, SUM(points_awarded) AS pts FROM claims
         WHERE season_id = ? AND status != 'reverted' GROUP BY player_id, claim_kind`)
        .all(seasonId)
    : db.prepare(`
        SELECT player_id, claim_kind, COUNT(*) AS n, SUM(points_awarded) AS pts FROM claims
         WHERE status != 'reverted' GROUP BY player_id, claim_kind`).all();

  const held = db.prepare(`
    SELECT owner_id, COUNT(*) AS n FROM hood_state WHERE owner_id IS NOT NULL GROUP BY owner_id`)
    .all();

  const pts = Object.fromEntries(points.map((r) => [r.player_id, r]));
  const hoods = Object.fromEntries(held.map((r) => [r.owner_id, r.n]));
  const kinds = {};
  const kindPoints = {};
  for (const r of byKind) {
    (kinds[r.player_id] ??= {})[r.claim_kind] = r.n;
    (kindPoints[r.player_id] ??= {})[r.claim_kind] = r.pts ?? 0;
  }

  const ordered = players
    .map((p) => ({
      player: publicPlayer(p),
      points: pts[p.id]?.pts ?? 0,
      claims: pts[p.id]?.claims ?? 0,
      hoods_held: hoods[p.id] ?? 0,
      conquers: kinds[p.id]?.conquer ?? 0,
      steals: kinds[p.id]?.steal ?? 0,
      reinforces: kinds[p.id]?.reinforce ?? 0,
      // Parkemon GO points count toward the same total, but it is worth seeing the
      // split: somebody can be top of the table without holding a single Hood.
      parks: kinds[p.id]?.park ?? 0,
      park_points: kindPoints[p.id]?.park ?? 0,
      territory_points: (kindPoints[p.id]?.conquer ?? 0)
        + (kindPoints[p.id]?.steal ?? 0)
        + (kindPoints[p.id]?.reinforce ?? 0),
    }))
    .sort((a, b) => b.points - a.points || b.hoods_held - a.hoods_held
      || a.player.handle.localeCompare(b.player.handle));

  // Shared rank on a tie: 1, 2, 2, 4.
  let lastPoints = null;
  let lastRank = 0;
  return ordered.map((row, i) => {
    const rank = row.points === lastPoints ? lastRank : i + 1;
    lastPoints = row.points;
    lastRank = rank;
    return { ...row, rank };
  });
}

/** Small summary the client keeps in its header: season, your score, Hoods you hold. */
export function playerSummary(playerId, at = nowIso()) {
  const season = activeSeason(at);
  const seasonPts = season
    ? db.prepare(`
        SELECT COALESCE(SUM(points_awarded), 0) AS pts FROM claims
         WHERE player_id = ? AND season_id = ? AND status != 'reverted'`)
        .get(playerId, season.id).pts
    : 0;
  const totalPts = db.prepare(`
    SELECT COALESCE(SUM(points_awarded), 0) AS pts FROM claims
     WHERE player_id = ? AND status != 'reverted'`).get(playerId).pts;
  const holdings = db.prepare(`
    SELECT COUNT(*) AS n FROM hood_state WHERE owner_id = ?`).get(playerId).n;
  const readyRow = db.prepare(`
    SELECT COUNT(*) AS n FROM hood_state
     WHERE owner_id = ? AND (last_claim_at IS NULL OR last_claim_at <= ?)`)
    .get(playerId, new Date(Date.parse(at) - config.REINFORCE_GATE_HOURS * 3600_000).toISOString()).n;

  return {
    season,
    season_points: seasonPts,
    total_points: totalPts,
    hoods_held: holdings,
    reinforce_ready: readyRow,
  };
}
