// Your bag: what your special pulls granted, and the three items you spend from here.
//
// Crowbar and Sprint are listed but not spent here. They are spent by the claim they open,
// in that claim's own transaction, so the Hood sheet offers them at the gate that stops you
// rather than asking you to remember to come here first.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { ago, clock } from '../lib/game.js';
import { ITEM_ORDER } from '../lib/items.js';
import { BackIcon, ShieldIcon, ITEM_ICON } from '../components/icons.jsx';
import { Banner, Spinner } from '../components/bits.jsx';
import CloverClock from '../components/CloverClock.jsx';

const VERB = { fortify: 'Arm', recon: 'Look', tuneup: 'Tune up', clover: 'Pop it' };

const NO_TARGET = {
  fortify: 'Hold a Hood without a Fortify on it to arm one.',
  recon: 'Nobody else holds a Hood right now.',
  tuneup: 'None of your Hoods is waiting on its reinforce gate.',
};

function describeUse(u) {
  const where = u.hood_label ?? 'a Hood';
  switch (u.item_type) {
    case 'fortify':
      return u.mine
        ? `Your Fortify on ${where} stopped ${u.against ?? 'a steal'}`
        : `${u.by}’s Fortify on ${where} stopped you`;
    case 'recon': return `Recon on ${where}: ${u.fortified ? 'fortified' : 'clear'}`;
    case 'crowbar': return `Crowbar through the lock on ${where}`;
    case 'sprint': return `Sprint into ${where}`;
    case 'tuneup': return `Tune-Up on ${where}`;
    case 'clover': return `Clover${u.expires_at ? `, until ${clock(u.expires_at)}` : ''}`;
    default: return u.label;
  }
}

