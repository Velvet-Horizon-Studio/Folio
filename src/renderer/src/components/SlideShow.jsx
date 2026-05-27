import { useState, useEffect, useRef } from 'react'
import './SlideShow.css'

// Two slots alternate as front/back buffers for smooth crossfade.
// The outgoing image stays visible while the incoming one animates in.

export default function SlideShow({ image, index, total, transition, transitionDuration, isFullscreen, onToggleFullscreen }) {
  const [slots, setSlots] = useState([
    { src: null, state: 'active' },
    { src: null, state: 'idle' },
  ])
  const frontRef = useRef(0)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const slideshowRef = useRef(null)
  const dragRef = useRef({ active: false, startX: 0, startY: 0, startOX: 0, startOY: 0 })

  // Reset zoom/offset/drag on image change
  useEffect(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    dragRef.current.active = false
    setIsDragging(false)

    if (!image) {
      setSlots([{ src: null, state: 'active' }, { src: null, state: 'idle' }])
      frontRef.current = 0
      return
    }

    const src = `file:///${image.path.replace(/\\/g, '/')}`
    const curr = frontRef.current
    const next = 1 - curr

    if (transition === 'none') {
      setSlots(prev => {
        const s = [...prev]
        s[curr] = { src, state: 'active' }
        s[next] = { ...s[next], state: 'idle' }
        return s
      })
      return
    }

    // Place new image in the inactive slot at its start position (no transition yet)
    frontRef.current = next
    setSlots(prev => {
      const s = [...prev]
      s[next] = { src, state: 'enter-start' }
      return s
    })

    // Two rAFs: first lets React commit enter-start, second triggers the CSS transition
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setSlots(prev => {
          const s = [...prev]
          s[next] = { src, state: 'active' }
          s[curr] = { ...s[curr], state: 'leave' }
          return s
        })
      })
    })
  }, [index, image, transition])

  // Wheel zoom — passive:false so preventDefault works
  useEffect(() => {
    const el = slideshowRef.current
    if (!el) return
    const handler = (e) => {
      e.preventDefault()
      const step = e.deltaY < 0 ? 0.1 : -0.1
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
        setZoom(z => Math.min(5, parseFloat((z + 0.1).toFixed(2))))
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
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
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }

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
          {slots.map((slot, i) => {
            const isFront = i === frontRef.current
            const isInteractive = isFront && slot.state === 'active'
            const needsStyle = offset.x || offset.y || zoom !== 1
            const imgStyle = needsStyle ? {
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              transition: isDragging ? 'none' : 'transform 0.05s ease-out',
            } : undefined

            return (
              <div
                key={i}
                className={`slideshow-slot slot-${slot.state} transition-${transition}`}
                onMouseDown={isInteractive ? handleMouseDown : undefined}
                onDoubleClick={isInteractive ? onToggleFullscreen : undefined}
                onContextMenu={isInteractive ? handleContextMenu : undefined}
                style={isInteractive ? { cursor: isDragging ? 'grabbing' : 'grab' } : undefined}
              >
                {slot.src && (
                  <img
                    className="slideshow-img"
                    src={slot.src}
                    alt=""
                    draggable={false}
                    style={imgStyle}
                  />
                )}
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
