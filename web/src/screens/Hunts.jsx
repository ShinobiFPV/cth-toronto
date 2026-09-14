// Scavenger Blitz: your hunts, and starting new ones.
//
// A hunt is five things to find — in a park, or five cars on the street. Three at a time and
// no time limit. The rules live in server/lib/hunts.js; this screen shows what is left and
// where the player stands on every limit, so a hunt that pays XP only is never a surprise.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { ago, until } from '../lib/game.js';
import { playSound } from '../lib/audio.js';
import { BackIcon, CarIcon, PinIcon } from '../components/icons.jsx';
import { Banner, Spinner } from '../components/bits.jsx';
import HuntParkPicker from '../components/HuntParkPicker.jsx';
import HuntSubmit from '../components/HuntSubmit.jsx';

function HuntItemRow({ item, onOpen }) {
  const state = item.done ? 'done' : item.pending ? 'pending' : '';
  const inner = (
    <>
      <span className="hunt-check" aria-hidden="true">{item.done ? '✓' : item.pending ? '?' : ''}</span>
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="hunt-label">{item.label}</span>
        <span className="tiny dim" style={{ display: 'block' }}>
          {item.done
            ? (item.overridden ? 'marked found by hand' : 'found')
            : item.pending ? 'the camera was not sure — tap to decide' : 'tap to send a photo'}
        </span>
      </span>
      {item.tier === 'uncommon' && <span className="chip">uncommon</span>}
      {item.thumb_url && <img className="hunt-thumb" src={item.thumb_url} alt="" />}
    </>
  );
  return onOpen
    ? <button className={`hunt-item ${state}`} onClick={onOpen}>{inner}</button>
    : <div className={`hunt-item ${state}`}>{inner}</div>;
}

