// The map is the hero (spec §7): 25 Hoods filled in their owner's colour, unclaimed
// ones neutral grey with their point value at the centroid, and a subtle pulse on your
// own Hoods once they cross the 72-hour reinforce gate.
//
// Leaflet is driven directly rather than through a React wrapper: the layers are
// created once and then restyled in place on every state change, which keeps the map
// from flickering each time somebody's claim lands over the socket.
import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useGame } from '../lib/store.jsx';
import { hoodColour } from '../lib/game.js';
import HoodSheet from '../components/HoodSheet.jsx';

// Basemap. The default is plain OpenStreetMap raster, darkened in CSS — keyless, which
// matters because CARTO's dark_all endpoint now stamps "API KEY REQUIRED" across every
// tile. OSM's tile policy is fine for six people; if this ever grows, set the three
// VITE_MAP_* variables at build time to point at a keyed provider and turn the filter off.
const TILES = import.meta.env.VITE_MAP_TILES
  || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIB = import.meta.env.VITE_MAP_ATTRIB
  || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &middot; ' +
     'Hoods: City of Toronto (OGL&nbsp;&ndash;&nbsp;Toronto)';
// Darkening is only correct for a light basemap; a provider that is already dark should
// set VITE_MAP_DARKEN=false.
const DARKEN = (import.meta.env.VITE_MAP_DARKEN ?? 'true') !== 'false';

