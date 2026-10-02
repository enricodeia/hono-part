// mount(container, payload) boots an exported piece: decodes the embedded
// shapes, creates the ParticleField, runs the optional shape sequence.
// Contract: SPEC.md §6.
//
// payload = {
//   config,                        // DEFAULT_CONFIG-shaped (partial is fine)
//   shapes: [encodedShape, …],     // codec.js encodeShape(); decoded ShapeData also accepted
//   configs?: [partialConfig, …],  // optional per-shape looks, merged over config on each switch
//   sequence: { enabled, interval = 6, trigger: 'auto' | 'click' | 'both' },
//   options: { interactive = true, transparent = false, pixelRatio? },
// }

import { ParticleField } from './ParticleField.js'
import { decodeShape } from './codec.js'
import { DEFAULT_CONFIG, mergeConfig } from '../state.js'

export function mount(container, payload = {}) {
  if (typeof container === 'string') container = document.querySelector(container)
  if (!container) throw new Error('Pulviscolo: mount container not found')
  const shapes = (payload.shapes || []).map((s) => (s && s.positions ? s : decodeShape(s)))
  const options = { interactive: true, transparent: false, ...(payload.options || {}) }
  const seq = { enabled: false, interval: 6, trigger: 'both', ...(payload.sequence || {}) }
  const looks = Array.isArray(payload.configs) ? payload.configs : null
  const base = mergeConfig(DEFAULT_CONFIG, payload.config || {})
  const configFor = (i) => (looks && looks[i] ? mergeConfig(base, looks[i]) : base)

  const field = new ParticleField(container, {
    config: configFor(0),
    shape: shapes[0] || null,
    interactive: options.interactive,
    transparent: options.transparent,
    pixelRatio: options.pixelRatio,
  })

  let index = 0
  let wait = 0
  const many = seq.enabled && shapes.length > 1
  const auto = many && (seq.trigger === 'auto' || seq.trigger === 'both')
  const onClick = many && options.interactive && (seq.trigger === 'click' || seq.trigger === 'both')
  const interval = Math.max(0.5, +seq.interval || 6)

  function goTo(i, { morph = true } = {}) {
    if (!shapes.length) return
    index = ((i % shapes.length) + shapes.length) % shapes.length
    if (looks) field.setConfig(configFor(index))
    field.setShape(shapes[index], { morph })
    wait = 0
  }
  const next = () => goTo(index + 1)
  const prev = () => goTo(index - 1)

  const offs = []
  if (auto) {
    // counts frame time, so a hidden tab or an off-screen embed does not skip ahead
    offs.push(
      field.on('frame', (t, dt) => {
        if (field.morphing) return
        wait += dt
        if (wait >= interval) next()
      }),
    )
  }
  if (onClick) offs.push(field.on('click', () => next()))

  return {
    field,
    shapes,
    next,
    prev,
    goTo,
    get index() {
      return index
    },
    destroy() {
      offs.forEach((off) => off())
      field.dispose()
    },
  }
}
