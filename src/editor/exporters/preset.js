// Preset JSON: the whole studio state in one file.
//   { format, version, created, config, looks, exportOptions, custom? }
// custom = { kind, name, text, params, shape: encodeShape(...) } when the
// current custom source has a built shape, so a preset restores it exactly
// without the original upload.
// presetToState also accepts an exported Pulviscolo HTML (it reads the
// embedded payload), a bare config object and older preset versions.

import { DEFAULT_CONFIG } from '../../state.js'
import { encodeShape, decodeShape } from '../../runtime/codec.js'
import { sanitizeConfig, sanitizeLook, sanitizeExportOptions } from './payload.js'

export const PRESET_FORMAT = 'pulviscolo-preset'
export const PRESET_VERSION = 1

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function sanitizeLooks(looks) {
  const out = {}
  if (!isPlain(looks)) return out
  for (const [id, look] of Object.entries(looks)) {
    if (typeof id === 'string' && isPlain(look)) out[id] = sanitizeLook(look)
  }
  return out
}

// Known export options are validated; extra primitive keys the editor keeps
// there (PNG scale, video length, ...) survive the round trip untouched.
function presetExportOptions(opts) {
  const out = sanitizeExportOptions(opts)
  if (isPlain(opts)) {
    for (const [k, v] of Object.entries(opts)) {
      if (k in out) continue
      if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v
    }
  }
  return out
}

function customMeta(custom) {
  const out = {}
  for (const k of ['kind', 'name', 'text']) if (typeof custom[k] === 'string') out[k] = custom[k]
  const src = isPlain(custom.source) ? custom.source : null
  if (src) for (const k of ['kind', 'name', 'text']) if (out[k] === undefined && typeof src[k] === 'string') out[k] = src[k]
  if (isPlain(custom.params)) out.params = JSON.parse(JSON.stringify(custom.params))
  return out
}

export function presetFromState(state = {}) {
  const preset = {
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    created: new Date().toISOString(),
    config: sanitizeConfig(state.config),
    looks: sanitizeLooks(state.looks),
    exportOptions: presetExportOptions(state.exportOptions),
  }
  const custom = state.custom
  if (custom && custom.shape && custom.shape.positions) {
    preset.custom = { ...customMeta(custom), shape: encodeShape(custom.shape, custom.shape.count) }
  }
  return preset
}

export const presetToJSON = (preset) => JSON.stringify(preset)

async function readText(fileOrText) {
  if (typeof fileOrText === 'string') return fileOrText
  if (fileOrText && typeof fileOrText.text === 'function') return fileOrText.text()
  return null
}

function payloadFromHTML(text) {
  const m = text.match(/<script type="application\/json" id="[^"]*-data">([\s\S]*?)<\/script>/)
  if (!m) throw new Error('This HTML file has no Pulviscolo payload')
  return JSON.parse(m[1])
}

function decodeSafe(enc) {
  if (!isPlain(enc) || typeof enc.pos !== 'string' || !Number.isInteger(enc.n)) throw new Error('Preset shape data is malformed')
  const shape = decodeShape(enc)
  if (shape.positions.length !== shape.count * 3) throw new Error('Preset shape data is truncated')
  return shape
}

// Migrations keyed by the version they upgrade FROM.
const MIGRATIONS = {
  0: (p) => ({ ...p, version: 1, config: p.config || p.settings || {} }),
}

export async function presetToState(fileOrText) {
  let raw = fileOrText
  if (!isPlain(raw) || typeof raw.text === 'function') {
    const text = await readText(fileOrText)
    if (text == null) throw new Error('Nothing to load')
    const t = text.trim()
    if (/^<(!doctype|html|!--)/i.test(t)) {
      const payload = payloadFromHTML(t)
      const shapes = (payload.shapes || []).map(decodeSafe)
      const first = shapes[0]
      return {
        version: PRESET_VERSION,
        config: sanitizeConfig(payload.config),
        looks: {},
        exportOptions: sanitizeExportOptions({ sequence: payload.sequence, ...payload.options }),
        custom: first ? { kind: 'html', name: first.meta?.label || 'Imported', shape: first } : null,
        shapes,
        source: 'html',
      }
    }
    try {
      raw = JSON.parse(t)
    } catch {
      throw new Error('Not a valid Pulviscolo preset (JSON could not be parsed)')
    }
  }
  if (!isPlain(raw)) throw new Error('Not a Pulviscolo preset')
  // A bare config (e.g. copied from devtools) is accepted as a preset.
  if (!raw.config && (raw.particles || raw.dissolve || raw.camera)) raw = { version: PRESET_VERSION, config: raw }
  if (raw.format && raw.format !== PRESET_FORMAT) throw new Error(`Unknown preset format "${raw.format}"`)
  let v = Number.isInteger(raw.version) ? raw.version : 0
  if (v > PRESET_VERSION) console.info(`Pulviscolo: preset version ${v} is newer than this studio (${PRESET_VERSION}); unknown keys are ignored`)
  while (v < PRESET_VERSION && MIGRATIONS[v]) raw = MIGRATIONS[v++](raw)
  if (!isPlain(raw.config) && !isPlain(raw.looks)) throw new Error('Preset has no config')

  const config = sanitizeConfig(raw.config)
  // Config version follows DEFAULT_CONFIG; the preset never downgrades it.
  config.version = DEFAULT_CONFIG.version
  let custom = null
  if (isPlain(raw.custom) && raw.custom.shape) {
    custom = { ...customMeta(raw.custom), shape: decodeSafe(raw.custom.shape) }
  }
  return {
    version: PRESET_VERSION,
    config,
    looks: sanitizeLooks(raw.looks),
    exportOptions: presetExportOptions(raw.exportOptions),
    custom,
    source: 'preset',
  }
}
