import { db } from '../db.js';

/** The season containing `at` (default now), or null outside the four-season run. */
export function activeSeason(at = new Date().toISOString()) {
  return db.prepare(
    'SELECT * FROM seasons WHERE starts_at <= ? AND ends_at > ? ORDER BY id LIMIT 1'
  ).get(at, at) ?? null;
}

export function allSeasons() {
  return db.prepare('SELECT * FROM seasons ORDER BY id').all();
}

/** The season a not-yet-started game is waiting for, if any. */
export function nextSeason(at = new Date().toISOString()) {
  return db.prepare('SELECT * FROM seasons WHERE starts_at > ? ORDER BY id LIMIT 1').get(at) ?? null;
}
