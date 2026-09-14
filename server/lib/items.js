// Items: consumables that Gold and Hologram pulls grant, and that bend the cooldowns.
//
// Special cards are deliberately common — about one collection in seven — and uncapped.
// Items are not. Once you stop earning points you stop earning items, and past the weekly
// item cap you keep pulling cards without accruing any more power. Card rate and item
// rate are two independent knobs, which is most of what splitting them buys.
//
// Consuming an item is a mutation and the ledger is append-only, so this is the scoring
// trick again: `item_grants` and `item_uses` only ever grow, and an inventory is grants
// minus uses, derived, never stored. `item_uses.grant_id` is UNIQUE, so spending one grant
// twice is impossible at the schema level. The one mutable table is `item_armed`, and it
// only stages a Fortify — arming is not an event worth keeping; consuming is.
//
// Rules that are easy to get wrong:
//
//   - **Items follow the puller, never the card.** A grant carries the player who pulled
//     it, permanently. A trade moves the card and nothing else, or two players could
//     shuttle one Gold back and forth laundering items.
//   - **An active Clover is derived, not stored.** It is a clover use whose expires_at is
//     still ahead. No flag, no expiry job, nothing to miss.
//   - **Pulls inside a Clover window never grant Clover**, or the loop sustains itself.
//   - **An armed Fortify is visible to nobody but its owner.** Visible, nobody attacks it
//     and it becomes a wall rather than a trap.
//   - **Items expire with their season.** Derived here too: a grant is only spendable in
//     the season it was granted in. The rollover only has to disarm and announce.
//
// The type is rolled with fresh crypto.randomInt, like an edition and for the same
// reason: from card_seed, a player could read their next item off a card they hold.
import crypto from 'node:crypto';
import { db, nowIso, isoPlusHours } from '../db.js';
import { config } from '../config.js';
import { GameError, notFound } from './errors.js';
import { activeSeason } from './seasons.js';
import { hoodLabel } from './hood-seed.js';
import { weekKey, weekResetsAt, weekStartName } from './week.js';
import { humanUntil } from './time.js';

export const ITEM_TYPES = ['fortify', 'recon', 'crowbar', 'sprint', 'tuneup', 'clover'];

const LABELS = {
  fortify: 'Fortify',
  recon: 'Recon',
  crowbar: 'Crowbar',
  sprint: 'Sprint',
  tuneup: 'Tune-Up',
  clover: 'Clover',
};

export const itemLabel = (type) => LABELS[type] ?? type;

/** What each item does, in the numbers currently configured. For the inventory screen. */
export function describeItems() {
  const h = (n) => `${n} hour${n === 1 ? '' : 's'}`;
  return {
    fortify: {
      label: LABELS.fortify,
      blurb: `Arm it on a Hood you hold. The first steal attempt bounces off, and that thief is shut out of the Hood for ${h(config.FORTIFY_COOLDOWN_HOURS)}. Nobody else can see it is there.`,
      how: 'arm',
    },
    recon: {
      label: LABELS.recon,
      blurb: 'Find out whether somebody else’s Hood is fortified, before you travel.',
      how: 'use',
    },
    crowbar: {
      label: LABELS.crowbar,
      blurb: 'Steal through the lock on a Hood that just changed hands. Offered when the lock stops you, and spent only if the steal lands.',
      how: 'claim',
    },
    sprint: {
      label: LABELS.sprint,
      blurb: 'Conquer next door to a Hood you just took, without waiting out the cooldown. Offered when it stops you, and spent only if the conquer lands.',
      how: 'claim',
    },
    tuneup: {
      label: LABELS.tuneup,
      blurb: `Open the ${config.REINFORCE_GATE_HOURS}-hour reinforce gate on a Hood you hold, right now.`,
      how: 'use',
    },
    clover: {
      label: LABELS.clover,
      blurb: `Doubles your Gold and Hologram odds for ${h(config.CLOVER_HOURS)}. Pulls inside the window never grant another Clover, and a second one will not stack.`,
      how: 'use',
    },
  };
}

const wrongTarget = (message) => new GameError('ITEM_WRONG_TARGET', message);

