// Park endpoints. The park map is scoped to one Hood, because that is how you
// reach it — you tap a Hood, then you play the sub-game inside it.
import { Router } from 'express';
import multer from 'multer';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../lib/auth.js';
import {
  listParksInHood, evaluateCollect, commitCollect, getPark, getCardByClaim,
  cardsOf, collectionSummary, parkProgress, shapePark, parksForMap,
} from '../lib/parks.js';
import { processUpload, discardUpload } from '../lib/images.js';
import { broadcast, postMessage } from '../lib/hub.js';
import { withLevelUp, announceLevelUp } from '../lib/xp-announce.js';
import { notFound } from '../lib/errors.js';
import { hoodLabel } from '../lib/hood-seed.js';
import { packagesOf, garageSummary, getPackageByClaim } from '../lib/garage.js';
import { itemClause, announceItemCap } from '../lib/item-announce.js';
import { weekStartName } from '../lib/week.js';

export const parkRoutes = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

/**
 * Every park in the city, for the dots on the main map. One fetch of about 70 kB, so
 * the map draws all 1,513 without asking per Hood.
 */
parkRoutes.get('/parks/map', requireAuth, (req, res) => {
  res.json(parksForMap(req.player.id));
});

/** Every park in a Hood, with this player's collection state for the season. */
parkRoutes.get('/hoods/:id/parks', requireAuth, (req, res, next) => {
  const hoodId = Number(req.params.id);
  const hood = db.prepare('SELECT id, name FROM hoods WHERE id = ?').get(hoodId);
  if (!hood) return next(notFound('HOOD_NOT_FOUND', 'There is no Hood with that number.'));
  res.json({
    hood: { id: hood.id, name: hood.name, label: hoodLabel(hood.id, hood.name) },
    progress: parkProgress(hoodId, req.player.id),
    parks: listParksInHood(hoodId, req.player.id),
  });
});

parkRoutes.get('/parks/:id', requireAuth, (req, res, next) => {
  const park = getPark(Number(req.params.id));
  if (!park) return next(notFound('PARK_NOT_FOUND', 'No park with that id.'));
  const check = evaluateCollect({ parkId: park.id, playerId: req.player.id });
  res.json({ park: shapePark(park), viewer: check });
});

/** Dry run, so the sheet can say "already in your binder" before the camera opens. */
parkRoutes.get('/parks/:id/check', requireAuth, (req, res, next) => {
  try {
    res.json(evaluateCollect({ parkId: Number(req.params.id), playerId: req.player.id }));
  } catch (err) { next(err); }
});

/**
 * Collect a park: one photo of its sign. No subject, no counter rule, no cooldown —
 * the only rule is once per park per season.
 */
parkRoutes.post('/parks/:id/collect', requireAuth, upload.single('photo'), async (req, res, next) => {
  let photo = null;
  try {
    const parkId = Number(req.params.id);

    // Cheap pre-check before spending Pi CPU on sharp. commitCollect re-validates inside
    // its transaction, so this is an optimisation rather than the ruling.
    const pre = evaluateCollect({ parkId, playerId: req.player.id });
    if (!pre.ok) {
      return res.status(409).json({ error: pre.error, message: pre.message, claim_id: pre.claim_id });
    }

    photo = await processUpload(req.file);
    const { result, levelUp, progress } = withLevelUp(req.player.id,
      () => commitCollect({ parkId, playerId: req.player.id, photo, caption: req.body?.caption }));
    const { claim, park, xp, items, capacity } = result;

    // A collection past the Hood's cap is a success, and says so as one.
    const where = hoodLabel(park.hood_id, park.hood_name);
    const worth = claim.points > 0
      ? `+${claim.points}`
      : `XP only — ${where} is capped for them until ${capacity.resets_on}`;
    postMessage({
      body: `${req.player.display_name} collected ${park.name} in `
        + `${where} (${worth}, ${claim.rarity_label})`,
      kind: 'system',
      meta: { event: 'park', claim_id: claim.claim_id, park_id: park.id, hood_id: park.hood_id },
    });

    // Gold and Hologram get their own line rather than a parenthesis on the last one, and
    // the items they came with ride on it. Every card is at least Steel now, so Steel says
    // nothing — a second line on every collection would bury the ones worth reading.
    if (claim.edition === 'gold' || claim.edition === 'hologram') {
      postMessage({
        body: (claim.edition === 'hologram'
          ? `HOLOGRAM — ${req.player.display_name} pulled a hologram out of ${park.name} in ${where}`
          : `Gold edition — ${req.player.display_name}'s ${park.name} came out gold`)
          + ` (+${xp.edition_xp} XP)${itemClause(items)}`,
        kind: 'system',
        meta: {
          event: 'edition', edition: claim.edition,
          claim_id: claim.claim_id, park_id: park.id, hood_id: park.hood_id,
          items: items.items.map((i) => i.item_type),
        },
      });
    }
    announceItemCap(req.player, items, weekStartName());

    broadcast('park_collected', {
      park_id: park.id, hood_id: park.hood_id, player_id: req.player.id,
      points: claim.points, edition: claim.edition ?? null,
    });
    if (items.items.length) broadcast('items_changed', { player_id: req.player.id });
    announceLevelUp(req.player, levelUp);

    res.status(201).json({ card: claim, xp, progress, level_up: levelUp, items, capacity });
  } catch (err) {
    await discardUpload(photo);
    next(err);
  }
});

/**
 * A binder. `?season=` scopes it; omit for everything ever collected. `?player=` reads
 * somebody else's, and defaults to your own.
 *
 * Other players' binders are open on purpose. Nobody competes over parks (spec §1.8) —
 * a card in your binder takes nothing from anyone — so a collection is something to
 * show off rather than something to hide, and half the fun of a card game is looking
 * at what everybody else pulled. The cards are visible in the feed and in chat the
 * moment they are collected anyway.
 */
parkRoutes.get('/cards', requireAuth, (req, res, next) => {
  const seasonId = req.query.season ? Number(req.query.season) : null;
  const playerId = req.query.player ? Number(req.query.player) : req.player.id;
  // `?kind=car` is the Case — Not Wheels packages instead of park cards. Same shelf
  // rules: holdings, public, optionally one season.
  const kind = req.query.kind === 'car' ? 'car' : 'park';

  const player = db.prepare('SELECT id, handle, display_name, colour FROM players WHERE id = ?')
    .get(playerId);
  if (!player) return next(notFound('PLAYER_NOT_FOUND', 'No player with that id.'));

  res.json({
    player,
    is_you: player.id === req.player.id,
    kind,
    cards: kind === 'car' ? packagesOf(player.id, { seasonId }) : cardsOf(player.id, { seasonId }),
    summary: kind === 'car' ? garageSummary(player.id) : collectionSummary(player.id),
  });
});

/**
 * One card, by the claim that produced it. Not scoped to the owner — this is what the
 * feed opens when you tap somebody else's collection, and it is the same information
 * the feed already shows, laid out as the card it printed.
 */
parkRoutes.get('/cards/:claimId', requireAuth, (req, res, next) => {
  const claimId = Number(req.params.claimId);
  const card = getCardByClaim(claimId) ?? getPackageByClaim(claimId);
  if (!card) return next(notFound('CARD_NOT_FOUND', 'No card with that id.'));
  res.json({ card });
});
