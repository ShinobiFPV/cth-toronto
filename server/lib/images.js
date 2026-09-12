// Upload pipeline: original kept for dispute review, two derivatives for the app.
//
// Spec §4.3 — original/ untouched, display/ 1600px WebP q80, thumb/ 400px square
// WebP q70, EXIF stripped from anything served publicly. sharp strips metadata by
// default, so "stripped" here means "we never ask for it back", but the orientation
// tag has to be applied with .rotate() first or half the phone shots come out sideways.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { config } from '../config.js';
import { badRequest } from './errors.js';

const DIRS = ['original', 'display', 'thumb'];

export async function ensureMediaDirs() {
  for (const d of DIRS) await fs.mkdir(path.join(config.mediaDir, d), { recursive: true });
}

const HEIC_MIME = /^image\/(heic|heif)/i;
const HEIC_EXT = /\.(heic|heif)$/i;
const isHeic = (file) => HEIC_MIME.test(file.mimetype || '') || HEIC_EXT.test(file.originalname || '');

const HEIC_MESSAGE =
  'That looks like an iPhone HEIC file and this server cannot decode it. ' +
  'On your iPhone: Settings → Camera → Formats → Most Compatible, then retake the shot.';

/**
 * Decode whatever the phone sent into something sharp can work with.
 *
 * sharp on the Pi is usually built without an HEIC decoder (libheif ships AVIF-only
 * in most distro builds), so HEIC gets a pure-JS fallback. The web client also tries
 * to convert before upload — this is the safety net for the ones that slip through.
 */
async function decodable(buffer, file) {
  try {
    await sharp(buffer).metadata();
    return buffer;
  } catch {
    if (!isHeic(file)) {
      throw badRequest('BAD_IMAGE', 'That file is not an image this server can read.');
    }
    if (!config.heicServerFallback) throw badRequest('HEIC_UNSUPPORTED', HEIC_MESSAGE);

    let convert;
    try {
      ({ default: convert } = await import('heic-convert'));
    } catch {
      throw badRequest('HEIC_UNSUPPORTED', HEIC_MESSAGE);
    }
    try {
      // Slow (pure JS, seconds for a 12 MP frame) but reliable, and rare enough.
      const jpeg = await convert({ buffer, format: 'JPEG', quality: 0.92 });
      return Buffer.from(jpeg);
    } catch {
      throw badRequest('HEIC_UNSUPPORTED', HEIC_MESSAGE);
    }
  }
}

/**
 * Write the three derivatives and return the row shape `photos` wants.
 * Paths are relative to config.mediaDir and are served under /media/.
 */
export async function processUpload(file) {
  if (!file?.buffer?.length) throw badRequest('NO_PHOTO', 'No photo was attached.');
  if (file.size > config.maxUploadBytes) {
    throw badRequest('PHOTO_TOO_BIG',
      `That photo is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${config.maxUploadBytes / 1048576} MB.`);
  }
  await ensureMediaDirs();

  const source = await decodable(file.buffer, file);
  const meta = await sharp(source).metadata();

  const id = crypto.randomUUID();
  // The original keeps its real extension unless it was HEIC we transcoded on the way in.
  const originalExt = source === file.buffer
    ? (path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg')
    : '.jpg';

  const rel = {
    original: path.posix.join('original', id + originalExt),
    display: path.posix.join('display', `${id}.webp`),
    thumb: path.posix.join('thumb', `${id}.webp`),
  };
  const abs = (r) => path.join(config.mediaDir, r);

  await fs.writeFile(abs(rel.original), source);

  const display = await sharp(source)
    .rotate()                                   // bake in EXIF orientation, then drop it
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(abs(rel.display));

  await sharp(source)
    .rotate()
    .resize({ width: 400, height: 400, fit: 'cover', position: 'attention' })
    .webp({ quality: 70 })
    .toFile(abs(rel.thumb));

  let exifJson = null;
  if (config.readExif) exifJson = await readShotData(source);

  return {
    path_original: rel.original,
    path_display: rel.display,
    path_thumb: rel.thumb,
    width: display.width ?? meta.width ?? null,
    height: display.height ?? meta.height ?? null,
    bytes: file.size,
    exif_json: exifJson,
  };
}

/**
 * The read-only "shot data" panel from spec §1.4. The server never acts on any of
 * this — it exists so flaggers have something concrete to argue about.
 */
async function readShotData(buffer) {
  try {
    const { default: exifr } = await import('exifr');
    const raw = await exifr.parse(buffer, {
      pick: ['Make', 'Model', 'LensModel', 'DateTimeOriginal', 'CreateDate', 'ISO',
             'FNumber', 'ExposureTime', 'FocalLength', 'GPSLatitude', 'GPSLongitude',
             'GPSAltitude', 'Software'],
    });
    if (!raw) return null;
    const shot = {
      make: raw.Make ?? null,
      model: raw.Model ?? null,
      lens: raw.LensModel ?? null,
      taken_at: (raw.DateTimeOriginal ?? raw.CreateDate)?.toISOString?.() ?? null,
      iso: raw.ISO ?? null,
      aperture: raw.FNumber ?? null,
      shutter: raw.ExposureTime ?? null,
      focal_length: raw.FocalLength ?? null,
      altitude: raw.GPSAltitude ?? null,
      software: raw.Software ?? null,
      lat: Number.isFinite(raw.GPSLatitude) ? raw.GPSLatitude : null,
      lng: Number.isFinite(raw.GPSLongitude) ? raw.GPSLongitude : null,
    };
    return Object.values(shot).some((v) => v !== null) ? JSON.stringify(shot) : null;
  } catch {
    return null;   // no EXIF is not an error; most drone exports have plenty, screenshots none
  }
}

/** Delete the three files behind a photo row. Used only when a claim fails to land. */
export async function discardUpload(photo) {
  if (!photo) return;
  for (const rel of [photo.path_original, photo.path_display, photo.path_thumb]) {
    if (!rel) continue;
    await fs.rm(path.join(config.mediaDir, rel), { force: true }).catch(() => {});
  }
}
