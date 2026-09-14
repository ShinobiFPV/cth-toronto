// Parks, scoped to one Hood. Reached from the Hood sheet on the main map.
//
// Two ways to look at the same ~60 parks: pins on a map for when you are out walking,
// and a list sorted by value for when you are planning a route. The list is the default
// on purpose — you open this to decide where to go.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import L from 'leaflet';
import { api } from '../lib/api.js';
import { useGame } from '../lib/store.jsx';
import { cssVar } from '../lib/theme.js';
import { useTheme } from '../lib/theme-context.jsx';
import { BackIcon, CameraIcon, CloseIcon } from '../components/icons.jsx';
import { Banner, Spinner } from '../components/bits.jsx';
import ParkCard from '../components/ParkCard.jsx';
import ParkCollect from '../components/ParkCollect.jsx';
import { itemList, withheldText } from '../lib/items.js';
import { playCollection } from '../lib/audio.js';

const TILES = import.meta.env.VITE_MAP_TILES
  || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const FILTER_TILES = (import.meta.env.VITE_MAP_DARKEN ?? 'true') !== 'false';

/**
 * Leaflet's circleMarker wants a real colour string, not a var(), so the rarity palette
 * is read back out of CSS at render time. That means it follows both the theme and
 * whichever accent the player chose — legendary is always the accent.
 */
const rarityColours = () => ({
  common: cssVar('--r-common', '#9AA4B0'),
  uncommon: cssVar('--r-uncommon', '#3FD66A'),
  rare: cssVar('--r-rare', '#35C4FF'),
  legendary: cssVar('--accent', '#FFB020'),
});

