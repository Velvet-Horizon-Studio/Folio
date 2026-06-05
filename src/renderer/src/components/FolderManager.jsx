import { useEffect, useRef, useState } from 'react'
import './FolderManager.css'

function basename(path) {
  return path.replace(/\\/g, '/').split('/').pop() || path
}

export default function FolderManager({ folders, onAdd, onRemove, onToggle, onReorder, onMoveFolder, imageCount, loading, startupBehavior, onStartupBehaviorChange }) {
  const dragIndexRef = useRef(null)
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

  function handleDragStart(e, index) {
    dragIndexRef.current = index
    e.dataTransfer.setData('application/x-folio-reorder', '1')
    e.dataTransfer.effectAllowed = 'move'
    setDragState({ dragging: index, over: index })
  }

  function handleDragEnterRow(e, index) {
    e.preventDefault()
    setDragState(s => ({ ...s, over: index }))
  }

  function handleDragOverRow(e) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  function handleDropRow(e, index) {
    e.preventDefault()
    e.stopPropagation()
    const from = dragIndexRef.current
    dragIndexRef.current = null
    setDragState({ dragging: null, over: null })
    if (from !== null && from !== index) onReorder(from, index)
  }

  function handleDragEnd() {
    dragIndexRef.current = null
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

      <div className="fm-folder-list">
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
            draggable
            onDragStart={(e) => handleDragStart(e, index)}
            onDragEnter={(e) => handleDragEnterRow(e, index)}
            onDragOver={handleDragOverRow}
            onDrop={(e) => handleDropRow(e, index)}
            onDragEnd={handleDragEnd}
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
