# CLAUDE.md

## Commands

```bash
npm run dev        # Dev mode: Vite on :1420 (renderer hot-reload) + debug Rust build
npm run build      # Release exe, no installer → src-tauri/target/release/folio.exe
npm run package    # Release build + copy to dist/Folio_<version>_Portable.exe
```

> **Important:** `npm run dev` hot-reloads the renderer only. Changes under `src-tauri/` trigger a Rust rebuild and app restart (handled by `tauri dev`).

Prerequisites: Rust (stable MSVC), VS Build Tools with C++, WebView2.

---

## Architecture

Tauri 2 desktop app: Rust backend (`src-tauri/`) + React renderer (`src/renderer/`, built by Vite). Windows-only single portable executable. Folio 1.1.x was Electron; 1.2.0 moved to Tauri.

```
src-tauri/
  tauri.conf.json   ← window, asset protocol (scope **), version read from package.json
  capabilities/     ← window permissions (set-fullscreen, close)
  src/main.rs       ← every command: scan, config, dialogs, file ops, convert, metadata, clipboard, keep-awake
  src/thumbs.rs     ← disk thumbnail cache
  src/png.rs        ← PNG text-chunk copy + Stable Diffusion parameter parsing
  src/watch.rs      ← debounced folder watcher (notify) → "images-updated" event

src/renderer/src/
  backend.js                     ← window.folio.* → Tauri commands/events/window API; fileUrl(); patches window.close and the context menu
  App.jsx                        ← Root state owner; all business logic
  components/FolderManager.jsx   ← Folder list (pointer-drag reordering) + startup behavior setting
  components/ThumbnailBrowser.jsx← Thumbnail grid, context menu, bulk actions
  components/SlideShow.jsx       ← Main image viewer with transitions and zoom/pan
  components/Controls.jsx        ← Playback controls bar
  components/ImageEditor.jsx     ← Edit modal: Crop & Resize and Adjust tabs (encode in renderer, save via backend)
  components/BulkResize.jsx      ← Bulk-bar "Resize…" popover; runs resizes through the worker pool
  thumbnails.js                  ← Worker pool + scheduling: requestThumbnail(), resizeImage()
  imageWorker.js                 ← Web Worker: decode → resize → encode (thumb and bulk resize ops)
  adjust.js                      ← Adjustment sliders/presets + WebGL2 renderer + guided-filter luminance maps
```

### Renderer ↔ backend

Components only call `window.folio.*` (set up by `backend.js`, imported first in `main.jsx`). Commands are snake_case (`get_thumbnails`); Tauri maps camelCase JS args to snake_case Rust params. Command errors arrive as strings and `backend.js` rethrows them as `Error`s.

- Local images load through the asset protocol: always build `src` with `fileUrl(path)` (`http://asset.localhost/<encoded path>`). The query string is ignored by the protocol, so `?v=N` cache-busting works.
- Large byte payloads (`save_thumbnails`, `save_edited_image`) go as raw request bodies, with their other arguments in percent-encoded `x-*` headers. `read_image_bytes` returns a raw `Response` (an ArrayBuffer in JS). Never pass big `Uint8Array`s as JSON args.
- Dialogs (`tauri-plugin-dialog`, Rust side) use `blocking_*` calls inside `spawn_blocking`, modal to the main window. Slow file work also runs in `spawn_blocking`.
- Explorer folder drops: the webview's HTML5 drop events carry no paths, so `onFolderDrag` reports the native drag-drop events and `filter_directories` keeps the folders. Native drop handling also disables HTML5 drag and drop inside the webview on Windows, which is why folder reordering uses pointer events. Don't add HTML5 DnD.
- There's no fullscreen-changed event: `onFullscreenChanged` checks `isFullscreen()` after each resize.

### State in App.jsx

| State | Purpose |
|---|---|
| `folders` | `{ path, active }[]` — loaded source folders |
| `images` | `{ path, folder }[]` — flat list of all scanned images |
| `currentIndex` | Index into `images` for the viewer |
| `isPlaying` | Slideshow running |
| `intervalMs` | Slideshow speed |
| `shuffled` | Shuffle mode |
| `transition` / `transitionDuration` | Transition effect |
| `startupBehavior` | `'resume'` \| `'first'` \| `'last'` |
| `sidebarTab` / `sidebarWidth` / `thumbSize` | UI layout |

