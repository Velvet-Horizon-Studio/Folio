// The renderer's interface to the Rust backend (src-tauri/src/main.rs). Components
// call window.folio.*; this file maps those calls onto Tauri commands, events and
// window APIs.
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'

// URL the page can load a local file from (served by the asset protocol)
export const fileUrl = (path) => convertFileSrc(path)

// Commands reject with a plain string; the renderer expects Error objects (err.message)
const call = (cmd, args, options) =>
  invoke(cmd, args, options).catch((e) => { throw e instanceof Error ? e : new Error(String(e)) })

// Large payloads go as a raw body (no JSON number arrays); their other arguments ride
// in headers, percent-encoded because paths aren't ASCII-safe
const callRaw = (cmd, bytes, headers) =>
  call(cmd, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, encodeURIComponent(v ?? '')])),
  })

// Wraps a Tauri listener registration (which resolves to its unlisten function) so the
// caller gets an unsubscribe function right away, as React effects need
function subscription(register) {
  let unlisten = null, done = false
  register().then((fn) => { if (done) fn(); else unlisten = fn })
  return () => { done = true; unlisten?.() }
}

const win = getCurrentWindow()

window.folio = {
  selectFolder: () => call('select_folder'),
  scanImages: (folders) => call('scan_images', { folders }),
  watchFolders: (folders) => call('watch_folders', { folders }),
  onImagesUpdated: (callback) => subscription(() => listen('images-updated', (e) => callback(e.payload))),
  loadConfig: () => call('load_config').catch(() => null),
  saveConfig: (config) => call('save_config', { config }).catch(() => {}),

  // { url } when cached, { file } (the cache path to fill) when not, null if unreadable
  getThumbnail: async (path) => {
    const r = await call('get_thumbnail', { path })
    if (!r) return null
    return r.cached ? { url: convertFileSrc(r.cached) } : { file: r.file }
  },
  saveThumbnail: (file, bytes) =>
    callRaw('save_thumbnail', bytes, { 'x-file': file }).then((p) => (p ? convertFileSrc(p) : null)).catch(() => null),
  reloadThumbnails: () => call('clear_thumbnail_cache'),
  readImageBytes: (path) => call('read_image_bytes', { path }).then((b) => new Uint8Array(b)).catch(() => null),

  saveEditedImage: (sourcePath, bytes, ext, mode, suffix) =>
    callRaw('save_edited_image', bytes, { 'x-source': sourcePath, 'x-ext': ext, 'x-mode': mode ?? 'new', 'x-suffix': suffix ?? '' }),
  trashImage: (path) => call('trash_image', { path }),
  renameImage: (oldPath, newName) => call('rename_image', { oldPath, newName }),
  moveImage: (sourcePath, targetFolder) => call('move_image', { sourcePath, targetFolder }),
  moveImagesBulk: (paths, targetFolder) => call('move_images_bulk', { paths, targetFolder }),
  convertImage: (sourcePath, format) => call('convert_image', { sourcePath, format }),
  convertImagesBulk: (paths, format) => call('convert_images_bulk', { paths, format }),
  copyImage: (filePath) => call('copy_image', { filePath }),
  getImageMetadata: (filePath) => call('get_image_metadata', { filePath }),
  saveTextFile: (defaultPath, content) => call('save_text_file', { defaultPath, content }),

  setPreventSleep: (enable) => call('set_prevent_sleep', { enable }),
  getReadme: () => call('get_readme').catch(() => null),
  setFullscreen: (enable) => win.setFullscreen(enable),
  getFullscreen: () => win.isFullscreen(),
  // There is no fullscreen event: check after each resize and report changes
  onFullscreenChanged: (callback) => {
    let last = null
    win.isFullscreen().then((fs) => { last = fs })
    return subscription(() => win.onResized(async () => {
      const fs = await win.isFullscreen()
      if (fs !== last) { last = fs; callback(fs) }
    }))
  },

  // Folder drops from Explorer: { type: 'enter' | 'leave' } while dragging over the
  // window, then { type: 'drop', folders } with the dropped paths that are folders
  onFolderDrag: (callback) => subscription(() => getCurrentWebview().onDragDropEvent(async (e) => {
    const p = e.payload
    if (p.type === 'enter') callback({ type: 'enter' })
    else if (p.type === 'leave') callback({ type: 'leave' })
    else if (p.type === 'drop') {
      callback({ type: 'leave' })
      const folders = await call('filter_directories', { paths: p.paths })
      if (folders.length) callback({ type: 'drop', folders })
    }
  })),
}

// window.close() doesn't close a Tauri window by itself
window.close = () => { win.close() }

// No browser context menu (Back, Refresh, Print…) except on selected text and inputs;
// Folio's own menus call preventDefault themselves
document.addEventListener('contextmenu', (e) => {
  const editable = e.target.closest?.('input, textarea, [contenteditable="true"]')
  if (!editable && !window.getSelection()?.toString()) e.preventDefault()
})
