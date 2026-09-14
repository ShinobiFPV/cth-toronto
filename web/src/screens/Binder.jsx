// The binder: every card somebody holds, of every kind. The reason to keep collecting
// once the points stop mattering.
//
// One shelf, not one per kind. A park card and a car card are both cards; what differs is
// the face each prints and a few lines of detail, and both come from lib/collectables.js —
// so a new kind of card turns up here without this screen changing.
//
// Anybody's binder, not just your own — /binder/:playerId. Nobody competes over a card,
// so a collection is something to show off rather than something to protect, and looking
// at what everybody else pulled is most of why a card game is fun.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { COLLECTABLES, KIND_ORDER, collectable } from '../lib/collectables.js';
import { BackIcon, BagIcon, CameraIcon, CloseIcon, SwapIcon } from '../components/icons.jsx';
import { Banner, Spinner } from '../components/bits.jsx';
import Card from '../components/Card.jsx';
import TradeOffer from '../components/TradeOffer.jsx';

const RARITY_ORDER = ['legendary', 'rare', 'uncommon', 'common'];
// Rarest first, matching the roll's own order (server/lib/editions.js).
const EDITION_ORDER = ['hologram', 'gold', 'steel'];

const editionRank = (c) => (c.edition ? EDITION_ORDER.length - EDITION_ORDER.indexOf(c.edition) : 0);
const rarityRank = (c) => (c.rarity ? RARITY_ORDER.indexOf(c.rarity) : RARITY_ORDER.length);

