import { app, ipcMain, dialog, nativeImage, shell, Menu, MenuItem, clipboard, powerSaveBlocker } from 'electron'
import { readdirSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync, watch } from 'fs'
import { readFile, writeFile, stat, unlink, utimes } from 'fs/promises'
import { join, extname, dirname, basename } from 'path'
import { pathToFileURL } from 'url'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif', '.svg'])

// ── Disk thumbnail cache ─────────────────────────────────────────────────────
// Thumbnails are WebP files the renderer loads by file:// URL. They're generated in
// renderer Web Workers, so the main process only stats, reads and writes files.
// Name: <sha1(path)>_<sha1(size|mtime) prefix>.webp. The version part means a file
// edited outside Folio gets a fresh thumbnail; the path part lets a newer thumbnail
// replace an older one for the same image instead of leaving it behind.
const THUMB_FILE_RE = /^([0-9a-f]{40})_[0-9a-f]{16}\.webp$/
// Thumbnails not used for this long are pruned at startup (images deleted or edited
// while Folio was closed, or folders no longer loaded). Hits refresh the age.
const THUMB_MAX_AGE_MS = 90 * 24 * 3600 * 1000
const THUMB_TOUCH_AFTER_MS = 7 * 24 * 3600 * 1000

let _thumbDir = null
const thumbIndex = new Map() // sha1(path) → current cache file name
function thumbDir() {
  if (!_thumbDir) {
    _thumbDir = join(app.getPath('userData'), 'thumbnails')
    mkdirSync(_thumbDir, { recursive: true })
    for (const f of readdirSync(_thumbDir)) {
      const m = THUMB_FILE_RE.exec(f)
      // Anything else is from an older cache format (.dat data URLs, plain-hash .webp)
      if (m) thumbIndex.set(m[1], f)
      else unlink(join(_thumbDir, f)).catch(() => {})
    }
    setTimeout(pruneOldThumbs, 15000) // off the startup path
  }
  return _thumbDir
}

async function pruneOldThumbs() {
  const cutoff = Date.now() - THUMB_MAX_AGE_MS
  for (const [key, f] of [...thumbIndex]) {
    try {
      const p = join(_thumbDir, f)
      if ((await stat(p)).mtimeMs < cutoff) {
        await unlink(p)
        if (thumbIndex.get(key) === f) thumbIndex.delete(key)
      }
    } catch {}
  }
}

const pathKey = (imagePath) => createHash('sha1').update(imagePath).digest('hex')

