import './HelpOverlay.css'

// In-app help panel — renders the README text over the display area.
export default function HelpOverlay({ text, onClose }) {
  return (
    <div className="help-overlay" onClick={onClose}>
      <div className="help-panel" onClick={(e) => e.stopPropagation()}>
        <div className="help-header">
          <span className="help-title">Folio — Help</span>
          <button className="help-close" onClick={onClose} title="Close (Esc)">✕</button>
        </div>
        <pre className="help-body">{text}</pre>
      </div>
    </div>
  )
}