`imagesRef` and `currentIndexRef` are kept in sync with their state counterparts so event callbacks (set up once) always see current values.

`startupBehaviorRef` is a ref kept in sync with `startupBehavior` state so the async scan callback always reads the current value without being in the dependency array.

### Startup / image restore

Config is loaded once on mount. `lastImagePathRef.current` is set synchronously inside the `.then()` before React processes state updates. The folders effect (`[folders, shuffled]`) reads the ref after the async `scanImages` call resolves.

**Important:** `lastImagePath` is only written to config when `images.length > 0` — never while the list is empty (e.g. during the async scan) — to avoid wiping the saved path on every startup.

### Data folder

`%APPDATA%\Folio` (the Folio 1.1 Electron userData folder, so upgrades keep config and thumbnails): `config.json` (pretty JSON, key order preserved) and `thumbnails/`. WebView2's own data goes to `%LOCALAPPDATA%\com.velvethorizon.folio`.

### Thumbnail cache

WebP files in `thumbnails/`, named `<sha1(path)>_<sha1(size|mtimeMs)[0:16]>.webp`, so editing a file outside Folio invalidates its thumbnail. `mtimeMs` is computed and printed exactly like Node's (`secs·1e3 + nanos/1e6`, shortest round-trip), so 1.1's cache files still match. An in-memory index (sha1(path) → file name) is built at startup. It lets a regenerated thumbnail replace the old one, and lets rename, move and trash find an image's thumbnail without a stat. Entries unused for 90 days are pruned 15 s after startup; cache hits refresh their mtime at most weekly. Files in any other naming format are deleted at startup.

Generation happens in the renderer (`thumbnails.js`). A pool of Web Workers (`imageWorker.js`, inlined via `?worker&inline`, at most 8 or cores − 2; a worker that crashes or exceeds its job timeout is terminated and replaced; all are shut down after 8 s idle) fetches the file itself through the asset protocol (`cache: 'no-store'`, so file bytes never cross the UI thread) and decodes with Chromium (`createImageBitmap`), so every format WebView2 knows works, including WebP saved as `.jpg`. Each worker resizes to a shortest side of 320 px (long side capped at 1280) and encodes WebP q0.82. The backend only stats, reads and writes files. SVGs use the file itself.

The grid is virtualized (`computeLayout` in `ThumbnailBrowser.jsx`): thumbnails and folder labels are absolutely positioned on a canvas, and only those within 1.5 viewport heights of it are mounted (a fast wheel flick is scrolled by the compositor ahead of the UI thread, so a small margin shows empty space), so a folder of thousands of images renders like a few screenfuls. The layout constants (`GAP`, `PAD_*`, `LABEL_H`) must match `ThumbnailBrowser.css`. `ThumbnailItem` and `ThumbnailBrowser` are memoized, so changing the current image re-renders only the two thumbnails involved. `thumbnails.js` remembers each image's last thumbnail URL (`peekThumbnail`, cleared on F5) and keeps the 600 most recently shown ones loaded in `Image` objects (pinning the small files in Chromium's memory cache), so a remounted thumbnail paints in its first frame while its request re-checks the cache. Thumbnail `<img>`s must not use `decoding="async"`, or remounted ones flash blank for a frame. The visible blocks render as one flat keyed list (`flatMap`); nested arrays would be matched by position and remount every thumbnail whenever a row enters or leaves the range.

Scheduling: a mounted `ThumbnailItem` requests its thumbnail and cancels on unmount, so queued thumbnails that were scrolled past are dropped. Misses go into a LIFO queue (the newest request is what just scrolled into view), with on-screen requests taken before those in the off-screen margin (`setThumbnailOnScreen`). Bulk resize jobs use a separate FIFO queue, at most 3 at a time, and only run when no thumbnail is waiting.

Viewer: `SlideShow` decodes the next and previous images (`preload` from App) once the current one is shown, so arrow keys and the slideshow show them without a decoding delay.

Cache files are renamed on rename and move (size and mtime are unchanged), deleted on trash and editor overwrite, and wiped by `clear_thumbnail_cache` (F5).

### Image adjustments

