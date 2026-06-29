import { app, ipcMain, dialog, nativeImage, shell, Menu, MenuItem, clipboard, powerSaveBlocker } from 'electron'
import { readdirSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync, watch } from 'fs'
import { join, extname, dirname, basename } from 'path'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'

const thumbnailCache = new Map()

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif', '.svg'])

// ── Disk thumbnail cache ─────────────────────────────────────────────────────
let _thumbDir = null
function thumbDir() {
  if (!_thumbDir) {
    _thumbDir = join(app.getPath('userData'), 'thumbnails')
    mkdirSync(_thumbDir, { recursive: true })
  }
  return _thumbDir
}

function thumbDiskPath(imagePath) {
  const hash = createHash('sha1').update(imagePath).digest('hex')
  return join(thumbDir(), hash + '.dat')
}

function loadThumbFromDisk(imagePath) {
  try {
    const p = thumbDiskPath(imagePath)
    if (existsSync(p)) return readFileSync(p, 'utf-8')
  } catch {}
  return null
}

function saveThumbToDisk(imagePath, dataUrl) {
  try { writeFileSync(thumbDiskPath(imagePath), dataUrl, 'utf-8') } catch {}
}

function deleteThumbFromDisk(imagePath) {
  try { unlinkSync(thumbDiskPath(imagePath)) } catch {}
}

function renameThumbOnDisk(oldPath, newPath) {
  try {
    const src = thumbDiskPath(oldPath)
    if (existsSync(src)) renameSync(src, thumbDiskPath(newPath))
  } catch {}
}
// ────────────────────────────────────────────────────────────────────────────

function scanFolderForImages(folderPath) {
  const images = []
  try {
    const entries = readdirSync(folderPath)
    for (const entry of entries) {
      const fullPath = join(folderPath, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isFile() && IMAGE_EXTENSIONS.has(extname(entry).toLowerCase())) {
          images.push(fullPath)
        }
      } catch {
        // skip unreadable entries
      }
    }
  } catch {
    // skip unreadable folder
  }
  return images.sort()
}

