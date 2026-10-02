// 04 · Helix and 05 · Helix ↕: one double-helix generator, two specimens.
//
// Measured on reference/04-dna-horizontal.png and 05-dna-vertical.png:
//   pitch / radius ≈ 4.9 on both (P = 746 px, R = 152 px on 04; P ≈ 1080,
//   R ≈ 215 on 05), strand gaussian sd ≈ 0.1 R, a base pair every ≈ 54 px on
//   04 → 14 rungs per turn, the same spacing on 05. 04 shows ≈ 2.5 turns with
//   a crossover near the centre; 05 shows one crossover (waist) at the centre
//   with the strands at full separation top and bottom (≈ 0.65 turns).
// Strands carry most of the dots with a fine + fat size mix, base pairs are
// finer dotted rungs (group 2), a few faint clusters float off the strands
// (group 1).

import { createRng } from './lib/rng.js'
import { finalizeShape } from './lib/sampling.js'

const TAU = Math.PI * 2
const smooth = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}
const logNormal = (rng, mean, spread) => mean * Math.exp(rng.normal() * spread - (spread * spread) / 2)
const clampG = (rng, lim = 2.6) => {
  let g = rng.normal()
  while (Math.abs(g) > lim) g = rng.normal()
  return g
}

const PARAMS = (turns) => ({
  turns: { value: turns, min: 0.5, max: 6, step: 0.05, label: 'Turns' },
  radius: { value: 0.205, min: 0.08, max: 0.45, step: 0.005, label: 'Radius' },
  thickness: { value: 0.1, min: 0.02, max: 0.3, step: 0.005, label: 'Strand' },
  groove: { value: 180, min: 90, max: 180, step: 1, label: 'Groove °' },
  rungsPerTurn: { value: 14, min: 0, max: 24, step: 1, label: 'Rungs / turn' },
  rungs: { value: 0.4, min: 0, max: 0.7, step: 0.01, label: 'Rung share' },
  clusters: { value: 0.04, min: 0, max: 0.2, step: 0.005, label: 'Clusters' },
  taper: { value: 0.3, min: 0, max: 1, step: 0.01, label: 'End taper' },
  fat: { value: 0.24, min: 0, max: 0.6, step: 0.01, label: 'Fat dots' },
  hand: { value: 'right', options: ['right', 'left'], label: 'Handedness' },
})

