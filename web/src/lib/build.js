// The build stamp, injected by vite.config.js at build time.
//
// In `npm run dev` there is no define, so it falls back to a label that cannot be
// mistaken for a deployed build.
export const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
