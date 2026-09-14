// The binder: every park card somebody owns. The reason to keep collecting once the
// points stop mattering.
//
// Anybody's binder, not just your own — /binder/:playerId. Nobody competes over parks,
// so a collection is something to show off rather than something to protect, and
// looking at what everybody else pulled is most of why a card game is fun.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { BackIcon, BagIcon, CloseIcon, SwapIcon } from '../components/icons.jsx';
import { Banner, Spinner } from '../components/bits.jsx';
import ParkCard from '../components/ParkCard.jsx';
import TradeOffer from '../components/TradeOffer.jsx';
import Case from '../components/Case.jsx';

const RARITY_ORDER = ['legendary', 'rare', 'uncommon', 'common'];
// Rarest first, matching the roll's own order (server/lib/editions.js).
const EDITION_ORDER = ['hologram', 'gold', 'steel'];

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

  // Escape closes the zoomed card, as it does in CardLightbox. Without this the two
  // ways of looking at a card behave differently for no reason.
  useEffect(() => {
    if (!zoom) return undefined;
    const onKey = (e) => e.key === 'Escape' && setZoom(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  const viewing = playerId ? Number(playerId) : null;
  const isMine = viewing == null || viewing === me?.id;

  // Parks | Garage. The tab bar is full, so the Garage lives here as the other half of
  // the Cards tab — in the URL, so a link to somebody's Case stays a link to their Case.
  const [params, setParams] = useSearchParams();
  const kind = params.get('kind') === 'car' ? 'car' : 'park';
  const setKind = (k) => setParams(k === 'car' ? { kind: 'car' } : {}, { replace: true });
  const suffix = kind === 'car' ? '?kind=car' : '';

  useEffect(() => {
    if (kind !== 'park') return undefined;
    let cancelled = false;
    setLoading(true);
    api.cards(scope === 'season' ? session?.season?.id : null, viewing)
      .then((r) => !cancelled && setData(r))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [scope, session?.season?.id, viewing, kind]);

  const cards = useMemo(() => {
    let list = [...(data?.cards ?? [])];
    if (rarity !== 'all') list = list.filter((c) => c.rarity === rarity);
    // 'special' is every non-standard card at once, which is what anybody actually
    // wants to look at.
    if (edition === 'special') list = list.filter((c) => c.edition);
    else if (edition !== 'all') list = list.filter((c) => c.edition === edition);
    return list.sort((a, b) =>
      // Specials to the front, rarest edition first — they are the reason to open this.
      (b.edition ? EDITION_ORDER.length - EDITION_ORDER.indexOf(b.edition) : 0)
      - (a.edition ? EDITION_ORDER.length - EDITION_ORDER.indexOf(a.edition) : 0)
      || RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity)
      || b.points - a.points
      || a.park.name.localeCompare(b.park.name));
  }, [data, rarity, edition]);

  const s = data?.summary;

  return (
    <div className="screen-pad">
      <div className="cluster" style={{ marginBottom: '0.6rem' }}>
        <button className="btn btn-sm btn-ghost" onClick={() => navigate(-1)}>
          <BackIcon style={{ width: 14, height: 14 }} /> Back
        </button>
        <span className="grow" />
        {/* The bag lives off Cards rather than on a sixth tab: items come out of cards. */}
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

      {(() => {
        const them = players.find((p) => p.id === viewing)?.display_name ?? 'Their';
        const shelf = kind === 'car' ? 'Case' : 'binder';
        return <h1>{isMine ? (kind === 'car' ? 'Case' : 'Binder') : `${them}’s ${shelf}`}</h1>;
      })()}
      <p className="tiny dim" style={{ margin: '0.3rem 0 0.9rem' }}>
        {kind === 'car'
          ? (isMine
            ? `Every car you have snapped. ${session?.season ? 'Five points a car, up to 100 a week; ' : ''}`
              + 'past that, still a card and still the XP.'
            : 'Every car they have snapped. Nobody loses anything to a photo of a car, so '
              + 'compare away.')
          : (isMine
            ? 'Every park sign you have photographed. Each park comes back around next season.'
            : 'Every park sign they have photographed. Nobody competes over parks, so this '
              + 'costs you nothing — and the same parks are still there for you.')}
      </p>

      {/* Whose binder. Yours first, then everybody else — this is the whole point of
          making collections public, so it is a control rather than a deep link. */}
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

      <div className="toggle" role="group" aria-label="Collection">
        <button aria-pressed={kind === 'park'} onClick={() => setKind('park')}>Parks</button>
        <button aria-pressed={kind === 'car'} onClick={() => setKind('car')}>Garage</button>
      </div>

      {kind === 'car' ? <Case viewing={viewing} isMine={isMine} onOffer={setOffering} /> : (<>
      {s && (
        <div className="sheet" style={{ marginBottom: '0.9rem' }}>
          {/* Collected and held are different questions once cards can be traded, and
              the labels have to say which is which — otherwise a binder holding a
              traded card reads as "0 collected" above a grid with a card in it. */}
          <div className="row">
            <span className="grow dim">Collected {s.season?.name ?? 'this season'}</span>
            <b className="num">{s.season_collected}</b>
            <span className="tiny dim">/ {s.parks_total} parks</span>
          </div>
          <div className="row">
            <span className="grow dim">Points earned from parks, this season</span>
            <b className="num">{s.season_points}</b>
          </div>
          <div className="row">
            <span className="grow dim">Distinct parks collected, all time</span>
            <b className="num">{s.distinct_parks_all_time}</b>
          </div>
          <div className="row">
            <span className="grow dim">
              Cards on the shelf
              {(s.cards_received > 0 || s.cards_given_away > 0) && (
                <span className="tiny"> · {s.cards_received} in, {s.cards_given_away} out</span>
              )}
            </span>
            <b className="num">{s.cards_held}</b>
          </div>
          {Object.keys(s.by_rarity ?? {}).length > 0 && (
            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              {RARITY_ORDER.filter((r) => s.by_rarity[r]).map((r) => (
                <span key={r} className={`chip r-${r}`}>{s.by_rarity[r]} {r}</span>
              ))}
            </div>
          )}
          {Object.keys(s.by_edition ?? {}).length > 0 && (
            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              {EDITION_ORDER.filter((e) => s.by_edition[e]).map((e) => (
                <span key={e} className={`chip ed-${e}`}>{s.by_edition[e]} {e}</span>
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

      <div className="cluster" style={{ marginBottom: '0.5rem' }}>
        {['all', ...RARITY_ORDER].map((r) => (
          <button key={r} className={`btn btn-sm ${rarity === r ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setRarity(r)}>
            {r === 'all' ? 'All' : r}
          </button>
        ))}
      </div>

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
            ? 'Nothing here yet. Open a Hood on the map and tap Collect parks.'
            : 'They have not collected anything yet.'}
        </div>
      )}

      <div className="card-grid">
        {cards.map((c) => (
          <div key={c.claim_id} className="card-slot">
            <ParkCard card={c} compact onClick={() => setZoom(c)} />
            {/* Whose feet got this card. A traded card keeps the collector's name on
                it, because that is who actually went there. */}
            {c.traded && (
              <span className="card-from tiny" title={`Collected by ${c.player.display_name}`}>
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
            <ParkCard card={zoom} />
            {/* Only your own binder offers a card, and only when there is somebody to
                offer it to. */}
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
      </>)}

      {offering && (
        <TradeOffer
          card={offering}
          onClose={() => setOffering(null)}
          onSent={(trade) => {
            setOffering(null);
            setNote(trade.is_gift
              ? `${trade.offer.name ?? trade.offer.park_name} offered to ${trade.to.display_name}.`
              : `Offer sent to ${trade.to.display_name}.`);
          }}
        />
      )}
    </div>
  );
}
