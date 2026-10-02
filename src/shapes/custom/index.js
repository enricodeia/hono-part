// Custom sources: the user's own image, SVG, text or 3D model → ShapeData with
// the same contract (and finish) as the built-in specimens. See SPEC.md
// "Custom sources".
//
//   const shape = await createCustomShape({ kind: 'image', file }, { edges: 0.4 }, { seed: 1 })
//
// source: { kind: 'image' | 'svg' | 'text' | 'model',
//           file?: File | Blob,     // image / svg / model
//           text?: string,          // text content, or SVG markup for kind 'svg'
//           data?: ArrayBuffer | string, url?: string, name?: string }

import { hashSeed } from '../lib/rng.js'
import { finalizeShape, MAX_COUNT } from '../lib/sampling.js'
import { rasterizeImage, rasterizeSvg, rasterizeText, TEXT_FONTS } from './raster.js'
import { sampleImage } from './inkField.js'

export const CUSTOM_KINDS = ['image', 'svg', 'text', 'model']

const P = {
  ink: { value: 'auto', options: ['auto', 'alpha', 'luma'], label: 'Ink from' },
  invert: { value: false, label: 'Invert' },
  threshold: { value: 0.08, min: 0, max: 0.95, step: 0.01, label: 'Threshold' },
  contrast: { value: 1.4, min: 0.4, max: 6, step: 0.05, label: 'Contrast' },
  edges: { value: 0.35, min: 0, max: 1, step: 0.01, label: 'Edges' },
  depth: { value: 0.6, min: 0, max: 1.5, step: 0.01, label: 'Depth' },
  extrude: { value: 0, min: 0, max: 0.5, step: 0.005, label: 'Extrude' },
  relief: { value: 0, min: -1, max: 1, step: 0.01, label: 'Relief' },
  volume: { value: 0, min: 0, max: 1, step: 0.01, label: 'Volume' },
}

export const CUSTOM_PARAMS = {
  image: { ...P },
  svg: {
    ...P,
    edges: { ...P.edges, value: 0.45 },
    strokeOnly: { value: false, label: 'Outline only' },
    strokeWidth: { value: 3, min: 0.5, max: 24, step: 0.5, label: 'Outline px' },
  },
  text: {
    font: { value: 'Inter Tight', options: Object.keys(TEXT_FONTS), label: 'Font' },
    weight: { value: 600, min: 100, max: 900, step: 100, label: 'Weight' },
    tracking: { value: -0.02, min: -0.1, max: 0.4, step: 0.005, label: 'Tracking' },
    leading: { value: 1.02, min: 0.7, max: 1.8, step: 0.01, label: 'Leading' },
    align: { value: 'center', options: ['left', 'center', 'right'], label: 'Align' },
    edges: { ...P.edges, value: 0.4 },
    strokeOnly: { value: false, label: 'Outline only' },
    strokeWidth: { value: 3, min: 0.5, max: 24, step: 0.5, label: 'Outline px' },
    depth: { ...P.depth, value: 0.8 },
    extrude: P.extrude,
    volume: P.volume,
  },
  model: {
    upAxis: { value: '+Y', options: ['+Y', '-Y', '+Z', '-Z', '+X', '-X'], label: 'Up axis' },
    yaw: { value: 0, min: -180, max: 180, step: 1, label: 'Yaw' },
    pitch: { value: 0, min: -90, max: 90, step: 1, label: 'Pitch' },
    roll: { value: 0, min: -180, max: 180, step: 1, label: 'Roll' },
    volume: { value: 0, min: 0, max: 1, step: 0.01, label: 'Volume' },
  },
}

