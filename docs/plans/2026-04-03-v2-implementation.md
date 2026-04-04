# v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use subagent-driven-development-enhanced to implement this plan with automatic parallel dispatch.

**Goal:** Implement the full v2 design — 8 output formats, dynamic context menus, options page, clipboard support, batch save, and notification feedback.

**Architecture:** Chrome extension (Manifest V3) with no build step. Service worker orchestrates; offscreen document handles all canvas/encoding; content script captures modifier keys and scans pages; options page manages settings via `chrome.storage.sync`.

**Tech Stack:** Vanilla JS, Chrome Extensions API (MV3), UTIF.js (existing), inline BMP/ICO/GIF encoders.

---

## Shared Contracts

All tasks reference these contracts. Do NOT deviate from them.

### Settings Schema

```js
const DEFAULT_SETTINGS = {
  formats: [
    { id: "png",  label: "PNG",  visible: true, topLevel: true  },
    { id: "jpg",  label: "JPG",  visible: true, topLevel: true,  quality: 92 },
    { id: "tiff", label: "TIFF", visible: true, topLevel: true,  compression: "deflate" },
    { id: "webp", label: "WebP", visible: true, topLevel: false, quality: 90 },
    { id: "avif", label: "AVIF", visible: true, topLevel: false, quality: 80 },
    { id: "bmp",  label: "BMP",  visible: true, topLevel: false },
    { id: "ico",  label: "ICO",  visible: true, topLevel: false, size: 256 },
    { id: "gif",  label: "GIF",  visible: true, topLevel: false },
  ],
  transparency: { bgColor: "#ffffff" },
  notifications: {
    showSuccessBadge: true,
    showErrorNotifications: true,
    defaultAction: "save",
  },
};
```

Array order = display order. `topLevel: true` means shown directly in menu; `false` means inside "Others" submenu. The `formats` array is ordered by user preference (drag-to-reorder in options page).

### Message Protocol: background ↔ offscreen

```js
// Request (background → offscreen)
{
  target: "offscreen",
  action: "convert",
  imageUrl: "https://...",
  format: "png", // png|jpg|webp|avif|tiff|bmp|ico|gif
  settings: {
    quality: 0.92,           // 0-1, for jpg/webp/avif
    bgColor: "#ffffff",      // for formats without alpha (jpg, bmp)
    compression: "deflate",  // for tiff: "none"|"lzw"|"deflate"
    size: 256,               // for ico: 16|32|48|64|128|256
  }
}

// Response (offscreen → background via sendResponse)
"data:image/png;base64,..."   // success: data URL string
{ error: "Failed to fetch" }  // failure: object with error key
```

### Message Protocol: content ↔ background

```js
// Modifier state (content → background, sent on every contextmenu event)
{
  target: "background",
  action: "modifierState",
  shiftKey: true,
}

// Scan request (background → content via chrome.tabs.sendMessage)
{
  target: "content",
  action: "scanImages",
}

// Scan response (content → background via sendResponse)
["https://example.com/img1.png", "https://example.com/img2.jpg", ...]
```

### Context Menu ID Scheme

```
save-{format}        → e.g. "save-png", "save-webp"
copy-{format}        → e.g. "copy-png", "copy-jpg"
batch-{format}       → e.g. "batch-png", "batch-tiff"
save-image-as        → parent for Save Image As...
copy-image-as        → parent for Copy Image As...
batch-save           → parent for Save All Images As...
save-others          → parent for Others submenu under save
copy-others          → parent for Others submenu under copy
batch-others         → parent for Others submenu under batch
customize            → opens options page
```

Parse with: `const [action, format] = menuItemId.split("-", 2)` — but note `action` is the prefix before the first hyphen. Actually, use a lookup approach:

```js
function parseMenuItemId(id) {
  if (id.startsWith("save-") && id !== "save-image-as" && id !== "save-others") {
    return { action: "save", format: id.slice(5) };
  }
  if (id.startsWith("copy-") && id !== "copy-image-as" && id !== "copy-others") {
    return { action: "copy", format: id.slice(5) };
  }
  if (id.startsWith("batch-") && id !== "batch-save" && id !== "batch-others") {
    return { action: "batch", format: id.slice(6) };
  }
  return null;
}
```

---

## Parallelization Analysis

### Dependency Graph

```
Task 1: manifest.json + lib/defaults.js (independent)
Task 2: offscreen.js + offscreen.html + lib/gif-encoder.js (independent)
Task 3: content.js (independent)
Task 4: options.html + options.js (depends on Task 1 for lib/defaults.js)
Task 5: background.js (depends on Tasks 1, 2, 3, 4)
```

### Execution Strategy

| Batch | Tasks | Rationale |
|-------|-------|-----------|
| 1 | 1, 2, 3 | Independent, no shared files |
| 2 | 4 | Needs lib/defaults.js from Task 1 |
| 3 | 5 | Orchestrates all other components |

### Parallel Safety Notes
- Tasks 1, 2, 3 touch completely different files — safe to parallelize
- Task 4 creates new files (options.html, options.js) but references lib/defaults.js created by Task 1
- Task 5 rewrites background.js and depends on all other tasks' message contracts being implemented

---

## Task 1: Manifest + Shared Defaults

**Dependencies:** None
**Can parallelize with:** Tasks 2, 3

