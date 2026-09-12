import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// In dev, Vite serves the UI and proxies everything stateful to the Node server.
const API = process.env.CTH_DEV_API || 'http://127.0.0.1:8093';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'hoods.min.geojson', 'fonts/*.woff2'],
      manifest: {
        name: 'Capture the Hood: Toronto',
        short_name: 'Capture the Hood',
        description: 'Conquer Toronto\u2019s 25 Hoods with your camera.',
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
        navigateFallbackDenylist: [/^\/api/, /^\/media/, /^\/ws/],
        runtimeCaching: [
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
