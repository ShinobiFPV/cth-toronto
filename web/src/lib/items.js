// The client's names for items. The server carries the full descriptions (GET /items
// returns a catalogue with the configured numbers in it); these are just the labels and
// the order the bag lists them in.

export const ITEM_ORDER = ['fortify', 'recon', 'crowbar', 'sprint', 'tuneup', 'clover'];

export const ITEM_LABEL = {
  fortify: 'Fortify',
  recon: 'Recon',
  crowbar: 'Crowbar',
  sprint: 'Sprint',
  tuneup: 'Tune-Up',
  clover: 'Clover',
};

/** What the Hood sheet says when it offers an item at the gate that item opens. */
export const BYPASS_BLURB = {
  crowbar: 'A Crowbar gets you through the lock. Spent only if the steal lands.',
  sprint: 'A Sprint gets you past the cooldown. Spent only if the conquer lands.',
  tuneup: 'A Tune-Up opens the reinforce gate right now.',
};

/** "2 Fortify, 1 Clover" — for a withheld or granted list in a result line. */
export const itemList = (items = []) => items.map((i) => ITEM_LABEL[i.item_type] ?? i.item_type).join(', ');

/** Why a special pull came with nothing, in the words the sheet uses. */
export function withheldText(grant) {
  if (!grant || !grant.withheld) return null;
  if (grant.reason === 'no_points') return 'No item — it scored no points.';
  return grant.items?.length
    ? `${grant.withheld} more held back by this week’s item cap.`
    : 'No item — this week’s item cap is full.';
}