**Files:**
- Modify: `manifest.json`
- Create: `lib/defaults.js`

### Step 1: Update manifest.json

Replace the entire file with:

```json
{
  "manifest_version": 3,
  "name": "Save Image as Any Type",
  "version": "2.0.0",
  "description": "Right-click any image to save or copy it as PNG, JPG, WebP, AVIF, TIFF, BMP, ICO, or GIF",
  "permissions": [
    "contextMenus",
    "downloads",
    "offscreen",
    "storage",
    "notifications",
    "clipboardWrite",
    "scripting"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "options_page": "options.html",
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_start"
    }
  ],
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

### Step 2: Create lib/defaults.js

This file is loaded by background.js (via importScripts), options.js (via script tag), and defines the shared settings schema.

```js
// Shared default settings — loaded by background.js and options.js
const DEFAULT_SETTINGS = {
  formats: [
    { id: "png",  label: "PNG",  visible: true, topLevel: true  },
    { id: "jpg",  label: "JPG",  visible: true, topLevel: true,  quality: 92 },
    { id: "tiff", label: "TIFF", visible: true, topLevel: true,  compression: "deflate" },
    { id: "webp", label: "WebP", visible: true, topLevel: false, quality: 90 },
    { id: "avif", label: "AVIF", visible: true, topLevel: false, quality: 80 },
    { id: "bmp",  label: "BMP",  visible: true, topLevel: false },
    { id: "ico",  label: "ICO",  visible: true, topLevel: false, size: 256 },
    { id: "gif",  label: "GIF",  visible: true, topLevel: false },
  ],
  transparency: { bgColor: "#ffffff" },
  notifications: {
    showSuccessBadge: true,
    showErrorNotifications: true,
    defaultAction: "save",
  },
};

// Load settings from storage, falling back to defaults
async function loadSettings() {
  const stored = await chrome.storage.sync.get("settings");
  if (!stored.settings) return structuredClone(DEFAULT_SETTINGS);

  // Merge with defaults to handle new fields added in updates
  const settings = structuredClone(DEFAULT_SETTINGS);
  const s = stored.settings;

  if (Array.isArray(s.formats)) {
    // Preserve user's format order and settings, add any new formats
    const userIds = new Set(s.formats.map((f) => f.id));
    settings.formats = s.formats.map((uf) => {
      const def = DEFAULT_SETTINGS.formats.find((d) => d.id === uf.id);
      return def ? { ...def, ...uf } : uf;
    });
    // Append any new default formats the user doesn't have yet
    for (const def of DEFAULT_SETTINGS.formats) {
      if (!userIds.has(def.id)) settings.formats.push(structuredClone(def));
    }
  }

  if (s.transparency) Object.assign(settings.transparency, s.transparency);
  if (s.notifications) Object.assign(settings.notifications, s.notifications);

  return settings;
}

// Save settings to storage
async function saveSettings(settings) {
  await chrome.storage.sync.set({ settings });
}
```

### Step 3: Verify

Load the extension in Chrome. It should install without errors. Check `chrome://extensions` for any manifest warnings.

### Step 4: Commit

```
git add manifest.json lib/defaults.js
git commit -m "Add v2 manifest permissions and shared settings defaults"
```

---

## Task 2: Format Encoders (offscreen.js + offscreen.html)

**Dependencies:** None
**Can parallelize with:** Tasks 1, 3

**Files:**
- Modify: `offscreen.js` (rewrite)
- Modify: `offscreen.html` (add gif-encoder.js script tag)
- Create: `lib/gif-encoder.js`

### Step 1: Create lib/gif-encoder.js

Minimal single-frame GIF encoder. Takes RGBA pixel data, quantizes to 256 colors, produces GIF binary.

```js
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
```

### Step 2: Update offscreen.html

```html
<!DOCTYPE html>
<html>
<head>
  <title>Save Image as Any Type - Offscreen</title>
</head>
<body>
  <script src="lib/UTIF.js"></script>
  <script src="lib/gif-encoder.js"></script>
  <script src="offscreen.js"></script>
</body>
</html>
```

### Step 3: Rewrite offscreen.js

Replace the entire file. The new version accepts settings via the message protocol, supports all 8 formats, and handles clipboard operations.

