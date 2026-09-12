// Capture: pick the subject, shoot or choose the photo, confirm, upload.
//
// The subject is chosen BEFORE the camera opens, because the server can already say
// which subjects this Hood will accept — there is no reason to let somebody shoot a
// landmark for a Hood that needs an animal and only find out after the upload.
import { useEffect, useRef, useState } from 'react';
import { uploadClaim } from '../lib/api.js';
import { SUBJECTS, SUBJECT_BLURB, KIND_VERB, article, until } from '../lib/game.js';
import { SUBJECT_ICON, CameraIcon, CloseIcon } from './icons.jsx';
import { Banner } from './bits.jsx';

const HEIC = /\.(heic|heif)$/i;
const isHeic = (f) => HEIC.test(f.name || '') || /image\/hei[cf]/i.test(f.type || '');

export default function ClaimFlow({ hood, onClose, onDone }) {
  const viewer = hood.viewer ?? {};
  const allowed = viewer.required_types ?? SUBJECTS;

  const [subject, setSubject] = useState(allowed.length === 1 ? allowed[0] : null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const cameraInput = useRef(null);
  const libraryInput = useRef(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const pick = async (event) => {
    const chosen = event.target.files?.[0];
    event.target.value = '';                    // let the same file be re-picked
    if (!chosen) return;
    setError(null);

    let usable = chosen;
    // iPhones hand out HEIC unless the owner has switched to Most Compatible.
    // Converting here keeps the work off the Pi; the server has its own fallback for
    // the ones that get through, and a clear message if neither path works.
    if (isHeic(chosen)) {
      setConverting(true);
      try {
        const { default: heic2any } = await import('heic2any');
        const blob = await heic2any({ blob: chosen, toType: 'image/jpeg', quality: 0.92 });
        const out = Array.isArray(blob) ? blob[0] : blob;
        usable = new File([out], chosen.name.replace(HEIC, '.jpg'), { type: 'image/jpeg' });
      } catch {
        // Not fatal — send the original and let the server try.
        usable = chosen;
      } finally {
        setConverting(false);
      }
    }

    if (preview) URL.revokeObjectURL(preview);
    setFile(usable);
    setPreview(URL.createObjectURL(usable));
  };

  const submit = async () => {
    if (!subject || !file || busy) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const form = new FormData();
      form.append('photo', file, file.name);
      form.append('photo_type', subject);
      const { claim } = await uploadClaim(hood.id, form, setProgress);
      onDone?.(claim);
    } catch (err) {
      setError(err.message || 'That did not go through.');
      setBusy(false);
    }
  };

  const verb = KIND_VERB[viewer.claim_kind] ?? 'Claim';

  return (
    <>
      <div className="sheet-head">
        <div className="grow">
          <h1>{verb} {hood.label}</h1>
          <div className="tiny dim">
            {viewer.claim_kind === 'conquer' ? 'Unclaimed — any subject takes it'
              : `Held with ${article(hood.photo_type)} photo`}
            {' · '}+{viewer.points} points
          </div>
        </div>
        <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close" disabled={busy}>
          <CloseIcon style={{ width: 16, height: 16 }} />
        </button>
      </div>

      <div className="sheet-body stack">
        {!viewer.can_claim && (
          <Banner kind="bad">
            {viewer.message}
            {viewer.available_at && ` (${until(viewer.available_at)} to go)`}
          </Banner>
        )}

        <div>
          <h2 style={{ marginBottom: '0.5rem' }}>1 · What is the photo of?</h2>
          <div className="stack" style={{ gap: '0.5rem' }}>
            {SUBJECTS.map((s) => {
              const Icon = SUBJECT_ICON[s];
              const ok = allowed.includes(s);
              return (
                <button
                  key={s}
                  className={`btn ${subject === s ? 'btn-primary' : ''}`}
                  style={{ justifyContent: 'flex-start', textAlign: 'left', minHeight: 56 }}
                  disabled={!ok || busy}
                  aria-pressed={subject === s}
                  onClick={() => setSubject(s)}
                >
                  <Icon style={{ width: 22, height: 22, flex: 'none' }} />
                  <span className="grow">
                    <b style={{ display: 'block', letterSpacing: '0.08em' }}>{s}</b>
                    <span className="tiny" style={{ textTransform: 'none', letterSpacing: 0, opacity: 0.75 }}>
                      {ok ? SUBJECT_BLURB[s] : `Does not beat ${article(hood.photo_type)} photo`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <h2 style={{ marginBottom: '0.5rem' }}>2 · The photo</h2>

          {preview ? (
            <>
              <img className="sheet-photo" src={preview} alt="Your photo, ready to upload" />
              <div className="cluster" style={{ marginTop: '0.6rem' }}>
                <button className="btn btn-sm" onClick={() => cameraInput.current?.click()} disabled={busy}>
                  Retake
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => libraryInput.current?.click()} disabled={busy}>
                  Choose another
                </button>
                <span className="tiny dim">{(file.size / 1048576).toFixed(1)} MB</span>
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

          {converting && <div className="tiny dim" style={{ marginTop: '0.5rem' }}>Converting from HEIC…</div>}

          {/* `capture` hands off to the native camera; the second input is for drone
              and standalone-camera shots already on the device. */}
          <input ref={cameraInput} type="file" accept="image/*" capture="environment"
                 onChange={pick} hidden />
          <input ref={libraryInput} type="file" accept="image/*" onChange={pick} hidden />
        </div>

        <div className="tiny dim">
          Honour system: the photo has to be recent, shot inside {hood.label}, and it has
          to actually show {subject ? article(subject) : 'the subject you declared'}.
          Nobody checks. Everybody can flag.
        </div>

        {error && <Banner kind="bad">{error}</Banner>}

        {busy && (
          <div>
            <div style={{ height: 6, background: 'var(--surface-2)', border: '2px solid var(--border)' }}>
              <div style={{ height: '100%', width: `${Math.round(progress * 100)}%`, background: 'var(--accent)' }} />
            </div>
            <div className="tiny dim" style={{ marginTop: '0.3rem' }}>
              {progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Processing on the server…'}
            </div>
          </div>
        )}

        <button className="btn btn-primary btn-block"
                disabled={!subject || !file || busy || !viewer.can_claim}
                onClick={submit}>
          {busy ? 'Sending…' : `${verb} (+${viewer.points})`}
        </button>
      </div>
    </>
  );
}
