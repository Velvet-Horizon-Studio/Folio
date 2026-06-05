import './FolderManager.css'

function basename(path) {
  return path.replace(/\\/g, '/').split('/').pop() || path
}

export default function FolderManager({ folders, onAdd, onRemove, onToggle, imageCount, loading, startupBehavior, onStartupBehaviorChange }) {
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
    </div>
  )
}
