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
