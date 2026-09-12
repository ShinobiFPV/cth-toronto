// Central configuration. Everything tunable lives here so the game levers named in
// the spec's "Open decisions" can be turned without hunting through logic.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// .env is optional; a plain KEY=value file, no dependency needed.
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^["'](.*)["']$/, '$1');
    }
  }
}

const num = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got ${JSON.stringify(v)}`);
  return n;
};
const bool = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
};

export const config = {
  port: num('CTH_PORT', 8096),
  host: process.env.CTH_HOST || '0.0.0.0',
  isProd: process.env.NODE_ENV === 'production',

  dbPath: process.env.CTH_DB || path.join(ROOT, 'data', 'cth.sqlite'),
  mediaDir: process.env.CTH_MEDIA || path.join(ROOT, 'data', 'media'),
  webDist: process.env.CTH_WEB_DIST || path.join(ROOT, 'web', 'dist'),
  publicDir: path.join(ROOT, 'web', 'public'),

  // Auth
  jwtSecret: process.env.CTH_JWT_SECRET || '',
  sessionDays: num('CTH_SESSION_DAYS', 30),
  cookieName: 'cth_token',
  cookieSecure: bool('CTH_COOKIE_SECURE', process.env.NODE_ENV === 'production'),

  // ── Game levers (spec §1, §10) ─────────────────────────────────────────
  // Stealing pays the Hood's difficulty score times this, so 10-100 across the city.
  // Aggression is always worth about double picking up the same Hood unclaimed, and
  // the ceiling lands on exactly 100 — what a steal was worth when it was a flat rate.
  STEAL_MULTIPLIER: num('CTH_STEAL_MULTIPLIER', 2),
  REINFORCE_POINTS: num('CTH_REINFORCE_POINTS', 25),   // flat forever, never escalates
  // Fallback difficulty for a Hood with no score of its own. Real scores are 5-50 and
  // come from scripts/lib/difficulty.js.
  BASE_UNCLAIMED_VALUE: num('CTH_BASE_UNCLAIMED_VALUE', 25),
  ESCALATION_STEP: num('CTH_ESCALATION_STEP', 25),
  // null = uncapped. Spec §10 floats capping untouched Hoods at 75 instead of 100.
  ESCALATION_CAP: process.env.CTH_ESCALATION_CAP ? num('CTH_ESCALATION_CAP', 0) : null,
  REINFORCE_GATE_HOURS: num('CTH_REINFORCE_GATE_HOURS', 72),
  STEAL_COOLDOWN_HOURS: num('CTH_STEAL_COOLDOWN_HOURS', 12),
  // After conquering an unclaimed Hood, that player cannot conquer any Hood bordering
  // it for this long. Aimed squarely at the drone advantage: one flight should not hand
  // somebody a whole contiguous block of the city. Steals and reinforces are untouched,
  // and it is per-player — anyone else can still take the neighbour. 0 disables it.
  ADJACENT_CONQUER_COOLDOWN_HOURS: num('CTH_ADJACENT_CONQUER_COOLDOWN_HOURS', 24),
  // Per-season cap on reinforce points per player, 0 = uncapped (spec §10 lever).
  REINFORCE_SEASON_CAP: num('CTH_REINFORCE_SEASON_CAP', 0),

  // Anonymous-facing rate limits. Only login and registration are reachable without
  // a session, and argon2id makes each attempt cost real Pi CPU.
  LOGIN_MAX_ATTEMPTS: num('CTH_LOGIN_MAX_ATTEMPTS', 10),
  LOGIN_WINDOW_MINUTES: num('CTH_LOGIN_WINDOW_MINUTES', 15),
  REGISTER_MAX_ATTEMPTS: num('CTH_REGISTER_MAX_ATTEMPTS', 10),
  REGISTER_WINDOW_MINUTES: num('CTH_REGISTER_WINDOW_MINUTES', 60),

  // Disputes (spec §1.7 / §10)
  FLAG_THRESHOLD: num('CTH_FLAG_THRESHOLD', 2),
  // §10: "consider requiring the flaggers to be neither the claimant nor the
  // displaced holder, so a grudge pair can't revert at will." Off by default —
  // §1.7's stated rule is "2 or more other players" — but one env var away.
  FLAG_EXCLUDE_DISPLACED: bool('CTH_FLAG_EXCLUDE_DISPLACED', false),

  // Uploads
  maxUploadBytes: num('CTH_MAX_UPLOAD_MB', 60) * 1024 * 1024,
  // A caption is flavour, not an essay. Long enough for a joke about the raccoon,
  // short enough to sit under a thumbnail and on a park card without reflowing it.
  CAPTION_MAX_LENGTH: num('CTH_CAPTION_MAX_LENGTH', 200),
  // sharp on the Pi usually ships without an HEIC decoder; heic-convert is the
  // fallback. Set false to reject HEIC outright with a "use Most Compatible" message.
  heicServerFallback: bool('CTH_HEIC_SERVER_FALLBACK', true),
  readExif: bool('CTH_READ_EXIF', true),

  timezone: process.env.CTH_TZ || 'America/Toronto',
};

if (!config.jwtSecret) {
  if (config.isProd) {
    throw new Error('CTH_JWT_SECRET must be set in production (see .env.example)');
  }
  config.jwtSecret = 'dev-only-insecure-secret-change-me';
  console.warn('[cth] CTH_JWT_SECRET unset — using an insecure development secret.');
}

// Player colours. High-contrast on the dark map, deliberately avoiding the amber
// UI accent so chrome never reads as somebody's territory.
export const PLAYER_COLOURS = [
  '#FF4D4D', // crimson
  '#35C4FF', // azure
  '#A970FF', // violet
  '#3FD66A', // green
  '#FF7BC0', // pink
  '#00E5C0', // teal
  '#FF8A3D', // ember
  '#C9D400', // acid
];

// What the photo is OF, not what took it. Any camera is fair game — phone, drone,
// SLR, disposable — the counter layer reads subject matter instead.
//   landmark  a building, a monument, a street, a local business storefront
//   person    a selfie, a friend, a stranger who said yes
//   animal    anything with a pulse that is not a person
export const PHOTO_TYPES = ['landmark', 'person', 'animal'];

// animal > person > landmark > animal
export const BEATS = { animal: 'person', person: 'landmark', landmark: 'animal' };
export const BEATEN_BY = { person: 'animal', landmark: 'person', animal: 'landmark' };

export const beats = (a, b) => BEATS[a] === b;
