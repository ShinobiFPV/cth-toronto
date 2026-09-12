// A small fixed-window rate limiter for the endpoints an anonymous stranger can reach.
//
// Everything else in this app is behind a session cookie, so the only doors facing the
// open internet are login and registration. Both are expensive on purpose — argon2id
// costs about 100 ms of Pi CPU per attempt — which makes unlimited guessing both a
// password risk and a way to peg the CPU of a Raspberry Pi that is also running other
// people's services.
//
// In memory, per process. For six players that is the right amount of machinery: no
// Redis, no table, and a restart clearing the counters is a feature rather than a bug.

import { config } from '../config.js';

const buckets = new Map();

/** Drop windows that expired more than a window ago, so the map cannot grow forever. */
function sweep(now) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now - 3_600_000) buckets.delete(key);
  }
}

let lastSweep = 0;

/**
 * @param {object} options
 * @param {number} options.max      attempts allowed per window
 * @param {number} options.windowMs window length
 * @param {string} options.name     appears in the error message
 * @param {(req: object) => string[]} options.keys
 *   One or more keys to count against — an attempt is refused if ANY of them is over
 *   budget. Login counts per IP and per handle, so one IP cannot grind through a
 *   dictionary and a botnet cannot gang up on a single account either.
 */
export function rateLimit({ max, windowMs, name, keys }) {
  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep > 600_000) { sweep(now); lastSweep = now; }

    const ids = keys(req).filter(Boolean).map((k) => `${name}:${k}`);
    let worst = null;

    for (const id of ids) {
      let bucket = buckets.get(id);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(id, bucket);
      }
      bucket.count += 1;
      if (bucket.count > max && (!worst || bucket.resetAt > worst.resetAt)) worst = bucket;
    }

    if (worst) {
      const seconds = Math.max(1, Math.ceil((worst.resetAt - now) / 1000));
      res.set('Retry-After', String(seconds));
      return res.status(429).json({
        error: 'TOO_MANY_ATTEMPTS',
        message: `Too many ${name} attempts. Try again in ${
          seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`}.`,
        retry_after: seconds,
      });
    }
    return next();
  };
}

/** Clears every window. Tests only. */
export const resetRateLimits = () => buckets.clear();

const ipOf = (req) => req.ip || req.socket?.remoteAddress || 'unknown';
const handleOf = (req) => String(req.body?.handle ?? '').trim().toLowerCase() || null;

// Ten wrong passwords in fifteen minutes is already somebody who has forgotten theirs.
export const loginLimiter = rateLimit({
  max: config.LOGIN_MAX_ATTEMPTS,
  windowMs: config.LOGIN_WINDOW_MINUTES * 60_000,
  name: 'sign-in',
  keys: (req) => [ipOf(req), handleOf(req) && `handle/${handleOf(req)}`],
});

// Registration needs a valid one-time invite code, so this only exists to stop somebody
// grinding through the code space — which at 32^12 would take a while regardless.
export const registerLimiter = rateLimit({
  max: config.REGISTER_MAX_ATTEMPTS,
  windowMs: config.REGISTER_WINDOW_MINUTES * 60_000,
  name: 'sign-up',
  keys: (req) => [ipOf(req)],
});
