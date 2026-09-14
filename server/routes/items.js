// Item endpoints. The rules live in lib/items.js; Crowbar and Sprint are not here at all,
// because they are spent by the claim they open (POST /api/hoods/:id/claim, use_grant_id).
import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';
import {
  inventoryOf, itemHistory, armFortify, disarmFortify, useItem,
} from '../lib/items.js';
import { broadcast, postMessage } from '../lib/hub.js';
import { badRequest } from '../lib/errors.js';
import { config } from '../config.js';

export const itemRoutes = Router();

/** What you hold, what is armed and where, your Clover, and this week's item cap. */
itemRoutes.get('/items', requireAuth, (req, res) => {
  res.json(inventoryOf(req.player.id));
});

/** Every grant and every use, for arguments. */
itemRoutes.get('/items/history', requireAuth, (req, res) => {
  res.json(itemHistory(req.player.id));
});

// Arming and disarming are never announced and never broadcast to anybody but the owner:
// a Fortify that anybody can see is a wall, not a trap.
itemRoutes.post('/items/arm', requireAuth, (req, res, next) => {
  try {
    const hoodId = Number(req.body?.hood_id);
    if (!req.body?.grant_id || !hoodId) {
      throw badRequest('BAD_ITEM_REQUEST', 'Say which Fortify, and which Hood.');
    }
    const armed = armFortify({ playerId: req.player.id, grantId: req.body.grant_id, hoodId });
    broadcast('items_changed', { player_id: req.player.id });
    res.json({ armed, inventory: inventoryOf(req.player.id) });
  } catch (err) { next(err); }
});

itemRoutes.post('/items/disarm', requireAuth, (req, res, next) => {
  try {
    const hoodId = Number(req.body?.hood_id);
    if (!hoodId) throw badRequest('BAD_ITEM_REQUEST', 'Say which Hood.');
    const disarmed = disarmFortify({ playerId: req.player.id, hoodId });
    broadcast('items_changed', { player_id: req.player.id });
    res.json({ disarmed, inventory: inventoryOf(req.player.id) });
  } catch (err) { next(err); }
});

/** Recon, Tune-Up or Clover. */
itemRoutes.post('/items/use', requireAuth, (req, res, next) => {
  try {
    if (!req.body?.grant_id) throw badRequest('BAD_ITEM_REQUEST', 'Say which item.');
    const targetHoodId = req.body?.target_hood_id == null ? null : Number(req.body.target_hood_id);
    const result = useItem({ playerId: req.player.id, grantId: req.body.grant_id, targetHoodId });

    // Clover and Tune-Up touch nobody else, so they are worth a line in chat. Recon is
    // not announced: it is intelligence, and announcing it would tip off the defender.
    if (result.item_type === 'clover') {
      postMessage({
        body: `${req.player.display_name} popped a Clover — double Gold and Hologram odds for `
          + `${config.CLOVER_HOURS} hours.`,
        kind: 'system',
        meta: { event: 'item_use', item_type: 'clover', player_id: req.player.id, expires_at: result.expires_at },
      });
    } else if (result.item_type === 'tuneup') {
      postMessage({
        body: `${req.player.display_name} tuned up ${result.hood_label} — it can be reinforced now.`,
        kind: 'system',
        meta: { event: 'item_use', item_type: 'tuneup', player_id: req.player.id, hood_id: result.hood_id },
      });
      broadcast('hood_changed', { hood_id: result.hood_id });
    }

    broadcast('items_changed', { player_id: req.player.id });
    res.json({ result, inventory: inventoryOf(req.player.id) });
  } catch (err) { next(err); }
});