/** Items a pull of this edition grants, before any cap. */
export const itemsForEdition = (edition) => (
  edition === 'hologram' ? config.ITEMS_PER_HOLOGRAM
    : edition === 'gold' ? config.ITEMS_PER_GOLD
      : 0);

// ── Clover ────────────────────────────────────────────────────────────────

/** The Clover running for this player at `at`, or null. Derived from the use, nothing else. */
export const activeClover = (playerId, at = nowIso()) => db.prepare(`
  SELECT id, grant_id, created_at, expires_at FROM item_uses
   WHERE player_id = ? AND item_type = 'clover' AND expires_at > ?
   ORDER BY expires_at DESC LIMIT 1`).get(playerId, at) ?? null;

// ── the weekly cap ────────────────────────────────────────────────────────

/** Items granted to a player in a week. A grant off a reverted card gives its slot back. */
export const grantsInWeek = (playerId, week) => db.prepare(`
  SELECT COUNT(*) AS n FROM item_grants g
    JOIN claims c ON c.id = g.claim_id
   WHERE g.player_id = ? AND g.week_key = ? AND c.status != 'reverted'
     AND g.source = 'pull'`).get(playerId, week).n;

export function itemCapacity(playerId, at = nowIso()) {
  const week = weekKey(at);
  const granted = grantsInWeek(playerId, week);
  const cap = config.ITEM_WEEKLY_CAP > 0 ? config.ITEM_WEEKLY_CAP : null;
  return {
    week_key: week,
    granted,
    cap,
    remaining: cap == null ? null : Math.max(0, cap - granted),
    resets_at: weekResetsAt(at),
    resets_on: weekStartName(),
  };
}

// ── granting ──────────────────────────────────────────────────────────────

/**
 * Which item a grant is. A weighted draw over the configured weights, minus anything
 * excluded — Clover, inside a Clover window.
 */
export function rollItemType({ rand = crypto.randomInt, exclude = [] } = {}) {
  const SCALE = 1000;   // weights may be fractional
  const pool = ITEM_TYPES
    .map((type) => [type, exclude.includes(type) ? 0 : Math.round(Math.max(0, Number(config.ITEM_WEIGHTS[type]) || 0) * SCALE)])
    .filter(([, w]) => w > 0);
  const total = pool.reduce((sum, [, w]) => sum + w, 0);
  if (!total) return null;
  let draw = rand(total);
  for (const [type, w] of pool) {
    if (draw < w) return type;
    draw -= w;
  }
  return pool[pool.length - 1][0];
}

/**
 * Grant whatever a pull earns. Call inside the collection's transaction, after its claim
 * row is written, with the same `at` the edition was rolled at.
 *
 * "No points, no items": a collection worth 0 — past the car cap, past a Hood's park cap
 * — grants nothing. Past the weekly item cap the grant is clamped with min(), like every
 * other cap here, so a Hologram with one slot left grants one item rather than none.
 * Withheld items are reported back so chat can say so plainly.
 */
