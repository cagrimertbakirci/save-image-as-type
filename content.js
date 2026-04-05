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

  const urls = scanPageForImages(
    message.minSize || 100,
    message.maxSize || 0,
    message.preferHighRes !== false
  );
  sendResponse(urls);
  return true;
});

function scanPageForImages(minSize, maxSize, preferHighRes) {
  const urls = new Set();

  // <img> elements — filter by size, prefer high-res srcset
  document.querySelectorAll("img").forEach((img) => {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (w < minSize || h < minSize) return;
    if (maxSize > 0 && (w > maxSize || h > maxSize)) return;

    let bestUrl = img.src;

    // Check srcset for highest resolution version
    if (preferHighRes && img.srcset) {
      bestUrl = getHighestResSrcsetUrl(img.srcset) || bestUrl;
    }

    // Check parent <picture> for highest resolution source
    if (preferHighRes && img.closest("picture")) {
      const pictureUrl = getHighestResPictureUrl(img.closest("picture"));
      if (pictureUrl) bestUrl = pictureUrl;
    }

    if (bestUrl) urls.add(bestUrl);
  });

  // CSS background-image (visible elements only, skip tiny)
  document.querySelectorAll("*").forEach((el) => {
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== "none") {
      const match = bg.match(/url\(["']?(.*?)["']?\)/);
      if (match && match[1]) {
        try {
          const url = new URL(match[1], document.baseURI).href;
          if (url.startsWith("http")) urls.add(url);
        } catch { /* invalid URL, skip */ }
      }
    }
  });

  return [...urls];
}

function getHighestResSrcsetUrl(srcset) {
  let bestUrl = null;
  let bestSize = 0;

  for (const part of srcset.split(",")) {
    const tokens = part.trim().split(/\s+/);
    const url = tokens[0];
    const descriptor = tokens[1] || "";

    let size = 0;
    if (descriptor.endsWith("w")) {
      size = parseInt(descriptor);
    } else if (descriptor.endsWith("x")) {
      size = parseFloat(descriptor) * 1000; // normalize: 2x → 2000
    }

    if (url && size > bestSize) {
      bestSize = size;
      try {
        bestUrl = new URL(url, document.baseURI).href;
      } catch { /* skip */ }
    }
  }

  return bestUrl;
}

function getHighestResPictureUrl(picture) {
  let bestUrl = null;
  let bestSize = 0;

  picture.querySelectorAll("source[srcset]").forEach((source) => {
    const url = getHighestResSrcsetUrl(source.srcset);
    // Use media query width hints if available
    const media = source.getAttribute("media") || "";
    const widthMatch = media.match(/min-width:\s*(\d+)/);
    const size = widthMatch ? parseInt(widthMatch[1]) : 0;

    if (url && size >= bestSize) {
      bestSize = size;
      bestUrl = url;
    }
  });

  return bestUrl;
}
