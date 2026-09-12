// Inverse transverse Mercator, enough to normalise the City of Toronto ward file to
// WGS84 if you hand the importer a projected variant instead of the 4326 one.
//
// The city publishes the ward geometry in several CRSs. Two of them make sense for
// Toronto and are supported here:
//
//   EPSG:2952  NAD83(CSRS) / MTM zone 10  — central meridian -79.5°, what the city
//              actually ships as its "2952" resource (eastings around 300 000 m)
//   EPSG:26917 NAD83 / UTM zone 17N       — and its CSRS/WGS84 twins 2958 / 32617
//
// The dataset's "2945" resource is MTM zone 4, a Quebec zone roughly 20° off Toronto's
// meridian; the transverse Mercator series is not accurate that far out, so it is
// rejected with a pointer at the 4326 resource rather than silently mangled.
//
// NAD83 and WGS84 differ by centimetres at Toronto's latitude — irrelevant beside the
// ~8 m simplification tolerance — so no datum shift is applied. Verified against the
// city's own 4326 file; see test/reproject.test.js.

const GRS80 = { a: 6378137.0, f: 1 / 298.257222101 };

const PROJECTIONS = {
  // NAD83(CSRS) / MTM zone 10 — 3-degree Ontario zone centred on Toronto.
  'EPSG:2952': { lon0: -79.5, k0: 0.9999, fe: 304800, fn: 0 },
  // NAD83 / UTM zone 17N, and the CSRS and WGS84 realisations of the same grid.
  'EPSG:26917': { lon0: -81, k0: 0.9996, fe: 500000, fn: 0 },
  'EPSG:2958': { lon0: -81, k0: 0.9996, fe: 500000, fn: 0 },
  'EPSG:32617': { lon0: -81, k0: 0.9996, fe: 500000, fn: 0 },
};

/**
 * What CRS a GeoJSON is in: 'wgs84', an EPSG key above, or throws.
 *
 * The `crs` member was dropped in RFC 7946 but the city still emits it, and the
 * coordinate magnitudes settle it either way — degrees never exceed 180.
 */
export function detectCrs(collection) {
  const name = collection?.crs?.properties?.name ?? '';
  const epsg = /(?:EPSG|epsg)[:\s]*(\d{4,5})/.exec(name)?.[1];

  if (/CRS84|4326/.test(name)) return 'wgs84';
  if (epsg && PROJECTIONS[`EPSG:${epsg}`]) return `EPSG:${epsg}`;
  if (epsg) {
    throw new Error(
      `This file is in EPSG:${epsg}, which is not one of the Toronto-local grids this ` +
      'importer can invert. Re-run with the EPSG:4326 GeoJSON resource (the default).');
  }

  const sample = firstCoordinate(collection);
  if (!sample) throw new Error('GeoJSON has no coordinates to inspect');
  const [x, y] = sample;
  if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return 'wgs84';

  // Projected metres, no CRS member. Distinguish by easting: UTM 17N puts Toronto
  // near 620 000 m, MTM zone 10 near 310 000 m.
  if (x > 450000 && x < 800000) return 'EPSG:26917';
  if (x > 200000 && x < 450000) return 'EPSG:2952';
  throw new Error(
    `Cannot identify the coordinate system (first coordinate ${x}, ${y}). ` +
    'Re-run with the EPSG:4326 GeoJSON resource.');
}

function firstCoordinate(collection) {
  for (const f of collection.features ?? []) {
    let c = f.geometry?.coordinates;
    while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
    if (Array.isArray(c) && typeof c[0] === 'number') return c;
  }
  return null;
}

/** Deep-map a FeatureCollection's coordinates through the inverse projection. */
export function reprojectToWgs84(collection, crs) {
  const proj = PROJECTIONS[crs];
  if (!proj) throw new Error(`No inverse projection for ${crs}`);
  const walk = (c) => (typeof c[0] === 'number' ? inverseTM(c[0], c[1], proj) : c.map(walk));
  return {
    ...collection,
    crs: undefined,
    features: collection.features.map((f) => ({
      ...f,
      geometry: f.geometry && { ...f.geometry, coordinates: walk(f.geometry.coordinates) },
    })),
  };
}

/**
 * Inverse transverse Mercator (Snyder, Map Projections — A Working Manual, eqs 8-1
 * to 8-8, series form). Sub-millimetre within a few degrees of the central meridian,
 * which covers all of Toronto in both zones.
 */
export function inverseTM(easting, northing, { lon0, k0, fe, fn }) {
  const { a, f } = GRS80;
  const e2 = f * (2 - f);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const ep2 = e2 / (1 - e2);

  const x = easting - fe;
  const y = northing - fn;

  const M = y / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));

  const phi1 = mu
    + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu)
    + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const tan1 = Math.tan(phi1);

  const C1 = ep2 * cos1 ** 2;
  const T1 = tan1 ** 2;
  const N1 = a / Math.sqrt(1 - e2 * sin1 ** 2);
  const R1 = (a * (1 - e2)) / (1 - e2 * sin1 ** 2) ** 1.5;
  const D = x / (N1 * k0);

  const lat = phi1 - ((N1 * tan1) / R1) * (
    D ** 2 / 2
    - ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6) / 720
  );

  const lon = (lon0 * Math.PI) / 180 + (
    D
    - ((1 + 2 * T1 + C1) * D ** 3) / 6
    + ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5) / 120
  ) / cos1;

  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}