export function grantItems({
  claimId, playerId, seasonId, edition, points, at,
  clover = !!activeClover(playerId, at), rand = crypto.randomInt,
}) {
  const wanted = itemsForEdition(edition);
  const week = weekKey(at);
  const out = { items: [], wanted, withheld: 0, reason: null, week_key: week, clover };
  if (wanted <= 0) return out;

  if (!(points > 0)) {
    return { ...out, withheld: wanted, reason: 'no_points' };
  }

  const cap = config.ITEM_WEEKLY_CAP;
  const allowed = cap > 0 ? Math.max(0, Math.min(wanted, cap - grantsInWeek(playerId, week))) : wanted;

  const insert = db.prepare(`
    INSERT INTO item_grants (claim_id, player_id, season_id, week_key, item_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < allowed; i += 1) {
    const type = rollItemType({ rand, exclude: clover ? ['clover'] : [] });
    if (!type) break;
    const id = Number(insert.run(claimId, playerId, seasonId, week, type, at).lastInsertRowid);
    out.items.push({ grant_id: id, item_type: type, label: itemLabel(type) });
  }

  out.withheld = wanted - out.items.length;
  out.reason = out.withheld > 0 ? 'weekly_cap' : null;
  return out;
}

// ── holding and spending ──────────────────────────────────────────────────

/**
 * A completed Scavenger Blitz's items. Exempt from the weekly item cap — hunts are the
 * designed, deliberate path to items and have their own weekly limit on scoring
 * completions (lib/hunts.js) — so these are recorded as source 'hunt', which
 * grantsInWeek() leaves out. The Clover rule still applies. Call inside the completion's
 * transaction, after its claim row is written.
 */
export function grantHuntItems({
  claimId, playerId, seasonId, count, at,
  clover = !!activeClover(playerId, at), rand = crypto.randomInt,
}) {
  const insert = db.prepare(`
    INSERT INTO item_grants (claim_id, player_id, season_id, week_key, item_type, created_at, source)
    VALUES (?, ?, ?, ?, ?, ?, 'hunt')`);
  const week = weekKey(at);
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const type = rollItemType({ rand, exclude: clover ? ['clover'] : [] });
    if (!type) break;
    const id = Number(insert.run(claimId, playerId, seasonId, week, type, at).lastInsertRowid);
    items.push({ grant_id: id, item_type: type, label: itemLabel(type) });
  }
  return items;
}

const grantRow = (grantId) => db.prepare(`
  SELECT g.*, c.status AS claim_status, u.id AS use_id,
         a.hood_id AS armed_hood_id, h.name AS armed_hood_name
    FROM item_grants g
    LEFT JOIN claims c     ON c.id = g.claim_id
    LEFT JOIN item_uses u  ON u.grant_id = g.id
    LEFT JOIN item_armed a ON a.grant_id = g.id
    LEFT JOIN hoods h      ON h.id = a.hood_id
   WHERE g.id = ?`).get(grantId);

/**
 * A grant this player can spend right now, or the reason they cannot. Every way of using
 * an item goes through here, so "held" means the same thing everywhere.
 */
export function heldGrant(playerId, grantId, at = nowIso()) {
  const id = Number(grantId);
  const g = Number.isInteger(id) && id > 0 ? grantRow(id) : null;
  if (!g || g.player_id !== playerId) {
    throw new GameError('ITEM_NOT_HELD', 'You do not have that item.');
  }
  const label = itemLabel(g.item_type);
  if (!g.claim_status || g.claim_status === 'reverted') {
    throw new GameError('ITEM_NOT_HELD',
      `That ${label} came off a card the group threw out, so it went with it.`);
  }
  if (g.use_id) {
    throw new GameError('ITEM_ALREADY_USED', `That ${label} has already been used.`);
  }
  const season = activeSeason(at);
  if (!season || season.id !== g.season_id) {
    throw new GameError('ITEM_NOT_HELD', `That ${label} expired when its season ended.`);
  }
  if (g.armed_hood_id != null) {
    throw new GameError('ITEM_ALREADY_USED',
      `That ${label} is armed on ${hoodLabel(g.armed_hood_id, g.armed_hood_name)}. Disarm it first.`);
  }
  return g;
}

/**
 * Spend a grant. The UNIQUE index on grant_id is the ruling: if two requests race for the
 * same grant, the second insert fails here and nothing else in its transaction lands.
 */
export function spendGrant({
  grant, playerId, targetHoodId = null, targetPlayerId = null, expiresAt = null, context = null, at,
}) {
  try {
    return Number(db.prepare(`
      INSERT INTO item_uses (grant_id, player_id, item_type, target_hood_id, target_player_id,
                             expires_at, context_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(grant.id, playerId, grant.item_type, targetHoodId, targetPlayerId, expiresAt,
           context ? JSON.stringify(context) : null, at).lastInsertRowid);
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) {
      throw new GameError('ITEM_ALREADY_USED', `That ${itemLabel(grant.item_type)} has already been used.`);
    }
    throw err;
  }
}

// ── what the state machine asks ───────────────────────────────────────────

/**
 * The Fortify that would stop a steal on this Hood right now, or null.
 *
 * A row in item_armed is only a live Fortify if its owner still holds the Hood, its grant
 * is this season's, its card was not thrown out, and it has not been spent. Anything else
 * is a stale row and is treated as nothing at all.
 */
