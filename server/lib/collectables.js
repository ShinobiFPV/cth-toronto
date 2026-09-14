// Collectables: every kind of card the game prints, behind one registry.
//
// Players collect cards for their binder. A park prints one, a car prints one, and
// whatever comes next will print one too — so nothing that *reads* cards should know how
// many kinds there are. The binder, the one-card lookup, trading and the binder's totals
// all go through here.
//
// Adding a kind is: its own module (the collect flow, the card's shape, its summary), a
// claim_kind for its rows, and one entry in COLLECTABLES. Nothing downstream changes.
//
// What makes that possible is that every kind of card obeys the same rules:
//   - it is a row in `claims`, and its claim_kind names the kind
//   - it never touches hood_state
//   - its holder is COALESCE(card_holdings.holder_id, claims.player_id)
//   - it rolls an edition, pays XP, grants items only if it scored, and trades without
//     moving its points
//   - its shape carries `kind`, `claim_id`, `name`, `edition`, `player`, `holder`,
//     `traded` and `season`, whatever else it adds
import { db, nowIso } from '../db.js';
import { activeSeason } from './seasons.js';
import * as parks from './parks.js';
import * as cars from './cars.js';

/**
 * Each entry: the claim_kind, what to call it, and three functions — the cards a player
 * holds, one card by claim id, and the kind's own binder summary.
 */
export const COLLECTABLES = [
  {
    kind: 'park',
    label: 'Parks',
    noun: 'park card',
    cardsOf: parks.cardsOf,
    getCard: parks.getCardByClaim,
    summary: parks.collectionSummary,
  },
  {
    kind: 'car',
    label: 'Cars',
    noun: 'car card',
    cardsOf: cars.carCardsOf,
    getCard: cars.getCarCard,
    summary: cars.carSummary,
  },
];

const byKind = new Map(COLLECTABLES.map((c) => [c.kind, c]));

/** The claim kinds that print a card. */
export const CARD_KINDS = COLLECTABLES.map((c) => c.kind);

export const isCardKind = (kind) => byKind.has(kind);

export const collectable = (kind) => byKind.get(kind) ?? null;

/** What the client needs to label the kinds, without the functions. */
export const cardKindList = () => COLLECTABLES.map(({ kind, label, noun }) => ({ kind, label, noun }));

/**
 * A player's binder: every card they hold, of every kind — or of one, if `kind` is given.
 * Newest first. Holdings, not collections: after a trade those differ, and the binder is
 * a shelf.
 */
export function cardsOf(playerId, { seasonId = null, kind = null, limit = 500 } = {}) {
  const kinds = kind ? [collectable(kind)].filter(Boolean) : COLLECTABLES;
  return kinds
    .flatMap((k) => k.cardsOf(playerId, { seasonId, limit }))
    .sort((a, b) => b.claim_id - a.claim_id)
    .slice(0, limit);
}

/** One card by the claim that printed it, whatever kind it is. Null for anything else. */
export function getCard(claimId) {
  const row = db.prepare('SELECT claim_kind FROM claims WHERE id = ?').get(claimId);
  return row && isCardKind(row.claim_kind) ? collectable(row.claim_kind).getCard(claimId) : null;
}

/**
 * The binder's totals. Across every kind at the top, and each kind's own detail under
 * `kinds` — a park knows how big its set is, a car knows its weekly cap, and the binder
 * does not need to know which is which to show both.
 *
 * Collected and held stay separate questions, as they always have: `season_collected` and
 * `season_points` count what this player went and got; `cards_held` counts the shelf.
 */
export function binderSummary(playerId, at = nowIso()) {
  const kinds = Object.fromEntries(COLLECTABLES.map((k) => [k.kind, k.summary(playerId, at)]));
  const all = Object.values(kinds);
  const sum = (key) => all.reduce((n, s) => n + (s[key] ?? 0), 0);

  const byEdition = {};
  for (const s of all) {
    for (const [edition, n] of Object.entries(s.by_edition ?? {})) {
      byEdition[edition] = (byEdition[edition] ?? 0) + n;
    }
  }

  return {
    season: activeSeason(at),
    season_collected: sum('season_collected'),
    season_points: sum('season_points'),
    cards_held: sum('cards_held'),
    cards_received: sum('cards_received'),
    cards_given_away: sum('cards_given_away'),
    by_edition: byEdition,
    kinds,
  };
}
