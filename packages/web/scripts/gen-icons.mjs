#!/usr/bin/env node
/**
 * gen-icons.mjs
 *
 * Regenerates the per-size PNG icons from packages/web/public/logo-dy.png.
 * The output PNGs in packages/web/public/icons/ are checked into the repo
 * so this script is only needed when the source logo changes.
 *
 * Strategy (in order):
 *   1. macOS `sips`  (always available on macOS, no install needed)
 *   2. ImageMagick `magick`
 *   3. `rsvg-convert` (only if source is SVG; not used here)
 *
 * Run:  ./bin/node packages/web/scripts/gen-icons.mjs
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PUB = resolve(here, '../public');
const SRC = resolve(PUB, 'logo-dy.png');
const OUT = resolve(PUB, 'icons');

const SIZES = [
  ['icon-152.png', 152],
  ['icon-167.png', 167],
  ['icon-180.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
];

function which(cmd) {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

if (!existsSync(SRC)) {
  console.error(`source logo not found: ${SRC}`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

if (which('sips')) {
  for (const [name, size] of SIZES) {
    const out = resolve(OUT, name);
    execSync(`sips -s format png -Z ${size} "${SRC}" --out "${out}"`, { stdio: 'ignore' });
    console.log(`wrote ${name} (${size}px) via sips`);
  }
} else if (which('magick')) {
  for (const [name, size] of SIZES) {
    const out = resolve(OUT, name);
    execSync(`magick -background black -resize ${size}x${size} "${SRC}" "${out}"`);
    console.log(`wrote ${name} (${size}px) via imagemagick`);
  }
} else {
  console.error('Neither sips nor imagemagick is available. Install one:\n  (macOS) sips is built-in\n  brew install imagemagick');
  process.exit(1);
}
console.log('done. icons regenerated from', SRC);
