// Flags and reversal — the game's only enforcement mechanism (spec §1.7).
import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../lib/auth.js';
import { revertClaim } from '../lib/game.js';
import { setCaption } from '../lib/captions.js';
import { shapeClaim } from '../lib/views.js';
import { broadcast, postMessage } from '../lib/hub.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';
import { hoodLabel } from '../lib/hood-seed.js';

export const claimRoutes = Router();

const fullClaim = (id) => db.prepare(`
  SELECT c.*, p.handle, p.display_name, p.colour,
         b.handle AS beaten_handle, b.display_name AS beaten_name,
         ph.path_thumb, ph.path_display, ph.exif_json, ph.caption,
         h.name AS hood_name,
         pk.name AS park_name, pk.value AS park_value,
         veh.make AS vehicle_make, veh.model AS vehicle_model
    FROM claims c
    JOIN players p ON p.id = c.player_id
    JOIN hoods   h ON h.id = c.hood_id
LEFT JOIN players b ON b.id = c.beaten_player_id
LEFT JOIN photos ph ON ph.id = c.photo_id
LEFT JOIN parks  pk ON pk.id = c.park_id
LEFT JOIN vehicles veh ON veh.id = c.vehicle_id
   WHERE c.id = ?`).get(id);

claimRoutes.get('/:id', requireAuth, (req, res, next) => {
  const claim = fullClaim(Number(req.params.id));
  if (!claim) return next(notFound('CLAIM_NOT_FOUND', 'No such claim.'));
  res.json({
    claim: shapeClaim(claim, req.player.id),
    flags: db.prepare(`
      SELECT f.id, f.reason, f.created_at, p.handle, p.display_name, p.colour
        FROM flags f JOIN players p ON p.id = f.player_id
       WHERE f.claim_id = ? ORDER BY f.id`).all(claim.id),
  });
});

/**
 * Write or clear the caption on your own photo. A caption is flavour, so this is the one
 * thing in the game a player can change after the fact — and even here nothing in the
 * ledger moves: the write lands on `photos`, not on the claim.
 *
 * Allowed on a superseded or reverted claim too. The photo is still yours and still in
 * the feed, so being able to fix a typo on it does not depend on still holding the Hood.
 */
claimRoutes.put('/:id/caption', requireAuth, (req, res, next) => {
  try {
    const claimId = Number(req.params.id);
    const caption = setCaption({ claimId, playerId: req.player.id, caption: req.body?.caption });
    // No chat post: the claim already announced itself, and an edit is not an event.
    // The feed does need to catch up, though.
    broadcast('caption_changed', { claim_id: claimId, caption });
    res.json({ claim: shapeClaim(fullClaim(claimId), req.player.id), caption });
  } catch (err) { next(err); }
});

