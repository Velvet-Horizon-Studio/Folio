import { useEffect, useRef, useState } from 'react'
import './FolderManager.css'

function basename(path) {
  return path.replace(/\\/g, '/').split('/').pop() || path
}

export default function FolderManager({ folders, onAdd, onRemove, onToggle, onReorder, onMoveFolder, imageCount, loading, startupBehavior, onStartupBehaviorChange }) {
  const dragRef = useRef(null) // { index, startY, active } while a row is held
  const listRef = useRef(null)
  const [dragState, setDragState] = useState({ dragging: null, over: null })
  const [contextMenu, setContextMenu] = useState(null) // { x, y, path, submenuOpen }
  const menuRef = useRef(null)

  // Dismiss context menu on outside click or Escape
  useEffect(() => {
    if (!contextMenu) return
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

  // Reordering uses pointer events rather than HTML5 drag and drop, which the webview
  // gives up to native Explorer drops on Windows

  // Row under a vertical position, clamped to the list
  function rowIndexAt(y) {
    const rows = listRef.current.querySelectorAll('.fm-folder-item')
    for (let i = 0; i < rows.length; i++) {
      if (y < rows[i].getBoundingClientRect().bottom) return i
    }
    return rows.length - 1
  }

  function handlePointerDown(e, index) {
    if (e.button !== 0 || e.target.closest('button, label, input')) return
    dragRef.current = { index, startY: e.clientY, active: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function handlePointerMove(e) {
    const d = dragRef.current
    if (!d) return
    if (!d.active) {
      if (Math.abs(e.clientY - d.startY) < 4) return // a click, not a drag
      d.active = true
    }
    setDragState({ dragging: d.index, over: rowIndexAt(e.clientY) })
  }

  function handlePointerUp(e) {
    const d = dragRef.current
    dragRef.current = null
    if (!d?.active) return
    setDragState({ dragging: null, over: null })
    const to = rowIndexAt(e.clientY)
    if (to !== d.index) onReorder(d.index, to)
  }

  function handlePointerCancel() {
    dragRef.current = null
    setDragState({ dragging: null, over: null })
  }

  return (
    <div className="folder-manager">
      <div className="fm-section-title">
        Source Folders
        {imageCount > 0 && (
          <span className="fm-badge">{imageCount} images</span>
        )}
      </div>

      <div className="fm-folder-list" ref={listRef}>
        {folders.length === 0 && (
          <div className="fm-empty">No folders added yet.<br />Click below to add one.</div>
        )}
        {folders.map(({ path, active }, index) => (
          <div
            key={path}
            className={[
              'fm-folder-item',
              active ? '' : 'fm-folder-inactive',
              dragState.dragging === index ? 'fm-folder-dragging' : '',
              dragState.over === index && dragState.dragging !== index ? 'fm-folder-drag-over' : '',
            ].filter(Boolean).join(' ')}
            title={path}
            onPointerDown={(e) => handlePointerDown(e, index)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, path, submenuOpen: false }) }}
          >
            <span className="fm-drag-handle" title="Drag to reorder">⠿</span>
            <label className="fm-checkbox-wrap" title={active ? 'Disable folder' : 'Enable folder'}>
              <input
                type="checkbox"
                className="fm-checkbox"
                checked={active}
                onChange={() => onToggle(path)}
              />
              <span className="fm-checkmark" />
            </label>
            <span className="fm-folder-icon">📁</span>
            <span className="fm-folder-name">{basename(path)}</span>
            <button
              className="fm-remove-btn"
              onClick={() => onRemove(path)}
              title={`Remove ${path}`}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {loading && <div className="fm-loading">Scanning images…</div>}

      <button className="fm-add-btn" onClick={onAdd}>
        + Add Folder
      </button>

      <div className="fm-settings">
        <div className="fm-section-title" style={{ marginTop: 0 }}>Startup</div>
        <div className="fm-setting-row">
          <label className={`fm-setting-opt${startupBehavior === 'resume' ? ' fm-setting-opt-active' : ''}`}>
            <input type="radio" name="startupBehavior" value="resume"
              checked={startupBehavior === 'resume'}
              onChange={() => onStartupBehaviorChange('resume')}
            />
            Resume last image
          </label>
          <label className={`fm-setting-opt${startupBehavior === 'first' ? ' fm-setting-opt-active' : ''}`}>
            <input type="radio" name="startupBehavior" value="first"
              checked={startupBehavior === 'first'}
              onChange={() => onStartupBehaviorChange('first')}
            />
            Start from first image
          </label>
          <label className={`fm-setting-opt${startupBehavior === 'last' ? ' fm-setting-opt-active' : ''}`}>
            <input type="radio" name="startupBehavior" value="last"
              checked={startupBehavior === 'last'}
              onChange={() => onStartupBehaviorChange('last')}
            />
            Start from last image
          </label>
        </div>
      </div>
      {contextMenu && (() => {
        const targets = folders.filter(f => f.path !== contextMenu.path)
        return (
          <div
            ref={menuRef}
            className="fm-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <div className="fm-context-label">{basename(contextMenu.path)}</div>
            <div className="fm-context-divider" />
            <div
              className="fm-context-item fm-context-submenu-trigger"
              onMouseEnter={() => setContextMenu(c => ({ ...c, submenuOpen: true }))}
              onMouseLeave={() => setContextMenu(c => ({ ...c, submenuOpen: false }))}
            >
              Move all to ▶
              {contextMenu.submenuOpen && (
                <div className="fm-context-submenu">
                  {targets.length === 0
                    ? <span className="fm-context-item" style={{ color: 'var(--text-muted)', cursor: 'default' }}>No other folders</span>
                    : targets.map(f => (
                        <button
                          key={f.path}
                          className="fm-context-item"
                          title={f.path}
                          onClick={() => {
                            const src = contextMenu.path
                            setContextMenu(null)
                            onMoveFolder(src, f.path)
                          }}
                        >
                          {basename(f.path)}
                        </button>
                      ))
                  }
                </div>
              )}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
