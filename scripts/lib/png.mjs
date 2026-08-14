/**
 * A very small PNG toolkit: decode, resample, encode, and pack an ICO.
 *
 *   import { decodePng, encodePng, encodeIco, resize } from './lib/png.mjs';
 *
 * ## Why this exists rather than a dependency
 *
 * It is used by `scripts/make-brand-icons.mjs` to derive every icon in the product from one
 * master image. The obvious alternative is `sharp`, and it was rejected deliberately: it is
 * a large native package that every contributor would install on every `pnpm install`, and
 * it would be pulled in to resize a handful of icons that change about as often as the
 * company name. Everything here is built on `node:zlib`, which ships with Node.
 *
 * ## What it does not do
 *
 * This is not a general PNG library and must not be treated as one. It reads 8-bit,
 * non-interlaced RGB or RGBA only — the form the brand master is in — and refuses anything
 * else with a message naming what it found rather than emitting a corrupt image (Rule 14).
 * It writes 8-bit RGBA. There is no colour quantisation, no gamma handling and no interlace.
 */
import { deflateSync, inflateSync } from 'node:zlib';

export const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes per pixel in every buffer this module hands out or takes back. */
const BPP = 4;

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

/** PNG's Paeth predictor, shared by the encoder and the decoder. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode a PNG into `{ width, height, rgba }`, where `rgba` is 4 bytes per pixel.
 *
 * `label` only appears in error messages, so a failure names the file that caused it.
 */
export function decodePng(file, label = 'image') {
  if (!file.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error(`${label} is not a PNG (bad signature)`);
  }

  let width = 0;
  let height = 0;
  let channels = 0;
  const parts = [];

  for (let offset = 8; offset + 8 <= file.length; ) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('ascii', offset + 4, offset + 8);
    const data = file.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colourType = data[9];
      const interlace = data[12];

      if (depth !== 8 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) {
        throw new Error(
          `${label}: unsupported PNG (bit depth ${depth}, colour type ${colourType}, ` +
            `interlace ${interlace}). This decoder reads 8-bit non-interlaced RGB or RGBA ` +
            `only. Re-export the file in that form.`,
        );
      }
      channels = colourType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      parts.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset += 12 + length;
  }

  if (width === 0 || height === 0) throw new Error(`${label}: no IHDR chunk`);

  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const expected = height * (stride + 1);
  if (raw.length < expected) {
    throw new Error(`${label}: truncated image data (${raw.length} of ${expected} bytes)`);
  }

  const rgba = Buffer.alloc(width * height * BPP);
  let previous = Buffer.alloc(stride);
  let current = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));

    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? current[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      let value = line[i];

      // Reconstruction formulas, PNG spec §9.2.
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`${label}: unknown filter ${filter} on row ${y}`);

      current[i] = value & 0xff;
    }

    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * BPP;
      const from = x * channels;
      rgba[to] = current[from];
      rgba[to + 1] = current[from + 1];
      rgba[to + 2] = current[from + 2];
      rgba[to + 3] = channels === 4 ? current[from + 3] : 255;
    }

    // Swap, so the row just decoded becomes the reference for the next one.
    const spare = previous;
    previous = current;
    current = spare;
  }

  return { width, height, rgba };
}

/**
 * Encode 8-bit RGBA as a PNG.
 *
 * Each row picks the filter that compresses best, using the minimum-sum-of-absolute-
 * differences heuristic the spec recommends (§12.8). On this artwork that is worth roughly
 * a third of the file size over always writing filter 0, for a few lines of arithmetic.
 */
