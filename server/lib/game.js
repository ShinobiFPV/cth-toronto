// The claim state machine — conquer / steal / reinforce, cooldowns, counter rule.
// Spec §9 calls this "the core of the app; everything else is presentation", and that
// is meant literally: nothing else in the codebase decides who owns a Hood.
//
// Two entry points:
//   evaluateClaim()  — pure, no writes. Answers "could this player claim this Hood,
//                      with what type, for how many points, and if not, why not?"
//                      Both POST /claim and GET /hoods run it, so the map sheet can
//                      say "needs an animal photo" before the file picker ever opens.
//   commitClaim()    — one transaction: photo row, ledger row, hood_state.
import { db, nowIso, isoPlusHours } from '../db.js';
import { config, BEATEN_BY, PHOTO_TYPES, beats } from '../config.js';
import { GameError, badRequest, notFound } from './errors.js';
import { activeSeason } from './seasons.js';
import { hoodLabel } from './hood-seed.js';
import { xpFor } from './xp.js';
import { cleanCaption } from './captions.js';
import { humanUntil } from './time.js';
import {
  armedFortifyOn, fortifyCooldown, tuneupPending, heldGrant, spendGrant, itemLabel,
} from './items.js';

export { humanUntil };

/**
 * Items spent on the claim they open, and the one gate each lets you through. Everything
 * else about the claim is still checked — a Crowbar opens a lock, not a counter rule.
 */
export const CLAIM_ITEMS = {
  crowbar: { lock: true },
  sprint: { adjacency: true },
};

/**
 * What `playerId` can do at `hoodId` right now.
 *
 * `declaredType` is optional: omit it to ask "what are my options?", pass it to ask
 * "will this exact photo be accepted?". The returned shape is identical either way,
 * so the map sheet and the upload handler agree by construction.
 *
 * `bypass` is what an item held for this claim lets through: `{ lock }` for a Crowbar,
 * `{ adjacency }` for a Sprint. It never skips anything else.
 */
