# Changelog

All notable changes to Folio are documented here.

---

## [1.1.3] — 2026-10-27

### Added
- **Resize / Crop editor**: right-click a thumbnail and choose "Resize / Crop…". Drag or draw the crop box, or type exact X/Y/W/H values. Choose an aspect-ratio preset, set the output size in pixels or by percentage, and pick PNG, JPEG or WebP with adjustable quality. **Save as new…** writes a separate file. **Overwrite** replaces the original and moves it to the Recycle Bin first. Stable Diffusion parameters in PNG files are kept.
- **Bulk resize**: select several thumbnails and use "⤡ Resize…" in the bulk action bar. Scale by a percentage or fit the longest side to a pixel size; images already within the size are skipped. Save as new `_resized` files (keeping the format, or as PNG, JPEG or WebP) or overwrite the originals in place, with the originals moved to the Recycle Bin. PNG generation parameters are kept.
- **Thumbnail reload**: a ↻ button in the Browse footer and F5 anywhere in the app clear and regenerate thumbnails.

### Changed
- **Faster thumbnails**: thumbnails are now generated in parallel background workers instead of one at a time in the main process. A cold load of a 101-image folder dropped from ~4.7 s to ~2.0 s, and the app stays responsive while it runs (main-process stalls went from up to 2.8 s to under 30 ms). Thumbnails are stored as small WebP files, so the cache is ~9× smaller (17.1 MB → 1.9 MB for 101 images) and warm loads are about twice as fast. They're also sharper (320 px), and they refresh automatically when a file is edited outside Folio.
- **Self-cleaning thumbnail cache**: a new thumbnail replaces the image's old one instead of leaving it behind. Thumbnails unused for 90 days (deleted images, folders no longer loaded) are cleaned up automatically, and files from the old cache format are removed on first launch.
- **Visible thumbnails first**: when you scroll quickly through a large folder, thumbnails you've already scrolled past are dropped from the queue, so the ones on screen load right away. Fast-scrolling a 606-image folder, the thumbnails at the bottom were ready in 0.3 s instead of 9.2 s.
- **More robust thumbnail generation**: if a background worker crashes or gets stuck on a file for 30 s, it's replaced automatically and the other thumbnails keep loading.

### Fixed
- **WebP and other thumbnails**: thumbnails for WebP, AVIF and GIF files (including ones with a misleading `.jpg` extension) no longer stay blank.

---

## [1.1.2] — 2026-06-29

### Added
- **Keep Awake** — a toggle in the controls bar that stops the monitor from going to sleep while a slideshow is playing. The display is only kept awake while playback is running, and the setting is remembered between sessions.
- **Real (1:1) size** — double right-click an image to switch it to its native pixel size, then double right-click again to return to the fitted view. A single right-click still resets zoom and position.
- **In-app help** — a "?" button next to Keep Awake opens this guide (the README) as an overlay on top of the image. Dismiss it with the ✕, a click outside, or Escape.

### Changed
- **Removed the Fullscreen button** from the controls bar; fullscreen is still available by double-clicking the image (and Escape still exits it).

---

## [1.1.1] — 2026-06-05

### Added
- **Drag to reorder folders** — drag the ⠿ handle on any folder row in the sidebar to change its position; the thumbnail groups in the Browse tab follow the same order.
- **Move folder contents** — right-click any folder in the sidebar and choose "Move all to ▶" to move every image inside it to another loaded folder in one operation.

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
