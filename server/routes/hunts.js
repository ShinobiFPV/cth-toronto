// Scavenger Blitz endpoints. The rules are in lib/hunts.js; the vision calls happen here,
// in the route, never inside a transaction.
import { Router } from 'express';
import multer from 'multer';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../lib/auth.js';
import { processUpload, discardUpload, blurRegions } from '../lib/images.js';
import { identifyPhoto } from '../lib/identify.js';
import { resolveIdentification } from '../lib/vehicles.js';
import { verifyHuntPhoto } from '../lib/hunt-verify.js';
import {
  startHunt, huntsFor, openSlot, submitParkPhoto, submitStreetPhoto, overrideSlot, abandonHunt, amenityIndex,
} from '../lib/hunts.js';
import { withLevelUp, announceLevelUp } from '../lib/xp-announce.js';
import { broadcast, postMessage } from '../lib/hub.js';
import { GameError, badRequest } from '../lib/errors.js';
import { announceCarCollection } from './cars.js';

export const huntRoutes = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

huntRoutes.get('/hunts', requireAuth, (req, res) => {
  res.json(huntsFor(req.player.id));
});

/** For the park picker: in-season amenities per park. No positions; the phone has those. */
huntRoutes.get('/hunts/parks', requireAuth, (_req, res) => {
  res.json(amenityIndex());
});

huntRoutes.post('/hunts', requireAuth, (req, res, next) => {
  try {
    const hunt = startHunt({ playerId: req.player.id, kind: req.body?.kind, parkId: req.body?.park_id ?? null });
    res.status(201).json({ hunt });
  } catch (err) { next(err); }
});

huntRoutes.post('/hunts/:id/abandon', requireAuth, (req, res, next) => {
  try {
    res.json({ hunt: abandonHunt({ playerId: req.player.id, huntId: req.params.id }) });
  } catch (err) { next(err); }
});

/** Plate boxes straight from the identifier's answer, for a photo it could not resolve. */
const platesIn = (raw) => (Array.isArray(raw?.plates) ? raw.plates : [])
  .map((p) => ({
    x: Math.min(1, Math.max(0, Number(p?.x) || 0)), y: Math.min(1, Math.max(0, Number(p?.y) || 0)),
    width: Math.min(1, Math.max(0, Number(p?.width) || 0)), height: Math.min(1, Math.max(0, Number(p?.height) || 0)),
  }))
  .filter((p) => p.width > 0 && p.height > 0);

/**
 * A photo for one slot. The response says whether the camera confirmed it; if not, the
 * photo is kept and "I'm sure" (POST /override) can mark the slot without sending it again.
 */
huntRoutes.post('/hunts/:id/submit', requireAuth, upload.single('photo'), async (req, res, next) => {
  let photo = null;
  let keep = false;
  try {
    const player = req.player;
    // Cheap checks before sharp and before any billed vision call.
    const { hunt, item } = openSlot({ playerId: player.id, huntId: req.params.id, slot: req.body?.slot });
    const hoodId = Number(req.body?.hood_id) || null;
    if (hunt.kind === 'street' && !(hoodId && db.prepare('SELECT 1 FROM hoods WHERE id = ?').get(hoodId))) {
      throw badRequest('HOOD_REQUIRED', 'Say which Hood the car was in.');
    }

    photo = await processUpload(req.file);
    let outcome;
    let levelUp;
    let progress;
    let reason = null;

    if (hunt.kind === 'park') {
      const check = await verifyHuntPhoto(photo, item.label);
      if (check.unavailable) reason = 'The camera check is not answering right now.';
      ({ result: outcome, levelUp, progress } = withLevelUp(player.id,
        () => submitParkPhoto({ playerId: player.id, huntId: hunt.id, slot: item.slot, photo, found: check.found })));
      keep = true;
    } else {
      let raw = null;
      let identification = null;
      let identifyError = null;
      try {
        raw = await identifyPhoto(photo, { target: item.label });
      } catch (err) {
        if (!(err instanceof GameError)) throw err;
        identifyError = { code: err.code, message: err.message };
      }
      if (raw) {
        try {
          identification = resolveIdentification(raw, { minConfidence: config.IDENTIFY_MIN_CONFIDENCE });
        } catch (err) {
          if (!(err instanceof GameError)) throw err;
          identifyError = { code: err.code, message: err.message };
        }
      }
      // Before anything is written, whichever system ends up using the photo — and from the
      // raw answer too, so an unresolved car still has its plate blurred.
      const plates = identification?.plates ?? platesIn(raw);
      if (config.CAR_BLUR_PLATES && plates.length) await blurRegions(photo, plates);

      try {
        ({ result: outcome, levelUp, progress } = withLevelUp(player.id, () => submitStreetPhoto({
          playerId: player.id, huntId: hunt.id, slot: item.slot, photo, hoodId,
          raw, identification, identifyError, caption: req.body?.caption,
        })));
      } catch (err) {
        if (err.carCommitted) keep = true;
        throw err;
      }
      keep = true;
      if (identifyError && !outcome.verified) reason = identifyError.message;

      // The card, if one was printed, announces itself like any car.
      if (outcome.car) {
        announceCarCollection(player, outcome.car);
        broadcast('car_collected', {
          claim_id: outcome.car.repeat ? outcome.car.claim_id : outcome.car.card.claim_id,
          vehicle_id: outcome.car.vehicle.id, hood_id: hoodId, player_id: player.id,
          points: outcome.car.points, edition: outcome.car.repeat ? null : outcome.car.card.edition,
          repeat: outcome.car.repeat,
        });
      }
    }

    if (outcome.completion) announceCompletion(player, outcome.completion, outcome.hunt);
    announceLevelUp(player, levelUp);

    res.status(201).json({
      verified: outcome.verified,
      can_override: !outcome.verified,
      reason,
      label: outcome.label,
      hunt: outcome.hunt,
      completion: outcome.completion,
      card: outcome.car && !outcome.car.repeat ? outcome.car.card : null,
      car_points: outcome.car?.points ?? null,
      car_items: outcome.car?.items ?? null,
      car_error: outcome.car_error ?? null,
      progress,
      level_up: levelUp,
    });
  } catch (err) {
    if (!keep) await discardUpload(photo);
    next(err);
  }
});

