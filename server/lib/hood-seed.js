// The 25 City of Toronto wards — the game's "Hoods". Never call them wards in UI copy.
// Names and centroids come from City of Toronto Open Data, dataset `city-wards` (the
// 25-ward 2018 boundaries), licensed under the Open Government Licence – Toronto.
// `npm run import-hoods` refreshes these from the live source and emits the map layer;
// this seed only exists so a fresh checkout is playable before anyone downloads 1 MB
// of GeoJSON.
export const HOOD_SEED = [
  { id:  1, name: "Etobicoke North", lat: 43.72141, lng: -79.57387 },
  { id:  2, name: "Etobicoke Centre", lat: 43.65481, lng: -79.55815 },
  { id:  3, name: "Etobicoke-Lakeshore", lat: 43.61419, lng: -79.50358 },
  { id:  4, name: "Parkdale-High Park", lat: 43.64148, lng: -79.46409 },
  { id:  5, name: "York South-Weston", lat: 43.69388, lng: -79.49671 },
  { id:  6, name: "York Centre", lat: 43.74976, lng: -79.46262 },
  { id:  7, name: "Humber River-Black Creek", lat: 43.74561, lng: -79.53783 },
  { id:  8, name: "Eglinton-Lawrence", lat: 43.72517, lng: -79.43085 },
  { id:  9, name: "Davenport", lat: 43.66752, lng: -79.44369 },
  { id: 10, name: "Spadina-Fort York", lat: 43.63012, lng: -79.39286 },
  { id: 11, name: "University-Rosedale", lat: 43.67663, lng: -79.38042 },
  { id: 12, name: "Toronto-St. Paul's", lat: 43.68819, lng: -79.41116 },
  { id: 13, name: "Toronto Centre", lat: 43.66204, lng: -79.36489 },
  { id: 14, name: "Toronto-Danforth", lat: 43.63903, lng: -79.33439 },
  { id: 15, name: "Don Valley West", lat: 43.72185, lng: -79.36785 },
  { id: 16, name: "Don Valley East", lat: 43.72858, lng: -79.33703 },
  { id: 17, name: "Don Valley North", lat: 43.78162, lng: -79.36017 },
  { id: 18, name: "Willowdale", lat: 43.76802, lng: -79.41598 },
  { id: 19, name: "Beaches-East York", lat: 43.67134, lng: -79.30186 },
  { id: 20, name: "Scarborough Southwest", lat: 43.7029, lng: -79.24221 },
  { id: 21, name: "Scarborough Centre", lat: 43.75714, lng: -79.28036 },
  { id: 22, name: "Scarborough-Agincourt", lat: 43.79036, lng: -79.30694 },
  { id: 23, name: "Scarborough North", lat: 43.80823, lng: -79.24184 },
  { id: 24, name: "Scarborough-Guildwood", lat: 43.75249, lng: -79.20778 },
  { id: 25, name: "Scarborough-Rouge Park", lat: 43.78861, lng: -79.15705 },
];

export const HOOD_NAMES = Object.fromEntries(HOOD_SEED.map(h => [h.id, h.name]));

/** "Hood 13 — Toronto Centre" — the one true way to render a Hood in copy (spec §1.1). */
export function hoodLabel(id, name) {
  return `Hood ${id} — ${name ?? HOOD_NAMES[id] ?? '?'}`;
}

/**
 * Which Hoods border which. Derived from the boundary file: in a proper GIS coverage
 * adjacent wards share exact vertices, so two Hoods are neighbours when they share at
 * least two of them — two rather than one, so a pair merely touching at a single corner
 * does not count as a shared border.
 *
 * This drives the adjacent-conquer cooldown (spec §1.3). `npm run import-hoods`
 * recomputes it from the live source; this seed keeps a fresh checkout playable.
 */
export const NEIGHBOUR_SEED = {
   1: [2, 5, 7],
   2: [1, 3, 4, 5],
   3: [2, 4],
   4: [2, 3, 5, 9, 10],
   5: [1, 2, 4, 6, 7, 8, 9],
   6: [5, 7, 8, 18],
   7: [1, 5, 6],
   8: [5, 6, 9, 12, 15, 18],
   9: [4, 5, 8, 10, 11, 12],
  10: [4, 9, 11, 13, 14],
  11: [9, 10, 12, 13, 14, 15],
  12: [8, 9, 11, 15],
  13: [10, 11, 14],
  14: [10, 11, 13, 15, 16, 19],
  15: [8, 11, 12, 14, 16, 17, 18],
  16: [14, 15, 17, 19, 20, 21],
  17: [15, 16, 18, 22],
  18: [6, 8, 15, 17],
  19: [14, 16, 20],
  20: [16, 19, 21, 24],
  21: [16, 20, 22, 23, 24],
  22: [17, 21, 23],
  23: [21, 22, 24, 25],
  24: [20, 21, 23, 25],
  25: [23, 24],
};

/** Neighbours of a Hood, or [] for an id that does not exist. */
export const neighboursOf = (id) => NEIGHBOUR_SEED[id] ?? [];