```js
// Signal to background that scripts are loaded and ready
chrome.runtime.sendMessage({ target: "background", action: "ready" });

// Listen for conversion requests from background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return;

  if (message.action === "convert") {
    convertImage(message.imageUrl, message.format, message.settings || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "copyToClipboard") {
    copyDataUrlToClipboard(message.dataUrl)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function convertImage(imageUrl, format, settings) {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }
  const blob = await response.blob();
  const img = await loadImage(blob);

  let canvas = document.createElement("canvas");
  let width = img.naturalWidth;
  let height = img.naturalHeight;

  // For ICO, resize to target size
  if (format === "ico") {
    const targetSize = settings.size || 256;
    canvas.width = targetSize;
    canvas.height = targetSize;
  } else {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");

  // Fill background for formats without alpha support
  if (format === "jpg" || format === "bmp") {
    ctx.fillStyle = settings.bgColor || "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Revoke the object URL to prevent memory leak
  URL.revokeObjectURL(img.src);

  switch (format) {
    case "png":
      return canvas.toDataURL("image/png");

    case "jpg": {
      const q = (settings.quality || 92) / 100;
      return canvas.toDataURL("image/jpeg", q);
    }

    case "webp": {
      const q = (settings.quality || 90) / 100;
      return canvas.toDataURL("image/webp", q);
    }

    case "avif": {
      const q = (settings.quality || 80) / 100;
      const dataUrl = canvas.toDataURL("image/avif", q);
      // Chrome returns PNG if AVIF not supported — detect and error
      if (dataUrl.startsWith("data:image/png")) {
        throw new Error("AVIF encoding not supported in this browser");
      }
      return dataUrl;
    }

    case "tiff":
      return canvasToTiffDataUrl(ctx, canvas.width, canvas.height, settings.compression);

    case "bmp":
      return canvasToBmpDataUrl(ctx, canvas.width, canvas.height);

    case "ico":
      return canvasToIcoDataUrl(canvas);

    case "gif":
      return canvasToGifDataUrl(ctx, canvas.width, canvas.height);

    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = URL.createObjectURL(blob);
  });
}

// --- TIFF Encoder (via UTIF.js) ---

function canvasToTiffDataUrl(ctx, width, height, compression) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const rgba = imageData.data;
  const tiffBuffer = UTIF.encodeImage(rgba, width, height);
  return arrayBufferToDataUrl(tiffBuffer, "image/tiff");
}

// --- BMP Encoder ---

function canvasToBmpDataUrl(ctx, width, height) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const rgba = imageData.data;

  const rowSize = Math.ceil((width * 3) / 4) * 4; // rows padded to 4 bytes
  const pixelDataSize = rowSize * height;
  const fileSize = 14 + 40 + pixelDataSize; // file header + info header + pixels

  const buf = new ArrayBuffer(fileSize);
  const view = new DataView(buf);

  // BITMAPFILEHEADER (14 bytes)
  view.setUint8(0, 0x42); // 'B'
  view.setUint8(1, 0x4d); // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint32(6, 0, true); // reserved
  view.setUint32(10, 54, true); // pixel data offset

  // BITMAPINFOHEADER (40 bytes)
  view.setUint32(14, 40, true); // header size
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positive = bottom-to-top
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 24, true); // bits per pixel (BGR)
  view.setUint32(30, 0, true); // compression (none)
  view.setUint32(34, pixelDataSize, true);
  view.setUint32(38, 2835, true); // X pixels per meter (~72 DPI)
  view.setUint32(42, 2835, true); // Y pixels per meter
  view.setUint32(46, 0, true); // colors used
  view.setUint32(50, 0, true); // important colors

  // Pixel data (BGR, bottom-to-top)
  const pixels = new Uint8Array(buf, 54);
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width; // BMP is bottom-to-top
    const dstRow = y * rowSize;
    for (let x = 0; x < width; x++) {
      const srcIdx = (srcRow + x) * 4;
      const dstIdx = dstRow + x * 3;
      pixels[dstIdx] = rgba[srcIdx + 2];     // B
      pixels[dstIdx + 1] = rgba[srcIdx + 1]; // G
      pixels[dstIdx + 2] = rgba[srcIdx];     // R
    }
  }

  return arrayBufferToDataUrl(buf, "image/bmp");
}

// --- ICO Encoder (PNG-in-ICO) ---

function canvasToIcoDataUrl(canvas) {
  // Get PNG data from canvas
  const pngDataUrl = canvas.toDataURL("image/png");
  const pngBase64 = pngDataUrl.split(",")[1];
  const pngBytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));

  const size = canvas.width; // already resized to target ICO size

  // ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes) + PNG data
  const fileSize = 6 + 16 + pngBytes.length;
  const buf = new ArrayBuffer(fileSize);
  const view = new DataView(buf);

  // ICONDIR
  view.setUint16(0, 0, true);  // reserved
  view.setUint16(2, 1, true);  // type: 1 = icon
  view.setUint16(4, 1, true);  // count: 1 image

  // ICONDIRENTRY
  view.setUint8(6, size >= 256 ? 0 : size);  // width (0 = 256)
  view.setUint8(7, size >= 256 ? 0 : size);  // height (0 = 256)
  view.setUint8(8, 0);   // color palette count
  view.setUint8(9, 0);   // reserved
  view.setUint16(10, 1, true);  // color planes
  view.setUint16(12, 32, true); // bits per pixel
  view.setUint32(14, pngBytes.length, true); // image size
  view.setUint32(18, 22, true); // offset to image data (6 + 16)

  // PNG data
  new Uint8Array(buf, 22).set(pngBytes);

  return arrayBufferToDataUrl(buf, "image/x-icon");
}

// --- GIF Encoder (via lib/gif-encoder.js) ---

function canvasToGifDataUrl(ctx, width, height) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const gifBytes = encodeGIF(imageData.data, width, height);
  return arrayBufferToDataUrl(gifBytes.buffer, "image/gif");
}

// --- Clipboard ---

async function copyDataUrlToClipboard(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();

  // Clipboard API supports PNG natively; for other formats, convert to PNG first
  let clipboardBlob = blob;
  if (blob.type !== "image/png") {
    const img = await loadImage(blob);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(img.src);
    clipboardBlob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );
  }

  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": clipboardBlob }),
  ]);
}

// --- Utility ---

function arrayBufferToDataUrl(buffer, mimeType) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}
```

