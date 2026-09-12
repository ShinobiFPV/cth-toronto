// Parkemans Go — server entry point.
// Express for the API, ws for chat and live map updates, static hosting for the PWA.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { config } from './config.js';
import { db } from './db.js';
import { attachPlayer } from './lib/auth.js';
import { attachWebSocket } from './lib/hub.js';
import { ensureMediaDirs } from './lib/images.js';
import { GameError } from './lib/errors.js';
import { authRoutes, meRoutes } from './routes/auth.js';
import { hoodRoutes } from './routes/hoods.js';
import { claimRoutes } from './routes/claims.js';
import { miscRoutes } from './routes/misc.js';
import { parkRoutes } from './routes/parks.js';
import { tradeRoutes } from './routes/trades.js';
import { activeSeason } from './lib/seasons.js';

await ensureMediaDirs();

const app = express();
app.set('trust proxy', true);   // behind nginx and the Cloudflare Tunnel
app.disable('x-powered-by');

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());
app.use(attachPlayer);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    season: activeSeason()?.name ?? null,
    players: db.prepare('SELECT COUNT(*) AS c FROM players').get().c,
    claims: db.prepare('SELECT COUNT(*) AS c FROM claims').get().c,
  });
});

app.use('/api/auth', authRoutes);
app.use('/api', meRoutes);
app.use('/api/hoods', hoodRoutes);
app.use('/api/claims', claimRoutes);
app.use('/api', miscRoutes);
app.use('/api', parkRoutes);
app.use('/api', tradeRoutes);

// Photos are behind the login. Originals in particular exist for dispute review, and
// nothing in this game should be linkable to someone who is not playing it.
app.use('/media', (req, res, next) => {
  if (!req.player) return res.status(401).end();
  next();
}, express.static(config.mediaDir, {
  maxAge: '30d',
  immutable: true,
  fallthrough: false,
  dotfiles: 'deny',
}));

// The map layer and PWA assets. In dev these come from web/public; a production
// build copies them into web/dist.
const staticRoots = [config.webDist, config.publicDir].filter((d) => fs.existsSync(d));

/**
 * The service worker and the app shell must never be cached, and this is not a
 * micro-optimisation — it is the difference between a deploy reaching players or not.
 *
 * Express sends `max-age=0` for static files, which Cloudflare happily replaces with
 * its own four-hour TTL on anything ending in .js. `sw.js` *is* the precache manifest,
 * so a stale copy pins every phone to the previous build's assets for four hours — in
 * Safari and in the installed app alike, because they share one worker. That is exactly
 * how a shipped fix can look like it never happened. `no-store` is the one instruction
 * both the browser and the edge honour.
 *
 * Everything under /assets/ is content-hashed, so it gets the opposite treatment: a
 * year, immutable. A new build has new filenames.
 */
const NEVER_CACHE = new Set(['sw.js', 'registerSW.js', 'index.html', 'manifest.webmanifest']);

const cacheHeaders = (res, filePath) => {
  const name = path.basename(filePath);
  if (NEVER_CACHE.has(name)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return;
  }
  // Normalised first: this runs on Windows in dev, where path.sep is a backslash.
  const unix = filePath.split(path.sep).join('/');
  if (unix.includes('/assets/') || /-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/.test(name)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return;
  }
  // Fonts, icons, the Hood geometry: unhashed but slow-moving. A day is short enough
  // that a change lands the next time somebody opens the app.
  res.setHeader('Cache-Control', 'public, max-age=86400');
};

for (const root of staticRoots) {
  app.use(express.static(root, { index: false, setHeaders: cacheHeaders }));
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

// SPA fallback — every non-API path renders the app shell.
app.get('*', (req, res, next) => {
  const indexPath = staticRoots
    .map((r) => path.join(r, 'index.html'))
    .find((p) => fs.existsSync(p));
  if (!indexPath) {
    return res.status(503).type('text/plain').send(
      'The web client has not been built yet. Run: npm run build');
  }
  // Same rule as above: the shell names the hashed bundles, so a cached shell serves
  // yesterday's app. res.sendFile does not go through express.static's setHeaders.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(indexPath, (err) => (err ? next(err) : undefined));
});

// ── Errors ────────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err instanceof GameError) {
    return res.status(err.status ?? 409).json(err.toJSON());
  }
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(400).json({
      error: tooBig ? 'PHOTO_TOO_BIG' : 'UPLOAD_FAILED',
      message: tooBig
        ? `That photo is over the ${config.maxUploadBytes / 1048576} MB limit.`
        : err.message,
    });
  }
  console.error('[cth]', err);
  res.status(500).json({ error: 'SERVER_ERROR', message: 'Something broke on the server.' });
});

const server = http.createServer(app);
attachWebSocket(server);

server.listen(config.port, config.host, () => {
  const season = activeSeason();
  console.log(`[cth] Parkemans Go listening on http://${config.host}:${config.port}`);
  console.log(`[cth] db=${config.dbPath}`);
  console.log(`[cth] media=${config.mediaDir}`);
  console.log(`[cth] season=${season ? season.name : 'none active'}`);
  if (!staticRoots.some((r) => fs.existsSync(path.join(r, 'index.html')))) {
    console.log('[cth] no web build found — run `npm run build`, or `npm run dev:web` for the Vite dev server');
  }
});

const shutdown = (signal) => () => {
  console.log(`[cth] ${signal} — closing`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown('SIGTERM'));
process.on('SIGINT', shutdown('SIGINT'));
