// URL the page can load a local file from. Electron loads file:// directly
// (webSecurity is off); the Tauri bridge serves files through the asset protocol.
export function fileUrl(path) {
  return window.electronAPI.fileUrl ? window.electronAPI.fileUrl(path) : `file:///${path.replace(/\\/g, '/')}`
}
