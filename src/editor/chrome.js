// The sheet around the field: plate label, specimen index, count control,
// live stats, panel shell (header actions, shortcuts, collapse, mobile sheet).

import { COUNT_PRESETS } from '../state.js'
import { icon } from './icons.js'

const LIFE = {
  none: 'Still',
  wave: 'Wave',
  heartbeat: 'Heartbeat',
  helix: 'Helix',
  neural: 'Neural',
  breath: 'Breath',
}

const KEYS = [
  ['1', 'to', '6', 'Specimen'],
  ['H', 'Interface'],
  ['P', 'PNG'],
  ['E', 'HTML'],
  ['R', 'Reroll'],
  ['O', 'Reference'],
]

const pad = (n, w = 2) => String(n).padStart(w, '0')
const el = (tag, cls, html) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html != null) e.innerHTML = html
  return e
}

export function createChrome(app) {
  const { state } = app
  const plate = document.getElementById('pv-plate')
  const index = document.getElementById('pv-index')
  const count = document.getElementById('pv-count')
  const stats = document.getElementById('pv-stats')
  const panel = document.getElementById('pv-panel')
  const fab = document.getElementById('pv-fab')
  const actions = document.getElementById('pv-panel-actions')
  const keys = document.getElementById('pv-keys')
  const mobile = window.matchMedia('(max-width: 720px)')

  // ── plate (specimen label) ─────────────────────────────────────────────
  const plateRows = {}
  for (const [k, label] of [
    ['no', 'No.'],
    ['name', 'Specimen'],
    ['life', 'Life'],
    ['seed', 'Seed'],
  ]) {
    const row = el('div', 'pv-plate-r')
    row.append(el('dt', null, label), (plateRows[k] = el('dd')))
    plate.appendChild(row)
  }

  function updatePlate() {
    const cur = app.current
    const total = app.entries.length
    plateRows.no.textContent = `${cur.number} / ${pad(total)}`
    plateRows.name.textContent = cur.label
    plateRows.life.textContent = state.config.life.enabled ? LIFE[cur.life] || cur.life || 'Still' : 'Paused'
    plateRows.seed.textContent = pad(state.config.seed, 4)
  }

  // ── specimen index ─────────────────────────────────────────────────────
  const indexHead = el('div', 'pv-index-h', '<span>Specimens</span>')
  const list = el('div', 'pv-index-l')
  list.setAttribute('role', 'listbox')
  index.append(indexHead, list)
  const items = new Map()

  function renderIndex() {
    list.textContent = ''
    items.clear()
    for (const e of app.entries) {
      const b = el('button', 'pv-spec')
      b.type = 'button'
      b.setAttribute('role', 'option')
      b.dataset.id = e.id
      b.title = e.id === 'custom' ? 'Custom specimen: image, SVG, 3D model or text' : `${e.label} (${Number(e.number)})`
      b.innerHTML = `<span class="pv-spec-n">${e.number}</span><span class="pv-spec-l">${e.label}</span>${e.id === 'custom' ? `<span class="pv-spec-x">${icon('plus')}</span>` : ''}`
      b.addEventListener('click', () => app.selectEntry(e.id))
      list.appendChild(b)
      items.set(e.id, b)
    }
    setActive()
  }

  function setActive() {
    for (const [id, b] of items) {
      const on = id === state.config.shape
      b.classList.toggle('is-active', on)
      b.setAttribute('aria-selected', on ? 'true' : 'false')
      if (on && mobile.matches) b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
    }
    items.get('custom')?.classList.toggle('is-open', app.sheetOpen?.())
  }

  // ── count control ──────────────────────────────────────────────────────
  const countHead = el('div', 'pv-count-h')
  const live = el('span', 'pv-count-live', '8000')
  countHead.append(el('span', 'pv-k', 'Particles'), live)
  const seg = el('div', 'pv-seg')
  seg.setAttribute('role', 'radiogroup')
  seg.setAttribute('aria-label', 'Particle count')
  const segButtons = COUNT_PRESETS.map((n) => {
    const b = el('button', 'pv-seg-b', String(n))
    b.type = 'button'
    b.setAttribute('role', 'radio')
    b.addEventListener('click', () => app.setCount(n))
    seg.appendChild(b)
    return b
  })
  count.append(countHead, seg)
  // When a stylesheet hides the count control, toasts and the mobile index
  // drop down into its place.
  document.body.classList.toggle('pv-no-count', getComputedStyle(count).display === 'none')

  function updateCount() {
    const n = state.config.count
    segButtons.forEach((b, i) => {
      const on = COUNT_PRESETS[i] === n
      b.classList.toggle('is-active', on)
      b.setAttribute('aria-checked', on ? 'true' : 'false')
    })
  }

  // ── stats ──────────────────────────────────────────────────────────────
  const sFps = el('b')
  const sPts = el('b')
  const sDust = el('b')
  const sCpu = el('b')
  const s1 = el('span', 'pv-st')
  s1.append(sFps, ' fps')
  const s2 = el('span', 'pv-st')
  s2.append(sPts, ' particles')
  const s3 = el('span', 'pv-st')
  s3.append(sDust, ' dust')
  const s4 = el('span', 'pv-st pv-st-cpu')
  s4.append(sCpu, ' ms cpu')
  stats.append(s1, s2, s3, s4)

  let lastStats = 0
  let lastLive = -1
  function tick(st) {
    const now = performance.now()
    if (st && st.particles != null) {
      const p = Math.round(st.particles)
      if (p !== lastLive) {
        lastLive = p
        live.textContent = String(p)
      }
    }
    if (now - lastStats < 250 || !st) return
    lastStats = now
    sFps.textContent = String(Math.round(st.fps || 0))
    sPts.textContent = String(Math.round(st.particles ?? state.config.count))
    sDust.textContent = String(Math.round(st.dust ?? state.config.dust.count))
    if (st.cpuMs != null) sCpu.textContent = (+st.cpuMs).toFixed(1)
    s4.hidden = st.cpuMs == null
  }

  // ── panel shell ────────────────────────────────────────────────────────
  const hideBtn = el('button', 'pv-ib', icon('hide'))
  hideBtn.type = 'button'
  hideBtn.title = 'Hide interface (H)'
  hideBtn.setAttribute('aria-label', 'Hide interface')
  hideBtn.addEventListener('click', () => toggleUI(false))
  const colBtn = el('button', 'pv-ib', icon('minus'))
  colBtn.type = 'button'
  colBtn.title = 'Collapse panel'
  colBtn.setAttribute('aria-label', 'Collapse panel')
  colBtn.addEventListener('click', () => setPanelOpen(false))
  actions.append(hideBtn, colBtn)

  fab.innerHTML = `${icon('sliders')}<span>Controls</span>`
  fab.addEventListener('click', () => setPanelOpen(!panelOpen()))

  keys.innerHTML = KEYS.map((k) => {
    const label = k[k.length - 1]
    const caps = k.slice(0, -1).map((c) => (c === 'to' ? '<i>to</i>' : `<kbd>${c}</kbd>`)).join('')
    return `<span class="pv-key">${caps}<span>${label}</span></span>`
  }).join('')

  const panelOpen = () => document.body.classList.contains('pv-panel-open')

  function setPanelOpen(open, { save = true } = {}) {
    document.body.classList.toggle('pv-panel-open', open)
    fab.setAttribute('aria-expanded', open ? 'true' : 'false')
    panel.setAttribute('aria-hidden', open ? 'false' : 'true')
    if (save) {
      if (mobile.matches) state.ui.sheet = open
      else state.ui.panel = open
      app.save()
    }
  }

  function applyPanelDefault() {
    // The panel always starts folded behind the top-right toggle (client request):
    // on load only the specimen, the mark and the bottom-left index are visible.
    setPanelOpen(false, { save: false })
  }
  mobile.addEventListener('change', applyPanelDefault)
  applyPanelDefault()

  function toggleUI(force) {
    const hidden = document.body.classList.contains('pv-ui-hidden')
    const show = force ?? hidden
    document.body.classList.toggle('pv-ui-hidden', !show)
    if (!show) app.toast('Interface hidden · press H to bring it back')
  }

  return { renderIndex, setActive, updatePlate, updateCount, tick, setPanelOpen, panelOpen, toggleUI, mobile }
}
