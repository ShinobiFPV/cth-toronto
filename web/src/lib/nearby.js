// Find a Park's arithmetic. Pure — no DOM, no network, no geolocation — so it runs the
// same on a phone and in a test, and so it provably sends nothing anywhere.
//
// Location never leaves the device: the fix comes from the browser (lib/location.js), the
// park positions from a static index, the collected state from data the app already has,
// and everything is computed here.
//
// And it is not verification. Nothing in this file, or anywhere, may gate a collection on
// how close a player is to a park. The game is honour-based and enforced by flagging;
// "you must be within 100m to collect" is a very natural-looking next commit that would
// quietly replace the social system the whole game rests on. Do not write it.

/** One fix, high accuracy: at street level GPS versus tower trilateration is the right park or the next one over. */
export const LOCATE_OPTIONS = Object.freeze({ enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });

const EARTH_RADIUS_M = 6371008.8;
const rad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in metres between two { lat, lng } points. */
export function haversineMetres(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * What a park would score given what is left of its Hood's park points cap. The same
 * min() as parkAward() in server/lib/parks.js — if the two ever disagree, this list is
 * lying, which is worse than not showing it. test/nearby.test.js holds them together.
 * `remaining` null means uncapped.
 */
export const awardFor = (value, remaining) =>
  (remaining == null ? value : Math.max(0, Math.min(value, remaining)));

/** Hood id → park points left this period (null for uncapped), from the Hood list. */
export const capacityByHood = (hoods = []) =>
  new Map(hoods.map((h) => [h.id, h.parks?.capacity?.remaining ?? null]));

/**
 * The nearest parks to `origin`, nearest first.
 *
 * `index` is parks.index.json ({ i, n, h, la, ln }); `state` maps park id → { v, c } from
 * /api/parks/map (its value, and whether this player has it this season). Collected
 * parks are left out unless `includeCollected` — by midseason everything near home is in
 * the binder, and a list of parks you cannot collect is worse than no list.
 */
export function nearestParks({ origin, index = [], state = new Map(), capacity = new Map(), count = 5, includeCollected = false }) {
  const rows = [];
  for (const p of index) {
    const known = state.get(p.i);
    const collected = !!known?.c;
    if (collected && !includeCollected) continue;
    const value = known?.v ?? null;
    const remaining = capacity.has(p.h) ? capacity.get(p.h) : null;
    const award = value == null || collected ? null : awardFor(value, remaining);
    rows.push({
      id: p.i,
      name: p.n,
      hood_id: p.h,
      lat: p.la,
      lng: p.ln,
      distance_m: haversineMetres(origin, { lat: p.la, lng: p.ln }),
      collected,
      value,
      award,
      // Collectable, worth something, and scoring nothing because the Hood is capped.
      xp_only: !collected && value != null && value > 0 && award === 0,
    });
  }
  rows.sort((a, b) => a.distance_m - b.distance_m || a.id - b.id);
  return rows.slice(0, count);
}

/** "80 m", "1.4 km", "12 km". */
export function formatDistance(metres) {
  if (!Number.isFinite(metres)) return '';
  if (metres < 1000) return `${Math.max(10, Math.round(metres / 10) * 10)} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}

/** A fix vaguer than the threshold gets said out loud rather than trusted. */
export function accuracyWarning(accuracy, thresholdM = 200) {
  return Number.isFinite(accuracy) && accuracy > thresholdM
    ? `Your location is only good to about ${formatDistance(accuracy)}, so these may not be the closest.`
    : null;
}

/**
 * Hand off to the phone's maps app. We do not build routing. Apple Maps on iOS and macOS,
 * a geo: URI on Android, Google Maps on the web everywhere else.
 */
export function directionsUrl({ lat, lng, name = '' }, userAgent = (typeof navigator !== 'undefined' ? navigator.userAgent : '')) {
  const label = encodeURIComponent(name);
  if (/iPhone|iPad|iPod|Macintosh/.test(userAgent)) {
    return `https://maps.apple.com/?daddr=${lat},${lng}&q=${label}`;
  }
  if (/Android/.test(userAgent)) return `geo:${lat},${lng}?q=${lat},${lng}(${label})`;
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

/**
 * Why location did not work, in words, with a way forward. Every failure falls back to
 * the Hood picker — none is a dead end.
 */
export function locateFailure(error, { secure = true, supported = true } = {}) {
  const base = { fallback: 'hood-picker' };
  if (!supported) {
    return { ...base, code: 'unsupported', title: 'No location on this device',
      message: 'This browser cannot share a location. Pick a Hood instead.' };
  }
  if (!secure || error?.code === 'insecure') {
    return { ...base, code: 'insecure', title: 'Location needs the secure address',
      message: 'Browsers only share a location over HTTPS. Open cth.shintech.online rather than a LAN address — or pick a Hood.' };
  }
  switch (error?.code) {
    case 1:
      return { ...base, code: 'denied', title: 'Location is switched off for this app',
        message: 'To turn it back on: on an iPhone, Settings › Privacy & Security › Location Services › Safari Websites (or the app). '
          + 'On Android, tap the icon by the address bar › Permissions › Location. Or pick a Hood below.' };
    case 3:
      return { ...base, code: 'timeout', title: 'Could not get a fix in time',
        message: 'Step outside or away from tall buildings and try again — or pick a Hood.' };
    default:
      return { ...base, code: 'unavailable', title: 'Your location is not available right now',
        message: 'Try again in a moment — or pick a Hood.' };
  }
}
