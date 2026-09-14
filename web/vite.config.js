import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * A build stamp, shown in the app and logged on boot.
 *
 * This exists because a caching bug once left phones running a build from hours
 * earlier while every fix looked deployed from this side. "What does your profile
 * screen say?" settles that in one message.
 */
const stamp = () => {
  let sha = '';
  try {
    sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { /* a tarball with no git is still a legitimate build */ }
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return sha ? `${when}Z · ${sha}` : `${when}Z`;
};

// In dev, Vite serves the UI and proxies everything stateful to the Node server.
const API = process.env.CTH_DEV_API || 'http://127.0.0.1:8096';

export default defineConfig({
  define: { __BUILD__: JSON.stringify(stamp()) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // parks.index.json is precached so Find a Park works offline, standing outside on
      // bad LTE. Its revision is its content hash, so a re-import reaches every phone.
      includeAssets: ['favicon.svg', 'hoods.min.geojson', 'fonts/*.woff2', 'parks.index.json'],
      manifest: {
        name: 'Park-E-Mans GO!',
        short_name: 'Park-E-Mans',
        description: 'Collect Toronto\u2019s park signs, and hold its 25 Hoods with your camera.',
        theme_color: '#0B0D10',
        background_color: '#0B0D10',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The Hood geometry never changes; everything else is live game state and
        // must not be served stale, so only the map layer and tiles are cached.
        globPatterns: ['**/*.{js,css,html,woff2,svg,png}'],
        // heic2any is 1.3 MB and only ever loads for an iPhone shooting HEIC. It is
        // already a lazy chunk; keeping it out of the precache means nobody pays for
        // it on first load. It still gets cached the first time it is actually used.
        globIgnores: ['**/heic2any-*.js'],
        navigateFallbackDenylist: [/^\/api/, /^\/media/, /^\/ws/, /^\/audio/],
        runtimeCaching: [
          // Sound. Never precached: every URL carries its file's hash (?v=), so a sound
          // the admin swaps is a URL this cache has never seen, and cache-first is safe.
          // Precaching the bare paths is exactly how phones kept playing the old file.
          {
            urlPattern: /\/audio\/[a-z_]+\.m4a\?v=/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'audio',
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 60 },
            },
          },
          // The manifest that names those URLs: network first, the last good copy offline.
          {
            urlPattern: /\/api\/audio\/manifest$/,
            handler: 'NetworkFirst',
            options: { cacheName: 'audio-manifest', networkTimeoutSeconds: 4 },
          },
          {
            urlPattern: /\/hoods\.min\.geojson$/,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'hood-geometry' },
          },
          {
            urlPattern: /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: /heic2any-.*\.js$/,
            handler: 'CacheFirst',
            options: { cacheName: 'heic-decoder' },
          },
          {
            urlPattern: /\/media\/thumb\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'thumbs',
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 14 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/media': { target: API, changeOrigin: true },
      '/ws': { target: API, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    // Leaflet plus the app is comfortably under this; the warning exists to catch
    // somebody accidentally bundling a 2 MB GeoJSON.
    chunkSizeWarningLimit: 700,
  },
});
