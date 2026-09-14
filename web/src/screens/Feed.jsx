// Reverse-chronological claims with thumbnails and a one-tap flag on each.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { KIND_VERB } from '../lib/game.js';
import { CardIcon, CarIcon } from '../components/icons.jsx';
import { Subject, PlayerName, FlagButton, When, Spinner, Lightbox } from '../components/bits.jsx';
import Caption from '../components/Caption.jsx';
import CardLightbox from '../components/CardLightbox.jsx';

export default function Feed() {
  const { player, hoods } = useGame();
  const [items, setItems] = useState([]);
  const [before, setBefore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [zoomed, setZoomed] = useState(null);
  const [cardClaim, setCardClaim] = useState(null);

  const load = useCallback(async (cursor) => {
    const { feed, next_before } = await api.feed(cursor);
    setItems((prev) => (cursor ? [...prev, ...feed] : feed));
    setBefore(next_before);
    setLoading(false);
  }, []);

  useEffect(() => { load(null).catch(() => setLoading(false)); }, [load, hoods.length]);

  const replace = (claim) => setItems((prev) => prev.map((c) => (c.id === claim.id ? claim : c)));

  if (loading) return <div className="empty"><Spinner /></div>;
  if (!items.length) {
    return <div className="empty">Nothing yet. Somebody go outside and take a photo.</div>;
  }

  return (
    <>
      {items.map((c) => (
        <article key={c.id} className={`claim ${c.status === 'reverted' ? 'reverted' : ''}`}>
          {c.thumb_url
            ? <img className="claim-thumb" src={c.thumb_url} alt="" loading="lazy"
                   onClick={() => (c.park || c.claim_kind === 'car'
                     ? setCardClaim(c.id) : setZoomed(c.display_url))} />
            : <div className="claim-thumb" aria-hidden="true" />}

          <div className="grow">
            <div className="cluster" style={{ justifyContent: 'space-between' }}>
              <PlayerName player={c.player} you={player} />
              <When iso={c.created_at} />
            </div>

            <div style={{ margin: '0.2rem 0' }}>
              <Link to={`/hood/${c.hood_id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <b>{c.hood_label}</b>
              </Link>
            </div>

            <div className="cluster">
              <span className={`chip ${c.claim_kind === 'reversal' ? 'chip-bad' : 'chip-accent'}`}>
                {KIND_VERB[c.claim_kind]}{c.points ? ` +${c.points}` : ''}
              </span>
              {c.park
                ? (
                  <button className="btn btn-sm btn-ghost" onClick={() => setCardClaim(c.id)}
                          title={`See the ${c.park.name} card`}>
                    <CardIcon style={{ width: 14, height: 14 }} />
                    {c.park.name}
                  </button>
                )
                : c.vehicle
                  ? (
                    c.claim_kind === 'car' ? (
                      <button className="btn btn-sm btn-ghost" onClick={() => setCardClaim(c.id)}
                              title={`See the ${c.vehicle.name} card`}>
                        <CarIcon style={{ width: 14, height: 14 }} />
                        {c.vehicle.name}
                      </button>
                    ) : <span className="tiny dim">{c.vehicle.name}</span>
                  )
                  : c.photo_type && <Subject type={c.photo_type} />}
              {c.claim_kind === 'car' && c.edition && c.edition !== 'steel'
                && <span className={`chip ed-${c.edition}`}>{c.edition}</span>}
              {c.beaten && <span className="tiny dim">beat {c.beaten.display_name}</span>}
              {c.replaced_photo_type
                && <span className="tiny dim">was {c.replaced_photo_type}</span>}
            </div>

            <Caption claim={c} onChanged={replace} />

            <div className="cluster" style={{ marginTop: '0.35rem' }}>
              <FlagButton claim={c} onChanged={(res) => replace(res.claim)} />
            </div>
          </div>
        </article>
      ))}

      {before && (
        <div className="screen-pad">
          <button className="btn btn-block" onClick={() => load(before)}>Older</button>
        </div>
      )}

      <Lightbox src={zoomed} onClose={() => setZoomed(null)} />
      <CardLightbox claimId={cardClaim} onClose={() => setCardClaim(null)} />
    </>
  );
}