export function evaluateClaim({ hoodId, playerId, declaredType = null, at = nowIso(), bypass = {} }) {
  const hood = db.prepare('SELECT * FROM hoods WHERE id = ?').get(hoodId);
  if (!hood) throw notFound('HOOD_NOT_FOUND', `There is no Hood ${hoodId}.`);
  if (declaredType !== null && !PHOTO_TYPES.includes(declaredType)) {
    throw badRequest('BAD_TYPE', `photo_type must be one of ${PHOTO_TYPES.join(', ')}.`);
  }

  const state = db.prepare('SELECT * FROM hood_state WHERE hood_id = ?').get(hoodId)
    ?? { hood_id: hoodId, owner_id: null, photo_type: null, last_claim_at: null, locked_until: null };

  const label = hoodLabel(hood.id, hood.name);
  const held = state.owner_id != null;
  const mine = held && state.owner_id === playerId;
  const kind = !held ? 'conquer' : mine ? 'reinforce' : 'steal';

  // Which photo types would be accepted, ignoring time gates. For a held Hood there
  // is exactly one: the type that beats what is currently planted there.
  const requiredTypes = kind === 'conquer' ? [...PHOTO_TYPES] : [BEATEN_BY[state.photo_type]];
  // What this claim is worth. A Hood's difficulty score (5-50) is the basis for both
  // taking actions: conquering pays it (plus any seasonal escalation banked into
  // unclaimed_value), stealing pays a multiple of it. Reinforcing is flat forever —
  // it is a maintenance action, not a conquest, and scaling it would turn holding the
  // hard Hoods into a passive income stream.
  const points = kind === 'conquer' ? hood.unclaimed_value
    : kind === 'steal' ? hood.difficulty * config.STEAL_MULTIPLIER
    : config.REINFORCE_POINTS;

  const base = {
    hood_id: hood.id,
    hood_name: hood.name,
    hood_label: label,
    claim_kind: kind,
    points,
    difficulty: hood.difficulty,
    required_types: requiredTypes,
    holder_photo_type: state.photo_type,
    owner_id: state.owner_id,
    available_at: null,
  };

  const deny = (code, message, extra = {}) => ({ ...base, ok: false, error: code, message, ...extra });

  // ── Validation order is the spec §6 table, top to bottom ────────────────
  // Time gates first: they are knowable before the photo is even taken, and a player
  // who simply has to wait should not be told their photo type is wrong instead. Among
  // the gates the order is fixed so a player always gets the one clear reason: the
  // post-handover lock, then a Fortify's cooldown, then adjacency, then the reinforce gate.
  // A Fortify itself fires last of all, in commitClaim, only once everything here passed.

  if (kind === 'steal' && state.locked_until && state.locked_until > at && !bypass.lock) {
    return deny('HOOD_LOCKED',
      `${label} just changed hands. Stealing is locked for another ${humanUntil(at, state.locked_until)}.`,
      { available_at: state.locked_until, bypassable_with: 'crowbar' });
  }

  // You walked into a Fortify here recently. This attacker, this Hood — nobody else's
  // steals and none of your other ones. The copy reads like being caught, because the
  // error is the only way an attacker ever learns a Fortify was there.
  if (kind === 'steal') {
    const caught = fortifyCooldown(playerId, hoodId, at);
    if (caught) {
      return deny('FORTIFY_COOLDOWN', fortifyMessage(label, at, caught.until),
        { available_at: caught.until });
    }
  }

  // The adjacent-conquer cooldown (spec §1.3). Conquering unclaimed ground closes that
  // Hood's neighbours to you for ADJACENT_CONQUER_COOLDOWN_HOURS, so one drone flight
  // cannot sweep up a whole contiguous block. Per-player: anybody else may still
  // conquer the neighbour, and your own steals and reinforces are unaffected.
  if (kind === 'conquer' && config.ADJACENT_CONQUER_COOLDOWN_HOURS > 0 && !bypass.adjacency) {
    const blocker = recentAdjacentConquer(hoodId, playerId, at);
    if (blocker) {
      const openAt = isoPlusHours(blocker.created_at, config.ADJACENT_CONQUER_COOLDOWN_HOURS);
      return deny('ADJACENT_COOLDOWN',
        `You conquered ${hoodLabel(blocker.hood_id, blocker.hood_name)} ${humanUntil(blocker.created_at, at)} ago, `
        + `and it borders this one. ${label} opens up to you in ${humanUntil(at, openAt)}.`,
        { available_at: openAt, blocked_by_hood_id: blocker.hood_id, bypassable_with: 'sprint' });
    }
  }

  if (kind === 'reinforce') {
    const eligibleAt = state.last_claim_at
      ? isoPlusHours(state.last_claim_at, config.REINFORCE_GATE_HOURS)
      : at;
    // A Tune-Up spent against this exact last_claim_at opens the gate early.
    if (eligibleAt > at && !tuneupPending(playerId, hoodId, state.last_claim_at)) {
      return deny('REINFORCE_TOO_SOON',
        `You can reinforce ${label} in ${humanUntil(at, eligibleAt)}.`,
        { available_at: eligibleAt, bypassable_with: 'tuneup' });
    }
    if (config.REINFORCE_SEASON_CAP > 0) {
      const season = activeSeason(at);
      if (season && reinforcePointsThisSeason(playerId, season.id) >= config.REINFORCE_SEASON_CAP) {
        return deny('REINFORCE_CAP_REACHED',
          `You have hit this season's reinforce cap (${config.REINFORCE_SEASON_CAP} points).`);
      }
    }
  }

  // Counter rule. SAME_TYPE is checked ahead of WEAK_TYPE because it is the more
  // specific diagnosis of the same failure — "you need something else" reads worse
  // than "that Hood already holds an animal photo".
  if (declaredType && kind !== 'conquer') {
    if (declaredType === state.photo_type) {
      return deny('SAME_TYPE',
        `${label} already holds ${article(state.photo_type)} photo. The same subject never takes a Hood.`);
    }
    if (!beats(declaredType, state.photo_type)) {
      return deny('WEAK_TYPE',
        `${cap(article(declaredType))} photo does not beat ${article(state.photo_type)} photo. You need ${article(requiredTypes[0])} photo.`);
    }
  }

  return { ...base, ok: true, error: null, message: null };
}

/**
 * What an attacker is told about a Fortify. It is the only reveal there is, so it should
 * read like getting caught rather than like a form that failed validation.
 */
export function fortifyMessage(label, at, until, { justNow = false } = {}) {
  return justNow
    ? `${label} was fortified. Your steal bounced straight off it — the photo is spent, and `
      + `${label} is shut to you for ${humanUntil(at, until)}.`
    : `You walked into a Fortify on ${label}. It is shut to you for another ${humanUntil(at, until)}.`;
}

/**
 * The player's most recent surviving conquer on a Hood bordering `hoodId`, if it falls
 * inside the cooldown window. Reverted conquers do not count — a claim the group threw
 * out should not go on blocking you.
 */