export default function MapScreen() {
  const { hoods, player } = useGame();
  const [geo, setGeo] = useState(null);
  const [geoError, setGeoError] = useState(null);
  const [selected, setSelected] = useState(null);

  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef(new Map());      // hood id → { polygon, label }
  const byId = useMemo(() => new Map(hoods.map((h) => [h.id, h])), [hoods]);

  // ── the boundary file, fetched once and cached by the service worker ────
  useEffect(() => {
    let cancelled = false;
    fetch('/hoods.min.geojson')
      .then((r) => {
        if (!r.ok) throw new Error(`hoods.min.geojson → HTTP ${r.status}`);
        return r.json();
      })
      .then((g) => !cancelled && setGeo(g))
      .catch((err) => !cancelled && setGeoError(err.message));
    return () => { cancelled = true; };
  }, []);

  // ── create the map once ─────────────────────────────────────────────────
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return undefined;
    const map = L.map(mapEl.current, {
      zoomControl: true,
      attributionControl: true,
      // SVG, not canvas: the reinforce pulse is a CSS animation on the polygon's
      // path element, and canvas rendering would leave nothing to animate.
      preferCanvas: false,
      maxZoom: 17,
      minZoom: 9,
    }).setView([43.72, -79.38], 10);
    L.tileLayer(TILES, { attribution: ATTRIB, maxZoom: 19 }).addTo(map);
    mapRef.current = map;

    // Leaflet measures its container on creation. Inside a freshly mounted grid that
    // measurement is often wrong, which leaves the map fitted to the wrong viewport —
    // so re-measure on the next frame and whenever the container actually resizes.
    const resize = () => map.invalidateSize({ animate: false });
    requestAnimationFrame(resize);
    const observer = new ResizeObserver(resize);
    observer.observe(mapEl.current);

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      layersRef.current.clear();
    };
  }, []);

  // ── draw the Hoods once the geometry arrives ────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !geo) return;

    const group = L.featureGroup().addTo(map);
    // Fitting is done against the polygons alone. The centroid labels are markers, and
    // their icon boxes would pad the bounds northward and shove the city off centre.
    const shapes = L.featureGroup();
    for (const feature of geo.features) {
      const id = feature.properties.id;
      const polygon = L.geoJSON(feature).addTo(group);
      shapes.addLayer(polygon);
      polygon.on('click', () => setSelected(id));

      const label = L.marker([feature.properties.lat, feature.properties.lng], {
        interactive: false,
        icon: L.divIcon({ className: 'hood-label', html: '', iconSize: [44, 30], iconAnchor: [22, 15] }),
      }).addTo(group);

      // Leaflet exposes no public accessor for a Path's rendered element, so this
      // reaches for _path once, at creation, and holds onto it. It is stable for the
      // life of the layer.
      const shape = polygon.getLayers()[0];
      const pathEl = shape?._path ?? null;
      if (pathEl) {
        pathEl.setAttribute('role', 'button');
        pathEl.setAttribute('tabindex', '0');
        pathEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(id); }
        });
      }

      layersRef.current.set(id, { polygon, label, pathEl });
    }
    // Fit after the container has been measured, or Toronto ends up a smudge in the
    // middle of Southern Ontario.
    const fit = () => {
      map.invalidateSize({ animate: false });
      map.fitBounds(shapes.getBounds(), { padding: [10, 10] });
      // Toronto is the whole world here. Pin the city in place: you cannot zoom out
      // past the fitted view, and panning stops before the map is all lake. On a phone
      // the viewport is taller than the city, and Leaflet simply centres the axis that
      // does not fit, which is what we want anyway.
      map.setMinZoom(map.getZoom());
      map.setMaxBounds(shapes.getBounds().pad(0.4));
    };
    fit();
    requestAnimationFrame(fit);

    return () => { group.remove(); layersRef.current.clear(); };
  }, [geo]);

  // ── restyle on every state change ───────────────────────────────────────
  useEffect(() => {
    if (!layersRef.current.size) return;
    for (const [id, { polygon, label, pathEl }] of layersRef.current) {
      const hood = byId.get(id);
      if (!hood) continue;
      const colour = hoodColour(hood);
      const ready = hood.viewer?.reinforce_ready;
      const blocked = hood.viewer?.adjacent_blocked;

      polygon.setStyle({
        color: colour,
        weight: hood.owner ? 2 : 1.5,
        opacity: 0.95,
        fillColor: colour,
        fillOpacity: hood.owner ? 0.42 : 0.14,
        dashArray: hood.owner ? null : '4 4',
      });

      // The pulse rides on the SVG path itself, so it survives pan and zoom.
      if (pathEl) {
        pathEl.classList.toggle('hood-ready', !!ready);
        pathEl.classList.toggle('hood-blocked', !!blocked);
        pathEl.setAttribute('aria-label', `${hood.label} — ${
          hood.owner ? `held by ${hood.owner.display_name}`
            : blocked ? `unclaimed, but closed to you for ${hood.viewer.countdown}`
            : `unclaimed, worth ${hood.unclaimed_value}`}`);
      }

      const el = label.getElement();
      if (el) {
        el.innerHTML =
          `<span class="n" style="color:${hood.owner ? colour : blocked ? '#6B7480' : '#C6CFD8'}">${hood.id}</span>`
          + (hood.owner ? ''
            : blocked ? `<span class="v" style="color:#6B7480">${hood.viewer.countdown}</span>`
            : `<span class="v">+${hood.unclaimed_value}</span>`);
        el.classList.toggle('hood-ready', !!ready);
        el.title = hood.label;
      }
    }
  }, [byId]);

  const mine = hoods.filter((h) => h.owner?.id === player?.id);
  const ready = mine.filter((h) => h.viewer?.reinforce_ready);
  const unclaimed = hoods.filter((h) => !h.owner);
  const blocked = hoods.filter((h) => h.viewer?.adjacent_blocked);

  return (
    <div className="map-wrap">
      <div className={`map ${DARKEN ? 'map-dark' : ''}`} ref={mapEl}
           role="application" aria-label="Map of Toronto's 25 Hoods" />

      {geoError && (
        <div className="map-legend" style={{ maxWidth: '80vw' }}>
          <b style={{ color: 'var(--bad)' }}>No Hood boundaries.</b>
          <div className="tiny dim">Run <code>npm run import-hoods</code> on the server.</div>
        </div>
      )}

      {!geoError && (
        <div className="map-legend">
          <div className="row"><b>{mine.length}</b><span className="dim">yours</span></div>
          <div className="row"><b>{unclaimed.length}</b><span className="dim">unclaimed</span></div>
          {ready.length > 0 && (
            <div className="row" style={{ color: 'var(--accent)' }}>
              <b>{ready.length}</b><span>ready to reinforce</span>
            </div>
          )}
          {blocked.length > 0 && (
            <div className="row"><b>{blocked.length}</b><span className="dim">next door, on hold</span></div>
          )}
        </div>
      )}

      {selected && (
        <HoodSheet hoodId={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
