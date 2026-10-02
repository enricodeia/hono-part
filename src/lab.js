// Runtime lab: one full-viewport ParticleField, driven by the query string and
// window.__lab (playwright scripts in tools/runtime-*.mjs).
//   ?shape=heart  ?count=1500  ?seed=1  ?pr=2  ?hud=1
//   ?cfg=<url-encoded JSON patch merged over DEFAULT_CONFIG + the shape's defaults>
//   ?params=<JSON shape params>  ?interactive=0  ?transparent=1

import { ParticleField } from './runtime/ParticleField.js'
import { encodeShape, decodeShape } from './runtime/codec.js'
import { DEFAULT_CONFIG, mergeConfig } from './state.js'
import { SHAPES, buildShape, getShapeDef } from './shapes/index.js'

const q = new URLSearchParams(location.search)
const fail = (e) => {
  const el = document.getElementById('err')
  el.style.display = 'block'
  el.textContent = String(e && e.stack ? e.stack : e)
  console.error(e)
  document.body.dataset.ready = 'error'
}

try {
  run()
} catch (e) {
  fail(e)
}

function lookFor(id, patch) {
  const def = getShapeDef(id)
  return mergeConfig(mergeConfig(DEFAULT_CONFIG, (def && def.defaults) || {}), patch || {})
}

function run() {
  if (!SHAPES.length) throw new Error('no shapes registered')
  const ids = SHAPES.map((s) => s.id)
  const id = q.get('shape') && ids.includes(q.get('shape')) ? q.get('shape') : ids[0]
  const seed = +q.get('seed') || 1
  const params = q.get('params') ? JSON.parse(q.get('params')) : {}
  const patch = q.get('cfg') ? JSON.parse(q.get('cfg')) : {}
  if (q.has('count')) patch.count = +q.get('count')
  const config = lookFor(id, patch)
  config.shape = id

  const shape = buildShape(id, params, seed)
  const field = new ParticleField(document.getElementById('stage'), {
    config,
    shape,
    pixelRatio: q.has('pr') ? +q.get('pr') : undefined,
    interactive: q.get('interactive') !== '0',
    transparent: q.get('transparent') === '1',
  })

  let current = id
  window.__lab = {
    field,
    shapes: ids,
    buildShape,
    encodeShape,
    decodeShape,
    DEFAULT_CONFIG,
    mergeConfig,
    lookFor,
    get current() {
      return current
    },
    // switch shape with its own default look (plus the lab's ?cfg patch)
    setShape(next, morph = true, extra = {}) {
      const s = buildShape(next, extra.params || {}, extra.seed || seed)
      field.setConfig(lookFor(next, { ...patch, ...(extra.cfg || {}) }))
      field.setShape(s, { morph })
      current = next
      return s.meta
    },
    setConfig(p) {
      field.setConfig(p)
      return field.config
    },
    waitMorph() {
      return new Promise((res) => {
        if (!field.morphing) return res(true)
        const off = field.on('morphend', () => {
          off()
          res(true)
        })
      })
    },
    frames(n = 2) {
      return new Promise((res) => {
        let k = 0
        const off = field.on('frame', () => {
          if (++k >= n) {
            off()
            res(true)
          }
        })
      })
    },
  }

  const hud = document.getElementById('hud')
  if (q.get('hud') === '1') {
    let last = 0
    field.on('frame', (t) => {
      if (t - last < 0.25) return
      last = t
      const s = field.stats
      hud.textContent = `${current} · ${s.particles} pts · ${s.dust} dust · ${s.fps.toFixed(0)} fps · cpu ${s.cpuMs.toFixed(2)} ms`
    })
  }

  field.on('ready', () => {
    document.body.dataset.ready = 'true'
  })
}

// Shapes are edited by other people while tests run: take their updates
// without a full page reload (the field keeps its current shape).
if (import.meta.hot) import.meta.hot.accept(['./shapes/index.js'], () => {})
