// How long until something, in the words every gate message uses. Its own module because
// both the claim state machine and the items module need it, and items.js cannot import
// game.js without making a cycle of the two.

/** "14h", "3h 20m", "4m", "2d 6h" — used in every gate message and on the map sheet. */
export function humanUntil(fromIso, toIso) {
  const ms = new Date(toIso) - new Date(fromIso);
  if (ms <= 0) return 'now';
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}