claimRoutes.post('/:id/flag', requireAuth, (req, res, next) => {
  try {
    const claimId = Number(req.params.id);
    const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
    if (!claim) throw notFound('CLAIM_NOT_FOUND', 'No such claim.');
    if (claim.claim_kind === 'reversal') throw badRequest('NOT_FLAGGABLE', 'You cannot flag a reversal.');
    if (claim.status !== 'active') {
      throw badRequest('NOT_FLAGGABLE', 'That claim is no longer standing.');
    }
    if (claim.player_id === req.player.id) {
      throw forbidden('OWN_CLAIM', 'You cannot flag your own claim.');
    }
    // Spec §10's optional guard against a grudge pair reverting at will. Off by default.
    if (config.FLAG_EXCLUDE_DISPLACED && claim.beaten_player_id === req.player.id) {
      throw forbidden('DISPLACED_HOLDER',
        'You lost this Hood, so your flag does not count. Ask someone else to look.');
    }

    const reason = String(req.body?.reason ?? '').trim().slice(0, 500);

    const result = db.transaction(() => {
      const inserted = db.prepare(`
        INSERT INTO flags (claim_id, player_id, reason, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(claim_id, player_id) DO NOTHING`)
        .run(claimId, req.player.id, reason || null, nowIso());
      if (inserted.changes === 0) return { duplicate: true };

      const count = db.prepare('SELECT COUNT(*) AS c FROM flags WHERE claim_id = ?').get(claimId).c;
      db.prepare('UPDATE claims SET flag_count = ? WHERE id = ?').run(count, claimId);
      return { count, reverted: count >= config.FLAG_THRESHOLD };
    })();

    if (result.duplicate) throw badRequest('ALREADY_FLAGGED', 'You have already flagged this claim.');

    // Name the park for a Parkemans claim: "flagged Alice's claim on Hood 25" tells
    // nobody which of its 68 parks is in dispute.
    const hood = hoodLabel(claim.hood_id,
      db.prepare('SELECT name FROM hoods WHERE id = ?').get(claim.hood_id).name);
    const park = claim.park_id
      ? db.prepare('SELECT name FROM parks WHERE id = ?').get(claim.park_id)
      : null;
    // And the car for a Garage claim, for the same reason.
    const car = claim.vehicle_id
      ? db.prepare("SELECT make || ' ' || model AS name FROM vehicles WHERE id = ?").get(claim.vehicle_id)
      : null;
    const label = park ? `${park.name} (${hood})` : car ? `the ${car.name} (${hood})` : hood;
    const claimant = db.prepare('SELECT display_name FROM players WHERE id = ?').get(claim.player_id);

    // Flags go to chat: the spec is explicit that a visible first flag is most of
    // what makes the honour system work.
    postMessage({
      body: `${req.player.display_name} flagged ${claimant.display_name}'s claim on ${label}`
        + (reason ? ` — "${reason}"` : '')
        + ` (${result.count}/${config.FLAG_THRESHOLD})`,
      kind: 'system',
      meta: { event: 'flag', claim_id: claimId, hood_id: claim.hood_id, count: result.count },
    });

    let reversal = null;
    if (result.reverted) {
      reversal = revertClaim(claimId, { reason });
      postMessage({
        body: `${claimant.display_name}'s claim on ${label} was reverted by ${result.count} flags.`
          + (reversal.wasLive
            ? (reversal.restoredOwnerId
                ? ` ${label} goes back to its previous holder.`
                : ` ${label} is unclaimed again.`)
            : ''),
        kind: 'system',
        meta: { event: 'reversal', claim_id: claimId, hood_id: claim.hood_id },
      });
      broadcast('claim_reverted', { claim_id: claimId, hood_id: claim.hood_id });
      broadcast('hood_changed', { hood_id: claim.hood_id });
    }

    broadcast('flag_added', { claim_id: claimId, count: result.count, reverted: !!result.reverted });
    res.json({
      claim: shapeClaim(fullClaim(claimId), req.player.id),
      flag_count: result.count,
      threshold: config.FLAG_THRESHOLD,
      reverted: !!result.reverted,
    });
  } catch (err) { next(err); }
});

claimRoutes.delete('/:id/flag', requireAuth, (req, res, next) => {
  try {
    const claimId = Number(req.params.id);
    const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
    if (!claim) throw notFound('CLAIM_NOT_FOUND', 'No such claim.');
    // A reverted claim stays reverted. Withdrawing is for changing your mind before
    // the threshold lands, not for undoing a reversal by consensus-of-one.
    if (claim.status === 'reverted') {
      throw badRequest('ALREADY_REVERTED',
        'That claim has already been reverted — withdrawing a flag will not bring it back.');
    }

    const count = db.transaction(() => {
      const del = db.prepare('DELETE FROM flags WHERE claim_id = ? AND player_id = ?')
        .run(claimId, req.player.id);
      if (del.changes === 0) return null;
      const c = db.prepare('SELECT COUNT(*) AS c FROM flags WHERE claim_id = ?').get(claimId).c;
      db.prepare('UPDATE claims SET flag_count = ? WHERE id = ?').run(c, claimId);
      return c;
    })();

    if (count === null) throw badRequest('NOT_FLAGGED', 'You have not flagged that claim.');

    broadcast('flag_added', { claim_id: claimId, count, reverted: false });
    res.json({ claim: shapeClaim(fullClaim(claimId), req.player.id), flag_count: count });
  } catch (err) { next(err); }
});
