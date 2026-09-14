// The bottom sheet behind every Hood on the map: who holds it, their photo, the
// subject you need, and one action button — Conquer / Steal / Reinforce, or a countdown.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { article, until, ago, GATE_CODES, difficultyBand } from '../lib/game.js';
import { ITEM_LABEL, BYPASS_BLURB } from '../lib/items.js';
import { CloseIcon, LockIcon, ShieldIcon, ReconIcon, ITEM_ICON } from './icons.jsx';
import { Subject, PlayerName, FlagButton, Banner, Lightbox } from './bits.jsx';
import ClaimFlow from './ClaimFlow.jsx';
import Caption from './Caption.jsx';
import { playSound } from '../lib/audio.js';

export default function HoodSheet({ hoodId, onClose }) {
  const { hoodById, player, refreshHoods, refreshMe, itemsTick, itemsChanged } = useGame();
  const hood = hoodById(hoodId);
  const [claiming, setClaiming] = useState(false);
  const [zoomed, setZoomed] = useState(null);
  const [landed, setLanded] = useState(null);
  // Your bag, so the sheet can offer the item that gets you past whatever is stopping you.
  const [inventory, setInventory] = useState(null);
  // A Crowbar or Sprint brought along to the claim.
  const [grant, setGrant] = useState(null);
  const [itemNote, setItemNote] = useState(null);
  const [itemBusy, setItemBusy] = useState(false);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !claiming && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, claiming]);

  useEffect(() => {
    let cancelled = false;
    api.items().then((r) => !cancelled && setInventory(r)).catch(() => {});
    return () => { cancelled = true; };
  }, [hoodId, itemsTick]);

  if (!hood) return null;
  const v = hood.viewer ?? {};
  const held = (type) => inventory?.items.filter((i) => i.item_type === type) ?? [];

  const done = async (claim, meta) => {
    // conquer, steal and reinforce are slot names as well as claim kinds.
    playSound(claim.claim_kind);
    setLanded({ ...claim, xp: meta?.xp, level_up: meta?.level_up, item_used: meta?.item_used });
    setClaiming(false);
    setGrant(null);
    if (meta?.item_used) itemsChanged();
    await refreshHoods().catch(() => {});
  };

  // The steal walked into a Fortify. It happened — the photo is spent — so the sheet says
  // so and closes the capture flow rather than leaving a retry button under it.
  const blocked = async (message) => {
    playSound('fortify_blocked');
    setClaiming(false);
    setGrant(null);
    setItemNote({ kind: 'bad', text: message });
    await refreshHoods().catch(() => {});
  };

  const itemAct = async (run, say) => {
    setItemBusy(true);
    setItemNote(null);
    try {
      const res = await run();
      setInventory(res.inventory);
      setItemNote({ kind: 'ok', text: say(res) });
      itemsChanged();
      refreshMe().catch(() => {});
      await refreshHoods().catch(() => {});
    } catch (err) {
      setItemNote({ kind: 'bad', text: err.message });
    } finally {
      setItemBusy(false);
    }
  };

  const bypass = (type) => {
    const [first] = held(type);
    if (!first) return;
    if (type === 'tuneup') {
      itemAct(() => api.useItem(first.grant_id, hood.id),
        () => `${hood.label} is tuned up. Reinforce away.`);
    } else {
      setGrant(first);
      setClaiming(true);
    }
  };

  const BypassIcon = v.bypassable_with ? ITEM_ICON[v.bypassable_with] : null;

  return (
    <>
      <div className="scrim" onClick={() => !claiming && onClose()} />
      <div className="bottom-sheet" role="dialog" aria-modal="true" aria-label={hood.label}>
        {claiming ? (
          <ClaimFlow hood={hood} useGrant={grant} onDone={done} onBlocked={blocked}
                     onClose={() => { setClaiming(false); setGrant(null); }} />
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
                  {landed.summary}.{' '}
                  {landed.xp && <><b>+{landed.xp.xp} XP</b>
                    {landed.xp.discovery > 0 && ' — somewhere new'}. </>}
                  {landed.level_up && <><b>Level {landed.level_up.to}, {landed.level_up.title}!</b> </>}
                  {landed.item_used && <>Your {landed.item_used.label} is spent. </>}
                  {landed.claim_kind !== 'reinforce'
                    && `Locked from stealing for ${until(hood.locked_until) ?? 'a while'}.`}
                </Banner>
              )}

              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <PlayerName player={hood.owner} you={player} />
                {hood.photo_type && <Subject type={hood.photo_type} className="chip chip-accent" />}
              </div>

              {/* The Hood shape carries the holding photo's caption, so this stands in a
                  claim-shaped object rather than fetching the claim just to read one line. */}
              {hood.active_claim_id && (
                <Caption
                  claim={{ id: hood.active_claim_id, caption: hood.caption, can_caption: !!v.is_mine }}
                  onChanged={() => refreshHoods().catch(() => {})}
                />
              )}

              {/* What this Hood costs to reach, and therefore what it pays. */}
              <div className="row" style={{ padding: 0, border: 0, gap: '0.5rem' }}>
                <span className="chip" title="Distance from downtown and how many Hoods border it">
                  difficulty {hood.difficulty}/50 · {difficultyBand(hood.difficulty)}
                </span>
                <span className="grow" />
                <span className="tiny dim">
                  conquer +{hood.conquer_value} · steal +{hood.steal_value}
                </span>
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
                <Banner kind={v.error === 'FORTIFY_COOLDOWN' ? 'bad' : GATE_CODES.has(v.error) ? 'info' : 'bad'}>
                  {v.message}
                </Banner>
              )}

              {itemNote && <Banner kind={itemNote.kind}>{itemNote.text}</Banner>}

              {/* The item that opens this gate, offered at the gate — nobody should have to
                  remember they own a Crowbar and go and find it. */}
              {!v.can_claim && v.bypassable_with && held(v.bypassable_with).length > 0 && (
                <div className="cluster">
                  <span className="tiny grow">{BYPASS_BLURB[v.bypassable_with]}</span>
                  <button className="btn btn-sm" disabled={itemBusy} onClick={() => bypass(v.bypassable_with)}>
                    {BypassIcon && <BypassIcon style={{ width: 14, height: 14 }} />}
                    {' '}Use a {ITEM_LABEL[v.bypassable_with]} ({held(v.bypassable_with).length})
                  </button>
                </div>
              )}

              {/* A Fortify is yours to see and nobody else's — the server only sends
                  `fortified` to the Hood's owner. */}
              {v.is_mine && v.fortified && (
                <div className="cluster">
                  <span className="chip chip-ok"><ShieldIcon style={{ width: 12, height: 12 }} /> Fortified</span>
                  <span className="tiny dim grow">Only you can see this.</span>
                  <button className="btn btn-sm btn-ghost" disabled={itemBusy}
                          onClick={() => itemAct(() => api.disarmItem(hood.id),
                            () => 'Fortify taken off. It is back in your bag.')}>
                    Disarm
                  </button>
                </div>
              )}
              {v.is_mine && v.fortified === false && held('fortify').length > 0 && (
                <div className="cluster">
                  <span className="tiny dim grow">The first steal attempt will bounce off.</span>
                  <button className="btn btn-sm" disabled={itemBusy}
                          onClick={() => itemAct(() => api.armItem(held('fortify')[0].grant_id, hood.id),
                            () => `Fortify armed on ${hood.label}. Nobody else can see it.`)}>
                    <ShieldIcon style={{ width: 14, height: 14 }} /> Arm a Fortify ({held('fortify').length})
                  </button>
                </div>
              )}

              {hood.owner && !v.is_mine && held('recon').length > 0 && (
                <div className="cluster">
                  <span className="tiny dim grow">Is it fortified? Find out before you go.</span>
                  <button className="btn btn-sm btn-ghost" disabled={itemBusy}
                          onClick={() => itemAct(() => api.useItem(held('recon')[0].grant_id, hood.id),
                            (r) => (r.result.fortified
                              ? `${hood.label} is fortified. The first steal bounces off it.`
                              : `No Fortify on ${hood.label} right now.`))}>
                    <ReconIcon style={{ width: 14, height: 14 }} /> Recon ({held('recon').length})
                  </button>
                </div>
              )}

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

            {/* Both actions live outside the scrolling body, so a Hood with a photo, a
                cooldown banner and a caption cannot push them off the bottom of the
                screen. The sub-game sits directly under the claim action and matches
                its shape: collecting parks is half the reason to open a Hood. It is
                rendered unconditionally — every Hood in Toronto has between 31 and 95
                parks, so hiding it on a missing count only ever hides a working
                feature. */}
            <div className="sheet-actions">
              <button className="btn btn-primary btn-block"
                      disabled={!v.can_claim}
                      onClick={() => setClaiming(true)}>
                {v.action_label}
              </button>

              <Link className="btn btn-block btn-parkemans" to={`/hood/${hood.id}/parks`}
                    onClick={onClose}>
                <span>Collect parks</span>
                {hood.parks?.total > 0 && (
                  <span className="btn-sub">
                    {hood.parks.collected}/{hood.parks.total}
                    {/* Past this Hood's park points cap: said before anybody sets off. */}
                    {hood.parks.capacity?.remaining === 0 && ' · XP only'}
                  </span>
                )}
              </Link>
            </div>
          </>
        )}
      </div>
      <Lightbox src={zoomed} alt={hood.label} onClose={() => setZoomed(null)} />
    </>
  );
}