export default function Hunts() {
  const navigate = useNavigate();
  const { itemsTick } = useGame();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  // The park picker asks for a location, so it only ever opens on a tap.
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(null);    // { hunt, item }
  // Abandoning is two taps, not a browser confirm: the first arms it, the second does it.
  const [abandoning, setAbandoning] = useState(null);

  const load = useCallback(() => api.hunts()
    .then((d) => setData(d))
    .catch((err) => setError(err.message)), []);
  useEffect(() => { load(); }, [load, itemsTick]);

  if (!data) {
    return <div className="empty">{error ? <Banner kind="bad">{error}</Banner> : <Spinner />}</div>;
  }

  const { active, recent, limits } = data;
  const full = limits.used >= limits.slots;
  const pastWeek = limits.week_limit > 0 && limits.week_scoring >= limits.week_limit;

  const start = async (kind, parkId = null) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const { hunt } = await api.startHunt(kind, parkId);
      setNote(`${hunt.title} is on. Five things — go and find them.`);
      await load();
    } catch (err) {
      playSound('blocked');
      setError(err.message);
    } finally {
      setPicking(false);
      setBusy(false);
    }
  };

  const abandon = async (hunt) => {
    setAbandoning(null);
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await api.abandonHunt(hunt.id);
      setNote(`${hunt.title} abandoned. The slot is free.`);
      await load();
    } catch (err) {
      playSound('blocked');
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen-pad stack">
      <div className="cluster">
        <button className="btn btn-sm btn-ghost" onClick={() => navigate(-1)}>
          <BackIcon style={{ width: 14, height: 14 }} /> Back
        </button>
      </div>

      <div>
        <h1>Scavenger Blitz</h1>
        <p className="tiny dim" style={{ margin: '0.3rem 0 0' }}>
          Five things to find, in a park or on the street. No time limit. A finished hunt pays
          +{limits.points_per_hunt}, {limits.items_per_hunt} items, and {limits.xp_park} XP in a
          park or {limits.xp_street} on the street.
        </p>
      </div>

      {note && <Banner kind="ok">{note}</Banner>}
      {error && <Banner kind="bad">{error}</Banner>}

      <div className="sheet">
        <div className="row">
          <span className="grow dim">Hunts going</span>
          <b className="num">{limits.used} / {limits.slots}</b>
        </div>
        {limits.week_limit > 0 && (
          <div className="row">
            <span className="grow dim">Scoring hunts this week</span>
            <b className="num">{Math.min(limits.week_scoring, limits.week_limit)} / {limits.week_limit}</b>
            <span className="tiny dim">resets {limits.resets_on}</span>
          </div>
        )}
        {limits.season_cap > 0 && (
          <div className="row">
            <span className="grow dim">Hunt points this season</span>
            <b className="num">{limits.season_points} / {limits.season_cap}</b>
          </div>
        )}
      </div>

      {pastWeek && (
        <Banner kind="info">
          That is this week’s {limits.week_limit} scoring hunts. More still pay their XP; points and
          items come back {limits.resets_on}.
        </Banner>
      )}

      <div className="cluster">
        <button className="btn grow" disabled={busy || full} onClick={() => setPicking(true)}>
          <PinIcon style={{ width: 18, height: 18 }} /> Park hunt
        </button>
        <button className="btn grow" disabled={busy || full} onClick={() => start('street')}>
          <CarIcon style={{ width: 18, height: 18 }} /> Street hunt
        </button>
      </div>
      <div className="tiny dim">
        {full
          ? `${limits.slots} hunts going already. Finish one, or abandon it.`
          : 'A park hunt is things any kid can spot. A street hunt is five cars by make, model and years — bigger, and worth more XP.'}
      </div>

      {!active.length && <div className="empty">No hunts going. Start one above.</div>}

      {active.map((hunt) => (
        <div key={hunt.id}>
          <div className="cluster" style={{ marginBottom: '0.4rem', flexWrap: 'nowrap' }}>
            {hunt.kind === 'park'
              ? <PinIcon style={{ width: 18, height: 18, flex: 'none' }} />
              : <CarIcon style={{ width: 18, height: 18, flex: 'none' }} />}
            <h2 className="grow truncate" style={{ margin: 0 }}>{hunt.title}</h2>
            <span className="chip chip-accent">{hunt.found} / {hunt.total}</span>
          </div>
          <div className="sheet">
            {hunt.items.map((item) => (
              <HuntItemRow key={item.slot} item={item}
                           onOpen={item.done ? null : () => setSubmitting({ hunt, item })} />
            ))}
          </div>
          <div className="cluster" style={{ marginTop: '0.4rem' }}>
            <span className="tiny dim grow">
              {hunt.park?.hood_label ? `${hunt.park.hood_label} · ` : ''}started {ago(hunt.started_at)}
            </span>
            {abandoning === hunt.id ? (
              <>
                <button className="btn btn-sm btn-ghost" onClick={() => setAbandoning(null)}>Keep it</button>
                <button className="btn btn-sm" disabled={busy} onClick={() => abandon(hunt)}>
                  Abandon — no reward
                </button>
              </>
            ) : (
              <button className="btn btn-sm btn-ghost" disabled={busy || !!limits.abandon_available_at}
                      title={limits.abandon_available_at ? `You can abandon another in ${until(limits.abandon_available_at)}` : undefined}
                      onClick={() => setAbandoning(hunt.id)}>
                {limits.abandon_available_at ? `Abandon in ${until(limits.abandon_available_at)}` : 'Abandon'}
              </button>
            )}
          </div>
        </div>
      ))}

      {recent.length > 0 && (
        <div>
          <h2 style={{ marginBottom: '0.5rem' }}>Finished</h2>
          <div className="sheet">
            {recent.map((h) => (
              <div key={h.id} className="row">
                <span className="grow truncate">{h.title}</span>
                <span className="tiny dim">
                  {h.status === 'complete'
                    ? `${h.scoring ? 'scored' : 'XP only'} · ${ago(h.completed_at)}`
                    : `abandoned · ${ago(h.ended_at)}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {picking && (
        <HuntParkPicker busy={busy} onClose={() => setPicking(false)} onPick={(park) => start('park', park.id)} />
      )}

      {submitting && (
        <HuntSubmit hunt={submitting.hunt} item={submitting.item} onChange={load}
                    onClose={() => { setSubmitting(null); load(); }} />
      )}
    </div>
  );
}
