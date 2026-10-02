// Pulviscolo studio: boots the field, the sheet around it and the panel.
// State model (per-shape looks vs global keys) lives in src/editor/store.js.

import { ParticleField } from './runtime/ParticleField.js'
import { DEFAULT_CONFIG, mergeConfig, cloneConfig } from './state.js'
import { SHAPES, getShapeDef, buildShape, paramDefaults } from './shapes/index.js'
import { encodeShape, decodeShape } from './runtime/codec.js'
import * as store from './editor/store.js'
import { createPanel } from './editor/panel.js'
import { createChrome } from './editor/chrome.js'
import { createReference } from './editor/reference.js'
import { createCustom, CUSTOM_LOOK } from './editor/custom.js'
import { createActions, LOCAL_EXPORT_DEFAULTS } from './editor/actions.js'
import { bindKeys } from './editor/keys.js'
import { toast } from './editor/toast.js'

const pad = (n, w = 2) => String(n).padStart(w, '0')
const titleCase = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1)
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// ── registry → specimen index ───────────────────────────────────────────
const real = SHAPES.filter((d) => !String(d.id).startsWith('zz-'))
const specimens = (real.length ? real : SHAPES).map((def, i) => ({
  id: def.id,
  label: def.label || titleCase(def.id),
  number: pad(i + 1),
  def,
}))
const entries = [...specimens, { id: 'custom', label: 'Custom', number: pad(specimens.length + 1), def: null }]
const isKnown = (id) => entries.some((e) => e.id === id)
const entryOf = (id) => entries.find((e) => e.id === id) || entries[0]
const defaultsOf = (id) => store.lookDefaults(id === 'custom' ? CUSTOM_LOOK : getShapeDef(id)?.defaults || {})

// ── state ───────────────────────────────────────────────────────────────
const saved = store.loadSaved()
const state = {
  config: mergeConfig(DEFAULT_CONFIG, isPlain(saved?.config) ? saved.config : {}),
  looks: isPlain(saved?.looks) ? saved.looks : {},
  exportOptions: mergeConfig(LOCAL_EXPORT_DEFAULTS, isPlain(saved?.exportOptions) ? saved.exportOptions : {}),
  custom: isPlain(saved?.custom) ? saved.custom : null,
  ui: {
    sheet: false,
    linkColors: true,
    folders: {},
    capture: { pngScale: 2, pngTransparent: false, seconds: 6 },
    ...(isPlain(saved?.ui) ? saved.ui : {}),
  },
}
if (!isPlain(state.config.shapeParams)) state.config.shapeParams = {}

let customShape = state.config.shape === 'custom' || state.custom ? store.loadCustomShape(decodeShape) : null
if (!isKnown(state.config.shape) || (state.config.shape === 'custom' && !customShape)) state.config.shape = specimens[0]?.id
{
  const d = defaultsOf(state.config.shape)
  state.config = store.composeConfig(state.config, d, d, state.looks[state.config.shape])
}

// ── shapes ──────────────────────────────────────────────────────────────
const groupInfo = new WeakMap()
function groupCount(shape) {
  if (groupInfo.has(shape)) return groupInfo.get(shape)
  let max = 0
  const g = shape.group || []
  for (let i = 0; i < g.length; i++) if (g[i] > max) max = g[i]
  groupInfo.set(shape, max + 1)
  return max + 1
}

function describe(id, shape) {
  const e = entryOf(id)
  const def = e.def
  return {
    id,
    label: id === 'custom' ? shape?.meta?.label || 'Custom' : e.label,
    number: e.number,
    def,
    shape,
    life: shape?.meta?.life || 'none',
    groupCount: shape ? groupCount(shape) : 1,
    groupLabels: shape?.meta?.groups || [],
    paramDefs: def?.params || {},
    paramValues: def ? { ...paramDefaults(def), ...(state.config.shapeParams[id] || {}) } : {},
  }
}

