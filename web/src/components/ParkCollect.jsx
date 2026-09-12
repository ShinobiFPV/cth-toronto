// Collecting a park: one photo of the sign. No subject to declare, no counter rule, no
// cooldown — which is why this is a much shorter flow than a territory claim.
import { useEffect, useRef, useState } from 'react';
import { uploadPark } from '../lib/api.js';
import { CameraIcon, CloseIcon } from './icons.jsx';
import { Banner } from './bits.jsx';
import { CAPTION_MAX } from './Caption.jsx';

const HEIC = /\.(heic|heif)$/i;
const isHeic = (f) => HEIC.test(f.name || '') || /image\/hei[cf]/i.test(f.type || '');

export default function ParkCollect({ park, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [caption, setCaption] = useState('');
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
        usable = chosen;     // let the server's fallback have a go
      } finally {
        setConverting(false);
      }
    }

    if (preview) URL.revokeObjectURL(preview);
    setFile(usable);
    setPreview(URL.createObjectURL(usable));
  };

  const submit = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const form = new FormData();
      form.append('photo', file, file.name);
      if (caption.trim()) form.append('caption', caption.trim());
      const res = await uploadPark(park.id, form, setProgress);
      onDone?.(res.card, res);
    } catch (err) {
      setError(err.message || 'That did not go through.');
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sheet-head">
        <div className="grow">
          <h1>Collect {park.name}</h1>
          <div className="tiny dim">
            {park.rarity_label} · +{park.value} · {park.hood_label}
          </div>
        </div>
        <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close" disabled={busy}>
          <CloseIcon style={{ width: 16, height: 16 }} />
        </button>
      </div>

      <div className="sheet-body stack">
        <div className="tiny dim">
          Photograph the park sign — the one with <b>{park.name}</b> on it. That name in the
          frame is the whole proof, so get close enough to read it.
        </div>

        {preview ? (
          <>
            <img className="sheet-photo" src={preview} alt="Your photo of the park sign" />
            <div className="cluster">
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

        {converting && <div className="tiny dim">Converting from HEIC…</div>}

        <input ref={cameraInput} type="file" accept="image/*" capture="environment" onChange={pick} hidden />
        <input ref={libraryInput} type="file" accept="image/*" onChange={pick} hidden />

        {/* On a card this becomes the flavour text along the bottom edge. */}
        {preview && (
          <div>
            <input
              className="caption-input"
              value={caption}
              maxLength={CAPTION_MAX}
              placeholder="Flavour text for the card (optional)"
              disabled={busy}
              onChange={(e) => setCaption(e.target.value)}
            />
            <div className="cluster tiny dim" style={{ marginTop: '0.3rem' }}>
              <span className="grow">Printed on the card, under the park.</span>
              <span>{CAPTION_MAX - caption.length}</span>
            </div>
          </div>
        )}

        {error && <Banner kind="bad">{error}</Banner>}

        {/* Pinned to the bottom of the sheet: with a preview and a caption on screen at
            once this button otherwise falls past the bottom edge of a small phone. */}
        <div className="sheet-actions">
          {busy && (
            <div>
              <div className="progress-bar">
                <i style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <div className="tiny dim" style={{ marginTop: '0.3rem' }}>
                {progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Printing your card…'}
              </div>
            </div>
          )}

          <button className="btn btn-primary btn-block" disabled={!file || busy} onClick={submit}>
            {busy ? 'Sending…' : `Collect (+${park.value})`}
          </button>
        </div>
      </div>
    </>
  );
}
