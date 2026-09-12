// The binder: every park card you own. The reason to keep collecting once the points
// stop mattering.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { BackIcon, CloseIcon } from '../components/icons.jsx';
import { Spinner } from '../components/bits.jsx';
import ParkCard from '../components/ParkCard.jsx';

const RARITY_ORDER = ['legendary', 'rare', 'uncommon', 'common'];

export default function Binder() {
  const navigate = useNavigate();
  const { session } = useGame();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState('season');
  const [zoom, setZoom] = useState(null);
  const [rarity, setRarity] = useState('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.cards(scope === 'season' ? session?.season?.id : null)
      .then((r) => !cancelled && setData(r))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [scope, session?.season?.id]);

  const cards = useMemo(() => {
    const list = [...(data?.cards ?? [])];
    const filtered = rarity === 'all' ? list : list.filter((c) => c.rarity === rarity);
    return filtered.sort((a, b) =>
      RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity)
      || b.points - a.points
      || a.park.name.localeCompare(b.park.name));
  }, [data, rarity]);

  const s = data?.summary;

  return (
    <div className="screen-pad">
      <div className="cluster" style={{ marginBottom: '0.6rem' }}>
        <button className="btn btn-sm btn-ghost" onClick={() => navigate(-1)}>
          <BackIcon style={{ width: 14, height: 14 }} /> Back
        </button>
      </div>

      <h1>Binder</h1>
      <p className="tiny dim" style={{ margin: '0.3rem 0 0.9rem' }}>
        Every park sign you have photographed. Each park comes back around next season.
      </p>

      {s && (
        <div className="sheet" style={{ marginBottom: '0.9rem' }}>
          <div className="row">
            <span className="grow dim">{s.season?.name ?? 'This season'}</span>
            <b className="num">{s.season_collected}</b>
            <span className="tiny dim">/ {s.parks_total} parks</span>
          </div>
          <div className="row">
            <span className="grow dim">Points from parks this season</span>
            <b className="num">{s.season_points}</b>
          </div>
          <div className="row">
            <span className="grow dim">Distinct parks, all time</span>
            <b className="num">{s.distinct_parks_all_time}</b>
          </div>
          {Object.keys(s.by_rarity ?? {}).length > 0 && (
            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              {RARITY_ORDER.filter((r) => s.by_rarity[r]).map((r) => (
                <span key={r} className={`chip r-${r}`}>{s.by_rarity[r]} {r}</span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="toggle" role="group" aria-label="Scope">
        <button aria-pressed={scope === 'season'} onClick={() => setScope('season')}>
          {session?.season?.name ?? 'This season'}
        </button>
        <button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All time</button>
      </div>

      <div className="cluster" style={{ marginBottom: '0.8rem' }}>
        {['all', ...RARITY_ORDER].map((r) => (
          <button key={r} className={`btn btn-sm ${rarity === r ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setRarity(r)}>
            {r === 'all' ? 'All' : r}
          </button>
        ))}
      </div>

      {loading && <div className="empty"><Spinner /></div>}

      {!loading && !cards.length && (
        <div className="empty">
          Nothing here yet. Open a Hood on the map and tap Parkemon GO.
        </div>
      )}

      <div className="card-grid">
        {cards.map((c) => (
          <ParkCard key={c.claim_id} card={c} compact onClick={() => setZoom(c)} />
        ))}
      </div>

      {zoom && (
        <div className="lightbox" onClick={() => setZoom(null)} role="dialog" aria-modal="true">
          <ParkCard card={zoom} />
          <button className="btn btn-sm" style={{ position: 'fixed', top: '1rem', right: '1rem' }}
                  onClick={() => setZoom(null)} aria-label="Close">
            <CloseIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>
      )}
    </div>
  );
}
