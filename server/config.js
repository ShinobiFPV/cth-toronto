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
  //
  // Six, not the 24 it launched with: a day meant that walking two adjacent Hoods in an
  // afternoon was impossible, which punished the people the rule was never aimed at.
  // Six still stops a single drone flight becoming a contiguous block, and leaves the
  // neighbour open by the evening.
  ADJACENT_CONQUER_COOLDOWN_HOURS: num('CTH_ADJACENT_CONQUER_COOLDOWN_HOURS', 6),
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

  // Special editions (spec §1.8b). A card's *rarity* comes from the park's value and is
  // knowable before you set out; its *edition* is luck, rolled when the photo lands.
  // Percentages of one draw. Steel is not configured: it is whatever remains, so the
  // table can never sum to anything but 100. About one pull in seven is special, and no
  // edition is capped anywhere — scarcity of *power* lives in the item cap below instead.
  EDITION_HOLOGRAM_PCT: num('CTH_EDITION_HOLOGRAM_PCT', 2),
  EDITION_GOLD_PCT: num('CTH_EDITION_GOLD_PCT', 12),

  // ── Parks (spec §1.8) ──────────────────────────────────────────────────
  // Park points per player per Hood, per period. Past it a collection still prints its
  // card, rolls its edition and pays XP, worth 0 points and no item. 0 = uncapped.
  // 'week' paces a park-dense Hood; 'season' removes the advantage of living in one.
  PARK_HOOD_CAP: num('CTH_PARK_HOOD_CAP', 300),
  PARK_CAP_PERIOD: process.env.CTH_PARK_CAP_PERIOD === 'season' ? 'season' : 'week',

  // ── Items (spec §1.8d) ─────────────────────────────────────────────────
  // Gold and Hologram pulls grant consumables. The weekly cap is the number that decides
  // whether Fortify is an event or a tax — the one lever here worth revisiting first.
  ITEM_WEEKLY_CAP: num('CTH_ITEM_WEEKLY_CAP', 4),
  ITEMS_PER_GOLD: num('CTH_ITEMS_PER_GOLD', 1),
  ITEMS_PER_HOLOGRAM: num('CTH_ITEMS_PER_HOLOGRAM', 3),
  // Relative weights for which item a grant is. Fortify is the only item that denies
  // somebody else points, so it is rarest; Clover touches nobody, so it is commonest.
  ITEM_WEIGHTS: {
    fortify: num('CTH_ITEM_WEIGHT_FORTIFY', 10),
    recon: num('CTH_ITEM_WEIGHT_RECON', 20),
    crowbar: num('CTH_ITEM_WEIGHT_CROWBAR', 15),
    sprint: num('CTH_ITEM_WEIGHT_SPRINT', 20),
    tuneup: num('CTH_ITEM_WEIGHT_TUNEUP', 15),
    clover: num('CTH_ITEM_WEIGHT_CLOVER', 20),
  },
  CLOVER_HOURS: num('CTH_CLOVER_HOURS', 6),
  CLOVER_MULTIPLIER: num('CTH_CLOVER_MULTIPLIER', 2),
  // A steal that walks into a Fortify locks that attacker out of that Hood for this long.
  FORTIFY_COOLDOWN_HOURS: num('CTH_FORTIFY_COOLDOWN_HOURS', 1),

  // The week every weekly cap counts in — cars, parks, items. MO | TU | … | SU, in
  // CTH_TZ. Monday means Sunday night is the scramble. CTH_CAR_WEEK_START is the name it
  // had when only the Garage had a week, and still works.
  WEEK_START: (process.env.CTH_WEEK_START || process.env.CTH_CAR_WEEK_START || 'MO').toUpperCase(),

  // ── The Garage (spec §1.8c) ────────────────────────────────────────────
  // Photograph a car, the Pi asks Claude what it is, and prints a Not Wheels package.
  // A flat value with a weekly cap, so points_awarded is knowable at claim time and
  // frozen like every other claim — nothing about scoring reads outside the ledger.
  CAR_POINTS: num('CTH_CAR_POINTS', 5),
  // Per player, per calendar week. Past it a car still mints, rolls and pays XP; it is
  // worth 0 points, which is a success rather than an error.
  CAR_WEEKLY_CAP: num('CTH_CAR_WEEKLY_CAP', 100),
  // XP by edition. Every package is at least Steel — plain stock is what going outside
  // and snapping a car is worth, and it is set to feel like a park collection's worth.
  CAR_XP_STEEL: num('CTH_CAR_XP_STEEL', 25),
  CAR_XP_GOLD: num('CTH_CAR_XP_GOLD', 75),
  CAR_XP_HOLOGRAM: num('CTH_CAR_XP_HOLOGRAM', 250),
  // XP for photographing a car you already have this season, at most once per vehicle
  // per week. 0 = a repeat is ALREADY_COLLECTED and mints nothing at all.
  CAR_REPEAT_XP: num('CTH_CAR_REPEAT_XP', 0),
  // Blur licence plates in the display and thumbnail derivatives. A park sign is
  // nobody's; a plate is traceable to a person. The original, behind the login and kept
  // for disputes, is left untouched.
  CAR_BLUR_PLATES: bool('CTH_CAR_BLUR_PLATES', true),

  // The vision call. The key is read from the environment and never written down —
  // this repo is public.
  IDENTIFY_ENABLED: bool('CTH_IDENTIFY_ENABLED', true),
  IDENTIFY_API_KEY: process.env.CTH_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '',
  IDENTIFY_MODEL: process.env.CTH_IDENTIFY_MODEL || 'claude-opus-5',
  IDENTIFY_TIMEOUT_MS: num('CTH_IDENTIFY_TIMEOUT_MS', 45_000),
  IDENTIFY_MIN_CONFIDENCE: num('CTH_IDENTIFY_MIN_CONFIDENCE', 0.5),

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