export function encodePng({ width, height, rgba }) {
  const stride = width * BPP;
  const rows = [];
  let previous = Buffer.alloc(stride);

  const candidate = Buffer.alloc(stride);
  let best = null;
  let bestScore = Infinity;

  for (let y = 0; y < height; y++) {
    const line = rgba.subarray(y * stride, (y + 1) * stride);
    bestScore = Infinity;
    best = null;

    for (let filter = 0; filter <= 4; filter++) {
      let score = 0;

      for (let i = 0; i < stride; i++) {
        const raw = line[i];
        const a = i >= BPP ? line[i - BPP] : 0;
        const b = previous[i];
        const c = i >= BPP ? previous[i - BPP] : 0;

        let value;
        if (filter === 0) value = raw;
        else if (filter === 1) value = raw - a;
        else if (filter === 2) value = raw - b;
        else if (filter === 3) value = raw - ((a + b) >> 1);
        else value = raw - paeth(a, b, c);

        value &= 0xff;
        candidate[i] = value;
        // Treat the byte as signed for scoring: small deltas either side of zero are what
        // deflate compresses well, and 255 is -1, not a large number.
        score += value < 128 ? value : 256 - value;
      }

      if (score < bestScore) {
        bestScore = score;
        best = Buffer.concat([Buffer.from([filter]), candidate]);
      }
    }

    rows.push(best);
    previous = line;
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Pack PNGs into an ICO.
 *
 * ICO has been able to carry PNG payloads rather than raw DIBs since Windows Vista, and
 * every browser in use understands them, so this is a container around the images rather
 * than a re-encode.
 */
export function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    // 0 means 256 in this field, which is why it is a byte and 256 is the maximum.
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette size: not paletted
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

/** Read an ICO back out into `[{ size, png }]`, for verification. */
export function decodeIco(file) {
  if (file.readUInt16LE(0) !== 0 || file.readUInt16LE(2) !== 1) {
    throw new Error('Not an ICO file');
  }

  const count = file.readUInt16LE(4);
  const images = [];

  for (let i = 0; i < count; i++) {
    const entry = 6 + 16 * i;
    const length = file.readUInt32LE(entry + 8);
    const offset = file.readUInt32LE(entry + 12);
    if (offset + length > file.length) throw new Error(`ICO entry ${i} runs past end of file`);
    images.push({ size: file.readUInt8(entry) || 256, png: file.subarray(offset, offset + length) });
  }

  return images;
}

/**
 * Area-average downscale to a square.
 *
 * Every destination pixel averages the whole block of source pixels it covers rather than
 * sampling one of them. At these ratios — a 1254px master down to 16px — point sampling
 * throws away 99.98% of the image and returns whatever pixel it happened to land on.
 *
 * Colour is averaged premultiplied by alpha and then divided back out. Averaging straight
 * RGB lets the colour of fully transparent pixels bleed inward and leaves a grey halo
 * around the edge of the mark.
 */
export function resize({ width, height, rgba }, size) {
  const out = Buffer.alloc(size * size * BPP);

  for (let y = 0; y < size; y++) {
    const y0 = Math.floor((y * height) / size);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / size));

    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * width) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / size));

      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      let count = 0;

      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * width + sx) * BPP;
          const a = rgba[i + 3];
          r += rgba[i] * a;
          g += rgba[i + 1] * a;
          b += rgba[i + 2] * a;
          alpha += a;
          count++;
        }
      }

      const to = (y * size + x) * BPP;
      out[to] = alpha === 0 ? 0 : Math.round(r / alpha);
      out[to + 1] = alpha === 0 ? 0 : Math.round(g / alpha);
      out[to + 2] = alpha === 0 ? 0 : Math.round(b / alpha);
      out[to + 3] = Math.round(alpha / count);
    }
  }

  return { width: size, height: size, rgba: out };
}

/**
 * Clear a flat background colour, leaving the subject on transparency.
 *
 * Flood-filled inward from the frame edge rather than colour-keyed across the whole image.
 * A global key also matches the identical colour enclosed *inside* the subject, which on
 * the brand master would punch the artwork full of holes.
 */
export function knockOutBackground({ width, height, rgba }, { colour, tolerance }) {
  const matches = (pixel) => {
    const i = pixel * BPP;
    return (
      Math.abs(rgba[i] - colour[0]) <= tolerance &&
      Math.abs(rgba[i + 1] - colour[1]) <= tolerance &&
      Math.abs(rgba[i + 2] - colour[2]) <= tolerance
    );
  };

  const seen = new Uint8Array(width * height);
  const stack = [];
  for (let x = 0; x < width; x++) stack.push(x, x + (height - 1) * width);
  for (let y = 0; y < height; y++) stack.push(y * width, y * width + width - 1);

  let cleared = 0;
  while (stack.length > 0) {
    const pixel = stack.pop();
    if (seen[pixel] || !matches(pixel)) continue;

    seen[pixel] = 1;
    rgba[pixel * BPP + 3] = 0;
    cleared++;

    const x = pixel % width;
    const y = (pixel / width) | 0;
    if (x > 0) stack.push(pixel - 1);
    if (x < width - 1) stack.push(pixel + 1);
    if (y > 0) stack.push(pixel - width);
    if (y < height - 1) stack.push(pixel + width);
  }

  return cleared;
}

/** Composite over an opaque colour, for targets that cannot show transparency. */
export function flatten({ width, height, rgba }, colour) {
  const out = Buffer.alloc(rgba.length);

  for (let i = 0; i < rgba.length; i += BPP) {
    const a = rgba[i + 3] / 255;
    out[i] = Math.round(rgba[i] * a + colour[0] * (1 - a));
    out[i + 1] = Math.round(rgba[i + 1] * a + colour[1] * (1 - a));
    out[i + 2] = Math.round(rgba[i + 2] * a + colour[2] * (1 - a));
    out[i + 3] = 255;
  }

  return { width, height, rgba: out };
}