let lastBuildMs = 0
function safeBuild(id) {
  if (id === 'custom') return customShape
  try {
    const t0 = performance.now()
    const s = buildShape(id, state.config.shapeParams[id] || {}, state.config.seed)
    lastBuildMs = performance.now() - t0
    return s
  } catch (e) {
    console.error(e)
    toast(`${entryOf(id).label} could not be built: ${e.message}`, { error: true })
    return null
  }
}

let initialShape = safeBuild(state.config.shape)
if (!initialShape) {
  for (const s of specimens) {
    if (s.id === state.config.shape) continue
    initialShape = safeBuild(s.id)
    if (initialShape) {
      const d = defaultsOf(s.id)
      state.config = store.composeConfig(state.config, defaultsOf(state.config.shape), d, state.looks[s.id])
      state.config.shape = s.id
      break
    }
  }
}

// ── field ───────────────────────────────────────────────────────────────
const stage = document.getElementById('stage')
const field = new ParticleField(stage, { config: state.config, shape: initialShape, interactive: true })

const app = {
  state,
  field,
  specimens,
  entries,
  current: describe(state.config.shape, initialShape),
  get customShape() {
    return customShape
  },
  toast,
  save: () => store.saveSoon(state),
}

// ── config edits ────────────────────────────────────────────────────────
function record(path, value) {
  store.setIn(state.config, path, value)
  const d = defaultsOf(state.config.shape)
  if (store.isLookPath(d, path)) store.recordLook(state.looks, state.config.shape, d, path, value)
}

app.tweak = (path, value, { last = true } = {}) => {
  record(path, value)
  const patch = store.patchFor(path, value)
  if (path[0] === 'particles' && path[1] === 'color' && state.ui.linkColors !== false) {
    for (const k of ['colorB', 'colorC']) {
      record(['particles', k], value)
      patch.particles[k] = value
    }
  }
  field.setConfig(patch)
  const key = path.join('.')
  if (key === 'count') app.chrome.updateCount()
  if (key === 'life.enabled') app.chrome.updatePlate()
  if (key === 'scene.background') document.documentElement.style.setProperty('--paper-stage', value)
  if (/^(motion\.mode|camera\.autoFit)$/.test(key)) app.panel.updateVisibility()
  if (last && key === 'count') app.panel.sync()
  app.save()
}

app.tweakColorLink = (color) => {
  for (const k of ['colorB', 'colorC']) record(['particles', k], color)
  field.setConfig({ particles: { colorB: color, colorC: color } })
  app.panel.sync()
  app.save()
}

app.setConfig = (patch) => {
  for (const p of store.leafPaths(patch)) record(p, store.getIn(patch, p))
  field.setConfig(patch)
  app.panel.sync()
  app.chrome.updateCount()
  app.chrome.updatePlate()
  app.save()
}

app.setCount = (n) => {
  app.tweak(['count'], n)
}

// Short morph for param / seed rebuilds: patch morph timing, restore after.
let morphRestore = 0
let morphOff = null
function morphTo(shape, short) {
  if (!short) return field.setShape(shape, { morph: true })
  const m = state.config.morph
  field.setConfig({ morph: { duration: Math.min(m.duration, 0.85), stagger: Math.min(m.stagger, 0.3) } })
  field.setShape(shape, { morph: true })
  clearTimeout(morphRestore)
  morphOff?.()
  const restore = () => {
    clearTimeout(morphRestore)
    morphOff?.()
    morphOff = null
    field.setConfig({ morph: state.config.morph })
  }
  morphOff = field.on?.('morphend', restore) || null
  morphRestore = setTimeout(restore, 1300)
}

let rebuildTimer = 0
function rebuildCurrent({ last = true } = {}) {
  clearTimeout(rebuildTimer)
  const id = state.config.shape
  if (id === 'custom') {
    if (last) app.custom.refresh()
    return
  }
  // Live rebuilds while dragging only when the shape builds fast.
  if (!last && lastBuildMs > 45) return
  rebuildTimer = setTimeout(() => {
    const shape = safeBuild(id)
    if (!shape || shape === app.current.shape) return
    app.current = describe(id, shape)
    morphTo(shape, true)
    app.chrome.updatePlate()
    app.panel.updateVisibility()
  }, last ? 0 : 50)
}