export function customParamDefaults(kind) {
  const out = {}
  for (const [k, p] of Object.entries(CUSTOM_PARAMS[kind] || {})) out[k] = p.value
  return out
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp']
const MODEL_EXT = ['glb', 'gltf', 'obj', 'stl']

export function kindFromFile(file) {
  if (!file) return null
  const name = (file.name || '').toLowerCase()
  const ext = (/\.([a-z0-9]+)$/.exec(name) || [])[1] || ''
  const type = (file.type || '').toLowerCase()
  if (type === 'image/svg+xml' || ext === 'svg') return 'svg'
  if (MODEL_EXT.includes(ext) || type === 'model/gltf-binary' || type === 'model/gltf+json' || type === 'model/stl' || type === 'model/obj') return 'model'
  if (IMAGE_EXT.includes(ext) || /^image\/(png|jpe?g|webp|gif|avif|bmp)$/.test(type)) return 'image'
  return null
}

async function blobOf(source) {
  if (source.file) return source.file
  if (source.data instanceof Blob) return source.data
  if (source.data) return new Blob([source.data])
  if (source.url) {
    const res = await fetch(source.url)
    if (!res.ok) throw new Error(`Could not fetch ${source.url} (${res.status})`)
    return res.blob()
  }
  throw new Error(`No file given for the ${source.kind} source`)
}

function baseName(name) {
  return String(name || '').replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '') || null
}

function labelFor(source) {
  if (source.name) return String(source.name)
  if (source.file && source.file.name) return source.file.name
  if (source.kind === 'text') {
    const t = String(source.text || '').replace(/\s+/g, ' ').trim()
    return t.length > 40 ? t.slice(0, 39) + '…' : t
  }
  if (source.url) return source.url.replace(/^.*\//, '')
  return 'Custom'
}

// Wide sources fill the viewport width, the rest its height (SPEC §2 frame).
function frameFor(aspect) {
  return aspect > 1.45 ? { w: 0.85 } : { h: 0.62 }
}

/**
 * @returns {Promise<ShapeData>} meta.id 'custom', meta.life 'breath'
 */
export async function createCustomShape(source, params = {}, { seed = 1, maxCount = MAX_COUNT } = {}) {
  const t0 = performance.now()
  if (!source || typeof source !== 'object') throw new Error('createCustomShape: source must be an object { kind, file | text }')
  let kind = source.kind
  if (!kind && source.file) kind = kindFromFile(source.file)
  if (!CUSTOM_KINDS.includes(kind)) {
    const what = source.file && source.file.name ? `"${source.file.name}"` : `kind "${kind}"`
    throw new Error(`Unsupported source ${what}: use an image (PNG, JPG, WebP), an SVG, text, or a GLB / glTF / OBJ / STL model`)
  }
  const p = { ...customParamDefaults(kind), ...(params || {}) }
  const label = labelFor({ ...source, kind })
  // the seed is mixed with the kind so image #1 and text #1 differ
  const s = hashSeed('custom', kind, seed)

  let raw
  let aspect
  let info
  if (kind === 'model') {
    const { loadModel, sampleModel } = await import('./model.js')
    const blob = source.file || source.data || (source.url ? await blobOf(source) : null)
    if (!blob) throw new Error('No file given for the model source')
    const root = await loadModel(blob, source.file?.name || source.name || source.url || 'model.glb')
    raw = sampleModel(root, p, { N: maxCount, seed: s })
    aspect = raw.info.aspect
    info = raw.info
  } else {
    let img
    if (kind === 'image') img = await rasterizeImage(await blobOf(source))
    else if (kind === 'svg') {
      const markup = typeof source.text === 'string' && !source.file ? source.text : await (await blobOf(source)).text()
      img = await rasterizeSvg(markup)
    } else {
      img = await rasterizeText(source.text, p)
    }
    raw = sampleImage(img, { ...p, N: maxCount, seed: s })
    aspect = raw.info.aspect
    info = raw.info
  }

  const shape = finalizeShape(
    { positions: raw.positions, normal: raw.normal, size: raw.size, aux: raw.aux },
    {
      seed: s,
      maxCount,
      meta: {
        id: 'custom',
        label,
        name: baseName(source.file?.name || source.name) || label,
        kind,
        life: 'breath',
        axis: [0, 1, 0],
        frame: frameFor(aspect),
        groups: ['Shape'],
        aux: kind === 'model' ? 'height 0..1 (bottom to top)' : 'ink 0..1 (1 = solid ink, wall dots 1)',
        params: p,
        source: info,
      },
    },
  )
  shape.meta.buildMs = Math.round(performance.now() - t0)
  return shape
}
