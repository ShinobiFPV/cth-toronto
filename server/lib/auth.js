// Invite-code registration, argon2id passwords, JWT in an httpOnly cookie.
import crypto from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { db, nowIso } from '../db.js';
import { config, PLAYER_COLOURS } from '../config.js';
import { GameError, badRequest, forbidden, unauthorized } from './errors.js';

const HANDLE_RE = /^[a-z0-9][a-z0-9_.-]{1,23}$/i;

export const hashPassword = (plain) => argon2.hash(plain, { type: argon2.argon2id });
export const verifyPassword = (hash, plain) => argon2.verify(hash, plain);

export function signToken(player) {
  return jwt.sign({ sub: player.id, handle: player.handle }, config.jwtSecret, {
    expiresIn: `${config.sessionDays}d`,
  });
}

export function setAuthCookie(res, player) {
  res.cookie(config.cookieName, signToken(player), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: config.sessionDays * 86_400_000,
    path: '/',
  });
}

export const clearAuthCookie = (res) => res.clearCookie(config.cookieName, { path: '/' });

/** Resolve a raw cookie-jar token to a player row, or null. Used by HTTP and by /ws. */
export function playerFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return db.prepare('SELECT * FROM players WHERE id = ?').get(payload.sub) ?? null;
  } catch {
    return null;
  }
}

export function attachPlayer(req, _res, next) {
  req.player = playerFromToken(req.cookies?.[config.cookieName]);
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.player) return next(unauthorized());
  next();
}

export function requireAdmin(req, _res, next) {
  if (!req.player) return next(unauthorized());
  if (!req.player.is_admin) return next(forbidden('NOT_ADMIN', 'Admins only.'));
  next();
}

/** Next unused colour, wrapping once the palette runs out. */
function nextColour() {
  const taken = new Set(db.prepare('SELECT colour FROM players').all().map((r) => r.colour));
  return PLAYER_COLOURS.find((c) => !taken.has(c))
    ?? PLAYER_COLOURS[db.prepare('SELECT COUNT(*) AS c FROM players').get().c % PLAYER_COLOURS.length];
}

/**
 * The admin repaints a player. Only from the palette, because every colour in it was
 * picked to read on the dark map and to stay clear of every accent, and never into a
 * colour somebody else is wearing — two players in one colour makes the map a lie.
 * Nothing stores a colour but this row: every view joins it at read time, so the whole
 * territory, feed and binder follow on the next fetch.
 */
export function setPlayerColour(playerId, colour) {
  const hex = String(colour ?? '').trim().toUpperCase();
  const wanted = PLAYER_COLOURS.find((c) => c.toUpperCase() === hex);
  if (!wanted) throw badRequest('BAD_COLOUR', 'That colour is not in the player palette.');

  return db.transaction(() => {
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
    if (!player) throw new GameError('NO_SUCH_PLAYER', 'No such player.', {}, 404);
    if (player.colour === wanted) return { player, changed: false };
    const wearer = db.prepare('SELECT display_name FROM players WHERE colour = ? AND id != ?')
      .get(wanted, playerId);
    if (wearer) {
      throw new GameError('COLOUR_TAKEN', `${wearer.display_name} is already wearing that.`, {}, 409);
    }
    db.prepare('UPDATE players SET colour = ? WHERE id = ?').run(wanted, playerId);
    return { player: db.prepare('SELECT * FROM players WHERE id = ?').get(playerId), changed: true };
  })();
}

export function createInvite({ createdBy = null, note = null, expiresAt = null } = {}) {
  // Six groups of four uppercase base32-ish characters; no vowels, no 0/1/I/O.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const raw = Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');
  const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  db.prepare(`
    INSERT INTO invite_codes (code, created_by, note, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(code, createdBy, note, expiresAt, nowIso());
  return code;
}

/**
 * Register a player against an invite code. The first player to register is made
 * admin — somebody has to be able to mint the next invite.
 */
export async function registerPlayer({ inviteCode, handle, displayName, password }) {
  handle = String(handle ?? '').trim();
  displayName = String(displayName ?? '').trim() || handle;
  const code = String(inviteCode ?? '').trim().toUpperCase();

  if (!HANDLE_RE.test(handle)) {
    throw badRequest('BAD_HANDLE',
      'Handles are 2–24 characters: letters, numbers, dot, dash, underscore.');
  }
  if (String(password ?? '').length < 8) {
    throw badRequest('BAD_PASSWORD', 'Passwords need at least 8 characters.');
  }

  const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code);
  if (!invite) throw badRequest('BAD_INVITE', 'That invite code is not valid.');
  if (invite.used_by) throw badRequest('INVITE_USED', 'That invite code has already been used.');
  if (invite.expires_at && invite.expires_at < nowIso()) {
    throw badRequest('INVITE_EXPIRED', 'That invite code has expired.');
  }
  if (db.prepare('SELECT 1 FROM players WHERE handle = ?').get(handle)) {
    throw badRequest('HANDLE_TAKEN', `${handle} is taken.`);
  }

  const passwordHash = await hashPassword(password);
  const isFirst = db.prepare('SELECT COUNT(*) AS c FROM players').get().c === 0;

  return db.transaction(() => {
    const res = db.prepare(`
      INSERT INTO players (handle, display_name, password_hash, colour, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(handle, displayName, passwordHash, nextColour(), isFirst ? 1 : 0, nowIso());
    const id = Number(res.lastInsertRowid);
    db.prepare('UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code = ?')
      .run(id, nowIso(), code);
    return db.prepare('SELECT * FROM players WHERE id = ?').get(id);
  })();
}

export async function loginPlayer({ handle, password }) {
  const player = db.prepare('SELECT * FROM players WHERE handle = ?')
    .get(String(handle ?? '').trim());
  // Same error either way — no handle enumeration, even among six friends.
  const bad = new GameError('BAD_CREDENTIALS', 'Wrong handle or password.', {}, 401);
  if (!player) {
    // Burn comparable time so a missing handle is not detectably faster.
    await argon2.hash(String(password ?? 'x'), { type: argon2.argon2id }).catch(() => {});
    throw bad;
  }
  if (!(await verifyPassword(player.password_hash, String(password ?? '')))) throw bad;
  return player;
}

/** The shape every endpoint uses for a player — never includes password_hash. */
export const publicPlayer = (p) => p && ({
  id: p.id,
  handle: p.handle,
  display_name: p.display_name,
  colour: p.colour,
  is_admin: !!p.is_admin,
  created_at: p.created_at,
});
