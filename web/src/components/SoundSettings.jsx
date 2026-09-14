// Sound, on the profile screen. Two toggles, because they are two preferences: plenty of
// people want the Hologram sting while listening to their own music, and one switch would
// mean silencing the best moment in the game to turn off a background loop.
import { useEffect, useState } from 'react';
import { getAudioPrefs, onAudioPrefs, setAudioPrefs, playSound } from '../lib/audio.js';

function Toggle({ label, on, onChange }) {
  return (
    <div className="toggle" role="group" aria-label={label} style={{ marginBottom: '0.3rem' }}>
      <button aria-pressed={on} onClick={() => onChange(true)}>On</button>
      <button aria-pressed={!on} onClick={() => onChange(false)}>Off</button>
    </div>
  );
}

export default function SoundSettings() {
  const [prefs, setPrefs] = useState(getAudioPrefs);
  useEffect(() => onAudioPrefs(setPrefs), []);

  return (
    <div>
      <h2 style={{ marginBottom: '0.5rem' }}>Sound</h2>
      <div className="sheet">
        <div className="sheet-body stack" style={{ gap: '0.9rem' }}>
          <div>
            <div className="cluster" style={{ justifyContent: 'space-between' }}>
              <b>Music</b>
            </div>
            <Toggle label="Music" on={prefs.music} onChange={(music) => setAudioPrefs({ music })} />
            <div className="tiny dim">
              A quiet loop while you are on the map. Off unless you turn it on, so it never
              plays over your own music.
            </div>
          </div>

          <div>
            <div className="cluster" style={{ justifyContent: 'space-between' }}>
              <b>Sound effects</b>
              {prefs.effects && (
                <button className="btn btn-sm btn-ghost" onClick={() => playSound('edition_holo')}>
                  Test
                </button>
              )}
            </div>
            <Toggle label="Sound effects" on={prefs.effects}
                    onChange={(effects) => setAudioPrefs({ effects })} />
            <div className="tiny dim">
              Conquers, pulls, Fortifies, level-ups. Short and quiet, except the ones worth it.
            </div>
          </div>

          <div className="tiny dim">
            No sound on an iPhone? Check the silent switch on the side — it mutes the app
            completely, even with the volume up. Sound starts after your first tap. Saved on
            this device only.
          </div>
        </div>
      </div>
    </div>
  );
}