function recentAdjacentConquer(hoodId, playerId, at) {
  const since = new Date(Date.parse(at) - config.ADJACENT_CONQUER_COOLDOWN_HOURS * 3600_000)
    .toISOString();
  return db.prepare(`
    SELECT c.hood_id, c.created_at, h.name AS hood_name
      FROM claims c
      JOIN hood_neighbours n ON n.neighbour_id = c.hood_id
      JOIN hoods h           ON h.id = c.hood_id
     WHERE n.hood_id = ?
       AND c.player_id = ?
       AND c.claim_kind = 'conquer'
       AND c.status != 'reverted'
       AND c.created_at > ?
     ORDER BY c.created_at DESC
     LIMIT 1`).get(hoodId, playerId, since) ?? null;
}

function reinforcePointsThisSeason(playerId, seasonId) {
  return db.prepare(`
    SELECT COALESCE(SUM(points_awarded), 0) AS pts FROM claims
    WHERE player_id = ? AND season_id = ? AND claim_kind = 'reinforce' AND status != 'reverted'`)
    .get(playerId, seasonId).pts;
}

/**
 * Land a claim. The caller has already written the photo derivatives to disk and
 * touched nothing in the database — this owns the entire write, in one transaction.
 *
 * It re-runs evaluateClaim() inside that transaction on purpose: the preflight the
 * client ran minutes ago, while the player walked back to their car, may no longer
 * hold. The preflight is a courtesy; this is the ruling.
 */
