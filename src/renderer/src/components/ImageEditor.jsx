import { useState, useEffect, useRef, useLayoutEffect } from 'react'
import './ImageEditor.css'

const ASPECTS = [
  { label: 'Free', value: 'free' },
  { label: 'Original', value: 'original' },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '3:2', value: 3 / 2 },
  { label: '2:3', value: 2 / 3 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
]

const FORMATS = [
  { label: 'PNG', value: 'png', mime: 'image/png', ext: 'png' },
  { label: 'JPEG', value: 'jpeg', mime: 'image/jpeg', ext: 'jpg' },
  { label: 'WebP', value: 'webp', mime: 'image/webp', ext: 'webp' },
]

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

function basename(p) {
  return p.split(/[\\/]/).pop()
}

// Format the file can be overwritten in, judged by its extension
function formatForPath(p) {
  const ext = p.split('.').pop().toLowerCase()
  if (ext === 'png') return 'png'
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg'
  if (ext === 'webp') return 'webp'
  return null
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

// Snap to whole pixels without letting rounding push the rect past the image edge
function roundRect(r, W, H) {
  const x = clamp(Math.round(r.x), 0, W - 1)
  const y = clamp(Math.round(r.y), 0, H - 1)
  return { x, y, w: clamp(Math.round(r.w), 1, W - x), h: clamp(Math.round(r.h), 1, H - y) }
}

// Largest rect of the given ratio that fits the image, centered
function fitRatio(ratio, W, H) {
  let w = W, h = W / ratio
  if (h > H) { h = H; w = H * ratio }
  return roundRect({ x: (W - w) / 2, y: (H - h) / 2, w, h }, W, H)
}

// Rect spanning from a fixed anchor point to the pointer, optionally ratio-locked,
// kept inside the image
function rectFromAnchor(ax, ay, px, py, ratio, W, H) {
  const sx = px >= ax ? 1 : -1
  const sy = py >= ay ? 1 : -1
  let w = Math.abs(px - ax)
  let h = Math.abs(py - ay)
  const maxW = sx > 0 ? W - ax : ax
  const maxH = sy > 0 ? H - ay : ay
  if (ratio) {
    if (w / ratio > h) h = w / ratio
    else w = h * ratio
    if (w === 0) return { x: ax, y: ay, w: 1, h: 1 }
    const s = Math.min(1, maxW / w, maxH / h)
    w *= s
    h *= s
  } else {
    w = Math.min(w, maxW)
    h = Math.min(h, maxH)
  }
  return { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h }
}

// Edge drag: one side moves, the opposite side stays; with a ratio the other
// dimension grows around the rect's center line
function rectFromEdge(start, edge, dx, dy, ratio, W, H) {
  const horizontal = edge === 'e' || edge === 'w'
  if (horizontal) {
    const ax = edge === 'e' ? start.x : start.x + start.w
    let w = edge === 'e' ? start.w + dx : start.w - dx
    w = clamp(w, 1, edge === 'e' ? W - ax : ax)
    let h = start.h, y = start.y
    if (ratio) {
      const cy = start.y + start.h / 2
      const maxH = 2 * Math.min(cy, H - cy)
      h = w / ratio
      if (h > maxH) { h = maxH; w = h * ratio }
      y = cy - h / 2
    }
    return { x: edge === 'e' ? ax : ax - w, y, w, h }
  }
  const ay = edge === 's' ? start.y : start.y + start.h
  let h = edge === 's' ? start.h + dy : start.h - dy
  h = clamp(h, 1, edge === 's' ? H - ay : ay)
  let w = start.w, x = start.x
  if (ratio) {
    const cx = start.x + start.w / 2
    const maxW = 2 * Math.min(cx, W - cx)
    w = h * ratio
    if (w > maxW) { w = maxW; h = w / ratio }
    x = cx - w / 2
  }
  return { x, y: edge === 's' ? ay : ay - h, w, h }
}

// High-quality downscale: halve in steps until within 2× of the target, then the
// final draw. Single-pass canvas scaling aliases badly on big reductions.
function renderOutput(bitmap, crop, outW, outH, fillWhite) {
  let src = bitmap, sx = crop.x, sy = crop.y, sw = crop.w, sh = crop.h
  while (sw / 2 >= outW && sh / 2 >= outH) {
    const step = new OffscreenCanvas(Math.round(sw / 2), Math.round(sh / 2))
    const sctx = step.getContext('2d')
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(src, sx, sy, sw, sh, 0, 0, step.width, step.height)
    src = step; sx = 0; sy = 0; sw = step.width; sh = step.height
  }
  const canvas = new OffscreenCanvas(outW, outH)
  const ctx = canvas.getContext('2d')
  if (fillWhite) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, outW, outH) } // JPEG has no alpha
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, outW, outH)
  return canvas
}