function thumbFile(imagePath, st) {
  const version = createHash('sha1').update(`${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16)
  return join(thumbDir(), `${pathKey(imagePath)}_${version}.webp`)
}

function deleteThumbFor(imagePath) {
  thumbDir()
  const key = pathKey(imagePath)
  const f = thumbIndex.get(key)
  if (!f) return
  thumbIndex.delete(key)
  unlink(join(_thumbDir, f)).catch(() => {})
}

// After a rename/move (size and mtime unchanged), carry the cached thumbnail over
function renameThumbOnDisk(oldPath, newPath) {
  thumbDir()
  const oldKey = pathKey(oldPath)
  const f = thumbIndex.get(oldKey)
  if (!f) return
  const newKey = pathKey(newPath)
  const moved = newKey + f.slice(oldKey.length)
  try {
    renameSync(join(_thumbDir, f), join(_thumbDir, moved))
    thumbIndex.delete(oldKey)
    thumbIndex.set(newKey, moved)
  } catch {}
}
// ────────────────────────────────────────────────────────────────────────────

// Canvas re-encoding drops PNG text chunks, which is where Stable Diffusion keeps its
// generation parameters. Copy the source's tEXt/iTXt/zTXt chunks into the new PNG,
// right after IHDR (chunks carry their own CRC, so they can be copied verbatim).
function copyPngTextChunks(srcBuf, outBuf) {
  const SIG = 8
  const isPng = (b) => b.length > SIG && b.toString('hex', 0, 8) === '89504e470d0a1a0a'
  if (!isPng(srcBuf) || !isPng(outBuf)) return outBuf
  const textChunks = []
  let pos = SIG
  while (pos + 12 <= srcBuf.length) {
    const len = srcBuf.readUInt32BE(pos)
    const type = srcBuf.toString('ascii', pos + 4, pos + 8)
    const end = pos + 12 + len
    if (end > srcBuf.length) break
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') textChunks.push(srcBuf.subarray(pos, end))
    if (type === 'IEND') break
    pos = end
  }
  if (textChunks.length === 0) return outBuf
  const ihdrEnd = SIG + 12 + outBuf.readUInt32BE(SIG)
  return Buffer.concat([outBuf.subarray(0, ihdrEnd), ...textChunks, outBuf.subarray(ihdrEnd)])
}

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

  // { url } when a cached thumbnail exists, { file } (where to save one) when it
  // must be generated, null when the image itself can't be read
  ipcMain.handle('get-thumbnail', async (_event, path) => {
    try {
      const file = thumbFile(path, await stat(path))
      try {
        const st = await stat(file)
        // Keep thumbnails in use from being pruned as old
        if (Date.now() - st.mtimeMs > THUMB_TOUCH_AFTER_MS) {
          const now = new Date()
          utimes(file, now, now).catch(() => {})
        }
        return { url: pathToFileURL(file).href }
      } catch {
        return { file }
      }
    } catch {
      return null
    }
  })

  ipcMain.handle('clear-thumbnail-cache', () => {
    // Drop every cached thumbnail so the next fetch regenerates from source —
    // used by the renderer's "reload thumbnails" button.
    try {
      const dir = thumbDir()
      for (const f of readdirSync(dir)) {
        try { unlinkSync(join(dir, f)) } catch {}
      }
    } catch {}
    thumbIndex.clear()
    return true
  })

  // Raw file bytes for renderer-side (Chromium) decoding: thumbnails and the editor
  ipcMain.handle('read-image-bytes', async (_event, filePath) => {
    try {
      return await readFile(filePath)
    } catch {
      return null
    }
  })

  // Only accepts a cache file name handed out by get-thumbnail, inside the cache dir
  ipcMain.handle('save-thumbnail', async (_event, { file, bytes }) => {
    const m = typeof file === 'string' && dirname(file) === thumbDir() && THUMB_FILE_RE.exec(basename(file))
    if (!m) return null
    try {
      await writeFile(file, Buffer.from(bytes))
      // Replace the image's previous thumbnail (it was edited) rather than orphan it
      const name = basename(file)
      const prev = thumbIndex.get(m[1])
      if (prev && prev !== name) unlink(join(thumbDir(), prev)).catch(() => {})
      thumbIndex.set(m[1], name)
      return pathToFileURL(file).href
    } catch {
      return null
    }
  })

  // Resize/crop editor output. The renderer encodes the result (Chromium canvas);
  // this writes it either to a new file (save dialog) or over the original, in which
  // case the original goes to the Recycle Bin first so the overwrite can be undone.
  ipcMain.handle('save-edited-image', async (_event, { sourcePath, bytes, ext, mode }) => {
    let out = Buffer.from(bytes)
    if (ext === 'png') {
      try { out = copyPngTextChunks(readFileSync(sourcePath), out) } catch {}
    }

    let targetPath = sourcePath
    if (mode === 'new') {
      const stem = basename(sourcePath).replace(/\.[^.]+$/, '')
      const result = await dialog.showSaveDialog(win, {
        title: 'Save edited image',
        defaultPath: join(dirname(sourcePath), `${stem}_edit.${ext}`),
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      })
      if (result.canceled || !result.filePath) return null
      targetPath = result.filePath
    }

    if (existsSync(targetPath)) {
      deleteThumbFor(targetPath)
      await shell.trashItem(targetPath)
    }
    writeFileSync(targetPath, out)
    return targetPath
  })

  ipcMain.handle('trash-image', async (_event, path) => {
    try {
      deleteThumbFor(path)
      await shell.trashItem(path)
    } catch (err) {
      console.error('[trash-image] failed:', err)
      throw err
    }
  })

  ipcMain.handle('rename-image', async (_event, { oldPath, newName }) => {
    const ext = extname(oldPath)
    const newPath = join(dirname(oldPath), newName + ext)
    renameSync(oldPath, newPath)
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
