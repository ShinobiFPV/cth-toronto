// Parkemon GO endpoints. The park map is scoped to one Hood, because that is how you
// reach it — you tap a Hood, then you play the sub-game inside it.
import { Router } from 'express';
import multer from 'multer';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../lib/auth.js';
import {
  listParksInHood, evaluateCollect, commitCollect, getPark, getCardByClaim,
  cardsOf, collectionSummary, parkProgress, shapePark,
} from '../lib/parks.js';
import { processUpload, discardUpload } from '../lib/images.js';
import { broadcast, postMessage } from '../lib/hub.js';
import { notFound } from '../lib/errors.js';
import { hoodLabel } from '../lib/hood-seed.js';

export const parkRoutes = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
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
    const { claim, park } = commitCollect({ parkId, playerId: req.player.id, photo });

    postMessage({
      body: `${req.player.display_name} collected ${park.name} in `
        + `${hoodLabel(park.hood_id, park.hood_name)} (+${claim.points}, ${claim.rarity_label})`,
      kind: 'system',
      meta: { event: 'park', claim_id: claim.claim_id, park_id: park.id, hood_id: park.hood_id },
    });
    broadcast('park_collected', {
      park_id: park.id, hood_id: park.hood_id, player_id: req.player.id, points: claim.points,
    });

    res.status(201).json({ card: claim });
  } catch (err) {
    await discardUpload(photo);
    next(err);
  }
});

/** The binder. `?season=` scopes it; omit for everything ever collected. */
parkRoutes.get('/cards', requireAuth, (req, res) => {
  const seasonId = req.query.season ? Number(req.query.season) : null;
  res.json({
    cards: cardsOf(req.player.id, { seasonId }),
    summary: collectionSummary(req.player.id),
  });
});

parkRoutes.get('/cards/:claimId', requireAuth, (req, res, next) => {
  const card = getCardByClaim(Number(req.params.claimId));
  if (!card) return next(notFound('CARD_NOT_FOUND', 'No card with that id.'));
  res.json({ card });
});
