// 01 · HONE wordmark (replaces the triangle mark). The four letters of the
// client SVG extruded into a real solid: stratified dots on the front and back
// faces, the extrusion walls, and tighter rims along every contour so the
// letterforms stay crisp down to 1000 particles. Front view = the logo as drawn.

import { createRng } from './lib/rng.js'
import { finalizeShape, defaultSize } from './lib/sampling.js'
import { flattenPath, insideRings } from './lib/svgPath.js'
import { HONE_PATHS, HONE_VIEWBOX } from './data/hone-logo.js'

let ringsCache = null
function rings() {
  if (!ringsCache) ringsCache = HONE_PATHS.flatMap((d) => flattenPath(d, { tolerance: 0.8 }))
  return ringsCache
}

// Contour segments with outward normals (SVG units, y down).
function contour(rs) {
  const segs = []
  let total = 0
  for (const r of rs) {
    for (let a = 0; a < r.length; a++) {
      const p = r[a], q = r[(a + 1) % r.length]
      const dx = q[0] - p[0], dy = q[1] - p[1]
      const len = Math.hypot(dx, dy)
      if (len < 1e-6) continue
      let nx = dy / len, ny = -dx / len
      const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2
      if (insideRings(mx + nx * 0.6, my + ny * 0.6, rs)) { nx = -nx; ny = -ny }
      segs.push({ x: p[0], y: p[1], dx, dy, len, nx, ny, s0: total })
      total += len
    }
  }
  return { segs, total }
}

function pointOnContour(c, s) {
  let lo = 0, hi = c.segs.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (c.segs[mid].s0 <= s) lo = mid
    else hi = mid - 1
  }
  const g = c.segs[lo]
  const t = Math.min(Math.max((s - g.s0) / g.len, 0), 1)
  return { x: g.x + g.dx * t, y: g.y + g.dy * t, nx: g.nx, ny: g.ny }
}

export default {
  id: 'hone',
  label: 'Hone',
  order: 1,
  params: {
    depth: { value: 0.2, min: 0, max: 0.8, step: 0.01, label: 'Depth' },
    edges: { value: 0.4, min: 0.05, max: 0.9, step: 0.01, label: 'Contour share' },
    rim: { value: 0.55, min: 0, max: 1, step: 0.01, label: 'Rim vs wall' },
    backFace: { value: 0.65, min: 0, max: 1, step: 0.01, label: 'Back face' },
    jitter: { value: 0.75, min: 0, max: 1, step: 0.01, label: 'Jitter' },
    contourPriority: { value: 4, min: 1, max: 12, step: 0.1, label: 'Contour priority' },
  },
  defaults: {
    particles: { size: 1.7, sizeVariance: 0.5, shading: 0.25 },
    depth: { fade: 0.5 },
    motion: { mode: 'sway', yaw: -16, pitch: 4, swayAngle: 12, speed: 0.22, float: 0.2 },
    dissolve: { amount: 0.22, mode: 'linear', angle: -12, softness: 0.4, spread: 0.7, turbulence: 0.5, fade: 0.85 },
    life: { amount: 0.3, rate: 1 },
    dust: { count: 1800, opacity: 0.2 },
  },

  generate(params, { seed, maxCount }) {
    const rng = createRng(seed)
    const rs = rings()
    const [, , W, H] = HONE_VIEWBOX
    const D = params.depth * H
    const c = contour(rs)

    const nContour = Math.round(maxCount * params.edges)
    const nRim = D > 0 ? Math.round(nContour * params.rim) : nContour
    const nWall = nContour - nRim
    const nFaces = maxCount - nContour
    const backShare = D > 0 ? params.backFace / (1 + params.backFace) : 0
    const nBack = Math.round(nFaces * backShare)
    const nFront = nFaces - nBack

    const P = []
    const N = []
    const S = []
    const A = []
    const R = []
    let prio = 1
    const add = (x, y, z, nx, ny, nz, size) => {
      // SVG y-down → y-up
      P.push(x, -y, z)
      N.push(nx, -ny, nz)
      S.push(size)
      A.push(x / W)
      R.push(prio)
    }

    // faces: jittered grid inside the letters, topped up by rejection sampling
    const faceArea = (() => {
      let hit = 0
      const probe = createRng(seed ^ 0xa11ce)
      for (let k = 0; k < 20000; k++) if (insideRings(probe.next() * W, probe.next() * H, rs)) hit++
      return (hit / 20000) * W * H
    })()
    const sampleFace = (n, z, nz) => {
      if (n <= 0) return
      const cell = Math.sqrt(faceArea / n)
      const pts = []
      for (let gy = cell / 2; gy < H; gy += cell) {
        for (let gx = cell / 2; gx < W; gx += cell) {
          const x = gx + (rng.next() - 0.5) * cell * params.jitter
          const y = gy + (rng.next() - 0.5) * cell * params.jitter
          if (insideRings(x, y, rs)) pts.push([x, y])
        }
      }
      rng.shuffle(pts)
      while (pts.length < n) {
        const x = rng.next() * W, y = rng.next() * H
        if (insideRings(x, y, rs)) pts.push([x, y])
      }
      for (let k = 0; k < n; k++) add(pts[k][0], pts[k][1], z, 0, 0, nz, defaultSize(rng))
    }
    prio = 1
    sampleFace(nFront, D / 2, 1)
    prio = 0.6
    sampleFace(nBack, -D / 2, -1)

    // rims: stratified along the contour, a hair inside the face edge
    const rimFront = Math.round(nRim * (D > 0 ? 1 / (1 + params.backFace) : 1))
    const rimBack = nRim - rimFront
    const sampleRim = (n, z, nz) => {
      for (let k = 0; k < n; k++) {
        const s = ((k + 0.5 + (rng.next() - 0.5) * params.jitter) / n) * c.total
        const p = pointOnContour(c, s)
        const inset = rng.next() * 2.2
        const zz = z - nz * rng.next() * Math.min(D * 0.08, 3)
        const l = Math.hypot(p.nx, p.ny, nz) || 1
        add(p.x - p.nx * inset, p.y - p.ny * inset, zz, p.nx / l, p.ny / l, nz / l, defaultSize(rng, 0.3) * 0.85)
      }
    }
    // contours win the sparse prefixes so 1000 dots still spell HONE
    prio = params.contourPriority
    sampleRim(rimFront, D / 2, 1)
    prio = params.contourPriority * 0.7
    sampleRim(rimBack, -D / 2, -1)
    prio = 1.4

    // walls: jittered grid in (arc length × depth)
    if (nWall > 0) {
      const rows = Math.max(1, Math.round(Math.sqrt((nWall * D) / c.total)))
      const perRow = Math.ceil(nWall / rows)
      let made = 0
      for (let r = 0; r < rows && made < nWall; r++) {
        for (let k = 0; k < perRow && made < nWall; k++) {
          const s = ((k + 0.5 + (rng.next() - 0.5) * params.jitter) / perRow) * c.total
          const z = ((r + 0.5 + (rng.next() - 0.5) * params.jitter) / rows - 0.5) * D
          const p = pointOnContour(c, s)
          add(p.x, p.y, z, p.nx, p.ny, 0, defaultSize(rng))
          made++
        }
      }
    }

    return finalizeShape(
      { positions: P, normal: N, size: S, aux: A, priority: R },
      {
        seed,
        maxCount,
        meta: {
          id: 'hone',
          label: 'Hone',
          life: 'wave',
          axis: [1, 0, 0],
          frame: { w: 0.56 },
          groups: ['Logo'],
          aux: 'x across the wordmark, 0 (H) → 1 (E)',
        },
      },
    )
  },
}
