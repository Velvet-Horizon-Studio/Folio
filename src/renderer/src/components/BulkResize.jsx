import { useState, useEffect, useRef } from 'react'
import { resizeImage } from '../thumbnails'
import './BulkResize.css'

const FORMATS = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  webp: { mime: 'image/webp', ext: 'webp' },
}

// Format a file can be written back in, judged by its extension
function formatForPath(p) {
  const ext = p.split('.').pop().toLowerCase()
  if (ext === 'png') return 'png'
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg'
  if (ext === 'webp') return 'webp'
  return null
}

// "Resize…" button for the bulk action bar, with its options popover and progress.
// onFinished(overwrittenPaths) runs once a batch completes.
export default function BulkResize({ paths, onFinished }) {
  const [open, setOpen] = useState(null) // popover position while open
  const [sizeMode, setSizeMode] = useState('scale') // 'scale' | 'max'
  const [scale, setScale] = useState(50)
  const [maxSide, setMaxSide] = useState(2000)
  const [format, setFormat] = useState('same') // 'same' | 'png' | 'jpeg' | 'webp'
  const [quality, setQuality] = useState(90)
  const [saveMode, setSaveMode] = useState('new') // 'new' | 'overwrite'
  const [progress, setProgress] = useState(null) // { done, total } while running
  const wrapRef = useRef(null)
  const btnRef = useRef(null)

  // The sidebar clips overflow, so the popover is placed in viewport coordinates
  // above the button, free to extend past the sidebar's edge
  function toggle() {
    if (open) { setOpen(null); return }
    const r = btnRef.current.getBoundingClientRect()
    setOpen({ left: Math.max(8, Math.min(r.left, window.innerWidth - 248)), bottom: window.innerHeight - r.top + 6 })
  }

  useEffect(() => {
    if (!open) return
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const sizeValid = sizeMode === 'scale' ? scale >= 1 && scale < 100 : maxSide >= 16
  const usesQuality = saveMode === 'overwrite' || format === 'same' || format !== 'png'

  async function run() {
    if (!sizeValid || progress) return
    const batch = [...paths]
    if (saveMode === 'overwrite' && !window.confirm(
      `Resize and overwrite ${batch.length} image(s)?\n\nThe originals will be moved to the Recycle Bin.`
    )) return
    setOpen(null)
    setProgress({ done: 0, total: batch.length })

    const sizeOpt = sizeMode === 'scale' ? { scale: scale / 100 } : { maxSide }
    let resized = 0, unchanged = 0, failed = 0, asNew = 0
    const overwritten = []

    await Promise.all(batch.map(async (path) => {
      try {
        // Overwrite keeps each file's own format; files that can't be written back
        // in their format (GIF, BMP, AVIF…) are saved as new PNGs instead
        const own = formatForPath(path)
        const fmtKey = saveMode === 'overwrite' || format === 'same' ? own ?? 'png' : format
        const fmt = FORMATS[fmtKey]
        const result = await resizeImage(path, { ...sizeOpt, mime: fmt.mime, quality: quality / 100 })
        if (!result) { failed++; return }
        if (result.unchanged) { unchanged++; return }
        const mode = saveMode === 'overwrite' && own ? 'overwrite' : 'sibling'
        if (saveMode === 'overwrite' && !own) asNew++
        const saved = await window.electronAPI.saveEditedImage(path, new Uint8Array(result.out), fmt.ext, mode, '_resized')
        if (!saved) { failed++; return }
        resized++
        if (mode === 'overwrite') overwritten.push(saved)
      } catch {
        failed++
      } finally {
        setProgress((p) => p && { ...p, done: p.done + 1 })
      }
    }))

    setProgress(null)
    onFinished(overwritten)
    const lines = [`Resized ${resized} image(s).`]
    if (unchanged) lines.push(`${unchanged} skipped (already within the target size).`)
    if (asNew) lines.push(`${asNew} saved as new PNG files (their format can't be overwritten).`)
    if (failed) lines.push(`${failed} failed.`)
    alert(lines.join('\n'))
  }

  return (
    <div className="br-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        className="tb-bulk-btn"
        onClick={toggle}
        disabled={!!progress}
        title="Resize selected images"
      >
        {progress ? `Resizing ${progress.done}/${progress.total}…` : '⤡ Resize…'}
      </button>
      {open && (
        <div className="br-menu" style={open}>
          <div className="br-title">Resize {paths.length} image(s)</div>

          <div className="br-row">
            <label className="br-radio">
              <input type="radio" checked={sizeMode === 'scale'} onChange={() => setSizeMode('scale')} />
              Scale
            </label>
            <input
              className="br-num"
              type="number"
              min={1}
              max={99}
              value={scale}
              disabled={sizeMode !== 'scale'}
              onChange={(e) => setScale(Number(e.target.value))}
            />
            <span className="br-unit">%</span>
          </div>
          <div className="br-row">
            <label className="br-radio">
              <input type="radio" checked={sizeMode === 'max'} onChange={() => setSizeMode('max')} />
              Longest side
            </label>
            <input
              className="br-num"
              type="number"
              min={16}
              max={20000}
              value={maxSide}
              disabled={sizeMode !== 'max'}
              onChange={(e) => setMaxSide(Number(e.target.value))}
            />
            <span className="br-unit">px</span>
          </div>
          <div className="br-hint">Images are never enlarged.</div>

          <div className="br-label">Save</div>
          <div className="br-chips">
            <button className={`br-chip${saveMode === 'new' ? ' active' : ''}`} onClick={() => setSaveMode('new')}>New files (_resized)</button>
            <button className={`br-chip${saveMode === 'overwrite' ? ' active' : ''}`} onClick={() => setSaveMode('overwrite')}>Overwrite</button>
          </div>

          <div className="br-label">Format</div>
          {saveMode === 'overwrite' ? (
            <div className="br-hint">Overwrite keeps each file's format. Originals go to the Recycle Bin.</div>
          ) : (
            <div className="br-chips">
              {[['same', 'Same'], ['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP']].map(([v, label]) => (
                <button key={v} className={`br-chip${format === v ? ' active' : ''}`} onClick={() => setFormat(v)}>{label}</button>
              ))}
            </div>
          )}
          {usesQuality && (
            <label className="br-quality">
              <span>JPEG / WebP quality {quality}</span>
              <input type="range" min={50} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
            </label>
          )}

          <button className="br-run" onClick={run} disabled={!sizeValid}>
            {saveMode === 'overwrite' ? 'Resize and overwrite' : 'Resize'}
          </button>
        </div>
      )}
    </div>
  )
}
