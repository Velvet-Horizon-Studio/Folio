import { useState, useEffect, useCallback, useRef } from 'react'
import FolderManager from './components/FolderManager'
import ThumbnailBrowser from './components/ThumbnailBrowser'
import SlideShow from './components/SlideShow'
import Controls from './components/Controls'
import './styles/App.css'


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
  const startupBehaviorRef = useRef('resume')
  const sidebarResizing = useRef(false)
  const timerRef = useRef(null)
  const configReady = useRef(false)
  const lastImagePathRef = useRef(null)
  // Refs kept in sync so IPC callbacks (set up once) always see current values
  const imagesRef = useRef([])
  const currentIndexRef = useRef(0)
  const [controlsVisible, setControlsVisible] = useState(true)
  const hideTimerRef = useRef(null)
  const dragCounterRef = useRef(0)

  // Load saved config on first mount
  useEffect(() => {
    window.electronAPI.loadConfig().then((cfg) => {
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
      sidebarTab, sidebarWidth, thumbSize, startupBehavior,
    }
    // Only overwrite lastImagePath once images are loaded so we don't
    // clobber the saved path during the async scan on startup
    if (images.length > 0) payload.lastImagePath = images[currentIndex]?.path ?? null
    window.electronAPI.saveConfig(payload)
  }, [folders, intervalMs, shuffled, transition, transitionDuration,
      sidebarTab, sidebarWidth, thumbSize, startupBehavior, currentIndex, images])

  useEffect(() => { imagesRef.current = images }, [images])
  useEffect(() => { currentIndexRef.current = currentIndex }, [currentIndex])
  useEffect(() => { startupBehaviorRef.current = startupBehavior }, [startupBehavior])

  // Sync fullscreen state from main process
  useEffect(() => {
    const unsubscribe = window.electronAPI.onFullscreenChanged((val) => {
      setIsFullscreen(val)
    })
    return unsubscribe
  }, [])

  // Escape: exit fullscreen if active, otherwise close the window
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape') return
      if (isFullscreen) {
        window.electronAPI.setFullscreen(false)
      } else {
        window.close()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isFullscreen])

  // Reload images whenever active folders change
  useEffect(() => {
    const activePaths = folders.filter((f) => f.active).map((f) => f.path)
    if (activePaths.length === 0) {
      window.electronAPI.watchFolders([])
      setImages([])
      setCurrentIndex(0)
      setIsPlaying(false)
      return
    }
    window.electronAPI.watchFolders(activePaths)
    setLoading(true)
    window.electronAPI.scanImages(activePaths).then((imgs) => {
      const list = shuffled ? shuffle(imgs) : imgs
      setImages(list)
      const behavior = startupBehaviorRef.current
      const savedPath = lastImagePathRef.current
      lastImagePathRef.current = null
      if (behavior === 'resume' && savedPath) {
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
    const unsubscribe = window.electronAPI.onImagesUpdated((newRawList) => {
      const prev = imagesRef.current
      const currentPath = prev[currentIndexRef.current]?.path

      // Keep the existing order (preserves shuffle), remove deleted, append new
      const newPaths = new Set(newRawList.map((img) => img.path))
      const existingPaths = new Set(prev.map((img) => img.path))
      const kept = prev.filter((img) => newPaths.has(img.path))
      const added = newRawList.filter((img) => !existingPaths.has(img.path))
      const merged = [...kept, ...added]

      setImages(merged)
      const newIdx = merged.findIndex((img) => img.path === currentPath)
      setCurrentIndex(newIdx >= 0 ? newIdx : Math.min(currentIndexRef.current, Math.max(0, merged.length - 1)))
    })
    return unsubscribe
  }, [])

  // Slideshow timer
  useEffect(() => {
    clearInterval(timerRef.current)
    if (isPlaying && images.length > 1) {
      timerRef.current = setInterval(() => {
        setCurrentIndex((i) => (i + 1) % images.length)
      }, intervalMs)
    }
    return () => clearInterval(timerRef.current)
  }, [isPlaying, images.length, intervalMs])

  const handleAddFolder = useCallback(async () => {
    const path = await window.electronAPI.selectFolder()
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
      const results = await window.electronAPI.moveImagesBulk(paths, targetFolderPath)
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
    setCurrentIndex((i) => (i - 1 + images.length) % images.length)
  }, [images.length])

  const handleNext = useCallback(() => {
    setIsPlaying(false)
    setCurrentIndex((i) => (i + 1) % images.length)
  }, [images.length])

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
    await window.electronAPI.setFullscreen(next)
    setIsFullscreen(next)
  }, [isFullscreen])

  const handleShuffleToggle = useCallback(() => {
    setShuffled((s) => !s)
  }, [])

  const handleJumpTo = useCallback((index) => {
    setIsPlaying(false)
    setCurrentIndex(index)
  }, [])

  const handleDeleteImage = useCallback(async (path) => {
    try {
      await window.electronAPI.trashImage(path)
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
    const newPath = await window.electronAPI.renameImage(oldPath, newName)
    setImages((prev) => prev.map((img) => img.path === oldPath ? { ...img, path: newPath } : img))
  }, [])

  const handleMoveImage = useCallback(async (sourcePath, targetFolder) => {
    try {
      const newPath = await window.electronAPI.moveImage(sourcePath, targetFolder)
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

  const handleDragEnter = useCallback((e) => {
    if (e.dataTransfer.types.includes('application/x-folio-reorder')) return
    e.preventDefault()
    dragCounterRef.current++
    if (dragCounterRef.current === 1) setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e) => {
    if (e.dataTransfer.types.includes('application/x-folio-reorder')) return
    e.preventDefault()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setIsDragging(false)
  }, [])

  const handleDragOver = useCallback((e) => {
    if (e.dataTransfer.types.includes('application/x-folio-reorder')) return
    e.preventDefault()
  }, [])

  const handleDrop = useCallback((e) => {
    if (e.dataTransfer.types.includes('application/x-folio-reorder')) return
    e.preventDefault()
    dragCounterRef.current = 0
    setIsDragging(false)
    const newPaths = []
    for (const item of Array.from(e.dataTransfer.items)) {
      const entry = item.webkitGetAsEntry()
      if (entry && entry.isDirectory) {
        const file = item.getAsFile()
        if (file && file.path) newPaths.push(file.path)
      }
    }
    if (newPaths.length > 0) {
      setFolders((prev) => {
        const existing = new Set(prev.map((f) => f.path))
        const toAdd = newPaths.filter((p) => !existing.has(p)).map((p) => ({ path: p, active: true }))
        return [...prev, ...toAdd]
      })
    }
  }, [])

  const currentImage = images[currentIndex] || null

  return (
    <div
      className={`app-root${isFullscreen ? ' fullscreen' : ''}${isFullscreen && !controlsVisible ? ' cursor-hidden' : ''}`}
      onMouseMove={handleMouseMove}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-box">
            <div className="drop-overlay-icon">📁</div>
            <div className="drop-overlay-text">Drop folders to add</div>
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
                <span className="app-version">v.1.1.1</span>
              </div>
              <div className="app-tagline">Your images, beautifully kept.</div>
            </div>
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
              folders={folders}
              thumbSize={thumbSize}
              onThumbSizeChange={setThumbSize}
            />
          )}
        </aside>
      )}

      <main className="main-area">
        <SlideShow
          image={currentImage}
          index={currentIndex}
          total={images.length}
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
          onToggleFullscreen={handleToggleFullscreen}
          shuffled={shuffled}
          onShuffleToggle={handleShuffleToggle}
          transition={transition}
          onTransitionChange={setTransition}
          transitionDuration={transitionDuration}
          onTransitionDurationChange={setTransitionDuration}
          currentIndex={currentIndex}
          total={images.length}
        />
      </main>
    </div>
  )
}
