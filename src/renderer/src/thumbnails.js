// Image work off the UI thread. Thumbnail cache hits come back from the main process
// as file:// URLs; misses (and bulk resizes) are decoded and re-encoded in a pool of
// Web Workers, then written to disk by the main process.
import ImageWorker from './imageWorker.js?worker&inline'

// Shortest side in px. Covers the largest grid size (200px) at 150% display scaling.
const THUMB_SIZE = 320
const MAX_LONG_SIDE = 1280
const WEBP_QUALITY = 0.82
// A job that takes longer than this is treated as stuck: the worker is replaced
const JOB_TIMEOUT_MS = 30000
const BULK_TIMEOUT_MS = 120000
// Each in-flight job holds a fully decoded image (~48 MB at 12 MP), so the pool is capped
const POOL_SIZE = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 2))
// Bulk resizes also hold a full-size output canvas, so fewer run at once
const BULK_CONCURRENCY = Math.min(3, POOL_SIZE)

// ── Worker pool ─────────────────────────────────────────────────────────────
const workers = []
const idle = []
let nextId = 0

// Each worker runs one job at a time; `job` is its current { id, resolve, timer }
function getWorker() {
  if (idle.length) return idle.pop()
  const w = new ImageWorker()
  w.onmessage = ({ data }) => {
    if (w.job?.id === data.id) finishJob(w, data.out || data.unchanged ? data : null)
  }
  // A crashed worker fails its job and is dropped; the pool starts a fresh one
  w.onerror = () => retire(w)
  workers.push(w)
  return w
}

const hasFreeWorker = () => idle.length > 0 || workers.length < POOL_SIZE

function finishJob(w, result) {
  const job = w.job
  w.job = null
  clearTimeout(job?.timer)
  job?.resolve(result)
}

function retire(w) {
  w.dead = true
  w.terminate()
  workers.splice(workers.indexOf(w), 1)
  finishJob(w, null)
}

function runOnWorker(worker, bytes, op, timeoutMs) {
  return new Promise((resolve) => {
    const id = ++nextId
    worker.job = { id, resolve, timer: setTimeout(() => retire(worker), timeoutMs) }
    // Transfer the buffer instead of copying it (IPC hands us a fresh, unshared one)
    const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer
    worker.postMessage({ id, bytes: buf, op }, [buf])
  })
}

// ── Scheduling ──────────────────────────────────────────────────────────────
// Thumbnails go newest-first, since the latest request is what just scrolled into
// view. Bulk jobs run in order, a few at a time, and only when no thumbnail waits.
const thumbQueue = []
const bulkQueue = []
let bulkActive = 0

function pump() {
  while (hasFreeWorker()) {
    let job
    if (thumbQueue.length) job = thumbQueue.pop()
    else if (bulkQueue.length && bulkActive < BULK_CONCURRENCY) job = bulkQueue.shift()
    else return
    const worker = getWorker()
    if (job.bulk) bulkActive++
    job.run(worker).finally(() => {
      if (job.bulk) bulkActive--
      if (!worker.dead) idle.push(worker)
      pump()
    })
  }
}

// ── Thumbnails ──────────────────────────────────────────────────────────────
const requests = new Map() // image path → { listeners: Set, job: queued job | null }

function finish(path, req, url) {
  if (requests.get(path) === req) requests.delete(path)
  for (const fn of req.listeners) fn(url)
}

async function start(path, req) {
  const res = await window.electronAPI.getThumbnail(path)
  if (req.listeners.size === 0) { // scrolled away meanwhile
    if (requests.get(path) === req) requests.delete(path)
    return
  }
  if (!res) return finish(path, req, null)
  if (res.url) return finish(path, req, res.url)
  req.job = {
    run: async (worker) => {
      req.job = null
      let url = null
      try {
        const bytes = await window.electronAPI.readImageBytes(path)
        const result = bytes && await runOnWorker(worker, bytes, {
          kind: 'thumb', size: THUMB_SIZE, maxLongSide: MAX_LONG_SIDE, mime: 'image/webp', quality: WEBP_QUALITY,
        }, JOB_TIMEOUT_MS)
        url = result?.out ? await window.electronAPI.saveThumbnail(res.file, result.out) : null
      } catch {}
      finish(path, req, url)
    },
  }
  thumbQueue.push(req.job)
  pump()
}

// Ask for a thumbnail; onReady(url | null) is called once. The returned function
// cancels the request: a thumbnail still waiting in the queue is dropped (one already
// being generated finishes and is cached, but nobody is notified).
export function requestThumbnail(path, onReady) {
  // SVGs are vectors (and can't be decoded in a worker): show the file itself
  if (/\.svg$/i.test(path)) {
    let cancelled = false
    queueMicrotask(() => { if (!cancelled) onReady(`file:///${path.replace(/\\/g, '/')}`) })
    return () => { cancelled = true }
  }
  let req = requests.get(path)
  if (!req) {
    req = { listeners: new Set(), job: null }
    requests.set(path, req)
    start(path, req)
  }
  req.listeners.add(onReady)
  return () => {
    req.listeners.delete(onReady)
    if (req.listeners.size === 0 && req.job) {
      thumbQueue.splice(thumbQueue.indexOf(req.job), 1)
      req.job = null
      if (requests.get(path) === req) requests.delete(path)
    }
  }
}

// ── Bulk resize ─────────────────────────────────────────────────────────────
// opts: { scale } or { maxSide }, plus mime and quality (0–1).
// Resolves { out, width, height } | { unchanged: true } | null on failure.
export function resizeImage(path, opts) {
  return new Promise((resolve) => {
    bulkQueue.push({
      bulk: true,
      run: async (worker) => {
        try {
          const bytes = await window.electronAPI.readImageBytes(path)
          resolve(bytes ? await runOnWorker(worker, bytes, { kind: 'resize', ...opts }, BULK_TIMEOUT_MS) : null)
        } catch {
          resolve(null)
        }
      },
    })
    pump()
  })
}
