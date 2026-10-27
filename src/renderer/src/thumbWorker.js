// Decodes an image with Chromium and returns a small WebP thumbnail. Runs in a
// Web Worker so decoding happens off both the UI thread and the main process.

self.onmessage = async ({ data: { id, bytes, size, maxLongSide, quality } }) => {
  try {
    const full = await createImageBitmap(new Blob([bytes]))
    const { width: w, height: h } = full
    // Shortest side = size (thumbnails are square, object-fit: cover), with the
    // long side capped for panoramas; never upscale
    let s = Math.min(1, size / Math.min(w, h))
    if (Math.max(w, h) * s > maxLongSide) s = maxLongSide / Math.max(w, h)
    const tw = Math.max(1, Math.round(w * s))
    const th = Math.max(1, Math.round(h * s))

    const bitmap = s < 1
      ? await createImageBitmap(full, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' })
      : full
    if (bitmap !== full) full.close()

    const canvas = new OffscreenCanvas(tw, th)
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    bitmap.close()
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality })
    const out = await blob.arrayBuffer()
    self.postMessage({ id, out }, [out])
  } catch (err) {
    self.postMessage({ id, out: null, error: err?.message || String(err) })
  }
}
