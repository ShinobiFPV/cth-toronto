// What chat says about items. Separate from lib/items.js for the same reason level-ups
// are separate from xp.js: hub.js imports views.js, which imports items.js, and routing
// the announcements through here keeps that cycle from forming.
import { db } from '../db.js';
import { config } from '../config.js';
import { postMessage } from './hub.js';
import { itemLabel } from './items.js';

/** "a Crowbar", "a Crowbar and a Recon", "a Fortify, a Clover and a Sprint". */
function listItems(items) {
  const names = items.map((i) => `a ${itemLabel(i.item_type)}`);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The tail of an edition's chat line: what the pull granted, and — plainly, never
 * silently — what it did not. Empty for a Steel, which grants nothing and says nothing.
 */
export function itemClause(grant) {
  if (!grant || grant.wanted <= 0) return '';
  if (grant.reason === 'no_points') {
    return ' — no item, because it scored no points';
  }
  if (!grant.items.length) {
    return ' — no item, this week’s item cap is full';
  }
  const held = grant.withheld > 0 ? `, and ${grant.withheld} more held back by the weekly item cap` : '';
  return ` — with ${listItems(grant.items)}${held}`;
}

const capAnnounced = (playerId, week) => !!db.prepare(`
  SELECT 1 FROM messages
   WHERE kind = 'system'
     AND json_extract(meta_json, '$.event') = 'item_cap'
     AND json_extract(meta_json, '$.player_id') = ?
     AND json_extract(meta_json, '$.week_key') = ?
   LIMIT 1`).get(playerId, week);

/**
 * Hitting the weekly item cap is announced once, the first time it withholds something in
 * a week. After that each edition line says so on its own, which is plenty.
 */
export function announceItemCap(player, grant, resetsOn) {
  if (!grant || grant.reason !== 'weekly_cap' || capAnnounced(player.id, grant.week_key)) return;
  postMessage({
    body: `${player.display_name} has hit this week’s item cap (${config.ITEM_WEEKLY_CAP}). `
      + `The cards and the XP keep coming; items are back ${resetsOn ?? 'next week'}.`,
    kind: 'system',
    meta: { event: 'item_cap', player_id: player.id, week_key: grant.week_key },
  });
}