app.setShapeParam = (key, value, { last = true } = {}) => {
  const id = state.config.shape
  ;(state.config.shapeParams[id] ||= {})[key] = value
  app.current.paramValues[key] = value
  rebuildCurrent({ last })
  app.save()
}

app.setSeed = (seed, { last = true } = {}) => {
  state.config.seed = Math.max(1, Math.round(seed))
  field.setConfig({ seed: state.config.seed })
  rebuildCurrent({ last })
  app.chrome.updatePlate()
  app.save()
}

app.reroll = () => {
  const seed = 1 + Math.floor(Math.random() * 9999)
  app.setSeed(seed)
  app.panel.sync()
  toast(`Seed ${pad(seed, 4)}`)
}

app.resetLook = () => {
  const id = state.config.shape
  delete state.looks[id]
  const d = defaultsOf(id)
  state.config = store.composeConfig(state.config, d, d, null)
  if (id !== 'custom') {
    delete state.config.shapeParams[id]
    app.current = describe(id, app.current.shape)
    const shape = safeBuild(id)
    if (shape && shape !== app.current.shape) {
      app.current = describe(id, shape)
      morphTo(shape, true)
    }
  } else {
    app.custom.refresh({ resetParams: true })
  }
  field.setConfig(state.config)
  app.panel.onShape()
  app.chrome.updateCount()
  app.chrome.updatePlate()
  app.save()
  toast(`${app.current.label}: look restored`)
}

app.useCurrentView = () => {
  const cs = field.getCameraState?.()
  if (!cs) return
  const patch = { camera: { azimuth: Math.round(cs.azimuth), elevation: Math.round(cs.elevation) } }
  if (!state.config.camera.autoFit && cs.distance) patch.camera.distance = +cs.distance.toFixed(2)
  app.setConfig(patch)
  toast(`View kept · azimuth ${patch.camera.azimuth}° · elevation ${patch.camera.elevation}°`)
}

app.resetView = () => field.resetView?.()

// ── shape switching ─────────────────────────────────────────────────────
function refreshAll() {
  app.chrome.setActive()
  app.chrome.updatePlate()
  app.chrome.updateCount()
  app.panel.onShape()
  app.reference.apply()
  document.documentElement.style.setProperty('--paper-stage', state.config.scene.background)
}

app.setShape = (id, { morph = true } = {}) => {
  if (!isKnown(id)) return false
  if (id === state.config.shape) return true
  const shape = safeBuild(id)
  if (!shape) return false
  const prevId = state.config.shape
  const prevD = defaultsOf(prevId)
  const look = store.diffLook(state.config, prevD)
  if (Object.keys(look).length) state.looks[prevId] = look
  else delete state.looks[prevId]
  state.config = store.composeConfig(state.config, prevD, defaultsOf(id), state.looks[id])
  state.config.shape = id
  app.current = describe(id, shape)
  field.setShape(shape, { morph })
  field.setConfig(state.config)
  refreshAll()
  app.save()
  return true
}

app.selectEntry = (id) => {
  if (id === 'custom') {
    if (customShape && state.config.shape !== 'custom') {
      app.setShape('custom')
      app.custom.open()
    } else app.custom.toggle()
    return
  }
  app.custom.close()
  app.setShape(id)
}

app.setCustomShape = (shape) => {
  customShape = shape
  if (!store.saveCustomShape(encodeShape(shape, shape.count))) console.info('Pulviscolo: custom shape too large to keep in localStorage')
  if (state.config.shape === 'custom') {
    app.current = describe('custom', shape)
    morphTo(shape, false)
    refreshAll()
  } else {
    app.setShape('custom')
  }
  app.save()
}

app.sheetOpen = () => app.custom?.isOpen()

