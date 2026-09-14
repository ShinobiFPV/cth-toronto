// Sound endpoints. Every player reads the manifest; only the admin swaps what is in it.
// See lib/audio.js for how a slot resolves and why every URL carries a hash.
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { requireAuth, requireAdmin } from '../lib/auth.js';
import {
  publicManifest, listSlots, uploadSlot, setSlotMeta, resetSlot, audioLimits, readManifest,
} from '../lib/audio.js';
import { broadcast } from '../lib/hub.js';
import { badRequest } from '../lib/errors.js';

export const audioRoutes = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.AUDIO_MAX_UPLOAD_MB * 1048576, files: 1 },
});
// multer's own size error says nothing a player can act on, and the global handler would
// call it a photo. This one names the limit.
const oneFile = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return next(badRequest('AUDIO_TOO_BIG', `That file is over the ${config.AUDIO_MAX_UPLOAD_MB} MB limit.`));
  }
  return next(err);
});

/** Every slot's URL and gain. Fetched network-first; never cached by anything in between. */
audioRoutes.get('/audio/manifest', requireAuth, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicManifest());
});

// ── the admin sound board ─────────────────────────────────────────────────

const changed = () => broadcast('audio_changed', { version: publicManifest().version });

audioRoutes.get('/admin/audio', requireAdmin, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ version: readManifest().version, limits: audioLimits(), slots: listSlots() });
});

audioRoutes.post('/admin/audio/:slot', requireAdmin, oneFile, async (req, res, next) => {
  try {
    const slot = await uploadSlot({
      key: req.params.slot, buffer: req.file?.buffer, licence: req.body?.licence, playerId: req.player.id,
    });
    changed();
    res.status(201).json({ slot });
  } catch (err) { next(err); }
});

audioRoutes.patch('/admin/audio/:slot', requireAdmin, (req, res, next) => {
  try {
    const slot = setSlotMeta(req.params.slot, { gain: req.body?.gain, licence: req.body?.licence });
    changed();
    res.json({ slot });
  } catch (err) { next(err); }
});

audioRoutes.delete('/admin/audio/:slot', requireAdmin, (req, res, next) => {
  try {
    const slot = resetSlot(req.params.slot);
    changed();
    res.json({ slot });
  } catch (err) { next(err); }
});
