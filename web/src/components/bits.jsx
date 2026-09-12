// Small shared pieces: subject chips, player names, flag buttons, a lightbox.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { ago, article, clock } from '../lib/game.js';
import { SUBJECT_ICON, FlagIcon, CloseIcon } from './icons.jsx';

export function Subject({ type, label = true, className = '' }) {
  if (!type) return null;
  const Icon = SUBJECT_ICON[type];
  return (
    <span className={`subject ${className}`} title={article(type)}>
      <Icon />
      {label && <span>{type}</span>}
    </span>
  );
}

export function PlayerName({ player, you }) {
  if (!player) return <span className="dim">nobody</span>;
  const mine = you && player.id === you.id;
  return (
    <span className="cluster" style={{ gap: '0.35rem' }}>
      <i className="dot" style={{ background: player.colour }} />
      <b style={{ fontWeight: mine ? 700 : 400 }}>
        {player.display_name}{mine ? ' (you)' : ''}
      </b>
    </span>
  );
}

export function Banner({ kind = 'info', children }) {
  if (!children) return null;
  return <div className={`banner banner-${kind}`}>{children}</div>;
}

export function Spinner() { return <i className="spinner" aria-label="Loading" />; }

export function Lightbox({ src, alt, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!src) return null;
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true">
      <img src={src} alt={alt ?? ''} />
      <button className="btn btn-sm" style={{ position: 'fixed', top: '1rem', right: '1rem' }}
              onClick={onClose} aria-label="Close">
        <CloseIcon style={{ width: 16, height: 16 }} />
      </button>
    </div>
  );
}

/**
 * The one-tap accusation. The count is public and the whole point — spec §1.7 says the
 * social pressure of a visible first flag is most of what makes the honour system work.
 */
export function FlagButton({ claim, threshold = 2, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (claim.claim_kind === 'reversal') return null;
  if (claim.status === 'reverted') return <span className="chip chip-bad">Reverted</span>;

  const flagged = claim.flagged_by_me;
  const count = claim.flag_count ?? 0;

  const toggle = async () => {
    if (busy) return;
    if (!flagged) {
      const reason = window.prompt(
        `Flag ${claim.player.display_name}'s claim on ${claim.hood_label}?\n\n` +
        `${threshold} flags reverts it. Say why — everyone sees this in chat.`);
      if (reason === null) return;
      setBusy(true);
      try {
        const res = await api.flag(claim.id, reason.trim());
        onChanged?.(res);
      } catch (err) { setError(err.message); }
      finally { setBusy(false); }
    } else {
      setBusy(true);
      try {
        const res = await api.unflag(claim.id);
        onChanged?.(res);
      } catch (err) { setError(err.message); }
      finally { setBusy(false); }
    }
  };

  if (!claim.flaggable && !flagged) {
    return count > 0 ? <span className="chip">{count} flag{count === 1 ? '' : 's'}</span> : null;
  }

  return (
    <span className="cluster" style={{ gap: '0.35rem' }}>
      <button className={`btn btn-sm ${flagged ? 'btn-danger' : 'btn-ghost'}`}
              onClick={toggle} disabled={busy}
              title={flagged ? 'Withdraw your flag' : 'Flag this claim'}>
        <FlagIcon style={{ width: 14, height: 14 }} />
        {count > 0 ? `${count}/${threshold}` : 'Flag'}
      </button>
      {error && <span className="tiny" style={{ color: 'var(--bad)' }}>{error}</span>}
    </span>
  );
}

export function When({ iso, absolute = false }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString('en-CA')} className="tiny dim">
      {absolute ? clock(iso) : ago(iso)}
    </time>
  );
}