/** "I'm sure — mark it anyway." Marks the slot and raises it for the group. */
huntRoutes.post('/hunts/:id/override', requireAuth, (req, res, next) => {
  try {
    const player = req.player;
    const { result, levelUp, progress } = withLevelUp(player.id,
      () => overrideSlot({ playerId: player.id, huntId: req.params.id, slot: req.body?.slot }));

    postMessage({
      body: `${player.display_name} marked "${result.label}" found on their ${result.hunt.title} `
        + 'without the camera agreeing. If it looks wrong when the hunt lands, flag it.',
      kind: 'system',
      meta: { event: 'hunt_override', hunt_id: result.hunt.id, slot: Number(req.body?.slot), player_id: player.id },
    });

    if (result.completion) announceCompletion(player, result.completion, result.hunt);
    announceLevelUp(player, levelUp);
    res.json({ hunt: result.hunt, completion: result.completion, progress, level_up: levelUp });
  } catch (err) { next(err); }
});

/**
 * A finished hunt, in one chat line. Five photos is a lot of feed, so it carries a strip of
 * thumbnails — for a street hunt. A park hunt is often a child's afternoon, and its photos
 * stay with the player unless CTH_HUNT_PARK_PHOTOS_PUBLIC says otherwise.
 */
function announceCompletion(player, completion, hunt) {
  const share = hunt.kind === 'street' || config.HUNT_PARK_PHOTOS_PUBLIC;
  const thumbs = share
    ? db.prepare(`SELECT ph.path_thumb FROM hunt_items i JOIN photos ph ON ph.id = i.photo_id
                   WHERE i.hunt_id = ? ORDER BY i.slot`).all(hunt.id).map((r) => `/media/${r.path_thumb}`)
    : [];

  const worth = completion.reason === 'no_season'
    ? 'between seasons, so no rewards'
    : [
      completion.points > 0 ? `+${completion.points}` : null,
      `+${completion.xp} XP`,
      completion.items.length ? `${completion.items.length} items` : null,
    ].filter(Boolean).join(', ')
      + (completion.reason === 'weekly_limit' ? ` — past this week's ${completion.week_limit} scoring hunts` : '')
      + (completion.reason === 'season_cap' ? ' — the season’s hunt points are used up' : '');

  postMessage({
    body: `${player.display_name} finished a ${completion.title} (${worth})`
      + (completion.self_confirmed ? `. ${completion.self_confirmed} of the 5 were marked found by hand.` : ''),
    kind: 'system',
    meta: {
      event: 'hunt_complete', hunt_id: hunt.id, claim_id: completion.claim_id, kind: hunt.kind,
      player_id: player.id, thumbs,
    },
  });
  if (completion.claim_id) broadcast('hood_changed', { hood_id: null });
  if (completion.items.length) broadcast('items_changed', { player_id: player.id });
  broadcast('hunt_completed', { player_id: player.id, hunt_id: hunt.id });
}
