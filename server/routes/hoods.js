import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { requireAuth } from '../lib/auth.js';
import { listHoods, hoodDetail, hoodHistory, shapeClaim, claimSummary } from '../lib/views.js';
import { commitClaim, evaluateClaim } from '../lib/game.js';
import { withLevelUp, announceLevelUp } from '../lib/xp-announce.js';
import { processUpload, discardUpload } from '../lib/images.js';
import { broadcast, postMessage } from '../lib/hub.js';
import { badRequest, notFound } from '../lib/errors.js';

export const hoodRoutes = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

hoodRoutes.get('/', requireAuth, (req, res) => {
  res.json({ hoods: listHoods(req.player.id) });
});

hoodRoutes.get('/:id', requireAuth, (req, res, next) => {
  const detail = hoodDetail(Number(req.params.id), req.player.id);
  if (!detail) return next(notFound('HOOD_NOT_FOUND', 'There is no Hood with that number.'));
  res.json({ hood: detail });
});

hoodRoutes.get('/:id/history', requireAuth, (req, res) => {
  res.json({ history: hoodHistory(Number(req.params.id), req.player.id) });
});

/**
 * Dry run. The client calls this when the sheet opens and again when a type is
 * picked, so a doomed claim is rejected before a 40 MB drone frame goes up the
 * tunnel (spec §6: "reject before wasting the upload").
 */
hoodRoutes.get('/:id/check', requireAuth, (req, res, next) => {
  try {
    const type = req.query.photo_type ? String(req.query.photo_type) : null;
    res.json(evaluateClaim({ hoodId: Number(req.params.id), playerId: req.player.id, declaredType: type }));
  } catch (err) { next(err); }
});

/**
 * The one endpoint behind all three actions. The server infers conquer / steal /
 * reinforce from who holds the Hood — the client never says which it meant.
 */
hoodRoutes.post('/:id/claim', requireAuth, upload.single('photo'), async (req, res, next) => {
  let photo = null;
  try {
    const hoodId = Number(req.params.id);
    const declaredType = String(req.body?.photo_type ?? req.body?.declared_type ?? '').trim();
    if (!declaredType) throw badRequest('BAD_TYPE', 'Tell us what the photo is of: landmark, person or animal.');

    // Cheap pre-check before spending CPU on sharp. commitClaim re-validates inside
    // its transaction, so this is an optimisation, not the ruling.
    const pre = evaluateClaim({ hoodId, playerId: req.player.id, declaredType });
    if (!pre.ok) {
      return res.status(409).json({
        error: pre.error, message: pre.message,
        available_at: pre.available_at, required_types: pre.required_types,
      });
    }

    photo = await processUpload(req.file);
    const { result, levelUp, progress } = withLevelUp(req.player.id, () => commitClaim({
      hoodId, playerId: req.player.id, declaredType, photo,
    }));
    const { claim, xp } = result;

    const shaped = shapeClaim(claim, req.player.id);
    // Chat is the activity feed (spec §7) — every claim announces itself.
    postMessage({
      body: claimSummary(claim),
      kind: 'system',
      meta: { event: 'claim', claim_id: claim.id, hood_id: hoodId, claim_kind: claim.claim_kind },
    });
    broadcast('claim_created', shaped);
    broadcast('hood_changed', { hood_id: hoodId });
    announceLevelUp(req.player, levelUp);

    res.status(201).json({ claim: shaped, xp, progress, level_up: levelUp });
  } catch (err) {
    await discardUpload(photo);   // never leave orphaned files behind a rejected claim
    next(err);
  }
});
