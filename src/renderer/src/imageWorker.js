// Decodes an image with Chromium, resizes it and re-encodes it. Runs in a Web Worker
// so the work happens off both the UI thread and the main process.
//
// op.kind 'thumb':  shortest side = op.size (thumbnails are square, object-fit: cover),
//                   long side capped at op.maxLongSide
// op.kind 'resize': op.scale (0–1), or longest side = op.maxSide
// Never upscales. A 'resize' that wouldn't change the size returns { unchanged: true }.

function targetScale(op, w, h) {
  if (op.kind === 'thumb') {
    let s = Math.min(1, op.size / Math.min(w, h))
    if (Math.max(w, h) * s > op.maxLongSide) s = op.maxLongSide / Math.max(w, h)
    return s
  }
  return Math.min(1, op.scale ?? op.maxSide / Math.max(w, h))
}

self.onmessage = async ({ data: { id, bytes, op } }) => {
  try {
    const full = await createImageBitmap(new Blob([bytes]))
    const { width: w, height: h } = full
    const s = targetScale(op, w, h)
    const tw = Math.max(1, Math.round(w * s))
    const th = Math.max(1, Math.round(h * s))
    if (op.kind === 'resize' && tw === w && th === h) {
      full.close()
      self.postMessage({ id, unchanged: true, width: w, height: h })
      return
    }

    const bitmap = s < 1
      ? await createImageBitmap(full, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' })
      : full
    if (bitmap !== full) full.close()

    const canvas = new OffscreenCanvas(tw, th)
    const ctx = canvas.getContext('2d')
    if (op.mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, tw, th) } // JPEG has no alpha
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    const blob = await canvas.convertToBlob({ type: op.mime, quality: op.quality })
    const out = await blob.arrayBuffer()
    self.postMessage({ id, out, width: tw, height: th }, [out])
  } catch (err) {
    self.postMessage({ id, out: null, error: err?.message || String(err) })
  }
}
