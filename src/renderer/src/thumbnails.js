// Thumbnail loading: cache hits come back from the main process as file:// URLs;
// misses are decoded and encoded to WebP in a pool of Web Workers, then saved to
// the disk cache by the main process.
import ThumbWorker from './thumbWorker.js?worker&inline'

// Shortest side in px. Covers the largest grid size (200px) at 150% display scaling.
const THUMB_SIZE = 320
const MAX_LONG_SIDE = 1280
const WEBP_QUALITY = 0.82
// A decode that takes longer than this is treated as stuck: the worker is replaced
const JOB_TIMEOUT_MS = 30000
// Each in-flight job holds a fully decoded image (~48 MB at 12 MP), so the pool is capped
const POOL_SIZE = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 2))

const workers = []
const idle = []
const queue = []
const inflight = new Map() // image path → Promise<url|null>
let nextId = 0

// Each worker runs one job at a time; `job` is its current { id, resolve }
function getWorker() {
  if (idle.length) return idle.pop()
  if (workers.length < POOL_SIZE) {
    const w = new ThumbWorker()
    w.onmessage = ({ data }) => {
      if (w.job?.id === data.id) finishJob(w, data.out)
    }
    // A crashed worker fails its job and is dropped; the pool starts a fresh one
    w.onerror = () => retire(w)
    workers.push(w)
    return w
  }
  return null
}

function finishJob(w, out) {
  const job = w.job
  w.job = null
  clearTimeout(job?.timer)
  job?.resolve(out)
}

function retire(w) {
  w.dead = true
  w.terminate()
  workers.splice(workers.indexOf(w), 1)
  finishJob(w, null)
}

function encodeInWorker(worker, bytes) {
  return new Promise((resolve) => {
    const id = ++nextId
    worker.job = { id, resolve, timer: setTimeout(() => retire(worker), JOB_TIMEOUT_MS) }
    // Transfer the buffer instead of copying it (IPC hands us a fresh, unshared one)
    const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer
    worker.postMessage({ id, bytes: buf, size: THUMB_SIZE, maxLongSide: MAX_LONG_SIDE, quality: WEBP_QUALITY }, [buf])
  })
}

// Each job holds one worker from reading the file to saving the thumbnail, which
// also bounds how many full-size files sit in memory at once
function pump() {
  while (queue.length) {
    const worker = getWorker()
    if (!worker) return
    const { path, file, resolve } = queue.shift()
    ;(async () => {
      try {
        const bytes = await window.electronAPI.readImageBytes(path)
        const webp = bytes && await encodeInWorker(worker, bytes)
        resolve(webp ? await window.electronAPI.saveThumbnail(file, webp) : null)
      } catch {
        resolve(null)
      } finally {
        if (!worker.dead) idle.push(worker)
        pump()
      }
    })()
  }
}

export function loadThumbnail(path) {
  // SVGs are vectors (and can't be decoded in a worker): show the file itself
  if (/\.svg$/i.test(path)) return Promise.resolve(`file:///${path.replace(/\\/g, '/')}`)
  if (inflight.has(path)) return inflight.get(path)
  const p = (async () => {
    const res = await window.electronAPI.getThumbnail(path)
    if (!res) return null
    if (res.url) return res.url
    return new Promise((resolve) => {
      queue.push({ path, file: res.file, resolve })
      pump()
    })
  })().finally(() => inflight.delete(path))
  inflight.set(path, p)
  return p
}
