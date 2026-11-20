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
  src/thumbs.rs     ← thumbnail packs (one Folio.thumbs per folder)
  src/png.rs        ← PNG text-chunk copy + Stable Diffusion parameter parsing
  src/meta.rs       ← text metadata (PNG text, EXIF, XMP, JPEG comments) without decoding pixels + the search index
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
- Explorer drops: the webview's HTML5 drop events carry no paths, so `onDrop` reports the native drag-drop events and `classify_drop` sorts the paths into folders (added) and image files. A dropped image becomes `pendingJumpRef` in App.jsx: its folder is added or switched on if needed, and the folder scan (or the watcher, or the current list if the folder is already showing) jumps to it. Native drop handling also disables HTML5 drag and drop inside the webview on Windows, which is why folder reordering uses pointer events. Don't add HTML5 DnD.
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
| `searchQuery` / `matches` | Metadata search: the query, and the `Set` of matching paths (`null` when not searching) |

`imagesRef` and `currentIndexRef` are kept in sync with their state counterparts so event callbacks (set up once) always see current values.

While `matches` is set, the grid shows only the matches, and `stepIndex()` makes arrow keys, the slideshow and preloading skip the rest; the counters show the position among the matches (`viewIndex` / `viewTotal`). When a search's results don't include the current image, the viewer goes to the first match.

`startupBehaviorRef` is a ref kept in sync with `startupBehavior` state so the async scan callback always reads the current value without being in the dependency array.

### Startup / image restore

Config is loaded once on mount. `lastImagePathRef.current` is set synchronously inside the `.then()` before React processes state updates. The folders effect (`[folders, shuffled]`) reads the ref after the async `scanImages` call resolves.

**Important:** `lastImagePath` is only written to config when `images.length > 0` — never while the list is empty (e.g. during the async scan) — to avoid wiping the saved path on every startup.

### Data folder

`%APPDATA%\Folio` (the Folio 1.1 Electron userData folder, so upgrades keep the config): `config.json` (pretty JSON, key order preserved) and `thumbnails/` (fallback thumbnail packs only, see below). WebView2's own data goes to `%LOCALAPPDATA%\com.velvethorizon.folio`.

### Thumbnail cache

One pack file per folder (`thumbs.rs`), like PaintShop Pro's browser file: `Folio.thumbs`, hidden, next to the images. Folders that can't be written to (read-only media, protected folders) use `thumbnails/<sha1(lowercase folder)>.thumbs` in the data folder instead; those unused for 90 days are deleted. A pack is an append-only log: magic `FOLIOTB1`, then records `u32 len | u8 kind | u16 name len | name | u64 image size | i64 image mtime ns | WebP` (kind 1 = thumbnail, 2 = deletion; later records win). A thumbnail is current while the image's size and mtime match, so editing a file outside Folio invalidates it. `get_thumbnails` hands out that version as a string token; the renderer passes it back to `save_thumbnails`, and thumbnails load from `thumb://<encoded image path>?v=<token>` (served from the pack by `serve_thumbnail`). Each pack's index is loaded on first use and reloaded if the file changes underneath (length/mtime). A damaged tail (a write cut short) is cut off by the next save. After every `scan_images`, `tidy` rewrites a pack without dead records (replaced, deleted, or images no longer in the folder) once they're ≥ 25 % and ≥ 512 KB of it, and deletes the pack when its folder has no images left (not when the folder is unreachable). Rename and move carry the thumbnail (move: into the destination folder's pack); trash and editor overwrite delete it. Hidden files must be opened without truncation (`CREATE_ALWAYS` fails on them), hence `set_len` + seek. The loose per-image `.webp` files of Folio ≤ 1.2.1 are deleted from `thumbnails/` 5 s after startup.

Generation happens in the renderer (`thumbnails.js`). A pool of Web Workers (`imageWorker.js`, inlined via `?worker&inline`, at most 8 or cores − 2; a worker that crashes or exceeds its job timeout is terminated and replaced; all are shut down after 8 s idle) fetches the file itself through the asset protocol (`cache: 'no-store'`, so file bytes never cross the UI thread) and decodes with Chromium (`createImageBitmap`), so every format WebView2 knows works, including WebP saved as `.jpg`. Each worker resizes to a shortest side of 320 px (long side capped at 1280) and encodes WebP q0.82. The backend only stats images and stores the WebP bytes. SVGs use the file itself.

The grid is virtualized (`computeLayout` in `ThumbnailBrowser.jsx`): thumbnails and folder labels are absolutely positioned on a canvas, and only those within 1.5 viewport heights of it are mounted (a fast wheel flick is scrolled by the compositor ahead of the UI thread, so a small margin shows empty space), so a folder of thousands of images renders like a few screenfuls. The layout constants (`GAP`, `PAD_*`, `LABEL_H`) must match `ThumbnailBrowser.css`. `ThumbnailItem` and `ThumbnailBrowser` are memoized, so changing the current image re-renders only the two thumbnails involved. `thumbnails.js` remembers each image's last thumbnail URL (`peekThumbnail`, cleared on F5) and keeps the 600 most recently shown ones loaded in `Image` objects (pinning the small files in Chromium's memory cache), so a remounted thumbnail paints in its first frame while its request re-checks the cache. Thumbnail `<img>`s must not use `decoding="async"`, or remounted ones flash blank for a frame. The visible blocks render as one flat keyed list (`flatMap`); nested arrays would be matched by position and remount every thumbnail whenever a row enters or leaves the range.

