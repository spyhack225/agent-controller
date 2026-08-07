/**
 * Dependency-free QR Code encoder (ISO/IEC 18004).
 *
 * Supports byte mode (UTF-8), versions 1-40, all four error correction levels,
 * automatic version selection and automatic mask selection. Renderers are
 * provided for SVG (labels), plain text and ANSI terminals (factory operators).
 *
 * Only byte mode is implemented on purpose: claim URLs are mixed-case and
 * contain "://" and "?", none of which fit alphanumeric mode anyway.
 */

const ECC_LEVELS = {
  L: { name: "L", ordinal: 0, formatBits: 0b01 },
  M: { name: "M", ordinal: 1, formatBits: 0b00 },
  Q: { name: "Q", ordinal: 2, formatBits: 0b11 },
  H: { name: "H", ordinal: 3, formatBits: 0b10 },
};

// Number of error correction codewords per block, indexed [eccOrdinal][version].
const ECC_CODEWORDS_PER_BLOCK = [
  // 0   1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
];

// Number of error correction blocks, indexed [eccOrdinal][version].
const NUM_ERROR_CORRECTION_BLOCKS = [
  // 0  1  2  3  4  5  6  7  8  9 10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
];

const MIN_VERSION = 1;
const MAX_VERSION = 40;
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    GF_EXP[index] = value;
    GF_LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) GF_EXP[index] = GF_EXP[index - 255];
})();

export class QrCode {
  constructor({ version, ecc, mask, modules }) {
    this.version = version;
    this.ecc = ecc;
    this.mask = mask;
    this.size = modules.length;
    this.modules = modules;
    Object.freeze(this);
  }

  /** Returns true when the module at (x, y) is dark. Out-of-range is light. */
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return false;
    return this.modules[y][x] === true;
  }

  /** Rows of "0"/"1" characters, handy for tests and debugging. */
  toRowStrings() {
    return this.modules.map((row) => row.map((cell) => (cell ? "1" : "0")).join(""));
  }
}

/**
 * Encodes `text` as a QR code.
 *
 * @param {string} text
 * @param {{ecc?: "L"|"M"|"Q"|"H", minVersion?: number, maxVersion?: number, mask?: number|null}} [options]
 * @returns {QrCode}
 */
export function encodeQr(text, options = {}) {
  const ecc = resolveEcc(options.ecc ?? "M");
  const minVersion = clampVersion(options.minVersion ?? MIN_VERSION);
  const maxVersion = clampVersion(options.maxVersion ?? MAX_VERSION);
  if (minVersion > maxVersion) throw new Error("minVersion must be <= maxVersion.");
  const forcedMask = options.mask ?? null;
  if (forcedMask !== null && (!Number.isInteger(forcedMask) || forcedMask < 0 || forcedMask > 7)) {
    throw new Error("mask must be an integer between 0 and 7.");
  }

  const payload = new TextEncoder().encode(String(text));
  const version = pickVersion(payload.length, ecc, minVersion, maxVersion);
  const dataCodewords = buildDataCodewords(payload, version, ecc);
  const codewords = interleaveWithEcc(dataCodewords, version, ecc);
  return renderMatrix({ codewords, version, ecc, forcedMask });
}

/** Smallest version that can hold `byteLength` bytes in byte mode at `ecc`. */
export function pickVersion(byteLength, ecc, minVersion = MIN_VERSION, maxVersion = MAX_VERSION) {
  const level = resolveEcc(ecc);
  for (let version = minVersion; version <= maxVersion; version += 1) {
    const capacityBits = numDataCodewords(version, level) * 8;
    const usedBits = 4 + charCountBits(version) + byteLength * 8;
    if (usedBits <= capacityBits) return version;
  }
  throw new Error(`Payload of ${byteLength} bytes does not fit in a version ${maxVersion} QR code at level ${level.name}.`);
}

/** Byte-mode capacity, in bytes, of a given version + ecc level. */
export function byteCapacity(version, ecc) {
  const level = resolveEcc(ecc);
  const bits = numDataCodewords(clampVersion(version), level) * 8 - 4 - charCountBits(version);
  return Math.floor(bits / 8);
}

/**
 * Renders a QR code as a standalone SVG document string.
 *
 * @param {QrCode|string} input
 * @param {{scale?: number, border?: number, dark?: string, light?: string,
 *          title?: string, id?: string, xmlDeclaration?: boolean, ecc?: string}} [options]
 */