### Step 4: Verify

Load extension, right-click an image, test each format conversion. Verify the offscreen document loads without errors (check service worker console).

### Step 5: Commit

```
git add offscreen.js offscreen.html lib/gif-encoder.js
git commit -m "Add 5 new format encoders and clipboard support in offscreen"
```

---

## Task 3: Content Script

**Dependencies:** None
**Can parallelize with:** Tasks 1, 2

**Files:**
- Create: `content.js`

### Step 1: Create content.js

```js
// Capture modifier key state on right-click
// This fires BEFORE the browser context menu appears
document.addEventListener("contextmenu", (e) => {
  chrome.runtime.sendMessage({
    target: "background",
    action: "modifierState",
    shiftKey: e.shiftKey,
  });
});

// Listen for image scan requests from background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "content" || message.action !== "scanImages") return;

  const urls = scanPageForImages();
  sendResponse(urls);
  return true;
});

function scanPageForImages() {
  const urls = new Set();

  // <img> elements
  document.querySelectorAll("img[src]").forEach((img) => {
    if (img.naturalWidth > 10 && img.naturalHeight > 10) {
      urls.add(img.src);
    }
  });

  // <picture> <source> elements
  document.querySelectorAll("picture source[srcset]").forEach((source) => {
    // srcset can have multiple URLs with descriptors
    const parts = source.srcset.split(",");
    for (const part of parts) {
      const url = part.trim().split(/\s+/)[0];
      if (url) {
        try {
          urls.add(new URL(url, document.baseURI).href);
        } catch { /* invalid URL, skip */ }
      }
    }
  });

  // CSS background-image (visible elements only)
  document.querySelectorAll("*").forEach((el) => {
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== "none") {
      const match = bg.match(/url\(["']?(.*?)["']?\)/);
      if (match && match[1]) {
        try {
          const url = new URL(match[1], document.baseURI).href;
          // Skip data URLs and gradients
          if (url.startsWith("http")) urls.add(url);
        } catch { /* invalid URL, skip */ }
      }
    }
  });

  return [...urls];
}
```

### Step 2: Verify

Load extension. Open any web page. Open the page's DevTools console and check that no content script errors appear. Right-click and verify the contextmenu event fires (check background console for modifierState message).

### Step 3: Commit

```
git add content.js
git commit -m "Add content script for modifier key capture and image scanning"
```

---

## Task 4: Options Page

**Dependencies:** Task 1 (needs lib/defaults.js)
**Can parallelize with:** None in its batch

**Files:**
- Create: `options.html`
- Create: `options.js`

### Step 1: Create options.html

```html
<!DOCTYPE html>
<html>
<head>
  <title>Save Image as Any Type — Settings</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 600px;
      margin: 0 auto;
      padding: 24px;
      color: #202124;
      background: #fff;
    }
    h1 { font-size: 22px; margin-bottom: 24px; }
    h2 {
      font-size: 15px;
      font-weight: 600;
      color: #5f6368;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin: 32px 0 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid #e0e0e0;
    }

    /* Format list */
    .format-list { list-style: none; }
    .format-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 8px;
      border-bottom: 1px solid #f0f0f0;
      cursor: grab;
    }
    .format-item:active { cursor: grabbing; }
    .format-item.dragging { opacity: 0.4; }
    .format-item.drag-over { border-top: 2px solid #1a73e8; }
    .drag-handle {
      color: #bbb;
      cursor: grab;
      font-size: 16px;
      user-select: none;
    }
    .format-label { font-weight: 500; min-width: 50px; }
    .format-controls { display: flex; align-items: center; gap: 12px; flex: 1; }
    .format-settings {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: #5f6368;
    }
    .format-settings input[type="range"] { width: 100px; }
    .format-settings select { padding: 2px 4px; }

    /* Placement toggle */
    .placement-toggle {
      font-size: 12px;
      padding: 3px 8px;
      border: 1px solid #dadce0;
      border-radius: 12px;
      background: #f8f9fa;
      cursor: pointer;
      user-select: none;
    }
    .placement-toggle.top-level {
      background: #e8f0fe;
      border-color: #1a73e8;
      color: #1a73e8;
    }

    /* Toggle switch */
    .toggle { position: relative; display: inline-block; width: 36px; height: 20px; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle .slider {
      position: absolute; inset: 0;
      background: #dadce0; border-radius: 10px;
      cursor: pointer; transition: background 0.2s;
    }
    .toggle .slider::before {
      content: "";
      position: absolute; left: 2px; top: 2px;
      width: 16px; height: 16px;
      background: #fff; border-radius: 50%;
      transition: transform 0.2s;
    }
    .toggle input:checked + .slider { background: #1a73e8; }
    .toggle input:checked + .slider::before { transform: translateX(16px); }

    /* Transparency section */
    .color-presets { display: flex; gap: 8px; margin-top: 8px; }
    .color-preset {
      width: 32px; height: 32px;
      border: 2px solid #dadce0; border-radius: 4px;
      cursor: pointer;
    }
    .color-preset.active { border-color: #1a73e8; }
    .color-preset.white { background: #fff; }
    .color-preset.black { background: #000; }
    .color-custom { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    input[type="color"] { width: 32px; height: 32px; border: none; padding: 0; cursor: pointer; }

    /* Notifications section */
    .setting-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid #f0f0f0;
    }
    .setting-row label { font-size: 14px; }
    select.action-select { padding: 4px 8px; border: 1px solid #dadce0; border-radius: 4px; }

    /* Tip box */
    .tip {
      margin-top: 16px;
      padding: 12px;
      background: #fef7e0;
      border-radius: 8px;
      font-size: 13px;
      color: #5f6368;
    }
    .tip strong { color: #202124; }

    /* Save status */
    .save-status {
      position: fixed; bottom: 24px; right: 24px;
      padding: 8px 16px;
      background: #1a73e8; color: #fff;
      border-radius: 8px;
      font-size: 13px;
      opacity: 0;
      transition: opacity 0.3s;
    }
    .save-status.visible { opacity: 1; }
  </style>
</head>
<body>
  <h1>Save Image as Any Type</h1>

  <h2>Formats</h2>
  <ul class="format-list" id="formatList"></ul>

  <h2>Transparency Background</h2>
  <p style="font-size: 13px; color: #5f6368; margin-bottom: 8px;">
    Used when saving as JPG or BMP (formats without transparency).
  </p>
  <div class="color-presets" id="colorPresets">
    <div class="color-preset white" data-color="#ffffff" title="White"></div>
    <div class="color-preset black" data-color="#000000" title="Black"></div>
  </div>
  <div class="color-custom">
    <input type="color" id="customColor" value="#ffffff">
    <span id="colorHex" style="font-size: 13px; color: #5f6368;">#ffffff</span>
  </div>

  <h2>Notifications</h2>
  <div class="setting-row">
    <label>Show success badge</label>
    <label class="toggle">
      <input type="checkbox" id="showSuccessBadge">
      <span class="slider"></span>
    </label>
  </div>
  <div class="setting-row">
    <label>Show error notifications</label>
    <label class="toggle">
      <input type="checkbox" id="showErrorNotifications">
      <span class="slider"></span>
    </label>
  </div>
  <div class="setting-row">
    <label>Default action</label>
    <select class="action-select" id="defaultAction">
      <option value="save">Save to disk</option>
      <option value="clipboard">Copy to clipboard</option>
    </select>
  </div>

  <div class="tip">
    <strong>Tip:</strong> Hold <strong>Shift</strong> while clicking any format to quickly switch
    between save and copy.
  </div>

  <div class="save-status" id="saveStatus">Settings saved</div>

  <script src="lib/defaults.js"></script>
  <script src="options.js"></script>
</body>
</html>
```

