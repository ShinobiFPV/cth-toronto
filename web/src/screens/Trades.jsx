// Offers: the ones waiting on you, and the ones you have out.
//
// Incoming pending offers come first, because they are the only rows anybody has to do
// anything about. Everything else is history, kept visible so a trade is as auditable
// as a claim.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { BackIcon } from '../components/icons.jsx';
import { Banner, Spinner, When } from '../components/bits.jsx';
import CardLightbox from '../components/CardLightbox.jsx';

const STATUS_LABEL = {
  pending: 'waiting',
  accepted: 'done',
  declined: 'declined',
  cancelled: 'withdrawn',
  // A card in the offer moved on before it was accepted, so the offer lapsed.
  stale: 'lapsed',
};

export default function Trades() {
  const navigate = useNavigate();
  const { refreshMe } = useGame();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [cardClaim, setCardClaim] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.trades());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);

  const act = async (id, fn, said) => {
    setBusy(id);
    setError(null);
    setNote(null);
    try {
      await fn(id);
      setNote(said);
      await load();
      // Accepting changes what is in your binder, and the tab badge counts offers.
      await refreshMe().catch(() => {});
    } catch (err) {
      setError(err.message || 'That did not go through.');
      await load().catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  // A park card shows what the park is worth; a Not Wheels card's worth is its print.
  const Card = ({ side, card }) => {
    const name = card.name ?? card.park_name;
    return (
      <button className="trade-card" onClick={() => setCardClaim(card.claim_id)}
              title={`See the ${name} card`}>
        <span className="tiny dim">{side}</span>
        <b className="truncate">{name}</b>
        <span className="tiny dim">
          {card.kind === 'car' ? `${card.edition} car card` : `+${card.value}`}
        </span>
      </button>
    );
  };

  const Row = ({ t, mine }) => (
    <div className={`sheet trade-row ${t.status !== 'pending' ? 'resolved' : ''}`}>
      <div className="sheet-head">
        <div className="grow">
          <b>{mine ? `To ${t.to.display_name}` : `From ${t.from.display_name}`}</b>
          <div className="tiny dim">
            <When iso={t.created_at} /> · {STATUS_LABEL[t.status] ?? t.status}
          </div>
        </div>
        <i className="dot" style={{ background: mine ? t.to.colour : t.from.colour }} />
      </div>

      <div className="sheet-body stack" style={{ gap: '0.5rem' }}>
        <div className="trade-swap">
          <Card side={mine ? 'you give' : 'they give'} card={t.offer} />
          {t.is_gift
            ? <span className="trade-arrow tiny dim">gift</span>
            : (
              <>
                <span className="trade-arrow" aria-hidden="true">⇄</span>
                <Card side={mine ? 'you get' : 'they want'} card={t.want} />
              </>
            )}
        </div>

        {t.message && <p className="caption">{t.message}</p>}

        {t.status === 'pending' && (
          <div className="cluster">
            {mine ? (
              <button className="btn btn-sm btn-ghost" disabled={busy === t.id}
                      onClick={() => act(t.id, api.cancelTrade, 'Offer withdrawn.')}>
                Withdraw
              </button>
            ) : (
              <>
                <button className="btn btn-sm btn-primary" disabled={busy === t.id}
                        onClick={() => act(t.id, api.acceptTrade,
                          t.is_gift ? 'Taken — it is in your binder.' : 'Traded.')}>
                  {t.is_gift ? 'Take it' : 'Accept'}
                </button>
                <button className="btn btn-sm btn-ghost" disabled={busy === t.id}
                        onClick={() => act(t.id, api.declineTrade, 'Declined.')}>
                  No thanks
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );

  if (loading) return <div className="empty"><Spinner /></div>;

  const incoming = data?.incoming ?? [];
  const outgoing = data?.outgoing ?? [];
  const waiting = incoming.filter((t) => t.status === 'pending');
  const settled = [...incoming, ...outgoing]
    .filter((t) => t.status !== 'pending')
    .sort((a, b) => b.id - a.id);
  const sent = outgoing.filter((t) => t.status === 'pending');
  // Which side of a settled trade you were on, without re-deriving it per row.
  const iSent = new Set(outgoing.map((t) => t.id));

  return (
    <div className="screen-pad">
      <div className="cluster" style={{ marginBottom: '0.6rem' }}>
        <button className="btn btn-sm btn-ghost" onClick={() => navigate(-1)}>
          <BackIcon style={{ width: 14, height: 14 }} /> Back
        </button>
        <span className="grow" />
        <Link className="btn btn-sm btn-ghost" to="/binder">Binder</Link>
      </div>

      <h1>Offers</h1>
      <p className="tiny dim" style={{ margin: '0.3rem 0 0.9rem' }}>
        Cards change hands; scores do not. Whoever went and got one keeps its
        points and XP, whatever happens to it afterwards.
      </p>

      {note && <Banner kind="ok">{note}</Banner>}
      {error && <Banner kind="bad">{error}</Banner>}

      {!waiting.length && !sent.length && !settled.length && (
        <div className="empty">
          Nothing yet. Open your binder, pick a card and offer it to somebody.
        </div>
      )}

      {waiting.length > 0 && (
        <>
          <h2 style={{ margin: '1rem 0 0.5rem' }}>Waiting on you</h2>
          {waiting.map((t) => <Row key={t.id} t={t} mine={false} />)}
        </>
      )}

      {sent.length > 0 && (
        <>
          <h2 style={{ margin: '1rem 0 0.5rem' }}>Out with you</h2>
          {sent.map((t) => <Row key={t.id} t={t} mine />)}
        </>
      )}

      {settled.length > 0 && (
        <>
          <h2 style={{ margin: '1rem 0 0.5rem' }}>Settled</h2>
          {settled.map((t) => <Row key={t.id} t={t} mine={iSent.has(t.id)} />)}
        </>
      )}

      <CardLightbox claimId={cardClaim} onClose={() => setCardClaim(null)} />
    </div>
  );
}
