import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  scanImages: (folders) => ipcRenderer.invoke('scan-images', folders),
  getThumbnail: (path) => ipcRenderer.invoke('get-thumbnail', path),
  trashImage: (path) => ipcRenderer.invoke('trash-image', path),
  renameImage: (oldPath, newName) => ipcRenderer.invoke('rename-image', { oldPath, newName }),
  setFullscreen: (enable) => ipcRenderer.invoke('set-fullscreen', enable),
  getFullscreen: () => ipcRenderer.invoke('get-fullscreen'),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  onFullscreenChanged: (callback) => {
    const handler = (_event, value) => callback(value)
    ipcRenderer.on('fullscreen-changed', handler)
    return () => ipcRenderer.removeListener('fullscreen-changed', handler)
  },
  copyImage: (filePath) => ipcRenderer.invoke('copy-image', filePath),
  saveTextFile: (defaultPath, content) => ipcRenderer.invoke('save-text-file', { defaultPath, content }),
  getImageMetadata: (filePath) => ipcRenderer.invoke('get-image-metadata', filePath),
  convertImage: (sourcePath, format) => ipcRenderer.invoke('convert-image', { sourcePath, format }),
  convertImagesBulk: (paths, format) => ipcRenderer.invoke('convert-images-bulk', { paths, format }),
  watchFolders: (folders) => ipcRenderer.invoke('watch-folders', folders),
  onImagesUpdated: (callback) => {
    const handler = (_event, images) => callback(images)
    ipcRenderer.on('images-updated', handler)
    return () => ipcRenderer.removeListener('images-updated', handler)
  },
})
