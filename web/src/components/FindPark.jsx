// Find a Park: the nearest parks you can still collect, worked out on this phone.
//
// Location never leaves the device. The fix comes from the browser, the park positions
// from a static index the service worker already holds, and the distances are computed
// right here. No request carries where you are — see server/lib/privacy.js.
//
// And it is not verification: nothing gates a collection on how close you are.
//
// Opened by a tap on Find a Park, which is the gesture that earns the permission prompt —
// never on load.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { getFix, locationSupported, secureContext } from '../lib/location.js';
import {
  nearestParks, capacityByHood, formatDistance, directionsUrl, locateFailure, accuracyWarning,
} from '../lib/nearby.js';
import { CloseIcon } from './icons.jsx';
import { Banner, Spinner } from './bits.jsx';

let indexLoad = null;
/** The park index, once per session. Precached, so this works offline. */
export const loadParkIndex = () => {
  indexLoad ??= fetch('/parks.index.json')
    .then((res) => { if (!res.ok) throw new Error(`parks.index.json ${res.status}`); return res.json(); })
    .catch((err) => { indexLoad = null; throw err; });
  return indexLoad;
};

export default function FindPark({ parks, onClose, onFocus }) {
  const navigate = useNavigate();
  const { hoods } = useGame();
  const [phase, setPhase] = useState('locating');     // locating | ready | failed
  const [fix, setFix] = useState(null);
  const [failure, setFailure] = useState(null);
  const [index, setIndex] = useState(null);
  const [indexFailed, setIndexFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [rules, setRules] = useState({ count: 5, warn: 200 });
  const [hoodPick, setHoodPick] = useState('');

  const locate = useCallback(async () => {
    setPhase('locating');
    setFailure(null);
    try {
      setFix(await getFix());
      setPhase('ready');
    } catch (err) {
      setFailure(locateFailure(err, { secure: secureContext(), supported: locationSupported() }));
      setPhase('failed');
    }
  }, []);

  useEffect(() => { locate(); }, [locate]);

  useEffect(() => {
    loadParkIndex().then(setIndex).catch(() => setIndexFailed(true));
    api.seasons()
      .then((s) => setRules({
        count: s.rules?.nearby_park_count ?? 5,
        warn: s.rules?.nearby_accuracy_warn_m ?? 200,
      }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const state = useMemo(() => new Map((parks?.parks ?? []).map((p) => [p.i, { v: p.v, c: p.c }])), [parks]);
  const capacity = useMemo(() => capacityByHood(hoods), [hoods]);
  const hoodLabel = useMemo(() => new Map(hoods.map((h) => [h.id, h.label])), [hoods]);
  const rows = useMemo(() => (fix && index
    ? nearestParks({ origin: fix, index, state, capacity, count: rules.count, includeCollected: showAll })
    : []), [fix, index, state, capacity, rules.count, showAll]);
  const warning = fix ? accuracyWarning(fix.accuracy, rules.warn) : null;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="bottom-sheet" role="dialog" aria-modal="true" aria-label="Find a park">
        <div className="sheet-head">
          <div className="grow">
            <h1>Find a park</h1>
            <div className="tiny dim">
              {showAll ? 'The nearest parks to you' : 'The nearest parks you can still collect'}
            </div>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">
            <CloseIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <div className="sheet-body stack">
          {phase === 'locating' && (
            <div className="empty"><Spinner /> Finding where you are…</div>
          )}

          {phase === 'failed' && failure && (
            <>
              <Banner kind="info">
                <b>{failure.title}.</b> {failure.message}
              </Banner>
              {/* Never a dead end: the Hood list gets you to the same parks by hand. */}
              <div className="cluster">
                <select className="caption-input grow" value={hoodPick} aria-label="Pick a Hood"
                        onChange={(e) => setHoodPick(e.target.value)}>
                  <option value="" disabled>Pick a Hood</option>
                  {hoods.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
                </select>
                <button className="btn btn-sm" disabled={!hoodPick}
                        onClick={() => navigate(`/hood/${hoodPick}/parks`)}>
                  See its parks
                </button>
              </div>
            </>
          )}

          {phase === 'ready' && (
            <>
              {warning && <Banner kind="info">{warning}</Banner>}
              {indexFailed && <Banner kind="bad">The park list did not load. Try again in a moment.</Banner>}

              <div className="toggle" role="group" aria-label="Which parks">
                <button aria-pressed={!showAll} onClick={() => setShowAll(false)}>Still to collect</button>
                <button aria-pressed={showAll} onClick={() => setShowAll(true)}>All parks</button>
              </div>

              {index && !rows.length && (
                <div className="empty">
                  {showAll ? 'No parks found.' : 'Nothing left to collect near here — or show all parks.'}
                </div>
              )}

              <div className="sheet">
                {rows.map((row) => (
                  <div key={row.id} className="find-row">
                    <button className="find-row-main" onClick={() => onFocus(row)}>
                      <span className="truncate" style={{ display: 'block', fontWeight: 700 }}>{row.name}</span>
                      <span className="tiny dim">
                        {formatDistance(row.distance_m)} · {hoodLabel.get(row.hood_id) ?? `Hood ${row.hood_id}`}
                      </span>
                    </button>
                    <span className="find-row-tags">
                      {row.collected
                        ? <span className="chip chip-ok">in binder</span>
                        : row.xp_only
                          ? <span className="chip" title="This Hood's park points are used up for now">XP only</span>
                          : row.award != null && <span className="chip chip-accent">+{row.award}</span>}
                      <a className="btn btn-sm btn-ghost" href={directionsUrl(row)} target="_blank" rel="noreferrer">
                        Directions
                      </a>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="tiny dim">
            Worked out on your phone. Your location is never sent anywhere — not to the game,
            not to the other players.
          </div>
        </div>

        <div className="sheet-actions">
          <button className="btn btn-primary btn-block" onClick={locate} disabled={phase === 'locating'}>
            {phase === 'failed' ? 'Try again' : 'Update my location'}
          </button>
        </div>
      </div>
    </>
  );
}
