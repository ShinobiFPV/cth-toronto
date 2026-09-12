#!/usr/bin/env node
// Generate the PWA icons and favicon from one SVG, so there is exactly one place to
// change the mark. Run once; re-run if the mark or the accent colour changes.
//
//   node scripts/make-icons.js
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../server/config.js';

const OUT = path.join(ROOT, 'web', 'public');
const ACCENT = '#FFB020';
const INK = '#0B0D10';

/**
 * The mark: a Hood outline as a hard-edged polygon with a claim pin dropped in it.
 * Pixel-snapped angles only — Arctic Classified has no curves and no rounded corners.
 */
const mark = ({ size, bleed = 0 }) => {
  const s = size;
  const u = s / 512;               // design is drawn at 512 and scaled
  const inset = bleed ? 78 * u : 34 * u;   // maskable icons need a safe zone
  const g = (n) => (n * (s - inset * 2)) / 512 + inset;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <rect width="${s}" height="${s}" fill="${INK}"/>
  <path d="M ${g(40)} ${g(150)} L ${g(200)} ${g(40)} L ${g(430)} ${g(96)} L ${g(472)} ${g(320)}
           L ${g(300)} ${g(472)} L ${g(96)} ${g(430)} Z"
        fill="none" stroke="${ACCENT}" stroke-width="${26 * u}" stroke-linejoin="miter"/>
  <path d="M ${g(256)} ${g(150)} L ${g(330)} ${g(224)} L ${g(256)} ${g(372)} L ${g(182)} ${g(224)} Z"
        fill="${ACCENT}"/>
  <rect x="${g(226)}" y="${g(194)}" width="${g(60) - g(0)}" height="${g(60) - g(0)}" fill="${INK}"/>
</svg>`;
};

const targets = [
  { file: 'icons/icon-192.png', size: 192, bleed: 0 },
  { file: 'icons/icon-512.png', size: 512, bleed: 0 },
  { file: 'icons/icon-maskable-512.png', size: 512, bleed: 1 },
];

await fs.mkdir(path.join(OUT, 'icons'), { recursive: true });

for (const t of targets) {
  const svg = Buffer.from(mark(t));
  const dest = path.join(OUT, t.file);
  await sharp(svg).png({ compressionLevel: 9 }).toFile(dest);
  console.log(`[icons] ${t.file}`);
}

await fs.writeFile(path.join(OUT, 'favicon.svg'), mark({ size: 512 }));
console.log('[icons] favicon.svg');
