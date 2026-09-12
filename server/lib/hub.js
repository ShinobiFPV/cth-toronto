// WebSocket hub: chat plus live map updates. One global room — six players.
//
// Every mutation in the game funnels through broadcast() here, and most of them also
// write a system message to chat. Spec §7: chat doubles as the activity feed, and
// visible accusations are the enforcement mechanism, so nothing happens quietly.
import { WebSocketServer } from 'ws';
import { parse as parseCookie } from 'cookie';
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import { playerFromToken, publicPlayer } from './auth.js';

const clients = new Set();

export function broadcast(type, payload) {
  const frame = JSON.stringify({ type, payload, at: nowIso() });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(frame); } catch { /* a dead socket will be cleaned up on close */ }
    }
  }
}

/**
 * Write a message and push it to every connected client.
 * `kind` is 'system' for game events, 'user' for people talking.
 */
export function postMessage({ playerId = null, body, kind = 'system', meta = null }) {
  const res = db.prepare(`
    INSERT INTO messages (player_id, body, kind, meta_json, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run(playerId, body, kind, meta ? JSON.stringify(meta) : null, nowIso());
  const message = getMessage(Number(res.lastInsertRowid));
  broadcast('chat_message', message);
  return message;
}

export function getMessage(id) {
  return hydrate(db.prepare(`
    SELECT m.*, p.handle, p.display_name, p.colour
      FROM messages m LEFT JOIN players p ON p.id = m.player_id
     WHERE m.id = ?`).get(id));
}

export function recentMessages({ before = null, limit = 50 } = {}) {
  const rows = before
    ? db.prepare(`
        SELECT m.*, p.handle, p.display_name, p.colour
          FROM messages m LEFT JOIN players p ON p.id = m.player_id
         WHERE m.id < ? ORDER BY m.id DESC LIMIT ?`).all(before, limit)
    : db.prepare(`
        SELECT m.*, p.handle, p.display_name, p.colour
          FROM messages m LEFT JOIN players p ON p.id = m.player_id
         ORDER BY m.id DESC LIMIT ?`).all(limit);
  return rows.map(hydrate).reverse();   // oldest first, ready to append to a log
}

function hydrate(row) {
  if (!row) return null;
  const { meta_json, ...rest } = row;
  return { ...rest, meta: meta_json ? JSON.parse(meta_json) : null };
}

const MAX_BODY = 2000;

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const cookies = parseCookie(req.headers.cookie || '');
    const player = playerFromToken(cookies[config.cookieName]);
    if (!player) {
      ws.close(4001, 'unauthorized');
      return;
    }

    ws.player = player;
    ws.isAlive = true;
    clients.add(ws);

    ws.send(JSON.stringify({
      type: 'hello',
      payload: { player: publicPlayer(player), online: onlineHandles() },
      at: nowIso(),
    }));
    broadcast('presence', { online: onlineHandles() });

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'chat') {
        const body = String(msg.body ?? '').trim().slice(0, MAX_BODY);
        if (!body) return;
        postMessage({ playerId: ws.player.id, body, kind: 'user' });
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', at: nowIso() }));
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      broadcast('presence', { online: onlineHandles() });
    });
    ws.on('error', () => clients.delete(ws));
  });

  // Drop sockets that stopped answering — phones sleep, tunnels drop.
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) { ws.terminate(); clients.delete(ws); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* terminate on the next sweep */ }
    }
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

const onlineHandles = () => [...new Set([...clients].map((ws) => ws.player?.handle).filter(Boolean))];

export const onlineCount = () => onlineHandles().length;
