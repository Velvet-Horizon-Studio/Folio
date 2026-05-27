import './FolderManager.css'

function basename(path) {
  return path.replace(/\\/g, '/').split('/').pop() || path
}

export default function FolderManager({ folders, onAdd, onRemove, onToggle, imageCount, loading }) {
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
        {folders.map(({ path, active }) => (
          <div key={path} className={`fm-folder-item${active ? '' : ' fm-folder-inactive'}`} title={path}>
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
    </div>
  )
}
