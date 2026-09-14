// The Not Wheels card — the face of a car card, sibling to ParkCard. Which face a card
// wears is decided by lib/collectables.js; this only draws one.
//
// It started life as a blister pack, with a hang tab and a plastic bubble over the
// photo. Both went: under the packaging it was already a card, so now it is only the
// card — a printed backing, the photo in a window, a spec strip along the bottom. No
// flame, no red and yellow: the backing is plain stock, foil or holographic, and that
// is the whole of its edition.
//
// House rules carry over from the park card. The art is seeded, never random: card_seed
// is hashed from (player, vehicle, season) on the server, so the stripe weave and the
// serial are the same every time you open the binder. Every colour is a token in
// styles.css.
import { useMemo } from 'react';

/** mulberry32 over the seed — the same generator ParkCard uses, for the same reason. */
function rng(seed) {
  let a = 0;
  for (const ch of String(seed ?? 'cth')) a = (a * 31 + ch.charCodeAt(0)) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildArt(seed) {
  const rand = rng(seed);
  return {
    stripeAngle: 20 + Math.floor(rand() * 140),
    stripeGap: 6 + Math.floor(rand() * 8),
    serial: String(parseInt(String(seed ?? '0').slice(0, 6), 16) % 10000).padStart(4, '0'),
  };
}

const shortDate = (iso) => (iso
  ? new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
  : null);

export default function NotWheelsCard({ card, compact = false, onClick }) {
  const art = useMemo(() => buildArt(card?.card_seed), [card?.card_seed]);
  if (!card) return null;

  const v = card.vehicle;
  const edition = card.edition ?? 'steel';

  return (
    <figure
      className={`nwcard nwcard-${edition}${compact ? ' nwcard-compact' : ''}`}
      onClick={onClick}
      aria-label={`Not Wheels card: ${v.name}, ${card.edition_label ?? edition}`}
      style={{
        '--nw-stripe-angle': `${art.stripeAngle}deg`,
        '--nw-stripe-gap': `${art.stripeGap}px`,
      }}
    >
      <header className="nwcard-head">
        <span className="nwcard-titles">
          <span className="nwcard-mark">Not Wheels</span>
          <span className="nwcard-name" title={v.name}>{v.name}</span>
        </span>
        <span className="nwcard-ed">{card.edition_label ?? edition}</span>
      </header>

      <div className="nwcard-photo">
        {card.display_url || card.thumb_url ? (
          <img src={compact ? (card.thumb_url ?? card.display_url) : (card.display_url ?? card.thumb_url)}
               alt={`The ${v.name}`} loading="lazy" />
        ) : (
          <div className="nwcard-nophoto">no photo</div>
        )}
        {/* Marked, never rejected: the group decides. Only on the full card — at
            thumbnail size it would cover the car. */}
        {!compact && card.suspect && <span className="nwcard-check">Unverified</span>}
      </div>

      {!compact && card.caption && <div className="nwcard-flavour">{card.caption}</div>}

      <footer className="nwcard-foot">
        <span>{v.make}</span>
        <span>{v.model}</span>
        {v.year && <span>{v.year}</span>}
        {!compact && card.hood?.label && <span>{card.hood.label}</span>}
        {!compact && <span>{shortDate(card.collected_at)}</span>}
        <span className="nwcard-no">NW-{art.serial}</span>
      </footer>
    </figure>
  );
}
