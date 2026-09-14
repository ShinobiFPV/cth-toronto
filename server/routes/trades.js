// Trading endpoints. A trade moves a card between binders and never touches a score —
// see lib/trades.js for why that is the whole design.
import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';
import {
  offerTrade, acceptTrade, declineTrade, cancelTrade, tradesFor, getTrade,
} from '../lib/trades.js';
import { getCard } from '../lib/collectables.js';
import { broadcast, postMessage } from '../lib/hub.js';
import { badRequest } from '../lib/errors.js';

export const tradeRoutes = Router();

/** Everything you are part of, incoming and outgoing. */
tradeRoutes.get('/trades', requireAuth, (req, res) => {
  res.json(tradesFor(req.player.id));
});

tradeRoutes.get('/trades/:id', requireAuth, (req, res, next) => {
  const trade = getTrade(Number(req.params.id));
  if (!trade) return next(badRequest('TRADE_NOT_FOUND', 'No offer with that id.'));
  // Not scoped to the two parties: offers are announced in chat anyway, and a private
  // trade nobody can look up would only make the announcement confusing.
  res.json({ trade });
});

/**
 * Offer a card. `want_claim_id` is optional — leaving it out is a gift.
 *
 * Nothing is escrowed: both cards stay where they are until the offer is accepted.
 */
tradeRoutes.post('/trades', requireAuth, (req, res, next) => {
  try {
    const toId = Number(req.body?.to_player_id);
    const offerClaimId = Number(req.body?.offer_claim_id);
    const wantClaimId = req.body?.want_claim_id == null ? null : Number(req.body.want_claim_id);
    if (!toId || !offerClaimId) {
      throw badRequest('BAD_TRADE', 'An offer needs a player to send it to and a card to offer.');
    }

    const { id } = offerTrade({
      fromId: req.player.id,
      toId,
      offerClaimId,
      wantClaimId,
      message: typeof req.body?.message === 'string' ? req.body.message.slice(0, 200) : null,
    });
    const trade = getTrade(id);

    // Chat is the activity feed and, for six people with no push notifications, it is
    // also how the other player finds out an offer is waiting.
    postMessage({
      body: `${trade.from.display_name} offered ${trade.to.display_name} `
        + (trade.is_gift
          ? `${trade.offer.name} as a gift`
          : `${trade.offer.name} for ${trade.want.name}`)
        + (trade.message ? ` — "${trade.message}"` : ''),
      kind: 'system',
      meta: { event: 'trade_offered', trade_id: trade.id },
    });
    broadcast('trade_offered', trade);

    res.status(201).json({ trade });
  } catch (err) { next(err); }
});

tradeRoutes.post('/trades/:id/accept', requireAuth, (req, res, next) => {
  try {
    const result = acceptTrade({ tradeId: Number(req.params.id), playerId: req.player.id });
    const { trade } = result;

    postMessage({
      body: trade.is_gift
        ? `${trade.to.display_name} accepted ${trade.offer.name} from ${trade.from.display_name}`
        : `${trade.from.display_name} and ${trade.to.display_name} traded — `
          + `${trade.offer.name} for ${trade.want.name}`,
      kind: 'system',
      meta: { event: 'trade_accepted', trade_id: trade.id },
    });
    broadcast('trade_resolved', trade);

    res.json({
      trade,
      // The cards as they now stand, so the binder can update without a refetch.
      cards: [
        getCard(trade.offer.claim_id),
        trade.want ? getCard(trade.want.claim_id) : null,
      ].filter(Boolean),
    });
  } catch (err) { next(err); }
});

/**
 * Turn an offer down, or withdraw your own. Neither is announced in chat: the offer
 * already was, and a public "X said no to Y" is not something this game needs.
 */
tradeRoutes.post('/trades/:id/decline', requireAuth, (req, res, next) => {
  try {
    const trade = declineTrade({ tradeId: Number(req.params.id), playerId: req.player.id });
    broadcast('trade_resolved', trade);
    res.json({ trade });
  } catch (err) { next(err); }
});

tradeRoutes.delete('/trades/:id', requireAuth, (req, res, next) => {
  try {
    const trade = cancelTrade({ tradeId: Number(req.params.id), playerId: req.player.id });
    broadcast('trade_resolved', trade);
    res.json({ trade });
  } catch (err) { next(err); }
});