export default function Parkemans() {
  const { id } = useParams();
  // ?park=<id> opens straight onto that park's sheet rather than the Hood's list, so a
  // link to one particular park is possible from anywhere.
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { refreshMe, itemsChanged } = useGame();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  // Seeded from ?park= on the first render. Read once: closing the sheet should not
  // reopen it.
  const [selected, setSelected] = useState(() => {
    const want = Number(search.get('park'));
    return Number.isInteger(want) && want > 0 ? want : null;
  });
  const [sort, setSort] = useState('value');
  // Declared up here with the rest: there are early returns below, and a useState
  // after one of those is a rules-of-hooks violation that React will throw on.
  const [justGot, setJustGot] = useState(null);

  const load = useCallback(async () => {
    const res = await api.parksInHood(id);
    setData(res);
    setLoading(false);
  }, [id]);

  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);

  const parks = useMemo(() => {
    const list = [...(data?.parks ?? [])];
    if (sort === 'value') list.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    else if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else list.sort((a, b) => Number(a.collected) - Number(b.collected) || b.value - a.value);
    return list;
  }, [data, sort]);

  if (loading) return <div className="empty"><Spinner /></div>;
  if (!data) return <div className="empty">No parks here.</div>;

  const { progress, hood } = data;
  const pct = progress.total ? Math.round((progress.collected / progress.total) * 100) : 0;

  const collected = async (card, meta) => {
    playCollection('collect_park', { edition: card.edition, items: meta?.items });
    setSelected(null);
    await Promise.all([load().catch(() => {}), refreshMe().catch(() => {})]);
    if (meta?.items?.items?.length) itemsChanged();
    setJustGot({ ...card, xp: meta?.xp, level_up: meta?.level_up, items: meta?.items });
  };

  return (
    <div className={view === 'map' ? '' : 'screen-pad'}>
      {view === 'list' && (
        <>
          <div className="cluster" style={{ marginBottom: '0.6rem' }}>
            <button className="btn btn-sm btn-ghost" onClick={() => navigate(-1)}>
              <BackIcon style={{ width: 14, height: 14 }} /> Back
            </button>
          </div>

          <h1>Parks</h1>
          <p className="tiny dim" style={{ margin: '0.3rem 0 0.8rem' }}>
            {hood.label} · photograph the sign, keep the card. Each park once a season.
          </p>

          <div className="sheet" style={{ marginBottom: '0.9rem' }}>
            <div className="sheet-body">
              <div className="cluster" style={{ justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                <b className="num">{progress.collected} / {progress.total}</b>
                <span className="tiny dim">{progress.points} points from this Hood</span>
              </div>
              <div className="progress-bar"><i style={{ width: `${pct}%` }} /></div>
              {/* The per-Hood park points cap, before anybody walks to a park that pays nothing. */}
              {progress.capacity?.cap != null && (
                <div className="tiny dim" style={{ marginTop: '0.45rem' }}>
                  {progress.capacity.remaining === 0
                    ? <><b>XP only in this Hood</b> until {progress.capacity.period === 'season' ? 'next season' : progress.capacity.resets_on} — cards and XP still count; go to another Hood for points.</>
                    : <>{progress.capacity.remaining} of {progress.capacity.cap} park points left here {progress.capacity.period === 'season' ? 'this season' : 'this week'}.</>}
                </div>
              )}
            </div>
          </div>

          <div className="toggle" role="group" aria-label="View">
            <button aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
            <button aria-pressed={view === 'map'} onClick={() => setView('map')}>Map</button>
          </div>

          <div className="cluster" style={{ marginBottom: '0.5rem' }}>
            <span className="tiny dim">Sort</span>
            {[['value', 'Value'], ['todo', 'Still to get'], ['name', 'A–Z']].map(([k, label]) => (
              <button key={k} className={`btn btn-sm ${sort === k ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => setSort(k)}>{label}</button>
            ))}
          </div>

          <div className="sheet">
            {parks.map((p) => (
              <button key={p.id} className={`park-row ${p.collected ? 'got' : ''}`}
                      onClick={() => setSelected(p.id)}>
                <span className={`dot park-pin r-${p.rarity}`}
                      style={{ background: 'currentColor', width: 12, height: 12 }} />
                <span className="grow">
                  <span className="truncate" style={{ display: 'block' }}>{p.name}</span>
                  <span className="tiny dim">
                    {p.collected ? 'in your binder' : `${p.rarity_label} · ${p.distance_km} km out`}
                  </span>
                </span>
                <span className={`park-value r-${p.rarity}`}>{p.collected ? '✓' : `+${p.value}`}</span>
              </button>
            ))}
          </div>

          <div className="footer-note">
            Park locations from the City of Toronto <code>parks-and-recreation-facilities</code>
            {' '}dataset, Open Government Licence – Toronto. {progress.total} parks in this Hood.
          </div>
        </>
      )}

      {view === 'map' && (
        <ParkMap parks={parks} hood={hood} onPick={setSelected} onClose={() => setView('list')} />
      )}

      {selected && (
        <ParkSheet parkId={selected} onClose={() => setSelected(null)} onCollected={collected} />
      )}

      {justGot && (
        <>
          <div className="scrim" onClick={() => setJustGot(null)} />
          <div className="bottom-sheet" role="dialog" aria-modal="true" aria-label="New card">
            <div className="sheet-head">
              <div className="grow">
                <h1>{justGot.rarity_label} · {justGot.points > 0 ? `+${justGot.points}` : 'XP only'}</h1>
                <div className="tiny dim">
                  {justGot.park.name} is yours for {justGot.season?.name}
                  {justGot.xp && ` · +${justGot.xp.xp} XP`}
                  {justGot.xp?.discovery > 0 && ' (first time here)'}
                </div>
                {justGot.items?.items?.length > 0 && (
                  <div className="tiny" style={{ color: 'var(--accent-text)' }}>
                    It came with: {itemList(justGot.items.items)}
                  </div>
                )}
                {withheldText(justGot.items) && (
                  <div className="tiny dim">{withheldText(justGot.items)}</div>
                )}
                {justGot.level_up && (
                  <div className="tiny" style={{ color: 'var(--accent-text)' }}>
                    Level {justGot.level_up.to} — {justGot.level_up.title}
                  </div>
                )}
              </div>
              <button className="btn btn-sm btn-ghost" onClick={() => setJustGot(null)} aria-label="Close">
                <CloseIcon style={{ width: 16, height: 16 }} />
              </button>
            </div>
            <div className="sheet-body" style={{ display: 'grid', placeItems: 'center' }}>
              <ParkCard card={justGot} />
              <button className="btn btn-primary btn-block" style={{ marginTop: '1rem' }}
                      onClick={() => setJustGot(null)}>
                Nice
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Pins for every park in the Hood, coloured by rarity, hollow once collected. */
function ParkMap({ parks, hood, onPick, onClose }) {
  const el = useRef(null);
  const mapRef = useRef(null);
  // Re-read the palette and redraw the pins when the appearance changes.
  const { resolved, appearance } = useTheme();

  useEffect(() => {
    if (!el.current || mapRef.current) return undefined;
    const map = L.map(el.current, { zoomControl: true, preferCanvas: true }).setView([43.7, -79.4], 12);
    L.tileLayer(TILES, { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    mapRef.current = map;
    const resize = () => map.invalidateSize({ animate: false });
    requestAnimationFrame(resize);
    const obs = new ResizeObserver(resize);
    obs.observe(el.current);
    return () => { obs.disconnect(); map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !parks.length) return undefined;
    const group = L.featureGroup().addTo(map);
    const colours = rarityColours();
    for (const p of parks) {
      L.circleMarker([p.lat, p.lng], {
        radius: p.collected ? 5 : 7,
        color: colours[p.rarity],
        weight: 2,
        fillColor: p.collected ? 'transparent' : colours[p.rarity],
        fillOpacity: p.collected ? 0 : 0.75,
      })
        .bindTooltip(`${p.name} · ${p.collected ? 'collected' : `+${p.value}`}`, { direction: 'top' })
        .on('click', () => onPick(p.id))
        .addTo(group);
    }
    map.invalidateSize({ animate: false });
    map.fitBounds(group.getBounds(), { padding: [24, 24] });
    return () => group.remove();
  }, [parks, onPick, resolved, appearance.accent]);

  return (
    <div className="map-wrap map-wrap-inline">
      <div className={`map ${FILTER_TILES ? 'map-osm' : ''}`} ref={el}
           role="application" aria-label={`Parks in ${hood.label}`} />
      <div className="map-legend">
        <div className="row"><b>{parks.filter((p) => !p.collected).length}</b><span className="dim">still to get</span></div>
        <div className="row tiny dim">hollow pin = collected</div>
      </div>
      <div className="map-fab">
        <button className="btn btn-primary" onClick={onClose}>List</button>
      </div>
    </div>
  );
}

/** One park: what it is worth, and either the collect button or the card you already have. */
function ParkSheet({ parkId, onClose, onCollected }) {
  const [data, setData] = useState(null);
  const [collecting, setCollecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.park(parkId).then((r) => !cancelled && setData(r)).catch(() => {});
    return () => { cancelled = true; };
  }, [parkId]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !collecting && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, collecting]);

  if (!data) return null;
  const { park, viewer } = data;

  return (
    <>
      <div className="scrim" onClick={() => !collecting && onClose()} />
      <div className="bottom-sheet" role="dialog" aria-modal="true" aria-label={park.name}>
        {collecting ? (
          <ParkCollect park={park} viewer={viewer} onClose={() => setCollecting(false)} onDone={onCollected} />
        ) : (
          <>
            <div className="sheet-head">
              <div className="grow">
                <h1>{park.name}</h1>
                <div className="tiny dim">
                  {park.hood_label} · {park.distance_km} km from downtown
                </div>
              </div>
              <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">
                <CloseIcon style={{ width: 16, height: 16 }} />
              </button>
            </div>

            <div className="sheet-body stack">
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <span className={`chip r-${park.rarity}`}>{park.rarity_label}</span>
                <b className="num">+{park.value}</b>
              </div>

              {park.address && <div className="tiny dim">{park.address}</div>}
              {park.amenities.length > 0 && (
                <div className="cluster">
                  {park.amenities.slice(0, 6).map((a) => (
                    <span key={a} className="chip tiny">{a}</span>
                  ))}
                </div>
              )}

              {park.collected && park.collection ? (
                <>
                  <Banner kind="ok">Already in your binder this season.</Banner>
                  <div style={{ display: 'grid', placeItems: 'center' }}>
                    <ParkCard card={{
                      claim_id: park.collection.claim_id,
                      park: { id: park.id, name: park.name, value: park.value, hood_label: park.hood_label, address: park.address },
                      points: park.collection.points,
                      rarity: park.rarity,
                      rarity_label: park.rarity_label,
                      card_seed: park.collection.card_seed,
                      season: viewer.season ?? null,
                      collected_at: park.collection.created_at,
                      display_url: park.collection.display_url,
                      thumb_url: park.collection.thumb_url,
                      caption: park.collection.caption,
                    }} />
                  </div>
                </>
              ) : (
                <>
                  {!viewer.ok && <Banner kind="info">{viewer.message}</Banner>}
                  {viewer.ok && viewer.capacity?.xp_only && (
                    <Banner kind="info">
                      XP only in this Hood for now — the card and the XP, no points. Points
                      here come back {viewer.capacity.period === 'season' ? 'next season' : viewer.capacity.resets_on}.
                    </Banner>
                  )}
                  <div className="tiny dim">
                    Honour system: a photo of this park's sign, taken by you, recently.
                    Nobody checks. Everybody can flag.
                  </div>
                  <button className="btn btn-primary btn-block" disabled={!viewer.ok}
                          onClick={() => setCollecting(true)}>
                    <CameraIcon style={{ width: 18, height: 18 }} />
                    {' '}Collect ({viewer.capacity?.xp_only ? 'XP only' : `+${viewer.points ?? park.value}`})
                  </button>
                </>
              )}

              {park.url && (
                <a className="btn btn-sm btn-ghost" href={park.url} target="_blank" rel="noreferrer">
                  City park page
                </a>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
