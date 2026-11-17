// Image work off the UI thread. Thumbnail cache hits come back from the backend as
// loadable URLs; misses (and bulk resizes) are decoded and re-encoded in a pool of
// Web Workers, then written to disk by the backend.
import ImageWorker from './imageWorker.js?worker&inline'
import { fileUrl } from './backend'

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

// Workers left idle this long are shut down, giving their memory back
const IDLE_SHUTDOWN_MS = 8000
let idleTimer = 0

// Each worker runs one job at a time; `job` is its current { id, resolve, timer }
function getWorker() {
  clearTimeout(idleTimer)
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

// The worker reads the file itself through the asset protocol, so file bytes never
// pass through the UI thread
function runOnWorker(worker, path, op, timeoutMs) {
  return new Promise((resolve) => {
    const id = ++nextId
    worker.job = { id, resolve, timer: setTimeout(() => retire(worker), timeoutMs) }
    worker.postMessage({ id, url: fileUrl(path), op })
  })
}

// ── Scheduling ──────────────────────────────────────────────────────────────
// Thumbnails on screen go before those just off it (mounted ahead of scrolling),
// and newest-first within each, since the latest request is what just scrolled into
// view. Bulk jobs run in order, a few at a time, and only when no thumbnail waits.
const thumbQueue = []
const bulkQueue = []
let bulkActive = 0

function takeThumbJob() {
  for (let i = thumbQueue.length - 1; i >= 0; i--) {
    if (thumbQueue[i].req.onScreen) return thumbQueue.splice(i, 1)[0]
  }
  return thumbQueue.pop()
}

function pump() {
  while (hasFreeWorker()) {
    let job
    if (thumbQueue.length) job = takeThumbJob()
    else if (bulkQueue.length && bulkActive < BULK_CONCURRENCY) job = bulkQueue.shift()
    else {
      if (idle.length === workers.length) { // nothing running
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          for (const w of idle.splice(0)) retire(w)
        }, IDLE_SHUTDOWN_MS)
      }
      return
    }
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
// Last URL each image's thumbnail loaded from. The grid only mounts the thumbnails
// near the viewport, so one scrolled back into view shows this right away (no
// placeholder flash) while its request re-checks the cache.
const known = new Map()
// The most recently shown thumbnails stay loaded in an Image object each. That keeps
// the (small, encoded) files in Chromium's memory cache, so a thumbnail scrolling back
// into view is complete on its very first frame instead of reloading and flashing.
const PINNED_MAX = 600
const pinned = new Map() // url → Image, oldest first

function pin(url) {
  const img = pinned.get(url)
  if (img) { pinned.delete(url); pinned.set(url, img); return }
  const next = new Image()
  next.src = url
  pinned.set(url, next)
  if (pinned.size > PINNED_MAX) pinned.delete(pinned.keys().next().value)
}

export function peekThumbnail(path) {
  const url = known.get(path) ?? null
  if (url) pin(url)
  return url
}

export function forgetThumbnails() {
  known.clear()
  pinned.clear()
}

function finish(path, req, url) {
  if (requests.get(path) === req) requests.delete(path)
  if (url) { known.set(path, url); pin(url) }
  else known.delete(path)
  for (const fn of req.listeners) fn(url)
}

// Cache lookups are batched per frame: every IPC call costs the UI thread a few ms,
// and scrolling mounts a row or more of thumbnails at a time
let lookupBatch = null // Map path → [resolve]

function lookup(path) {
  return new Promise((resolve) => {
    if (!lookupBatch) {
      lookupBatch = new Map()
      setTimeout(sendLookups, 0) // after the current commit has mounted everything
    }
    const waiting = lookupBatch.get(path)
    if (waiting) waiting.push(resolve)
    else lookupBatch.set(path, [resolve])
  })
}

async function sendLookups() {
  const batch = lookupBatch
  lookupBatch = null
  const paths = [...batch.keys()]
  const results = await window.folio.getThumbnails(paths).catch(() => paths.map(() => null))
  paths.forEach((p, i) => { for (const resolve of batch.get(p)) resolve(results[i]) })
}

// Generated thumbnails are saved in batches too, gathered over a short window
const SAVE_BATCH_MS = 40
let saveBatch = null // [{ path, token, bytes, resolve }]

function saveThumbnail(path, token, bytes) {
  return new Promise((resolve) => {
    if (!saveBatch) {
      saveBatch = []
      setTimeout(sendSaves, SAVE_BATCH_MS)
    }
    saveBatch.push({ path, token, bytes, resolve })
  })
}

async function sendSaves() {
  const batch = saveBatch
  saveBatch = null
  const urls = await window.folio.saveThumbnails(batch)
  batch.forEach((it, i) => it.resolve(urls[i]))
}

async function start(path, req) {
  const res = await lookup(path)
  if (res?.url) return finish(path, req, res.url) // a cache hit is worth remembering even if nobody waits
  if (req.listeners.size === 0) { // scrolled away meanwhile
    if (requests.get(path) === req) requests.delete(path)
    return
  }
  if (!res) return finish(path, req, null)
  req.job = {
    req,
    // Resolves once the worker is done, so it takes the next job while the save is
    // still waiting for its batch
    run: async (worker) => {
      req.job = null
      const result = await runOnWorker(worker, path, {
        kind: 'thumb', size: THUMB_SIZE, maxLongSide: MAX_LONG_SIDE, mime: 'image/webp', quality: WEBP_QUALITY,
      }, JOB_TIMEOUT_MS).catch(() => null)
      if (!result?.out) return finish(path, req, null)
      saveThumbnail(path, res.token, result.out).then((url) => finish(path, req, url))
    },
  }
  thumbQueue.push(req.job)
  pump()
}

// Ask for a thumbnail; onReady(url | null) is called once. The returned function
// cancels the request: a thumbnail still waiting in the queue is dropped (one already
// being generated finishes and is cached, but nobody is notified). onScreen requests
// are generated first; setThumbnailOnScreen updates that as the grid scrolls.
export function requestThumbnail(path, onReady, onScreen = true) {
  // SVGs are vectors (and can't be decoded in a worker): show the file itself
  if (/\.svg$/i.test(path)) {
    let cancelled = false
    queueMicrotask(() => { if (!cancelled) onReady(fileUrl(path)) })
    return () => { cancelled = true }
  }
  let req = requests.get(path)
  if (!req) {
    req = { listeners: new Set(), job: null, onScreen }
    requests.set(path, req)
    start(path, req)
  } else if (onScreen) req.onScreen = true
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

export function setThumbnailOnScreen(path, onScreen) {
  const req = requests.get(path)
  if (req) req.onScreen = onScreen
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
          resolve(await runOnWorker(worker, path, { kind: 'resize', ...opts }, BULK_TIMEOUT_MS))
        } catch {
          resolve(null)
        }
      },
    })
    pump()
  })
}