`adjust.js` renders every Adjust slider in one WebGL2 fragment shader. The editor's live preview renders a copy of the image at its on-screen pixel size into a `<canvas>`; saving renders the crop at full resolution into an `OffscreenCanvas`, which then goes through the same `renderOutput` downscale and encode as plain crops (neutral adjustments skip WebGL entirely). HDR and Clarity need local brightness: `luminanceMaps()` runs a self-guided filter on a ≤512 px luminance copy on the CPU, once per image, and uploads its `(a, b)` coefficients as RG16F textures; the shader evaluates `a·L + b` per pixel, which keeps edges halo-free at full resolution. The maps come from the same small copy for preview and export, so the two match. The editor decodes with `premultiplyAlpha: 'none'` so soft alpha edges keep exact colors. React StrictMode mounts effects twice in dev, so the preview renderer's cleanup deletes GL resources but never loses the canvas's context.

### Commands

| Command | Purpose |
|---|---|
| `scan_images` | Scan folders (in parallel), return `{ path, folder }[]` in folder order, each folder sorted |
| `filter_directories` | Keep the dropped paths that are folders |
| `load_config` / `save_config` | `config.json` in the data folder |
| `select_folder` | Folder picker dialog |
| `watch_folders` | Watch folders (non-recursive); image changes emit `images-updated` with a fresh scan (400 ms debounce) |
| `get_thumbnails` | Per path: `{ cached }` path if cached, `{ file }` (cache path to fill) if not, `null` if unreadable. Batched: `thumbnails.js` collects the lookups of one render, since each IPC call costs WebView2's UI thread ~3 ms |
| `save_thumbnails` | Generated thumbnails, batched over 40 ms: raw body of concatenated WebPs, `x-files` = JSON `[[cache path from get_thumbnails, length], …]` (paths validated to the cache dir) |
| `clear_thumbnail_cache` | Delete every cached thumbnail |
| `read_image_bytes` | Raw file bytes for worker / editor decoding |
| `save_edited_image` | Raw body; `x-mode`: `new` (save dialog), `sibling` (`<stem><x-suffix>.<ext>` next to the source, uniquified), `overwrite` (original to the Recycle Bin first). Copies PNG text chunks |
| `trash_image` | Recycle Bin (`trash` crate) |
| `rename_image` / `move_image` / `move_images_bulk` | Rename/move, carrying the cache entry; bulk returns `{ sourcePath, destPath, ok, error? }[]` |
| `convert_image` / `convert_images_bulk` | Re-encode to PNG or JPEG q92 (alpha onto white) with the `image` crate: PNG, JPEG, WebP, GIF, BMP, TIFF input |
| `copy_image` | CF_HDROP file drop on the clipboard (Win32, `clipboard-win`) |
| `get_image_metadata` | Size, dates, dimensions (`imagesize`, header only) and parsed SD parameters from the PNG `parameters` tEXt chunk |
| `save_text_file` | Save dialog + write |
| `set_prevent_sleep` | Keep the display awake (power request, `keepawake`) |
| `get_readme` | README.MD, compiled into the exe (in-app help) |

### Keyboard shortcuts

| Key | Action |
|---|---|
| `←` / `→` | Previous / next image |
| `Space` | Toggle play/pause (ignored when input focused) |
| `Escape` | Exit fullscreen (or close window if not fullscreen) |
| Double-click image | Toggle fullscreen |
| Scroll wheel | Zoom in/out (25%–500%) |
| Click + drag | Pan (when zoomed) |
| Right-click image | Reset zoom/pan |

### Config persistence

Saved to `config.json` on every relevant state change. Loaded once on mount. Fields: `folders`, `intervalMs`, `shuffled`, `transition`, `transitionDuration`, `sidebarTab`, `sidebarWidth`, `thumbSize`, `startupBehavior`, `lastImagePath`.

### Testing

Test-only env vars: `FOLIO_DATA_DIR` (data folder instead of `%APPDATA%\Folio`) and `FOLIO_TEST_SAVE_DIR` (answers save dialogs with that folder, without showing them). `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=N` exposes the Chrome DevTools Protocol for driving the app; `WEBVIEW2_USER_DATA_FOLDER` isolates the webview profile.

### Key constraints

- The asset protocol scope is `**` and CSP is off, so the page can load any local image (the equivalent of Electron's old `webSecurity: false`).
- PNG metadata parsing is done manually by walking chunks looking for the `parameters` key used by Stable Diffusion.
- Release builds use LTO and take a few minutes; `[profile.dev.package."*"] opt-level = 3` keeps dependency code fast in dev.
