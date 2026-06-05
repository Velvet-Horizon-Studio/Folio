# CLAUDE.md

## Commands

```bash
npm run dev        # Start in development mode (Vite hot-reload for renderer; restart required for main/preload)
npm run build      # Production build (electron-vite build → out/)
npm run package    # Build + package as Windows portable .exe (dist/Folio-portable.exe)
```

> **Important:** Changes to `src/main/` or `src/preload/` are **not** hot-reloaded. Stop and restart `npm run dev` after editing those files.

---

## Architecture

Electron + React desktop app built with `electron-vite`. Windows-only portable executable.

### Process boundary

```
src/main/
  index.js          ← BrowserWindow creation, app lifecycle
  ipc-handlers.js   ← All IPC channels: file I/O, thumbnails, metadata, folder watching

src/preload/
  index.js          ← contextBridge — exposes window.electronAPI.* to renderer

src/renderer/src/
  App.jsx                        ← Root state owner; all business logic
  components/FolderManager.jsx   ← Folder list + startup behavior setting
  components/ThumbnailBrowser.jsx← Thumbnail grid, context menu, bulk actions
  components/SlideShow.jsx       ← Main image viewer with transitions and zoom/pan
  components/Controls.jsx        ← Playback controls bar
```

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

`imagesRef` and `currentIndexRef` are kept in sync with their state counterparts so IPC callbacks (set up once) always see current values.

`startupBehaviorRef` is a ref kept in sync with `startupBehavior` state so the async scan callback always reads the current value without being in the dependency array.

### Startup / image restore

Config is loaded once on mount. `lastImagePathRef.current` is set synchronously inside the `.then()` before React processes state updates. The folders effect (`[folders, shuffled]`) reads the ref after the async `scanImages` call resolves.

**Important:** `lastImagePath` is only written to config when `images.length > 0` — never while the list is empty (e.g. during the async scan) — to avoid wiping the saved path on every startup.

### Thumbnail cache

Two-tier: in-memory `Map` + SHA-1-keyed files in `app.getPath('userData')/thumbnails/`. Generated via `nativeImage.resize({ width: 240 })`. Cache entries are updated on rename and move, deleted on trash.

### IPC channels

| Channel | Direction | Purpose |
|---|---|---|
| `scan-images` | renderer→main | Scan folders, return `{ path, folder }[]` |
| `get-thumbnail` | renderer→main | Return data URL (memory → disk → generate) |
| `watch-folders` | renderer→main | Set up fs.watch on folders |
| `images-updated` | main→renderer | Push new image list after fs change |
| `trash-image` | renderer→main | Move file to Recycle Bin |
| `rename-image` | renderer→main | Rename file, update cache |
| `move-image` | renderer→main | Move single file to another folder |
| `move-images-bulk` | renderer→main | Move multiple files, return `{ sourcePath, destPath, ok }[]` |
| `convert-image` | renderer→main | Convert with save dialog |
| `convert-images-bulk` | renderer→main | Convert in-place, return `{ success, failed }` |
| `copy-image` | renderer→main | CF_HDROP clipboard via PowerShell |
| `get-image-metadata` | renderer→main | PNG tEXt chunk parser for SD params |
| `save-text-file` | renderer→main | Save dialog + write |
| `load-config` / `save-config` | renderer→main | JSON config in userData |
| `select-folder` | renderer→main | Open folder picker dialog |
| `set-fullscreen` / `get-fullscreen` | renderer→main | Fullscreen toggle |
| `fullscreen-changed` | main→renderer | Window fullscreen state change |

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

Saved to `userData/config.json` on every relevant state change. Loaded once on mount. Fields: `folders`, `intervalMs`, `shuffled`, `transition`, `transitionDuration`, `sidebarTab`, `sidebarWidth`, `thumbSize`, `startupBehavior`, `lastImagePath`.

### Key constraints

- `webSecurity: false` is set to allow loading local file URLs as image src.
- Clipboard file copy uses PowerShell `System.Windows.Forms.Clipboard::SetFileDropList` (CF_HDROP) because Electron's clipboard API doesn't support file drops on Windows.
- PNG metadata parsing is done manually (no external libs) by walking tEXt chunks looking for the `parameters` key used by Stable Diffusion.
- `src/main/` and `src/preload/` changes require a full dev server restart — electron-vite only hot-reloads the renderer.
