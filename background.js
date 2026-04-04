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
