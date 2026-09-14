// Calendar weeks in Toronto, for every weekly cap: the Garage's points, the per-Hood park
// points (when counted by week), and items.
//
// The week is a stored string rather than a rolling window: a week key is computed once
// at claim time and written onto the row, so the cap check is an exact match and a SUM
// — the same trick the rest of the codebase plays with sortable ISO timestamps.
//
// Everything here goes through a real timezone conversion. Adding a fixed offset would
// put two different weeks either side of the March and November DST changes, and the
// first person to notice would be whoever was snapping cars at 11:30 on a Sunday night.
import { config } from '../config.js';

const DAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86_400_000;

const startIndex = (start) => DAY_INDEX[String(start).toUpperCase()] ?? DAY_INDEX.MO;

const formatters = new Map();
const partsIn = (tz) => {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(tz);
};

/** The wall-clock fields of an instant in `tz`. */
function wallClock(ms, tz) {
  const out = {};
  for (const p of partsIn(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** The calendar date an instant falls on in `tz`, as a UTC-midnight day number. */
const localDay = (ms, tz) => {
  const w = wallClock(ms, tz);
  return Date.UTC(w.year, w.month - 1, w.day);
};

/** The UTC instant of local midnight on a calendar day in `tz`, DST included. */
export function zonedMidnight(dayUtcMs, tz) {
  // Guess that local midnight is UTC midnight, measure how far off that is, correct,
  // and measure again — the second pass is what gets the transition days right.
  let guess = dayUtcMs;
  for (let i = 0; i < 2; i += 1) {
    const w = wallClock(guess, tz);
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    guess -= asUtc - dayUtcMs;
  }
  return guess;
}

/** The first local day of the week containing `iso`. */
function weekStartDay(iso, { tz, start }) {
  const day = localDay(Date.parse(iso), tz);
  const dow = new Date(day).getUTCDay();
  return day - ((dow - startIndex(start) + 7) % 7) * DAY_MS;
}

/**
 * '2026-W38'. ISO-8601 numbering, with the configured start day standing in for Monday:
 * the week's first day is shifted onto a Monday before numbering, so a Sunday-start
 * week is still seven days and still numbered like the ISO week it mostly overlaps.
 */
export function weekKey(iso, { tz = config.timezone, start = config.WEEK_START } = {}) {
  const monday = new Date(weekStartDay(iso, { tz, start })
    + ((DAY_INDEX.MO - startIndex(start) + 7) % 7) * DAY_MS);
  // The ISO year is the year of that week's Thursday.
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY_MS / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** When the week containing `iso` ends and capacity comes back, as a UTC instant. */
export function weekResetsAt(iso, { tz = config.timezone, start = config.WEEK_START } = {}) {
  return new Date(zonedMidnight(weekStartDay(iso, { tz, start }) + 7 * DAY_MS, tz)).toISOString();
}

/** "Monday", for "resets Monday". */
export const weekStartName = (start = config.WEEK_START) => DAY_NAME[startIndex(start)];