export function renderQrSvg(input, options = {}) {
  const qr = input instanceof QrCode ? input : encodeQr(input, options);
  const scale = positiveNumber(options.scale ?? 4, "scale");
  const border = nonNegativeInteger(options.border ?? 4, "border");
  const dark = options.dark ?? "#000000";
  const light = options.light ?? "#ffffff";
  const dimension = (qr.size + border * 2) * scale;

  const parts = [];
  for (let y = 0; y < qr.size; y += 1) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.get(x, y)) {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < qr.size && qr.get(x + run, y)) run += 1;
      parts.push(`M${(x + border) * scale} ${(y + border) * scale}h${run * scale}v${scale}h-${run * scale}z`);
      x += run;
    }
  }

  const title = options.title ? `<title>${escapeXml(options.title)}</title>` : "";
  const idAttr = options.id ? ` id="${escapeXml(options.id)}"` : "";
  const declaration = options.xmlDeclaration === false ? "" : '<?xml version="1.0" encoding="UTF-8"?>\n';
  return [
    `${declaration}<svg xmlns="http://www.w3.org/2000/svg" version="1.1"${idAttr} `
      + `width="${dimension}" height="${dimension}" viewBox="0 0 ${dimension} ${dimension}" `
      + `shape-rendering="crispEdges" role="img">`,
    title,
    `<rect width="${dimension}" height="${dimension}" fill="${escapeXml(light)}"/>`,
    `<path d="${parts.join("")}" fill="${escapeXml(dark)}"/>`,
    "</svg>",
    "",
  ].filter((line) => line !== "").join("\n");
}

/**
 * Renders a QR code for a terminal.
 *
 * styles:
 *  - "half"  (default) one column per module, two module rows per text row
 *  - "block" two columns per module, one module row per text row
 *  - "ascii" two "#" columns per dark module (no Unicode required)
 *
 * `ansi: true` forces black-on-white via SGR colors so the code still scans in a
 * dark terminal; without it the caller must guarantee a light background.
 */
export function renderQrAscii(input, options = {}) {
  const qr = input instanceof QrCode ? input : encodeQr(input, options);
  const style = options.style ?? "half";
  const border = nonNegativeInteger(options.border ?? 4, "border");
  const ansi = options.ansi === true;
  const total = qr.size + border * 2;
  const dark = (x, y) => qr.get(x - border, y - border);
  const open = ansi ? "\u001b[30;47m" : "";
  const close = ansi ? "\u001b[0m" : "";
  const lines = [];

  if (style === "half") {
    for (let y = 0; y < total; y += 2) {
      let line = "";
      for (let x = 0; x < total; x += 1) {
        const top = dark(x, y);
        const bottom = y + 1 < total ? dark(x, y + 1) : false;
        if (top && bottom) line += "█";
        else if (top) line += "▀";
        else if (bottom) line += "▄";
        else line += " ";
      }
      lines.push(`${open}${line}${close}`);
    }
    return `${lines.join("\n")}\n`;
  }

  const darkCell = style === "ascii" ? "##" : "██";
  const lightCell = "  ";
  for (let y = 0; y < total; y += 1) {
    let line = "";
    for (let x = 0; x < total; x += 1) line += dark(x, y) ? darkCell : lightCell;
    lines.push(`${open}${line}${close}`);
  }
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

function buildDataCodewords(payload, version, ecc) {
  const bits = [];
  appendBits(bits, 0b0100, 4); // byte mode
  appendBits(bits, payload.length, charCountBits(version));
  for (const byte of payload) appendBits(bits, byte, 8);

  const capacityBits = numDataCodewords(version, ecc) * 8;
  if (bits.length > capacityBits) throw new Error("Internal error: payload exceeds selected version capacity.");

  appendBits(bits, 0, Math.min(4, capacityBits - bits.length)); // terminator
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8); // byte align

  const codewords = new Uint8Array(capacityBits / 8);
  for (let index = 0; index < bits.length; index += 1) {
    if (bits[index]) codewords[index >>> 3] |= 0x80 >>> (index & 7);
  }
  for (let index = bits.length / 8, pad = 0xec; index < codewords.length; index += 1, pad ^= 0xec ^ 0x11) {
    codewords[index] = pad;
  }
  return codewords;
}

