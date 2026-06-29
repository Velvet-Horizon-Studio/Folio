import { useState, useEffect, useRef } from 'react'
import './SlideShow.css'

// Crossfade model: each image is rendered as its own absolutely-positioned layer.
// When the image changes, the previous layer stays underneath as a solid backdrop
// and the incoming layer animates in on top via a CSS @keyframes animation. Because
// the enter animation uses `animation-fill-mode: both`, the incoming image holds its
// start frame (opacity 0) from the very first paint — there is no transition baseline
// to race, so a new image can never "appear instantly" without fading.

export default function SlideShow({ image, index, total, transition, transitionDuration, isFullscreen, onToggleFullscreen }) {
  // layers: [{ id, src }] — last entry is the foreground (current) image
  const [layers, setLayers] = useState([])
  const idRef = useRef(0)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [atRealSize, setAtRealSize] = useState(false)
  const slideshowRef = useRef(null)
  const frontImgRef = useRef(null)
  const dragRef = useRef({ active: false, startX: 0, startY: 0, startOX: 0, startOY: 0 })
  const lastRightClickRef = useRef(0)
  const rightClickTimerRef = useRef(null)

  // Toggle between fit-to-window and native 1:1 pixel size
  function toggleRealSize() {
    const img = frontImgRef.current
    if (!img || !img.naturalWidth || !img.clientWidth) return
    if (atRealSize) {
      setZoom(1)
      setOffset({ x: 0, y: 0 })
      setAtRealSize(false)
    } else {
      const scale = parseFloat((img.naturalWidth / img.clientWidth).toFixed(3))
      setZoom(scale)
      setOffset({ x: 0, y: 0 })
      setAtRealSize(true)
    }
  }

  // Build the layer stack when the image changes. The incoming image is decoded
  // off-screen first so the <img> we mount is already paint-ready — otherwise a
  // large image finishes decoding partway through the fade and pops in instead of
  // fading from its first frame.
  useEffect(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setAtRealSize(false)
    dragRef.current.active = false
    setIsDragging(false)

    if (!image) {
      setLayers([])
      return
    }

    const src = `file:///${image.path.replace(/\\/g, '/')}`
    let cancelled = false

    const show = () => {
      if (cancelled) return
      setLayers(prev => {
        const top = prev[prev.length - 1]
        if (top && top.src === src) return prev // same image already shown — nothing to do
        const id = ++idRef.current
        // No backdrop needed for the first image or when transitions are off
        if (!top || transition === 'none') return [{ id, src }]
        // The backdrop must be a fully-settled, opaque layer. If the current foreground
        // is still animating in (two layers present), keep the existing solid backdrop
        // rather than demoting the half-faded foreground — demoting a mid-animation
        // layer would snap it to full opacity (the "appears instantly" glitch).
        const backdrop = prev.length > 1 ? prev[0] : { id: top.id, src: top.src }
        return [backdrop, { id, src }]
      })
    }

    // Decode off-screen, then mount. A superseding change cancels this pending show.
    const pre = new Image()
    pre.src = src
    if (pre.decode) {
      pre.decode().then(show).catch(show)
    } else {
      pre.onload = show
      pre.onerror = show
    }

    return () => { cancelled = true }
  }, [index, image, transition])

  // Once the incoming image finishes animating, drop the backdrop layer beneath it
  function handleAnimationEnd(endedId) {
    setLayers(prev =>
      prev.length > 1 && prev[prev.length - 1].id === endedId ? prev.slice(-1) : prev
    )
  }

  // Wheel zoom — passive:false so preventDefault works
  useEffect(() => {
    const el = slideshowRef.current
    if (!el) return
    const handler = (e) => {
      e.preventDefault()
      const step = e.deltaY < 0 ? 0.1 : -0.1
      setAtRealSize(false)
      setZoom(z => Math.min(5, Math.max(0.25, parseFloat((z + step).toFixed(2)))))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  // Arrow Up/Down — zoom in/out
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtRealSize(false)
        setZoom(z => Math.min(5, parseFloat((z + 0.1).toFixed(2))))
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtRealSize(false)
        setZoom(z => Math.max(0.25, parseFloat((z - 0.1).toFixed(2))))
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Document-level drag tracking
  useEffect(() => {
    function onMouseMove(e) {
      const d = dragRef.current
      if (!d.active) return
      setOffset({ x: d.startOX + (e.clientX - d.startX), y: d.startOY + (e.clientY - d.startY) })
    }
    function onMouseUp() {
      if (!dragRef.current.active) return
      dragRef.current.active = false
      setIsDragging(false)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // Show grabbing cursor globally while dragging
  useEffect(() => {
    document.body.style.cursor = isDragging ? 'grabbing' : ''
    document.body.style.userSelect = isDragging ? 'none' : ''
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isDragging])

  function handleMouseDown(e) {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, startOX: offset.x, startOY: offset.y }
    setIsDragging(true)
  }

  function handleContextMenu(e) {
    e.preventDefault()
    const now = Date.now()
    if (now - lastRightClickRef.current < 350) {
      // Second right-click within the window → toggle real (1:1) size
      lastRightClickRef.current = 0
      clearTimeout(rightClickTimerRef.current)
      toggleRealSize()
    } else {
      // First right-click → reset zoom/pan, but defer so a second click can cancel it
      lastRightClickRef.current = now
      clearTimeout(rightClickTimerRef.current)
      rightClickTimerRef.current = setTimeout(() => {
        setZoom(1)
        setOffset({ x: 0, y: 0 })
        setAtRealSize(false)
      }, 350)
    }
  }

  const imgStyle = (offset.x || offset.y || zoom !== 1) ? {
    transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
    transition: isDragging ? 'none' : 'transform 0.05s ease-out',
  } : undefined

  return (
    <div
      ref={slideshowRef}
      className={`slideshow${isFullscreen ? ' slideshow-fullscreen' : ''}`}
      style={{ '--transition-duration': `${transitionDuration}ms` }}
    >
      {!image ? (
        <div className="slideshow-placeholder">
          <div className="placeholder-icon">🖼</div>
          <div className="placeholder-text">Add folders to start your slideshow</div>
        </div>
      ) : (
        <>
          {layers.map((layer, i) => {
            const isFront = i === layers.length - 1
            // The foreground image animates in. A CSS animation only plays on mount,
            // and each layer keeps a stable key, so a settled layer never replays it.
            const animating = isFront && transition !== 'none'

            return (
              <div
                key={layer.id}
                className={`slideshow-layer${animating ? ` layer-enter transition-${transition}` : ''}`}
                style={{ zIndex: i, cursor: isFront ? (isDragging ? 'grabbing' : 'grab') : undefined }}
                onAnimationEnd={isFront ? () => handleAnimationEnd(layer.id) : undefined}
                onMouseDown={isFront ? handleMouseDown : undefined}
                onDoubleClick={isFront ? onToggleFullscreen : undefined}
                onContextMenu={isFront ? handleContextMenu : undefined}
              >
                <img
                  ref={isFront ? frontImgRef : undefined}
                  className="slideshow-img"
                  src={layer.src}
                  alt=""
                  draggable={false}
                  style={isFront ? imgStyle : undefined}
                />
              </div>
            )
          })}
          {total > 0 && (
            <div className="slideshow-counter">
              {index + 1} / {total}
              {zoom !== 1 && <span className="zoom-indicator"> · {Math.round(zoom * 100)}%</span>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
