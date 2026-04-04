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
      const q = (settings.quality ?? 92) / 100;
      return canvas.toDataURL("image/jpeg", q);
    }

    case "webp": {
      const q = (settings.quality ?? 90) / 100;
      return canvas.toDataURL("image/webp", q);
    }

    case "avif": {
      const q = (settings.quality ?? 80) / 100;
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
