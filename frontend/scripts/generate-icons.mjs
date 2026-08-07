#!/usr/bin/env node
// Regenerates the PWA icon set in frontend/public/icons/.
// Zero dependencies: rasterizes the brand mark by hand and writes PNGs with node:zlib.
//
//   node frontend/scripts/generate-icons.mjs
//
// The mark mirrors the in-app brand glyph (lucide TerminalSquare): a rounded square
// with a lime chevron and prompt bar on the console-dark canvas.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const outputDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

const CANVAS = [0x11, 0x12, 0x11];
const SURFACE = [0x1a, 0x1b, 0x1a];
const PRIMARY = [0xa9, 0xe8, 0x5e];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function roundedRect(x, y, rect) {
  const dx = Math.max(rect.x0 - x, x - rect.x1, 0);
  const dy = Math.max(rect.y0 - y, y - rect.y1, 0);
  return Math.hypot(dx, dy) - rect.r;
}

function segment(x, y, ax, ay, bx, by, halfWidth) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = x - ax;
  const wy = y - ay;
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / lengthSquared));
  return Math.hypot(wx - vx * t, wy - vy * t) - halfWidth;
}

function over(base, layer, coverage) {
  if (coverage <= 0) return base;
  return [
    base[0] + (layer[0] - base[0]) * coverage,
    base[1] + (layer[1] - base[1]) * coverage,
    base[2] + (layer[2] - base[2]) * coverage,
    base[3] + (1 - base[3]) * coverage,
  ];
}

// Signed-distance coverage with a one-pixel feather, in unit space.
function cover(distance, feather) {
  return Math.min(1, Math.max(0, 0.5 - distance / feather));
}

function sample(u, v, options) {
  const feather = options.feather;
  const scale = options.contentScale;
  // Map into the content box so maskable icons keep their glyph inside the safe zone.
  const x = 0.5 + (u - 0.5) / scale;
  const y = 0.5 + (v - 0.5) / scale;

  let pixel = [0, 0, 0, 0];

  if (options.fullBleed) {
    pixel = over(pixel, CANVAS, 1);
  } else {
    const outer = roundedRect(u, v, { x0: 0.06, y0: 0.06, x1: 0.94, y1: 0.94, r: 0.2 });
    pixel = over(pixel, CANVAS, cover(outer, feather));
  }

  const plate = roundedRect(x, y, { x0: 0.24, y0: 0.24, x1: 0.76, y1: 0.76, r: 0.11 });
  pixel = over(pixel, SURFACE, cover(plate, feather));
  // Lime keyline around the terminal plate.
  pixel = over(pixel, PRIMARY, cover(Math.abs(plate + 0.015) - 0.015, feather));

  const chevron = Math.min(
    segment(x, y, 0.375, 0.4, 0.5, 0.5, 0.028),
    segment(x, y, 0.5, 0.5, 0.375, 0.6, 0.028),
  );
  pixel = over(pixel, PRIMARY, cover(chevron, feather));
  pixel = over(pixel, PRIMARY, cover(segment(x, y, 0.545, 0.6, 0.64, 0.6, 0.028), feather));

  return pixel;
}

function renderIcon(size, options) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 3;
  const feather = 1.6 / size;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const u = (px + (sx + 0.5) / samples) / size;
          const v = (py + (sy + 0.5) / samples) / size;
          const pixel = sample(u, v, { ...options, feather });
          r += pixel[0] * pixel[3];
          g += pixel[1] * pixel[3];
          b += pixel[2] * pixel[3];
          a += pixel[3];
        }
      }
      const total = samples * samples;
      const alpha = a / total;
      const offset = (py * size + px) * 4;
      rgba[offset] = alpha > 0 ? Math.round(r / a) : 0;
      rgba[offset + 1] = alpha > 0 ? Math.round(g / a) : 0;
      rgba[offset + 2] = alpha > 0 ? Math.round(b / a) : 0;
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

const targets = [
  { file: "icon-192.png", size: 192, options: { contentScale: 1, fullBleed: false } },
  { file: "icon-512.png", size: 512, options: { contentScale: 1, fullBleed: false } },
  { file: "icon-maskable-512.png", size: 512, options: { contentScale: 0.72, fullBleed: true } },
  { file: "apple-touch-icon.png", size: 180, options: { contentScale: 0.86, fullBleed: true } },
  { file: "favicon-32.png", size: 32, options: { contentScale: 1, fullBleed: false } },
];

mkdirSync(outputDir, { recursive: true });
for (const target of targets) {
  writeFileSync(join(outputDir, target.file), renderIcon(target.size, target.options));
  process.stdout.write(`wrote ${target.file} (${target.size}x${target.size})\n`);
}
