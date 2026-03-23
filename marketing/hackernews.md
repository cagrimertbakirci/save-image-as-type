# Hacker News

**Title:** Show HN: Save Image as Any Type – Right-click to save web images as PNG, JPG, or TIFF

**Body:**

Chrome extension that adds format options to the image context menu. Right-click any image, pick PNG/JPG/TIFF, get a Save As dialog.

Built this because every image on the web seems to be WebP now, and my workflow doesn't always accept that. The conversion uses an offscreen canvas in MV3 — no server, no uploads, everything stays local.

TIFF encoding uses UTIF.js by the Photopea author. JPG export fills transparent regions white to avoid the classic black background problem.

No content scripts, no data collection, minimal permissions.

Chrome Web Store: [link]
