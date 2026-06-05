# Changelog

All notable changes to Folio are documented here.

---

## [1.1.1] — 2026-06-05

### Fixed
- **Bulk move to folder** — Ctrl-click to select multiple thumbnails, then use the "📁 Move to…" button in the bulk action bar to move them all to another folder in one operation.
- **Resume last image** — config was saving `lastImagePath: null` before the async scan finished on startup, wiping the saved position every launch.
- **Start from last image** — was picking a random position when shuffle was enabled; now always resolves to the visually-last image in the sorted thumbnail order.
- **Startup behavior setting** — changing the option no longer triggers a full image rescan.

---

## [1.1.0] — 2026-06-02

### Added
- **Move to folder** — right-click any thumbnail to move the image to another loaded folder. The submenu lists every other active folder by name; the image list updates instantly without a restart.
- **Spacebar play/pause** — press Space anywhere in the app to start or stop the slideshow. The shortcut is ignored when a text input (e.g. the rename field) is focused.

---

## [1.0.0] — 2026-05-01

Initial public release.

### Features
- Multi-folder slideshow viewer with ten transition effects (fade, slide, zoom, blur, rotate, flip)
- Adjustable slideshow speed and transition duration
- Shuffle mode
- Fullscreen mode with auto-hiding controls
- Thumbnail browser grouped by folder with lazy-loaded, disk-cached thumbnails
- Resizable sidebar and adjustable thumbnail size
- Zoom (25 %–500 %) and pan with mouse wheel and keyboard
- Live folder watching — grid updates automatically when files are added or removed
- AI image metadata reader — parses Stable Diffusion PNG tEXt chunks (prompt, negative prompt, generation parameters)
- Inline rename, delete to Recycle Bin, single and bulk convert (PNG / JPEG)
- Copy file to Windows clipboard (CF_HDROP, paste-compatible with Explorer)
- Persistent settings — restores folders, last viewed image, sidebar width, and thumbnail size on relaunch
- Drag-and-drop folders onto the app window to add them
- Arrow key navigation (← →), double-click to toggle fullscreen