function generateHelix(params, { seed, maxCount }, orient) {
  const rng = createRng(seed)
  const T = Math.max(0.25, params.turns)
  const R = params.radius
  const sigma = params.thickness * R
  const g = (params.groove * Math.PI) / 180
  const L = T // pitch = 1
  const vertical = orient === 'vertical'
  const mirror = params.hand === 'left' ? -1 : 1 // B-DNA is right-handed; many posters are not
  // phase so the centre of the axis is a crossover in the FRONT view
  const thetaCross = vertical ? Math.PI / 2 - g / 2 : Math.PI - g / 2
  const theta0 = thetaCross - TAU * (L / 2)
  const thetaLobe = thetaCross - Math.PI / 2 // strands at full separation

  // helix-local (u along the axis, p, q across) → world
  const out = [0, 0, 0]
  const toWorld = (u, p, q) => {
    q *= mirror
    if (vertical) {
      out[0] = q
      out[1] = u
      out[2] = p
    } else {
      out[0] = u
      out[1] = p
      out[2] = q
    }
    return out
  }

  // end taper: density and thickness ease off over the outer `zone` of each end
  const zone = Math.max(1e-3, params.taper * 0.5)
  const ease = (a) => (params.taper <= 0 ? 1 : smooth(0, zone, Math.min(a, L - a) / L))
  const densityAt = (a) => 0.28 + 0.72 * ease(a)
  const thickAt = (a) => 0.5 + 0.5 * ease(a)

  // frame at axis coordinate a on the strand with phase offset ph
  const frame = (a, ph, f) => {
    const th = theta0 + TAU * a + ph
    const c = Math.cos(th)
    const s = Math.sin(th)
    f.p = R * c
    f.q = R * s
    // tangent (du, dp, dq) = (1, -R·2π·s, R·2π·c)
    const k = R * TAU
    const tl = Math.hypot(1, k) || 1
    f.tu = 1 / tl
    f.tp = (-k * s) / tl
    f.tq = (k * c) / tl
    // radial (0, c, s) and binormal = tangent × radial
    f.rp = c
    f.rq = s
    f.bu = f.tp * s - f.tq * c
    f.bp = -f.tu * s
    f.bq = f.tu * c
    return f
  }

  const N = maxCount
  const nRung = params.rungsPerTurn > 0 ? Math.round(N * params.rungs) : 0
  const nCluster = Math.round(N * params.clusters)
  const nStrand = N - nRung - nCluster

  const positions = new Float32Array(N * 3)
  const normal = new Float32Array(N * 3)
  const group = new Uint8Array(N)
  const size = new Float32Array(N)
  const aux = new Float32Array(N)
  let w = 0
  const put = (u, p, q, nu, np, nq, grp, sz, ax) => {
    const P = toWorld(u - L / 2, p, q)
    positions[w * 3] = P[0]
    positions[w * 3 + 1] = P[1]
    positions[w * 3 + 2] = P[2]
    const nl = Math.hypot(nu, np, nq) || 1
    const Nn = toWorld(nu / nl, np / nl, nq / nl)
    normal[w * 3] = Nn[0]
    normal[w * 3 + 1] = Nn[1]
    normal[w * 3 + 2] = Nn[2]
    group[w] = grp
    size[w] = sz
    aux[w] = ax
    w++
  }

  // ── strands: gaussian tubes, fine dots everywhere, fat dots nearer the core
  const f = {}
  const pickA = () => {
    for (let tries = 0; tries < 64; tries++) {
      const a = rng.next() * L
      if (rng.next() < densityAt(a)) return a
    }
    return rng.next() * L
  }
  for (let i = 0; i < nStrand; i++) {
    const a = pickA()
    const ph = i & 1 ? g : 0
    frame(a, ph, f)
    const isFat = rng.next() < params.fat
    const sd = sigma * thickAt(a) * (isFat ? 0.9 : 1.05)
    const g1 = clampG(rng) * sd
    const g2 = clampG(rng) * sd
    const ou = f.bu * g2
    const op = f.rp * g1 + f.bp * g2
    const oq = f.rq * g1 + f.bq * g2
    const hasOff = Math.abs(g1) + Math.abs(g2) > 1e-6
    put(
      a + ou,
      f.p + op,
      f.q + oq,
      hasOff ? ou : 0,
      hasOff ? op : f.rp,
      hasOff ? oq : f.rq,
      0,
      isFat ? logNormal(rng, 1.5, 0.3) : logNormal(rng, 0.66, 0.36),
      a / L,
    )
  }

  // ── base pairs: dotted rungs at regular steps, aligned on the lobe centres
  if (nRung > 0) {
    const step = 1 / params.rungsPerTurn
    const first = (thetaLobe - theta0) / TAU
    const k0 = Math.ceil((0 - first) / step)
    const rungs = []
    for (let k = k0; ; k++) {
      const a = first + k * step
      if (a > L) break
      if (a < 0) continue
      rungs.push({ a, w: densityAt(a), phase: rng.next() * TAU })
    }
    const wsum = rungs.reduce((s, r) => s + r.w, 0) || 1
    const fa = {}
    const fb = {}
    const sdR = sigma * 0.42
    for (let i = 0; i < nRung; i++) {
      // pick a rung ∝ its taper weight
      let r = rng.next() * wsum
      let rung = rungs[rungs.length - 1]
      for (const c of rungs) {
        r -= c.w
        if (r <= 0) {
          rung = c
          break
        }
      }
      frame(rung.a, 0, fa)
      frame(rung.a, g, fb)
      const t = 0.03 + 0.94 * rng.next()
      // the rung chord, a gentle meander along the axis, a thin gaussian section
      const dp = fb.p - fa.p
      const dq = fb.q - fa.q
      const dl = Math.hypot(dp, dq) || 1
      const cp = -dq / dl // across the rung, perpendicular to the axis
      const cq = dp / dl
      const wav = Math.sin(t * Math.PI * 3 + rung.phase) * sigma * 0.35
      const g1 = clampG(rng, 2.2) * sdR * thickAt(rung.a)
      const g2 = clampG(rng, 2.2) * sdR * thickAt(rung.a)
      const tiny = Math.abs(g1) + Math.abs(g2) < 1e-6
      put(
        rung.a + wav + g1,
        fa.p + dp * t + cp * g2,
        fa.q + dq * t + cq * g2,
        tiny ? 0 : g1,
        tiny ? cp : cp * g2,
        tiny ? cq : cq * g2,
        2,
        logNormal(rng, 0.9, 0.32),
        rung.a / L,
      )
    }
  }

  // ── faint clusters drifting just off the strands
  if (nCluster > 0) {
    let left = nCluster
    while (left > 0) {
      const m = Math.min(left, 3 + rng.int(8))
      const a = pickA()
      frame(a, rng.next() < 0.5 ? 0 : g, f)
      const ang = rng.next() * TAU
      const dist = sigma * (2.2 + rng.next() * 3)
      const cu = f.bu * Math.sin(ang) * dist
      const cp = (f.rp * Math.cos(ang) + f.bp * Math.sin(ang)) * dist
      const cq = (f.rq * Math.cos(ang) + f.bq * Math.sin(ang)) * dist
      for (let j = 0; j < m; j++) {
        const s = sigma * 0.55
        const du = rng.normal() * s
        const dp = rng.normal() * s
        const dq = rng.normal() * s
        put(a + cu + du, f.p + cp + dp, f.q + cq + dq, cu, cp, cq, 1, logNormal(rng, 0.55, 0.3), a / L)
      }
      left -= m
    }
  }

  // mean size ≈ 1 (the runtime mixes towards the attribute by sizeVariance)
  let mean = 0
  for (let i = 0; i < N; i++) mean += size[i]
  mean /= N
  for (let i = 0; i < N; i++) size[i] = Math.min(Math.max(size[i] / mean, 0.3), 2.6)

  return finalizeShape(
    { positions, normal, group, size, aux },
    {
      seed,
      maxCount,
      meta: {
        life: 'helix',
        axis: vertical ? [0, 1, 0] : [1, 0, 0],
        center: [0, 0, 0],
        groups: ['Strands', 'Clusters', 'Base pairs'],
        aux: 'coordinate along the helix axis, 0..1',
      },
    },
  )
}

