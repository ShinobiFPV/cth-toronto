// Snapping a car. Longer than a park, for two reasons the sheet says out loud:
//
//   - The weekly cap. Capacity is shown before the shutter, not after, so a player who
//     snaps three cars past it already knows why no points moved — otherwise it gets
//     filed as a bug.
//   - The identify call. The server asks what the car is between the upload and the
//     package, which takes a few seconds, so the sheet says "Identifying…" instead of
//     leaving a dead spinner.
import { useEffect, useRef, useState } from 'react';
import { api, uploadCar } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { CameraIcon, CloseIcon } from './icons.jsx';
import { Banner, Spinner } from './bits.jsx';
import { CAPTION_MAX } from './Caption.jsx';
import NotWheelsPack from './NotWheelsPack.jsx';

const HEIC = /\.(heic|heif)$/i;
const isHeic = (f) => HEIC.test(f.name || '') || /image\/hei[cf]/i.test(f.type || '');

// The Hood you last snapped a car in. Per device, like appearance, and wrapped because a
// private window throws on access rather than returning null.
const HOOD_KEY = 'cth.garage.hood';
const readHood = () => { try { return Number(localStorage.getItem(HOOD_KEY)) || null; } catch { return null; } };
const saveHood = (id) => { try { localStorage.setItem(HOOD_KEY, String(id)); } catch { /* fine */ } };

// Failures the photo can fix. Everything else is information or a retry of the same shot.
const RETAKE = new Set(['IDENTIFY_UNSURE', 'NOT_A_VEHICLE']);

function CapacityLine({ capacity }) {
  if (!capacity) return <>Checking this week…</>;
  if (capacity.xp_only) {
    return <><b>XP only</b> — points reset {capacity.resets_on}</>;
  }
  return (
    <>
      <b className="num">{capacity.spent} / {capacity.cap}</b> this week · this one +{capacity.next_award}
    </>
  );
}

