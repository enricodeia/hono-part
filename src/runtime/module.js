// ESM export entry: same runtime, `three` left as a bare import so it resolves
// through an import map (CDN) or the host app's bundler. SPEC.md §Export.
//
// The exporter replaces the string literal below with the payload object
// literal ({ config, shapes, sequence }), so the downloaded module is
// self-contained: `import { mountPulviscolo } from './pulviscolo-heart.js'`.

import { mount } from './mount.js'

const EMBEDDED = '__PULVISCOLO_PAYLOAD__'

export function mountPulviscolo(container, overrides = {}) {
  if (typeof EMBEDDED === 'string') throw new Error('Pulviscolo: no embedded payload in this build')
  const config = overrides.config ? deepMerge(EMBEDDED.config, overrides.config) : EMBEDDED.config
  return mount(container, { ...EMBEDDED, ...overrides, config })
}

function deepMerge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b
  const out = { ...a }
  for (const k of Object.keys(b)) out[k] = a && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepMerge(a[k], b[k]) : b[k]
  return out
}

export const payload = typeof EMBEDDED === 'string' ? null : EMBEDDED
export { mount }
export { ParticleField } from './ParticleField.js'
export { decodeShape, encodeShape } from './codec.js'
