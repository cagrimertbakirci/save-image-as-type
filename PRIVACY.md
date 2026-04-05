# Privacy Policy — Save Image as Any Type

**Last updated:** April 5, 2026

## Data Collection

Save Image as Any Type does **not** collect, store, transmit, or share any personal data or browsing information. The extension operates entirely within your browser.

## How the Extension Works

- All image conversion happens locally in your browser using the HTML5 Canvas API
- No images or data are uploaded to any external server
- User preferences (format settings, quality levels) are stored locally in your browser via Chrome's built-in `chrome.storage.sync` API, which syncs settings across your signed-in Chrome browsers. This data never leaves Google's infrastructure.

## Permissions

The extension requests the following permissions solely to provide its functionality:

| Permission | Purpose |
|-----------|---------|
| `contextMenus` | Adds right-click menu options for image conversion |
| `downloads` | Triggers the Save As dialog for converted images |
| `offscreen` | Creates an invisible canvas for image format conversion |
| `storage` | Saves your format preferences locally |
| `notifications` | Shows success/error feedback after conversions |
| `clipboardWrite` | Copies converted images to your clipboard |
| `scripting` | Scans pages for images during batch download |
| `<all_urls>` | Fetches images from any website for conversion |

## Third-Party Services

This extension does not use any third-party services, analytics, tracking, or advertising.

## Open Source

The source code is publicly available at [github.com/cagrimertbakirci/save-image-as-type](https://github.com/cagrimertbakirci/save-image-as-type).

## Contact

If you have questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/cagrimertbakirci/save-image-as-type/issues).
