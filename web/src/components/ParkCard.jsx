// The Parkemon card.
//
// Every collection renders one of these: the photo of the park sign in the window, the
// park's name on the plate, its value where a Pokémon card would put HP, and a border
// that is unique to that card.
//
// "Unique" is procedural, not random. The server stores a card_seed derived from
// (player, park, season), so the art is deterministic — reload the app and you get the
// same card back, and two players who collect the same park in the same season still get
// visibly different borders. The SEASON picks the palette; the SEED picks the ornament,
// the hatch, the foil angle and the corner motif.
//
// All of it is inline SVG and CSS gradients. Nothing is rasterised, nothing is fetched,
// and the Pi never renders a pixel of it.
import { useMemo } from 'react';

/**
 * One palette per season, so a Fall card is recognisable across the room from a Winter
 * one. Keyed by season id with a name fallback, because a re-seeded database could
 * renumber them.
 */
const SEASON_THEMES = {
  1: {
    key: 'fall',
    label: 'Fall',
    ink: '#1A0F06',
    paper: '#2A1A0D',
    frame: ['#C86A18', '#F0A33C', '#7A3B08'],
    foil: ['#FFD08A', '#C86A18', '#FFE9C4'],
    glyph: '🍁',
  },
  2: {
    key: 'winter',
    label: 'Winter',
    ink: '#06101A',
    paper: '#0E1A26',
    frame: ['#4A8CB8', '#A8D8F0', '#1E4A68'],
    foil: ['#E8F6FF', '#6FB0D8', '#FFFFFF'],
    glyph: '❄',
  },
  3: {
    key: 'spring',
    label: 'Spring',
    ink: '#08160C',
    paper: '#0F2416',
    frame: ['#3C9A52', '#8FD8A0', '#1C5E2C'],
    foil: ['#DFFFE6', '#5EC078', '#FFD6E8'],
    glyph: '🌸',
  },
  4: {
    key: 'summer',
    label: 'Summer',
    ink: '#06181A',
    paper: '#0C2A2C',
    frame: ['#0E9A94', '#5FE0D6', '#06605C'],
    foil: ['#D6FFFA', '#2FC4BA', '#FFE98A'],
    glyph: '☀',
  },
};

const themeFor = (season) => {
  if (SEASON_THEMES[season?.id]) return SEASON_THEMES[season.id];
  const name = String(season?.name ?? '').toLowerCase();
  return Object.values(SEASON_THEMES).find((t) => name.includes(t.key)) ?? SEASON_THEMES[1];
};

/** Rarity decides how much the frame shows off, not what it is worth. */
const RARITY_STYLE = {
  common: { ornaments: 0, strokes: 1, foil: 0, label: 'Common' },
  uncommon: { ornaments: 2, strokes: 2, foil: 0.25, label: 'Uncommon' },
  rare: { ornaments: 4, strokes: 2, foil: 0.55, label: 'Rare' },
  legendary: { ornaments: 4, strokes: 3, foil: 0.9, label: 'Legendary' },
};

/**
 * mulberry32, seeded from the card_seed hex. Deterministic and tiny — the whole point is
 * that the same seed always draws the same border.
 */
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

const W = 320;
const H = 448;