export function armedFortifyOn(hoodId, at = nowIso()) {
  const season = activeSeason(at);
  if (!season) return null;
  return db.prepare(`
    SELECT a.hood_id, a.grant_id, a.player_id, a.armed_at
      FROM item_armed a
      JOIN item_grants g ON g.id = a.grant_id
      JOIN claims c      ON c.id = g.claim_id
      JOIN hood_state s  ON s.hood_id = a.hood_id AND s.owner_id = a.player_id
      LEFT JOIN item_uses u ON u.grant_id = a.grant_id
     WHERE a.hood_id = ? AND g.season_id = ? AND c.status != 'reverted' AND u.id IS NULL`)
    .get(hoodId, season.id) ?? null;
}

/**
 * The cooldown a Fortify leaves behind: this attacker, this Hood, for
 * FORTIFY_COOLDOWN_HOURS. Derived from the Fortify's own use row, exactly as the adjacency
 * cooldown is derived from the conquer that caused it — two per-player cooldowns, one
 * shape, no third table to shadow either of them.
 */
export function fortifyCooldown(attackerId, hoodId, at = nowIso()) {
  if (!(config.FORTIFY_COOLDOWN_HOURS > 0)) return null;
  const since = isoPlusHours(at, -config.FORTIFY_COOLDOWN_HOURS);
  const row = db.prepare(`
    SELECT created_at, player_id AS defender_id FROM item_uses
     WHERE item_type = 'fortify' AND target_player_id = ? AND target_hood_id = ? AND created_at > ?
     ORDER BY created_at DESC LIMIT 1`).get(attackerId, hoodId, since);
  return row ? { ...row, until: isoPlusHours(row.created_at, config.FORTIFY_COOLDOWN_HOURS) } : null;
}

/**
 * Has this player tuned up the reinforce gate they are currently waiting on?
 *
 * A Tune-Up records the last_claim_at it was spent against, and counts only while that
 * is still the Hood's last_claim_at. The reinforce it enables moves last_claim_at on, which
 * is what spends it — and a reversal that rewinds last_claim_at brings it back, which is
 * right, because the reinforce it paid for was thrown out. hood_state is never touched.
 */
export const tuneupPending = (playerId, hoodId, lastClaimAt) => !!db.prepare(`
  SELECT 1 FROM item_uses
   WHERE player_id = ? AND target_hood_id = ? AND item_type = 'tuneup'
     AND json_extract(context_json, '$.last_claim_at') IS ?
   LIMIT 1`).get(playerId, hoodId, lastClaimAt ?? null);

const hoodWithState = (hoodId) => {
  const row = db.prepare(`
    SELECT h.id, h.name, s.owner_id, s.last_claim_at, s.locked_until
      FROM hoods h JOIN hood_state s ON s.hood_id = h.id WHERE h.id = ?`).get(Number(hoodId));
  if (!row) throw notFound('HOOD_NOT_FOUND', 'There is no Hood with that number.');
  return { ...row, label: hoodLabel(row.id, row.name) };
};

// ── the actions ───────────────────────────────────────────────────────────

/** Arm a Fortify on a Hood you hold. Free; only the steal that hits it spends it. */
export const armFortify = db.transaction(({ playerId, grantId, hoodId, at = nowIso() }) => {
  const grant = heldGrant(playerId, grantId, at);
  if (grant.item_type !== 'fortify') {
    throw wrongTarget(`A ${itemLabel(grant.item_type)} is not something you arm. Only a Fortify is.`);
  }
  const hood = hoodWithState(hoodId);
  if (hood.owner_id !== playerId) {
    throw wrongTarget(`You can only fortify a Hood you hold, and ${hood.label} is not yours.`);
  }
  if (db.prepare('SELECT 1 FROM item_armed WHERE hood_id = ?').get(hood.id)) {
    if (armedFortifyOn(hood.id, at)) {
      throw new GameError('HOOD_ALREADY_ARMED',
        `${hood.label} already has a Fortify on it. One is a trap; three would be a wall.`);
    }
    // Somebody's stale row — a Hood lost to a reversal, or last season's. Not a Fortify.
    db.prepare('DELETE FROM item_armed WHERE hood_id = ?').run(hood.id);
  }
  db.prepare('INSERT INTO item_armed (hood_id, grant_id, player_id, armed_at) VALUES (?, ?, ?, ?)')
    .run(hood.id, grant.id, playerId, at);
  return { hood_id: hood.id, hood_label: hood.label, grant_id: grant.id };
});

