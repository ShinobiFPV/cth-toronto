/** An error carrying a stable code the client can branch on (spec §6). */
export class GameError extends Error {
  constructor(code, message, extra = {}, status = 409) {
    super(message);
    this.name = 'GameError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
  toJSON() {
    const { code, message, status, ...rest } = this;
    return { error: code, message, ...omit(rest, ['name', 'stack']) };
  }
}

function omit(obj, keys) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (!keys.includes(k)) out[k] = v;
  return out;
}

export const badRequest = (code, message, extra) => new GameError(code, message, extra, 400);
export const notFound = (code, message, extra) => new GameError(code, message, extra, 404);
export const unauthorized = (message = 'Sign in first') =>
  new GameError('UNAUTHORIZED', message, {}, 401);
export const forbidden = (code, message, extra) => new GameError(code, message, extra, 403);