export default function ParkCard({ card, compact = false, onClick }) {
  const art = useMemo(() => buildArt(card), [card?.card_seed, card?.rarity, card?.season?.id]);
  if (!card) return null;

  const { theme, rarity, pattern, corners, foilAngle, hue } = art;
  const uid = `c${card.claim_id ?? card.card_seed ?? 'x'}`;

  return (
    <figure
      className={`pcard ${compact ? 'pcard-compact' : ''} pcard-${theme.key} pcard-${card.rarity}`}
      onClick={onClick}
      style={{ '--pc-ink': theme.ink, '--pc-paper': theme.paper, '--pc-edge': theme.frame[0] }}
    >
      <svg className="pcard-frame" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <defs>
          <linearGradient id={`${uid}-edge`} gradientTransform={`rotate(${foilAngle} 0.5 0.5)`}>
            <stop offset="0%" stopColor={theme.frame[1]} />
            <stop offset="45%" stopColor={theme.frame[0]} />
            <stop offset="100%" stopColor={theme.frame[2]} />
          </linearGradient>

          <linearGradient id={`${uid}-foil`} gradientTransform={`rotate(${foilAngle + 30} 0.5 0.5)`}>
            <stop offset="0%" stopColor={theme.foil[0]} stopOpacity="0" />
            <stop offset="42%" stopColor={theme.foil[0]} stopOpacity={rarity.foil} />
            <stop offset="52%" stopColor={theme.foil[2]} stopOpacity={rarity.foil} />
            <stop offset="62%" stopColor={theme.foil[1]} stopOpacity={rarity.foil * 0.6} />
            <stop offset="100%" stopColor={theme.foil[1]} stopOpacity="0" />
          </linearGradient>

          {/* The procedural bit: a hatch tile whose angle, spacing and weight all come
              out of the seed, so no two cards carry the same weave. */}
          <pattern id={`${uid}-hatch`} width={pattern.gap} height={pattern.gap}
                   patternTransform={`rotate(${pattern.angle})`} patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2={pattern.gap}
                  stroke={theme.frame[1]} strokeWidth={pattern.weight} opacity="0.5" />
            {pattern.cross && (
              <line x1="0" y1="0" x2={pattern.gap} y2="0"
                    stroke={theme.frame[2]} strokeWidth={pattern.weight * 0.7} opacity="0.35" />
            )}
          </pattern>
        </defs>

        {/* Outer bezel, hatched */}
        <rect x="0" y="0" width={W} height={H} fill={`url(#${uid}-edge)`} />
        <rect x="0" y="0" width={W} height={H} fill={`url(#${uid}-hatch)`} />

        {/* Inner rules. Legendary gets a third line, common gets one. */}
        {Array.from({ length: rarity.strokes }, (_, i) => (
          <rect key={i} x={7 + i * 4} y={7 + i * 4}
                width={W - 14 - i * 8} height={H - 14 - i * 8}
                fill="none" stroke={i % 2 ? theme.frame[2] : theme.foil[0]}
                strokeWidth={i === 0 ? 2 : 1} opacity={i === 0 ? 0.9 : 0.5} />
        ))}

        {/* Corner motifs, one of four shapes, rotated per corner by the seed. */}
        {corners.map((c, i) => (
          <g key={i} transform={`translate(${c.x} ${c.y}) rotate(${c.rot}) scale(${c.s})`}
             fill="none" stroke={theme.foil[0]} strokeWidth="1.6" opacity="0.85">
            {c.shape === 0 && <path d="M0 0 L14 0 M0 0 L0 14 M4 4 L10 10" />}
            {c.shape === 1 && <path d="M0 0 L16 0 L0 16 Z" />}
            {c.shape === 2 && <path d="M2 2 L12 2 L12 12 L2 12 Z M6 6 L8 6" />}
            {c.shape === 3 && <path d="M0 8 L8 0 L16 8 L8 16 Z" />}
          </g>
        ))}

        {/* The holo sweep, strongest on a legendary. */}
        {rarity.foil > 0 && (
          <rect x="2" y="2" width={W - 4} height={H - 4} fill={`url(#${uid}-foil)`}
                style={{ mixBlendMode: 'screen' }} />
        )}
      </svg>

      <div className="pcard-inner" style={{ filter: `hue-rotate(${hue}deg)` }}>
        <header className="pcard-head">
          <span className="pcard-name" title={card.park.name}>{card.park.name}</span>
          <span className="pcard-value" aria-label={`${card.points} points`}>
            {card.points}
          </span>
        </header>

        <div className="pcard-window">
          {card.display_url || card.thumb_url ? (
            <img src={compact ? (card.thumb_url ?? card.display_url) : (card.display_url ?? card.thumb_url)}
                 alt={`The park sign at ${card.park.name}`} loading="lazy" />
          ) : (
            <div className="pcard-nophoto">no photo</div>
          )}
        </div>

        <div className="pcard-body">
          <div className="pcard-where">{card.park.hood_label}</div>
          {!compact && card.park.address && (
            <div className="pcard-addr">{card.park.address}</div>
          )}
        </div>

        <footer className="pcard-foot">
          <span className="pcard-rarity">{theme.glyph} {card.rarity_label}</span>
          <span className="pcard-season">{card.season?.name}</span>
          <span className="pcard-no">
            #{String(card.park.set_number ?? card.park.id).padStart(4, '0')}
            {card.set_size ? `/${card.set_size}` : ''}
          </span>
        </footer>
      </div>
    </figure>
  );
}

function buildArt(card) {
  const theme = themeFor(card?.season);
  const rarity = RARITY_STYLE[card?.rarity] ?? RARITY_STYLE.common;
  const rand = rng(card?.card_seed);

  const pattern = {
    angle: Math.floor(rand() * 180),
    gap: 5 + Math.floor(rand() * 7),
    weight: 0.7 + rand() * 1.4,
    cross: rand() > 0.5,
  };

  const shape = Math.floor(rand() * 4);
  const positions = [
    { x: 12, y: 12 }, { x: W - 28, y: 12 },
    { x: 12, y: H - 28 }, { x: W - 28, y: H - 28 },
  ];
  const corners = positions.slice(0, rarity.ornaments).map((p, i) => ({
    ...p,
    shape,
    rot: i * 90 + (rand() > 0.7 ? 45 : 0),
    s: 0.85 + rand() * 0.4,
  }));

  return {
    theme,
    rarity,
    pattern,
    corners,
    foilAngle: Math.floor(rand() * 360),
    // A few degrees of drift so even two same-season commons are not identical.
    hue: Math.round((rand() - 0.5) * 16),
  };
}

export { SEASON_THEMES, themeFor };