export default function CarCollect({ onClose, onDone }) {
  const { hoods, refreshMe } = useGame();
  const [capacity, setCapacity] = useState(null);
  const [hoodId, setHoodId] = useState(readHood);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [caption, setCaption] = useState('');
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState('pick');      // pick | uploading | identifying | done
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const cameraInput = useRef(null);
  const libraryInput = useRef(null);
  const busy = phase === 'uploading' || phase === 'identifying';

  useEffect(() => {
    api.carCapacity().then((r) => setCapacity(r.capacity)).catch(() => {});
  }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const pick = async (event) => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    setError(null);

    let usable = chosen;
    if (isHeic(chosen)) {
      setConverting(true);
      try {
        const { default: heic2any } = await import('heic2any');
        const blob = await heic2any({ blob: chosen, toType: 'image/jpeg', quality: 0.92 });
        usable = new File([Array.isArray(blob) ? blob[0] : blob],
          chosen.name.replace(HEIC, '.jpg'), { type: 'image/jpeg' });
      } catch {
        usable = chosen;     // the server's fallback can have a go
      } finally {
        setConverting(false);
      }
    }

    if (preview) URL.revokeObjectURL(preview);
    setFile(usable);
    setPreview(URL.createObjectURL(usable));
  };

  const submit = async () => {
    if (!file || !hoodId || busy) return;
    saveHood(hoodId);
    setPhase('uploading');
    setError(null);
    setProgress(0);
    try {
      const form = new FormData();
      form.append('hood_id', String(hoodId));
      if (caption.trim()) form.append('caption', caption.trim());
      form.append('photo', file, file.name);
      const res = await uploadCar(form, (p) => {
        setProgress(p);
        // The bytes are there; the wait from here on is the identifier.
        if (p >= 1) setPhase('identifying');
      });
      setResult(res);
      setCapacity(res.capacity);
      setPhase('done');
      refreshMe().catch(() => {});
      onDone?.(res);
    } catch (err) {
      setError({ code: err.code, message: err.message || 'That did not go through.' });
      setPhase('pick');
      api.carCapacity().then((r) => setCapacity(r.capacity)).catch(() => {});
    }
  };

  const retake = () => cameraInput.current?.click();

  return (
    <>
      <div className="scrim" onClick={() => !busy && onClose()} />
      <div className="bottom-sheet" role="dialog" aria-modal="true" aria-label="Snap a car">
        <div className="sheet-head">
          <div className="grow">
            <h1>{phase === 'done' ? (result?.repeat ? 'Spotted again' : 'In the Case') : 'Snap a car'}</h1>
            <div className="tiny dim"><CapacityLine capacity={capacity} /></div>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close" disabled={busy}>
            <CloseIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <div className="sheet-body stack">
          {phase === 'done' && result ? (
            <>
              <div className="nwpack-reveal">
                <NotWheelsPack card={result.package} />
              </div>
              <div className="tiny" style={{ textAlign: 'center' }}>
                {result.repeat
                  ? `You already have this one — +${result.xp.xp} XP for spotting it again.`
                  : result.points > 0
                    ? `+${result.points} points · +${result.xp.xp} XP · ${result.capacity.spent} / ${result.capacity.cap} this week`
                    : `Past this week's cap, so XP only — +${result.xp.xp} XP. Points come back ${result.capacity.resets_on}.`}
                {result.first_sighting && ' The first one anybody has put in the Garage.'}
              </div>
              {result.level_up && (
                <Banner kind="ok">Level {result.level_up.to} — {result.level_up.title}</Banner>
              )}
            </>
          ) : (
            <>
              <div className="tiny dim">
                Any car on the street. Get the whole thing in — side-on or three-quarters is
                what the identifier reads best. One package per car per season; plates are
                blurred before anybody else sees the photo.
              </div>

              <div>
                <label className="tiny dim" htmlFor="car-hood">Where is it?</label>
                <select id="car-hood" className="caption-input" value={hoodId ?? ''} disabled={busy}
                        onChange={(e) => setHoodId(Number(e.target.value) || null)}>
                  <option value="" disabled>Pick the Hood</option>
                  {hoods.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
                </select>
              </div>

              {preview ? (
                <>
                  <img className="sheet-photo" src={preview} alt="Your photo of the car" />
                  <div className="cluster">
                    <button className="btn btn-sm" onClick={retake} disabled={busy}>Retake</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => libraryInput.current?.click()} disabled={busy}>
                      Choose another
                    </button>
                    <span className="tiny dim">{(file.size / 1048576).toFixed(1)} MB</span>
                  </div>
                </>
              ) : (
                <div className="cluster">
                  <button className="btn grow" onClick={retake} disabled={converting || busy}>
                    <CameraIcon style={{ width: 18, height: 18 }} /> Take photo
                  </button>
                  <button className="btn btn-ghost grow" onClick={() => libraryInput.current?.click()} disabled={converting || busy}>
                    Upload
                  </button>
                </div>
              )}

              {converting && <div className="tiny dim">Converting from HEIC…</div>}

              {preview && (
                <div>
                  <input className="caption-input" value={caption} maxLength={CAPTION_MAX}
                         placeholder="Flavour text for the package (optional)" disabled={busy}
                         onChange={(e) => setCaption(e.target.value)} />
                  <div className="cluster tiny dim" style={{ marginTop: '0.3rem' }}>
                    <span className="grow">Printed on the backing card.</span>
                    <span>{CAPTION_MAX - caption.length}</span>
                  </div>
                </div>
              )}

              {error && (
                <Banner kind={error.code === 'IDENTIFY_UNSURE' || error.code === 'ALREADY_COLLECTED' ? 'info' : 'bad'}>
                  {error.message}
                  {RETAKE.has(error.code) && (
                    <div style={{ marginTop: '0.4rem' }}>
                      <button className="btn btn-sm" onClick={retake}>
                        <CameraIcon style={{ width: 14, height: 14 }} /> Try another angle
                      </button>
                    </div>
                  )}
                </Banner>
              )}
            </>
          )}

          <input ref={cameraInput} type="file" accept="image/*" capture="environment" onChange={pick} hidden />
          <input ref={libraryInput} type="file" accept="image/*" onChange={pick} hidden />
        </div>

        {/* Outside the scrolling body, like every sheet with an action: this one carries
            the most content of any of them. */}
        <div className="sheet-actions">
          {busy && (
            <div>
              <div className="progress-bar">
                <i style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <div className="tiny dim cluster" style={{ marginTop: '0.3rem', gap: '0.4rem' }}>
                {phase === 'uploading'
                  ? `Uploading ${Math.round(progress * 100)}%`
                  : <><Spinner /> Identifying… asking what it is. A few seconds longer than a park.</>}
              </div>
            </div>
          )}

          {phase === 'done' ? (
            <button className="btn btn-primary btn-block" onClick={onClose}>Done</button>
          ) : (
            <button className="btn btn-primary btn-block" disabled={!file || !hoodId || busy} onClick={submit}>
              {busy ? 'Sending…'
                : !hoodId ? 'Pick the Hood first'
                : capacity?.xp_only ? 'Snap it (XP only)'
                : `Snap it (+${capacity?.next_award ?? 5})`}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
