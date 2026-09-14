// What a Scavenger Blitz can ask for.
//
// Park hunts are the easy mode: things a four-year-old can find without reading a sign or
// crossing a road. Every item carries the seasons it is worth photographing in — a splash
// pad in January and an ice rink in July are both *there*, and both make a miserable hunt
// item — and the generator filters on the season the hunt starts in.
//
// Wildlife is kept general on purpose: a dog, a bird, a bug, a squirrel. Never a species —
// "a robin" fails on a January afternoon, and a five-year-old does not deserve that.

export const HUNT_SEASONS = ['spring', 'summer', 'fall', 'winter'];
const ALL = HUNT_SEASONS;
const WARM = ['spring', 'summer', 'fall'];

/**
 * Park-specific items, keyed by the amenity slug the city's records produce
 * (lib/amenities.js). The first block is every amenity the dataset actually carries.
 * Washroom is deliberately missing: not something to send a child off to photograph.
 */
export const AMENITY_ITEMS = {
  playground: { label: 'The playground', seasons: ALL },
  ball_diamond: { label: 'The baseball diamond', seasons: ALL },
  sports_field: { label: 'The sports field', seasons: WARM },
  tennis_court: { label: 'A tennis court', seasons: WARM },
  basketball_court: { label: 'A basketball net', seasons: ALL },
  pickleball_court: { label: 'A pickleball court', seasons: WARM },
  outdoor_fitness_equipment: { label: 'The outdoor exercise equipment', seasons: ALL },
  outdoor_ping_pong_table_tennis: { label: 'A ping-pong table', seasons: WARM },
  picnic_site: { label: 'A picnic table', seasons: WARM },
  dog_off_leash_area: { label: 'The dog off-leash area', seasons: ALL },
  outdoor_dry_pad: { label: 'The outdoor rink pad', seasons: ALL },
  firepit: { label: 'The fire pit', seasons: ALL },
  skateboarding: { label: 'The skate park', seasons: WARM },
  cricket_pitch_field: { label: 'The cricket pitch', seasons: WARM },
  beach: { label: 'The beach', seasons: ALL },
  outdoor_track: { label: 'The running track', seasons: WARM },
  disc_golf: { label: 'A disc golf basket', seasons: ALL },

  // Named in the spec but not in the city's park records today. Kept, season-tagged, so a
  // richer source lights them up without a code change.
  splash_pad: { label: 'The splash pad', seasons: ['summer'] },
  wading_pool: { label: 'The wading pool', seasons: ['summer'] },
  ice_rink: { label: 'The ice rink', seasons: ['winter'] },
};

/** Safe in any green space. */
export const UNIVERSAL_ITEMS = [
  { key: 'bench', label: 'A bench', seasons: ALL },
  { key: 'garbage_bin', label: 'A garbage bin', seasons: ALL },
  { key: 'water_fountain', label: 'A water fountain', seasons: WARM },
  { key: 'fence', label: 'A fence', seasons: ALL },
  { key: 'gate', label: 'A gate', seasons: ALL },
  { key: 'path', label: 'A path', seasons: ALL },
  { key: 'big_tree', label: 'A big tree', seasons: ALL },
  { key: 'lamp_post', label: 'A lamp post', seasons: ALL },
  { key: 'leaf', label: 'A leaf', seasons: WARM },
  { key: 'flower', label: 'A flower', seasons: ['spring', 'summer'] },
  { key: 'pine_cone', label: 'A pine cone', seasons: ['fall', 'winter'] },
  { key: 'snow', label: 'Some snow', seasons: ['winter'] },
];

export const WILDLIFE_ITEMS = [
  { key: 'dog', label: 'A dog', seasons: ALL },
  { key: 'bird', label: 'A bird', seasons: ALL },
  { key: 'squirrel', label: 'A squirrel', seasons: ALL },
  { key: 'bug', label: 'A bug', seasons: WARM },
];

/** A park hunt never asks for more than this many animals, in case nothing is moving. */
export const MAX_WILDLIFE = 2;

/**
 * Street hunts are passenger vehicles: cars, SUVs, crossovers and pickups. Motorcycles,
 * buses, streetcars, trains, work vehicles and delivery bikes are out, and an entry whose
 * body style is not one of these is ignored.
 */
export const PASSENGER_BODY_STYLES = [
  'sedan', 'hatchback', 'coupe', 'convertible', 'wagon', 'suv', 'crossover', 'pickup', 'minivan',
];