/** Take your Fortify back off a Hood. Free, and the item goes back in your inventory. */
export const disarmFortify = db.transaction(({ playerId, hoodId }) => {
  const hood = hoodWithState(hoodId);
  const res = db.prepare('DELETE FROM item_armed WHERE hood_id = ? AND player_id = ?')
    .run(hood.id, playerId);
  if (!res.changes) throw wrongTarget(`Nothing of yours is armed on ${hood.label}.`);
  return { hood_id: hood.id, hood_label: hood.label };
});

/**
 * Use Recon, Tune-Up or Clover. Crowbar and Sprint are spent by the claim they open, in
 * that claim's transaction (see commitClaim), so an item is never spent on a claim that
 * then fails validation.
 */
export const useItem = db.transaction(({ playerId, grantId, targetHoodId = null, at = nowIso() }) => {
  const grant = heldGrant(playerId, grantId, at);

  switch (grant.item_type) {
    case 'clover': {
      const running = activeClover(playerId, at);
      if (running) {
        throw new GameError('CLOVER_ACTIVE',
          `You already have a Clover running, with ${humanUntil(at, running.expires_at)} left. They do not stack.`,
          { expires_at: running.expires_at });
      }
      const expiresAt = isoPlusHours(at, config.CLOVER_HOURS);
      const useId = spendGrant({ grant, playerId, expiresAt, at });
      return { use_id: useId, item_type: 'clover', label: itemLabel('clover'), expires_at: expiresAt };
    }

    case 'recon': {
      if (targetHoodId == null) throw wrongTarget('Recon needs a Hood to look at.');
      const hood = hoodWithState(targetHoodId);
      if (!hood.owner_id || hood.owner_id === playerId) {
        throw wrongTarget(`Recon is for a Hood somebody else holds, and ${hood.label} is ${hood.owner_id ? 'yours' : 'unclaimed'}.`);
      }
      const fortified = !!armedFortifyOn(hood.id, at);
      const useId = spendGrant({
        grant, playerId, targetHoodId: hood.id, targetPlayerId: hood.owner_id,
        context: { fortified }, at,
      });
      return { use_id: useId, item_type: 'recon', label: itemLabel('recon'),
        hood_id: hood.id, hood_label: hood.label, fortified };
    }

    case 'tuneup': {
      if (targetHoodId == null) throw wrongTarget('A Tune-Up needs a Hood you hold.');
      const hood = hoodWithState(targetHoodId);
      if (hood.owner_id !== playerId) {
        throw wrongTarget(`A Tune-Up only works on a Hood you hold, and ${hood.label} is not yours.`);
      }
      const opensAt = hood.last_claim_at
        ? isoPlusHours(hood.last_claim_at, config.REINFORCE_GATE_HOURS) : at;
      if (opensAt <= at) {
        throw wrongTarget(`${hood.label} can already be reinforced. Keep the Tune-Up.`);
      }
      if (tuneupPending(playerId, hood.id, hood.last_claim_at)) {
        throw wrongTarget(`${hood.label} is already tuned up. Go and reinforce it.`);
      }
      const useId = spendGrant({
        grant, playerId, targetHoodId: hood.id,
        context: { last_claim_at: hood.last_claim_at, gate_opened_early_by: humanUntil(at, opensAt) }, at,
      });
      return { use_id: useId, item_type: 'tuneup', label: itemLabel('tuneup'),
        hood_id: hood.id, hood_label: hood.label };
    }

    case 'crowbar':
      throw wrongTarget('A Crowbar is spent on the steal it opens. The Hood sheet offers it when a lock stops you.');
    case 'sprint':
      throw wrongTarget('A Sprint is spent on the conquer it opens. The Hood sheet offers it when the cooldown stops you.');
    case 'fortify':
      throw wrongTarget('A Fortify is armed on a Hood you hold, not used.');
    default:
      throw wrongTarget('That item does nothing.');
  }
});

