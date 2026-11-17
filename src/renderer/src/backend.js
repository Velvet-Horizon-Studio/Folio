// The renderer's interface to the Rust backend (src-tauri/src/main.rs). Components
// call window.folio.*; this file maps those calls onto Tauri commands, events and
// window APIs.
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'

// URL the page can load a local file from (served by the asset protocol)
export const fileUrl = (path) => convertFileSrc(path)

// An image's thumbnail, served from its folder's thumbnail file. The version token
// changes when the image does, so the webview never shows a stale cached copy.
const thumbUrl = (path, token) => `${convertFileSrc(path, 'thumb')}?v=${encodeURIComponent(token)}`

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

  // One result per path: { url } when cached, { file } (the cache path to fill) when
  // not, null if unreadable
  // Thumbnails live in a file per folder and load through the thumb:// protocol.
  // One result per path: { url } when cached, { token } (pass it to saveThumbnails)
  // when one must be generated, null if the image is unreadable.
  getThumbnails: async (paths) =>
    (await call('get_thumbnails', { paths })).map((r, i) =>
      !r ? null : r.cached ? { url: thumbUrl(paths[i], r.cached) } : { token: r.missing }),
  // items: [{ path, token (from getThumbnails), bytes: ArrayBuffer }] → one URL (or null) each
  saveThumbnails: async (items) => {
    const body = new Uint8Array(items.reduce((n, it) => n + it.bytes.byteLength, 0))
    let offset = 0
    for (const it of items) { body.set(new Uint8Array(it.bytes), offset); offset += it.bytes.byteLength }
    const files = JSON.stringify(items.map((it) => [it.path, it.token, it.bytes.byteLength]))
    const saved = await callRaw('save_thumbnails', body, { 'x-files': files }).catch(() => items.map(() => null))
    return saved.map((token, i) => (token ? thumbUrl(items[i].path, token) : null))
  },
  // Deletes these folders' thumbnail files
  reloadThumbnails: (folders) => call('clear_thumbnail_cache', { folders }),
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

  // Drops from Explorer: { type: 'enter' | 'leave' } while dragging over the window,
  // then { type: 'drop', folders, images } with the dropped folders and image files
  // (images as { path, folder }; other files are ignored)
  onDrop: (callback) => subscription(() => getCurrentWebview().onDragDropEvent(async (e) => {
    const p = e.payload
    if (p.type === 'enter') callback({ type: 'enter' })
    else if (p.type === 'leave') callback({ type: 'leave' })
    else if (p.type === 'drop') {
      callback({ type: 'leave' })
      const { folders, images } = await call('classify_drop', { paths: p.paths })
      if (folders.length || images.length) callback({ type: 'drop', folders, images })
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
