// Export entry, bundled to an IIFE (three inlined) by vite.config.js and
// embedded in the exported HTML. Contract: SPEC.md §Export payload.

import { ParticleField } from './ParticleField.js'
import { decodeShape } from './codec.js'
import { mount } from './mount.js'

window.Pulviscolo = { ParticleField, decodeShape, mount }
