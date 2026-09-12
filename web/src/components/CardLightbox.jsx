// The card a collection printed, opened from wherever that collection appears.
//
// The feed and a Hood's history both show park claims as a thumbnail and a name, which
// is the least interesting thing about them — the card is the point. This fetches it by
// claim id and shows it full size.
//
// It is deliberately not fussy about whose card it is. Nobody competes over parks, so a
// card is something to show off; being able to see what everybody else pulled is most
// of why a card game is fun.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { CloseIcon } from './icons.jsx';
import { Spinner } from './bits.jsx';
import ParkCard from './ParkCard.jsx';

export default function CardLightbox({ claimId, onClose }) {
  const [card, setCard] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (claimId == null) return undefined;
    let cancelled = false;
    setCard(null);
    setError(null);
    api.card(claimId)
      .then((r) => !cancelled && setCard(r.card))
      .catch((err) => !cancelled && setError(err.message || 'Could not load that card.'));
    return () => { cancelled = true; };
  }, [claimId]);

  useEffect(() => {
    if (claimId == null) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [claimId, onClose]);

  if (claimId == null) return null;

  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true"
         aria-label="Park card">
      {/* Stop a tap on the card itself from closing the thing you just opened. */}
      <div onClick={(e) => e.stopPropagation()}>
        {card && <ParkCard card={card} />}
        {!card && !error && <Spinner />}
        {error && <div className="empty">{error}</div>}
      </div>
      <button className="btn btn-sm" style={{ position: 'fixed', top: '1rem', right: '1rem' }}
              onClick={onClose} aria-label="Close">
        <CloseIcon style={{ width: 16, height: 16 }} />
      </button>
    </div>
  );
}