function interleaveWithEcc(data, version, ecc) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecc.ordinal][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc.ordinal][version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const generator = reedSolomonGenerator(blockEccLen);
  const blocks = [];
  for (let index = 0, offset = 0; index < numBlocks; index += 1) {
    const dataLen = shortBlockLen - blockEccLen + (index < numShortBlocks ? 0 : 1);
    const dataPart = data.subarray(offset, offset + dataLen);
    offset += dataLen;
    blocks.push({ data: dataPart, ecc: reedSolomonRemainder(dataPart, generator) });
  }

  const result = new Uint8Array(rawCodewords);
  let cursor = 0;
  for (let index = 0; index < shortBlockLen + 1; index += 1) {
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex];
      if (index < block.data.length) {
        result[cursor] = block.data[index];
        cursor += 1;
      }
    }
  }
  for (let index = 0; index < blockEccLen; index += 1) {
    for (const block of blocks) {
      result[cursor] = block.ecc[index];
      cursor += 1;
    }
  }
  if (cursor !== rawCodewords) throw new Error("Internal error: codeword interleaving produced the wrong length.");
  return result;
}

function reedSolomonGenerator(degree) {
  // Monic polynomial (x - a^0)(x - a^1)...(x - a^(degree-1)); leading 1 omitted.
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let position = 0; position < degree; position += 1) {
      result[position] = gfMultiply(result[position], root);
      if (position + 1 < degree) result[position] ^= result[position + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data, generator) {
  const degree = generator.length;
  const result = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[degree - 1] = 0;
    for (let index = 0; index < degree; index += 1) {
      result[index] ^= gfMultiply(generator[index], factor);
    }
  }
  return result;
}

function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/* ------------------------------------------------------------------ */
/* Matrix construction                                                 */
/* ------------------------------------------------------------------ */

function renderMatrix({ codewords, version, ecc, forcedMask }) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  drawTimingPatterns(size, set);
  drawFinderPattern(3, 3, size, set);
  drawFinderPattern(size - 4, 3, size, set);
  drawFinderPattern(3, size - 4, size, set);
  drawAlignmentPatterns(version, set);
  drawFormatBits(0, ecc, size, set); // placeholder, rewritten after mask selection
  drawVersionBits(version, size, set);
  drawCodewords(codewords, size, modules, isFunction);

  let mask = forcedMask;
  if (mask === null) {
    let bestPenalty = Infinity;
    for (let candidate = 0; candidate < 8; candidate += 1) {
      applyMask(candidate, size, modules, isFunction);
      drawFormatBits(candidate, ecc, size, set);
      const penalty = penaltyScore(modules, size);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        mask = candidate;
      }
      applyMask(candidate, size, modules, isFunction); // undo (XOR is an involution)
    }
  }
  applyMask(mask, size, modules, isFunction);
  drawFormatBits(mask, ecc, size, set);

  return new QrCode({ version, ecc: ecc.name, mask, modules });
}

function drawTimingPatterns(size, set) {
  for (let index = 0; index < size; index += 1) {
    set(6, index, index % 2 === 0);
    set(index, 6, index % 2 === 0);
  }
}

function drawFinderPattern(centerX, centerY, size, set) {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      const x = centerX + dx;
      const y = centerY + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      set(x, y, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignmentPatterns(version, set) {
  const positions = alignmentPatternPositions(version);
  const last = positions.length - 1;
  for (let i = 0; i <= last; i += 1) {
    for (let j = 0; j <= last; j += 1) {
      // Skip the three corners, which are occupied by finder patterns.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const centerX = positions[i];
      const centerY = positions[j];
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          set(centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
}

export function alignmentPatternPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let pos = version * 4 + 10; positions.length < count; pos -= step) positions.splice(1, 0, pos);
  return positions;
}

function drawFormatBits(mask, ecc, size, set) {
  const data = (ecc.formatBits << 3) | mask;
  let remainder = data;
  for (let index = 0; index < 10; index += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  const bits = ((data << 10) | remainder) ^ 0x5412;

  for (let index = 0; index <= 5; index += 1) set(8, index, getBit(bits, index));
  set(8, 7, getBit(bits, 6));
  set(8, 8, getBit(bits, 7));
  set(7, 8, getBit(bits, 8));
  for (let index = 9; index < 15; index += 1) set(14 - index, 8, getBit(bits, index));

  for (let index = 0; index < 8; index += 1) set(size - 1 - index, 8, getBit(bits, index));
  for (let index = 8; index < 15; index += 1) set(8, size - 15 + index, getBit(bits, index));
  set(8, size - 8, true); // always-dark module
}

function drawVersionBits(version, size, set) {
  if (version < 7) return;
  let remainder = version;
  for (let index = 0; index < 12; index += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  const bits = (version << 12) | remainder;
  for (let index = 0; index < 18; index += 1) {
    const bit = getBit(bits, index);
    const a = size - 11 + (index % 3);
    const b = Math.floor(index / 3);
    set(a, b, bit);
    set(b, a, bit);
  }
}

function drawCodewords(codewords, size, modules, isFunction) {
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (isFunction[y][x] || bitIndex >= codewords.length * 8) continue;
        modules[y][x] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
        bitIndex += 1;
      }
    }
  }
  if (bitIndex !== codewords.length * 8) throw new Error("Internal error: not all codeword bits were placed.");
}

function applyMask(mask, size, modules, isFunction) {
  const predicate = MASK_PREDICATES[mask];
  if (!predicate) throw new Error(`Unknown mask ${mask}.`);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (isFunction[y][x]) continue;
      if (predicate(x, y)) modules[y][x] = !modules[y][x];
    }
  }
}

