// TEMPORARY scaffold smoke test (deleted after the pipeline is verified).
import { createRng } from './lib/rng.js'
import { finalizeShape, sampleSDF } from './lib/sampling.js'
import { sdTorus } from './lib/sdf.js'
export default {
  id: 'zz-smoke', label: 'Smoke torus', order: 999, params: {}, defaults: {},
  generate(params, { seed, maxCount }) {
    const rng = createRng(seed)
    const s = sampleSDF((x, y, z) => sdTorus(x, y, z, 1, 0.35), { min: [-1.5, -0.5, -1.5], max: [1.5, 0.5, 1.5] }, maxCount, rng, { shell: 0.03 })
    return finalizeShape({ positions: s.positions, normal: s.normals }, { seed, maxCount, meta: { id: 'zz-smoke', label: 'Smoke torus' } })
  },
}
