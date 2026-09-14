// One photo for one hunt item.
//
// The camera confirms; it does not gatekeep. When it cannot tell — a four-year-old's bird is
// a grey smudge in a corner — the sheet offers "I'm sure — mark it anyway", which marks the
// item and tells the group, or another photo. It never says the player was wrong.
//
// A street photo also goes through the ordinary car pipeline, so it may print a card. The two
// are independent: a car already in the binder still ticks its slot.
import { useEffect, useRef, useState } from 'react';
import { api, uploadHuntPhoto } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { playSound } from '../lib/audio.js';
import { itemList } from '../lib/items.js';
import { CameraIcon, CloseIcon } from './icons.jsx';
import { Banner, Spinner } from './bits.jsx';

const HEIC = /\.(heic|heif)$/i;
const isHeic = (f) => HEIC.test(f.name || '') || /image\/hei[cf]/i.test(f.type || '');

// The same remembered Hood as Snap a car: a street hunt is usually snapped from the same street.
const HOOD_KEY = 'cth.cars.hood';
const readHood = () => { try { return Number(localStorage.getItem(HOOD_KEY)) || null; } catch { return null; } };
const saveHood = (id) => { try { localStorage.setItem(HOOD_KEY, String(id)); } catch { /* fine */ } };

function Rewards({ completion }) {
  if (completion.reason === 'no_season') {
    return <div className="tiny dim" style={{ textAlign: 'center' }}>Between seasons, so there is nothing to pay into.</div>;
  }
  return (
    <div className="tiny" style={{ textAlign: 'center' }}>
      {completion.points > 0 && `+${completion.points} points · `}+{completion.xp} XP
      {completion.items.length > 0 && (
        <div style={{ color: 'var(--accent-text)' }}>And {completion.items.length} items: {itemList(completion.items)}</div>
      )}
      {completion.reason === 'weekly_limit' && (
        <div className="dim">Past this week’s {completion.week_limit} scoring hunts, so XP only. Points come back {completion.resets_on}.</div>
      )}
      {completion.reason === 'season_cap' && (
        <div className="dim">That is the season’s hunt points used up ({completion.season_cap}). XP still counts.</div>
      )}
    </div>
  );
}