Scheduling: a mounted `ThumbnailItem` requests its thumbnail and cancels on unmount, so queued thumbnails that were scrolled past are dropped. Misses go into a LIFO queue (the newest request is what just scrolled into view), with on-screen requests taken before those in the off-screen margin (`setThumbnailOnScreen`). Bulk resize jobs use a separate FIFO queue, at most 3 at a time, and only run when no thumbnail is waiting.

Viewer: `SlideShow` decodes the next and previous images (`preload` from App) once the current one is shown, so arrow keys and the slideshow show them without a decoding delay.

F5 (`clear_thumbnail_cache`) deletes the packs of the active folders.

### Image adjustments

`adjust.js` renders every Adjust slider in one WebGL2 fragment shader. The editor's live preview renders a copy of the image at its on-screen pixel size into a `<canvas>`; saving renders the crop at full resolution into an `OffscreenCanvas`, which then goes through the same `renderOutput` downscale and encode as plain crops (neutral adjustments skip WebGL entirely). HDR and Clarity need local brightness: `luminanceMaps()` runs a self-guided filter on a ≤512 px luminance copy on the CPU, once per image, and uploads its `(a, b)` coefficients as RG16F textures; the shader evaluates `a·L + b` per pixel, which keeps edges halo-free at full resolution. The maps come from the same small copy for preview and export, so the two match. The editor decodes with `premultiplyAlpha: 'none'` so soft alpha edges keep exact colors. React StrictMode mounts effects twice in dev, so the preview renderer's cleanup deletes GL resources but never loses the canvas's context.

### Commands

| Command | Purpose |
|---|---|
| `scan_images` | Scan folders (in parallel), return `{ path, folder }[]` in folder order, each folder sorted |
| `classify_drop` | Dropped paths → `{ folders, images: [{ path, folder }] }` (other files ignored) |
| `load_config` / `save_config` | `config.json` in the data folder |
| `select_folder` | Folder picker dialog |
| `watch_folders` | Watch folders (non-recursive); image changes emit `images-updated` with a fresh scan (400 ms debounce) |
| `get_thumbnails` | Per path: `{ cached: token }` if its folder's pack has a current thumbnail, `{ missing: token }` if one must be generated, `null` if unreadable. Batched: `thumbnails.js` collects the lookups of one render, since each IPC call costs WebView2's UI thread ~3 ms |
| `save_thumbnails` | Generated thumbnails, batched over 40 ms, appended to their folders' packs: raw body of concatenated WebPs, `x-files` = JSON `[[image path, token, length], …]` |
| `clear_thumbnail_cache` | Delete the packs of the given folders (F5) |
| `thumb://` protocol | A thumbnail's WebP from its folder's pack |
| `read_image_bytes` | Raw file bytes for worker / editor decoding |
| `save_edited_image` | Raw body; `x-mode`: `new` (save dialog), `sibling` (`<stem><x-suffix>.<ext>` next to the source, uniquified), `overwrite` (original to the Recycle Bin first). Copies PNG text chunks |
| `trash_image` | Recycle Bin (`trash` crate) |
| `rename_image` / `move_image` / `move_images_bulk` | Rename/move, carrying the cache entry; bulk returns `{ sourcePath, destPath, ok, error? }[]` |
| `convert_image` / `convert_images_bulk` | Re-encode to PNG or JPEG q92 (alpha onto white) with the `image` crate: PNG, JPEG, WebP, GIF, BMP, TIFF input |
| `copy_image` | CF_HDROP file drop on the clipboard (Win32, `clipboard-win`) |
| `get_image_metadata` | Size, dates, dimensions (`imagesize`, header only), parsed SD parameters (PNG `parameters` chunk, or an A1111 EXIF user comment in JPEG/WebP) and `fields`: other text metadata as `[label, value]` pairs (`meta.rs`) |
| `search_images` | Indexes into `paths` of the images whose file name, dimensions or text metadata contain every query term (`"phrase"`, `-exclude`, case-insensitive). `meta.rs` reads only the metadata blocks (PNG chunks are skipped by seeking, JPEG stops at SOS), and keeps each image's lowercased search text in memory while its size and mtime match (≤ 64 KB per image; ComfyUI JSON reduced to its strings). An empty query warms the index (the search box does this on focus) and forgets unlisted paths |
| `save_text_file` | Save dialog + write |
| `set_prevent_sleep` | Keep the display awake (power request, `keepawake`) |
| `get_readme` | README.MD, compiled into the exe (in-app help) |

### Keyboard shortcuts

| Key | Action |
|---|---|
| `←` / `→` | Previous / next image |
| `Space` | Toggle play/pause (ignored when input focused) |
| `Ctrl+F` | Focus the metadata search (Escape in it clears it, never closes the window) |
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
