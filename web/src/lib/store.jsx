// One context holding the session, the 25 Hoods, and the live socket.
//
// The socket is the only push channel: a claim anywhere re-fetches the Hood list, so
// the map is never more than a round-trip stale for anybody looking at it.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

const Ctx = createContext(null);

export const useGame = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useGame outside <GameProvider>');
  return v;
};

export function GameProvider({ children }) {
  const [session, setSession] = useState(null);      // { player, season, season_points, … }
  const [hoods, setHoods] = useState([]);
  const [players, setPlayers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [online, setOnline] = useState([]);
  const [unreadChat, setUnreadChat] = useState(0);
  const [booting, setBooting] = useState(true);
  const [connected, setConnected] = useState(false);

  const socketRef = useRef(null);
  const retryRef = useRef(0);
  const chatOpenRef = useRef(false);

  const refreshHoods = useCallback(async () => {
    const { hoods } = await api.hoods();
    setHoods(hoods);
  }, []);

  const refreshMe = useCallback(async () => {
    const me = await api.me();
    setSession(me);
    return me;
  }, []);

  // ── boot ────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const me = await api.me();
        setSession(me);
        const [{ hoods }, { players }, { messages }] = await Promise.all([
          api.hoods(), api.players(), api.chat(),
        ]);
        setHoods(hoods);
        setPlayers(players);
        setMessages(messages);
      } catch {
        setSession(null);       // not signed in; <App> shows the login screen
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  // ── socket ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!session) return undefined;
    let closed = false;
    let timer = null;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      socketRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        retryRef.current = 0;
        // A socket that dropped may have missed claims; resync on every connect.
        refreshHoods().catch(() => {});
      };

      ws.onmessage = (ev) => {
        let frame;
        try { frame = JSON.parse(ev.data); } catch { return; }
        const { type, payload } = frame;

        if (type === 'hello') {
          setOnline(payload.online ?? []);
        } else if (type === 'presence') {
          setOnline(payload.online ?? []);
        } else if (type === 'chat_message') {
          setMessages((prev) => (prev.some((m) => m.id === payload.id) ? prev : [...prev, payload]));
          if (!chatOpenRef.current) setUnreadChat((n) => n + 1);
        } else if (type === 'hood_changed' || type === 'claim_reverted') {
          refreshHoods().catch(() => {});
          refreshMe().catch(() => {});
        } else if (type === 'claim_created') {
          refreshHoods().catch(() => {});
          refreshMe().catch(() => {});
        } else if (type === 'trade_offered' || type === 'trade_resolved') {
          // The badge counts offers waiting on you, so it has to move when one arrives
          // rather than on the next reload. Both parties care: one gains a pending
          // offer, the other loses one. Everybody else can ignore the frame.
          // The effect re-runs on login and logout, so the captured session is always
          // the player this socket belongs to.
          const me = session?.player?.id;
          if (me && (payload?.to?.id === me || payload?.from?.id === me)) {
            refreshMe().catch(() => {});
          }
        } else if (type === 'caption_changed') {
          // Nothing in the ledger moved, so patch the one field rather than refetching
          // 25 Hoods. Anyone with that Hood's sheet open sees the new line.
          setHoods((prev) => prev.map((h) =>
            h.active_claim_id === payload.claim_id ? { ...h, caption: payload.caption } : h));
        } else if (type === 'flag_added') {
          setHoods((prev) => prev.map((h) =>
            h.active_claim_id === payload.claim_id ? { ...h, flag_count: payload.count } : h));
        }
      };

      ws.onclose = () => {
        setConnected(false);
        socketRef.current = null;
        if (closed) return;
        // Back off to 30s: phones sleep, and the tunnel drops idle sockets.
        const delay = Math.min(1000 * 2 ** retryRef.current++, 30_000);
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [session?.player?.id, refreshHoods, refreshMe]);

  // Re-sync whenever the app comes back to the foreground — a phone that was in a
  // pocket for an hour has a stale map and quite possibly a dead socket.
  useEffect(() => {
    if (!session) return undefined;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      refreshHoods().catch(() => {});
      refreshMe().catch(() => {});
      if (socketRef.current?.readyState !== WebSocket.OPEN) retryRef.current = 0;
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [session, refreshHoods, refreshMe]);

  const say = useCallback(async (body) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'chat', body }));
    else await api.say(body);              // socket down — the REST path still lands
  }, []);

  const loadOlderMessages = useCallback(async () => {
    const oldest = messages[0]?.id;
    if (!oldest) return 0;
    const { messages: older } = await api.chat(oldest);
    if (older.length) setMessages((prev) => [...older, ...prev]);
    return older.length;
  }, [messages]);

  const markChatRead = useCallback((open) => {
    chatOpenRef.current = open;
    if (open) setUnreadChat(0);
  }, []);

  const signIn = useCallback(async (result) => {
    setSession(result);
    const [{ hoods }, { players }, { messages }] = await Promise.all([
      api.hoods(), api.players(), api.chat(),
    ]);
    setHoods(hoods);
    setPlayers(players);
    setMessages(messages);
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    socketRef.current?.close();
    setSession(null);
    setHoods([]);
    setMessages([]);
  }, []);

  const value = useMemo(() => ({
    session, player: session?.player ?? null,
    hoods, players, messages, online, unreadChat, booting, connected,
    refreshHoods, refreshMe, say, loadOlderMessages, markChatRead, signIn, signOut,
    hoodById: (id) => hoods.find((h) => h.id === Number(id)) ?? null,
  }), [session, hoods, players, messages, online, unreadChat, booting, connected,
       refreshHoods, refreshMe, say, loadOlderMessages, markChatRead, signIn, signOut]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