// ── reading ───────────────────────────────────────────────────────────────

/**
 * Everything the inventory screen shows: what you hold, what is armed and where, how long
 * your Clover has left, and where you stand against this week's item cap.
 */
export function inventoryOf(playerId, at = nowIso()) {
  const season = activeSeason(at);
  const rows = season ? db.prepare(`
    SELECT g.id AS grant_id, g.item_type, g.created_at, g.claim_id,
           a.hood_id AS armed_hood_id, a.armed_at, h.name AS armed_hood_name
      FROM item_grants g
      JOIN claims c         ON c.id = g.claim_id
      LEFT JOIN item_uses u  ON u.grant_id = g.id
      LEFT JOIN item_armed a ON a.grant_id = g.id
      LEFT JOIN hoods h      ON h.id = a.hood_id
     WHERE g.player_id = ? AND g.season_id = ? AND c.status != 'reverted' AND u.id IS NULL
     ORDER BY g.id`).all(playerId, season.id) : [];

  const loose = rows.filter((r) => r.armed_hood_id == null);
  const counts = Object.fromEntries(ITEM_TYPES.map((t) => [t, 0]));
  for (const r of loose) counts[r.item_type] += 1;

  const clover = activeClover(playerId, at);
  return {
    season: season ? { id: season.id, name: season.name, ends_at: season.ends_at } : null,
    items: loose.map((r) => ({
      grant_id: r.grant_id, item_type: r.item_type, label: itemLabel(r.item_type),
      granted_at: r.created_at, claim_id: r.claim_id,
    })),
    counts,
    held: loose.length,
    armed: rows.filter((r) => r.armed_hood_id != null).map((r) => ({
      grant_id: r.grant_id,
      hood_id: r.armed_hood_id,
      hood_label: hoodLabel(r.armed_hood_id, r.armed_hood_name),
      armed_at: r.armed_at,
      // False only for a stale row: a Hood you have since lost to a reversal.
      live: armedFortifyOn(r.armed_hood_id, at)?.grant_id === r.grant_id,
    })),
    clover: clover
      ? { active: true, started_at: clover.created_at, expires_at: clover.expires_at }
      : { active: false, started_at: null, expires_at: null },
    capacity: itemCapacity(playerId, at),
    catalogue: describeItems(),
  };
}

/** The two numbers the header and the capture sheets want, without the whole inventory. */
export function itemSummary(playerId, at = nowIso()) {
  const season = activeSeason(at);
  const held = season ? db.prepare(`
    SELECT COUNT(*) AS n FROM item_grants g
      JOIN claims c ON c.id = g.claim_id
      LEFT JOIN item_uses u ON u.grant_id = g.id
     WHERE g.player_id = ? AND g.season_id = ? AND c.status != 'reverted' AND u.id IS NULL`)
    .get(playerId, season.id).n : 0;
  return { held, clover_until: activeClover(playerId, at)?.expires_at ?? null };
}

/**
 * Every grant and every use, for when somebody argues. Includes the Fortifies that caught
 * you, because being on the wrong end of one is part of your history too.
 */
