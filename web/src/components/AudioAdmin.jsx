// The sound board: every slot, what it plays now, and the controls to change it. Admin only.
//
// Preview is non-negotiable — nobody can choose a sound without hearing it. Uploads are
// converted on the Pi to the standard format, so a 40 MB WAV never reaches a phone, and each
// slot has a gain slider, because fixing one loud cue should not mean re-exporting it.
// Every change reaches every phone as a new URL (server/lib/audio.js), so nothing is left
// playing the old sound out of a cache.
import { useEffect, useState } from 'react';
import { api, uploadAudio } from '../lib/api.js';
import { previewClip, audioChanged } from '../lib/audio.js';
import { Banner, Spinner } from './bits.jsx';
import { PlayIcon } from './icons.jsx';

function SlotRow({ slot, busy, onUpload, onPatch, onReset }) {
  const [gain, setGain] = useState(slot.gain);
  const [licence, setLicence] = useState(slot.licence ?? '');
  useEffect(() => { setGain(slot.gain); }, [slot.gain]);
  useEffect(() => { setLicence(slot.licence ?? ''); }, [slot.licence]);

  const commitGain = () => { if (gain !== slot.gain) onPatch({ gain }); };
  const commitLicence = () => {
    if ((licence.trim() || null) !== (slot.licence || null)) onPatch({ licence: licence.trim() });
  };

  return (
    <div className="sheet-body stack sound-slot">
      <div className="cluster">
        <b className="grow">{slot.label}</b>
        <span className={`chip ${slot.source === 'override' ? 'chip-accent' : ''}`}>
          {slot.source === 'override' ? 'custom' : slot.source === 'default' ? 'default' : 'no file'}
        </span>
      </div>
      <div className="tiny dim">
        <code>{slot.key}</code> · {slot.fires}
        {slot.duration_s ? ` · ${slot.duration_s}s` : ''}
      </div>

      <div className="cluster">
        <button className="btn btn-sm" disabled={!slot.url} onClick={() => previewClip(slot.url, gain)}>
          <PlayIcon style={{ width: 14, height: 14 }} /> Preview
        </button>
        <label className="btn btn-sm btn-ghost" aria-disabled={busy}>
          Replace…
          <input type="file" accept="audio/*" hidden disabled={busy}
                 onChange={(e) => {
                   const file = e.target.files?.[0];
                   e.target.value = '';
                   if (file) onUpload(file, licence);
                 }} />
        </label>
        <button className="btn btn-sm btn-ghost"
                disabled={busy || (slot.source !== 'override' && slot.gain === slot.default_gain)}
                onClick={onReset}>
          Reset to default
        </button>
        {busy && <Spinner />}
      </div>

      <label className="tiny dim">
        Gain {gain.toFixed(2)}
        <input className="gain-slider" type="range" min="0" max="1.5" step="0.05" value={gain}
               disabled={busy}
               onChange={(e) => setGain(Number(e.target.value))}
               onPointerUp={commitGain} onKeyUp={commitGain} onBlur={commitGain} />
      </label>

      <input className="caption-input" value={licence} maxLength={160} disabled={busy}
             placeholder="Licence — e.g. CC0 / freesound 123456"
             onChange={(e) => setLicence(e.target.value)} onBlur={commitLicence} />
    </div>
  );
}

export default function AudioAdmin() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = () => api.adminAudio().then(setData).catch((err) => setError(err.message));
  useEffect(() => { load(); }, []);

  const act = async (key, run, said) => {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      await run();
      setNote(said);
      await load();
      audioChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h2 style={{ marginBottom: '0.5rem' }}>Sounds</h2>
      {error && <Banner kind="bad">{error}</Banner>}
      {note && <Banner kind="ok">{note}</Banner>}

      {!data ? <div className="empty"><Spinner /></div> : (
        <div className="sheet">
          {data.slots.map((slot) => (
            <SlotRow
              key={slot.key}
              slot={slot}
              busy={busy === slot.key}
              onUpload={(file, licence) => {
                const form = new FormData();
                form.append('file', file, file.name);
                if (licence.trim()) form.append('licence', licence.trim());
                act(slot.key, () => uploadAudio(slot.key, form), `${slot.label} replaced.`);
              }}
              onPatch={(body) => act(slot.key, () => api.setAudioMeta(slot.key, body), `${slot.label} updated.`)}
              onReset={() => act(slot.key, () => api.resetAudio(slot.key), `${slot.label} is back to the default.`)}
            />
          ))}
        </div>
      )}

      {data && (
        <div className="tiny dim" style={{ marginTop: '0.4rem' }}>
          Up to {data.limits.max_upload_mb} MB; cues up to {data.limits.max_effect_s}s, music up
          to {data.limits.max_music_s}s. Converted on the server to AAC and levelled. The repo is
          public, so use CC0 sounds only, and write the licence down for each one.
        </div>
      )}
    </div>
  );
}
