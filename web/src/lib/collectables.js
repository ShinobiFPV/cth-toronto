// Every kind of card the game prints, as the client sees it.
//
// The server's registry (server/lib/collectables.js) decides what a card is; this one
// decides how each kind looks: the face it prints, its icon, the one-line description
// lists use, and the few lines of detail the binder shows for it. The binder, the card
// lightbox, the feed and trading read from here and never branch on a kind themselves —
// so a new kind of card is a new entry here, and those screens do not change.
import ParkCard from '../components/ParkCard.jsx';
import NotWheelsCard from '../components/NotWheelsCard.jsx';
import CarCollect from '../components/CarCollect.jsx';
import { CardIcon, CarIcon } from '../components/icons.jsx';

const RARITY_ORDER = ['legendary', 'rare', 'uncommon', 'common'];
const pad = (n) => String(n ?? '').padStart(4, '0');

export const COLLECTABLES = {
  park: {
    kind: 'park',
    label: 'Parks',
    noun: 'park card',
    Face: ParkCard,
    Icon: CardIcon,
    collectedBy: 'Collected by',
    subtitle: (c) => `${c.rarity_label} · ${c.season?.name ?? ''} · #${pad(c.park?.set_number ?? c.park?.id)}`,
    // The short tag a list puts beside the name: what the park is worth.
    tag: (c) => ({ className: `chip r-${c.rarity}`, text: `+${c.points}` }),
    summaryRows: (k) => [
      { label: 'Parks collected this season', value: k.season_collected, extra: `/ ${k.parks_total}` },
      { label: 'Points from parks this season', value: k.season_points },
      { label: 'Different parks, all time', value: k.distinct_parks_all_time },
    ],
    summaryChips: (k) => RARITY_ORDER.filter((r) => k.by_rarity?.[r])
      .map((r) => ({ key: r, className: `chip r-${r}`, text: `${k.by_rarity[r]} ${r}` })),
    note: null,
    // Parks are collected from a Hood's sheet on the map, not from the binder.
    Collect: null,
    emptyHint: 'open a Hood on the map and tap Collect parks',
  },

  car: {
    kind: 'car',
    label: 'Cars',
    noun: 'car card',
    Face: NotWheelsCard,
    Icon: CarIcon,
    collectedBy: 'Snapped by',
    subtitle: (c) => `${c.edition_label} · ${c.season?.name ?? ''}${c.vehicle?.year ? ` · ${c.vehicle.year}` : ''}`,
    // A car card's worth is its print.
    tag: (c) => ({ className: `chip ed-${c.edition}`, text: c.edition }),
    summaryRows: (k, { isMine }) => [
      ...(isMine && k.capacity ? [{
        label: 'Car points this week',
        value: k.capacity.xp_only ? 'XP only' : k.capacity.spent,
        extra: k.capacity.xp_only ? `resets ${k.capacity.resets_on}` : `/ ${k.capacity.cap}`,
      }] : []),
      { label: 'Cars snapped this season', value: k.season_collected },
      { label: 'Points from cars this season', value: k.season_points },
      { label: 'Different cars, all time', value: k.distinct_vehicles_all_time, extra: `/ ${k.catalogue_size} so far` },
    ],
    summaryChips: () => [],
    note: (c) => `Snapped in ${c.hood?.label ?? 'a Hood'}`
      + (c.confidence != null ? ` · identified ${Math.round(c.confidence * 100)}% sure` : '')
      + (c.suspect ? '. The identifier was not sure this is a real car on the street — flag it if you agree.' : ''),
    Collect: CarCollect,
    collectLabel: 'Snap a car',
    emptyHint: 'snap a car',
  },
};

/** The order kinds are listed in — the binder's filter, the summary. */
export const KIND_ORDER = Object.keys(COLLECTABLES);

/** A kind's entry. An unknown kind falls back to a park card rather than rendering nothing. */
export const collectable = (kind) => COLLECTABLES[kind] ?? COLLECTABLES.park;
