// Offering one of your cards to somebody.
//
// Two decisions and a note: who, and what you want back. Asking for nothing is a
// gift, and that is a button rather than a hidden state, because giving somebody a
// spare is the most common thing anyone will do here.
//
// The sheet is explicit that no points move. That is the first question anybody asks
// about a trading system, and the answer is load-bearing enough to print.
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { cardName } from '../lib/game.js';
import { CloseIcon } from './icons.jsx';
import { Banner, Spinner } from './bits.jsx';

export default function TradeOffer({ card, onClose, onSent }) {
  const { players, player: me } = useGame();
  const others = players.filter((p) => p.id !== me?.id);

  const [toId, setToId] = useState(others.length === 1 ? others[0].id : null);
  const [theirCards, setTheirCards] = useState(null);
  const [wantId, setWantId] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Their binder, so you can ask for something specific. Loaded on demand rather than
  // up front: five other binders is a lot of cards nobody asked for.
  useEffect(() => {
    if (!toId) return undefined;
    let cancelled = false;
    setTheirCards(null);
    setWantId(null);
    // Both shelves: a car card can be asked for in exchange for a park card and back.
    Promise.all([api.cards(null, toId), api.cards(null, toId, 'car')])
      .then(([parksShelf, carShelf]) => !cancelled
        && setTheirCards([...parksShelf.cards, ...carShelf.cards]))
      .catch(() => !cancelled && setTheirCards([]));
    return () => { cancelled = true; };
  }, [toId]);

  const send = async () => {
    if (!toId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.offerTrade({
        to_player_id: toId,
        offer_claim_id: card.claim_id,
        want_claim_id: wantId,
        message: message.trim() || null,
      });
      onSent?.(res.trade);
    } catch (err) {
      setError(err.message || 'That did not send.');
      setBusy(false);
    }
  };

  const them = others.find((p) => p.id === toId);

  return (
    <>
      <div className="scrim" onClick={() => !busy && onClose()} />
      <div className="bottom-sheet" role="dialog" aria-modal="true" aria-label="Offer a card">
        <div className="sheet-head">
          <div className="grow">
            <h1>Offer {cardName(card)}</h1>
            <div className="tiny dim">
              {card.kind === 'car'
                ? `${card.edition_label} car card · ${card.season?.name}${card.vehicle.year ? ` · ${card.vehicle.year}` : ''}`
                : `${card.rarity_label} · ${card.season?.name} · #${String(card.park.set_number ?? card.park.id).padStart(4, '0')}`}
            </div>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close" disabled={busy}>
            <CloseIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <div className="sheet-body stack">
          <div>
            <h2 style={{ marginBottom: '0.5rem' }}>1 · Who to?</h2>
            <div className="cluster">
              {others.map((p) => (
                <button key={p.id}
                        className={`btn btn-sm ${toId === p.id ? 'btn-primary' : 'btn-ghost'}`}
                        aria-pressed={toId === p.id}
                        disabled={busy}
                        onClick={() => setToId(p.id)}>
                  <i className="dot" style={{ background: p.colour }} />
                  {p.display_name}
                </button>
              ))}
            </div>
          </div>

          {toId && (
            <div>
              <h2 style={{ marginBottom: '0.5rem' }}>
                2 · What for? <span className="tiny dim">optional</span>
              </h2>

              <button className={`btn btn-block ${wantId == null ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ justifyContent: 'space-between' }}
                      aria-pressed={wantId == null}
                      disabled={busy}
                      onClick={() => setWantId(null)}>
                <span>Nothing — it&rsquo;s a gift</span>
              </button>

              {theirCards == null && <div className="empty"><Spinner /></div>}

              {theirCards?.length === 0 && (
                <div className="tiny dim" style={{ marginTop: '0.5rem' }}>
                  {them?.display_name} has no cards yet, so this can only be a gift.
                </div>
              )}

              {theirCards && theirCards.length > 0 && (
                <div className="sheet" style={{ marginTop: '0.5rem', maxHeight: '32vh', overflowY: 'auto' }}>
                  {theirCards.map((c) => (
                    <button key={c.claim_id}
                            className={`row trade-pick ${wantId === c.claim_id ? 'picked' : ''}`}
                            aria-pressed={wantId === c.claim_id}
                            disabled={busy}
                            onClick={() => setWantId(c.claim_id)}>
                      {c.kind === 'car'
                        ? <span className={`chip ed-${c.edition}`}>{c.edition}</span>
                        : <span className={`chip r-${c.rarity}`}>{c.points}</span>}
                      <span className="grow truncate" style={{ textAlign: 'left' }}>{cardName(c)}</span>
                      <span className="tiny dim">{c.season?.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div>
            <input className="caption-input" value={message} maxLength={200}
                   placeholder="Say something (optional)" disabled={busy}
                   onChange={(e) => setMessage(e.target.value)} />
          </div>

          <div className="tiny dim">
            Trading moves the <b>card</b>. Points and XP stay with whoever went and got it,
            so nothing here changes the standings — it is your collection you are
            rearranging, not your score.
          </div>

          {error && <Banner kind="bad">{error}</Banner>}
        </div>

        <div className="sheet-actions">
          <button className="btn btn-primary btn-block" disabled={!toId || busy} onClick={send}>
            {busy ? 'Sending…' : (wantId == null
              ? `Give ${cardName(card)} to ${them?.display_name ?? '…'}`
              : 'Send the offer')}
          </button>
        </div>
      </div>
    </>
  );
}
