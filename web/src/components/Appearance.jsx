// The appearance controls. Lives on the profile screen, which is this app's options page.
//
// There is no Apply button and no preview pane: changing either control repaints the
// whole app immediately, because the app IS the preview. That is only safe because the
// palette is CSS custom properties — nothing re-renders, the browser just recolours.
import { ACCENTS, MODES } from '../lib/theme.js';
import { useTheme } from '../lib/theme-context.jsx';

const MODE_LABEL = { system: 'System', light: 'Light', dark: 'Dark' };
const MODE_HINT = {
  system: 'Follows your phone or laptop, and changes with it.',
  light: 'Arctic Classified on paper — the original ShinTech house style.',
  dark: 'The after-dark variant this app was designed in.',
};

export default function Appearance() {
  const { appearance, resolved, setMode, setAccent } = useTheme();
  const active = ACCENTS.find((a) => a.key === appearance.accent) ?? ACCENTS[0];

  return (
    <div>
      <h2 style={{ marginBottom: '0.5rem' }}>Appearance</h2>

      <div className="sheet">
        <div className="sheet-body stack" style={{ gap: '0.9rem' }}>
          <div>
            <div className="toggle" role="group" aria-label="Colour scheme">
              {MODES.map((m) => (
                <button key={m} aria-pressed={appearance.mode === m} onClick={() => setMode(m)}>
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
            <div className="tiny dim">
              {MODE_HINT[appearance.mode]}
              {appearance.mode === 'system' && ` Currently ${resolved}.`}
            </div>
          </div>

          <div>
            <div className="cluster" style={{ justifyContent: 'space-between', marginBottom: '0.4rem' }}>
              <span className="tiny dim" style={{ textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                Accent
              </span>
              <span className="tiny dim">{active.name}</span>
            </div>

            <div className="swatches" role="radiogroup" aria-label="Accent colour">
              {ACCENTS.map((a) => (
                <button
                  key={a.key}
                  className="swatch"
                  style={{ '--sw': a.hex }}
                  role="radio"
                  aria-checked={appearance.accent === a.key}
                  aria-label={a.name}
                  title={a.name}
                  onClick={() => setAccent(a.key)}
                />
              ))}
            </div>

            <div className="tiny dim" style={{ marginTop: '0.5rem' }}>
              Dresses the chrome only. Player colours come from the server and never
              change, so nobody's territory can be recoloured out from under them.
            </div>
          </div>

          {/* Something accented to look at while choosing, without a fake preview pane. */}
          <div className="cluster">
            <button className="btn btn-primary btn-sm" type="button">Conquer (+50)</button>
            <span className="chip chip-accent">Legendary</span>
            <span className="chip">difficulty 50/50</span>
          </div>

          <div className="tiny dim">
            Saved on this device only — appearance belongs to the screen you are looking
            at, not to your account.
          </div>
        </div>
      </div>
    </div>
  );
}