const helixDefaults = {
  particles: { size: 2.4, sizeVariance: 0.9, softness: 0.06, opacity: 0.95, colorB: '#0d0d0d', opacityB: 0.38, colorC: '#0d0d0d', opacityC: 0.8, shading: 0.2 },
  depth: { fade: 0.42, dof: 0 },
  life: { enabled: true, amount: 0.5, rate: 0.5 },
  dust: { count: 1800, size: 0.9, opacity: 0.16, radius: 1, drift: 0.2 },
}

export default [
  {
    id: 'dna',
    label: 'Helix',
    order: 4,
    params: PARAMS(2.5),
    defaults: {
      ...helixDefaults,
      depth: { fade: 0.32, dof: 0 },
      motion: { mode: 'sway', speed: 0.15, swayAngle: 5, yaw: 0, pitch: 0, roll: 0, float: 0.1, noise: 0.14 },
      dissolve: { amount: 0.3, mode: 'mirror', angle: 0, softness: 0.45, spread: 0.8, turbulence: 0.6, fade: 0.85 },
      scene: { glow: 0 },
      // a long fov flattens the 2.5 turns like the poster (ends not seen obliquely)
      camera: { fov: 14, frame: 1, azimuth: 0, elevation: 0, offsetX: 0, offsetY: 0 },
    },
    generate(params, ctx) {
      const s = generateHelix(params, ctx, 'horizontal')
      Object.assign(s.meta, { id: 'dna', label: 'Helix', frame: { w: 0.93 } })
      return s
    },
  },
  {
    id: 'dna-vertical',
    label: 'Helix ↕',
    order: 5,
    params: {
      ...PARAMS(0.7),
      thickness: { value: 0.07, min: 0.02, max: 0.3, step: 0.005, label: 'Strand' },
      taper: { value: 0.15, min: 0, max: 1, step: 0.01, label: 'End taper' },
    },
    defaults: {
      ...helixDefaults,
      particles: { ...helixDefaults.particles, size: 2.6 },
      motion: { mode: 'still', speed: 0.15, swayAngle: 5, yaw: 0, pitch: -12, roll: 6, float: 0.1, noise: 0.14 },
      dissolve: { amount: 0.35, mode: 'linear', angle: -12, softness: 0.45, spread: 0.8, turbulence: 0.6, fade: 0.85 },
      scene: { glow: 0.3, glowColor: '#dce9f7' },
      camera: { frame: 1, azimuth: 0, elevation: 0, offsetX: 0, offsetY: 0 },
    },
    generate(params, ctx) {
      const s = generateHelix(params, ctx, 'vertical')
      Object.assign(s.meta, { id: 'dna-vertical', label: 'Helix ↕', frame: { h: 0.7 } })
      return s
    },
  },
]
