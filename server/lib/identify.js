// Asking Claude what car is in a photo.
//
// One vision call per collection, made in the route handler after the sharp pipeline and
// before commitCar() — never inside the transaction, because it takes seconds and a
// transaction that waits on the network holds the whole database while it does.
//
//   upload → sharp → identify (2–5s) → evaluateCar() → commitCar()
//
// The identifier is swappable with setIdentifier(), the same way rollEdition() takes a
// `rand`, so no test ever touches the network.
import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { GameError } from './errors.js';

const SYSTEM = `You identify road vehicles in photos for a street car-spotting game.

Report the vehicle's make and its base model name only. The model name is what is used to
decide whether two photos show "the same car", so it must not contain trim, generation,
engine, drivetrain, body style or year: "Civic", not "Civic Si"; "911", not "911 Carrera S";
"F-150", not "F-150 Lariat SuperCrew"; "3 Series", not "330i". Put those details in their own
fields instead. When a car is a distinct model rather than a trim (a Mustang Mach-E is not a
Mustang), report it as its own model.

If several vehicles are visible, describe the most prominent one.

in_situ is false when the photo is of a screen, a printed page, a poster, a toy or diecast
model, or video game footage rather than a real vehicle in the physical world.

plates lists every visible licence plate as a box in fractions of the image (x and y are the
top-left corner, 0 to 1). Include partially visible plates. Return an empty list if none.

confidence is your probability, 0 to 1, that make and model are both right. Say so honestly;
a low number is useful.

target_match: the request sometimes names a vehicle the player is hunting for. Set it true if
the photo shows that make and model — be generous about trim and exact model year, since years
within a generation cannot be seen — false if it is clearly a different vehicle, and null if you
cannot tell. When no vehicle is named, set it to null.`;

/** Structured output schema. Nullable fields are nullable rather than optional. */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_vehicle', 'in_situ', 'make', 'model', 'generation', 'trim', 'year_range',
    'body_style', 'confidence', 'plates', 'target_match'],
  properties: {
    is_vehicle: { type: 'boolean' },
    // A Street Blitz rides on this same call: one call answers both "what car is this"
    // and "is it the one being hunted". Null when no target was named.
    target_match: { type: ['boolean', 'null'] },
    in_situ: { type: 'boolean' },
    make: { type: ['string', 'null'] },
    model: { type: ['string', 'null'] },
    generation: { type: ['string', 'null'] },
    trim: { type: ['string', 'null'] },
    year_range: { type: ['string', 'null'] },
    body_style: { type: ['string', 'null'] },
    confidence: { type: 'number' },
    plates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y', 'width', 'height'],
        properties: {
          x: { type: 'number' }, y: { type: 'number' },
          width: { type: 'number' }, height: { type: 'number' },
        },
      },
    },
  },
};

const unavailable = (why) => new GameError('IDENTIFY_UNAVAILABLE',
  'The car identifier is not answering right now. Nothing was collected — try again in a minute.',
  why ? { detail: why } : {}, 503);

let client = null;
const anthropic = () => {
  client ??= new Anthropic({
    apiKey: config.IDENTIFY_API_KEY,
    timeout: config.IDENTIFY_TIMEOUT_MS,
    maxRetries: 1,
  });
  return client;
};

/**
 * The real identifier: an image buffer in, the model's JSON out. Throws
 * IDENTIFY_UNAVAILABLE for anything that is the service's fault rather than the photo's.
 */
export async function claudeIdentifier(image, mediaType, { target = null } = {}) {
  if (!config.IDENTIFY_ENABLED || !config.IDENTIFY_API_KEY) {
    throw unavailable(config.IDENTIFY_ENABLED ? 'no API key configured' : 'disabled');
  }

  let response;
  try {
    // Opus 5 thinks by default; low effort is plenty for "what car is this" and keeps the
    // round trip near the few seconds the capture sheet promises. `fallbacks: 'default'`
    // re-runs a declined request on another model server-side rather than failing it.
    response = await anthropic().beta.messages.create({
      model: config.IDENTIFY_MODEL,
      max_tokens: 4096,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image.toString('base64') } },
          { type: 'text', text: target
            ? `Identify the vehicle in this photo. The player is hunting for: ${target}.`
            : 'Identify the vehicle in this photo.' },
        ],
      }],
    });
  } catch (err) {
    // Logged in full here because the player only ever sees "not answering".
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      console.error('[cth] identify: the API key was rejected —', err.message);
    } else if (err instanceof Anthropic.BadRequestError) {
      console.error('[cth] identify: request rejected —', err.message);
    } else {
      console.error('[cth] identify:', err?.message ?? err);
    }
    throw unavailable(err?.status ? `HTTP ${err.status}` : 'network');
  }

  // A refusal is not an outage; the photo just could not be read.
  if (response.stop_reason === 'refusal') return null;
  if (response.stop_reason === 'max_tokens') throw unavailable('ran out of tokens');

  const text = response.content.find((b) => b.type === 'text')?.text;
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    console.error('[cth] identify: unparseable output —', text?.slice(0, 200));
    return null;
  }
}

/**
 * A canned identifier for the end-to-end test, which boots the real server and so
 * cannot inject a function. Honoured only under NODE_ENV=test, so no deployment can be
 * talked into skipping the real call.
 */
const stubIdentifier = () => {
  const raw = process.env.CTH_IDENTIFY_STUB;
  if (!raw || process.env.NODE_ENV !== 'test') return null;
  return async () => {
    const stub = JSON.parse(raw);
    if (stub === 'UNAVAILABLE') throw unavailable('stub');
    return stub;
  };
};

let identifier = stubIdentifier() ?? claudeIdentifier;

/** Swap the identifier. Tests only; returns the previous one so it can be put back. */
export function setIdentifier(fn) {
  const previous = identifier;
  identifier = fn ?? claudeIdentifier;
  return previous;
}

/**
 * Identify the car in a processed upload. Reads the display derivative, which is at most
 * 1600px and already rotated upright — the original can be a 40 MB drone frame.
 */
export async function identifyPhoto(photo, { target = null } = {}) {
  const image = await fs.readFile(path.join(config.mediaDir, photo.path_display));
  return identifier(image, 'image/webp', { target });
}
