// What counts as "the same car" — the Garage's dedupe key.
//
// Identification exists for two things: the face of the package, and this key. It never
// touches scoring, so accuracy barely matters for fairness and consistency matters
// enormously. The key is make + model with trim and generation stripped, so `honda|civic`
// is one package whether it was an Si or a base sedan.
//
// This is the easiest thing in the module to get wrong by being too specific. Too fine
// and the Case fills with near-identical Civics; too coarse and every Toyota is one
// package. The prompt already asks for the base model name without trim — everything
// here is the second line of defence, for the day the model says "Civic Si" anyway.
import { GameError } from './errors.js';

/** Spellings of the same maker. Keys and values are already squashed. */
const MAKE_ALIASES = {
  mercedes: 'mercedesbenz',
  benz: 'mercedesbenz',
  vw: 'volkswagen',
  chevy: 'chevrolet',
  landrover: 'landrover',
  rangerover: 'landrover',
  alfa: 'alfaromeo',
  mini: 'mini',
  bmwm: 'bmw',
  mercedesamg: 'mercedesbenz',
};

/**
 * Words that describe a version of a car rather than the car. Stripped only from the
 * END of the model name and never down to nothing, so "Sport Trac" and "Grand Cherokee"
 * survive while "Civic Sport" does not.
 *
 * Single letters (S, R, X) are deliberately absent: "Model S" is a model, not a Model
 * with an S trim. They are only stripped when the identifier also reported them as trim.
 */
const TRIM_WORDS = new Set([
  'base', 'sport', 'sports', 'limited', 'touring', 'premium', 'platinum', 'luxury',
  'ex', 'exl', 'lx', 'dx', 'si', 'se', 'sel', 'le', 'xle', 'xse', 'sr', 'sr5', 'trd',
  'gt', 'gts', 'gti', 'rs', 'st', 'ss', 'lt', 'ltz', 'ls', 'sv', 'sl', 'slt', 'xlt',
  'lariat', 'denali', 'hybrid', 'phev', 'plugin', 'awd', '4wd', '4x4', 'fwd', 'rwd',
  'xdrive', 'quattro', '4matic', 'turbo', 'diesel', 'tdi', 'sedan', 'coupe', 'hatchback',
  'hatch', 'wagon', 'estate', 'convertible', 'cabriolet', 'cabrio', 'roadster', 'spyder',
  'suv', 'crossover', 'van', 'minivan', 'pickup', 'truck', 'crewcab', 'supercrew',
]);

/** Lowercase, accents off, everything but letters and digits removed. */
export const squash = (s) => String(s ?? '')
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '');

const tokens = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean);

const YEARISH = /^(19|20)\d{2}(-\d{2,4})?$/;

/**
 * The model name with anything that is not the model taken off. Returns display-cased
 * text; `squash()` of the result is what goes in the key.
 */
export function baseModel(make, model, { trim = null, generation = null } = {}) {
  let words = tokens(String(model ?? '').replace(/\(.*?\)/g, ' '));

  // "Honda Civic" → "Civic". Some identifiers repeat the make.
  const makeWords = tokens(make).map(squash);
  while (words.length > 1 && makeWords.includes(squash(words[0]))) words = words.slice(1);

  const reported = new Set([...tokens(trim), ...tokens(generation)].map(squash).filter(Boolean));

  const strippable = (w) => {
    const s = squash(w);
    return !s || YEARISH.test(w) || TRIM_WORDS.has(s) || reported.has(s);
  };
  // Leading years ("2019 Civic") and trailing trim, never the last word standing.
  while (words.length > 1 && YEARISH.test(words[0])) words = words.slice(1);
  while (words.length > 1 && strippable(words[words.length - 1])) words = words.slice(0, -1);

  return words.join(' ');
}

export const makeKey = (make) => {
  const s = squash(make);
  return MAKE_ALIASES[s] ?? s;
};

/** 'honda|civic'. The one place a vehicle key is made. */
export function vehicleKey(make, model, detail = {}) {
  return `${makeKey(make)}|${squash(baseModel(make, model, detail))}`;
}

/** "a Honda Civic", "an Audi A4". */
export const withArticle = (name) => `${/^[aeiou]/i.test(String(name ?? '')) ? 'an' : 'a'} ${name}`;

const text = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && !/^(unknown|n\/a|none|null)$/i.test(s) ? s.slice(0, 80) : null;
};

const unit = (n) => Math.min(1, Math.max(0, Number(n) || 0));

/**
 * Turn what the identifier said into something the game can collect, or say why not.
 * Pure: no database, no network. The route runs it on the model's output before
 * evaluateCar() ever sees a car.
 */
export function resolveIdentification(raw, { minConfidence = 0.5 } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new GameError('IDENTIFY_UNSURE',
      'Could not make out a car in that. Try again with the whole car in frame.', {}, 422);
  }
  if (raw.is_vehicle === false) {
    throw new GameError('NOT_A_VEHICLE',
      'That does not look like a vehicle. The Garage only takes cars, trucks and bikes with engines.',
      {}, 422);
  }

  const make = text(raw.make);
  const modelRaw = text(raw.model);
  const confidence = unit(raw.confidence);
  const trim = text(raw.trim);
  const generation = text(raw.generation);
  const model = modelRaw ? baseModel(make, modelRaw, { trim, generation }) : null;

  if (!make || !model || confidence < minConfidence) {
    throw new GameError('IDENTIFY_UNSURE',
      make && model
        ? `It might be a ${make} ${model}, but it is not sure enough to print a card.`
          + 'A side-on or three-quarter shot of the whole car usually does it.'
        : 'It could not tell what that is. A side-on or three-quarter shot of the whole car '
          + 'usually does it.',
      { guess: make && model ? `${make} ${model}` : null }, 422);
  }

  const plates = Array.isArray(raw.plates) ? raw.plates
    .map((p) => ({ x: unit(p?.x), y: unit(p?.y), width: unit(p?.width), height: unit(p?.height) }))
    .filter((p) => p.width > 0 && p.height > 0)
    .slice(0, 8) : [];

  return {
    vehicle_key: vehicleKey(make, model, { trim, generation }),
    make,
    model,
    trim,
    generation,
    year_range: text(raw.year_range),
    body_style: text(raw.body_style),
    confidence,
    // Photographs of screens, magazines, diecast and game footage. Low plausibility
    // marks the package for flaggers; it never rejects it — the group decides.
    in_situ: raw.in_situ !== false,
    plates,
    raw,
  };
}
