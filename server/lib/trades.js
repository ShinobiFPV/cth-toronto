// Trading park cards.
//
// The rule that shapes everything here: **a trade moves the card, never the score.**
// `points_awarded` and `xp_awarded` stay on the claim, with whoever earned them by
// actually walking to that park. Two reasons, and both are load-bearing:
//
//   - Points would otherwise be launderable. Six friends who can hand each other cards
//     can hand each other 100-point cards, and the season table stops meaning anything.
//   - XP is defined as how long you have been doing this (spec §1.9). You cannot trade
//     your own activity to somebody else; the idea is incoherent.
//
// So a trade is a change of *holding*, and holding lives in `card_holdings` rather than
// on the ledger row — mutable state beside an append-only ledger, exactly the
// relationship `hood_state` has with `claims`. The table is sparse: a row exists only
// for a card that has moved, so the holder of a card is
// COALESCE(card_holdings.holder_id, claims.player_id) and an untouched card needs
// nothing at all.
//
// Duplicates are allowed in a binder. In a card game duplicates are the entire currency
// of trading — what stays capped is *collecting*, which is still once per park per
// season per player.
import { db, nowIso } from '../db.js';
import { GameError, badRequest, forbidden, notFound } from './errors.js';

/** Who holds this card right now, and who they got it from. */
export const holdingOf = (claimId) => db.prepare(`
  SELECT COALESCE(h.holder_id, c.player_id) AS holder_id,
         c.player_id AS collector_id,
         h.from_player_id,
         h.acquired_at
    FROM claims c
    LEFT JOIN card_holdings h ON h.claim_id = c.id
   WHERE c.id = ?`).get(claimId);

const player = (id) => db.prepare(
  'SELECT id, handle, display_name, colour FROM players WHERE id = ?').get(id);

/**
 * A card fit to be traded, or the reason it is not.
 *
 * A reverted claim is not a card. The group threw the photo out, the points are
 * cancelled and it has left every binder — so it cannot be offered, and it cannot be
 * asked for either.
 */
function tradableCard(claimId, expectedHolder, { side }) {
  // A park card or a Not Wheels package — both trade through here, under the same rule.
  const row = db.prepare(`
    SELECT c.id, c.status, c.park_id, c.claim_kind, p.name AS park_name, p.value,
           v.make, v.model
      FROM claims c
      LEFT JOIN parks p ON p.id = c.park_id
      LEFT JOIN vehicles v ON v.id = c.vehicle_id
     WHERE c.id = ?`).get(claimId);

  if (!row || !(row.park_id || row.claim_kind === 'car')) {
    throw notFound('CARD_NOT_FOUND', `There is no card with id ${claimId}.`);
  }
  const name = row.park_name ?? `the ${row.make} ${row.model}`;
  if (row.status === 'reverted') {
    throw badRequest('CARD_REVERTED',
      `${name} was thrown out by flags, so it is not a card any more.`);
  }
  const held = holdingOf(claimId);
  if (held.holder_id !== expectedHolder) {
    throw badRequest('CARD_NOT_HELD', side === 'offer'
      ? `You do not hold ${name} any more.`
      : `They do not hold ${name} any more.`);
  }
  return { ...row, name };
}

/**
 * Offer one of your cards for one of theirs — or for nothing, which is a gift.
 *
 * Nothing is escrowed. Both cards stay exactly where they are until the offer is
 * accepted, which is when the holdings are checked again.
 */
