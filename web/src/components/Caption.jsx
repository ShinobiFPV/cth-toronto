// A photo's caption, wherever the photo appears.
//
// Two jobs in one component, because they are the same thing from different angles:
// somebody else's caption is prose you read, and your own is prose you can fix. Keeping
// them together means the feed, the Hood sheet and the Hood detail all get the pencil
// for free and none of them has to work out whose photo it is.
//
// A caption is never required. The empty state is a quiet prompt on your own photos and
// nothing at all on anybody else's — an "add a caption" nag under a friend's raccoon
// would be worse than no feature.
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { PencilIcon } from './icons.jsx';

export const CAPTION_MAX = 200;

export default function Caption({ claim, onChanged, className = '' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(claim.caption ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const input = useRef(null);

  // Somebody else's edit can arrive over the WebSocket while this is on screen.
  useEffect(() => { if (!editing) setDraft(claim.caption ?? ''); }, [claim.caption, editing]);
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);

  const save = async () => {
    if (busy) return;
    const next = draft.trim();
    if (next === (claim.caption ?? '')) { setEditing(false); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await api.setCaption(claim.id, next);
      setEditing(false);
      onChanged?.(res.claim);
    } catch (err) {
      setError(err.message || 'That did not save.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setDraft(claim.caption ?? '');
    setError(null);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className={`caption-edit ${className}`}>
        <input
          ref={input}
          className="caption-input"
          value={draft}
          maxLength={CAPTION_MAX}
          placeholder="Say something about this photo"
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          // Enter saves and Escape abandons, because this is one line of text and
          // reaching for a button on a phone is the slow way to do either.
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
        />
        <div className="cluster" style={{ gap: '0.35rem' }}>
          <button className="btn btn-sm btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <span className="grow" />
          <span className="tiny dim">{CAPTION_MAX - draft.length}</span>
        </div>
        {error && <div className="tiny" style={{ color: 'var(--bad)' }}>{error}</div>}
      </div>
    );
  }

  if (claim.caption) {
    return (
      <p className={`caption ${className}`}>
        {claim.caption}
        {claim.can_caption && (
          <button className="caption-pencil" onClick={() => setEditing(true)}
                  aria-label="Edit your caption" title="Edit your caption">
            <PencilIcon style={{ width: 12, height: 12 }} />
          </button>
        )}
      </p>
    );
  }

  if (!claim.can_caption) return null;

  return (
    <button className={`caption-add ${className}`} onClick={() => setEditing(true)}>
      <PencilIcon style={{ width: 12, height: 12 }} /> Add a caption
    </button>
  );
}
