// Thin fetch wrapper. Every call is same-origin and carries the session cookie.
// Errors come back as { error: CODE, message }, and the CODE is what the UI branches
// on — never the message text.

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error ?? 'UNKNOWN';
    this.availableAt = body?.available_at ?? null;
    this.requiredTypes = body?.required_types ?? null;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const init = { method, credentials: 'same-origin', signal, headers: {} };
  if (body instanceof FormData) {
    init.body = body;                      // let the browser set the multipart boundary
  } else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(`/api${path}`, init);
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const safeJson = (t) => { try { return JSON.parse(t); } catch { return { message: t }; } };

export const api = {
  // auth
  status: () => request('/auth/status'),
  register: (body) => request('/auth/register', { method: 'POST', body }),
  login: (body) => request('/auth/login', { method: 'POST', body }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/me'),
  players: () => request('/players'),
  invites: () => request('/invites'),
  createInvite: (note) => request('/invites', { method: 'POST', body: { note } }),

  // hoods and claims
  hoods: () => request('/hoods'),
  hood: (id) => request(`/hoods/${id}`),
  hoodHistory: (id) => request(`/hoods/${id}/history`),
  check: (id, photoType) =>
    request(`/hoods/${id}/check${photoType ? `?photo_type=${photoType}` : ''}`),
  claim: (id, formData) => request(`/hoods/${id}/claim`, { method: 'POST', body: formData }),

  // ledger
  feed: (before) => request(`/feed${before ? `?before=${before}` : ''}`),
  claimDetail: (id) => request(`/claims/${id}`),
  // Captions are the one thing a player can change after the fact. Sending an empty
  // string clears it.
  setCaption: (id, caption) =>
    request(`/claims/${id}/caption`, { method: 'PUT', body: { caption } }),
  flag: (id, reason) => request(`/claims/${id}/flag`, { method: 'POST', body: { reason } }),
  unflag: (id) => request(`/claims/${id}/flag`, { method: 'DELETE' }),

  // standings
  leaderboard: (season) => request(`/leaderboard${season ? `?season=${season}` : ''}`),
  champion: () => request('/leaderboard/champion'),
  seasons: () => request('/seasons'),

  // Parkemans GO
  parksInHood: (hoodId) => request(`/hoods/${hoodId}/parks`),
  park: (id) => request(`/parks/${id}`),
  parkCheck: (id) => request(`/parks/${id}/check`),
  // Omit playerId for your own binder; pass one to read somebody else's.
  cards: (season, playerId) => {
    const q = new URLSearchParams();
    if (season) q.set('season', season);
    if (playerId) q.set('player', playerId);
    const qs = q.toString();
    return request(`/cards${qs ? `?${qs}` : ''}`);
  },
  card: (claimId) => request(`/cards/${claimId}`),

  // chat
  chat: (before) => request(`/chat${before ? `?before=${before}` : ''}`),
  say: (body) => request('/chat', { method: 'POST', body: { body } }),
};

/**
 * Upload with progress. fetch() still cannot report upload progress, and a 40 MB
 * drone frame over a phone connection absolutely needs a bar, so these two calls use
 * XMLHttpRequest.
 */
export const uploadClaim = (hoodId, formData, onProgress) =>
  upload(`/api/hoods/${hoodId}/claim`, formData, onProgress);

export const uploadPark = (parkId, formData, onProgress) =>
  upload(`/api/parks/${parkId}/collect`, formData, onProgress);

function upload(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      const data = xhr.responseText ? safeJson(xhr.responseText) : null;
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data));
    });
    xhr.addEventListener('error', () => reject(new ApiError(0, { message: 'Upload failed — check your signal.' })));
    xhr.addEventListener('abort', () => reject(new ApiError(0, { message: 'Upload cancelled.' })));
    xhr.send(formData);
  });
}
