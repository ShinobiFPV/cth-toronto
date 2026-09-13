// The Garage's endpoints. See lib/garage.js for the rules and lib/identify.js for the
// vision call.
import { Router } from 'express';
import multer from 'multer';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../lib/auth.js';
import { activeSeason } from '../lib/seasons.js';
import { processUpload, discardUpload, blurRegions } from '../lib/images.js';
import { identifyPhoto } from '../lib/identify.js';
import { resolveIdentification, withArticle } from '../lib/vehicles.js';
import { commitCar, capacityFor, catalogue, vehicleHistory } from '../lib/garage.js';
import { broadcast, postMessage } from '../lib/hub.js';
import { withLevelUp, announceLevelUp } from '../lib/xp-announce.js';
import { GameError, badRequest, notFound } from '../lib/errors.js';
import { hoodLabel } from '../lib/hood-seed.js';

export const carRoutes = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

/** Where you stand this week — shown on the capture sheet before the shutter. */
carRoutes.get('/cars/capacity', requireAuth, (req, res) => {
  const season = activeSeason();
  res.json({
    capacity: capacityFor(req.player.id),
    season: season ? { id: season.id, name: season.name } : null,
    identify_enabled: config.IDENTIFY_ENABLED,
  });
});

/** Every vehicle ever pulled, and who holds what. Public, like binders. */
carRoutes.get('/cars', requireAuth, (_req, res) => {
  res.json(catalogue());
});

carRoutes.get('/cars/:vehicleId', requireAuth, (req, res, next) => {
  const history = vehicleHistory(Number(req.params.vehicleId));
  if (!history) return next(notFound('VEHICLE_NOT_FOUND', 'No vehicle with that id.'));
  res.json(history);
});

/**
 * Collect a car: upload → sharp → identify → evaluate → commit.
 *
 * Noticeably slower than a park, because of the identify call in the middle; the client
 * says "Identifying…" across the round trip rather than showing a dead spinner.
 */
carRoutes.post('/cars/collect', requireAuth, upload.single('photo'), async (req, res, next) => {
  let photo = null;
  try {
    const hoodId = Number(req.body?.hood_id);
    const hood = hoodId ? db.prepare('SELECT id, name FROM hoods WHERE id = ?').get(hoodId) : null;
    if (!hood) throw badRequest('HOOD_REQUIRED', 'Say which Hood the car was in.');
    // Cheap checks before spending Pi CPU on sharp and money on the identify call.
    if (!activeSeason()) {
      throw new GameError('NO_ACTIVE_SEASON', 'The game is between seasons — no collecting right now.');
    }

    photo = await processUpload(req.file);
    const identification = resolveIdentification(await identifyPhoto(photo),
      { minConfidence: config.IDENTIFY_MIN_CONFIDENCE });

    // Before anything is written, so no derivative that could be served ever shows a
    // readable plate. A failure here fails the collection rather than publishing one.
    if (config.CAR_BLUR_PLATES && identification.plates.length) {
      await blurRegions(photo, identification.plates);
    }

    const { result, levelUp, progress } = withLevelUp(req.player.id, () => commitCar({
      identification, playerId: req.player.id, hoodId: hood.id, photo, caption: req.body?.caption,
    }));

    announce(req.player, result);
    broadcast('car_collected', {
      claim_id: result.repeat ? result.claim_id : result.package.claim_id,
      vehicle_id: result.vehicle.id, hood_id: hood.id, player_id: req.player.id,
      points: result.points, edition: result.repeat ? null : result.package.edition,
      repeat: result.repeat,
    });
    announceLevelUp(req.player, levelUp);

    res.status(201).json({
      repeat: result.repeat,
      package: result.package,
      points: result.points,
      xp: result.xp,
      capacity: result.capacity,
      first_sighting: result.first_sighting,
      progress,
      level_up: levelUp,
    });
  } catch (err) {
    await discardUpload(photo);
    next(err);
  }
});

/**
 * Chat is where everyone reads the game, so the message says which kind of collection it
 * was: a scoring one and a post-cap one are different events.
 */
function announce(player, result) {
  const where = hoodLabel(result.hood.id, result.hood.name);
  const name = `${result.vehicle.make} ${result.vehicle.model}`;

  if (result.repeat) {
    postMessage({
      body: `${player.display_name} spotted another ${name} in ${where} (+${result.xp.xp} XP)`,
      kind: 'system',
      meta: { event: 'sighting', claim_id: result.claim_id, vehicle_id: result.vehicle.id, hood_id: result.hood.id },
    });
    return;
  }

  const pack = result.package;
  const worth = result.points > 0
    ? `+${result.points}, ${result.capacity.spent}/${result.capacity.cap} this week`
    : `past the weekly cap — XP only, +${result.xp.xp} XP`;
  postMessage({
    body: `${player.display_name} snapped ${withArticle(name)} in ${where} (${worth})`
      + (result.first_sighting ? ' — the first one in the Garage' : '')
      + (pack.suspect ? '. The identifier is not sure this one is a real car on the street.' : '')
      + (pack.caption ? ` — "${pack.caption}"` : ''),
    kind: 'system',
    meta: { event: 'car', claim_id: pack.claim_id, vehicle_id: result.vehicle.id,
      hood_id: result.hood.id, points: result.points, suspect: pack.suspect },
  });

  // A hologram reads like the event it is.
  if (pack.edition === 'hologram' || pack.edition === 'gold') {
    const onlyOne = config.CAR_HOLOGRAM_CAP_SCOPE === 'player-season'
      ? 'Their only one this season.'
      : 'There is only one this season.';
    postMessage({
      body: pack.edition === 'hologram'
        ? `HOLOGRAM — ${player.display_name} pulled the Not Wheels hologram: ${withArticle(name)}. `
          + `${onlyOne} (+${result.xp.xp} XP)`
        : `Gold edition — ${player.display_name}'s ${name} came out gold (+${result.xp.xp} XP)`,
      kind: 'system',
      meta: { event: 'edition', edition: pack.edition, claim_id: pack.claim_id, vehicle_id: result.vehicle.id },
    });
  }
}
