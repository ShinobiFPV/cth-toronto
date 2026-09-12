// The map is the hero (spec §7): 25 Hoods filled in their owner's colour, unclaimed
// ones neutral grey with their point value at the centroid, and a subtle pulse on your
// own Hoods once they cross the 72-hour reinforce gate.
//
// Leaflet is driven directly rather than through a React wrapper: the layers are
// created once and then restyled in place on every state change, which keeps the map
// from flickering each time somebody's claim lands over the socket.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { hoodColour } from '../lib/game.js';
import { cssVar, textSafe } from '../lib/theme.js';
import { useTheme } from '../lib/theme-context.jsx';
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
// Whether the tile pane gets the CSS filter at all. Which direction it filters in is a
// theme question answered by --map-filter in the stylesheet, so a provider that already
// ships dark tiles sets VITE_MAP_DARKEN=false and neither theme touches them.
const FILTER_TILES = (import.meta.env.VITE_MAP_DARKEN ?? 'true') !== 'false';

// The floor before a fit raises it to whatever actually frames the city.
const MIN_ZOOM = 9;

/**
 * How big a park dot is at a given zoom, and whether to draw it at all.
 *
 * There are 1,513 of them. At city zoom they have to be specks or they bury the Hood
 * numbers, and past the point where streets appear they want to be tappable. Below 10.5
 * the city is small enough that 1,513 dots read as a grey haze over it, so they are
 * dropped entirely rather than drawn as noise.
 */
const dotRadius = (zoom) => {
  if (zoom < 10.5) return 0;
  if (zoom < 12) return 1.8;
  if (zoom < 13.5) return 3;
  if (zoom < 15) return 4.5;
  return 6;
};

