// "Is there a bench in this photo?" — the park hunt's confirmation.
//
// Confirm, don't gatekeep. The whole pleasure of a hunt is the app saying *found it*, so
// this asks generously, and a no is never the end: the player can say "I'm sure", which
// marks the item and raises it for the group, exactly like a disputed claim. A
// four-year-old's photo of a bird is a grey smudge in a corner of the frame; rejecting it
// would be both wrong and unkind.
//
// Street hunts do not come through here — their target rides on the car identifier's own
// call (lib/identify.js), one call for both the card and the hunt.
//
// Swappable with setHuntVerifier(), so no test touches the network.
import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

const SYSTEM = `You check photos for a children's scavenger hunt in a city park.

You are told one thing the player is looking for. Say whether it appears anywhere in the
photo. Be generous: a small, distant, blurry, partly hidden or badly framed example counts,
and photos are often taken by young children. Any example of the general thing counts — any
bird for "a bird", any kind of bench for "a bench". Only answer false when it is clearly
not in the photo.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['found', 'confidence'],
  properties: {
    found: { type: 'boolean' },
    confidence: { type: 'number' },
  },
};

let client = null;
const anthropic = () => {
  client ??= new Anthropic({ apiKey: config.IDENTIFY_API_KEY, timeout: config.IDENTIFY_TIMEOUT_MS, maxRetries: 1 });
  return client;
};

/** The real verifier. Returns { found, confidence }, or { found: false, unavailable: true }. */
export async function claudeHuntVerifier(image, mediaType, { label }) {
  if (!config.IDENTIFY_ENABLED || !config.IDENTIFY_API_KEY) return { found: false, unavailable: true };
  try {
    const response = await anthropic().beta.messages.create({
      model: config.IDENTIFY_MODEL,
      max_tokens: 1024,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image.toString('base64') } },
          { type: 'text', text: `The player is looking for: ${label}.` },
        ],
      }],
    });
    const text = response.content.find((b) => b.type === 'text')?.text;
    const said = text ? JSON.parse(text) : null;
    return { found: said?.found === true, confidence: Number(said?.confidence) || 0 };
  } catch (err) {
    // Never the player's problem: an unanswered check simply is not a confirmation, and
    // "I'm sure" is still right there.
    console.error('[cth] hunt verify:', err?.message ?? err);
    return { found: false, unavailable: true };
  }
}

/** A canned answer for the end-to-end suite. Honoured only under NODE_ENV=test. */
const stubVerifier = () => {
  const raw = process.env.CTH_HUNT_VERIFY_STUB;
  if (!raw || process.env.NODE_ENV !== 'test') return null;
  return async () => JSON.parse(raw);
};

let verifier = stubVerifier() ?? claudeHuntVerifier;

/** Swap the verifier. Tests only; returns the previous one. */
export function setHuntVerifier(fn) {
  const previous = verifier;
  verifier = fn ?? claudeHuntVerifier;
  return previous;
}

/** Check a processed upload against one hunt item's label. */
export async function verifyHuntPhoto(photo, label) {
  const image = await fs.readFile(path.join(config.mediaDir, photo.path_display));
  return verifier(image, 'image/webp', { label });
}
