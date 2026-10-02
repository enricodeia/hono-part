// Reference overlay: one of /reference/0X-*.png over the canvas to calibrate
// framing. 'auto' follows the current specimen. Toggle with O.

const FILES = [
  ['01-triangle.png', 'Triangle'],
  ['02-head-brain.png', 'Head and brain'],
  ['03-heart.png', 'Heart'],
  ['04-dna-horizontal.png', 'Helix horizontal'],
  ['05-dna-vertical.png', 'Helix vertical'],
]
// 02 and 03 were rendered on black: inverted they read as ink on white.
const DARK = new Set(['02-head-brain.png', '03-heart.png'])

export const REFERENCE_DEFAULTS = { show: false, image: 'auto', opacity: 0.45, blend: 'multiply', invert: true, fit: 'contain' }

export function createReference(app) {
  const img = document.getElementById('pv-reference')
  const state = { ...REFERENCE_DEFAULTS, ...(app.state.ui.reference || {}) }
  if (typeof state.invert !== 'boolean') state.invert = true
  app.state.ui.reference = state

  const options = { Auto: 'auto' }
  FILES.forEach(([f, label], i) => (options[`0${i + 1} ${label}`] = f))

  function autoFile() {
    const cur = app.current
    if (!cur || cur.id === 'custom') return null
    const key = `${cur.id} ${cur.label}`.toLowerCase()
    if (/heart/.test(key)) return FILES[2][0]
    if (/head|brain/.test(key)) return FILES[1][0]
    if (/tri/.test(key)) return FILES[0][0]
    if (/dna|helix/.test(key)) return /vert|↕|[-_ ]v\b|v$/.test(key) ? FILES[4][0] : FILES[3][0]
    const i = app.specimens.findIndex((s) => s.id === cur.id)
    return FILES[i] ? FILES[i][0] : null
  }

  function file() {
    return state.image === 'auto' ? autoFile() : state.image
  }

  function apply() {
    const f = file()
    const on = !!state.show && !!f
    img.hidden = !on
    document.body.classList.toggle('pv-ref-on', on)
    if (!on) return
    const src = `./reference/${f}`
    if (!img.src.endsWith(src.slice(1))) img.src = src
    img.style.opacity = String(state.opacity)
    img.style.mixBlendMode = state.blend
    img.style.objectFit = state.fit
    img.style.filter = state.invert && DARK.has(f) ? 'invert(1) grayscale(1)' : 'grayscale(1)'
  }

  function set(patch) {
    Object.assign(state, patch)
    apply()
    app.save()
  }

  function toggle() {
    set({ show: !state.show })
    app.panel?.sync()
    const f = file()
    app.toast(state.show ? (f ? `Reference ${f.slice(0, 2)} over the field · O to hide` : 'No reference for this specimen') : 'Reference hidden')
  }

  apply()
  return { state, options, set, toggle, apply }
}
