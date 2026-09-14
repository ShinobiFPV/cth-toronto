import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { requireAuth } from '../lib/auth.js';
import { listHoods, hoodDetail, hoodHistory, shapeClaim, claimSummary } from '../lib/views.js';
import { commitClaim, evaluateClaim, CLAIM_ITEMS } from '../lib/game.js';
import { withLevelUp, announceLevelUp } from '../lib/xp-announce.js';
import { processUpload, discardUpload } from '../lib/images.js';
import { broadcast, postMessage } from '../lib/hub.js';
import { badRequest, notFound } from '../lib/errors.js';
import { heldGrant } from '../lib/items.js';
import { hoodLabel } from '../lib/hood-seed.js';
import { db } from '../db.js';

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
 *
 * `use_grant_id` brings a Crowbar or a Sprint along. It is spent inside the claim's own
 * transaction and only if the claim lands, so a claim that fails validation costs nothing.
 */
hoodRoutes.post('/:id/claim', requireAuth, upload.single('photo'), async (req, res, next) => {
  let photo = null;
  try {
    const hoodId = Number(req.params.id);
    const declaredType = String(req.body?.photo_type ?? req.body?.declared_type ?? '').trim();
    if (!declaredType) throw badRequest('BAD_TYPE', 'Tell us what the photo is of: landmark, person or animal.');
    const useGrantId = req.body?.use_grant_id ? Number(req.body.use_grant_id) : null;

    // Cheap pre-check before spending CPU on sharp. commitClaim re-validates inside
    // its transaction, so this is an optimisation, not the ruling.
    const bypass = useGrantId
      ? (CLAIM_ITEMS[heldGrant(req.player.id, useGrantId).item_type] ?? {})
      : {};
    const pre = evaluateClaim({ hoodId, playerId: req.player.id, declaredType, bypass });
    if (!pre.ok) {
      return res.status(409).json({
        error: pre.error, message: pre.message,
        available_at: pre.available_at, required_types: pre.required_types,
        bypassable_with: pre.bypassable_with ?? null,
      });
    }

    photo = await processUpload(req.file);
    const { result, levelUp, progress } = withLevelUp(req.player.id, () => commitClaim({
      hoodId, playerId: req.player.id, declaredType, photo, caption: req.body?.caption, useGrantId,
    }));

    // Walked into a Fortify. It committed — the Fortify is spent and the photo kept — so
    // the files stay on disk. Chat names the defender and the Hood, never the subject the
    // attacker brought; whether to admit that is up to them.
    if (result.blocked) {
      const label = hoodLabel(result.hood.id, result.hood.name);
      const defender = db.prepare('SELECT display_name FROM players WHERE id = ?')
        .get(result.fortify.defender_id);
      postMessage({
        body: `${req.player.display_name} tried to steal ${label} from ${defender.display_name} `
          + 'and walked straight into a Fortify. The Hood holds.',
        kind: 'system',
        meta: { event: 'fortify', hood_id: hoodId, defender_id: result.fortify.defender_id, attacker_id: req.player.id },
      });
      broadcast('items_changed', { player_id: result.fortify.defender_id });
      // So the defender's phone can play the sound for it. Carries no subject.
      broadcast('fortify_triggered', {
        hood_id: hoodId, defender_id: result.fortify.defender_id, attacker_id: req.player.id,
      });
      broadcast('hood_changed', { hood_id: hoodId });
      return res.status(409).json({
        error: 'FORTIFY_COOLDOWN',
        fortified: true,
        message: result.message,
        available_at: result.fortify.available_at,
      });
    }

    const { claim, xp } = result;

    const shaped = shapeClaim(claim, req.player.id);
    // Chat is the activity feed (spec §7) — every claim announces itself, and so does
    // the item that opened it.
    postMessage({
      body: claimSummary(claim) + (result.item_used ? ` — with a ${result.item_used.label}` : ''),
      kind: 'system',
      meta: {
        event: 'claim', claim_id: claim.id, hood_id: hoodId, claim_kind: claim.claim_kind,
        item_used: result.item_used?.item_type ?? null,
      },
    });
    broadcast('claim_created', shaped);
    broadcast('hood_changed', { hood_id: hoodId });
    if (result.item_used) broadcast('items_changed', { player_id: req.player.id });
    announceLevelUp(req.player, levelUp);

    res.status(201).json({
      claim: shaped, xp, progress, level_up: levelUp,
      item_used: result.item_used, item_kept: result.item_kept,
    });
  } catch (err) {
    await discardUpload(photo);   // never leave orphaned files behind a rejected claim
    next(err);
  }
});
