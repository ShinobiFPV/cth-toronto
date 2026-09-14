// The persistent global room. Every claim and every flag posts itself here, which is
// what makes chat double as the activity feed and gives the honour system its teeth.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useGame } from '../lib/store.jsx';
import { clock } from '../lib/game.js';

export default function Chat() {
  const { messages, say, loadOlderMessages, markChatRead, player, online, connected } = useGame();
  const [draft, setDraft] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const logRef = useRef(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    markChatRead(true);
    return () => markChatRead(false);
  }, [markChatRead]);

  // Stay pinned to the newest message, but never yank the view while somebody is
  // reading back through the history.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = async (e) => {
    const el = e.currentTarget;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (el.scrollTop < 40 && !loadingOlder) {
      setLoadingOlder(true);
      const before = el.scrollHeight;
      await loadOlderMessages().catch(() => {});
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - before; });
      setLoadingOlder(false);
    }
  };

  const send = (e) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    pinnedRef.current = true;
    say(body);
    setDraft('');
  };

  return (
    <div className="chat">
      <div className="chat-log" ref={logRef} onScroll={onScroll}>
        {!messages.length && <div className="empty">Nothing said yet.</div>}

        {messages.map((m) => (m.kind === 'system' ? (
          <div key={m.id} className="msg-system">
            {m.body} <span className="msg-time">{clock(m.created_at)}</span>
            {/* A finished hunt is one line with its photos as a strip, not five messages. */}
            {m.meta?.thumbs?.length > 0 && (
              <div className="msg-thumbs">
                {m.meta.thumbs.map((src) => <img key={src} src={src} alt="" loading="lazy" />)}
              </div>
            )}
          </div>
        ) : (
          <div key={m.id} className="msg">
            <i className="dot" style={{ background: m.colour ?? 'var(--dim)', marginTop: 6 }} />
            <div className="grow">
              <span className="msg-who" style={{ color: m.colour }}>
                {m.display_name ?? m.handle}
              </span>{' '}
              <span className="msg-time">{clock(m.created_at)}</span>
              <div>{m.body}</div>
            </div>
          </div>
        )))}
      </div>

      <div className="chat-status">
        {connected ? `${online.length} online` : 'offline — reconnecting'}
      </div>

      <form className="composer" onSubmit={send}>
        <input
          className="input grow"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={connected ? `Say something, ${player?.display_name}` : 'Reconnecting…'}
          maxLength={2000}
          aria-label="Message"
        />
        <button className="btn btn-primary" type="submit" disabled={!draft.trim()}>Send</button>
      </form>
    </div>
  );
}
