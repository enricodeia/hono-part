// Shape registry. Every ./<name>.js whose default export is a shape definition
// (or an array of them) is picked up automatically; see SPEC.md §Shapes.

import { hashSeed } from './lib/rng.js'
import { MAX_COUNT } from './lib/sampling.js'

const modules = import.meta.glob(['./*.js', '!./index.js'], { eager: true })

// Retired specimens stay buildable by id but leave the index.
// 'triangle' was replaced by the HONE wordmark (Enrico, 2026-10-02).
const RETIRED = new Set(['triangle'])

const ALL = Object.values(modules)
  .flatMap((m) => [].concat(m.default || []))
  .filter((d) => d && d.id && typeof d.generate === 'function')
  .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))

export const SHAPES = ALL.filter((d) => !RETIRED.has(d.id))

export function getShapeDef(id) {
  return ALL.find((s) => s.id === id) || null
}

export function paramDefaults(def) {
  const out = {}
  for (const [k, p] of Object.entries(def?.params || {})) out[k] = p.value
  return out
}

const cache = new Map()

// Builds (or returns the cached) ShapeData for a registered shape.
export function buildShape(id, overrides = {}, seed = 1) {
  const def = getShapeDef(id)
  if (!def) throw new Error(`[shapes] unknown shape "${id}"`)
  const params = { ...paramDefaults(def), ...(overrides || {}) }
  const key = `${id}|${seed}|${JSON.stringify(params)}`
  if (cache.has(key)) return cache.get(key)
  const t0 = performance.now()
  const shape = def.generate(params, { seed: hashSeed(id, seed), maxCount: MAX_COUNT })
  shape.meta.buildMs = Math.round(performance.now() - t0)
  shape.meta.id = shape.meta.id === 'shape' ? id : shape.meta.id
  cache.set(key, shape)
  if (cache.size > 24) cache.delete(cache.keys().next().value)
  return shape
}
