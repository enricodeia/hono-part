// Export payload: the JSON every export carries (SPEC §6).
//   { config, shapes: [encodeShape(shape, n), ...], sequence, options }
// Config is filtered against DEFAULT_CONFIG so editor-only keys never leak into
// a deliverable, and every value is type-checked (a bad preset cannot break it).

import { DEFAULT_CONFIG } from '../../state.js'
import { encodeShape } from '../../runtime/codec.js'

export const EXPORT_FORMAT_VERSION = 1

export const DEFAULT_EXPORT_OPTIONS = {
  title: 'Pulviscolo',
  three: 'inline', // 'inline' (offline, three bundled) | 'cdn' (import map to jsDelivr)
  layout: 'fullscreen', // 'fullscreen' | 'embed'
  height: '100vh', // container height in embed layout
  transparent: false,
  interactive: true,
  allCounts: false, // embed all 8000 particles so count can still be changed at runtime
  sequence: { enabled: false, shapes: [], interval: 6, trigger: 'both' },
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// Keeps only keys present in `base`, with the base's type; missing or invalid
// values fall back to the base. `fill = false` returns a partial (for looks).
export function filterLike(base, value, fill = true) {
  const out = {}
  const src = isPlain(value) ? value : {}
  for (const k of Object.keys(base)) {
    const d = base[k]
    const v = src[k]
    if (isPlain(d)) {
      if (k === 'shapeParams') {
        if (isPlain(v)) out[k] = sanitizeShapeParams(v)
        else if (fill) out[k] = {}
        continue
      }
      const sub = filterLike(d, v, fill)
      if (fill || Object.keys(sub).length) out[k] = sub
      continue
    }
    if (v === undefined) {
      if (fill) out[k] = d
      continue
    }
    const ok =
      typeof d === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof d === typeof v
    if (ok) out[k] = v
    else if (fill) out[k] = d
  }
  return out
}

function sanitizeShapeParams(sp) {
  const out = {}
  for (const [id, params] of Object.entries(sp)) {
    if (!isPlain(params)) continue
    const p = {}
    for (const [k, v] of Object.entries(params)) {
      if (['number', 'string', 'boolean'].includes(typeof v) && (typeof v !== 'number' || Number.isFinite(v))) p[k] = v
    }
    out[id] = p
  }
  return out
}

export const sanitizeConfig = (config) => filterLike(DEFAULT_CONFIG, config, true)
export const sanitizeLook = (look) => filterLike(DEFAULT_CONFIG, look, false)

export function sanitizeExportOptions(opts) {
  const o = { ...DEFAULT_EXPORT_OPTIONS, ...(isPlain(opts) ? opts : {}) }
  const seq = { ...DEFAULT_EXPORT_OPTIONS.sequence, ...(isPlain(o.sequence) ? o.sequence : {}) }
  return {
    title: typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 200) : DEFAULT_EXPORT_OPTIONS.title,
    three: o.three === 'cdn' ? 'cdn' : 'inline',
    layout: o.layout === 'embed' ? 'embed' : 'fullscreen',
    height: cssLength(o.height),
    transparent: !!o.transparent,
    interactive: o.interactive !== false,
    allCounts: !!o.allCounts,
    sequence: {
      enabled: !!seq.enabled,
      shapes: Array.isArray(seq.shapes) ? seq.shapes.filter((s) => typeof s === 'string') : [],
      interval: Number.isFinite(+seq.interval) ? Math.min(120, Math.max(1, +seq.interval)) : 6,
      trigger: ['auto', 'click', 'both'].includes(seq.trigger) ? seq.trigger : 'both',
    },
  }
}

export function cssLength(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return `${Math.round(v)}px`
  const s = String(v ?? '').trim()
  return /^\d+(\.\d+)?(px|vh|dvh|svh|lvh|vw|%|rem|em)$/.test(s) ? s : DEFAULT_EXPORT_OPTIONS.height
}

export function slug(s) {
  return (
    String(s || 'shape')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\.[a-z0-9]{2,4}$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'shape'
  )
}

export function shapeName(shape) {
  const m = shape?.meta || {}
  if (m.id === 'custom') return 'custom-' + slug(m.label || 'shape')
  return slug(m.id || m.label)
}

// extraShapes entries: ShapeData, or { shape, config } where config is that
// shape's look (partial or full config). The look travels as `look` on the
// encoded shape; decodeShape ignores it, the runtime may apply it on morph.
function normaliseEntry(e) {
  if (e && e.positions) return { shape: e, look: null }
  if (e && e.shape && e.shape.positions) return { shape: e.shape, look: e.config || e.look || null }
  return null
}

export function buildPayload({ config, shape, extraShapes = [], options }) {
  if (!shape || !shape.positions) throw new Error('Pulviscolo export: no shape to export')
  const opts = sanitizeExportOptions(options)
  const cfg = sanitizeConfig(config)
  const id = shape.meta?.id || cfg.shape
  cfg.shape = id
  cfg.count = Math.max(1, Math.min(Math.round(cfg.count), shape.count))
  // Only the current shape's params are meaningful once the shape is baked.
  cfg.shapeParams = cfg.shapeParams[id] ? { [id]: cfg.shapeParams[id] } : {}
  const n = opts.allCounts ? shape.count : cfg.count
  const entries = [{ shape, look: null }, ...extraShapes.map(normaliseEntry).filter(Boolean)]
  const shapes = entries.map(({ shape: s, look }) => {
    const enc = encodeShape(s, Math.min(n, s.count))
    if (look) enc.look = sanitizeLook(look)
    return enc
  })
  return {
    v: EXPORT_FORMAT_VERSION,
    config: cfg,
    shapes,
    sequence: {
      enabled: opts.sequence.enabled && shapes.length > 1,
      interval: opts.sequence.interval,
      trigger: opts.sequence.trigger,
    },
    options: { interactive: opts.interactive, transparent: opts.transparent },
  }
}

// JSON safe to drop inside <script> (any "<" becomes <) and inside JS
// source (U+2028/2029 escaped for old parsers).
export function payloadJSON(payload) {
  return JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export const byteLength = (s) => new TextEncoder().encode(s).length
