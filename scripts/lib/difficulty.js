// The difficulty score: what a Hood is worth, from how hard it is to get to.
//
// Two inputs, weighted 65/35:
//
//   distance from the city centre (65%)
//     The dominant cost. Everything in this game is a trip you have to actually make,
//     and the difference between Rouge Park and University-Rosedale is an afternoon.
//
//   isolation, from how many Hoods border it (35%)
//     FEWER borders is harder. A Hood with two neighbours is a cul-de-sac you commit a
//     dedicated journey to; one with seven has approaches from every direction and you
//     will pass through it anyway. This is also why Etobicoke-Lakeshore scores above
//     what its distance alone would suggest — it is a long thin waterfront strip with
//     only two ways in.
//
// Both inputs are normalised across the 25 Hoods, combined, then the result is
// normalised again and mapped onto 5–50. Normalising the combination is what guarantees
// the range is used end to end: the easiest Hood is always exactly 5 and the hardest
// always exactly 50, however the city's geography happens to be shaped.
//
// Sanity check the output against the spec, which jokes about Rouge Park being the Hood
// that nobody visits until the points force them to. It scores 50. If a change to this
// file stops Rouge Park being the most expensive Hood in Toronto, the change is wrong.

/** Nathan Phillips Square — the uncontroversial centre of Toronto. */
export const CITY_CENTRE = { lat: 43.6534, lng: -79.3841 };

export const MIN_DIFFICULTY = 5;
export const MAX_DIFFICULTY = 50;

const WEIGHT_DISTANCE = 0.65;
const WEIGHT_ISOLATION = 0.35;

/** Great-circle distance in kilometres. */
export function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** A 0..1 normaliser over `values`; returns 0 for everything if they are all equal. */
function normaliser(values) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return (v) => (hi === lo ? 0 : (v - lo) / (hi - lo));
}

/**
 * Score every Hood.
 *
 * @param {Array<{id:number, lat:number, lng:number, borders:number}>} hoods
 * @returns {Map<number, {difficulty:number, distance_km:number, borders:number}>}
 */
export function computeDifficulty(hoods) {
  if (!hoods.length) return new Map();

  const measured = hoods.map((h) => ({
    id: h.id,
    borders: h.borders,
    distance: haversineKm(CITY_CENTRE, { lat: h.lat, lng: h.lng }),
  }));

  const normDistance = normaliser(measured.map((m) => m.distance));
  const normBorders = normaliser(measured.map((m) => m.borders));

  const rawScored = measured.map((m) => ({
    ...m,
    raw: WEIGHT_DISTANCE * normDistance(m.distance)
       + WEIGHT_ISOLATION * (1 - normBorders(m.borders)),
  }));

  const normRaw = normaliser(rawScored.map((r) => r.raw));
  const range = MAX_DIFFICULTY - MIN_DIFFICULTY;

  return new Map(rawScored.map((r) => [r.id, {
    difficulty: Math.round(MIN_DIFFICULTY + normRaw(r.raw) * range),
    distance_km: Math.round(r.distance * 10) / 10,
    borders: r.borders,
  }]));
}
