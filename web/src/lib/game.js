// The client's copy of the counter rule. The server is the authority — it re-checks
// everything inside the claim transaction — but the sheet has to be able to say
// "needs an animal photo" before the file picker opens, which means knowing the cycle.

export const SUBJECTS = ['landmark', 'person', 'animal'];

export const BEATS = { animal: 'person', person: 'landmark', landmark: 'animal' };
export const BEATEN_BY = { person: 'animal', landmark: 'person', animal: 'landmark' };

export const SUBJECT_BLURB = {
  landmark: 'A building, monument, street or local business',
  person: 'A selfie, a friend, a willing stranger',
  animal: 'Anything with a pulse that is not a person',
};

export const article = (s) => `${s === 'animal' ? 'an' : 'a'} ${s}`;

/**
 * Error codes the claim endpoint can return, mapped to how the sheet should feel about
 * them. A time gate is information; a wrong subject is a mistake.
 */
export const GATE_CODES = new Set([
  'HOOD_LOCKED', 'REINFORCE_TOO_SOON', 'ADJACENT_COOLDOWN', 'REINFORCE_CAP_REACHED',
]);

/**
 * A Hood's difficulty score in words. The number is the thing players will argue
 * about, so it gets a label they can repeat back at each other.
 */
export function difficultyBand(score) {
  if (score >= 40) return 'brutal';
  if (score >= 30) return 'hard';
  if (score >= 20) return 'a trek';
  if (score >= 12) return 'moderate';
  return 'easy';
}

export const KIND_VERB = {
  conquer: 'Conquer',
  steal: 'Steal',
  reinforce: 'Reinforce',
  reversal: 'Reverted',
};

/** Human countdown, matching the server's phrasing so the two never disagree. */
export function until(iso, from = Date.now()) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - from;
  if (ms <= 0) return 'now';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** "4m ago", "3h ago", "Tue 14:02" once it stops being interesting. */
export function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

export const clock = (iso) =>
  new Date(iso).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false });

/** Unclaimed Hoods are neutral grey; held ones wear their owner's colour. */
export const hoodColour = (hood) => hood.owner?.colour ?? '#5A646F';