export default function HuntSubmit({ hunt, item, onClose, onChange }) {
  const { hoods, refreshMe, itemsChanged } = useGame();
  const street = hunt.kind === 'street';
  const [hoodId, setHoodId] = useState(readHood);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState(0);
  // pick | uploading | checking | unsure | found
  const [phase, setPhase] = useState(item.pending ? 'unsure' : 'pick');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const cameraInput = useRef(null);
  const libraryInput = useRef(null);
  const busy = phase === 'uploading' || phase === 'checking';

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
    setPhase('pick');
  };

  const landed = (res) => {
    setResult(res);
    refreshMe().catch(() => {});
    if (res.completion?.items?.length || res.car_items?.items?.length) itemsChanged();
    onChange?.();
  };

  const submit = async () => {
    if (!file || busy || (street && !hoodId)) return;
    if (street) saveHood(hoodId);
    setPhase('uploading');
    setError(null);
    setProgress(0);
    try {
      const form = new FormData();
      form.append('slot', String(item.slot));
      if (street) form.append('hood_id', String(hoodId));
      form.append('photo', file, file.name);
      const res = await uploadHuntPhoto(hunt.id, form, (p) => {
        setProgress(p);
        if (p >= 1) setPhase('checking');
      });
      landed(res);
      if (res.verified) {
        playSound(res.completion ? 'edition_gold' : 'collect_park');
        setPhase('found');
      } else {
        setPhase('unsure');
      }
    } catch (err) {
      playSound('blocked');
      setError(err.message || 'That did not go through.');
      setPhase('pick');
    }
  };

  const markAnyway = async () => {
    setPhase('checking');
    setError(null);
    try {
      const res = await api.overrideHunt(hunt.id, item.slot);
      landed({ ...res, verified: false, overridden: true });
      playSound(res.completion ? 'edition_gold' : 'collect_park');
      setPhase('found');
    } catch (err) {
      playSound('blocked');
      setError(err.message);
      setPhase('unsure');
    }
  };

  const another = () => {
    setFile(null);
    setPreview(null);
    setPhase('pick');
    cameraInput.current?.click();
  };

  const completion = result?.completion ?? null;

  return (
    <>
      <div className="scrim" onClick={() => !busy && onClose()} />
      <div className="bottom-sheet" role="dialog" aria-modal="true" aria-label={`Find ${item.label}`}>
        <div className="sheet-head">
          <div className="grow" style={{ minWidth: 0 }}>
            <h1 className="truncate">{completion ? 'Hunt complete!' : item.label}</h1>
            <div className="tiny dim truncate">{hunt.title}</div>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close" disabled={busy}>
            <CloseIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <div className="sheet-body stack">
          {phase === 'found' && (
            <>
              <div className="hunt-found">{completion ? 'All five!' : 'Found it!'}</div>
              {result?.overridden && (
                <div className="tiny dim" style={{ textAlign: 'center' }}>
                  Marked by hand — everybody has been told, and they can flag it.
                </div>
              )}
              {completion && <Rewards completion={completion} />}
              {result?.card && (
                <div className="tiny" style={{ textAlign: 'center' }}>
                  It printed a {result.card.name ?? 'car'} card for your binder too.
                </div>
              )}
              {result?.level_up && <Banner kind="ok">Level {result.level_up.to} — {result.level_up.title}</Banner>}
            </>
          )}

          {phase === 'unsure' && (
            <Banner kind="info">
              The camera could not tell whether that is {item.label.toLowerCase()}.
              {result?.reason ? ` ${result.reason}` : ''} If it is, say so — or try another photo.
            </Banner>
          )}

          {(phase === 'pick' || busy) && (
            <>
              <div className="tiny dim">
                {street
                  ? 'Get the whole car in, side-on or three-quarters. The years are a range because nobody can see a model year — any car from that generation counts. Plates are blurred.'
                  : 'Get it in the photo — it does not need to fill the frame. This photo stays with you.'}
              </div>

              {street && (
                <div>
                  <label className="tiny dim" htmlFor="hunt-hood">Where is it?</label>
                  <select id="hunt-hood" className="caption-input" value={hoodId ?? ''} disabled={busy}
                          onChange={(e) => setHoodId(Number(e.target.value) || null)}>
                    <option value="" disabled>Pick the Hood</option>
                    {hoods.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
                  </select>
                </div>
              )}

              {preview ? (
                <>
                  <img className="sheet-photo" src={preview} alt={`Your photo of ${item.label}`} />
                  <div className="cluster">
                    <button className="btn btn-sm" onClick={() => cameraInput.current?.click()} disabled={busy}>Retake</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => libraryInput.current?.click()} disabled={busy}>
                      Choose another
                    </button>
                  </div>
                </>
              ) : (
                <div className="cluster">
                  <button className="btn grow" onClick={() => cameraInput.current?.click()} disabled={converting || busy}>
                    <CameraIcon style={{ width: 18, height: 18 }} /> Take photo
                  </button>
                  <button className="btn btn-ghost grow" onClick={() => libraryInput.current?.click()} disabled={converting || busy}>
                    Upload
                  </button>
                </div>
              )}
              {converting && <div className="tiny dim">Converting from HEIC…</div>}
            </>
          )}

          {error && <Banner kind="bad">{error}</Banner>}

          <input ref={cameraInput} type="file" accept="image/*" capture="environment" onChange={pick} hidden />
          <input ref={libraryInput} type="file" accept="image/*" onChange={pick} hidden />
        </div>

        <div className="sheet-actions">
          {busy && (
            <div>
              <div className="progress-bar">
                <i style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <div className="tiny dim cluster" style={{ marginTop: '0.3rem', gap: '0.4rem' }}>
                {phase === 'uploading' ? `Uploading ${Math.round(progress * 100)}%` : <><Spinner /> Looking…</>}
              </div>
            </div>
          )}

          {phase === 'found' && (
            <button className="btn btn-primary btn-block" onClick={onClose}>{completion ? 'Brilliant' : 'Next one'}</button>
          )}
          {phase === 'unsure' && (
            <>
              <button className="btn btn-primary btn-block" onClick={markAnyway}>I’m sure — mark it anyway</button>
              <button className="btn btn-block" onClick={another}>
                <CameraIcon style={{ width: 16, height: 16 }} /> Try another photo
              </button>
            </>
          )}
          {(phase === 'pick' || busy) && (
            <button className="btn btn-primary btn-block" disabled={!file || busy || (street && !hoodId)} onClick={submit}>
              {busy ? 'Sending…' : street && !hoodId ? 'Pick the Hood first' : 'Send it'}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
