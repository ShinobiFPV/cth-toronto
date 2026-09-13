// The Not Wheels package — the Garage's collectable, sibling to ParkCard.
//
// It evokes the *format* of a diecast blister pack — hang tab with a punched slot, a
// clear bubble over the car, a printed backing card, a spec strip along the bottom — in
// the house style rather than anybody's trade dress. No flame, no red and yellow: the
// backing is plain stock, foil or holographic, and that is the whole of its edition.
//
// House rules carry over from the park card. The art is seeded, never random: card_seed
// is hashed from (player, vehicle, season) on the server, so the stripe weave, the angle
// the bubble sits at and where the highlight catches are the same every time you open
// the Case. Every colour is a token in styles.css. The blister is bevelled rather than
// rounded, because there are no radii anywhere in this app.
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
    // The specular strip runs down one side of the bubble, never through the middle of
    // the car.
    shineX: 8 + Math.floor(rand() * 14),
    tilt: Math.round((rand() - 0.5) * 30) / 10,
    serial: String(parseInt(String(seed ?? '0').slice(0, 6), 16) % 10000).padStart(4, '0'),
  };
}

const shortDate = (iso) => (iso
  ? new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
  : null);

export default function NotWheelsPack({ card, compact = false, onClick }) {
  const art = useMemo(() => buildArt(card?.card_seed), [card?.card_seed]);
  if (!card) return null;

  const v = card.vehicle;
  const edition = card.edition ?? 'steel';

  return (
    <figure
      className={`nwpack nwpack-${edition}${compact ? ' nwpack-compact' : ''}`}
      onClick={onClick}
      aria-label={`Not Wheels package: ${v.name}, ${card.edition_label ?? edition}`}
      style={{
        '--nw-stripe-angle': `${art.stripeAngle}deg`,
        '--nw-stripe-gap': `${art.stripeGap}px`,
        '--nw-shine-x': `${art.shineX}%`,
        '--nw-tilt': `${art.tilt}deg`,
      }}
    >
      <div className="nwpack-tab" aria-hidden="true">
        <i className="nwpack-hole" />
        <span className="nwpack-mark">Not Wheels</span>
      </div>

      <div className="nwpack-card">
        <header className="nwpack-head">
          <span className="nwpack-name" title={v.name}>{v.name}</span>
          <span className="nwpack-ed">{card.edition_label ?? edition}</span>
        </header>

        <div className="nwpack-blister">
          <i className="nwpack-bubble" aria-hidden="true" />
          <div className="nwpack-photo">
            {card.display_url || card.thumb_url ? (
              <img src={compact ? (card.thumb_url ?? card.display_url) : (card.display_url ?? card.thumb_url)}
                   alt={`The ${v.name}`} loading="lazy" />
            ) : (
              <div className="nwpack-nophoto">no photo</div>
            )}
          </div>
          <i className="nwpack-shine" aria-hidden="true" />
          {/* Marked, never rejected: the group decides. Only on the full package — at
              thumbnail size it would cover the car. */}
          {!compact && card.suspect && <span className="nwpack-check">Unverified</span>}
        </div>

        {!compact && card.caption && <div className="nwpack-flavour">{card.caption}</div>}

        <footer className="nwpack-foot">
          <span>{v.make}</span>
          <span>{v.model}</span>
          {v.year && <span>{v.year}</span>}
          {!compact && card.hood?.label && <span>{card.hood.label}</span>}
          {!compact && <span>{shortDate(card.collected_at)}</span>}
          <span className="nwpack-no">NW-{art.serial}</span>
        </footer>
      </div>
    </figure>
  );
}
