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
