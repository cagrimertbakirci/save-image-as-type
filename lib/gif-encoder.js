// Minimal single-frame GIF encoder
// Input: RGBA Uint8ClampedArray, width, height
// Output: Uint8Array of GIF file bytes

function encodeGIF(rgba, width, height) {
  // --- Color Quantization (popularity-based) ---
  const colorCounts = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    // Reduce to 5 bits per channel for grouping
    const r = rgba[i] >> 3;
    const g = rgba[i + 1] >> 3;
    const b = rgba[i + 2] >> 3;
    const key = (r << 10) | (g << 5) | b;
    colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
  }

  // Get top 256 colors
  const sorted = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]);
  const palette = [];
  const paletteMap = new Map();
  for (let i = 0; i < Math.min(256, sorted.length); i++) {
    const key = sorted[i][0];
    const r = ((key >> 10) & 0x1f) << 3;
    const g = ((key >> 5) & 0x1f) << 3;
    const b = (key & 0x1f) << 3;
    palette.push(r, g, b);
    paletteMap.set(key, i);
  }

  // Pad palette to 256 entries
  while (palette.length < 256 * 3) palette.push(0);

  // Map pixels to palette indices
  const indices = new Uint8Array(width * height);
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i] >> 3;
    const g = rgba[i + 1] >> 3;
    const b = rgba[i + 2] >> 3;
    const key = (r << 10) | (g << 5) | b;
    if (paletteMap.has(key)) {
      indices[i / 4] = paletteMap.get(key);
    } else {
      // Find nearest palette entry
      let bestDist = Infinity;
      let bestIdx = 0;
      for (let j = 0; j < 256; j++) {
        const pr = palette[j * 3] >> 3;
        const pg = palette[j * 3 + 1] >> 3;
        const pb = palette[j * 3 + 2] >> 3;
        const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = j;
        }
      }
      indices[i / 4] = bestIdx;
    }
  }

  // --- LZW Encoding ---
  const minCodeSize = 8;
  const lzwOutput = lzwEncode(indices, minCodeSize);

  // --- Build GIF File ---
  const buf = [];
  const write = (bytes) => buf.push(...bytes);
  const writeU16 = (v) => buf.push(v & 0xff, (v >> 8) & 0xff);

  // Header
  write([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a

  // Logical Screen Descriptor
  writeU16(width);
  writeU16(height);
  write([0xf7]); // GCT flag, 8 bits color resolution, 256 colors
  write([0x00]); // Background color index
  write([0x00]); // Pixel aspect ratio

  // Global Color Table (256 * 3 bytes)
  write(palette);

  // Image Descriptor
  write([0x2c]); // Image separator
  writeU16(0); // Left
  writeU16(0); // Top
  writeU16(width);
  writeU16(height);
  write([0x00]); // No local color table

  // Image Data
  write([minCodeSize]); // LZW minimum code size

  // Write LZW data in sub-blocks (max 255 bytes each)
  let offset = 0;
  while (offset < lzwOutput.length) {
    const chunkSize = Math.min(255, lzwOutput.length - offset);
    write([chunkSize]);
    write(lzwOutput.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
  write([0x00]); // Block terminator

  // Trailer
  write([0x3b]);

  return new Uint8Array(buf);
}

function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  const output = [];
  let buffer = 0;
  let bufferBits = 0;

  function emit(code) {
    buffer |= code << bufferBits;
    bufferBits += codeSize;
    while (bufferBits >= 8) {
      output.push(buffer & 0xff);
      buffer >>= 8;
      bufferBits -= 8;
    }
  }

  // Initialize code table
  let table = new Map();
  function resetTable() {
    table = new Map();
    for (let i = 0; i < clearCode; i++) {
      table.set(String(i), i);
    }
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
  }

  resetTable();
  emit(clearCode);

  let current = String(indices[0]);

  for (let i = 1; i < indices.length; i++) {
    const next = current + "," + indices[i];
    if (table.has(next)) {
      current = next;
    } else {
      emit(table.get(current));
      if (nextCode < 4096) {
        table.set(next, nextCode++);
        if (nextCode > (1 << codeSize) && codeSize < 12) {
          codeSize++;
        }
      } else {
        emit(clearCode);
        resetTable();
      }
      current = String(indices[i]);
    }
  }

  emit(table.get(current));
  emit(eoiCode);

  // Flush remaining bits
  if (bufferBits > 0) {
    output.push(buffer & 0xff);
  }

  return output;
}