export const commitClaim = db.transaction(({
  hoodId, playerId, declaredType, photo, caption = null, useGrantId = null,
}) => {
  const at = nowIso();
  const season = activeSeason(at);
  if (!season) {
    throw new GameError('NO_ACTIVE_SEASON',
      'The game is between seasons — no claims can be made right now.');
  }

  // A Crowbar or Sprint brought along for this claim. Checked now, spent only once the
  // claim has landed — so a claim that fails validation spends nothing.
  const item = useGrantId != null ? heldGrant(playerId, useGrantId, at) : null;
  if (item && !CLAIM_ITEMS[item.item_type]) {
    throw new GameError('ITEM_WRONG_TARGET',
      `A ${itemLabel(item.item_type)} is not spent on a claim.`);
  }
  const bypass = item ? CLAIM_ITEMS[item.item_type] : {};

  const evaluation = evaluateClaim({ hoodId, playerId, declaredType, at, bypass });
  if (!evaluation.ok) {
    throw new GameError(evaluation.error, evaluation.message, {
      available_at: evaluation.available_at,
      required_types: evaluation.required_types,
      bypassable_with: evaluation.bypassable_with ?? null,
    });
  }

  // Did the item actually open anything? With the bypass the claim passes, so if it
  // fails without one, the bypassed gate was the reason. A lock that ran out while you
  // were walking there costs you nothing; you keep the Crowbar.
  const needed = !!item && !evaluateClaim({ hoodId, playerId, declaredType, at }).ok;

  const hood = db.prepare('SELECT * FROM hoods WHERE id = ?').get(hoodId);
  const prev = db.prepare('SELECT * FROM hood_state WHERE hood_id = ?').get(hoodId);
  const kind = evaluation.claim_kind;

  // Worked out before the row is written, so the discovery check sees the ledger as it
  // was a moment ago and a first-ever claim on this Hood still counts as one.
  const earned = xpFor({ kind, playerId, hoodId });

  const photoRow = db.prepare(`
    INSERT INTO photos (player_id, photo_type, path_original, path_display, path_thumb,
                        width, height, bytes, exif_json, caption, created_at)
    VALUES (@player_id, @photo_type, @path_original, @path_display, @path_thumb,
            @width, @height, @bytes, @exif_json, @caption, @created_at)`)
    .run({
      player_id: playerId,
      photo_type: declaredType,
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

  // ── Fortify ─────────────────────────────────────────────────────────────
  // Last of all, once the steal has passed every other check. It is not an error: it is
  // something that happened, so it must commit — throwing here would roll back the very
  // use row that records it. The Fortify is spent, the attacker's photo is kept (and
  // earns nothing), hood_state is not touched, and no claim row is written: the ledger is
  // for claims that happened. The cooldown it leaves is derived from this use row.
  if (kind === 'steal') {
    const armed = armedFortifyOn(hoodId, at);
    if (armed) {
      const useId = spendGrant({
        grant: { id: armed.grant_id, item_type: 'fortify' },
        playerId: armed.player_id,
        targetHoodId: hoodId,
        targetPlayerId: playerId,
        context: { photo_id: Number(photoRow.lastInsertRowid), declared_type: declaredType, armed_at: armed.armed_at },
        at,
      });
      db.prepare('DELETE FROM item_armed WHERE hood_id = ?').run(hoodId);
      const until = isoPlusHours(at, config.FORTIFY_COOLDOWN_HOURS);
      return {
        blocked: true,
        claim: null,
        fortify: { use_id: useId, defender_id: armed.player_id, hood_id: hoodId, available_at: until },
        message: fortifyMessage(hoodLabel(hood.id, hood.name), at, until, { justNow: true }),
        evaluation, season, hood, prev, xp: null, item_used: null,
      };
    }
  }

  // The Hood's previous claim is superseded, not reverted: it keeps its points.
  // Spec §1.3 — "A player who loses a Hood does not lose points."
  if (prev?.active_claim_id) {
    db.prepare("UPDATE claims SET status = 'superseded' WHERE id = ? AND status = 'active'")
      .run(prev.active_claim_id);
  }

  const claimRow = db.prepare(`
    INSERT INTO claims (hood_id, player_id, season_id, photo_id, claim_kind, photo_type,
                        beaten_player_id, beaten_photo_type, points_awarded, xp_awarded,
                        status, flag_count,
                        prev_owner_id, prev_photo_type, prev_claim_id, prev_last_claim_at,
                        prev_locked_until, created_at)
    VALUES (@hood_id, @player_id, @season_id, @photo_id, @claim_kind, @photo_type,
            @beaten_player_id, @beaten_photo_type, @points_awarded, @xp_awarded,
            'active', 0,
            @prev_owner_id, @prev_photo_type, @prev_claim_id, @prev_last_claim_at,
            @prev_locked_until, @created_at)`)
    .run({
      hood_id: hoodId,
      player_id: playerId,
      season_id: season.id,
      photo_id: photoRow.lastInsertRowid,
      claim_kind: kind,
      photo_type: declaredType,
      beaten_player_id: kind === 'conquer' ? null : prev?.owner_id ?? null,
      beaten_photo_type: kind === 'conquer' ? null : prev?.photo_type ?? null,
      points_awarded: evaluation.points,
      xp_awarded: earned.xp,
      prev_owner_id: prev?.owner_id ?? null,
      prev_photo_type: prev?.photo_type ?? null,
      prev_claim_id: prev?.active_claim_id ?? null,
      prev_last_claim_at: prev?.last_claim_at ?? null,
      prev_locked_until: prev?.locked_until ?? null,
      created_at: at,
    });
  const claimId = Number(claimRow.lastInsertRowid);

  // A steal arms the anti-ping-pong lock, and so does a conquer — both are a change
  // of hands. A reinforce deliberately does not (spec §1.3): if it did, a player
  // could shield a Hood indefinitely by reinforcing on a timer. Rotating what beats
  // you is the defence a reinforce buys.
  const lockedUntil = kind === 'reinforce'
    ? (prev?.locked_until ?? null)
    : isoPlusHours(at, config.STEAL_COOLDOWN_HOURS);

  db.prepare(`
    UPDATE hood_state
       SET owner_id = ?, active_claim_id = ?, photo_type = ?, last_claim_at = ?, locked_until = ?
     WHERE hood_id = ?`)
    .run(playerId, claimId, declaredType, at, lockedUntil, hoodId);

  if (kind === 'conquer' && !hood.ever_conquered) {
    db.prepare('UPDATE hoods SET ever_conquered = 1 WHERE id = ?').run(hoodId);
  }

  // The claim has landed, so the item that opened it is spent — in this transaction, so
  // the two commit or fail together.
  let itemUsed = null;
  if (needed) {
    spendGrant({ grant: item, playerId, targetHoodId: hoodId, context: { claim_id: claimId }, at });
    itemUsed = { grant_id: item.id, item_type: item.item_type, label: itemLabel(item.item_type) };
  }

  // A change of hands leaves nothing armed for anybody else. A live Fortify would have
  // stopped a steal above, so anything left here is a stale row.
  if (kind !== 'reinforce') {
    db.prepare('DELETE FROM item_armed WHERE hood_id = ? AND player_id != ?').run(hoodId, playerId);
  }

  return {
    blocked: false, claim: getClaim(claimId), evaluation, season, hood, prev, xp: earned,
    item_used: itemUsed, item_kept: item && !needed
      ? { grant_id: item.id, item_type: item.item_type, label: itemLabel(item.item_type) } : null,
  };
});

/**
 * Revert a claim once it crosses the flag threshold (spec §1.7).
 *
 * On points: the original row is marked `reverted`, and every scoring query excludes
 * that status — that exclusion is what actually cancels the points, so the
 * compensating `reversal` row carries 0 rather than -N. Doing both would subtract the
 * score twice. The reversal row earns its place by making the cancellation visible in
 * the feed and in the Hood's history; the ledger stays append-only either way.
 */
export const revertClaim = db.transaction((claimId, { reason = 'flagged' } = {}) => {
  const at = nowIso();
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!claim) throw notFound('CLAIM_NOT_FOUND', 'No such claim.');
  if (claim.status === 'reverted') return { claim, alreadyReverted: true };

  db.prepare("UPDATE claims SET status = 'reverted' WHERE id = ?").run(claimId);

  const state = db.prepare('SELECT * FROM hood_state WHERE hood_id = ?').get(claim.hood_id);
  const wasLive = state?.active_claim_id === claim.id;

  // Only rewind territory if this claim is still the one standing. If someone has
  // since taken the Hood legitimately, that later claim is untouched — we just cancel
  // the flagged claim's points.
  if (wasLive) {
    db.prepare(`
      UPDATE hood_state
         SET owner_id = ?, active_claim_id = ?, photo_type = ?, last_claim_at = ?, locked_until = ?
       WHERE hood_id = ?`)
      .run(claim.prev_owner_id, claim.prev_claim_id, claim.prev_photo_type,
           claim.prev_last_claim_at, claim.prev_locked_until, claim.hood_id);

    if (claim.prev_claim_id) {
      db.prepare("UPDATE claims SET status = 'active' WHERE id = ? AND status = 'superseded'")
        .run(claim.prev_claim_id);
    }

    // A Fortify belongs to whoever held the Hood when it was armed. If the Hood goes back
    // to somebody else, it is disarmed — the grant returns to its owner's inventory.
    db.prepare('DELETE FROM item_armed WHERE hood_id = ? AND player_id IS NOT ?')
      .run(claim.hood_id, claim.prev_owner_id);

    // A reverted first-ever conquer un-conquers the Hood, so seasonal escalation
    // resumes for it — otherwise one bogus claim freezes its value at 25 forever.
    if (claim.claim_kind === 'conquer' && !claim.prev_owner_id) {
      const others = db.prepare(`
        SELECT COUNT(*) AS c FROM claims
        WHERE hood_id = ? AND id != ? AND claim_kind != 'reversal' AND status != 'reverted'`)
        .get(claim.hood_id, claim.id);
      if (others.c === 0) {
        db.prepare('UPDATE hoods SET ever_conquered = 0 WHERE id = ?').run(claim.hood_id);
      }
    }
  }

  const reversal = db.prepare(`
    INSERT INTO claims (hood_id, player_id, season_id, photo_id, claim_kind, photo_type,
                        beaten_player_id, beaten_photo_type, points_awarded, status, flag_count,
                        reverts_claim_id, created_at)
    VALUES (?, ?, ?, NULL, 'reversal', NULL, ?, NULL, 0, 'active', 0, ?, ?)`)
    .run(claim.hood_id, claim.player_id, claim.season_id, claim.player_id, claim.id, at);

  return {
    claim: getClaim(claim.id),
    reversal: getClaim(Number(reversal.lastInsertRowid)),
    restoredOwnerId: wasLive ? claim.prev_owner_id : null,
    wasLive,
    reason,
  };
});

// The player columns are aliased to bare `handle` / `display_name` / `colour` to match
// the feed and history queries, because shapeClaim() and claimSummary() consume rows
// from all three and must not have to care which one produced them.
export function getClaim(id) {
  return db.prepare(`
    SELECT c.*, p.handle AS handle, p.display_name AS display_name, p.colour AS colour,
           b.handle AS beaten_handle, b.display_name AS beaten_name,
           h.name AS hood_name,
           ph.path_thumb, ph.path_display, ph.exif_json, ph.caption
      FROM claims c
      JOIN players p ON p.id = c.player_id
      JOIN hoods   h ON h.id = c.hood_id
 LEFT JOIN players b ON b.id = c.beaten_player_id
 LEFT JOIN photos ph ON ph.id = c.photo_id
     WHERE c.id = ?`).get(id);
}

/** "a landmark", "a person", "an animal" — the three subjects, read aloud. */
export const article = (type) => `${type === 'animal' ? 'an' : 'a'} ${type}`;

const cap = (s) => s[0].toUpperCase() + s.slice(1);
