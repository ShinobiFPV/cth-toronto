// The binder: every park card somebody owns. The reason to keep collecting once the
// points stop mattering.
//
// Anybody's binder, not just your own — /binder/:playerId. Nobody competes over parks,
// so a collection is something to show off rather than something to protect, and
// looking at what everybody else pulled is most of why a card game is fun.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { BackIcon, CloseIcon } from '../components/icons.jsx';
import { Spinner } from '../components/bits.jsx';
import ParkCard from '../components/ParkCard.jsx';

const RARITY_ORDER = ['legendary', 'rare', 'uncommon', 'common'];

export default function Binder() {
  const navigate = useNavigate();
  const { playerId } = useParams();
  const { session, players, player: me } = useGame();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState('season');
  const [zoom, setZoom] = useState(null);
  const [rarity, setRarity] = useState('all');

  const viewing = playerId ? Number(playerId) : null;
  const isMine = viewing == null || viewing === me?.id;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.cards(scope === 'season' ? session?.season?.id : null, viewing)
      .then((r) => !cancelled && setData(r))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [scope, session?.season?.id, viewing]);

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

      <h1>
        {isMine ? 'Binder' : `${data?.player?.display_name ?? 'Their'}’s binder`}
      </h1>
      <p className="tiny dim" style={{ margin: '0.3rem 0 0.9rem' }}>
        {isMine
          ? 'Every park sign you have photographed. Each park comes back around next season.'
          : 'Every park sign they have photographed. Nobody competes over parks, so this '
            + 'costs you nothing — and the same parks are still there for you.'}
      </p>

      {/* Whose binder. Yours first, then everybody else — this is the whole point of
          making collections public, so it is a control rather than a deep link. */}
      {players.length > 1 && (
        <div className="cluster" style={{ marginBottom: '0.8rem' }}>
          {[...players].sort((a, b) => (a.id === me?.id ? -1 : b.id === me?.id ? 1 : 0))
            .map((p) => {
              const active = p.id === (viewing ?? me?.id);
              return (
                <button key={p.id}
                        className={`btn btn-sm ${active ? 'btn-primary' : 'btn-ghost'}`}
                        aria-pressed={active}
                        onClick={() => navigate(p.id === me?.id ? '/binder' : `/binder/${p.id}`)}>
                  <i className="dot" style={{ background: p.colour }} />
                  {p.id === me?.id ? 'You' : p.display_name}
                </button>
              );
            })}
        </div>
      )}

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
          {isMine
            ? 'Nothing here yet. Open a Hood on the map and tap Parkemans GO.'
            : 'They have not collected anything yet.'}
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
