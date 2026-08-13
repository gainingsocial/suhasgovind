#!/usr/bin/env node
/**
 * Generate the extension icons.
 *
 *   node integrations/chrome/tools/make-icons.mjs
 *
 * Committed as a generator rather than as three opaque binaries, so the mark can be
 * regenerated at any size when the store asks for one. PNG is assembled by hand — a solid
 * rounded square with a share glyph needs no image library, and adding one to this
 * repository to draw sixty pixels would be a poor trade.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../icons/', import.meta.url));

// Brand yellow with near-black ink. Yellow always carries dark text or marks — it has no
// contrast against white.
const BRAND = [245, 197, 24];
const INK = [27, 28, 32];

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, crc]);
}

/** Distance from a point to a line segment — used to draw the glyph's connecting bars. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function render(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const radius = size * 0.22;

  // Three nodes joined by two bars: the standard "share" mark.
  const nodes = [
    { x: size * 0.68, y: size * 0.28 },
    { x: size * 0.68, y: size * 0.72 },
    { x: size * 0.32, y: size * 0.5 },
  ];
  const nodeRadius = size * 0.1;
  const barWidth = size * 0.045;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none

    for (let x = 0; x < size; x++) {
      const offset = rowStart + 1 + x * 4;

      // Rounded-square mask, computed as distance outside the inset rectangle.
      const dx = Math.max(radius - x, 0, x - (size - 1 - radius));
      const dy = Math.max(radius - y, 0, y - (size - 1 - radius));
      const outside = Math.hypot(dx, dy) - radius;

      if (outside > 0.5) {
        raw[offset + 3] = 0; // transparent corner
        continue;
      }

      let [r, g, b] = BRAND;

      const onNode = nodes.some(
        (node) => Math.hypot(x - node.x, y - node.y) <= nodeRadius,
      );
      const onBar =
        distanceToSegment(x, y, nodes[2].x, nodes[2].y, nodes[0].x, nodes[0].y) <= barWidth ||
        distanceToSegment(x, y, nodes[2].x, nodes[2].y, nodes[1].x, nodes[1].y) <= barWidth;

      if (onNode || onBar) [r, g, b] = INK;

      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      // Feathered edge, so the rounded corner is not a staircase.
      raw[offset + 3] = outside > -0.5 ? Math.round((0.5 - outside) * 255) : 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });

for (const size of [16, 48, 128]) {
  const png = render(size);
  writeFileSync(`${OUT}icon${size}.png`, png);
  console.log(`icon${size}.png  ${png.length} bytes`);
}
