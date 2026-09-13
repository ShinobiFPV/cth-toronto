// The Case: every Not Wheels package somebody holds. The Garage half of the Cards tab.
//
// Public, like a binder, for the same reason — nobody loses anything when you photograph
// a car, and comparing pulls is most of the fun. Only your own Case has the camera
// button and this week's capacity on it.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { CameraIcon, CloseIcon, SwapIcon } from './icons.jsx';
import { Spinner } from './bits.jsx';
import NotWheelsPack from './NotWheelsPack.jsx';
import CarCollect from './CarCollect.jsx';

// Rarest first, as everywhere editions are listed.
const EDITION_ORDER = ['hologram', 'gold', 'steel'];

export default function Case({ viewing, isMine, onOffer }) {
  const { session, players } = useGame();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState('season');
  const [edition, setEdition] = useState('all');
  const [zoom, setZoom] = useState(null);
  const [snapping, setSnapping] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.cards(scope === 'season' ? session?.season?.id : null, viewing, 'car')
      .then((r) => !cancelled && setData(r))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [scope, session?.season?.id, viewing, version]);

  useEffect(() => {
    if (!zoom) return undefined;
    const onKey = (e) => e.key === 'Escape' && setZoom(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  const packs = useMemo(() => {
    let list = [...(data?.cards ?? [])];
    if (edition !== 'all') list = list.filter((p) => p.edition === edition);
    return list.sort((a, b) =>
      EDITION_ORDER.indexOf(a.edition) - EDITION_ORDER.indexOf(b.edition)
      || b.claim_id - a.claim_id);
  }, [data, edition]);

  const s = data?.summary;
  const cap = s?.capacity;

  return (
    <>
      {isMine && (
        <button className="btn btn-primary btn-block" style={{ marginBottom: '0.8rem' }}
                onClick={() => setSnapping(true)}>
          <CameraIcon style={{ width: 18, height: 18 }} /> Snap a car
        </button>
      )}

      {s && (
        <div className="sheet" style={{ marginBottom: '0.9rem' }}>
          {isMine && cap && (
            <div className="row">
              <span className="grow dim">Car points this week</span>
              {cap.xp_only
                ? <b>XP only — resets {cap.resets_on}</b>
                : <><b className="num">{cap.spent}</b><span className="tiny dim">/ {cap.cap}</span></>}
            </div>
          )}
          <div className="row">
            <span className="grow dim">Snapped {s.season?.name ?? 'this season'}</span>
            <b className="num">{s.season_collected}</b>
          </div>
          <div className="row">
            <span className="grow dim">Points earned from cars, this season</span>
            <b className="num">{s.season_points}</b>
          </div>
          <div className="row">
            <span className="grow dim">Different cars, all time</span>
            <b className="num">{s.distinct_vehicles_all_time}</b>
            <span className="tiny dim">/ {s.catalogue_size} in the Garage</span>
          </div>
          <div className="row">
            <span className="grow dim">
              Packages in the Case
              {(s.packages_received > 0 || s.packages_given_away > 0) && (
                <span className="tiny"> · {s.packages_received} in, {s.packages_given_away} out</span>
              )}
            </span>
            <b className="num">{s.packages_held}</b>
          </div>
          {Object.keys(s.by_edition ?? {}).length > 0 && (
            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              {EDITION_ORDER.filter((e) => s.by_edition[e]).map((e) => (
                <span key={e} className={`chip ed-${e}`}>{s.by_edition[e]} {e}</span>
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
        {['all', ...EDITION_ORDER].map((e) => (
          <button key={e} className={`btn btn-sm ${edition === e ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setEdition(e)}>
            {e === 'all' ? 'Any print' : e}
          </button>
        ))}
      </div>

      {loading && <div className="empty"><Spinner /></div>}

      {!loading && !packs.length && (
        <div className="empty">
          {isMine
            ? 'The Case is empty. Every car on the street is a package waiting to be printed.'
            : 'They have not snapped a car yet.'}
        </div>
      )}

      <div className="card-grid">
        {packs.map((p) => (
          <div key={p.claim_id} className="card-slot">
            <NotWheelsPack card={p} compact onClick={() => setZoom(p)} />
            {p.traded && (
              <span className="card-from tiny" title={`Snapped by ${p.player.display_name}`}>
                <i className="dot" style={{ background: p.player.colour }} />
                {p.player.display_name}
              </span>
            )}
          </div>
        ))}
      </div>

      {zoom && (
        <div className="lightbox" onClick={() => setZoom(null)} role="dialog" aria-modal="true">
          <div onClick={(e) => e.stopPropagation()} className="stack" style={{ alignItems: 'center' }}>
            <NotWheelsPack card={zoom} />
            <div className="lightbox-note">
              Snapped by {zoom.player.display_name} in {zoom.hood?.label}
              {zoom.confidence != null && ` · identified ${Math.round(zoom.confidence * 100)}% sure`}
              {zoom.suspect && '. The identifier was not sure this is a real car on the street — flag it if you agree.'}
            </div>
            {isMine && players.length > 1 && (
              <button className="btn btn-primary" onClick={() => { onOffer?.(zoom); setZoom(null); }}>
                <SwapIcon style={{ width: 16, height: 16 }} /> Offer this package
              </button>
            )}
          </div>
          <button className="btn btn-sm" style={{ position: 'fixed', top: '1rem', right: '1rem' }}
                  onClick={() => setZoom(null)} aria-label="Close">
            <CloseIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>
      )}

      {snapping && (
        <CarCollect
          onClose={() => setSnapping(false)}
          onDone={() => setVersion((n) => n + 1)}
        />
      )}
    </>
  );
}
