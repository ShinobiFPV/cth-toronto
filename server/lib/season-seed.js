// The four seasons (spec §1.5). Stored in the `seasons` table on first run, never
// hardcoded into game logic — change a row here (or in the DB) and the rollover
// script follows it.
//
// Boundaries are Toronto local midnight expressed as UTC instants. Each season's
// `ends_at` is exclusive and equals the next season's `starts_at`, so the four are
// contiguous with no gap or overlap. The UTC offsets differ (EDT = -04:00,
// EST = -05:00) because meteorological season boundaries straddle DST.
export const SEASON_SEED = [
  { id: 1, name: 'Fall 2026',        starts_at: '2026-09-01T04:00:00.000Z', ends_at: '2026-12-01T05:00:00.000Z' },
  { id: 2, name: 'Winter 2026–27',   starts_at: '2026-12-01T05:00:00.000Z', ends_at: '2027-03-01T05:00:00.000Z' },
  { id: 3, name: 'Spring 2027',      starts_at: '2027-03-01T05:00:00.000Z', ends_at: '2027-06-01T04:00:00.000Z' },
  { id: 4, name: 'Summer 2027',      starts_at: '2027-06-01T04:00:00.000Z', ends_at: '2027-09-01T04:00:00.000Z' },
];
