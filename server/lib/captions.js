// Captions: the one piece of player-authored prose in the game.
//
// Every photo can carry one line about itself, written at upload time or added later.
// It is flavour — it never affects points, XP, ownership, or anything the state machine
// looks at — which is exactly why it lives on `photos` rather than on `claims`. The
// ledger is append-only and only ever UPDATEs `status` and `flag_count`; a caption you
// can fix a typo in has no business in there.
//
// Everything a caption touches is rendered by React or written into a chat message as
// text, so escaping is not this module's job. Shape is: collapse the whitespace, cap the
// length, and turn empty into null so "no caption" is one value and not three.
import { db } from '../db.js';
import { config } from '../config.js';
import { badRequest, forbidden, notFound } from './errors.js';

/**
 * Normalise a caption on its way in.
 *
 * Newlines are collapsed rather than kept: a caption is rendered inline next to a
 * thumbnail and in a single-line chat message, so a player who pastes three paragraphs
 * would otherwise reflow the feed for everybody. Returns null for anything that is
 * empty once trimmed, so the column is null-or-content and never an empty string.
 */
export function cleanCaption(raw) {
  if (raw == null) return null;
  const collapsed = String(raw).replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  // Slice, then trim again: cutting mid-sentence can leave a trailing space.
  return collapsed.slice(0, config.CAPTION_MAX_LENGTH).trim() || null;
}

/**
 * Rewrite the caption on the photo behind a claim. Owner only.
 *
 * Deliberately allowed after the fact, and deliberately allowed on a claim that has
 * since been superseded or reverted: the photo is still yours and still in the feed.
 * What it cannot do is create a caption where there is no photo — a reversal row has
 * no photo_id, so there is nothing to caption.
 */
export function setCaption({ claimId, playerId, caption }) {
  const claim = db.prepare('SELECT id, player_id, photo_id FROM claims WHERE id = ?').get(claimId);
  if (!claim) throw notFound('CLAIM_NOT_FOUND', 'No such claim.');
  if (claim.player_id !== playerId) {
    throw forbidden('NOT_YOUR_CLAIM', 'You can only caption your own photos.');
  }
  if (!claim.photo_id) {
    throw badRequest('NO_PHOTO', 'There is no photo on that claim to caption.');
  }
  const cleaned = cleanCaption(caption);
  db.prepare('UPDATE photos SET caption = ? WHERE id = ?').run(cleaned, claim.photo_id);
  return cleaned;
}
