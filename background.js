// Create context menu on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "save-image-as",
    title: "Save Image As...",
    contexts: ["image"],
  });

  chrome.contextMenus.create({
    id: "save-as-png",
    parentId: "save-image-as",
    title: "PNG",
    contexts: ["image"],
  });

  chrome.contextMenus.create({
    id: "save-as-jpg",
    parentId: "save-image-as",
    title: "JPG",
    contexts: ["image"],
  });

  chrome.contextMenus.create({
    id: "save-as-tiff",
    parentId: "save-image-as",
    title: "TIFF",
    contexts: ["image"],
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info) => {
  const formatMap = {
    "save-as-png": "png",
    "save-as-jpg": "jpg",
    "save-as-tiff": "tiff",
  };

  const format = formatMap[info.menuItemId];
  if (!format) return;

  try {
    const imageUrl = info.srcUrl;

    await ensureOffscreenDocument();

    const dataUrl = await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "convert",
      imageUrl,
      format,
    });

    if (!dataUrl || dataUrl.error) {
      console.error("Conversion failed:", dataUrl?.error || "No response");
      return;
    }

    const filename = deriveFilename(imageUrl, format);

    chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: true,
    });
  } catch (err) {
    console.error("Save Image as Any Type error:", err);
  }
});

// Derive a clean filename from the source URL
function deriveFilename(url, format) {
  try {
    const urlObj = new URL(url);
    let pathname = urlObj.pathname;

    // Get the last segment of the path
    let name = pathname.split("/").pop() || "image";

    // Remove query-like fragments and decode
    name = decodeURIComponent(name.split("?")[0].split("#")[0]);

    // Replace existing extension with target format
    const dotIndex = name.lastIndexOf(".");
    if (dotIndex > 0) {
      name = name.substring(0, dotIndex);
    }

    // Sanitize: keep only safe filename characters
    name = name.replace(/[^a-zA-Z0-9_\-\.]/g, "_") || "image";

    return `${name}.${format}`;
  } catch {
    return `image.${format}`;
  }
}

// Ensure the offscreen document exists and is ready
async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")],
  });

  if (contexts.length > 0) return;

  // Listen for the ready signal before creating the document
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
    reasons: ["BLOBS"],
    justification: "Convert images between formats using canvas",
  });

  // Wait for offscreen scripts to finish loading
  await readyPromise;
}
