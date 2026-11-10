// Tauri backend for the shared renderer. The React app talks to window.electronAPI
// (set by the Electron preload); under Tauri this file provides the same API on top
// of the Rust commands in src-tauri/src/main.rs, so no component needs to know which
// backend it runs on.
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// Commands reject with a plain string; the renderer expects Error objects (err.message)
const call = (cmd, args, options) =>
  invoke(cmd, args, options).catch((e) => { throw e instanceof Error ? e : new Error(String(e)) })

// Large payloads go as a raw body (no JSON number arrays); their other arguments ride
// in headers, percent-encoded because paths aren't ASCII-safe
const callRaw = (cmd, bytes, headers) =>
  call(cmd, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, encodeURIComponent(v ?? '')])),
  })

// Subscribe to a backend event; returns an unsubscribe function right away
function subscribe(event, callback) {
  let unlisten = null, done = false
  listen(event, (e) => callback(e.payload)).then((fn) => { if (done) fn(); else unlisten = fn })
  return () => { done = true; unlisten?.() }
}

if (isTauri) {
  const win = getCurrentWindow()

  window.electronAPI = {
    fileUrl: (path) => convertFileSrc(path),
    selectFolder: () => call('select_folder'),
    scanImages: (folders) => call('scan_images', { folders }),
    getThumbnail: async (path) => {
      const r = await call('get_thumbnail', { path })
      if (!r) return null
      return r.cached ? { url: convertFileSrc(r.cached) } : { file: r.file }
    },
    reloadThumbnails: () => call('clear_thumbnail_cache'),
    readImageBytes: (path) => call('read_image_bytes', { path }).then((b) => new Uint8Array(b)).catch(() => null),
    saveThumbnail: (file, bytes) =>
      callRaw('save_thumbnail', bytes, { 'x-file': file }).then((p) => (p ? convertFileSrc(p) : null)).catch(() => null),
    saveEditedImage: (sourcePath, bytes, ext, mode, suffix) =>
      callRaw('save_edited_image', bytes, { 'x-source': sourcePath, 'x-ext': ext, 'x-mode': mode ?? 'new', 'x-suffix': suffix ?? '' }),
    trashImage: (path) => call('trash_image', { path }),
    renameImage: (oldPath, newName) => call('rename_image', { oldPath, newName }),
    setFullscreen: (enable) => win.setFullscreen(enable),
    setPreventSleep: (enable) => call('set_prevent_sleep', { enable }),
    getReadme: () => call('get_readme').catch(() => null),
    getFullscreen: () => win.isFullscreen(),
    loadConfig: () => call('load_config').catch(() => null),
    saveConfig: (config) => call('save_config', { config }).catch(() => {}),
    // Tauri has no fullscreen event: check after each resize, report changes
    onFullscreenChanged: (callback) => {
      let last = null
      let unlisten = null, done = false
      win.onResized(async () => {
        const fs = await win.isFullscreen()
        if (fs !== last) { last = fs; callback(fs) }
      }).then((fn) => { if (done) fn(); else unlisten = fn })
      win.isFullscreen().then((fs) => { last = fs })
      return () => { done = true; unlisten?.() }
    },
    copyImage: (filePath) => call('copy_image', { filePath }),
    saveTextFile: (defaultPath, content) => call('save_text_file', { defaultPath, content }),
    getImageMetadata: (filePath) => call('get_image_metadata', { filePath }),
    convertImage: (sourcePath, format) => call('convert_image', { sourcePath, format }),
    convertImagesBulk: (paths, format) => call('convert_images_bulk', { paths, format }),
    moveImage: (sourcePath, targetFolder) => call('move_image', { sourcePath, targetFolder }),
    moveImagesBulk: (paths, targetFolder) => call('move_images_bulk', { paths, targetFolder }),
    watchFolders: (folders) => call('watch_folders', { folders }),
    onImagesUpdated: (callback) => subscribe('images-updated', callback),

    // Folder drops from Explorer. The webview hands HTML5 drops no file paths, so the
    // window's native drag-drop events report them instead.
    onFolderDrag: (callback) => {
      let unlisten = null, done = false
      getCurrentWebview().onDragDropEvent(async (e) => {
        const p = e.payload
        if (p.type === 'enter') callback({ type: 'enter' })
        else if (p.type === 'leave') callback({ type: 'leave' })
        else if (p.type === 'drop') {
          callback({ type: 'leave' })
          const folders = await call('filter_directories', { paths: p.paths })
          if (folders.length) callback({ type: 'drop', folders })
        }
      }).then((fn) => { if (done) fn(); else unlisten = fn })
      return () => { done = true; unlisten?.() }
    },
  }

  // window.close() doesn't close a Tauri window by itself
  window.close = () => { win.close() }

  // Electron showed no browser context menu except Copy on selected text; WebView2's
  // default menu (Back, Refresh, Print…) is suppressed the same way
  document.addEventListener('contextmenu', (e) => {
    const editable = e.target.closest?.('input, textarea, [contenteditable="true"]')
    if (!editable && !window.getSelection()?.toString()) e.preventDefault()
  })
}
