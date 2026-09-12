// The bottom sheet behind every Hood on the map: who holds it, their photo, the
// subject you need, and one action button — Conquer / Steal / Reinforce, or a countdown.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGame } from '../lib/store.jsx';
import { article, until, ago } from '../lib/game.js';
import { CloseIcon, LockIcon } from './icons.jsx';
import { Subject, PlayerName, FlagButton, Banner, Lightbox } from './bits.jsx';
import ClaimFlow from './ClaimFlow.jsx';

export default function HoodSheet({ hoodId, onClose }) {
  const { hoodById, player, refreshHoods } = useGame();
  const hood = hoodById(hoodId);
  const [claiming, setClaiming] = useState(false);
  const [zoomed, setZoomed] = useState(null);
  const [landed, setLanded] = useState(null);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !claiming && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, claiming]);

  if (!hood) return null;
  const v = hood.viewer ?? {};

  const done = async (claim) => {
    setLanded(claim);
    setClaiming(false);
    await refreshHoods().catch(() => {});
  };

  return (
    <>
      <div className="scrim" onClick={() => !claiming && onClose()} />
      <div className="bottom-sheet" role="dialog" aria-modal="true" aria-label={hood.label}>
        {claiming ? (
          <ClaimFlow hood={hood} onClose={() => setClaiming(false)} onDone={done} />
        ) : (
          <>
            {hood.display_url && (
              <img className="sheet-photo" src={hood.display_url} alt={`The photo holding ${hood.label}`}
                   onClick={() => setZoomed(hood.display_url)} />
            )}

            <div className="sheet-head">
              <div className="grow">
                <h1>{hood.label}</h1>
                <div className="tiny dim">
                  {hood.owner
                    ? <>held {ago(hood.claimed_at)} · {hood.claim_kind}</>
                    : <>unclaimed · worth +{hood.unclaimed_value}</>}
                </div>
              </div>
              <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">
                <CloseIcon style={{ width: 16, height: 16 }} />
              </button>
            </div>

            <div className="sheet-body stack">
              {landed && (
                <Banner kind="ok">
                  {landed.summary}. {landed.claim_kind !== 'reinforce'
                    && `Locked from stealing for ${until(hood.locked_until) ?? 'a while'}.`}
                </Banner>
              )}

              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <PlayerName player={hood.owner} you={player} />
                {hood.photo_type && <Subject type={hood.photo_type} className="chip chip-accent" />}
              </div>

              {hood.owner && (
                <div className="cluster tiny dim">
                  <span>Beat it with {article(v.required_types?.[0] ?? 'anything')} photo.</span>
                  {hood.locked_until && (
                    <span className="chip"><LockIcon style={{ width: 12, height: 12 }} /> {until(hood.locked_until)}</span>
                  )}
                </div>
              )}

              {!v.can_claim && v.message && (
                <Banner kind={v.error === 'REINFORCE_TOO_SOON' ? 'info' : 'bad'}>{v.message}</Banner>
              )}

              <button className="btn btn-primary btn-block"
                      disabled={!v.can_claim}
                      onClick={() => setClaiming(true)}>
                {v.action_label}
              </button>

              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <Link className="btn btn-sm btn-ghost" to={`/hood/${hood.id}`} onClick={onClose}>
                  Full history
                </Link>
                {hood.active_claim_id && hood.owner?.id !== player?.id && (
                  <FlagButton
                    claim={{
                      id: hood.active_claim_id,
                      hood_label: hood.label,
                      player: hood.owner,
                      flag_count: hood.flag_count,
                      flagged_by_me: false,
                      flaggable: true,
                      status: 'active',
                      claim_kind: hood.claim_kind,
                    }}
                    onChanged={() => refreshHoods().catch(() => {})}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>
      <Lightbox src={zoomed} alt={hood.label} onClose={() => setZoomed(null)} />
    </>
  );
}
