// "Custom" specimen: drop an image, SVG or 3D model (anywhere on the page or
// in the sheet), or type a word. Uses src/shapes/custom/index.js, loaded lazily
// so a broken or missing module never takes the studio down.

import { Pane } from 'tweakpane'
import * as EssentialsPlugin from '@tweakpane/plugin-essentials'
import { MAX_COUNT } from '../state.js'
import { icon } from './icons.js'

// Look keys owned by the custom slot (everything else stays global).
export const CUSTOM_LOOK = {
  dissolve: { amount: 0 },
  life: { amount: 0.5 },
  camera: { frame: 1 },
}

const loaders = import.meta.glob('../shapes/custom/index.js')
let modPromise = null
function customModule() {
  const load = loaders['../shapes/custom/index.js']
  if (!load) return Promise.reject(new Error('Custom sources are not available in this build yet'))
  return (modPromise ||= load().catch((e) => {
    modPromise = null
    throw e
  }))
}

const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.avif,.svg,.glb,.gltf,.obj,.stl,image/*'
const KIND_LABEL = { image: 'Image', svg: 'SVG', text: 'Text', model: '3D model', html: 'Imported' }
const titleCase = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1)

export function createCustom(app) {
  const { state } = app
  const sheet = document.getElementById('pv-sheet')
  let source = null // { kind, file?, text?, name } of the current custom shape, when rebuildable
  let building = false
  let paramPane = null
  let paramValues = null
  let paneKind = null

  if (state.custom && state.custom.kind === 'text' && state.custom.text) source = { kind: 'text', text: state.custom.text, name: state.custom.text }

  sheet.innerHTML = `
    <div class="pv-sheet-h">
      <span class="pv-k"><span class="pv-sheet-n"></span>Custom specimen</span>
      <button type="button" class="pv-ib pv-sheet-x" aria-label="Close">${icon('close')}</button>
    </div>
    <label class="pv-dz">
      <input type="file" accept="${ACCEPT}" hidden />
      <span class="pv-dz-i">${icon('upload')}</span>
      <span class="pv-dz-t">Drop an image, SVG or 3D model</span>
      <span class="pv-dz-s">PNG · JPG · SVG · GLB · GLTF · OBJ · STL</span>
      <span class="pv-dz-b">Choose a file</span>
    </label>
    <form class="pv-wordform" autocomplete="off">
      <input type="text" name="word" maxlength="40" placeholder="Or set a word" aria-label="Word to sample" spellcheck="false" />
      <button type="submit" class="pv-wordform-b">${icon('text')}<span>Make</span></button>
    </form>
    <div class="pv-src" hidden>
      <div class="pv-src-r"><span class="pv-src-k">Source</span><span class="pv-src-v"></span></div>
      <p class="pv-src-note" hidden>Drop the file again to edit its parameters.</p>
    </div>
    <div class="pv-pane pv-pane-mini"></div>
  `
  const fileInput = sheet.querySelector('input[type=file]')
  const dz = sheet.querySelector('.pv-dz')
  const form = sheet.querySelector('.pv-wordform')
  const word = form.querySelector('input')
  const src = sheet.querySelector('.pv-src')
  const srcV = sheet.querySelector('.pv-src-v')
  const srcNote = sheet.querySelector('.pv-src-note')
  const paneHost = sheet.querySelector('.pv-pane-mini')
  sheet.querySelector('.pv-sheet-n').textContent = app.entries.find((e) => e.id === 'custom')?.number + ' ' || ''
  sheet.querySelector('.pv-sheet-x').addEventListener('click', () => close())

  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0]
    if (f) fromFile(f)
    fileInput.value = ''
  })
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const t = word.value.trim()
    if (!t) return word.focus()
    make({ kind: 'text', text: t, name: t })
  })

  for (const ev of ['dragenter', 'dragover']) {
    dz.addEventListener(ev, (e) => {
      e.preventDefault()
      dz.classList.add('is-over')
    })
  }
  dz.addEventListener('dragleave', () => dz.classList.remove('is-over'))
  dz.addEventListener('drop', () => dz.classList.remove('is-over'))

  // Drag and drop anywhere on the page.
  let depth = 0
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files')
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth++
    document.body.classList.add('pv-dragging')
  })
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  })
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return
    depth = Math.max(0, depth - 1)
    if (!depth) document.body.classList.remove('pv-dragging')
  })
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth = 0
    document.body.classList.remove('pv-dragging')
    const f = e.dataTransfer.files && e.dataTransfer.files[0]
    if (f) fromFile(f)
  })

  async function fromFile(file) {
    let mod
    try {
      mod = await customModule()
    } catch (e) {
      return app.toast(e.message || 'Custom sources are not available', { error: true })
    }
    const kind = mod.kindFromFile(file)
    if (!kind) return app.toast(`${file.name} is not a supported file`, { error: true })
    open()
    make({ kind, file, name: file.name })
  }

  async function make(src2, { params, quiet = false } = {}) {
    if (building) return
    let mod
    try {
      mod = await customModule()
    } catch (e) {
      return app.toast(e.message || 'Custom sources are not available', { error: true })
    }
    const kind = src2.kind
    const prev = state.custom
    const p = { ...mod.customParamDefaults(kind), ...(params || (prev && prev.kind === kind ? prev.params : {})) }
    const label = src2.name || (kind === 'text' ? src2.text : 'source')
    const t = quiet ? null : app.toast(`Sampling ${label}`, { busy: true })
    building = true
    sheet.classList.add('is-busy')
    try {
      const shape = await mod.createCustomShape(src2, p, { seed: state.config.seed, maxCount: MAX_COUNT })
      source = src2
      state.custom = { kind, name: shape.meta.label, text: kind === 'text' ? src2.text : null, params: p }
      app.setCustomShape(shape)
      renderSource()
      if (!paramPane || paneKind !== kind || !quiet) renderParams(mod, kind, p)
      t?.done(`${shape.meta.label} · ${shape.meta.buildMs} ms`)
    } catch (e) {
      console.error(e)
      if (t) t.fail(e.message || 'Could not sample this source')
      else app.toast(e.message || 'Could not sample this source', { error: true })
    } finally {
      building = false
      sheet.classList.remove('is-busy')
    }
  }

  function renderSource() {
    const c = state.custom
    src.hidden = !c
    if (!c) return
    srcV.textContent = `${c.name || 'Untitled'} · ${KIND_LABEL[c.kind] || c.kind}`
    srcNote.hidden = !!source
  }

  function renderParams(mod, kind, values) {
    if (paramPane) paramPane.dispose()
    paramPane = null
    paneKind = kind
    const defs = mod?.CUSTOM_PARAMS?.[kind]
    if (!defs || !source) return
    paramValues = { ...values }
    paramPane = new Pane({ container: paneHost })
    paramPane.registerPlugin(EssentialsPlugin)
    for (const [key, p] of Object.entries(defs)) {
      const label = p.label || titleCase(key)
      let b
      if (Array.isArray(p.options)) {
        b = p.options.length <= 3 && p.options.every((o) => String(o).length <= 7)
          ? paramPane.addBinding(paramValues, key, {
            view: 'radiogrid',
            groupName: `pv-c-${key}`,
            size: [p.options.length, 1],
            cells: (x) => ({ title: titleCase(p.options[x]), value: p.options[x] }),
            label,
          })
          : paramPane.addBinding(paramValues, key, { label, options: Object.fromEntries(p.options.map((o) => [String(o), o])) })
      } else if (typeof p.value === 'number') {
        const params = { label }
        for (const k of ['min', 'max', 'step']) if (p[k] !== undefined) params[k] = p[k]
        b = paramPane.addBinding(paramValues, key, params)
      } else {
        b = paramPane.addBinding(paramValues, key, { label })
      }
      b.on('change', (ev) => {
        if (ev.last === false) return
        rebuild()
      })
    }
  }

  let rebuildTimer = 0
  function rebuild() {
    clearTimeout(rebuildTimer)
    rebuildTimer = setTimeout(() => {
      if (!source) return
      if (building) return rebuild()
      make(source, { params: { ...paramValues }, quiet: true })
    }, 40)
  }

  // Seed or reset: rebuild from the kept source when we still have it.
  function refresh({ resetParams = false } = {}) {
    if (!source) return false
    if (resetParams) {
      customModule().then((mod) => make(source, { params: mod.customParamDefaults(source.kind), quiet: true }))
      return true
    }
    make(source, { params: paramValues ? { ...paramValues } : undefined, quiet: true })
    return true
  }

  function isOpen() {
    return !sheet.hidden
  }
  function open() {
    sheet.hidden = false
    document.body.classList.add('pv-sheet-open')
    requestAnimationFrame(() => sheet.classList.add('is-in'))
    renderSource()
    if (source && !paramPane && state.custom) customModule().then((mod) => renderParams(mod, state.custom.kind, state.custom.params || {})).catch(() => {})
    app.chrome?.setActive()
  }
  function close() {
    sheet.classList.remove('is-in')
    document.body.classList.remove('pv-sheet-open')
    sheet.hidden = true
    app.chrome?.setActive()
  }
  function toggle() {
    if (isOpen()) close()
    else open()
  }

  // Warm the module so the first drop is instant.
  setTimeout(() => customModule().catch(() => {}), 1500)

  return { open, close, toggle, isOpen, make, fromFile, refresh, hasSource: () => !!source }
}