export function itemHistory(playerId, { limit = 100 } = {}) {
  const grants = db.prepare(`
    SELECT g.id AS grant_id, g.item_type, g.created_at, g.claim_id, g.season_id, g.week_key,
           c.status AS claim_status, c.edition,
           COALESCE(p.name, v.make || ' ' || v.model) AS card_name,
           s.name AS season_name, u.created_at AS used_at
      FROM item_grants g
      LEFT JOIN claims c    ON c.id = g.claim_id
      LEFT JOIN parks p     ON p.id = c.park_id
      LEFT JOIN vehicles v  ON v.id = c.vehicle_id
      LEFT JOIN seasons s   ON s.id = g.season_id
      LEFT JOIN item_uses u ON u.grant_id = g.id
     WHERE g.player_id = ?
     ORDER BY g.id DESC LIMIT ?`).all(playerId, limit);

  const uses = db.prepare(`
    SELECT u.*, h.name AS hood_name, dp.display_name AS player_name, tp.display_name AS target_name
      FROM item_uses u
      LEFT JOIN hoods h    ON h.id = u.target_hood_id
      LEFT JOIN players dp ON dp.id = u.player_id
      LEFT JOIN players tp ON tp.id = u.target_player_id
     WHERE u.player_id = ? OR (u.item_type = 'fortify' AND u.target_player_id = ?)
     ORDER BY u.id DESC LIMIT ?`).all(playerId, playerId, limit);

  return {
    grants: grants.map((g) => ({
      grant_id: g.grant_id,
      item_type: g.item_type,
      label: itemLabel(g.item_type),
      granted_at: g.created_at,
      claim_id: g.claim_id,
      card_name: g.card_name ?? null,
      edition: g.edition ?? null,
      season_name: g.season_name ?? null,
      used_at: g.used_at ?? null,
      voided: g.claim_status === 'reverted',
    })),
    uses: uses.map((u) => {
      const context = u.context_json ? JSON.parse(u.context_json) : null;
      // Recon's answer is yours; nobody else's history carries it. A Fortify that caught
      // you does not say what the defender's inventory was, only that it happened.
      return {
        use_id: u.id,
        item_type: u.item_type,
        label: itemLabel(u.item_type),
        used_at: u.created_at,
        mine: u.player_id === playerId,
        hood_id: u.target_hood_id,
        hood_label: u.target_hood_id ? hoodLabel(u.target_hood_id, u.hood_name) : null,
        by: u.player_name,
        against: u.target_name ?? null,
        expires_at: u.expires_at,
        fortified: u.item_type === 'recon' && u.player_id === playerId ? !!context?.fortified : undefined,
      };
    }),
  };
}

// ── season rollover ───────────────────────────────────────────────────────

/**
 * Expire a finished season's items: disarm its Fortifies and report what went unspent,
 * per player, so the rollover can say so in chat. Unspendable already by derivation —
 * heldGrant refuses any grant from a season that is not the active one — so this only
 * tidies the one mutable table and produces the list people should feel.
 *
 * Guarded by seasons.items_expired, set in the same transaction, so a second run returns
 * null and posts nothing.
 */
export const expireSeasonItems = db.transaction((seasonId) => {
  const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(seasonId);
  if (!season || season.items_expired) return null;

  const rows = db.prepare(`
    SELECT g.player_id, p.display_name, g.item_type, COUNT(*) AS n
      FROM item_grants g
      JOIN claims c  ON c.id = g.claim_id
      JOIN players p ON p.id = g.player_id
      LEFT JOIN item_uses u ON u.grant_id = g.id
     WHERE g.season_id = ? AND c.status != 'reverted' AND u.id IS NULL
     GROUP BY g.player_id, g.item_type
     ORDER BY p.display_name COLLATE NOCASE, g.item_type`).all(seasonId);

  const disarmed = db.prepare(`
    DELETE FROM item_armed WHERE grant_id IN (SELECT id FROM item_grants WHERE season_id = ?)`)
    .run(seasonId).changes;
  db.prepare('UPDATE seasons SET items_expired = 1 WHERE id = ?').run(seasonId);

  const players = new Map();
  for (const r of rows) {
    if (!players.has(r.player_id)) {
      players.set(r.player_id, { player_id: r.player_id, display_name: r.display_name, items: {}, total: 0 });
    }
    const p = players.get(r.player_id);
    p.items[r.item_type] = r.n;
    p.total += r.n;
  }
  return { season, players: [...players.values()], disarmed };
});

/** "Items expired with Fall 2026: Alice — 2 Fortify, 1 Clover; Bob — 1 Recon." */
export function expiryMessage(result) {
  if (!result || !result.players.length) return null;
  const parts = result.players.map((p) => `${p.display_name} — ${Object.entries(p.items)
    .map(([type, n]) => `${n} ${itemLabel(type)}`).join(', ')}`);
  return `Items expired with ${result.season.name}: ${parts.join('; ')}. `
    + 'Nothing carries over — spend them next season before it ends.';
}