export const offerTrade = db.transaction(({ fromId, toId, offerClaimId, wantClaimId = null, message = null }) => {
  if (fromId === toId) {
    throw badRequest('TRADE_WITH_SELF', 'Trading with yourself is not a trade.');
  }
  if (!player(toId)) throw notFound('PLAYER_NOT_FOUND', 'No player with that id.');

  const offered = tradableCard(offerClaimId, fromId, { side: 'offer' });
  const wanted = wantClaimId != null
    ? tradableCard(wantClaimId, toId, { side: 'want' })
    : null;

  // One pending offer per card per recipient. Without this a stray double-tap sends
  // the same trade twice and the other player has to decline it twice.
  const dupe = db.prepare(`
    SELECT id FROM trades
     WHERE status = 'pending' AND from_player_id = ? AND to_player_id = ?
       AND offer_claim_id = ? AND IFNULL(want_claim_id, -1) = IFNULL(?, -1)`)
    .get(fromId, toId, offerClaimId, wantClaimId);
  if (dupe) {
    throw badRequest('TRADE_ALREADY_OFFERED', 'That offer is already on the table.');
  }

  const at = nowIso();
  const row = db.prepare(`
    INSERT INTO trades (from_player_id, to_player_id, offer_claim_id, want_claim_id,
                        message, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
    .run(fromId, toId, offerClaimId, wantClaimId, message || null, at);

  return { id: Number(row.lastInsertRowid), offered, wanted, at };
});

const move = db.prepare(`
  INSERT INTO card_holdings (claim_id, holder_id, from_player_id, acquired_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(claim_id) DO UPDATE
    SET holder_id = excluded.holder_id,
        from_player_id = excluded.from_player_id,
        acquired_at = excluded.acquired_at`);

/**
 * Accept an offer. One transaction, and it re-checks both cards inside it.
 *
 * The offer may have been sitting there for a week while both players kept playing, so
 * the holdings it was written against are a courtesy, not the ruling — the same
 * relationship `evaluateClaim` has with `commitClaim`. An offer whose cards have moved
 * on is marked `stale` rather than left to be retried forever.
 */
const acceptTx = db.transaction(({ tradeId, playerId }) => {
  const trade = getTradeRow(tradeId);
  if (trade.to_player_id !== playerId) {
    throw forbidden('NOT_YOUR_TRADE', 'That offer was not made to you.');
  }
  if (trade.status !== 'pending') {
    throw badRequest('TRADE_NOT_PENDING', `That offer is already ${trade.status}.`);
  }

  let offered;
  let wanted = null;
  try {
    offered = tradableCard(trade.offer_claim_id, trade.from_player_id, { side: 'offer' });
    if (trade.want_claim_id != null) {
      wanted = tradableCard(trade.want_claim_id, trade.to_player_id, { side: 'want' });
    }
  } catch (err) {
    // Reported back rather than thrown. Throwing out of a better-sqlite3 transaction
    // rolls it back, which would undo the very write that records the offer as stale —
    // so that write happens outside, in acceptTrade below.
    if (err instanceof GameError && (err.code === 'CARD_NOT_HELD' || err.code === 'CARD_REVERTED')) {
      return { stale: err.message };
    }
    throw err;
  }

  const at = nowIso();
  move.run(trade.offer_claim_id, trade.to_player_id, trade.from_player_id, at);
  if (trade.want_claim_id != null) {
    move.run(trade.want_claim_id, trade.from_player_id, trade.to_player_id, at);
  }
  db.prepare("UPDATE trades SET status = 'accepted', resolved_at = ? WHERE id = ?")
    .run(at, tradeId);

  return {
    trade: getTrade(tradeId),
    offered,
    wanted,
    from: player(trade.from_player_id),
    to: player(trade.to_player_id),
  };
});

/**
 * Accept an offer, and record it as stale if its cards have moved on.
 *
 * The two steps cannot share a transaction: the stale marking is a consequence of the
 * failure, and a transaction that throws takes its own writes down with it.
 */
export function acceptTrade({ tradeId, playerId }) {
  const result = acceptTx({ tradeId, playerId });
  if (result.stale) {
    db.prepare(`UPDATE trades SET status = 'stale', resolved_at = ?
                 WHERE id = ? AND status = 'pending'`).run(nowIso(), tradeId);
    throw badRequest('TRADE_STALE', `${result.stale} This offer is no longer good.`);
  }
  return result;
}

/** Turn an offer down. Only the player it was made to. */
export const declineTrade = db.transaction(({ tradeId, playerId }) => {
  const trade = getTradeRow(tradeId);
  if (trade.to_player_id !== playerId) {
    throw forbidden('NOT_YOUR_TRADE', 'That offer was not made to you.');
  }
  if (trade.status !== 'pending') {
    throw badRequest('TRADE_NOT_PENDING', `That offer is already ${trade.status}.`);
  }
  db.prepare("UPDATE trades SET status = 'declined', resolved_at = ? WHERE id = ?")
    .run(nowIso(), tradeId);
  return getTrade(tradeId);
});

/** Take back an offer you made. Only the player who made it. */
export const cancelTrade = db.transaction(({ tradeId, playerId }) => {
  const trade = getTradeRow(tradeId);
  if (trade.from_player_id !== playerId) {
    throw forbidden('NOT_YOUR_TRADE', 'That is not your offer to withdraw.');
  }
  if (trade.status !== 'pending') {
    throw badRequest('TRADE_NOT_PENDING', `That offer is already ${trade.status}.`);
  }
  db.prepare("UPDATE trades SET status = 'cancelled', resolved_at = ? WHERE id = ?")
    .run(nowIso(), tradeId);
  return getTrade(tradeId);
});

function getTradeRow(tradeId) {
  const row = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  if (!row) throw notFound('TRADE_NOT_FOUND', 'No offer with that id.');
  return row;
}

const TRADE_SELECT = `
  SELECT t.*,
         fp.handle AS from_handle, fp.display_name AS from_name, fp.colour AS from_colour,
         tp.handle AS to_handle, tp.display_name AS to_name, tp.colour AS to_colour,
         oc.claim_kind AS offer_kind, oc.edition AS offer_edition,
         COALESCE(op.name, ov.make || ' ' || ov.model) AS offer_card_name, op.value AS offer_value,
         wc.claim_kind AS want_kind, wc.edition AS want_edition,
         COALESCE(wp.name, wv.make || ' ' || wv.model) AS want_card_name, wp.value AS want_value
    FROM trades t
    JOIN players fp ON fp.id = t.from_player_id
    JOIN players tp ON tp.id = t.to_player_id
    JOIN claims oc  ON oc.id = t.offer_claim_id
    LEFT JOIN parks    op ON op.id = oc.park_id
    LEFT JOIN vehicles ov ON ov.id = oc.vehicle_id
    LEFT JOIN claims wc ON wc.id = t.want_claim_id
    LEFT JOIN parks    wp ON wp.id = wc.park_id
    LEFT JOIN vehicles wv ON wv.id = wc.vehicle_id`;

// A side of an offer. `value` is a park's value and null for a car package, whose worth
// is its edition; `park_name` survives as an alias of `name` for older clients.
const side = (claimId, kind, name, value, edition) => ({
  claim_id: claimId,
  kind: kind === 'car' ? 'car' : 'park',
  name,
  park_name: name,
  value: kind === 'car' ? null : value,
  edition: kind === 'car' ? (edition ?? 'steel') : (edition ?? null),
});

const shapeTrade = (r) => ({
  id: r.id,
  status: r.status,
  message: r.message,
  created_at: r.created_at,
  resolved_at: r.resolved_at,
  from: { id: r.from_player_id, handle: r.from_handle, display_name: r.from_name, colour: r.from_colour },
  to: { id: r.to_player_id, handle: r.to_handle, display_name: r.to_name, colour: r.to_colour },
  offer: side(r.offer_claim_id, r.offer_kind, r.offer_card_name, r.offer_value, r.offer_edition),
  // No want side means a gift, and the UI says so rather than showing an empty slot.
  want: r.want_claim_id == null
    ? null
    : side(r.want_claim_id, r.want_kind, r.want_card_name, r.want_value, r.want_edition),
  is_gift: r.want_claim_id == null,
});

export const getTrade = (tradeId) => {
  const row = db.prepare(`${TRADE_SELECT} WHERE t.id = ?`).get(tradeId);
  return row ? shapeTrade(row) : null;
};

/**
 * Every offer this player is part of, split by direction. Pending first, because that
 * is the only kind anybody has to do something about.
 */
export function tradesFor(playerId, { limit = 60 } = {}) {
  const rows = db.prepare(`${TRADE_SELECT}
     WHERE t.from_player_id = ? OR t.to_player_id = ?
     ORDER BY (t.status = 'pending') DESC, t.id DESC
     LIMIT ?`).all(playerId, playerId, limit).map(shapeTrade);

  return {
    incoming: rows.filter((t) => t.to.id === playerId),
    outgoing: rows.filter((t) => t.from.id === playerId),
    pending_incoming: rows.filter((t) => t.to.id === playerId && t.status === 'pending').length,
  };
}

/** For the tab badge: how many offers are waiting on this player. */
export const pendingCount = (playerId) => db.prepare(
  "SELECT COUNT(*) AS n FROM trades WHERE to_player_id = ? AND status = 'pending'")
  .get(playerId).n;
