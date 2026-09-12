// Every photo ever posted in one Hood, newest first. Spec §7 calls this "a genuinely
// nice artifact by the end of the year", which is the reason originals are kept and
// nothing is ever deleted from the ledger.
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { article, ago, until, KIND_VERB } from '../lib/game.js';
import { BackIcon, LockIcon } from '../components/icons.jsx';
import { Subject, PlayerName, FlagButton, Banner, Spinner, Lightbox, When } from '../components/bits.jsx';
import ShotData from '../components/ShotData.jsx';

export default function HoodDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { player, hoods, refreshHoods } = useGame();
  const [hood, setHood] = useState(null);
  const [loading, setLoading] = useState(true);
  const [zoomed, setZoomed] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.hood(id)
      .then((r) => !cancelled && setHood(r.hood))
      .catch(() => !cancelled && setHood(null))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [id, hoods]);

  if (loading) return <div className="empty"><Spinner /></div>;
  if (!hood) return <div className="empty">No such Hood.</div>;

  const v = hood.viewer ?? {};
  const replace = (claim) =>
    setHood((h) => ({ ...h, history: h.history.map((c) => (c.id === claim.id ? claim : c)) }));

  return (
    <div className="screen-pad">
      <div className="cluster" style={{ marginBottom: '0.8rem' }}>
        <button className="btn btn-sm btn-ghost" onClick={() => navigate(-1)}>
          <BackIcon style={{ width: 14, height: 14 }} /> Back
        </button>
      </div>

      <h1>{hood.label}</h1>

      <div className="cluster" style={{ margin: '0.6rem 0 1rem' }}>
        <PlayerName player={hood.owner} you={player} />
        {hood.photo_type && <Subject type={hood.photo_type} className="chip chip-accent" />}
        {!hood.owner && <span className="chip chip-accent">+{hood.unclaimed_value} to conquer</span>}
        {hood.locked_until && (
          <span className="chip"><LockIcon style={{ width: 12, height: 12 }} /> {until(hood.locked_until)}</span>
        )}
      </div>

      {hood.owner && (
        <p className="tiny dim">
          Beat it with {article(v.required_types?.[0] ?? 'anything')} photo.
          {hood.claimed_at && ` Held since ${ago(hood.claimed_at)}.`}
        </p>
      )}

      {v.message && <Banner kind={v.error === 'REINFORCE_TOO_SOON' ? 'info' : 'bad'}>{v.message}</Banner>}

      <h2 style={{ margin: '1.4rem 0 0.6rem' }}>
        History · {hood.history.filter((c) => c.claim_kind !== 'reversal').length} claims
      </h2>

      {!hood.history.length && <div className="empty">Nobody has ever claimed this Hood.</div>}

      <div className="stack">
        {hood.history.map((c) => (
          <article key={c.id} className={`sheet ${c.status === 'reverted' ? 'reverted' : ''}`}
                   style={c.status === 'reverted' ? { opacity: 0.6 } : undefined}>
            {c.display_url && (
              <img className="sheet-photo" src={c.display_url} alt="" loading="lazy"
                   onClick={() => setZoomed(c.display_url)} />
            )}
            <div className="sheet-body stack" style={{ gap: '0.5rem' }}>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <PlayerName player={c.player} you={player} />
                <When iso={c.created_at} />
              </div>

              <div className="cluster">
                <span className={`chip ${c.claim_kind === 'reversal' ? 'chip-bad' : 'chip-accent'}`}>
                  {KIND_VERB[c.claim_kind]}{c.points ? ` +${c.points}` : ''}
                </span>
                {c.photo_type && <Subject type={c.photo_type} />}
                {c.beaten && <span className="tiny dim">beat {c.beaten.display_name}</span>}
                {c.replaced_photo_type
                  && <span className="tiny dim">was {c.replaced_photo_type}</span>}
                {c.status === 'superseded' && <span className="chip">superseded</span>}
              </div>

              <ShotData data={c.shot_data} />

              <div className="cluster">
                <FlagButton claim={c} onChanged={(res) => { replace(res.claim); refreshHoods().catch(() => {}); }} />
              </div>
            </div>
          </article>
        ))}
      </div>

      <Lightbox src={zoomed} alt={hood.label} onClose={() => setZoomed(null)} />
    </div>
  );
}
