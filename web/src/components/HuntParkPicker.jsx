// Picking the park for a park hunt: the nearest parks to you, and what each has that a hunt
// could ask for.
//
// The same guarantee as Find a Park. The fix comes from the browser, the positions from the
// static park index, and the distances are worked out here; /api/hunts/parks returns
// amenities only and is sent nothing about where you are. Mounted by a tap on Park hunt,
// never on load.
//
// A location narrows the list and never limits the choice: any park in any Hood can be
// picked by hand, which is also where this lands when there is no fix.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { getFix, locationSupported, secureContext } from '../lib/location.js';
import { nearestParks, formatDistance, locateFailure, accuracyWarning } from '../lib/nearby.js';
import { loadParkIndex } from './FindPark.jsx';
import { CloseIcon } from './icons.jsx';
import { Banner, Spinner } from './bits.jsx';

const NEAREST = 8;

function amenityText(list) {
  if (!list?.length) return 'everyday things only';
  return list.slice(0, 3).join(', ') + (list.length > 3 ? ` +${list.length - 3}` : '');
}

export default function HuntParkPicker({ busy, onClose, onPick }) {
  const { hoods } = useGame();
  const [phase, setPhase] = useState('locating');     // locating | ready | failed
  const [fix, setFix] = useState(null);
  const [failure, setFailure] = useState(null);
  const [index, setIndex] = useState(null);
  const [indexFailed, setIndexFailed] = useState(false);
  const [amenities, setAmenities] = useState({});
  const [hoodPick, setHoodPick] = useState('');

  const locate = useCallback(async () => {
    setPhase('locating');
    setFailure(null);
    setHoodPick('');
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
    api.huntParks().then((r) => setAmenities(r.parks ?? {})).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hoodLabel = useMemo(() => new Map(hoods.map((h) => [h.id, h.label])), [hoods]);
  const rows = useMemo(() => {
    if (!index) return [];
    if (hoodPick) {
      return index.filter((p) => p.h === Number(hoodPick))
        .map((p) => ({ id: p.i, name: p.n, hood_id: p.h, distance_m: null }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    }
    return fix ? nearestParks({ origin: fix, index, count: NEAREST, includeCollected: true }) : [];
  }, [index, fix, hoodPick]);
  const warning = fix && !hoodPick ? accuracyWarning(fix.accuracy, 200) : null;

  return (
    <>
      <div className="scrim" onClick={() => !busy && onClose()} />
      <div className="bottom-sheet" role="dialog" aria-modal="true" aria-label="Pick a park for the hunt">
        <div className="sheet-head">
          <div className="grow">
            <h1>Park hunt</h1>
            <div className="tiny dim">
              {hoodPick ? `Every park in ${hoodLabel.get(Number(hoodPick)) ?? 'that Hood'}` : 'The parks nearest to you'}
            </div>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close" disabled={busy}>
            <CloseIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <div className="sheet-body stack">
          {phase === 'locating' && !hoodPick && (
            <div className="empty"><Spinner /> Finding where you are…</div>
          )}
          {phase === 'failed' && failure && !hoodPick && (
            <Banner kind="info"><b>{failure.title}.</b> {failure.message} Pick a Hood instead.</Banner>
          )}
          {warning && <Banner kind="info">{warning}</Banner>}
          {indexFailed && <Banner kind="bad">The park list did not load. Try again in a moment.</Banner>}

          {rows.length > 0 && (
            <div className="sheet">
              {rows.map((row) => (
                <div key={row.id} className="find-row">
                  <button className="find-row-main" disabled={busy} onClick={() => onPick(row)}>
                    <span className="truncate" style={{ display: 'block', fontWeight: 700 }}>{row.name}</span>
                    <span className="tiny dim">
                      {row.distance_m != null
                        ? formatDistance(row.distance_m)
                        : hoodLabel.get(row.hood_id) ?? `Hood ${row.hood_id}`}
                      {' · '}{amenityText(amenities[row.id])}
                    </span>
                  </button>
                  <span className="find-row-tags">
                    <button className="btn btn-sm" disabled={busy} onClick={() => onPick(row)}>Start</button>
                  </span>
                </div>
              ))}
            </div>
          )}
          {hoodPick && index && !rows.length && <div className="empty">No parks in that Hood.</div>}

          <select className="caption-input" value={hoodPick} aria-label="Or pick a Hood"
                  onChange={(e) => setHoodPick(e.target.value)}>
            <option value="">{phase === 'ready' ? 'Or pick any Hood' : 'Pick a Hood'}</option>
            {hoods.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
          </select>

          <div className="tiny dim">
            A park hunt asks for things the park actually has, and things every park has.
            Worked out on your phone — your location is never sent anywhere.
          </div>
        </div>

        <div className="sheet-actions">
          <button className="btn btn-primary btn-block" onClick={locate} disabled={phase === 'locating' || busy}>
            {phase === 'failed' ? 'Try my location again' : 'Update my location'}
          </button>
        </div>
      </div>
    </>
  );
}