export function registerIpcHandlers(win) {
  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('scan-images', async (_event, folders) => {
    const allImages = []
    for (const folder of folders) {
      const images = scanFolderForImages(folder)
      for (const img of images) {
        allImages.push({ path: img, folder })
      }
    }
    return allImages
  })

  ipcMain.handle('load-config', () => {
    try {
      const data = readFileSync(join(app.getPath('userData'), 'config.json'), 'utf-8')
      return JSON.parse(data)
    } catch {
      return null
    }
  })

  ipcMain.handle('save-config', (_event, config) => {
    try {
      writeFileSync(join(app.getPath('userData'), 'config.json'), JSON.stringify(config, null, 2), 'utf-8')
    } catch {
      // ignore write errors
    }
  })

  ipcMain.handle('get-thumbnail', async (_event, path) => {
    // 1. Memory cache
    if (thumbnailCache.has(path)) return thumbnailCache.get(path)
    // 2. Disk cache
    const fromDisk = loadThumbFromDisk(path)
    if (fromDisk) {
      thumbnailCache.set(path, fromDisk)
      return fromDisk
    }
    // 3. Generate and persist
    try {
      const img = nativeImage.createFromPath(path)
      if (img.isEmpty()) return null
      const thumb = img.resize({ width: 240, quality: 'good' })
      const dataUrl = thumb.toDataURL()
      thumbnailCache.set(path, dataUrl)
      saveThumbToDisk(path, dataUrl)
      return dataUrl
    } catch {
      return null
    }
  })

  ipcMain.handle('trash-image', async (_event, path) => {
    try {
      await shell.trashItem(path)
      thumbnailCache.delete(path)
      deleteThumbFromDisk(path)
    } catch (err) {
      console.error('[trash-image] failed:', err)
      throw err
    }
  })

  ipcMain.handle('rename-image', async (_event, { oldPath, newName }) => {
    const ext = extname(oldPath)
    const newPath = join(dirname(oldPath), newName + ext)
    renameSync(oldPath, newPath)
    // Update memory cache
    if (thumbnailCache.has(oldPath)) {
      thumbnailCache.set(newPath, thumbnailCache.get(oldPath))
      thumbnailCache.delete(oldPath)
    }
    // Update disk cache
    renameThumbOnDisk(oldPath, newPath)
    return newPath
  })

  ipcMain.handle('copy-image', (_event, filePath) => {
    try {
      // Put the file on the clipboard as CF_HDROP so it can be pasted in Explorer
      const lines = [
        '$ProgressPreference = "SilentlyContinue"',
        'Add-Type -AssemblyName System.Windows.Forms',
        '$col = New-Object System.Collections.Specialized.StringCollection',
        '$col.Add($env:IMG_PATH)',
        '[System.Windows.Forms.Clipboard]::SetFileDropList($col)',
      ].join('\n')
      const encoded = Buffer.from(lines, 'utf16le').toString('base64')
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        env: { ...process.env, IMG_PATH: filePath }
      })
      return true
    } catch (err) {
      console.error('[copy-image] failed:', err.message)
      return false
    }
  })

  ipcMain.handle('save-text-file', async (_event, { defaultPath, content }) => {
    const result = await dialog.showSaveDialog(win, {
      title: 'Save parameters',
      defaultPath,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    })
    if (result.canceled || !result.filePath) return false
    writeFileSync(result.filePath, content, 'utf-8')
    return true
  })

  ipcMain.handle('get-image-metadata', (_event, filePath) => {
    try {
      const stat = statSync(filePath)
      const img = nativeImage.createFromPath(filePath)
      const { width, height } = img.getSize()

      // Try PNG tEXt chunks for embedded SD parameters
      let sdRaw = null
      if (extname(filePath).toLowerCase() === '.png') {
        try {
          const buf = readFileSync(filePath)
          let offset = 8
          while (offset < buf.length - 12) {
            const chunkLen = buf.readUInt32BE(offset)
            const chunkType = buf.toString('ascii', offset + 4, offset + 8)
            if (chunkType === 'tEXt') {
              const raw = buf.toString('latin1', offset + 8, offset + 8 + chunkLen)
              const nul = raw.indexOf('\0')
              if (nul !== -1) {
                const key = raw.slice(0, nul)
                if (key === 'parameters') { sdRaw = raw.slice(nul + 1); break }
              }
            }
            if (chunkType === 'IEND') break
            offset += 12 + chunkLen
          }
        } catch {}
      }

      // 3. Parse SD parameter format
      let sd = null
      if (sdRaw) {
        const negIdx = sdRaw.indexOf('\nNegative prompt:')
        let positive, negative = null, paramStr = ''
        if (negIdx !== -1) {
          positive = sdRaw.slice(0, negIdx).trim()
          const rest = sdRaw.slice(negIdx + '\nNegative prompt:'.length)
          // Last line(s) starting with "Steps:" are the params
          const paramsMatch = rest.match(/([\s\S]*?)\n(Steps:[\s\S]+)$/)
          if (paramsMatch) {
            negative = paramsMatch[1].trim()
            paramStr = paramsMatch[2].trim()
          } else {
            negative = rest.trim()
          }
        } else {
          const paramsMatch = sdRaw.match(/([\s\S]*?)\n(Steps:[\s\S]+)$/)
          positive = paramsMatch ? paramsMatch[1].trim() : sdRaw.trim()
          paramStr = paramsMatch ? paramsMatch[2].trim() : ''
        }
        const params = {}
        for (const m of paramStr.matchAll(/([A-Za-z][\w ]*?):\s*([^,\n]+)/g)) {
          params[m[1].trim()] = m[2].trim()
        }
        sd = { positive, negative, params }
      }

      return {
        name: basename(filePath),
        ext: extname(filePath).slice(1).toUpperCase(),
        size: stat.size,
        width,
        height,
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        sd,
      }
    } catch (err) {
      console.error('[get-image-metadata] failed:', err)
      throw err
    }
  })

  ipcMain.handle('convert-images-bulk', async (_event, { paths, format }) => {
    const ext = format === 'jpeg' ? 'jpg' : format
    let success = 0, failed = 0
    for (const sourcePath of paths) {
      try {
        const stem = basename(sourcePath).replace(/\.[^.]+$/, '')
        const outPath = join(dirname(sourcePath), `${stem}.${ext}`)
        const img = nativeImage.createFromPath(sourcePath)
        const buffer = format === 'jpeg' ? img.toJPEG(92) : img.toPNG()
        writeFileSync(outPath, buffer)
        success++
      } catch {
        failed++
      }
    }
    return { success, failed }
  })

  ipcMain.handle('move-images-bulk', async (_event, { paths, targetFolder }) => {
    const results = []
    for (const sourcePath of paths) {
      const name = basename(sourcePath)
      const destPath = join(targetFolder, name)
      try {
        if (sourcePath !== destPath) {
          renameSync(sourcePath, destPath)
          if (thumbnailCache.has(sourcePath)) {
            thumbnailCache.set(destPath, thumbnailCache.get(sourcePath))
            thumbnailCache.delete(sourcePath)
          }
          renameThumbOnDisk(sourcePath, destPath)
        }
        results.push({ sourcePath, destPath, ok: true })
      } catch (err) {
        results.push({ sourcePath, destPath, ok: false, error: err.message })
      }
    }
    return results
  })

  ipcMain.handle('move-image', async (_event, { sourcePath, targetFolder }) => {
    const name = basename(sourcePath)
    const destPath = join(targetFolder, name)
    if (sourcePath === destPath) return sourcePath
    renameSync(sourcePath, destPath)
    if (thumbnailCache.has(sourcePath)) {
      thumbnailCache.set(destPath, thumbnailCache.get(sourcePath))
      thumbnailCache.delete(sourcePath)
    }
    renameThumbOnDisk(sourcePath, destPath)
    return destPath
  })

  ipcMain.handle('convert-image', async (_event, { sourcePath, format }) => {
    const ext = format === 'jpeg' ? 'jpg' : format
    const stem = basename(sourcePath).replace(/\.[^.]+$/, '')
    const result = await dialog.showSaveDialog(win, {
      title: `Save as ${format.toUpperCase()}`,
      defaultPath: join(dirname(sourcePath), `${stem}.${ext}`),
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    })
    if (result.canceled || !result.filePath) return null
    try {
      const img = nativeImage.createFromPath(sourcePath)
      const buffer = format === 'jpeg' ? img.toJPEG(92) : img.toPNG()
      writeFileSync(result.filePath, buffer)
      return result.filePath
    } catch (err) {
      console.error('[convert-image] failed:', err)
      throw err
    }
  })

  // ── Folder watchers ─────────────────────────────────────────────────────
  const folderWatchers = new Map()
  let watchDebounce = null
  let watchedPaths = []

  ipcMain.handle('watch-folders', (_event, folders) => {
    watchedPaths = folders
    // Tear down existing watchers
    for (const w of folderWatchers.values()) { try { w.close() } catch {} }
    folderWatchers.clear()

    for (const folder of folders) {
      try {
        const w = watch(folder, (_eventType, filename) => {
          if (!filename) return
          if (!IMAGE_EXTENSIONS.has(extname(filename).toLowerCase())) return
          clearTimeout(watchDebounce)
          watchDebounce = setTimeout(() => {
            const allImages = []
            for (const f of watchedPaths) {
              for (const img of scanFolderForImages(f)) {
                allImages.push({ path: img, folder: f })
              }
            }
            win.webContents.send('images-updated', allImages)
          }, 400)
        })
        folderWatchers.set(folder, w)
      } catch {
        // folder not accessible, skip
      }
    }
  })
  // ────────────────────────────────────────────────────────────────────────

  // ── Display-sleep blocker ───────────────────────────────────────────────
  let powerSaveBlockerId = null
  ipcMain.handle('set-prevent-sleep', (_event, enable) => {
    if (enable) {
      if (powerSaveBlockerId === null || !powerSaveBlocker.isStarted(powerSaveBlockerId)) {
        powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep')
      }
    } else if (powerSaveBlockerId !== null) {
      if (powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId)
      powerSaveBlockerId = null
    }
    return powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)
  })
  // ────────────────────────────────────────────────────────────────────────

  ipcMain.handle('get-readme', () => {
    // README ships at the project root in dev, and in resources/ when packaged
    const readmePath = app.isPackaged
      ? join(process.resourcesPath, 'README.MD')
      : join(app.getAppPath(), 'README.MD')
    try {
      return readFileSync(readmePath, 'utf-8')
    } catch (err) {
      console.error('[get-readme] failed:', err)
      return null
    }
  })

  ipcMain.handle('set-fullscreen', (_event, enable) => {
    win.setFullScreen(enable)
  })

  ipcMain.handle('get-fullscreen', () => {
    return win.isFullScreen()
  })

  win.webContents.on('context-menu', (_e, params) => {
    if (!params.selectionText) return
    const menu = new Menu()
    menu.append(new MenuItem({ label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => win.webContents.copy() }))
    menu.popup({ window: win })
  })

  win.on('enter-full-screen', () => {
    win.webContents.send('fullscreen-changed', true)
  })

  win.on('leave-full-screen', () => {
    win.webContents.send('fullscreen-changed', false)
  })
}
