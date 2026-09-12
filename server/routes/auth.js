import { Router } from 'express';
import { db } from '../db.js';
import {
  registerPlayer, loginPlayer, setAuthCookie, clearAuthCookie,
  requireAuth, requireAdmin, createInvite, publicPlayer,
} from '../lib/auth.js';
import { playerSummary } from '../lib/views.js';
import { postMessage } from '../lib/hub.js';

export const authRoutes = Router();

authRoutes.post('/register', async (req, res, next) => {
  try {
    const { invite_code, handle, display_name, password } = req.body ?? {};
    const player = await registerPlayer({
      inviteCode: invite_code, handle, displayName: display_name, password,
    });
    setAuthCookie(res, player);
    postMessage({ body: `${player.display_name} joined the game.`, kind: 'system',
      meta: { event: 'join', player_id: player.id } });
    res.status(201).json({ player: publicPlayer(player), ...playerSummary(player.id) });
  } catch (err) { next(err); }
});

authRoutes.post('/login', async (req, res, next) => {
  try {
    const player = await loginPlayer({ handle: req.body?.handle, password: req.body?.password });
    setAuthCookie(res, player);
    res.json({ player: publicPlayer(player), ...playerSummary(player.id) });
  } catch (err) { next(err); }
});

authRoutes.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

/** Whether anyone has registered yet — the login screen uses it to lead with "join". */
authRoutes.get('/status', (_req, res) => {
  res.json({ players: db.prepare('SELECT COUNT(*) AS c FROM players').get().c });
});

export const meRoutes = Router();

meRoutes.get('/me', requireAuth, (req, res) => {
  res.json({ player: publicPlayer(req.player), ...playerSummary(req.player.id) });
});

meRoutes.get('/players', requireAuth, (_req, res) => {
  res.json({ players: db.prepare('SELECT * FROM players ORDER BY id').all().map(publicPlayer) });
});

// ── Invites ───────────────────────────────────────────────────────────────
meRoutes.get('/invites', requireAdmin, (_req, res) => {
  res.json({
    invites: db.prepare(`
      SELECT i.*, p.handle AS used_by_handle
        FROM invite_codes i LEFT JOIN players p ON p.id = i.used_by
       ORDER BY i.created_at DESC`).all(),
  });
});

meRoutes.post('/invites', requireAdmin, (req, res) => {
  const code = createInvite({ createdBy: req.player.id, note: req.body?.note ?? null });
  res.status(201).json({ code });
});