const MASK_PREDICATES = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function penaltyScore(modules, size) {
  let score = 0;

  // Rule 1: runs of five or more same-colour modules in a row/column.
  for (let y = 0; y < size; y += 1) {
    score += lineRunPenalty((index) => modules[y][index], size);
  }
  for (let x = 0; x < size; x += 1) {
    score += lineRunPenalty((index) => modules[index][x], size);
  }

  // Rule 2: 2x2 blocks of the same colour.
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const value = modules[y][x];
      if (value === modules[y][x + 1] && value === modules[y + 1][x] && value === modules[y + 1][x + 1]) {
        score += PENALTY_N2;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules beside them.
  for (let y = 0; y < size; y += 1) {
    score += finderLikePenalty((index) => modules[y][index], size);
  }
  for (let x = 0; x < size; x += 1) {
    score += finderLikePenalty((index) => modules[index][x], size);
  }

  // Rule 4: deviation of the dark module ratio from 50%.
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) if (modules[y][x]) dark += 1;
  }
  const total = size * size;
  const deviation = Math.floor(Math.abs(dark * 20 - total * 10) / total);
  score += deviation * PENALTY_N4;

  return score;
}

function lineRunPenalty(at, size) {
  let score = 0;
  let runColor = at(0);
  let runLength = 1;
  for (let index = 1; index < size; index += 1) {
    const value = at(index);
    if (value === runColor) {
      runLength += 1;
      continue;
    }
    if (runLength >= 5) score += PENALTY_N1 + (runLength - 5);
    runColor = value;
    runLength = 1;
  }
  if (runLength >= 5) score += PENALTY_N1 + (runLength - 5);
  return score;
}

const FINDER_LIKE = [true, false, true, true, true, false, true];

function finderLikePenalty(at, size) {
  let score = 0;
  for (let index = 0; index + 7 <= size; index += 1) {
    let matches = true;
    for (let offset = 0; offset < 7; offset += 1) {
      if (at(index + offset) !== FINDER_LIKE[offset]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (allLight(at, index - 4, 4, size) || allLight(at, index + 7, 4, size)) score += PENALTY_N3;
  }
  return score;
}

function allLight(at, start, length, size) {
  if (start < 0 || start + length > size) return false;
  for (let index = start; index < start + length; index += 1) if (at(index)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Capacity helpers                                                    */
/* ------------------------------------------------------------------ */

function numRawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version, ecc) {
  return (
    Math.floor(numRawDataModules(version) / 8)
    - ECC_CODEWORDS_PER_BLOCK[ecc.ordinal][version] * NUM_ERROR_CORRECTION_BLOCKS[ecc.ordinal][version]
  );
}

function charCountBits(version) {
  return version <= 9 ? 8 : 16; // byte mode
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function appendBits(bits, value, length) {
  for (let index = length - 1; index >= 0; index -= 1) bits.push(((value >>> index) & 1) === 1);
}

function getBit(value, index) {
  return ((value >>> index) & 1) !== 0;
}

function resolveEcc(ecc) {
  if (ecc && typeof ecc === "object" && typeof ecc.ordinal === "number") return ecc;
  const level = ECC_LEVELS[String(ecc).toUpperCase()];
  if (!level) throw new Error(`Unknown error correction level "${ecc}". Use L, M, Q or H.`);
  return level;
}

function clampVersion(version) {
  const parsed = Number.parseInt(String(version), 10);
  if (!Number.isFinite(parsed) || parsed < MIN_VERSION || parsed > MAX_VERSION) {
    throw new Error(`Version must be between ${MIN_VERSION} and ${MAX_VERSION}.`);
  }
  return parsed;
}

function positiveNumber(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${field} must be a positive number.`);
  return parsed;
}

function nonNegativeInteger(value, field) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative integer.`);
  return parsed;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

export const QR_ECC_LEVELS = Object.freeze(Object.keys(ECC_LEVELS));