### Step 2: Create options.js

```js
let currentSettings = null;

document.addEventListener("DOMContentLoaded", async () => {
  currentSettings = await loadSettings();
  renderFormats();
  renderTransparency();
  renderNotifications();
});

// --- Format List ---

function renderFormats() {
  const list = document.getElementById("formatList");
  list.innerHTML = "";

  currentSettings.formats.forEach((fmt, index) => {
    const li = document.createElement("li");
    li.className = "format-item";
    li.draggable = true;
    li.dataset.index = index;

    li.innerHTML = `
      <span class="drag-handle">⠿</span>
      <label class="toggle">
        <input type="checkbox" data-field="visible" ${fmt.visible ? "checked" : ""}>
        <span class="slider"></span>
      </label>
      <span class="format-label">${fmt.label}</span>
      <div class="format-controls">
        <span class="placement-toggle ${fmt.topLevel ? "top-level" : ""}"
              data-field="topLevel">
          ${fmt.topLevel ? "Top level" : "Others"}
        </span>
        <div class="format-settings">
          ${renderFormatSettings(fmt)}
        </div>
      </div>
    `;

    // Event: visibility toggle
    li.querySelector("[data-field='visible']").addEventListener("change", (e) => {
      currentSettings.formats[index].visible = e.target.checked;
      save();
    });

    // Event: placement toggle
    li.querySelector("[data-field='topLevel']").addEventListener("click", (e) => {
      currentSettings.formats[index].topLevel = !currentSettings.formats[index].topLevel;
      renderFormats();
      save();
    });

    // Event: format-specific settings
    const qualityInput = li.querySelector("[data-field='quality']");
    if (qualityInput) {
      const valueSpan = li.querySelector(".quality-value");
      qualityInput.addEventListener("input", (e) => {
        const val = parseInt(e.target.value);
        currentSettings.formats[index].quality = val;
        if (valueSpan) valueSpan.textContent = val + "%";
        save();
      });
    }

    const compressionSelect = li.querySelector("[data-field='compression']");
    if (compressionSelect) {
      compressionSelect.addEventListener("change", (e) => {
        currentSettings.formats[index].compression = e.target.value;
        save();
      });
    }

    const sizeSelect = li.querySelector("[data-field='size']");
    if (sizeSelect) {
      sizeSelect.addEventListener("change", (e) => {
        currentSettings.formats[index].size = parseInt(e.target.value);
        save();
      });
    }

    // Drag events
    li.addEventListener("dragstart", onDragStart);
    li.addEventListener("dragover", onDragOver);
    li.addEventListener("dragleave", onDragLeave);
    li.addEventListener("drop", onDrop);
    li.addEventListener("dragend", onDragEnd);

    list.appendChild(li);
  });
}

function renderFormatSettings(fmt) {
  if ("quality" in fmt) {
    return `<span class="quality-value">${fmt.quality}%</span>
            <input type="range" min="1" max="100" value="${fmt.quality}" data-field="quality">`;
  }
  if ("compression" in fmt) {
    return `<select data-field="compression">
              <option value="none" ${fmt.compression === "none" ? "selected" : ""}>None</option>
              <option value="lzw" ${fmt.compression === "lzw" ? "selected" : ""}>LZW</option>
              <option value="deflate" ${fmt.compression === "deflate" ? "selected" : ""}>Deflate</option>
            </select>`;
  }
  if ("size" in fmt) {
    return `<select data-field="size">
              ${[16, 32, 48, 64, 128, 256].map(
                (s) => `<option value="${s}" ${fmt.size === s ? "selected" : ""}>${s}×${s}</option>`
              ).join("")}
            </select>`;
  }
  return "";
}

// --- Drag and Drop Reorder ---

let dragIndex = null;

function onDragStart(e) {
  dragIndex = parseInt(e.currentTarget.dataset.index);
  e.currentTarget.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
}

function onDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add("drag-over");
}

function onDragLeave(e) {
  e.currentTarget.classList.remove("drag-over");
}

function onDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove("drag-over");
  const dropIndex = parseInt(e.currentTarget.dataset.index);
  if (dragIndex === null || dragIndex === dropIndex) return;

  const [moved] = currentSettings.formats.splice(dragIndex, 1);
  currentSettings.formats.splice(dropIndex, 0, moved);
  renderFormats();
  save();
}

function onDragEnd(e) {
  e.currentTarget.classList.remove("dragging");
  dragIndex = null;
}

// --- Transparency ---

function renderTransparency() {
  const color = currentSettings.transparency.bgColor;
  const customColor = document.getElementById("customColor");
  const colorHex = document.getElementById("colorHex");

  customColor.value = color;
  colorHex.textContent = color;
  updatePresetActive(color);

  document.querySelectorAll(".color-preset").forEach((el) => {
    el.addEventListener("click", () => {
      const c = el.dataset.color;
      currentSettings.transparency.bgColor = c;
      customColor.value = c;
      colorHex.textContent = c;
      updatePresetActive(c);
      save();
    });
  });

  customColor.addEventListener("input", (e) => {
    currentSettings.transparency.bgColor = e.target.value;
    colorHex.textContent = e.target.value;
    updatePresetActive(e.target.value);
    save();
  });
}

function updatePresetActive(color) {
  document.querySelectorAll(".color-preset").forEach((el) => {
    el.classList.toggle("active", el.dataset.color === color);
  });
}

// --- Notifications ---

function renderNotifications() {
  const n = currentSettings.notifications;

  const badge = document.getElementById("showSuccessBadge");
  const errors = document.getElementById("showErrorNotifications");
  const action = document.getElementById("defaultAction");

  badge.checked = n.showSuccessBadge;
  errors.checked = n.showErrorNotifications;
  action.value = n.defaultAction;

  badge.addEventListener("change", (e) => {
    currentSettings.notifications.showSuccessBadge = e.target.checked;
    save();
  });

  errors.addEventListener("change", (e) => {
    currentSettings.notifications.showErrorNotifications = e.target.checked;
    save();
  });

  action.addEventListener("change", (e) => {
    currentSettings.notifications.defaultAction = e.target.value;
    save();
  });
}

// --- Save ---

let saveTimeout = null;

function save() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    await saveSettings(currentSettings);
    showSaveStatus();
  }, 300);
}

function showSaveStatus() {
  const el = document.getElementById("saveStatus");
  el.classList.add("visible");
  setTimeout(() => el.classList.remove("visible"), 1500);
}
```