export default function Items() {
  const navigate = useNavigate();
  const { hoods, player, refreshMe, refreshHoods, itemsTick } = useGame();
  const [inv, setInv] = useState(null);
  const [history, setHistory] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const [targets, setTargets] = useState({});

  const load = useCallback(() => api.items().then(setInv).catch((err) => setError(err.message)), []);
  useEffect(() => { load(); }, [load, itemsTick]);

  if (!inv) {
    return <div className="empty">{error ? <Banner kind="bad">{error}</Banner> : <Spinner />}</div>;
  }

  const mine = hoods.filter((h) => h.owner?.id === player?.id);
  const armedOn = new Set(inv.armed.map((a) => a.hood_id));
  const choices = {
    fortify: mine.filter((h) => !armedOn.has(h.id)),
    recon: hoods.filter((h) => h.owner && h.owner.id !== player?.id),
    tuneup: mine.filter((h) => h.viewer?.error === 'REINFORCE_TOO_SOON'),
  };
  const target = (type) => {
    const picked = targets[type];
    return choices[type]?.some((h) => h.id === picked) ? picked : (choices[type]?.[0]?.id ?? null);
  };
  const first = (type) => inv.items.find((i) => i.item_type === type) ?? null;

  const act = async (run, say) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await run();
      setInv(res.inventory);
      setNote(say(res));
      refreshMe().catch(() => {});
      refreshHoods().catch(() => {});
      if (history) api.itemHistory().then(setHistory).catch(() => {});
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const spend = (type) => {
    const grant = first(type);
    if (!grant) return;
    if (type === 'fortify') {
      act(() => api.armItem(grant.grant_id, target(type)),
        (r) => `Fortify armed on ${r.armed.hood_label}. Nobody else can see it.`);
    } else if (type === 'clover') {
      act(() => api.useItem(grant.grant_id),
        (r) => `Clover running until ${clock(r.result.expires_at)}. Go and collect something.`);
    } else if (type === 'recon') {
      act(() => api.useItem(grant.grant_id, target(type)),
        (r) => (r.result.fortified
          ? `${r.result.hood_label} is fortified. The first steal bounces off it.`
          : `${r.result.hood_label} has no Fortify on it right now.`));
    } else if (type === 'tuneup') {
      act(() => api.useItem(grant.grant_id, target(type)),
        (r) => `${r.result.hood_label} is tuned up. Go and reinforce it.`);
    }
  };

  const cap = inv.capacity;

  return (
    <div className="screen-pad stack">
      <div className="cluster">
        <button className="btn btn-sm btn-ghost" onClick={() => navigate(-1)}>
          <BackIcon style={{ width: 14, height: 14 }} /> Back
        </button>
      </div>

      <div>
        <h1>Items</h1>
        <p className="tiny dim" style={{ margin: '0.3rem 0 0' }}>
          A Gold pull grants one and a Hologram three — only when the card scored points,
          and at most {cap.cap ?? 'any number'} a week. Nothing carries past the end
          of {inv.season?.name ?? 'the season'}.
        </p>
      </div>

      {note && <Banner kind="ok">{note}</Banner>}
      {error && <Banner kind="bad">{error}</Banner>}
      <CloverClock />

      <div className="sheet">
        <div className="row">
          <span className="grow dim">Granted this week</span>
          <b className="num">{cap.granted}{cap.cap != null && ` / ${cap.cap}`}</b>
          <span className="tiny dim">resets {cap.resets_on}</span>
        </div>
        <div className="row">
          <span className="grow dim">In your bag</span>
          <b className="num">{inv.held}</b>
        </div>
      </div>

      {inv.armed.length > 0 && (
        <div>
          <h2 style={{ marginBottom: '0.5rem' }}>Armed</h2>
          <div className="sheet">
            {inv.armed.map((a) => (
              <div key={a.grant_id} className="row">
                <ShieldIcon style={{ width: 16, height: 16, flex: 'none' }} />
                <span className="grow truncate">
                  {a.hood_label}
                  {!a.live && <span className="tiny dim"> · not yours any more</span>}
                </span>
                <span className="tiny dim">{ago(a.armed_at)}</span>
                <button className="btn btn-sm btn-ghost" disabled={busy}
                        onClick={() => act(() => api.disarmItem(a.hood_id),
                          (r) => `Fortify taken off ${r.disarmed.hood_label}. It is back in your bag.`)}>
                  Disarm
                </button>
              </div>
            ))}
          </div>
          <div className="tiny dim" style={{ marginTop: '0.4rem' }}>
            Only you can see these. The first steal on the Hood spends it.
          </div>
        </div>
      )}

      <div>
        <h2 style={{ marginBottom: '0.5rem' }}>Your bag</h2>
        <div className="sheet">
          {ITEM_ORDER.map((type) => {
            const info = inv.catalogue[type];
            const n = inv.counts[type] ?? 0;
            const Icon = ITEM_ICON[type];
            const options = choices[type];
            return (
              <div key={type} className="sheet-body stack"
                   style={{ gap: '0.45rem', borderBottom: '1px solid var(--rule)' }}>
                <div className="cluster">
                  <Icon style={{ width: 20, height: 20, flex: 'none' }} />
                  <b className="grow">{info.label}</b>
                  <span className={`chip ${n ? 'chip-accent' : ''}`}>{n}</span>
                </div>
                <div className="tiny dim">{info.blurb}</div>

                {n > 0 && info.how !== 'claim' && (
                  <div className="cluster">
                    {options && (options.length ? (
                      <select className="caption-input grow" value={target(type) ?? ''} disabled={busy}
                              aria-label={`Which Hood for the ${info.label}`}
                              onChange={(e) => setTargets((t) => ({ ...t, [type]: Number(e.target.value) }))}>
                        {options.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
                      </select>
                    ) : <span className="tiny dim grow">{NO_TARGET[type]}</span>)}
                    <button className="btn btn-sm"
                            disabled={busy || (options && !options.length) || (type === 'clover' && inv.clover.active)}
                            onClick={() => spend(type)}>
                      {type === 'clover' && inv.clover.active ? 'Running' : VERB[type]}
                    </button>
                  </div>
                )}
                {n > 0 && info.how === 'claim' && (
                  <div className="tiny">Offered on the Hood sheet when it would get you through.</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <button className="btn btn-sm btn-ghost"
                onClick={() => (history ? setHistory(null)
                  : api.itemHistory().then(setHistory).catch((err) => setError(err.message)))}>
          {history ? 'Hide history' : 'History'}
        </button>
        {history && (
          <div className="sheet" style={{ marginTop: '0.5rem' }}>
            {history.uses.map((u) => (
              <div key={`u${u.use_id}`} className="row tiny">
                <span className="grow">{describeUse(u)}</span>
                <span className="dim">{ago(u.used_at)}</span>
              </div>
            ))}
            {history.grants.map((g) => (
              <div key={`g${g.grant_id}`} className="row tiny">
                <span className="grow">
                  {g.label} from {g.card_name ?? 'a card'}{g.edition ? ` (${g.edition})` : ''}
                  {g.voided ? ' · voided by flags' : g.used_at ? ' · used' : ''}
                </span>
                <span className="dim">{ago(g.granted_at)}</span>
              </div>
            ))}
            {!history.uses.length && !history.grants.length && (
              <div className="row dim tiny">Nothing yet. Pull a Gold.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
