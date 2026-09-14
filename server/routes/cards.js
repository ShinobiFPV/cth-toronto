// The binder: one shelf for every kind of card. See lib/collectables.js.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { cardsOf, getCard, binderSummary, isCardKind, cardKindList } from '../lib/collectables.js';
import { notFound } from '../lib/errors.js';

export const cardRoutes = Router();

/**
 * A binder. `?season=` scopes it; omit for everything ever held. `?player=` reads
 * somebody else's, and defaults to your own. `?kind=` narrows it to one kind of card;
 * omit it for all of them, which is what a binder is.
 *
 * Other players' binders are open on purpose. Nobody competes over a card — collecting
 * one takes nothing from anybody — so a collection is something to show off rather than
 * something to hide, and half the fun of a card game is looking at what everybody else
 * pulled. The cards are in the feed and in chat the moment they are collected anyway.
 */
cardRoutes.get('/cards', requireAuth, (req, res, next) => {
  const seasonId = req.query.season ? Number(req.query.season) : null;
  const playerId = req.query.player ? Number(req.query.player) : req.player.id;
  const kind = isCardKind(req.query.kind) ? req.query.kind : null;

  const player = db.prepare('SELECT id, handle, display_name, colour FROM players WHERE id = ?')
    .get(playerId);
  if (!player) return next(notFound('PLAYER_NOT_FOUND', 'No player with that id.'));

  res.json({
    player,
    is_you: player.id === req.player.id,
    kind,
    kinds: cardKindList(),
    cards: cardsOf(player.id, { seasonId, kind }),
    summary: binderSummary(player.id),
  });
});

/**
 * One card, by the claim that produced it, whatever kind. Not scoped to the owner — this
 * is what the feed opens when you tap somebody else's collection.
 */
cardRoutes.get('/cards/:claimId', requireAuth, (req, res, next) => {
  const card = getCard(Number(req.params.claimId));
  if (!card) return next(notFound('CARD_NOT_FOUND', 'No card with that id.'));
  res.json({ card });
});