export default function Binder() {
  const navigate = useNavigate();
  const { playerId } = useParams();
  const { session, players, player: me } = useGame();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState('season');
  const [zoom, setZoom] = useState(null);
  const [rarity, setRarity] = useState('all');
  const [edition, setEdition] = useState('all');
  const [offering, setOffering] = useState(null);
  const [note, setNote] = useState(null);
  const [collecting, setCollecting] = useState(null);   // a kind whose collect flow is open
  const [version, setVersion] = useState(0);

  // Escape closes the zoomed card, as it does in CardLightbox.
  useEffect(() => {
    if (!zoom) return undefined;
    const onKey = (e) => e.key === 'Escape' && setZoom(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  const viewing = playerId ? Number(playerId) : null;
  const isMine = viewing == null || viewing === me?.id;

  // Which kind of card to show, or all of them. In the URL, so a link to somebody's car
  // cards stays a link to their car cards.
  const [params, setParams] = useSearchParams();
  const kind = COLLECTABLES[params.get('kind')] ? params.get('kind') : null;
  const setKind = (k) => setParams(k ? { kind: k } : {}, { replace: true });
  const suffix = kind ? `?kind=${kind}` : '';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.cards(scope === 'season' ? session?.season?.id : null, viewing, kind)
      .then((r) => !cancelled && setData(r))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [scope, session?.season?.id, viewing, kind, version]);

  // A rarity filter left over from another kind would hide everything.
  useEffect(() => { setRarity('all'); }, [kind]);

  const cards = useMemo(() => {
    let list = [...(data?.cards ?? [])];
    if (rarity !== 'all') list = list.filter((c) => c.rarity === rarity);
    // 'special' is every Gold and Hologram at once, which is what anybody actually wants.
    if (edition === 'special') list = list.filter((c) => c.edition === 'gold' || c.edition === 'hologram');
    else if (edition !== 'all') list = list.filter((c) => c.edition === edition);
    return list.sort((a, b) => editionRank(b) - editionRank(a)
      || rarityRank(a) - rarityRank(b)
      || b.claim_id - a.claim_id);
  }, [data, rarity, edition]);

  const hasRarity = (data?.cards ?? []).some((c) => c.rarity);
  const s = data?.summary;
  // The totals row follows the filter: one kind's own numbers, or the whole binder's.
  const totals = kind ? s?.kinds?.[kind] : s;
  const kindsShown = kind ? [kind] : KIND_ORDER;
  const them = players.find((p) => p.id === viewing)?.display_name ?? 'Their';
  const Collecting = collecting ? collectable(collecting).Collect : null;

  return (
    <div className="screen-pad">
      <div className="cluster" style={{ marginBottom: '0.6rem' }}>
        <button className="btn btn-sm btn-ghost" onClick={() => navigate(-1)}>
          <BackIcon style={{ width: 14, height: 14 }} /> Back
        </button>
        <span className="grow" />
        {/* The bag lives off the binder rather than on a sixth tab: items come out of cards. */}
        <Link className="btn btn-sm btn-ghost" to="/items">
          <BagIcon style={{ width: 14, height: 14 }} /> Items
          {(session?.items?.held ?? 0) > 0 && (
            <span className="chip chip-accent">{session.items.held}</span>
          )}
        </Link>
        <Link className="btn btn-sm btn-ghost" to="/trades">
          <SwapIcon style={{ width: 14, height: 14 }} /> Offers
          {(session?.trades_pending ?? 0) > 0 && (
            <span className="chip chip-accent">{session.trades_pending}</span>
          )}
        </Link>
      </div>

      {note && <Banner kind="ok">{note}</Banner>}

      <h1>{isMine ? 'Binder' : `${them}’s binder`}</h1>
      <p className="tiny dim" style={{ margin: '0.3rem 0 0.9rem' }}>
        {isMine
          ? 'Every card you have collected — park signs, cars, all of it. Tap one to look at it or offer it.'
          : 'Every card they have collected. Nobody loses anything to somebody else’s card, so compare away.'}
      </p>

      {/* The ways to collect straight from here. Parks are collected from the map. */}
      {isMine && KIND_ORDER.filter((k) => COLLECTABLES[k].Collect).map((k) => (
        <button key={k} className="btn btn-block" style={{ marginBottom: '0.8rem' }}
                onClick={() => setCollecting(k)}>
          <CameraIcon style={{ width: 18, height: 18 }} /> {COLLECTABLES[k].collectLabel}
        </button>
      ))}

      {/* Whose binder. Yours first, then everybody else — a control, not a deep link, because
          looking at other people's cards is the point of making them public. */}
      {players.length > 1 && (
        <div className="cluster" style={{ marginBottom: '0.8rem' }}>
          {[...players].sort((a, b) => (a.id === me?.id ? -1 : b.id === me?.id ? 1 : 0))
            .map((p) => {
              const active = p.id === (viewing ?? me?.id);
              return (
                <button key={p.id}
                        className={`btn btn-sm ${active ? 'btn-primary' : 'btn-ghost'}`}
                        aria-pressed={active}
                        onClick={() => navigate(p.id === me?.id ? `/binder${suffix}` : `/binder/${p.id}${suffix}`)}>
                  <i className="dot" style={{ background: p.colour }} />
                  {p.id === me?.id ? 'You' : p.display_name}
                </button>
              );
            })}
        </div>
      )}

      <div className="toggle" role="group" aria-label="Which cards">
        <button aria-pressed={kind == null} onClick={() => setKind(null)}>All cards</button>
        {KIND_ORDER.map((k) => (
          <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {COLLECTABLES[k].label}
          </button>
        ))}
      </div>

      {totals && (
        <div className="sheet" style={{ marginBottom: '0.9rem' }}>
          {/* Collected and held are different questions once cards can be traded, and the
              labels have to say which is which. */}
          <div className="row">
            <span className="grow dim">
              Cards on the shelf
              {(totals.cards_received > 0 || totals.cards_given_away > 0) && (
                <span className="tiny"> · {totals.cards_received} in, {totals.cards_given_away} out</span>
              )}
            </span>
            <b className="num">{totals.cards_held}</b>
          </div>

          {kindsShown.map((k) => {
            const entry = COLLECTABLES[k];
            const detail = s.kinds?.[k];
            if (!detail) return null;
            const chips = entry.summaryChips(detail);
            return (
              <div key={k}>
                {entry.summaryRows(detail, { isMine }).map((row) => (
                  <div key={row.label} className="row">
                    <span className="grow dim">{row.label}</span>
                    <b className="num">{row.value}</b>
                    {row.extra && <span className="tiny dim">{row.extra}</span>}
                  </div>
                ))}
                {chips.length > 0 && (
                  <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                    {chips.map((c) => <span key={c.key} className={c.className}>{c.text}</span>)}
                  </div>
                )}
              </div>
            );
          })}

          {Object.keys(totals.by_edition ?? {}).length > 0 && (
            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              {EDITION_ORDER.filter((e) => totals.by_edition[e]).map((e) => (
                <span key={e} className={`chip ed-${e}`}>{totals.by_edition[e]} {e}</span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="toggle" role="group" aria-label="Scope">
        <button aria-pressed={scope === 'season'} onClick={() => setScope('season')}>
          {session?.season?.name ?? 'This season'}
        </button>
        <button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All time</button>
      </div>

      {hasRarity && (
        <div className="cluster" style={{ marginBottom: '0.5rem' }}>
          {['all', ...RARITY_ORDER].map((r) => (
            <button key={r} className={`btn btn-sm ${rarity === r ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setRarity(r)}>
              {r === 'all' ? 'Any rarity' : r}
            </button>
          ))}
        </div>
      )}

      <div className="cluster" style={{ marginBottom: '0.8rem' }}>
        {['all', 'special', ...EDITION_ORDER].map((e) => (
          <button key={e} className={`btn btn-sm ${edition === e ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setEdition(e)}>
            {e === 'all' ? 'Any print' : e}
          </button>
        ))}
      </div>

      {loading && <div className="empty"><Spinner /></div>}

      {!loading && !cards.length && (
        <div className="empty">
          {isMine
            ? `Nothing here yet. To get a card, ${kindsShown.map((k) => COLLECTABLES[k].emptyHint).join(', or ')}.`
            : 'They have not collected anything here yet.'}
        </div>
      )}

      <div className="card-grid">
        {cards.map((c) => (
          <div key={c.claim_id} className="card-slot">
            <Card card={c} compact onClick={() => setZoom(c)} />
            {/* A traded card keeps its collector's name on it, because that is who went
                and got it. */}
            {c.traded && (
              <span className="card-from tiny" title={`${collectable(c.kind).collectedBy} ${c.player.display_name}`}>
                <i className="dot" style={{ background: c.player.colour }} />
                {c.player.display_name}
              </span>
            )}
          </div>
        ))}
      </div>

      {zoom && (
        <div className="lightbox" onClick={() => setZoom(null)} role="dialog" aria-modal="true">
          <div onClick={(e) => e.stopPropagation()} className="stack" style={{ alignItems: 'center' }}>
            <Card card={zoom} />
            {collectable(zoom.kind).note && (
              <div className="lightbox-note">{collectable(zoom.kind).note(zoom)}</div>
            )}
            {/* Only your own binder offers a card, and only when there is somebody to offer
                it to. */}
            {isMine && players.length > 1 && (
              <button className="btn btn-primary" onClick={() => { setOffering(zoom); setZoom(null); }}>
                <SwapIcon style={{ width: 16, height: 16 }} /> Offer this card
              </button>
            )}
          </div>
          <button className="btn btn-sm" style={{ position: 'fixed', top: '1rem', right: '1rem' }}
                  onClick={() => setZoom(null)} aria-label="Close">
            <CloseIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>
      )}

      {offering && (
        <TradeOffer
          card={offering}
          onClose={() => setOffering(null)}
          onSent={(trade) => {
            setOffering(null);
            setNote(trade.is_gift
              ? `${trade.offer.name} offered to ${trade.to.display_name}.`
              : `Offer sent to ${trade.to.display_name}.`);
          }}
        />
      )}

      {Collecting && (
        <Collecting onClose={() => setCollecting(null)} onDone={() => setVersion((n) => n + 1)} />
      )}
    </div>
  );
}