export default function MapScreen() {
  const { hoods, player } = useGame();
  // `appearance` as well as `resolved`: the dot colours are read out of CSS, so they
  // have to be redrawn when the accent changes and not only on a light/dark flip.
  const { resolved, appearance } = useTheme();
  const [geo, setGeo] = useState(null);
  const [geoError, setGeoError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [parks, setParks] = useState(null);
  const [showParks, setShowParks] = useState(true);

  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef(new Map());      // hood id → { polygon, label }
  // The park dots live on their own canvas renderer. The Hood polygons have to stay SVG
  // for the reinforce pulse, but 1,513 SVG circles would put 1,513 more nodes in the
  // DOM — on canvas they are one draw call and the map still scrolls.
  const parkLayerRef = useRef(null);
  const parkRendererRef = useRef(null);
  const dotsRef = useRef([]);               // { marker, collected }
  const zoomBucketRef = useRef(null);
  // Set by the layer effect so the resize handler can re-fit, and flipped the first
  // time the player zooms or drags so we stop moving the map under them.
  const fitRef = useRef(null);
  const interactedRef = useRef(false);
  const byId = useMemo(() => new Map(hoods.map((h) => [h.id, h])), [hoods]);

  // paint() reads the Hood data through a ref rather than closing over it, which keeps
  // the callback itself stable. That matters: the layer-creation effect calls paint(),
  // and if paint changed identity every time the data changed, that effect would tear
  // the whole map down and rebuild it on every claim.
  const byIdRef = useRef(byId);
  byIdRef.current = byId;

  // paint() reads the theme through a ref for the same reason it reads the data that
  // way: so the callback stays stable and the layer effect does not rebuild the map.
  const themeRef = useRef(resolved);
  themeRef.current = resolved;

  /**
   * Put the game state onto the layers: owner colour, the reinforce pulse, the blocked
   * hatch, and the centroid label. Called both when the layers are created and whenever
   * the data changes, so neither ordering can leave the map unpainted.
   */
  const paint = useCallback(() => {
    const data = byIdRef.current;
    if (!layersRef.current.size || !data.size) return;

    for (const [id, { polygon, label, pathEl }] of layersRef.current) {
      const hood = data.get(id);
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
        // A held Hood wears its owner's colour inline; everything else is themed in CSS.
        // The fill above uses the player's exact colour; the number on top of it uses a
        // text-safe version of the same hue, because several of the palette land near
        // 2.7:1 as small text on paper.
        el.innerHTML = (hood.owner
          ? `<span class="n" style="color:${textSafe(colour, themeRef.current)}">${hood.id}</span>`
          : `<span class="n ${blocked ? 'blocked' : 'free'}">${hood.id}</span>`)
          + (hood.owner ? ''
            : blocked ? `<span class="v blocked">${hood.viewer.countdown}</span>`
            : `<span class="v">+${hood.unclaimed_value}</span>`);
        el.classList.toggle('hood-ready', !!ready);
        el.title = hood.label;
      }
    }
  }, []);

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

  // All 1,513 parks, with what this player has already collected. One fetch of about
  // 70 kB; failing is not worth a message, since the dots are an extra and the Hoods
  // are the map.
  useEffect(() => {
    let cancelled = false;
    api.parksForMap()
      .then((r) => !cancelled && setParks(r))
      .catch(() => {});
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
      // Fractional zoom. Leaflet otherwise snaps to whole levels, and Toronto at zoom
      // 10 needs a hair more than 400px of width — so every phone narrower than that
      // dropped to zoom 9 and drew the city at half size with Barrie and Niagara Falls
      // for company. With no snapping, fitBounds frames the city exactly, whatever the
      // screen. zoomDelta keeps the +/- buttons stepping a sensible amount.
      zoomSnap: 0,
      zoomDelta: 0.5,
      maxZoom: 17,
      minZoom: MIN_ZOOM,
    }).setView([43.72, -79.38], 10);
    L.tileLayer(TILES, { attribution: ATTRIB, maxZoom: 19 }).addTo(map);
    mapRef.current = map;

    // Once the player zooms or pans, the view is theirs and we stop re-fitting it.
    map.on('zoomstart dragstart', () => { interactedRef.current = true; });

    // Leaflet measures its container on creation, and inside a freshly mounted grid
    // that measurement is usually wrong. Re-measuring alone is not enough: a map fitted
    // to a 200px-tall box and then grown to 700px keeps its low zoom and shows Barrie
    // to Niagara Falls with Toronto as a smudge in the middle. So a resize also re-fits,
    // until the player touches the map.
    const resize = () => {
      map.invalidateSize({ animate: false });
      if (!interactedRef.current) fitRef.current?.();
    };
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
    const bounds = shapes.getBounds();
    const fit = () => {
      map.invalidateSize({ animate: false });
      // Drop the floor before fitting, or a minZoom left over from an earlier fit
      // against a smaller container clamps this one and the city stays too small.
      map.setMinZoom(MIN_ZOOM);
      map.fitBounds(bounds, { padding: [10, 10] });
      // Toronto is the whole world here. Pin the city in place: you cannot zoom out
      // past the fitted view, and panning stops before the map is all lake. On a phone
      // the viewport is taller than the city, and Leaflet simply centres the axis that
      // does not fit, which is what we want anyway.
      map.setMinZoom(map.getZoom());
      map.setMaxBounds(bounds.pad(0.4));
    };
    fitRef.current = fit;
    fit();
    requestAnimationFrame(fit);

    // Paint immediately, in the same tick the layers are created. The effect below
    // also paints whenever the data changes, but relying on it alone leaves a hole:
    // if the boundary file resolves after the last Hood update, the layers exist and
    // nothing ever triggers a repaint, so they keep Leaflet's default blue with blank
    // labels until you refresh. Painting here as well removes the ordering question
    // entirely — layers are never left unpainted, whichever half arrives last.
    paint();

    return () => {
      group.remove();
      layersRef.current.clear();
      fitRef.current = null;
    };
  }, [geo, paint]);

  // ── repaint whenever the game state, or the theme, changes ──────────────
  useEffect(() => { paint(); }, [byId, resolved, paint]);

  // ── the park dots ───────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !parks?.parks?.length || !showParks) return undefined;

    // Its own pane, at a z-index between the Hood polygons (overlayPane, 400) and the
    // Hood numbers (markerPane, 600). Two reasons: a dot has to draw over a Hood's
    // translucent fill to be seen at all, and it has to be above the polygons to get
    // the tap — in the overlay pane the polygon underneath swallowed it and opened the
    // Hood sheet instead. Under the labels, so a dot never hides a Hood's number.
    if (!map.getPane('parks')) {
      map.createPane('parks');
      const pane = map.getPane('parks');
      pane.style.zIndex = 450;
      // And transparent to the mouse. A canvas sitting above the polygons swallows
      // every click that lands on it — the browser dispatches to the topmost element,
      // and a non-interactive Leaflet layer does not make its canvas transparent. With
      // this missing, tapping a Hood anywhere on the map did nothing at all, which is
      // the map's entire interaction gone.
      pane.style.pointerEvents = 'none';
    }
    const renderer = L.canvas({ padding: 0.3, pane: 'parks' });
    parkRendererRef.current = renderer;
    const group = L.layerGroup();
    parkLayerRef.current = group;

    const got = cssVar('--r-uncommon', '#3FD66A');
    const want = cssVar('--accent', '#FFB020');
    const radius = dotRadius(map.getZoom());
    zoomBucketRef.current = radius;
    // Hidden means off the map, not drawn at radius 0 — there is no reason to keep
    // 1,513 invisible circles in the renderer's redraw loop while panning.
    const show = (r) => {
      if (r > 0 && !map.hasLayer(group)) group.addTo(map);
      else if (r === 0 && map.hasLayer(group)) map.removeLayer(group);
    };

    const dots = parks.parks.map((p) => {
      const marker = L.circleMarker([p.la, p.ln], {
        renderer,
        radius,
        // A collected park is hollow, an uncollected one solid — the same language the
        // per-Hood park map already speaks, so the two read as one feature.
        color: p.c ? got : want,
        weight: p.c ? 1.5 : 1,
        opacity: 0.9,
        fillColor: want,
        fillOpacity: p.c ? 0 : 0.75,
        // Not clickable, on purpose. Tapping a Hood is the map's whole interaction, and
        // a canvas of 1,513 hit targets laid over the polygons takes that tap: with the
        // dots interactive, aiming at one either opened the Hood underneath or did
        // nothing at all, depending on which pane won. The dots are here to show you
        // where the parks are; tapping the Hood and then Collect parks is still how you
        // get to one.
        interactive: false,
      }).addTo(group);
      return { marker, collected: !!p.c };
    });
    dotsRef.current = dots;
    show(radius);

    // Restyle only when the size band actually changes — 1,513 setStyle calls on every
    // fractional zoom step would make panning feel like treacle.
    const onZoom = () => {
      const r = dotRadius(map.getZoom());
      if (r === zoomBucketRef.current) return;
      zoomBucketRef.current = r;
      if (r > 0) {
        for (const { marker, collected } of dots) {
          marker.setStyle({ radius: r, opacity: 0.9, fillOpacity: collected ? 0 : 0.75 });
        }
      }
      show(r);
    };
    map.on('zoomend', onZoom);

    return () => {
      map.off('zoomend', onZoom);
      group.remove();
      parkLayerRef.current = null;
      parkRendererRef.current = null;
      dotsRef.current = [];
      zoomBucketRef.current = null;
    };
    // resolved and the accent are in here because the dot colours are read out of CSS.
  }, [parks, showParks, resolved, appearance.accent]);

  const mine = hoods.filter((h) => h.owner?.id === player?.id);
  const richest = hoods.filter((h) => !h.owner)
    .sort((a, b) => b.unclaimed_value - a.unclaimed_value)[0];
  const ready = mine.filter((h) => h.viewer?.reinforce_ready);
  const unclaimed = hoods.filter((h) => !h.owner);
  const blocked = hoods.filter((h) => h.viewer?.adjacent_blocked);

  return (
    <div className="map-wrap">
      <div className={`map ${FILTER_TILES ? 'map-osm' : ''}`} ref={mapEl}
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
            <div className="row" style={{ color: 'var(--accent-text)' }}>
              <b>{ready.length}</b><span>ready to reinforce</span>
            </div>
          )}
          {blocked.length > 0 && (
            <div className="row"><b>{blocked.length}</b><span className="dim">next door, on hold</span></div>
          )}
          {richest && (
            <div className="row" title={`Difficulty ${richest.difficulty} of 50`}>
              <b>+{richest.unclaimed_value}</b>
              <span className="dim truncate">best unclaimed · {richest.id}</span>
            </div>
          )}
          {parks && (
            <button className={`row map-parks-toggle ${showParks ? 'on' : ''}`}
                    aria-pressed={showParks}
                    onClick={() => setShowParks((v) => !v)}
                    title={showParks ? 'Hide the park dots' : 'Show the park dots'}>
              <b>{parks.collected}</b>
              <span className="dim truncate">
                of {parks.total} parks{showParks ? '' : ' · hidden'}
              </span>
            </button>
          )}
          <div className="map-hint">Refresh the page if the map is not showing info</div>
        </div>
      )}

      {selected && (
        <HoodSheet hoodId={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
