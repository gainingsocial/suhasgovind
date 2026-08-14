#!/usr/bin/env node
/**
 * Derive every icon in the product from one master image.
 *
 *   node scripts/make-brand-icons.mjs           # write the icons
 *   node scripts/make-brand-icons.mjs --check   # verify the committed ones are current
 *
 * ## Why one generator for three surfaces
 *
 * The website, the favicon and the Chrome extension had each acquired their own artwork.
 * That is not a cosmetic problem: a person who sees the extension icon in their toolbar and
 * the site icon in their tab has to recognise the same product twice. Keeping the outputs
 * in one place means the next change to the mark reaches every surface in one command
 * instead of reaching whichever ones somebody remembered.
 *
 * `--check` runs in `pnpm run ci`, following `errors:check` and `wp:check`. Generated files
 * that are committed alongside their generator drift silently otherwise — the master gets
 * updated, the icons do not, and nobody notices until a release. It compares decoded pixels
 * rather than file bytes, so a Node or zlib upgrade that changes compression output by a
 * byte cannot turn into a red build with nothing actually wrong.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  decodeIco,
  decodePng,
  encodeIco,
  encodePng,
  flatten,
  knockOutBackground,
  resize,
} from './lib/png.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const MASTER = `${root}assets/brand/gaining-social-logo.png`;

/**
 * The master sits on a flat light-grey field. The tolerance is wide enough to absorb the
 * master's compression noise and narrow enough to leave the white outlines around the small
 * social glyphs intact.
 */
const BACKGROUND = { colour: [235, 235, 235], tolerance: 16 };
const WHITE = [255, 255, 255];

/**
 * Every derived icon.
 *
 * `flattenOn` exists for exactly one target: iOS renders a home-screen icon over black, so
 * a transparent apple-touch-icon arrives as a mark floating in a black square.
 */
const TARGETS = [
  {
    path: 'apps/web/public/logo.png',
    size: 128,
    note: 'site mark — header, footer, dashboard sidebar (drawn at most at 36px)',
  },
  { path: 'apps/web/src/app/icon.png', size: 96, note: 'favicon for high-DPI browser tabs' },
  {
    path: 'apps/web/src/app/apple-icon.png',
    size: 180,
    flattenOn: WHITE,
    note: 'iOS home screen',
  },
  { path: 'integrations/chrome/icons/icon16.png', size: 16, note: 'extension toolbar' },
  { path: 'integrations/chrome/icons/icon48.png', size: 48, note: 'extension management page' },
  { path: 'integrations/chrome/icons/icon128.png', size: 128, note: 'Chrome Web Store listing' },
];

/** The `.ico` carries several sizes in one file; browsers pick the one they want. */
const ICO = { path: 'apps/web/src/app/favicon.ico', sizes: [16, 32, 48] };

const check = process.argv.includes('--check');

if (!existsSync(MASTER)) {
  console.error(`Brand master missing: ${MASTER}`);
  console.error('Every icon in the product is derived from it, so nothing can be generated.');
  process.exit(1);
}

const master = decodePng(readFileSync(MASTER), 'assets/brand/gaining-social-logo.png');
const cleared = knockOutBackground(master, BACKGROUND);

// A knockout that removes almost nothing, or nearly everything, means the master changed
// shape — a white background instead of grey, say. Better to stop than to quietly ship a
// grey box, or a blank one, to every surface at once.
const clearedShare = cleared / (master.width * master.height);
if (clearedShare < 0.05 || clearedShare > 0.6) {
  console.error(
    `Background knockout removed ${(clearedShare * 100).toFixed(1)}% of the master, which is ` +
      `outside the expected 5-60%. The master's background is probably no longer ` +
      `rgb(${BACKGROUND.colour.join(', ')}). Check it, then adjust BACKGROUND in this script.`,
  );
  process.exit(1);
}

const render = (size, flattenOn) => {
  const scaled = resize(master, size);
  return encodePng(flattenOn ? flatten(scaled, flattenOn) : scaled);
};

/** Compare by pixels, not bytes — see the note about zlib at the top. */
function samePixels(a, b, label) {
  const left = decodePng(a, label);
  const right = decodePng(b, label);
  return (
    left.width === right.width && left.height === right.height && left.rgba.equals(right.rgba)
  );
}

const stale = [];
let written = 0;

for (const target of TARGETS) {
  const file = `${root}${target.path}`;
  const png = render(target.size, target.flattenOn);

  if (check) {
    if (!existsSync(file) || !samePixels(readFileSync(file), png, target.path)) {
      stale.push(target.path);
    }
    continue;
  }

  mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  writeFileSync(file, png);
  written++;
  console.log(`${target.path.padEnd(42)} ${`${target.size}px`.padStart(6)}  ${String(png.length).padStart(6)} B  ${target.note}`);
}

const icoFile = `${root}${ICO.path}`;
const ico = encodeIco(ICO.sizes.map((size) => ({ size, png: render(size) })));

if (check) {
  let current = existsSync(icoFile);
  if (current) {
    try {
      const committed = decodeIco(readFileSync(icoFile));
      const fresh = decodeIco(ico);
      current =
        committed.length === fresh.length &&
        committed.every((image, i) => samePixels(image.png, fresh[i].png, ICO.path));
    } catch {
      current = false;
    }
  }
  if (!current) stale.push(ICO.path);
} else {
  writeFileSync(icoFile, ico);
  written++;
  console.log(`${ICO.path.padEnd(42)} ${ICO.sizes.join('/').padStart(6)}  ${String(ico.length).padStart(6)} B  browser tabs and legacy clients`);
}

if (check) {
  if (stale.length > 0) {
    console.error('These icons no longer match the brand master:');
    for (const path of stale) console.error(`  ${path}`);
    console.error('\nRun `pnpm brand:icons` and commit the result.');
    process.exit(1);
  }
  console.log(`Brand icons are current (${TARGETS.length + 1} files).`);
} else {
  console.log(`\n${written} files written from assets/brand/gaining-social-logo.png.`);
}