// Full configs per extra shape so each keeps its own look in a sequence export.
app.sequenceExtras = () => {
  const seq = state.exportOptions.sequence
  if (!seq?.enabled) return []
  const ids = (seq.shapes?.length ? seq.shapes : specimens.map((s) => s.id)).filter((id) => id !== state.config.shape && specimens.some((s) => s.id === id))
  const out = []
  for (const id of ids) {
    try {
      const shape = buildShape(id, state.config.shapeParams[id] || {}, state.config.seed)
      const config = store.composeConfig(state.config, defaultsOf(state.config.shape), defaultsOf(id), state.looks[id])
      config.shape = id
      out.push({ shape, config })
    } catch (e) {
      console.warn(`Pulviscolo: ${id} left out of the sequence`, e)
    }
  }
  return out
}

// Preset / imported HTML → studio state. Bound objects are mutated in place.
app.applyLoadedState = (res) => {
  if (!res || !isPlain(res.config)) throw new Error('Nothing to apply')
  if (res.custom && res.custom.shape) {
    customShape = res.custom.shape
    state.custom = { kind: res.custom.kind, name: res.custom.name || res.custom.shape.meta?.label, text: res.custom.text || null, params: res.custom.params || {} }
    store.saveCustomShape(encodeShape(customShape, customShape.count))
  }
  const cfg = mergeConfig(DEFAULT_CONFIG, res.config)
  let id = cfg.shape
  if (!isKnown(id) || (id === 'custom' && !customShape)) id = customShape ? 'custom' : specimens[0].id
  const d = defaultsOf(id)
  for (const k of Object.keys(state.looks)) delete state.looks[k]
  Object.assign(state.looks, isPlain(res.looks) ? res.looks : {})
  const look = mergeConfig(store.diffLook(cfg, d), state.looks[id] || {})
  if (Object.keys(look).length) state.looks[id] = look
  if (isPlain(res.exportOptions)) {
    const { sequence, ...rest } = res.exportOptions
    Object.assign(state.exportOptions, rest)
    if (isPlain(sequence)) Object.assign(state.exportOptions.sequence, sequence)
  }
  cfg.shape = id
  state.config = store.composeConfig(cfg, d, d, state.looks[id])
  if (!isPlain(state.config.shapeParams)) state.config.shapeParams = {}
  const shape = safeBuild(id)
  if (!shape) throw new Error(`${entryOf(id).label} could not be built`)
  app.current = describe(id, shape)
  field.setShape(shape, { morph: true })
  field.setConfig(state.config)
  refreshAll()
  app.save()
}

// ── UI modules ──────────────────────────────────────────────────────────
app.reference = createReference(app)
app.chrome = createChrome(app)
app.custom = createCustom(app)
app.actions = createActions(app)
app.panel = createPanel(app)
app.chrome.renderIndex()
refreshAll()
bindKeys(app)

field.on('frame', () => app.chrome.tick(field.stats))
window.addEventListener('pagehide', () => store.saveNow(state))
document.addEventListener('visibilitychange', () => document.hidden && store.saveNow(state))

// ── ready ───────────────────────────────────────────────────────────────
let ready = false
const markReady = () => {
  if (ready) return
  ready = true
  document.body.dataset.ready = 'true'
  document.body.classList.add('pv-ready')
}
field.on('ready', markReady)
const offFrame = field.on('frame', () => {
  offFrame?.()
  requestAnimationFrame(markReady)
})
setTimeout(markReady, 6000)

window.__pv = {
  field,
  state,
  app,
  panel: app.panel.pane,
  setShape: (id, opts) => app.setShape(id, opts),
  setConfig: (patch) => app.setConfig(patch),
  select: (id) => app.selectEntry(id),
  reset: () => {
    store.clearSaved()
    location.reload()
  },
  get current() {
    return { id: app.current.id, label: app.current.label, life: app.current.life, groups: app.current.groupCount }
  },
  cloneConfig,
}
