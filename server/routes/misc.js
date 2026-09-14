// Leaderboards, seasons, feed, chat history.
import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../lib/auth.js';
import { leaderboard, feed } from '../lib/views.js';
import { activeSeason, allSeasons, nextSeason } from '../lib/seasons.js';
import { recentMessages, postMessage, onlineCount } from '../lib/hub.js';
import { badRequest } from '../lib/errors.js';
import { editionRates } from '../lib/editions.js';

export const miscRoutes = Router();

const clampLimit = (v, def, max) => Math.min(Math.max(Number(v) || def, 1), max);

miscRoutes.get('/leaderboard', requireAuth, (req, res, next) => {
  try {
    const season = req.query.season
      ? db.prepare('SELECT * FROM seasons WHERE id = ?').get(Number(req.query.season))
      : activeSeason();
    if (req.query.season && !season) throw badRequest('NO_SUCH_SEASON', 'No season with that id.');
    res.json({ season, standings: season ? leaderboard(season.id) : leaderboard(null) });
  } catch (err) { next(err); }
});

miscRoutes.get('/leaderboard/champion', requireAuth, (_req, res) => {
  res.json({ season: null, standings: leaderboard(null) });
});

miscRoutes.get('/seasons', requireAuth, (_req, res) => {
  const active = activeSeason();
  res.json({
    seasons: allSeasons().map((s) => ({ ...s, active: !!active && s.id === active.id })),
    active,
    next: nextSeason(),
    rules: {
      steal_multiplier: config.STEAL_MULTIPLIER,
      difficulty_range: [5, 50],
      reinforce_points: config.REINFORCE_POINTS,
      escalation_step: config.ESCALATION_STEP,
      escalation_cap: config.ESCALATION_CAP,
      reinforce_gate_hours: config.REINFORCE_GATE_HOURS,
      steal_cooldown_hours: config.STEAL_COOLDOWN_HOURS,
      adjacent_conquer_cooldown_hours: config.ADJACENT_CONQUER_COOLDOWN_HOURS,
      flag_threshold: config.FLAG_THRESHOLD,
      park_hood_cap: config.PARK_HOOD_CAP,
      park_cap_period: config.PARK_CAP_PERIOD,
      car_points: config.CAR_POINTS,
      car_weekly_cap: config.CAR_WEEKLY_CAP,
      edition_rates: editionRates(),
      clover_edition_rates: editionRates({ clover: true }),
      item_weekly_cap: config.ITEM_WEEKLY_CAP,
      items_per_gold: config.ITEMS_PER_GOLD,
      items_per_hologram: config.ITEMS_PER_HOLOGRAM,
      clover_hours: config.CLOVER_HOURS,
      fortify_cooldown_hours: config.FORTIFY_COOLDOWN_HOURS,
    },
  });
});

miscRoutes.get('/feed', requireAuth, (req, res) => {
  const limit = clampLimit(req.query.limit, 30, 100);
  const before = req.query.before ? Number(req.query.before) : null;
  const items = feed({ before, limit, viewerId: req.player.id });
  res.json({
    feed: items,
    next_before: items.length === limit ? items[items.length - 1].id : null,
  });
});

miscRoutes.get('/chat', requireAuth, (req, res) => {
  const limit = clampLimit(req.query.limit, 50, 200);
  const before = req.query.before ? Number(req.query.before) : null;
  const messages = recentMessages({ before, limit });
  res.json({
    messages,
    next_before: messages.length === limit ? messages[0].id : null,
    online: onlineCount(),
  });
});

// The WebSocket is the normal send path; this exists so a message still gets through
// on a flaky connection, and so chat is testable with curl.
miscRoutes.post('/chat', requireAuth, (req, res, next) => {
  try {
    const body = String(req.body?.body ?? '').trim().slice(0, 2000);
    if (!body) throw badRequest('EMPTY_MESSAGE', 'Say something.');
    res.status(201).json({ message: postMessage({ playerId: req.player.id, body, kind: 'user' }) });
  } catch (err) { next(err); }
});
