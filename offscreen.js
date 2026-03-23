// Signal to background that scripts are loaded and ready
chrome.runtime.sendMessage({ target: "background", action: "ready" });

// Listen for conversion requests from background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen" || message.action !== "convert") return;

  convertImage(message.imageUrl, message.format)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));

  // Return true to indicate async response
  return true;
});

async function convertImage(imageUrl, format) {
  // Fetch the image as a blob
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }
  const blob = await response.blob();

  // Load into an Image element
  const img = await loadImage(blob);

  // Create canvas at natural dimensions
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");

  if (format === "jpg") {
    // Fill white background for JPG (no transparency support)
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.drawImage(img, 0, 0);

  // Convert based on format
  switch (format) {
    case "png":
      return canvas.toDataURL("image/png");

    case "jpg":
      return canvas.toDataURL("image/jpeg", 0.92);

    case "tiff":
      return canvasToTiffDataUrl(ctx, canvas.width, canvas.height);

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

function canvasToTiffDataUrl(ctx, width, height) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const rgba = imageData.data;

  // UTIF.encodeImage expects a regular array or Uint8Array
  const tiffBuffer = UTIF.encodeImage(rgba, width, height);

  // Convert ArrayBuffer to base64 data URL
  const bytes = new Uint8Array(tiffBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  return `data:image/tiff;base64,${base64}`;
}
