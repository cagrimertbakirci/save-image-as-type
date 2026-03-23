# r/webdev

**Title:** Built a Chrome extension that converts images on right-click — no more WebP frustration

**Body:**

Quick weekend project that turned out more useful than I expected.

**The problem:** Websites serve images in WebP/AVIF. You right-click, save, and get a format that Photoshop (older versions), email clients, or your CMS won't accept without conversion.

**The solution:** A Chrome extension that adds a "Save Image As..." submenu to the context menu with PNG, JPG, and TIFF options. Right-click, pick format, done.

**Tech stack for anyone curious:**
- Manifest V3
- Offscreen document with canvas for conversion
- UTIF.js (from the Photopea author) for TIFF encoding
- Zero dependencies otherwise
- No content scripts, no data collection

The trickiest part was the MV3 offscreen document lifecycle — service workers and offscreen docs have different lifetimes, so there's a ready-signal handshake to avoid race conditions.

Chrome Web Store: [link]

Happy to answer any technical questions.
