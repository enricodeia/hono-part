// PNG stills and WebM (or MP4 on Safari) recordings straight off the field.

import { download as save } from './download.js'
import { shapeName } from './payload.js'

const fieldName = (field) => shapeName(field.shape || { meta: { id: field.config?.shape } })

// Width/height from the PNG IHDR chunk (bytes 16..23, big endian).
async function pngSize(blob) {
  try {
    const v = new DataView(await blob.slice(16, 24).arrayBuffer())
    return { w: v.getUint32(0), h: v.getUint32(4) }
  } catch {
    return { w: 0, h: 0 }
  }
}

export async function exportPNG(field, { scale = 2, transparent = false, filename, download = true } = {}) {
  if (!field || typeof field.snapshot !== 'function') throw new Error('Pulviscolo export: no field to capture')
  const blob = await field.snapshot({ scale, transparent })
  if (!blob) throw new Error('Pulviscolo export: snapshot returned nothing')
  const { w, h } = await pngSize(blob)
  const name = filename || `pulviscolo-${fieldName(field)}-${w}x${h}${transparent ? '-transparent' : ''}.png`
  if (download) save(blob, name, 'image/png')
  return Object.assign(blob, { filename: name, width: w, height: h })
}

const MIME_CANDIDATES = [
  ['video/webm;codecs=vp9', 'webm'],
  ['video/webm;codecs=vp8', 'webm'],
  ['video/webm', 'webm'],
  ['video/mp4;codecs=avc1.640028', 'mp4'],
  ['video/mp4;codecs=avc1', 'mp4'],
  ['video/mp4', 'mp4'],
]

export function pickRecordingMime() {
  if (typeof MediaRecorder === 'undefined') return null
  for (const [mime, ext] of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return { mime, ext }
    } catch {
      // isTypeSupported can throw on some engines for unknown codecs
    }
  }
  return null
}

// Records `seconds` of the live canvas. Resolves with the Blob (also downloaded
// unless download:false). `signal` (AbortSignal) stops early and keeps the take.
export async function recordWebM(
  field,
  { seconds = 6, fps = 60, bitrate = 16e6, onProgress, download = true, filename, signal } = {},
) {
  if (!field || typeof field.captureStream !== 'function') throw new Error('Pulviscolo export: no field to record')
  const pick = pickRecordingMime()
  if (!pick) throw new Error('Video recording is not supported in this browser')
  const stream = field.captureStream(fps)
  const rec = new MediaRecorder(stream, { mimeType: pick.mime, videoBitsPerSecond: Math.round(bitrate) })
  const chunks = []
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data)
  }
  const stopped = new Promise((resolve, reject) => {
    rec.onstop = resolve
    rec.onerror = (e) => reject(e.error || new Error('MediaRecorder error'))
  })
  const ms = Math.max(0.25, seconds) * 1000
  let t0 = 0
  let timer = 0
  let raf = 0
  const stop = () => {
    clearTimeout(timer)
    cancelAnimationFrame(raf)
    if (rec.state !== 'inactive') rec.stop()
  }
  const tick = () => {
    const p = Math.min(1, (performance.now() - t0) / ms)
    onProgress?.(p)
    if (p < 1 && rec.state === 'recording') raf = requestAnimationFrame(tick)
  }
  signal?.addEventListener('abort', stop, { once: true })
  rec.start(250)
  t0 = performance.now()
  onProgress?.(0)
  raf = requestAnimationFrame(tick)
  timer = setTimeout(stop, ms)
  try {
    await stopped
  } finally {
    stop()
    stream.getTracks().forEach((t) => t.stop())
    signal?.removeEventListener('abort', stop)
  }
  onProgress?.(1)
  const blob = new Blob(chunks, { type: pick.mime.split(';')[0] })
  const name = filename || `pulviscolo-${fieldName(field)}-${Math.round(seconds)}s.${pick.ext}`
  if (download) save(blob, name)
  return Object.assign(blob, { filename: name, mimeType: pick.mime })
}
