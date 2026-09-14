// Turning a seed into five hunt items. Pure: the same seed and the same inputs always give
// the same five, which is what makes "why did I get this hunt" answerable.
import crypto from 'node:crypto';
import {
  AMENITY_ITEMS, UNIVERSAL_ITEMS, WILDLIFE_ITEMS, HUNT_SEASONS, MAX_WILDLIFE, PASSENGER_BODY_STYLES,
} from './hunt-pool.js';

export const HUNT_SIZE = 5;

/** mulberry32 over a hash of the seed. */
export function rngFor(seed) {
  let a = parseInt(crypto.createHash('sha256').update(`cth-hunt:${seed}`).digest('hex').slice(0, 8), 16);
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shuffle = (list, rand) => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

const MONTH = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', month: 'numeric' });

/**
 * Which season a hunt is filtered for: the game's season by name, or — between seasons —
 * the calendar season in Toronto.
 */
export function seasonKeyFor(at, season = null) {
  const named = season?.name?.split(/\s+/)[0]?.toLowerCase();
  if (HUNT_SEASONS.includes(named)) return named;
  const month = Number(MONTH.format(new Date(at)));
  if (month === 12 || month <= 2) return 'winter';
  if (month <= 5) return 'spring';
  if (month <= 8) return 'summer';
  return 'fall';
}

const inSeason = (item, season) => item.seasons.includes(season);

/**
 * A park hunt. At least two items from the park's own amenities when it has two worth
 * photographing this season (three, sometimes, when it has more), the rest universal and
 * wildlife, never more than two animals. A park with no amenity record still gets five
 * items — generation never blocks on a missing join.
 */
export function generateParkHunt({ seed, amenities = [], season }) {
  const rand = rngFor(seed);

  // Sorted before shuffling, so the order the amenities arrive in cannot change the draw.
  const specific = shuffle([...new Set(amenities)]
    .filter((key) => AMENITY_ITEMS[key] && inSeason(AMENITY_ITEMS[key], season))
    .sort(), rand);
  const takeSpecific = Math.min(specific.length, specific.length >= 3 && rand() < 0.5 ? 3 : 2);
  const picked = specific.slice(0, takeSpecific)
    .map((key) => ({ target_type: 'amenity', target_key: key, label: AMENITY_ITEMS[key].label }));

  const general = shuffle([
    ...UNIVERSAL_ITEMS.map((item) => ({ ...item, type: 'universal' })),
    ...WILDLIFE_ITEMS.map((item) => ({ ...item, type: 'wildlife' })),
  ].filter((item) => inSeason(item, season)), rand);

  let animals = 0;
  for (const item of general) {
    if (picked.length >= HUNT_SIZE) break;
    if (item.type === 'wildlife') {
      if (animals >= MAX_WILDLIFE) continue;
      animals += 1;
    }
    picked.push({ target_type: item.type, target_key: item.key, label: item.label });
  }

  return shuffle(picked, rand).map((item, slot) => ({ ...item, slot }));
}

/** Whether a vehicle-list entry is something a street hunt may ask for. */
export function validHuntVehicle(v) {
  return !!v
    && typeof v.key === 'string' && typeof v.make === 'string' && typeof v.model === 'string'
    && Array.isArray(v.years) && v.years.length === 2
    && Number.isInteger(v.years[0]) && Number.isInteger(v.years[1]) && v.years[0] < v.years[1]
    && (v.tier === 'common' || v.tier === 'uncommon')
    && PASSENGER_BODY_STYLES.includes(v.body_style);
}

/** "Honda Civic, 2016–2021" — the label a street target is frozen with. */
export const vehicleLabel = (v) => `${v.make} ${v.model}, ${v.years[0]}–${v.years[1]}`;

/**
 * A street hunt: commonality instead of difficulty tiers. Three common targets start the
 * hunt fast; two uncommon ones give it a tail worth a week.
 */
export function generateStreetHunt({ seed, vehicles, common = 3, uncommon = 2 }) {
  const rand = rngFor(seed);
  const pool = (vehicles ?? []).filter(validHuntVehicle)
    .sort((a, b) => a.key.localeCompare(b.key));
  const commons = shuffle(pool.filter((v) => v.tier === 'common'), rand).slice(0, common);
  const uncommons = shuffle(pool.filter((v) => v.tier === 'uncommon'), rand).slice(0, uncommon);
  if (commons.length < common || uncommons.length < uncommon) {
    throw new Error(`The vehicle list needs ${common} common and ${uncommon} uncommon passenger vehicles.`);
  }
  const picked = [...commons, ...uncommons].map((v) => ({
    target_type: 'vehicle_model',
    target_key: v.key,
    label: vehicleLabel(v),
    tier: v.tier,
    target: { make: v.make, model: v.model, years: v.years, body_style: v.body_style, tier: v.tier },
  }));
  return shuffle(picked, rand).map((item, slot) => ({ ...item, slot }));
}