function NumField({ label, value, min, max, onChange }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  function commit(raw) {
    const n = Math.round(Number(raw))
    if (!Number.isFinite(n)) { setDraft(String(value)); return }
    const v = clamp(n, min, max)
    setDraft(String(v))
    if (v !== value) onChange(v)
  }
  return (
    <label className="ie-num">
      <span>{label}</span>
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        onChange={(e) => {
          setDraft(e.target.value)
          // Apply as you type when the value is already valid; out-of-range is fixed on blur
          const n = Number(e.target.value)
          if (e.target.value !== '' && Number.isInteger(n) && n >= min && n <= max && n !== value) onChange(n)
        }}
        onBlur={(e) => commit(e.target.value)}
      />
    </label>
  )
}

export default function ImageEditor({ path, onClose, onSaved }) {
  const [bitmap, setBitmap] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)
  const [error, setError] = useState(null)
  const [crop, setCrop] = useState(null)
  const [aspect, setAspect] = useState('free')
  const [out, setOut] = useState({ w: 0, h: 0 })
  const [outTouched, setOutTouched] = useState(false)
  const [lockOut, setLockOut] = useState(true)
  const fileFormat = formatForPath(path)
  const [format, setFormat] = useState(fileFormat ?? 'png')
  const [quality, setQuality] = useState(92)
  const [saving, setSaving] = useState(false)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const stageRef = useRef(null)
  const imgRef = useRef(null)
  const canvasRef = useRef(null)
  const dragRef = useRef(null)

  const W = bitmap?.width ?? 0
  const H = bitmap?.height ?? 0
  const ratio = aspect === 'free' ? null : aspect === 'original' ? W / H : aspect

  // Decode through a Blob (not a file:// URL) so the canvas stays untainted and every
  // format Chromium knows — WebP, AVIF, GIF — works
  useEffect(() => {
    let cancelled = false
    let url = null
    ;(async () => {
      try {
        const bytes = await window.electronAPI.readImageBytes(path)
        if (!bytes) throw new Error('Could not read the file.')
        const blob = new Blob([bytes])
        const bm = await createImageBitmap(blob)
        if (cancelled) { bm.close(); return }
        url = URL.createObjectURL(blob)
        setBitmap(bm)
        setPreviewUrl(url)
        setCrop({ x: 0, y: 0, w: bm.width, h: bm.height })
        setOut({ w: bm.width, h: bm.height })
      } catch (err) {
        if (!cancelled) setError(err?.message || String(err))
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [path])

  useEffect(() => () => bitmap?.close(), [bitmap])

  // Track the stage size so the preview scale follows window resizes
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setStage({ w: width, h: height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keep the editor modal: Escape closes it and no key reaches the app's shortcuts
  // (arrows, Space, F5) underneath
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      e.stopPropagation()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onClose])

  // Output size follows the crop until the user sets it; once set and locked,
  // the width is kept and the height follows the crop's proportions
  useEffect(() => {
    if (!crop) return
    if (!outTouched) setOut({ w: crop.w, h: crop.h })
    else if (lockOut) setOut((o) => ({ w: o.w, h: Math.max(1, Math.round(o.w * crop.h / crop.w)) }))
  }, [crop, outTouched, lockOut])

  const scale = W && stage.w ? Math.min(stage.w / W, stage.h / H, 1) : 0

  function toImageCoords(e) {
    const rect = imgRef.current.getBoundingClientRect()
    return {
      x: clamp((e.clientX - rect.left) / scale, 0, W),
      y: clamp((e.clientY - rect.top) / scale, 0, H),
    }
  }

  function startDrag(e, mode) {
    if (e.button !== 0 || !crop) return
    e.preventDefault()
    e.stopPropagation()
    const p = toImageCoords(e)
    dragRef.current = { mode, start: { ...crop }, p0: p }
    // Capture on the canvas so every move lands in one handler, wherever the pointer goes
    canvasRef.current.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e) {
    const d = dragRef.current
    if (!d) return
    const p = toImageCoords(e)
    const dx = p.x - d.p0.x
    const dy = p.y - d.p0.y
    const s = d.start
    let next
    if (d.mode === 'move') {
      next = { ...s, x: clamp(s.x + dx, 0, W - s.w), y: clamp(s.y + dy, 0, H - s.h) }
    } else if (d.mode === 'new') {
      if (Math.abs(dx) * scale < 3 && Math.abs(dy) * scale < 3) return // a click, not a drag
      next = rectFromAnchor(d.p0.x, d.p0.y, p.x, p.y, ratio, W, H)
    } else if (d.mode.length === 2) {
      // Corner: the opposite corner is the anchor
      const ax = d.mode.includes('w') ? s.x + s.w : s.x
      const ay = d.mode.includes('n') ? s.y + s.h : s.y
      const px = d.mode.includes('w') ? s.x + dx : s.x + s.w + dx
      const py = d.mode.includes('n') ? s.y + dy : s.y + s.h + dy
      next = rectFromAnchor(ax, ay, px, py, ratio, W, H)
    } else {
      next = rectFromEdge(s, d.mode, dx, dy, ratio, W, H)
    }
    setCrop(roundRect(next, W, H))
  }

  function endDrag() {
    dragRef.current = null
  }

  function handleAspect(value) {
    setAspect(value)
    const r = value === 'free' ? null : value === 'original' ? W / H : value
    if (r) setCrop(fitRatio(r, W, H))
  }

  // Numeric crop edits; with a ratio, width and height drive each other
  function setCropField(field, v) {
    setCrop((c) => {
      let n = { ...c, [field]: v }
      if (ratio && field === 'w') n.h = n.w / ratio
      if (ratio && field === 'h') n.w = n.h * ratio
      if (n.w > W - n.x) { n.w = W - n.x; if (ratio) n.h = n.w / ratio }
      if (n.h > H - n.y) { n.h = H - n.y; if (ratio) n.w = n.h * ratio }
      return roundRect(n, W, H)
    })
  }

  function setOutField(field, v) {
    setOutTouched(true)
    setOut((o) => {
      if (!lockOut) return { ...o, [field]: v }
      return field === 'w'
        ? { w: v, h: Math.max(1, Math.round(v * crop.h / crop.w)) }
        : { w: Math.max(1, Math.round(v * crop.w / crop.h)), h: v }
    })
  }

  function setOutPercent(pct) {
    setOutTouched(true)
    setOut({ w: Math.max(1, Math.round(crop.w * pct / 100)), h: Math.max(1, Math.round(crop.h * pct / 100)) })
  }

  function handleReset() {
    setAspect('free')
    setCrop({ x: 0, y: 0, w: W, h: H })
    setOut({ w: W, h: H })
    setOutTouched(false)
    setLockOut(true)
  }

  async function handleSave(mode) {
    if (saving || !bitmap) return
    if (mode === 'overwrite' && !window.confirm(
      `Overwrite "${basename(path)}"?\n\nThe original will be moved to the Recycle Bin.`
    )) return
    setSaving(true)
    try {
      const fmt = FORMATS.find((f) => f.value === format)
      const canvas = renderOutput(bitmap, crop, out.w, out.h, format === 'jpeg')
      const blob = await canvas.convertToBlob({
        type: fmt.mime,
        quality: format === 'png' ? undefined : quality / 100,
      })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const saved = await window.electronAPI.saveEditedImage(path, bytes, fmt.ext, mode)
      if (saved) {
        onSaved(saved, mode)
        onClose()
      }
    } catch (err) {
      alert(`Could not save the image:\n${err?.message || err}`)
    } finally {
      setSaving(false)
    }
  }

  const canOverwrite = fileFormat !== null && format === fileFormat
  const isFullImage = crop && crop.x === 0 && crop.y === 0 && crop.w === W && crop.h === H
  const unchanged = isFullImage && out.w === W && out.h === H

  return (
    <div className="ie-backdrop">
      <div className="ie-window">
        <div className="ie-header">
          <span className="ie-title" title={path}>Resize / Crop — {basename(path)}</span>
          <button className="ie-close" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        <div className="ie-body">
          <div className="ie-stage" ref={stageRef}>
            {error && <div className="ie-message">{error}</div>}
            {!error && !bitmap && <div className="ie-message">Loading…</div>}
            {bitmap && previewUrl && scale > 0 && crop && (
              <div
                ref={canvasRef}
                className="ie-canvas"
                style={{ width: W * scale, height: H * scale }}
                onPointerDown={(e) => startDrag(e, 'new')}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <img ref={imgRef} src={previewUrl} alt="" draggable={false} />
                {/* Four panels dim everything outside the crop */}
                <div className="ie-shade" style={{ left: 0, top: 0, right: 0, height: crop.y * scale }} />
                <div className="ie-shade" style={{ left: 0, right: 0, top: (crop.y + crop.h) * scale, bottom: 0 }} />
                <div className="ie-shade" style={{ left: 0, top: crop.y * scale, width: crop.x * scale, height: crop.h * scale }} />
                <div className="ie-shade" style={{ left: (crop.x + crop.w) * scale, right: 0, top: crop.y * scale, height: crop.h * scale }} />
                <div
                  className="ie-crop"
                  style={{
                    left: crop.x * scale,
                    top: crop.y * scale,
                    width: crop.w * scale,
                    height: crop.h * scale,
                  }}
                  // A full-image crop can't move, so dragging inside it draws a new box instead
                  onPointerDown={(e) => startDrag(e, isFullImage ? 'new' : 'move')}
                >
                  <div className="ie-grid" />
                  {HANDLES.map((h) => (
                    <div
                      key={h}
                      className={`ie-handle ie-handle-${h}`}
                      onPointerDown={(e) => startDrag(e, h)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="ie-panel">
            <div className="ie-section-title">Crop</div>
            <div className="ie-aspects">
              {ASPECTS.map((a) => (
                <button
                  key={a.label}
                  className={`ie-chip${aspect === a.value ? ' active' : ''}`}
                  onClick={() => handleAspect(a.value)}
                  disabled={!bitmap}
                >
                  {a.label}
                </button>
              ))}
            </div>
            {crop && (
              <div className="ie-grid2">
                <NumField label="X" value={crop.x} min={0} max={W - crop.w} onChange={(v) => setCropField('x', v)} />
                <NumField label="Y" value={crop.y} min={0} max={H - crop.h} onChange={(v) => setCropField('y', v)} />
                <NumField label="W" value={crop.w} min={1} max={W - crop.x} onChange={(v) => setCropField('w', v)} />
                <NumField label="H" value={crop.h} min={1} max={H - crop.y} onChange={(v) => setCropField('h', v)} />
              </div>
            )}

            <div className="ie-section-title">Resize</div>
            {crop && (
              <>
                <div className="ie-grid2">
                  <NumField label="W" value={out.w} min={1} max={20000} onChange={(v) => setOutField('w', v)} />
                  <NumField label="H" value={out.h} min={1} max={20000} onChange={(v) => setOutField('h', v)} />
                </div>
                <label className="ie-check">
                  <input type="checkbox" checked={lockOut} onChange={(e) => setLockOut(e.target.checked)} />
                  Keep proportions
                </label>
                <div className="ie-aspects">
                  {[25, 50, 75, 100].map((pct) => (
                    <button key={pct} className="ie-chip" onClick={() => setOutPercent(pct)}>{pct}%</button>
                  ))}
                </div>
              </>
            )}

            <div className="ie-section-title">Format</div>
            <div className="ie-aspects">
              {FORMATS.map((f) => (
                <button
                  key={f.value}
                  className={`ie-chip${format === f.value ? ' active' : ''}`}
                  onClick={() => setFormat(f.value)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {format !== 'png' && (
              <label className="ie-quality">
                <span>Quality {quality}</span>
                <input type="range" min={50} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
              </label>
            )}
            {format === 'png' && fileFormat === 'png' && (
              <div className="ie-note">PNG text metadata (e.g. generation parameters) is kept.</div>
            )}

            <div className="ie-summary">
              {bitmap && <>Original {W} × {H}<br />Output <strong>{out.w} × {out.h}</strong> {format.toUpperCase()}</>}
            </div>

            <div className="ie-actions">
              <button className="ie-btn" onClick={handleReset} disabled={!bitmap || saving}>Reset</button>
              <button className="ie-btn" onClick={onClose} disabled={saving}>Cancel</button>
              <button
                className="ie-btn ie-btn-primary"
                onClick={() => handleSave('new')}
                disabled={!bitmap || saving}
                title="Save to a new file"
              >
                Save as new…
              </button>
              <button
                className="ie-btn ie-btn-danger"
                onClick={() => handleSave('overwrite')}
                disabled={!bitmap || saving || !canOverwrite || unchanged}
                title={canOverwrite
                  ? 'Replace the original (it goes to the Recycle Bin)'
                  : `Overwrite keeps the file's own format — pick ${fileFormat ? fileFormat.toUpperCase() : 'PNG, JPEG or WebP'} or use Save as new`}
              >
                Overwrite
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
