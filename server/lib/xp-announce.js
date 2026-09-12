// Posting a level-up to chat lives here rather than in xp.js, because xp.js is imported
// by game.js and hub.js imports views.js — routing the announcement through a separate
// module keeps that cycle from forming.
import { postMessage, broadcast } from './hub.js';

export { withLevelUp } from './xp.js';

/** Tell everyone. A level-up is the one piece of progress worth interrupting chat for. */
export function announceLevelUp(player, levelUp) {
  if (!levelUp) return;
  postMessage({
    body: `${player.display_name} reached level ${levelUp.to} — ${levelUp.title}`
      + ` (${levelUp.xp.toLocaleString('en-CA')} XP)`,
    kind: 'system',
    meta: { event: 'level_up', player_id: player.id, level: levelUp.to, title: levelUp.title },
  });
  broadcast('level_up', { player_id: player.id, ...levelUp });
}
