// Device location: one fix for Find a Park, a watch for the dot on the map.
//
// Nothing here talks to the server, and nothing may. A position is used on the phone and
// thrown away — see lib/nearby.js and server/lib/privacy.js.
//
// Two rules about asking:
//   - Never on load. A permission prompt on cold start is dismissed on reflex, and once a
//     browser has a denial recorded the app cannot ask again. The prompt is only ever
//     triggered by tapping Find a Park or the locate button — gestures where the reason is
//     obvious.
//   - Only over HTTPS. Geolocation needs a secure context: cth.shintech.online is fine,
//     http://192.168.x.x is not, and there it fails without saying so. localhost is exempt.
//
// This is a convenience, not verification. It must never become a geofence.
import { LOCATE_OPTIONS } from './nearby.js';

export const locationSupported = () =>
  typeof navigator !== 'undefined' && 'geolocation' in navigator;

export const secureContext = () =>
  typeof window === 'undefined' || window.isSecureContext !== false;

const shape = (pos) => ({
  lat: pos.coords.latitude,
  lng: pos.coords.longitude,
  accuracy: pos.coords.accuracy,
  at: pos.timestamp,
});

/** One high-accuracy fix. Rejects with the GeolocationPositionError, or { code: 'insecure' }. */
export function getFix(options = LOCATE_OPTIONS) {
  return new Promise((resolve, reject) => {
    if (!locationSupported()) { reject({ code: 'unsupported' }); return; }
    if (!secureContext()) { reject({ code: 'insecure' }); return; }
    navigator.geolocation.getCurrentPosition((pos) => resolve(shape(pos)), reject, options);
  });
}

/**
 * Follow the position while the dot is on. It drains a battery in a way one fix does not,
 * so the caller stops it on leaving the map, on hiding the tab, and on turning it off.
 * Returns the stop function.
 */
export function watchFix(onFix, onError) {
  if (!locationSupported()) { onError({ code: 'unsupported' }); return () => {}; }
  if (!secureContext()) { onError({ code: 'insecure' }); return () => {}; }
  const id = navigator.geolocation.watchPosition((pos) => onFix(shape(pos)), onError,
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  return () => navigator.geolocation.clearWatch(id);
}
