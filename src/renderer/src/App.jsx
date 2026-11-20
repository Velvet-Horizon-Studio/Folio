import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import FolderManager from './components/FolderManager'
import ThumbnailBrowser from './components/ThumbnailBrowser'
import SlideShow from './components/SlideShow'
import Controls from './components/Controls'
import HelpOverlay from './components/HelpOverlay'
import ImageEditor from './components/ImageEditor'
import { forgetThumbnails } from './thumbnails'
import './styles/App.css'


// Compare paths the way Windows does: separators, trailing slash and case don't matter
const normPath = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// Index of the next image in direction dir (±1), skipping images outside the search
// results (matches: Set of paths, or null when not searching)
function stepIndex(list, matches, i, dir) {
  const n = list.length
  if (n === 0) return 0
  if (!matches) return (((i + dir) % n) + n) % n
  for (let k = 1; k <= n; k++) {
    const j = (((i + dir * k) % n) + n) % n
    if (matches.has(list[j].path)) return j
  }
  return i
}

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export default function App() {
  // folders: [{ path: string, active: boolean }]
  const [folders, setFolders] = useState([])
  const [images, setImages] = useState([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [intervalMs, setIntervalMs] = useState(3000)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [shuffled, setShuffled] = useState(false)
  const [transition, setTransition] = useState('fade')
  const [transitionDuration, setTransitionDuration] = useState(600)
  const [loading, setLoading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [sidebarTab, setSidebarTab] = useState('folders')
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [thumbSize, setThumbSize] = useState(80)
  const [startupBehavior, setStartupBehavior] = useState('resume')
  const [keepAwake, setKeepAwake] = useState(false)
  const startupBehaviorRef = useRef('resume')
  const sidebarResizing = useRef(false)
  const timerRef = useRef(null)
  const configReady = useRef(false)
  const lastImagePathRef = useRef(null)
  // Refs kept in sync so IPC callbacks (set up once) always see current values
  const imagesRef = useRef([])
  const currentIndexRef = useRef(0)
  const foldersRef = useRef([])
  // An image dropped on the window, shown as soon as it's in the list (its folder may
  // still be scanning): { path, until }. Dropped if it doesn't show up within 10 s.
  const pendingJumpRef = useRef(null)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [helpText, setHelpText] = useState(null)
  const [thumbReloadKey, setThumbReloadKey] = useState(0)
  const [editPath, setEditPath] = useState(null) // image open in the resize/crop editor
  const [editVersions, setEditVersions] = useState({}) // path → bump count after an overwrite
  const hideTimerRef = useRef(null)
  // Metadata search: the query typed, and the matching paths (null when not searching)
  const [searchQuery, setSearchQuery] = useState('')
  const [matches, setMatches] = useState(null)
  const [searching, setSearching] = useState(false)
  const matchesRef = useRef(null)
  const searchSeq = useRef(0)
  const searchInputRef = useRef(null)

  // Load saved config on first mount
  useEffect(() => {
    window.folio.loadConfig().then((cfg) => {
      if (cfg) {
        if (Array.isArray(cfg.folders)) {
          // Migrate old string[] format to { path, active }[]
          setFolders(cfg.folders.map((f) =>
            typeof f === 'string' ? { path: f, active: true } : f
          ))
        }
        if (typeof cfg.intervalMs === 'number')        setIntervalMs(cfg.intervalMs)
        if (typeof cfg.shuffled === 'boolean')          setShuffled(cfg.shuffled)
        if (typeof cfg.transition === 'string')         setTransition(cfg.transition)
        if (typeof cfg.transitionDuration === 'number') setTransitionDuration(cfg.transitionDuration)
        if (typeof cfg.sidebarTab === 'string')         setSidebarTab(cfg.sidebarTab)
        if (typeof cfg.sidebarWidth === 'number')       setSidebarWidth(cfg.sidebarWidth)
        if (typeof cfg.thumbSize === 'number')          setThumbSize(cfg.thumbSize)
        if (typeof cfg.startupBehavior === 'string') {
          setStartupBehavior(cfg.startupBehavior)
          startupBehaviorRef.current = cfg.startupBehavior
        }
        if (typeof cfg.keepAwake === 'boolean')         setKeepAwake(cfg.keepAwake)
        if (typeof cfg.lastImagePath === 'string')      lastImagePathRef.current = cfg.lastImagePath
      }
      configReady.current = true
    })
  }, [])

  // Persist settings whenever they change (after initial load)
  useEffect(() => {
    if (!configReady.current) return
    const payload = {
      folders, intervalMs, shuffled, transition, transitionDuration,
      sidebarTab, sidebarWidth, thumbSize, startupBehavior, keepAwake,
    }
    // Only overwrite lastImagePath once images are loaded so we don't
    // clobber the saved path during the async scan on startup
    if (images.length > 0) payload.lastImagePath = images[currentIndex]?.path ?? null
    window.folio.saveConfig(payload)
  }, [folders, intervalMs, shuffled, transition, transitionDuration,
      sidebarTab, sidebarWidth, thumbSize, startupBehavior, keepAwake, currentIndex, images])

  // Keep the display awake only while a slideshow is actively playing
  useEffect(() => {
    window.folio.setPreventSleep(keepAwake && isPlaying)
  }, [keepAwake, isPlaying])

  useEffect(() => { imagesRef.current = images }, [images])
  useEffect(() => { foldersRef.current = folders }, [folders])

  // Index of the pending dropped image in `list` (and clear it), or -1
  function takePendingJump(list) {
    const pending = pendingJumpRef.current
    if (!pending) return -1
    if (Date.now() > pending.until) { pendingJumpRef.current = null; return -1 }
    const target = normPath(pending.path)
    const idx = list.findIndex((img) => normPath(img.path) === target)
    if (idx >= 0) pendingJumpRef.current = null
    return idx
  }
  useEffect(() => { currentIndexRef.current = currentIndex }, [currentIndex])
  useEffect(() => { startupBehaviorRef.current = startupBehavior }, [startupBehavior])

  // Sync fullscreen state from the window
  useEffect(() => {
    const unsubscribe = window.folio.onFullscreenChanged((val) => {
      setIsFullscreen(val)
    })
    return unsubscribe
  }, [])

  // Escape: close help overlay, else exit fullscreen, else close the window
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape') return
      if (helpText !== null) {
        setHelpText(null)
      } else if (isFullscreen) {
        window.folio.setFullscreen(false)
      } else {
        window.close()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isFullscreen, helpText])

  // Reload images whenever active folders change
  useEffect(() => {
    const activePaths = folders.filter((f) => f.active).map((f) => f.path)
    if (activePaths.length === 0) {
      window.folio.watchFolders([])
      setImages([])
      setCurrentIndex(0)
      setIsPlaying(false)
      return
    }
    window.folio.watchFolders(activePaths)
    setLoading(true)
    window.folio.scanImages(activePaths).then((imgs) => {
      const list = shuffled ? shuffle(imgs) : imgs
      setImages(list)
      const behavior = startupBehaviorRef.current
      const savedPath = lastImagePathRef.current
      lastImagePathRef.current = null
      const dropped = takePendingJump(list)
      if (dropped >= 0) {
        setCurrentIndex(dropped)
      } else if (behavior === 'resume' && savedPath) {
        const norm = (p) => p.replace(/\\/g, '/').toLowerCase()
        const idx = list.findIndex((img) => norm(img.path) === norm(savedPath))
        setCurrentIndex(idx >= 0 ? idx : 0)
      } else if (behavior === 'last') {
        // Find the visually-last image respecting folder order, then locate in (possibly shuffled) list
        const folderOrder = new Map(folders.map((f, i) => [f.path, i]))
        const sorted = [...imgs].sort(
          (a, b) => (folderOrder.get(a.folder) ?? 999) - (folderOrder.get(b.folder) ?? 999)
                 || a.path.localeCompare(b.path)
        )
        const lastPath = sorted[sorted.length - 1]?.path
        const idx = lastPath ? list.findIndex((img) => img.path === lastPath) : list.length - 1
        setCurrentIndex(idx >= 0 ? idx : list.length - 1)
      } else {
        setCurrentIndex(0)
      }
      setLoading(false)
    })
  }, [folders, shuffled])

  // Listen for file-system changes detected by folder watchers
  useEffect(() => {
    const unsubscribe = window.folio.onImagesUpdated((newRawList) => {
      const prev = imagesRef.current
      const currentPath = prev[currentIndexRef.current]?.path

      // Keep the existing order (preserves shuffle), remove deleted, append new
      const newPaths = new Set(newRawList.map((img) => img.path))
      const existingPaths = new Set(prev.map((img) => img.path))
      const kept = prev.filter((img) => newPaths.has(img.path))
      const added = newRawList.filter((img) => !existingPaths.has(img.path))
      const merged = [...kept, ...added]

      setImages(merged)
      const dropped = takePendingJump(merged) // a dropped file the watcher just picked up
      const newIdx = dropped >= 0 ? dropped : merged.findIndex((img) => img.path === currentPath)
      setCurrentIndex(newIdx >= 0 ? newIdx : Math.min(currentIndexRef.current, Math.max(0, merged.length - 1)))
    })
    return unsubscribe
  }, [])

  // Slideshow timer
  useEffect(() => {
    clearInterval(timerRef.current)
    if (isPlaying && images.length > 1) {
      timerRef.current = setInterval(() => {
        setCurrentIndex((i) => stepIndex(imagesRef.current, matchesRef.current, i, 1))
      }, intervalMs)
    }
    return () => clearInterval(timerRef.current)
  }, [isPlaying, images.length, intervalMs])

  const handleAddFolder = useCallback(async () => {
    const path = await window.folio.selectFolder()
    if (path && !folders.some((f) => f.path === path)) {
      setFolders((f) => [...f, { path, active: true }])
    }
  }, [folders])

  const handleRemoveFolder = useCallback((path) => {
    setFolders((f) => f.filter((item) => item.path !== path))
  }, [])

  const handleToggleFolder = useCallback((path) => {
    setFolders((f) =>
      f.map((item) => item.path === path ? { ...item, active: !item.active } : item)
    )
  }, [])

  const handleMoveFolderContents = useCallback(async (sourceFolderPath, targetFolderPath) => {
    const paths = images
      .filter(img => img.folder === sourceFolderPath)
      .map(img => img.path)
    if (paths.length === 0) return
    try {
      const results = await window.folio.moveImagesBulk(paths, targetFolderPath)
      const moved = results.filter(r => r.ok)
      const failed = results.filter(r => !r.ok)
      if (moved.length > 0) {
        const map = new Map(moved.map(r => [r.sourcePath, r.destPath]))
        setImages(prev => prev.map(img => {
          const newPath = map.get(img.path)
          return newPath ? { ...img, path: newPath, folder: targetFolderPath } : img
        }))
      }
      if (failed.length > 0) alert(`${failed.length} file(s) could not be moved.`)
    } catch (err) {
      alert(`Move failed:\n${err?.message || err}`)
    }
  }, [images])

  const handleReorderFolders = useCallback((fromIndex, toIndex) => {
    if (fromIndex === toIndex) return
    setFolders((prev) => {
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next
    })
  }, [])

  const handleTogglePlay = useCallback(() => {
    setIsPlaying((p) => !p)
  }, [])

  const handlePrev = useCallback(() => {
    setIsPlaying(false)
    setCurrentIndex((i) => stepIndex(imagesRef.current, matchesRef.current, i, -1))
  }, [])

  const handleNext = useCallback(() => {
    setIsPlaying(false)
    setCurrentIndex((i) => stepIndex(imagesRef.current, matchesRef.current, i, 1))
  }, [])

  // Search the loaded images' metadata as the query is typed (and again when the list
  // changes). Only the latest search's result is kept.
  useEffect(() => {
    const q = searchQuery.trim()
    const seq = ++searchSeq.current
    if (!q) { setMatches(null); setSearching(false); return }
    setSearching(true)
    const t = setTimeout(async () => {
      const list = images
      let found
      try {
        const hits = await window.folio.searchImages(list.map((img) => img.path), q)
        found = new Set(hits.map((i) => list[i].path))
      } catch {
        found = new Set()
      }
      if (seq !== searchSeq.current) return
      setMatches(found)
      setSearching(false)
    }, 200)
    return () => clearTimeout(t)
  }, [searchQuery, images])

  // The viewer and slideshow stay within the results: if the current image isn't one,
  // go to the first that is
  useEffect(() => {
    matchesRef.current = matches
    if (!matches || matches.size === 0) return
    const list = imagesRef.current
    if (matches.has(list[currentIndexRef.current]?.path)) return
    const first = list.findIndex((img) => matches.has(img.path))
    if (first >= 0) setCurrentIndex(first)
  }, [matches])

  const handleSearchChange = useCallback((e) => {
    const value = e.target.value
    setSearchQuery(value)
    if (value.trim()) setSidebarTab('browse') // the results show in the grid
  }, [])

  // Focusing the box reads every image's metadata in the background, so the first
  // search is instant
  const handleSearchFocus = useCallback(() => {
    const paths = imagesRef.current.map((img) => img.path)
    if (paths.length > 0) window.folio.searchImages(paths, '').catch(() => {})
  }, [])

  const handleSearchKey = useCallback((e) => {
    if (e.key === 'Escape') {
      // Clear the search, or leave the box; never close the window from here
      e.stopPropagation()
      if (e.target.value) setSearchQuery('')
      else e.target.blur()
    } else if (e.key === 'Enter') {
      e.target.blur() // arrow keys go back to browsing the results
    }
  }, [])

  // Ctrl+F: search
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && searchInputRef.current) {
        e.preventDefault()
        searchInputRef.current.focus()
        searchInputRef.current.select()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Arrow keys: cycle images; Space: toggle play
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.key === 'ArrowLeft') handlePrev()
      else if (e.key === 'ArrowRight') handleNext()
      else if (e.key === ' ') { e.preventDefault(); handleTogglePlay() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handlePrev, handleNext, handleTogglePlay])

  const handleToggleFullscreen = useCallback(async () => {
    const next = !isFullscreen
    await window.folio.setFullscreen(next)
    setIsFullscreen(next)
  }, [isFullscreen])

  const handleShuffleToggle = useCallback(() => {
    setShuffled((s) => !s)
  }, [])

  const handleKeepAwakeToggle = useCallback(() => {
    setKeepAwake((k) => !k)
  }, [])

  const handleOpenHelp = useCallback(async () => {
    const text = await window.folio.getReadme()
    setHelpText(text ?? 'Help content is unavailable.')
  }, [])

  // Reload thumbnails: delete the loaded folders' thumbnail files and bump the key so
  // every item re-fetches
  const handleReloadThumbnails = useCallback(async () => {
    const active = foldersRef.current.filter((f) => f.active).map((f) => f.path)
    try { await window.folio.reloadThumbnails(active) } catch {}
    forgetThumbnails()
    setThumbReloadKey((k) => k + 1)
  }, [])

  // F5 reloads thumbnails from anywhere in the app
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'F5') {
        e.preventDefault()
        handleReloadThumbnails()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleReloadThumbnails])

  const handleCloseEditor = useCallback(() => setEditPath(null), [])

  // An overwrite keeps the path, so bump its version to refresh the thumbnail and
  // viewer. A new file is picked up by the folder watcher on its own.
  const handleEditSaved = useCallback((savedPath, mode) => {
    if (mode !== 'overwrite') return
    setEditVersions((v) => ({ ...v, [savedPath]: (v[savedPath] ?? 0) + 1 }))
  }, [])

  const handleJumpTo = useCallback((index) => {
    setIsPlaying(false)
    setCurrentIndex(index)
  }, [])

  const handleDeleteImage = useCallback(async (path) => {
    try {
      await window.folio.trashImage(path)
    } catch (err) {
      alert(`Could not move file to Recycle Bin:\n${err?.message || err}`)
      return
    }
    setImages((prev) => {
      const idx = prev.findIndex((img) => img.path === path)
      if (idx === -1) return prev
      const next = prev.filter((img) => img.path !== path)
      setCurrentIndex((ci) => {
        if (next.length === 0) return 0
        if (ci > idx) return ci - 1
        if (ci === idx) return Math.min(ci, next.length - 1)
        return ci
      })
      return next
    })
  }, [])

  const handleRenameImage = useCallback(async (oldPath, newName) => {
    const newPath = await window.folio.renameImage(oldPath, newName)
    setImages((prev) => prev.map((img) => img.path === oldPath ? { ...img, path: newPath } : img))
  }, [])

  const handleMoveImage = useCallback(async (sourcePath, targetFolder) => {
    try {
      const newPath = await window.folio.moveImage(sourcePath, targetFolder)
      setImages((prev) => prev.map((img) =>
        img.path === sourcePath ? { ...img, path: newPath, folder: targetFolder } : img
      ))
    } catch (err) {
      alert(`Could not move file:\n${err?.message || err}`)
    }
  }, [])

  // Called after a bulk move so we do one single setImages update
  const handleBulkMoved = useCallback((pathMap, targetFolder) => {
    setImages((prev) => prev.map((img) => {
      const newPath = pathMap.get(img.path)
      return newPath ? { ...img, path: newPath, folder: targetFolder } : img
    }))
  }, [])

  // Sidebar resize drag
  useEffect(() => {
    function onMouseMove(e) {
      if (!sidebarResizing.current) return
      setSidebarWidth(Math.min(600, Math.max(160, e.clientX)))
    }
    function onMouseUp() {
      if (!sidebarResizing.current) return
      sidebarResizing.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // Auto-hide controls bar after 5 s of inactivity in fullscreen
  useEffect(() => {
    clearTimeout(hideTimerRef.current)
    if (isFullscreen) {
      setControlsVisible(true)
      hideTimerRef.current = setTimeout(() => setControlsVisible(false), 5000)
    } else {
      setControlsVisible(true)
    }
    return () => clearTimeout(hideTimerRef.current)
  }, [isFullscreen])

  const handleMouseMove = useCallback(() => {
    if (!isFullscreen) return
    setControlsVisible(true)
    clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 5000)
  }, [isFullscreen])

  // Folders and pictures dragged in from Explorer. Drops arrive as native window
  // events (the webview's HTML5 drop events carry no file paths). Dropped folders are
  // added. A dropped picture is shown in the viewer: its folder is added (or switched
  // back on) if needed, so its neighbours are an arrow key away. Other files are ignored.
  useEffect(() => window.folio.onDrop((e) => {
    if (e.type === 'enter') { setIsDragging(true); return }
    if (e.type === 'leave') { setIsDragging(false); return }

    const prev = foldersRef.current
    const next = [...prev]
    const index = new Map(prev.map((f, i) => [normPath(f.path), i]))
    const want = (path, activate) => {
      const i = index.get(normPath(path))
      if (i === undefined) {
        index.set(normPath(path), next.length)
        next.push({ path, active: true })
      } else if (activate && !next[i].active) {
        next[i] = { ...next[i], active: true }
      }
    }
    for (const path of e.folders) want(path, false)
    for (const img of e.images) want(img.folder, true)

    const target = e.images[0]?.path
    const changed = next.length !== prev.length || next.some((f, i) => f !== prev[i])
    if (target) {
      pendingJumpRef.current = { path: target, until: Date.now() + 10000 }
      setIsPlaying(false)
    }
    if (changed) {
      setFolders(next) // the rescan shows the dropped picture
    } else if (target) {
      // Its folder is already showing: jump now (or when the watcher adds a new file)
      const idx = takePendingJump(imagesRef.current)
      if (idx >= 0) setCurrentIndex(idx)
    }
  }), [])

  const currentImage = images[currentIndex] || null
  // The images an arrow key or the slideshow shows next, decoded ahead of time
  const nextIdx = stepIndex(images, matches, currentIndex, 1)
  const prevIdx = stepIndex(images, matches, currentIndex, -1)
  const nextPath = nextIdx !== currentIndex ? images[nextIdx]?.path : undefined
  const prevPath = prevIdx !== currentIndex && prevIdx !== nextIdx ? images[prevIdx]?.path : undefined
  const preload = useMemo(() => [nextPath, prevPath].filter(Boolean).map((path) => ({ path, version: editVersions[path] })),
    [nextPath, prevPath, editVersions])
  // While searching, the counters show the position among the results
  const matchIndexes = useMemo(() => matches
    ? images.reduce((acc, img, i) => { if (matches.has(img.path)) acc.push(i); return acc }, [])
    : null, [matches, images])
  const viewTotal = matchIndexes ? matchIndexes.length : images.length
  const viewIndex = matchIndexes ? Math.max(0, matchIndexes.indexOf(currentIndex)) : currentIndex

  return (
    <div
      className={`app-root${isFullscreen ? ' fullscreen' : ''}${isFullscreen && !controlsVisible ? ' cursor-hidden' : ''}`}
      onMouseMove={handleMouseMove}
    >
      {isDragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-box">
            <div className="drop-overlay-icon">📁</div>
            <div className="drop-overlay-text">Drop a picture to view it, or folders to add</div>
          </div>
        </div>
      )}
      {!isFullscreen && (
        <aside className="sidebar" style={{ width: sidebarWidth }}>
          <div
            className="sidebar-resizer"
            onMouseDown={(e) => {
              e.preventDefault()
              sidebarResizing.current = true
              document.body.style.cursor = 'col-resize'
              document.body.style.userSelect = 'none'
            }}
          />
          <div className="sidebar-header">
            <div className="app-brand">
              <div className="app-name-row">
                <span className="app-title">Folio</span>
                <span className="app-version">v.1.2.3</span>
              </div>
              <div className="app-tagline">Your images, beautifully kept.</div>
            </div>
            <div className={`sidebar-search${searchQuery ? ' sidebar-search-active' : ''}`}>
              <span className="sidebar-search-icon">🔍</span>
              <input
                ref={searchInputRef}
                className="sidebar-search-input"
                type="text"
                spellCheck={false}
                placeholder="Search metadata…"
                title={'Searches file names, prompts and generation settings, camera info, titles, keywords and comments.\nAll words must match. Use "quotes" for a phrase and -word to exclude. Ctrl+F'}
                value={searchQuery}
                onChange={handleSearchChange}
                onFocus={handleSearchFocus}
                onKeyDown={handleSearchKey}
              />
              {searchQuery && (
                <button className="sidebar-search-clear" onClick={() => setSearchQuery('')} title="Clear search (Esc)">✕</button>
              )}
            </div>
            {searchQuery.trim() && (
              <div className="sidebar-search-status">
                {searching && !matches ? 'Searching…'
                  : `${viewTotal} of ${images.length} image${images.length === 1 ? '' : 's'}${searching ? ' …' : ''}`}
              </div>
            )}
            <div className="sidebar-tabs">
              <button
                className={`stab${sidebarTab === 'folders' ? ' stab-active' : ''}`}
                onClick={() => setSidebarTab('folders')}
              >
                📁 Folders
              </button>
              <button
                className={`stab${sidebarTab === 'browse' ? ' stab-active' : ''}`}
                onClick={() => setSidebarTab('browse')}
              >
                🖼 Browse
              </button>
            </div>
          </div>
          {sidebarTab === 'folders' ? (
            <FolderManager
              folders={folders}
              onAdd={handleAddFolder}
              onRemove={handleRemoveFolder}
              onToggle={handleToggleFolder}
              onReorder={handleReorderFolders}
              onMoveFolder={handleMoveFolderContents}
              imageCount={images.length}
              loading={loading}
              startupBehavior={startupBehavior}
              onStartupBehaviorChange={setStartupBehavior}
            />
          ) : (
            <ThumbnailBrowser
              images={images}
              currentIndex={currentIndex}
              onJumpTo={handleJumpTo}
              onDelete={handleDeleteImage}
              onRename={handleRenameImage}
              onMove={handleMoveImage}
              onBulkMoved={handleBulkMoved}
              onEdit={setEditPath}
              onEditSaved={handleEditSaved}
              editVersions={editVersions}
              folders={folders}
              thumbSize={thumbSize}
              onThumbSizeChange={setThumbSize}
              reloadKey={thumbReloadKey}
              onReload={handleReloadThumbnails}
              matches={matches}
              searchQuery={searchQuery.trim()}
            />
          )}
        </aside>
      )}

      <main className="main-area">
        <SlideShow
          image={currentImage}
          version={currentImage ? editVersions[currentImage.path] : undefined}
          preload={preload}
          index={viewIndex}
          total={viewTotal}
          transition={transition}
          transitionDuration={transitionDuration}
          isFullscreen={isFullscreen}
          onToggleFullscreen={handleToggleFullscreen}
        />

        <Controls
          isPlaying={isPlaying}
          onTogglePlay={handleTogglePlay}
          onPrev={handlePrev}
          onNext={handleNext}
          hasImages={images.length > 0}
          intervalMs={intervalMs}
          onIntervalChange={setIntervalMs}
          isFullscreen={isFullscreen}
          controlsVisible={controlsVisible}
          onHelp={handleOpenHelp}
          keepAwake={keepAwake}
          onKeepAwakeToggle={handleKeepAwakeToggle}
          shuffled={shuffled}
          onShuffleToggle={handleShuffleToggle}
          transition={transition}
          onTransitionChange={setTransition}
          transitionDuration={transitionDuration}
          onTransitionDurationChange={setTransitionDuration}
          currentIndex={viewIndex}
          total={viewTotal}
        />

        {helpText !== null && (
          <HelpOverlay text={helpText} onClose={() => setHelpText(null)} />
        )}
      </main>

      {editPath && (
        <ImageEditor path={editPath} onClose={handleCloseEditor} onSaved={handleEditSaved} />
      )}
    </div>
  )
}
