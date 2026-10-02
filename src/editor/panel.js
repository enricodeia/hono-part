// Control panel: Tweakpane 4 built from CONFIG_SCHEMA. Bindings point at a
// mirror object (so config can be replaced wholesale on a shape switch) and
// report every change through app.tweak(path, value, { last }).

import { Pane } from 'tweakpane'
import * as EssentialsPlugin from '@tweakpane/plugin-essentials'
import { CONFIG_SCHEMA, COUNT_PRESETS, cloneConfig } from '../state.js'
import { getIn } from './store.js'
import { icon } from './icons.js'

const OPTION_LABELS = {
  shockwave: 'Wave',
  difference: 'Diff',
  fullscreen: 'Full',
  inline: 'Inline',
  cdn: 'CDN',
}
const titleCase = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1)
const optionLabel = (v) => OPTION_LABELS[v] || titleCase(v)

const LIFE_LABELS = {
  none: 'None',
  wave: 'Wave along strokes',
  heartbeat: 'Heartbeat',
  helix: 'Helix spin',
  neural: 'Neural sparks',
  breath: 'Breath',
}

let gid = 0

export function createPanel(app) {
  const { state } = app
  const container = document.getElementById('pv-pane')
  const pane = new Pane({ container })
  pane.registerPlugin(EssentialsPlugin)

  const mirror = cloneConfig(state.config)
  const records = [] // { obj, key, path } for config bindings
  const named = {} // 'section.key' → binding api
  let syncing = false

  const folders = {}
  const foldState = (state.ui.folders ||= {})

  function folder(key, title, expandedByDefault = false) {
    const f = pane.addFolder({ title, expanded: foldState[key] ?? expandedByDefault })
    f.on('fold', (ev) => {
      foldState[key] = ev.expanded
      app.save()
    })
    f.element.dataset.folder = key
    folders[key] = f
    return f
  }

  function caption(parent, text) {
    const sep = parent.addBlade({ view: 'separator' })
    sep.element.classList.add('pv-capsep')
    const s = document.createElement('span')
    s.textContent = text
    sep.element.appendChild(s)
    return { blade: sep, set: (t) => (s.textContent = t) }
  }

  function radio(parent, obj, key, options, label, extra = {}) {
    const name = `pv-r${gid++}`
    return parent.addBinding(obj, key, {
      view: 'radiogrid',
      groupName: name,
      size: [options.length, 1],
      cells: (x) => ({ title: optionLabel(options[x]), value: options[x] }),
      label,
      ...extra,
    })
  }

  // One binding from the schema; path = [section, key] or [key].
  function bind(parent, path, extra = {}) {
    const section = path.length > 1 ? path[0] : null
    const key = path[path.length - 1]
    const obj = section ? mirror[section] : mirror
    const sch = (section ? CONFIG_SCHEMA[section]?.[key] : null) || {}
    const label = extra.label || sch.label || titleCase(key)
    let b
    if (sch.options) {
      b = sch.options.length <= 4 && !extra.list
        ? radio(parent, obj, key, sch.options, label)
        : parent.addBinding(obj, key, { label, options: Object.fromEntries(sch.options.map((o) => [optionLabel(o), o])) })
    } else if (sch.color) {
      b = parent.addBinding(obj, key, { label, view: 'color' })
    } else if (typeof obj[key] === 'boolean') {
      b = parent.addBinding(obj, key, { label })
    } else {
      const params = { label }
      for (const k of ['min', 'max', 'step']) if (sch[k] !== undefined) params[k] = sch[k]
      Object.assign(params, extra.params || {})
      b = parent.addBinding(obj, key, params)
    }
    b.on('change', (ev) => {
      if (syncing) return
      app.tweak(path, ev.value, { last: ev.last !== false })
    })
    records.push({ obj, key, path })
    named[path.join('.')] = b
    return b
  }

  const bindAll = (parent, section, keys) => keys.map((k) => bind(parent, [section, k]))

  function iconButton(parent, title, ic, onClick, cls) {
    const b = parent.addButton({ title })
    const t = b.element.querySelector('.tp-btnv_t')
    if (t && ic) t.innerHTML = `${icon(ic)}<span>${title}</span>`
    if (cls) b.element.classList.add(cls)
    b.on('click', onClick)
    return b
  }

  function buttonRow(parent, cells) {
    const grid = parent.addBlade({
      view: 'buttongrid',
      size: [cells.length, 1],
      cells: (x) => ({ title: cells[x].title }),
    })
    grid.element.classList.add('pv-btnrow')
    const titles = grid.element.querySelectorAll('.tp-btnv_t')
    cells.forEach((c, i) => {
      if (titles[i] && c.icon) titles[i].innerHTML = `${icon(c.icon)}<span>${c.title}</span>`
    })
    grid.on('click', (ev) => cells[ev.index[0]]?.onClick())
    return grid
  }

  // ── 01 Specimen ────────────────────────────────────────────────────────
  const fSpec = folder('specimen', 'Specimen', true)
  const specParams = { values: {}, bindings: [] }
  const specEmpty = caption(fSpec, 'Parameters')
  caption(fSpec, 'Seed')
  const seedObj = { seed: state.config.seed }
  const seedB = fSpec.addBinding(seedObj, 'seed', { label: 'Seed', step: 1, min: 1, format: (v) => String(Math.round(v)).padStart(4, '0') })
  seedB.on('change', (ev) => {
    if (syncing) return
    app.setSeed(Math.round(ev.value), { last: ev.last !== false })
  })
  buttonRow(fSpec, [
    { title: 'Reroll', icon: 'shuffle', onClick: () => app.reroll() },
    { title: 'Reset look', icon: 'reset', onClick: () => app.resetLook() },
  ])

  function rebuildSpecimenParams() {
    for (const b of specParams.bindings) b.dispose()
    specParams.bindings = []
    const cur = app.current
    const defs = cur.paramDefs || {}
    const keys = Object.keys(defs)
    specEmpty.set(keys.length ? `${cur.label} · parameters` : `${cur.label} · no parameters`)
    const values = { ...cur.paramValues }
    specParams.values = values
    keys.forEach((key, i) => {
      const p = defs[key]
      const label = p.label || titleCase(key)
      const index = 1 + i
      let b
      if (Array.isArray(p.options)) {
        b = p.options.length <= 3 && p.options.every((o) => String(o).length <= 7)
          ? fSpec.addBinding(values, key, {
            view: 'radiogrid',
            groupName: `pv-r${gid++}`,
            size: [p.options.length, 1],
            cells: (x) => ({ title: optionLabel(p.options[x]), value: p.options[x] }),
            label,
            index,
          })
          : fSpec.addBinding(values, key, { label, index, options: Object.fromEntries(p.options.map((o) => [optionLabel(o), o])) })
      } else if (p.color) {
        b = fSpec.addBinding(values, key, { label, index, view: 'color' })
      } else if (typeof p.value === 'boolean') {
        b = fSpec.addBinding(values, key, { label, index })
      } else if (typeof p.value === 'number') {
        const params = { label, index }
        for (const k of ['min', 'max', 'step']) if (p[k] !== undefined) params[k] = p[k]
        b = fSpec.addBinding(values, key, params)
      } else {
        b = fSpec.addBinding(values, key, { label, index })
      }
      b.on('change', (ev) => {
        if (syncing) return
        app.setShapeParam(key, ev.value, { last: ev.last !== false })
      })
      specParams.bindings.push(b)
    })
  }

  // ── 02 Particles ───────────────────────────────────────────────────────
  const fPart = folder('particles', 'Particles', true)
  bind(fPart, ['count'], { label: 'Count', params: { min: COUNT_PRESETS[COUNT_PRESETS.length - 1], max: COUNT_PRESETS[0], step: 50 } })
  bindAll(fPart, 'particles', ['size', 'sizeVariance', 'sizeByCount', 'softness', 'opacity', 'shading'])
  caption(fPart, 'Colour')
  const linkObj = { link: state.ui.linkColors !== false }
  const linkB = fPart.addBinding(linkObj, 'link', { label: 'Link groups' })
  linkB.on('change', (ev) => {
    state.ui.linkColors = ev.value
    app.save()
    if (ev.value) app.tweakColorLink(state.config.particles.color)
    updateVisibility()
  })
  bindAll(fPart, 'particles', ['color', 'colorB', 'opacityB', 'colorC', 'opacityC'])

  // ── 03 Depth ───────────────────────────────────────────────────────────
  const fDepth = folder('depth', 'Depth')
  bindAll(fDepth, 'depth', ['fade', 'dof', 'focus'])

  // ── 04 Motion ──────────────────────────────────────────────────────────
  const fMotion = folder('motion', 'Motion')
  bindAll(fMotion, 'motion', ['mode', 'speed', 'swayAngle', 'float'])
  caption(fMotion, 'Pose')
  bindAll(fMotion, 'motion', ['yaw', 'pitch', 'roll'])
  caption(fMotion, 'Wander')
  bind(fMotion, ['motion', 'noise'], { label: 'Amount' })
  bind(fMotion, ['motion', 'noiseScale'], { label: 'Scale' })
  bind(fMotion, ['motion', 'noiseSpeed'], { label: 'Speed' })

  // ── 05 Life ────────────────────────────────────────────────────────────
  const fLife = folder('life', 'Life')
  const lifeCap = caption(fLife, 'Behaviour')
  bindAll(fLife, 'life', ['enabled', 'amount', 'rate'])

  // ── 06 Hover ───────────────────────────────────────────────────────────
  const fHover = folder('hover', 'Hover')
  bindAll(fHover, 'hover', ['enabled', 'mode', 'radius', 'strength', 'stiffness', 'damping', 'click'])

  // ── 07 Dissolve ────────────────────────────────────────────────────────
  const fDis = folder('dissolve', 'Dissolve')
  bindAll(fDis, 'dissolve', ['amount', 'mode', 'angle', 'softness', 'spread', 'turbulence', 'fade'])

  // ── 08 Morph ───────────────────────────────────────────────────────────
  const fMorph = folder('morph', 'Morph')
  bindAll(fMorph, 'morph', ['style', 'duration', 'stagger', 'turbulence', 'intro'])

  // ── 09 Atmosphere ──────────────────────────────────────────────────────
  const fAtmo = folder('atmosphere', 'Atmosphere')
  caption(fAtmo, 'Dust')
  bindAll(fAtmo, 'dust', ['count', 'size', 'opacity', 'radius', 'drift'])
  caption(fAtmo, 'Scene')
  bindAll(fAtmo, 'scene', ['background', 'glow', 'glowColor'])

  // ── 10 Camera ──────────────────────────────────────────────────────────
  const fCam = folder('camera', 'Camera')
  bindAll(fCam, 'camera', ['fov', 'autoFit', 'frame', 'distance', 'azimuth', 'elevation', 'offsetX', 'offsetY', 'orbit', 'zoom'])
  buttonRow(fCam, [
    { title: 'Use current view', icon: 'target', onClick: () => app.useCurrentView() },
    { title: 'Reset view', icon: 'reset', onClick: () => app.resetView() },
  ])

  // ── 11 Reference ───────────────────────────────────────────────────────
  const fRef = folder('reference', 'Reference')
  const ref = app.reference.state
  const refB = {}
  refB.show = fRef.addBinding(ref, 'show', { label: 'Overlay' })
  refB.image = fRef.addBinding(ref, 'image', { label: 'Image', options: app.reference.options })
  refB.opacity = fRef.addBinding(ref, 'opacity', { label: 'Opacity', min: 0, max: 1, step: 0.01 })
  refB.blend = radio(fRef, ref, 'blend', ['normal', 'multiply', 'difference'], 'Blend')
  refB.invert = fRef.addBinding(ref, 'invert', { label: 'Invert' })
  refB.fit = radio(fRef, ref, 'fit', ['contain', 'cover'], 'Fit')
  for (const [k, b] of Object.entries(refB)) {
    b.on('change', (ev) => {
      if (syncing) return
      app.reference.set({ [k]: ev.value })
    })
  }

  // ── 12 Export ──────────────────────────────────────────────────────────
  const fExp = folder('export', 'Export')
  const ex = state.exportOptions
  const capt = (state.ui.capture ||= { pngScale: 2, pngTransparent: false, seconds: 6 })
  const exB = {}
  exB.title = fExp.addBinding(ex, 'title', { label: 'Title' })
  exB.three = radio(fExp, ex, 'three', ['inline', 'cdn'], 'three.js')
  exB.layout = radio(fExp, ex, 'layout', ['fullscreen', 'embed'], 'Layout')
  exB.height = fExp.addBinding(ex, 'height', { label: 'Height' })
  exB.transparent = fExp.addBinding(ex, 'transparent', { label: 'Transparent' })
  exB.interactive = fExp.addBinding(ex, 'interactive', { label: 'Interactive' })
  exB.allCounts = fExp.addBinding(ex, 'allCounts', { label: 'All counts' })
  for (const b of Object.values(exB)) b.on('change', () => onExportChange())

  caption(fExp, 'Sequence')
  const seq = ex.sequence
  const seqB = {}
  seqB.enabled = fExp.addBinding(seq, 'enabled', { label: 'Cycle shapes' })
  const seqSel = {}
  const seqShapeB = []
  const seqIds = new Set(seq.shapes.length ? seq.shapes : app.specimens.map((s) => s.id))
  for (const s of app.specimens) {
    seqSel[s.id] = seqIds.has(s.id)
    const b = fExp.addBinding(seqSel, s.id, { label: `${s.number}  ${s.label}` })
    b.element.classList.add('pv-seqrow')
    b.on('change', () => {
      seq.shapes = app.specimens.filter((x) => seqSel[x.id]).map((x) => x.id)
      onExportChange()
    })
    seqShapeB.push(b)
  }
  if (!seq.shapes.length) seq.shapes = app.specimens.map((s) => s.id)
  seqB.interval = fExp.addBinding(seq, 'interval', { label: 'Interval s', min: 2, max: 30, step: 0.5 })
  seqB.trigger = radio(fExp, seq, 'trigger', ['auto', 'click', 'both'], 'Trigger')
  for (const b of Object.values(seqB)) b.on('change', () => onExportChange())

  caption(fExp, 'Files')
  iconButton(fExp, 'Download HTML', 'download', () => app.actions.exportHTML(), 'pv-primary')
  buttonRow(fExp, [
    { title: 'JS module', icon: 'code', onClick: () => app.actions.exportModule() },
    { title: 'Embed snippet', icon: 'copy', onClick: () => app.actions.copySnippet() },
  ])

  caption(fExp, 'Still')
  const capB = {}
  capB.pngScale = radio(fExp, capt, 'pngScale', [1, 2, 4], 'Scale', { cells: (x) => ({ title: `${[1, 2, 4][x]}×`, value: [1, 2, 4][x] }) })
  capB.pngTransparent = fExp.addBinding(capt, 'pngTransparent', { label: 'Transparent' })
  iconButton(fExp, 'Save PNG', 'camera', () => app.actions.savePNG())

  caption(fExp, 'Motion')
  capB.seconds = fExp.addBinding(capt, 'seconds', { label: 'Seconds', min: 2, max: 30, step: 1 })
  iconButton(fExp, 'Record WebM', 'video', () => app.actions.recordWebM())
  for (const b of Object.values(capB)) b.on('change', () => app.save())

  caption(fExp, 'Preset')
  buttonRow(fExp, [
    { title: 'Save preset', icon: 'save', onClick: () => app.actions.savePreset() },
    { title: 'Load preset', icon: 'open', onClick: () => app.actions.loadPreset() },
  ])

  function onExportChange() {
    if (syncing) return
    updateVisibility()
    app.save()
  }

  // ── visibility & sync ──────────────────────────────────────────────────
  function updateVisibility() {
    const c = state.config
    const cur = app.current
    const groups = cur.groupCount || 1
    const g = cur.groupLabels || []
    const linked = state.ui.linkColors !== false
    const set = (k, hidden) => named[k] && (named[k].hidden = hidden)
    set('particles.colorB', groups < 2 || linked)
    set('particles.opacityB', groups < 2)
    set('particles.colorC', groups < 3 || linked)
    set('particles.opacityC', groups < 3)
    linkB.hidden = groups < 2
    if (named['particles.color']) named['particles.color'].label = groups > 1 && !linked ? g[0] || 'Color' : 'Color'
    if (named['particles.colorB']) named['particles.colorB'].label = g[1] || 'Color B'
    if (named['particles.colorC']) named['particles.colorC'].label = g[2] || 'Color C'
    if (named['particles.opacity']) named['particles.opacity'].label = groups > 1 ? `${g[0] || 'Group A'} opacity` : 'Opacity'
    if (named['particles.opacityB']) named['particles.opacityB'].label = `${g[1] || 'Group B'} opacity`
    if (named['particles.opacityC']) named['particles.opacityC'].label = `${g[2] || 'Group C'} opacity`
    set('motion.swayAngle', c.motion.mode !== 'sway')
    set('camera.distance', !!c.camera.autoFit)
    set('camera.frame', !c.camera.autoFit)
    exB.height.hidden = ex.layout !== 'embed'
    for (const b of seqShapeB) b.hidden = !seq.enabled
    seqB.interval.hidden = !seq.enabled
    seqB.trigger.hidden = !seq.enabled
  }

  function sync() {
    syncing = true
    try {
      for (const { obj, key, path } of records) {
        const v = getIn(state.config, path)
        if (v !== undefined) obj[key] = typeof v === 'object' ? cloneConfig(v) : v
      }
      seedObj.seed = state.config.seed
      Object.assign(ref, app.reference.state)
      const picked = new Set(seq.shapes.length ? seq.shapes : app.specimens.map((s) => s.id))
      for (const s of app.specimens) seqSel[s.id] = picked.has(s.id)
      pane.refresh()
    } finally {
      syncing = false
    }
    updateVisibility()
  }

  function onShape() {
    syncing = true
    try {
      rebuildSpecimenParams()
    } finally {
      syncing = false
    }
    const life = app.current.life || 'none'
    lifeCap.set(`Behaviour · ${LIFE_LABELS[life] || titleCase(life)}`)
    sync()
  }

  // Values of the current shape's params, re-read after a reset.
  function syncParams() {
    syncing = true
    try {
      Object.assign(specParams.values, app.current.paramValues)
      for (const b of specParams.bindings) b.refresh()
    } finally {
      syncing = false
    }
  }

  return { pane, folders, sync, onShape, syncParams, updateVisibility }
}