### Step 3: Verify

Open the options page via `chrome://extensions` → extension details → "Extension options". Verify all 3 sections render, drag-to-reorder works, settings persist on page reload.

### Step 4: Commit

```
git add options.html options.js
git commit -m "Add options page with format config, transparency, and notifications"
```

---

## Task 5: Background.js (Orchestrator Rewrite)

**Dependencies:** Tasks 1, 2, 3, 4
**Can parallelize with:** None

**Files:**
- Modify: `background.js` (complete rewrite)

### Step 1: Rewrite background.js

Replace the entire file:

```js
importScripts("lib/defaults.js");

// --- State ---
let lastModifierState = { shiftKey: false };
let batchCancelFlag = false;

// --- Initialization ---

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await loadSettings();
  await buildContextMenus(settings);
});

// Rebuild menus when settings change
chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.settings) {
    const settings = await loadSettings();
    await buildContextMenus(settings);
  }
});

// --- Message Handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "background") return;

  if (message.action === "modifierState") {
    lastModifierState = { shiftKey: message.shiftKey };
    return;
  }

  if (message.action === "ready") {
    // Offscreen document ready — handled by ensureOffscreenDocument
    return;
  }
});

// --- Context Menu Building ---

async function buildContextMenus(settings) {
  await chrome.contextMenus.removeAll();

  const visible = settings.formats.filter((f) => f.visible);
  const topLevel = visible.filter((f) => f.topLevel);
  const others = visible.filter((f) => !f.topLevel);

  // Save Image As...
  chrome.contextMenus.create({
    id: "save-image-as",
    title: "Save Image As...",
    contexts: ["image"],
  });
  createFormatItems(topLevel, others, "save", "save-image-as", ["image"]);

  // Copy Image As...
  chrome.contextMenus.create({
    id: "copy-image-as",
    title: "Copy Image As...",
    contexts: ["image"],
  });
  createFormatItems(topLevel, others, "copy", "copy-image-as", ["image"]);

  // Save All Images As...
  chrome.contextMenus.create({
    id: "batch-save",
    title: "Save All Images As...",
    contexts: ["image", "page"],
  });
  createFormatItems(topLevel, others, "batch", "batch-save", ["image", "page"]);

  // Customize...
  chrome.contextMenus.create({
    id: "customize",
    title: "Customize...",
    contexts: ["image", "page"],
  });
}

function createFormatItems(topLevel, others, prefix, parentId, contexts) {
  for (const fmt of topLevel) {
    chrome.contextMenus.create({
      id: `${prefix}-${fmt.id}`,
      parentId,
      title: fmt.label,
      contexts,
    });
  }

  if (others.length > 0) {
    const othersId = `${prefix}-others`;
    chrome.contextMenus.create({
      id: othersId,
      parentId,
      title: "Others",
      contexts,
    });
    for (const fmt of others) {
      chrome.contextMenus.create({
        id: `${prefix}-${fmt.id}`,
        parentId: othersId,
        title: fmt.label,
        contexts,
      });
    }
  }
}

// --- Context Menu Click Handler ---

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "customize") {
    chrome.runtime.openOptionsPage();
    return;
  }

  const parsed = parseMenuItemId(info.menuItemId);
  if (!parsed) return;

  const settings = await loadSettings();
  let { action, format } = parsed;

  // Shift+click overrides: save ↔ clipboard
  if (lastModifierState.shiftKey) {
    if (action === "save") action = "copy";
    else if (action === "copy") action = "save";
  }

  // Check default action override (only for "save" action when defaultAction is clipboard)
  if (action === "save" && settings.notifications.defaultAction === "clipboard" && !lastModifierState.shiftKey) {
    action = "copy";
  }
  if (action === "copy" && settings.notifications.defaultAction === "save" && !lastModifierState.shiftKey) {
    // Already correct
  }

  const formatSettings = getFormatSettings(settings, format);

  if (action === "batch") {
    await handleBatchSave(tab, format, formatSettings, settings);
  } else if (action === "copy") {
    await handleCopyImage(info.srcUrl, format, formatSettings, settings);
  } else {
    await handleSaveImage(info.srcUrl, format, formatSettings, settings);
  }

  // Reset modifier state
  lastModifierState = { shiftKey: false };
});

function parseMenuItemId(id) {
  const parentIds = ["save-image-as", "copy-image-as", "batch-save", "save-others", "copy-others", "batch-others", "customize"];
  if (parentIds.includes(id)) return null;

  if (id.startsWith("save-")) return { action: "save", format: id.slice(5) };
  if (id.startsWith("copy-")) return { action: "copy", format: id.slice(5) };
  if (id.startsWith("batch-")) return { action: "batch", format: id.slice(6) };
  return null;
}

function getFormatSettings(settings, formatId) {
  const fmt = settings.formats.find((f) => f.id === formatId) || {};
  return {
    quality: fmt.quality,
    bgColor: settings.transparency.bgColor,
    compression: fmt.compression,
    size: fmt.size,
  };
}

// --- Save Image ---

async function handleSaveImage(imageUrl, format, formatSettings, settings) {
  try {
    await ensureOffscreenDocument();

    const dataUrl = await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "convert",
      imageUrl,
      format,
      settings: formatSettings,
    });

    if (!dataUrl || dataUrl.error) {
      throw new Error(dataUrl?.error || "Conversion failed");
    }

    const filename = deriveFilename(imageUrl, format);
    chrome.downloads.download({ url: dataUrl, filename, saveAs: true });

    showBadge("✓", "#34a853", 2000, settings);
  } catch (err) {
    console.error("Save failed:", err);
    showError(`Failed to save image: ${err.message}`, settings);
  }
}

// --- Copy Image ---

async function handleCopyImage(imageUrl, format, formatSettings, settings) {
  try {
    await ensureOffscreenDocument();

    const dataUrl = await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "convert",
      imageUrl,
      format,
      settings: formatSettings,
    });

    if (!dataUrl || dataUrl.error) {
      throw new Error(dataUrl?.error || "Conversion failed");
    }

    const result = await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "copyToClipboard",
      dataUrl,
    });

    if (result?.error) {
      throw new Error(result.error);
    }

    showBadge("✓", "#34a853", 2000, settings);

    if (settings.notifications.showSuccessBadge) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Copied to clipboard",
        message: `Image copied as ${format.toUpperCase()}`,
      });
    }
  } catch (err) {
    console.error("Copy failed:", err);
    showError(`Failed to copy image: ${err.message}`, settings);
  }
}

// --- Batch Save ---

async function handleBatchSave(tab, format, formatSettings, settings) {
  try {
    batchCancelFlag = false;

    // Scan page for images via content script
    const results = await chrome.tabs.sendMessage(tab.id, {
      target: "content",
      action: "scanImages",
    });

    if (!results || results.length === 0) {
      showError("No images found on this page", settings);
      return;
    }

    const imageUrls = results;

    // Confirmation for large batches
    if (imageUrls.length > 50) {
      chrome.notifications.create("batch-confirm", {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Save All Images",
        message: `Found ${imageUrls.length} images. This may take a while. Saving as ${format.toUpperCase()}...`,
        buttons: [{ title: "Continue" }, { title: "Cancel" }],
      });

      const confirmed = await new Promise((resolve) => {
        const handler = (notifId, btnIdx) => {
          if (notifId === "batch-confirm") {
            chrome.notifications.onButtonClicked.removeListener(handler);
            resolve(btnIdx === 0);
          }
        };
        chrome.notifications.onButtonClicked.addListener(handler);
      });

      if (!confirmed) return;
    }

    chrome.notifications.create("batch-progress", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Saving images...",
      message: `0/${imageUrls.length} saved as ${format.toUpperCase()}`,
    });

    await ensureOffscreenDocument();

    let saved = 0;
    let failed = 0;

    for (const imageUrl of imageUrls) {
      if (batchCancelFlag) break;

      try {
        const dataUrl = await chrome.runtime.sendMessage({
          target: "offscreen",
          action: "convert",
          imageUrl,
          format,
          settings: formatSettings,
        });

        if (!dataUrl || dataUrl.error) {
          failed++;
          continue;
        }

        const filename = deriveFilename(imageUrl, format);
        await chrome.downloads.download({
          url: dataUrl,
          filename,
          conflictAction: "uniquify",
        });

        saved++;
      } catch {
        failed++;
      }

      // Update progress badge
      chrome.action.setBadgeText({ text: `${saved}/${imageUrls.length}` });
      chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });

      // Update notification
      chrome.notifications.update("batch-progress", {
        message: `${saved}/${imageUrls.length} saved as ${format.toUpperCase()}${failed > 0 ? ` (${failed} failed)` : ""}`,
      });
    }

    // Final summary
    chrome.action.setBadgeText({ text: "" });

    if (failed > 0) {
      showBadge(`${saved}`, "#fbbc04", 3000, settings);
      chrome.notifications.update("batch-progress", {
        title: "Batch save complete",
        message: `Saved ${saved}/${imageUrls.length} images (${failed} failed)`,
      });
    } else {
      showBadge("✓", "#34a853", 2000, settings);
      chrome.notifications.update("batch-progress", {
        title: "Batch save complete",
        message: `All ${saved} images saved as ${format.toUpperCase()}`,
      });
    }
  } catch (err) {
    console.error("Batch save failed:", err);
    showError(`Batch save failed: ${err.message}`, settings);
  }
}

// --- Notifications & Badge ---

function showBadge(text, color, durationMs, settings) {
  if (!settings.notifications.showSuccessBadge && color === "#34a853") return;

  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), durationMs);
}

function showError(message, settings) {
  chrome.action.setBadgeText({ text: "✗" });
  chrome.action.setBadgeBackgroundColor({ color: "#ea4335" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);

  if (settings.notifications.showErrorNotifications) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Save Image as Any Type",
      message,
    });
  }
}

// --- Filename Derivation ---

function deriveFilename(url, format) {
  try {
    const urlObj = new URL(url);
    let name = urlObj.pathname.split("/").pop() || "image";
    name = decodeURIComponent(name.split("?")[0].split("#")[0]);

    const dotIndex = name.lastIndexOf(".");
    if (dotIndex > 0) {
      name = name.substring(0, dotIndex);
    }

    name = name.replace(/[^a-zA-Z0-9_\-\.]/g, "_") || "image";

    const ext = format === "ico" ? "ico" : format;
    return `${name}.${ext}`;
  } catch {
    return `image.${format}`;
  }
}

// --- Offscreen Document ---

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")],
  });

  if (contexts.length > 0) return;

  const readyPromise = new Promise((resolve) => {
    const listener = (message) => {
      if (message?.target === "background" && message?.action === "ready") {
        chrome.runtime.onMessage.removeListener(listener);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
  });

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS", "CLIPBOARD"],
    justification: "Convert images between formats and copy to clipboard",
  });

  await readyPromise;
}
```

### Step 2: Verify

1. Load extension. Right-click an image → "Save Image As..." should show PNG, JPG, TIFF at top level and Others submenu with remaining formats.
2. Test each format save.
3. Test "Copy Image As..." → verify clipboard contains image.
4. Open options page → change format order → verify menu updates.
5. Test "Save All Images As..." on a page with multiple images.
6. Test Shift+click toggles save ↔ copy.

### Step 3: Commit

```
git add background.js
git commit -m "Rewrite background.js for dynamic menus, clipboard, batch, and notifications"
```

---

## Final Verification

After all tasks complete:

1. Load extension fresh in Chrome
2. Test all 8 formats: PNG, JPG, WebP, AVIF, TIFF, BMP, ICO, GIF
3. Test clipboard copy for each
4. Test batch save on image-heavy page
5. Test options page: reorder, hide, quality sliders, transparency color
6. Test notification toggles (on/off)
7. Test Shift+click modifier
8. Test error case: AVIF on older browser profile
9. Verify no console errors in service worker or offscreen document
