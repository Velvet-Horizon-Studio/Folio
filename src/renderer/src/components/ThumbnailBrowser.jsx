import { useState, useEffect, useRef } from 'react'
import './ThumbnailBrowser.css'

function basename(p) {
  return p.replace(/\\/g, '/').split('/').pop()
}

function stripExt(name) {
  return name.replace(/\.[^.]+$/, '')
}

function formatSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
  if (bytes >= 1024)    return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

function formatDate(iso) {
  return new Date(iso).toLocaleString()
}

// Individual thumbnail with lazy load, rename, delete, selection, and metadata
function ThumbnailItem({ img, isActive, isSelected, scrollRef, onJumpTo, onDelete, onRename, onSelect, onContextMenu, onShowMeta }) {
  const [src, setSrc] = useState(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const btnRef = useRef(null)
  const inputRef = useRef(null)
  const nameNoExt = stripExt(basename(img.path))

  useEffect(() => {
    if (isActive && btnRef.current) scrollRef.current = btnRef.current
  }, [isActive, scrollRef])

  useEffect(() => {
    const el = btnRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect()
          window.electronAPI.getThumbnail(img.path).then((dataUrl) => {
            if (dataUrl) setSrc(dataUrl)
          })
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [img.path])

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [renaming])

  function handleClick(e) {
    if (renaming) return
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      onSelect(img.path)
    } else {
      onJumpTo(img.globalIndex)
    }
  }

  function startRename(e) {
    e.stopPropagation()
    setDraft(nameNoExt)
    setRenaming(true)
  }

  function cancelRename() { setRenaming(false) }

  async function submitRename() {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== nameNoExt) await onRename(img.path, trimmed)
    setRenaming(false)
  }

  function handleInputKey(e) {
    if (e.key === 'Enter') submitRename()
    else if (e.key === 'Escape') cancelRename()
    e.stopPropagation()
  }

  async function handleDelete(e) {
    e.stopPropagation()
    if (!window.confirm(`Move to Recycle Bin?\n\n${basename(img.path)}`)) return
    await onDelete(img.path)
  }

  function handleContextMenu(e) {
    e.preventDefault()
    e.stopPropagation()
    onContextMenu(e.clientX, e.clientY, img.path)
  }

  return (
    <div
      ref={btnRef}
      className={`tb-thumb${isActive ? ' tb-thumb-active' : ''}${isSelected ? ' tb-thumb-selected' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title={renaming ? undefined : basename(img.path)}
    >
      {isSelected && <div className="tb-selected-badge">✓</div>}

      {renaming ? (
        <div className="tb-rename-overlay">
          <input
            ref={inputRef}
            className="tb-rename-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleInputKey}
            onBlur={cancelRename}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : (
        <>
          {src
            ? <img src={src} alt="" draggable={false} />
            : <div className="tb-placeholder" />
          }
          <div className="tb-actions">
            <button className="tb-action-btn" onClick={(e) => { e.stopPropagation(); onShowMeta(img.path) }} title="Image info">ℹ️</button>
            <button className="tb-action-btn" onClick={startRename} title="Rename">✏️</button>
            <button className="tb-action-btn" onClick={handleDelete} title="Delete (Recycle Bin)">🗑️</button>
          </div>
        </>
      )}
    </div>
  )
}

const CONVERT_FORMATS = [
  { label: 'Save as PNG',  format: 'png'  },
  { label: 'Save as JPEG', format: 'jpeg' },
]



export default function ThumbnailBrowser({ images, currentIndex, onJumpTo, onDelete, onRename, onMove, onBulkMoved, folders, thumbSize, onThumbSizeChange }) {
  const activeRef = useRef(null)
  const menuRef = useRef(null)
  const [contextMenu, setContextMenu] = useState(null)
  const [moveSubmenuOpen, setMoveSubmenuOpen] = useState(false)
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false)
  const bulkMoveRef = useRef(null)
  const [selected, setSelected] = useState(new Set())
  const [converting, setConverting] = useState(false)
  const [metaInfo, setMetaInfo] = useState(null)

  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [currentIndex])

  // Dismiss context menu on outside click or Escape
  useEffect(() => {
    if (!contextMenu) { setMoveSubmenuOpen(false); return }
    function onDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setContextMenu(null)
    }
    function onKey(e) { if (e.key === 'Escape') setContextMenu(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  // Clear selection when image list changes (delete / external change)
  useEffect(() => {
    setSelected(prev => {
      const valid = new Set(images.map(img => img.path))
      const next = new Set([...prev].filter(p => valid.has(p)))
      return next.size === prev.size ? prev : next
    })
  }, [images])

  function toggleSelect(path) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }

  async function handleBulkDelete() {
    const paths = [...selected]
    if (!window.confirm(`Move ${paths.length} image(s) to the Recycle Bin?`)) return
    for (const path of paths) {
      try { await onDelete(path) } catch {}
    }
    setSelected(new Set())
  }

  // Close bulk-move dropdown on outside click
  useEffect(() => {
    if (!bulkMoveOpen) return
    function onDown(e) {
      if (bulkMoveRef.current && !bulkMoveRef.current.contains(e.target)) setBulkMoveOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [bulkMoveOpen])

  async function handleBulkMove(targetFolder) {
    setBulkMoveOpen(false)
    const paths = [...selected]
    try {
      const results = await window.electronAPI.moveImagesBulk(paths, targetFolder)
      // single state update for all moved files
      const moved = results.filter(r => r.ok)
      const failed = results.filter(r => !r.ok)
      if (moved.length > 0) {
        const map = new Map(moved.map(r => [r.sourcePath, r.destPath]))
        onBulkMoved(map, targetFolder)
      }
      setSelected(new Set())
      if (failed.length > 0) alert(`${failed.length} file(s) could not be moved.`)
    } catch (err) {
      alert(`Move failed:\n${err?.message || err}`)
    }
  }

  async function handleBulkConvert(format) {
    if (converting) return
    setConverting(true)
    try {
      const paths = [...selected]
      const result = await window.electronAPI.convertImagesBulk(paths, format)
      const msg = result.failed > 0
        ? `Converted ${result.success} file(s).\n${result.failed} failed.`
        : `Converted ${result.success} file(s) to ${format.toUpperCase()}.`
      alert(msg)
      setSelected(new Set())
    } catch (err) {
      alert(`Conversion failed:\n${err?.message || err}`)
    } finally {
      setConverting(false)
    }
  }

  async function handleShowMeta(filePath) {
    try {
      const meta = await window.electronAPI.getImageMetadata(filePath)
      setMetaInfo(meta)
    } catch (err) {
      alert(`Could not read metadata:\n${err?.message || err}`)
    }
  }

  async function handleConvert(sourcePath, format) {
    setContextMenu(null)
    try {
      await window.electronAPI.convertImage(sourcePath, format)
    } catch (err) {
      alert(`Conversion failed:\n${err?.message || err}`)
    }
  }

  const folderOrder = new Map((folders ?? []).map((f, i) => [f.path, i]))
  const sorted = [...images]
    .map((img, i) => ({ ...img, globalIndex: i }))
    .sort((a, b) =>
      (folderOrder.get(a.folder) ?? 999) - (folderOrder.get(b.folder) ?? 999)
      || a.path.localeCompare(b.path)
    )

  const groups = new Map()
  for (const img of sorted) {
    if (!groups.has(img.folder)) groups.set(img.folder, [])
    groups.get(img.folder).push(img)
  }

  return (
    <div className="tb-root">
      {images.length === 0 ? (
        <div className="tb-empty">
          No images loaded.<br />Add and enable folders first.
        </div>
      ) : (
        <div className="tb-scroll" style={{ '--thumb-size': `${thumbSize}px` }}>
          {[...groups.entries()].map(([folder, items]) => (
            <div key={folder} className="tb-group">
              <div className="tb-group-label" title={folder}>
                {basename(folder)}
              </div>
              <div className="tb-grid">
                {items.map((img) => (
                  <ThumbnailItem
                    key={img.path}
                    img={img}
                    isActive={img.globalIndex === currentIndex}
                    isSelected={selected.has(img.path)}
                    scrollRef={activeRef}
                    onJumpTo={onJumpTo}
                    onDelete={onDelete}
                    onRename={onRename}
                    onSelect={toggleSelect}
                    onContextMenu={(x, y, path) => setContextMenu({ x, y, path })}
                    onShowMeta={handleShowMeta}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="tb-bulk-bar">
          <span className="tb-bulk-count">{selected.size} selected</span>
          <button
            className="tb-bulk-btn"
            onClick={() => handleBulkConvert('png')}
            disabled={converting}
            title="Convert selected to PNG"
          >
            → PNG
          </button>
          <button
            className="tb-bulk-btn"
            onClick={() => handleBulkConvert('jpeg')}
            disabled={converting}
            title="Convert selected to JPEG"
          >
            → JPEG
          </button>
          {folders && folders.length > 0 && (
            <div className="tb-bulk-move-wrap" ref={bulkMoveRef}>
              <button
                className="tb-bulk-btn"
                onClick={() => setBulkMoveOpen(o => !o)}
                title="Move selected to another folder"
              >
                📁 Move to…
              </button>
              {bulkMoveOpen && (() => {
                const activeFolders = folders.filter(f => f.active)
                const sourceFolders = new Set(
                  [...selected].map(p => images.find(img => img.path === p)?.folder).filter(Boolean)
                )
                const targets = activeFolders.filter(
                  f => !(sourceFolders.size === 1 && sourceFolders.has(f.path))
                )
                return (
                  <div className="tb-bulk-move-menu">
                    {targets.length === 0
                      ? <span className="tb-bulk-move-item" style={{ color: 'var(--text-muted)', cursor: 'default' }}>No other folders</span>
                      : targets.map(f => (
                          <button
                            key={f.path}
                            className="tb-bulk-move-item"
                            title={f.path}
                            onClick={() => handleBulkMove(f.path)}
                          >
                            {basename(f.path)}
                          </button>
                        ))
                    }
                  </div>
                )
              })()}
            </div>
          )}
          <button
            className="tb-bulk-btn tb-bulk-delete"
            onClick={handleBulkDelete}
            title="Move selected to Recycle Bin"
          >
            🗑️ Delete
          </button>
          <button
            className="tb-bulk-btn tb-bulk-clear"
            onClick={() => setSelected(new Set())}
            title="Clear selection"
          >
            ✕
          </button>
        </div>
      )}

      <div className="tb-footer">
        <span className="tb-footer-icon">⊞</span>
        <input
          type="range"
          min={50}
          max={200}
          value={thumbSize}
          onChange={(e) => onThumbSizeChange(Number(e.target.value))}
          className="tb-size-slider"
          title={`Thumbnail size: ${thumbSize}px`}
        />
      </div>

      {/* Metadata modal */}
      {metaInfo && (
        <div className="tb-meta-backdrop" onClick={() => setMetaInfo(null)}>
          <div className="tb-meta-card" onClick={(e) => e.stopPropagation()}>
            <div className="tb-meta-header">
              <span className="tb-meta-title" title={metaInfo.name}>{metaInfo.name}</span>
              {metaInfo.sd && (
                <button
                  className="tb-meta-copy"
                  onClick={() => {
                    const { positive, negative, params } = metaInfo.sd
                    const lines = [positive]
                    if (negative) lines.push(`\nNegative prompt: ${negative}`)
                    if (Object.keys(params).length > 0)
                      lines.push('\n' + Object.entries(params).map(([k, v]) => `${k}: ${v}`).join(', '))
                    const content = lines.join('\n')
                    const defaultPath = metaInfo.name.replace(/\.[^.]+$/, '') + '.txt'
                    window.electronAPI.saveTextFile(defaultPath, content)
                  }}
                  title="Save parameters as .txt"
                >
                  Save
                </button>
              )}
              <button className="tb-meta-close" onClick={() => setMetaInfo(null)}>✕</button>
            </div>
            <div className="tb-meta-body">
              <div className="tb-meta-section-title">File</div>
              <table className="tb-meta-table"><tbody>
                <tr><td>Format</td><td>{metaInfo.ext}</td></tr>
                <tr><td>Dimensions</td><td>{metaInfo.width} × {metaInfo.height} px</td></tr>
                <tr><td>File size</td><td>{formatSize(metaInfo.size)}</td></tr>
                <tr><td>Created</td><td>{formatDate(metaInfo.created)}</td></tr>
                <tr><td>Modified</td><td>{formatDate(metaInfo.modified)}</td></tr>
              </tbody></table>

              {metaInfo.sd && (<>
                <div className="tb-meta-section-title">Prompt</div>
                <div className="tb-meta-text">{metaInfo.sd.positive}</div>

                {metaInfo.sd.negative && (<>
                  <div className="tb-meta-section-title">Negative prompt</div>
                  <div className="tb-meta-text tb-meta-text-neg">{metaInfo.sd.negative}</div>
                </>)}

                {Object.keys(metaInfo.sd.params).length > 0 && (<>
                  <div className="tb-meta-section-title">Generation</div>
                  <table className="tb-meta-table"><tbody>
                    {Object.entries(metaInfo.sd.params).map(([k, v]) => (
                      <tr key={k}><td>{k}</td><td>{v}</td></tr>
                    ))}
                  </tbody></table>
                </>)}
              </>)}

              {!metaInfo.sd && (
                <div className="tb-meta-no-sd">No generation parameters found.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Single-image right-click context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="tb-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="tb-context-label">{basename(contextMenu.path)}</div>
          <div className="tb-context-divider" />
          <button
            className="tb-context-item"
            onClick={async () => {
              const path = contextMenu.path
              setContextMenu(null)
              const ok = await window.electronAPI.copyImage(path)
              if (!ok) alert('Failed to copy image to clipboard.')
            }}
          >
            Copy file
          </button>
          <div className="tb-context-divider" />
          {CONVERT_FORMATS.map(({ label, format }) => (
            <button
              key={format}
              className="tb-context-item"
              onClick={() => handleConvert(contextMenu.path, format)}
            >
              {label}
            </button>
          ))}
          {folders && folders.length > 1 && (() => {
            const currentFolder = images.find(img => img.path === contextMenu.path)?.folder
            const otherFolders = folders.filter(f => f.path !== currentFolder)
            if (otherFolders.length === 0) return null
            return (
              <>
                <div className="tb-context-divider" />
                <div
                  className="tb-context-item tb-context-submenu-trigger"
                  onMouseEnter={() => setMoveSubmenuOpen(true)}
                  onMouseLeave={() => setMoveSubmenuOpen(false)}
                >
                  Move to folder ▶
                  {moveSubmenuOpen && (
                    <div className="tb-context-submenu">
                      {otherFolders.map(f => (
                        <button
                          key={f.path}
                          className="tb-context-item"
                          title={f.path}
                          onClick={async () => {
                            const path = contextMenu.path
                            setContextMenu(null)
                            await onMove(path, f.path)
                          }}
                        >
                          {basename(f.path)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}
