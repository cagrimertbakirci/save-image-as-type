importScripts("lib/defaults.js");

// --- State ---
let lastModifierState = { shiftKey: false };
let batchCancelFlag = false;

// Cancel batch when progress notification is closed
chrome.notifications.onClosed.addListener((notifId) => {
  if (notifId === "batch-progress") {
    batchCancelFlag = true;
  }
});

// --- Initialization ---

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await loadSettings();
  await buildContextMenus(settings);
});

chrome.runtime.onStartup.addListener(async () => {
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

  // Single top-level entry
  const root = "save-image-as";
  chrome.contextMenus.create({
    id: root,
    title: "Save Image as Any Type",
    contexts: ["image", "page"],
  });

  // Save formats — directly in root menu (2 clicks to reach)
  for (const fmt of topLevel) {
    chrome.contextMenus.create({
      id: `save-${fmt.id}`,
      parentId: root,
      title: `Save as ${fmt.label}`,
      contexts: ["image"],
    });
  }

  // Save Others submenu
  if (others.length > 0) {
    chrome.contextMenus.create({
      id: "save-others",
      parentId: root,
      title: "Save as Others",
      contexts: ["image"],
    });
    for (const fmt of others) {
      chrome.contextMenus.create({
        id: `save-${fmt.id}`,
        parentId: "save-others",
        title: fmt.label,
        contexts: ["image"],
      });
    }
  }

  // Separator before copy/batch
  chrome.contextMenus.create({
    id: "sep-1",
    parentId: root,
    type: "separator",
    contexts: ["image"],
  });

  // Copy Image As... submenu
  chrome.contextMenus.create({
    id: "copy-image-as",
    parentId: root,
    title: "Copy Image As...",
    contexts: ["image"],
  });
  createFormatItems(visible, "copy", "copy-image-as", ["image"]);

  // Save All Images As... submenu
  chrome.contextMenus.create({
    id: "batch-save",
    parentId: root,
    title: "Save All Images As...",
    contexts: ["image", "page"],
  });
  createFormatItems(visible, "batch", "batch-save", ["image", "page"]);

  // Separator before customize
  chrome.contextMenus.create({
    id: "sep-2",
    parentId: root,
    type: "separator",
    contexts: ["image", "page"],
  });

  // Customize...
  chrome.contextMenus.create({
    id: "customize",
    parentId: root,
    title: "Customize...",
    contexts: ["image", "page"],
  });
}

function createFormatItems(allVisible, prefix, parentId, contexts) {
  for (const fmt of allVisible) {
    chrome.contextMenus.create({
      id: `${prefix}-${fmt.id}`,
      parentId,
      title: fmt.label,
      contexts,
    });
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

  // Apply default action override first (swap save↔copy based on user preference)
  if (action === "save" && settings.notifications.defaultAction === "clipboard") {
    action = "copy";
  }

  // Shift+click inverts the effective action (overrides both menu choice and default)
  if (lastModifierState.shiftKey) {
    if (action === "save") action = "copy";
    else if (action === "copy") action = "save";
  }

  const formatSettings = getFormatSettings(settings, format);

  if (action === "batch") {
    await handleBatchSave(tab, format, formatSettings, settings);
  } else if (action === "copy") {
    await handleCopyImage(info.srcUrl, format, formatSettings, settings, tab);
  } else {
    await handleSaveImage(info.srcUrl, format, formatSettings, settings, tab);
  }

  // Reset modifier state
  lastModifierState = { shiftKey: false };
});

function parseMenuItemId(id) {
  const parentIds = ["save-image-as", "copy-image-as", "batch-save", "save-others", "copy-others", "batch-others", "customize", "sep-1", "sep-2"];
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

async function handleSaveImage(imageUrl, format, formatSettings, settings, tab) {
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
    showError(`Failed to save image: ${err.message}`, settings, tab);
  }
}

// --- Copy Image ---

async function handleCopyImage(imageUrl, format, formatSettings, settings, tab) {
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
    showError(`Failed to copy image: ${err.message}`, settings, tab);
  }
}

// --- Batch Save ---

async function handleBatchSave(tab, format, formatSettings, settings) {
  try {
    batchCancelFlag = false;

    // Scan page for images via content script with size filter
    const minSize = settings.batchFilter?.minWidth ?? 100;
    const maxSize = settings.batchFilter?.maxWidth ?? 0;
    const preferHighRes = settings.batchFilter?.preferHighRes !== false;

    let results;
    try {
      results = await chrome.tabs.sendMessage(tab.id, {
        target: "content",
        action: "scanImages",
        minSize,
        maxSize,
        preferHighRes,
      });
    } catch (e) {
      // Content script not loaded — inject it and retry
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      results = await chrome.tabs.sendMessage(tab.id, {
        target: "content",
        action: "scanImages",
        minSize,
        maxSize,
        preferHighRes,
      });
    }

    if (!results || results.length === 0) {
      showError("No images found on this page", settings, tab);
      return;
    }

    const imageUrls = results;

    // Ask user: zip or separate, with option to cancel
    const [choiceResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (count, fmt) => {
        const choice = prompt(
          `Save Image as Any Type\n\nFound ${count} images.\n\nType "zip" to download as a single ZIP file, or "ok" to download separately.\nCancel to abort.`,
          "zip"
        );
        if (choice === null) return "cancel";
        return choice.toLowerCase().trim() === "zip" ? "zip" : "separate";
      },
      args: [imageUrls.length, format.toUpperCase()],
    });

    const deliveryMode = choiceResult.result;
    if (deliveryMode === "cancel") return;

    await ensureOffscreenDocument();

    let saved = 0;
    let failed = 0;
    const zipFiles = [];

    chrome.action.setBadgeText({ text: "0" });
    chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });

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

        if (deliveryMode === "zip") {
          zipFiles.push({ filename, dataUrl });
        } else {
          await chrome.downloads.download({
            url: dataUrl,
            filename,
            conflictAction: "uniquify",
          });
        }

        saved++;
      } catch {
        failed++;
      }

      chrome.action.setBadgeText({ text: `${saved}/${imageUrls.length}` });
    }

    // Deliver ZIP if selected
    if (deliveryMode === "zip" && zipFiles.length > 0) {
      chrome.action.setBadgeText({ text: "ZIP" });
      const zipDataUrl = await chrome.runtime.sendMessage({
        target: "offscreen",
        action: "createZip",
        files: zipFiles,
      });

      if (zipDataUrl && !zipDataUrl.error) {
        await chrome.downloads.download({
          url: zipDataUrl,
          filename: `images_${format}.zip`,
          saveAs: true,
        });
      }
    }

    // Final summary
    chrome.action.setBadgeText({ text: "" });

    if (batchCancelFlag) {
      showBadge(`${saved}`, "#fbbc04", 3000, settings);
    } else if (failed > 0) {
      showBadge(`${saved}`, "#fbbc04", 3000, settings);
    } else {
      showBadge("✓", "#34a853", 2000, settings);
    }
  } catch (err) {
    console.error("Batch save failed:", err);
    showError(`Batch save failed: ${err.message}`, settings, tab);
  }
}

// --- Notifications & Badge ---

function showBadge(text, color, durationMs, settings) {
  if (!settings.notifications.showSuccessBadge && color === "#34a853") return;

  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), durationMs);
}

function showError(message, settings, tab) {
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

  // Show in-page alert as fallback (notifications may be blocked by OS)
  if (tab?.id) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (msg) => alert(msg),
      args: [`Save Image as Any Type:\n${message}`],
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

    return `${name}.${format}`;
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
