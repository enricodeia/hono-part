// 01 · Triangle: the mark from reference 01. An outlined triangle with three
// bell arches stacked inside and a base line, every stroke an extruded ribbon
// (superellipse cross-section, real Z depth) with particles on its surface.
//
// Proportions were measured on reference/01-triangle.png (centre-lines traced
// from a fade-normalised density map, then un-yawed by cos 24° and corrected
// for perspective). Design units: base half-width = 1, base centre-line at
// y = 0, apex at y = APEX.
//
// Joins are a true union: a surface point that falls inside another stroke is
// dropped, coplanar faces go to the stroke with priority, the outline corners
// are mitered. So the bottom corners merge cleanly instead of piling up dots.

import { createRng } from './lib/rng.js'
import { finalizeShape, defaultSize } from './lib/sampling.js'

const APEX = 1.467 // apex height / base half-width, front (un-yawed) view

// Arch family, fitted to the three reference arches (rms ≈ 4 px on 553 px):
//   v(X) = peak(t) · exp(-|X / s|^q / q)    with t = k / (n + 1), k = 1..n
// v is height as a fraction of APEX, X is in base half-widths. peak(t)
// interpolates from the apex (t = 0) to the base (t = 1).
const peakAt = (t) => 1.014 - 1.494 * t + 0.52 * t * t
const powAt = (t) => 1.4 + 1.4 * t // bell exponent: low = pointed, high = rounded
const halfWidthAt = (t) => 0.53 + 0.15 * t // half width at half height

function archFamily(n, shape, spread, height) {
  const out = []
  const qMul = Math.pow(2, (shape - 0.5) * 2)
  for (let k = 1; k <= n; k++) {
    const t = k / (n + 1)
    const peak = Math.min(0.96, Math.max(0.03, peakAt(t) * height))
    const q = Math.max(0.7, powAt(t) * qMul)
    const hw = halfWidthAt(t) * spread
    const s = hw / Math.pow(q * Math.LN2, 1 / q)
    const v = (X) => peak * Math.exp(-Math.pow(Math.abs(X) / s, q) / q)
    // foot: first X where the bell leaves the triangle (meets the edge v = 1 - |X|)
    let lo = 0
    let hi = 1
    const steps = 240
    for (let i = 1; i <= steps; i++) {
      const x = i / steps
      if (v(x) - (1 - x) >= 0) {
        hi = x
        lo = (i - 1) / steps
        break
      }
    }
    for (let it = 0; it < 30; it++) {
      const m = (lo + hi) / 2
      if (v(m) - (1 - m) >= 0) hi = m
      else lo = m
    }
    out.push({ v, foot: (lo + hi) / 2 })
  }
  return out
}

// Superellipse cross-section |s/hw|^e + |z/hd|^e = 1, tabulated by arc length
// so a uniform pick lands uniformly on the ribbon surface.
function crossSection(hw, hd, e, n = 384) {
  const S = new Float64Array(n)
  const Z = new Float64Array(n)
  const NS = new Float64Array(n)
  const NZ = new Float64Array(n)
  const cum = new Float64Array(n + 1)
  const p = 2 / e
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const c = Math.cos(a)
    const s = Math.sin(a)
    S[i] = hw * Math.sign(c) * Math.pow(Math.abs(c), p)
    Z[i] = hd * Math.sign(s) * Math.pow(Math.abs(s), p)
    // gradient of the implicit
    const gs = (Math.sign(S[i]) * Math.pow(Math.abs(S[i]) / hw, e - 1)) / hw
    const gz = (Math.sign(Z[i]) * Math.pow(Math.abs(Z[i]) / hd, e - 1)) / hd
    const l = Math.hypot(gs, gz) || 1
    NS[i] = gs / l
    NZ[i] = gz / l
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    cum[i + 1] = cum[i] + Math.hypot(S[j] - S[i], Z[j] - Z[i])
  }
  const perimeter = cum[n]
  function pick(r, out) {
    const target = r * perimeter
    let lo = 0
    let hi = n
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid] <= target) lo = mid
      else hi = mid
    }
    const j = (lo + 1) % n
    const f = (target - cum[lo]) / (cum[lo + 1] - cum[lo] || 1)
    out.s = S[lo] + (S[j] - S[lo]) * f
    out.z = Z[lo] + (Z[j] - Z[lo]) * f
    const ns = NS[lo] + (NS[j] - NS[lo]) * f
    const nz = NZ[lo] + (NZ[j] - NZ[lo]) * f
    const l = Math.hypot(ns, nz) || 1
    out.ns = ns / l
    out.nz = nz / l
    return out
  }
  return { perimeter, pick }
}

// Narrow-band unsigned distance to a set of 2D segments, on a shared grid.
function createGrid(minX, minY, maxX, maxY, cell) {
  const nx = Math.ceil((maxX - minX) / cell) + 2
  const ny = Math.ceil((maxY - minY) / cell) + 2
  return { minX, minY, cell, nx, ny }
}

function distanceField(grid, segs, band) {
  const { minX, minY, cell, nx, ny } = grid
  const D = new Float32Array(nx * ny).fill(1e9)
  for (const [ax, ay, bx, by] of segs) {
    const ex = bx - ax
    const ey = by - ay
    const ll = ex * ex + ey * ey || 1e-12
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - band - minX) / cell))
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + band - minX) / cell))
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - band - minY) / cell))
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by) + band - minY) / cell))
    for (let j = j0; j <= j1; j++) {
      const y = minY + j * cell
      for (let i = i0; i <= i1; i++) {
        const x = minX + i * cell
        let h = ((x - ax) * ex + (y - ay) * ey) / ll
        h = h < 0 ? 0 : h > 1 ? 1 : h
        const d = Math.hypot(x - ax - ex * h, y - ay - ey * h)
        const k = j * nx + i
        if (d < D[k]) D[k] = d
      }
    }
  }
  return function sample(x, y) {
    const fx = (x - minX) / cell
    const fy = (y - minY) / cell
    const i = Math.floor(fx)
    const j = Math.floor(fy)
    if (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1) return 1e9
    const tx = fx - i
    const ty = fy - j
    const k = j * nx + i
    const a = D[k], b = D[k + 1], c = D[k + nx], d = D[k + nx + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
  }
}

// Arc-length table of a planar polyline [[x, y], ...]: position, unit tangent, signed curvature.
function curveTable(pts) {
  const n = pts.length
  const cum = new Float64Array(n)
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  const T = []
  const K = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(n - 1, i + 1)]
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    T.push([(b[0] - a[0]) / l, (b[1] - a[1]) / l])
  }
  for (let i = 1; i < n - 1; i++) {
    const ds = cum[i + 1] - cum[i - 1] || 1
    K[i] = (T[i - 1][0] * T[i + 1][1] - T[i - 1][1] * T[i + 1][0]) / ds
  }
  K[0] = K[1]
  K[n - 1] = K[n - 2]
  const length = cum[n - 1]
  function at(l, out) {
    const s = Math.min(Math.max(l, 0), length)
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid] < s) lo = mid
      else hi = mid
    }
    const f = (s - cum[lo]) / (cum[hi] - cum[lo] || 1)
    out.x = pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f
    out.y = pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f
    const tx = T[lo][0] + (T[hi][0] - T[lo][0]) * f
    const ty = T[lo][1] + (T[hi][1] - T[lo][1]) * f
    const tl = Math.hypot(tx, ty) || 1
    out.tx = tx / tl
    out.ty = ty / tl
    out.k = K[lo] + (K[hi] - K[lo]) * f
    return out
  }
  let kMax = 0
  for (let i = 0; i < n; i++) kMax = Math.max(kMax, Math.abs(K[i]))
  return { length, at, kMax }
}

export default {
  id: 'triangle',
  label: 'Triangle',
  order: 1,
  params: {
    arches: { value: 3, min: 1, max: 5, step: 1, label: 'Arches' },
    archShape: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'Arch shape' },
    archSpread: { value: 1, min: 0.6, max: 1.5, step: 0.01, label: 'Arch spread' },
    archHeight: { value: 1, min: 0.5, max: 1.25, step: 0.01, label: 'Arch height' },
    stroke: { value: 0.07, min: 0.02, max: 0.18, step: 0.001, label: 'Stroke' },
    depth: { value: 0.09, min: 0, max: 0.6, step: 0.005, label: 'Depth' },
    roundness: { value: 0.6, min: 0, max: 1, step: 0.01, label: 'Roundness' },
    base: { value: true, label: 'Base line' },
  },
  defaults: {
    particles: { size: 1.7, sizeVariance: 0.5, softness: 0.08, opacity: 0.8, opacityB: 0.8, shading: 0.25 },
    depth: { fade: 0.2, dof: 0 },
    motion: { mode: 'sway', speed: 0.18, swayAngle: 6, yaw: 12, pitch: 0, roll: 0, float: 0.12, noise: 0.08 },
    // client: the mark stays whole, no dissolve (unlike ref 01)
    dissolve: { amount: 0, mode: 'linear', angle: -10, softness: 0.7, spread: 0.45, turbulence: 0.5, fade: 0.9 },
    life: { enabled: true, amount: 0.3, rate: 0.8 },
    dust: { count: 1800, size: 0.8, opacity: 0.15, radius: 1.1, drift: 0.2 },
    scene: { glow: 0 },
    // long lens: the yaw reads as depth without the near corner ballooning (ref 01 is nearly orthographic)
    camera: { fov: 15, frame: 1, azimuth: 0, elevation: 0, offsetX: 0, offsetY: 0 },
  },

  generate(params, { seed, maxCount }) {
    const rng = createRng(seed)
    const n = Math.round(params.arches ?? 3)
    const hw = Math.max(0.005, (params.stroke ?? 0.07) / 2)
    const hd = Math.max(0.0015, (params.depth ?? 0.09) / 2)
    const round = Math.min(Math.max(params.roundness ?? 0.6, 0), 1)
    const e = 2 + 10 * Math.pow(1 - round, 1.5)
    const withBase = params.base !== false
    const cs = crossSection(hw, hd, e)

    // ── outline: BL → apex → BR (one path) + base, mitered at the corners
    const V = [
      [-1, 0],
      [0, APEX],
      [1, 0],
    ]
    const C = [0, APEX / 3] // centroid: outward normals point away from it
    const segDefs = [
      { a: 0, b: 1, stroke: 0 }, // left edge
      { a: 1, b: 2, stroke: 0 }, // right edge
    ]
    if (withBase) segDefs.push({ a: 0, b: 2, stroke: 2 })
    // the miter line at a corner runs along the bisector of the two edges leaving it
    const bisector = (dirA, dirB) => {
      const bx = dirA[0] + dirB[0]
      const by = dirA[1] + dirB[1]
      const bl = Math.hypot(bx, by) || 1
      return [bx / bl, by / bl]
    }
    const unit = (p, q) => {
      const dx = q[0] - p[0]
      const dy = q[1] - p[1]
      const l = Math.hypot(dx, dy)
      return [dx / l, dy / l]
    }
    const bis = [
      bisector(unit(V[0], V[1]), withBase ? unit(V[0], V[2]) : unit(V[0], V[1])),
      bisector(unit(V[1], V[0]), unit(V[1], V[2])),
      bisector(unit(V[2], V[1]), withBase ? unit(V[2], V[0]) : unit(V[2], V[1])),
    ]
    const segs = segDefs.map((d) => {
      const A = V[d.a]
      const B = V[d.b]
      const t = unit(A, B)
      let nx = -t[1]
      let ny = t[0]
      const mx = (A[0] + B[0]) / 2 - C[0]
      const my = (A[1] + B[1]) / 2 - C[1]
      if (nx * mx + ny * my < 0) {
        nx = -nx
        ny = -ny
      }
      const L = Math.hypot(B[0] - A[0], B[1] - A[1])
      // clip planes through each end vertex, perpendicular to the bisector's normal
      const plane = (vi, sign) => {
        const b = bis[vi]
        // the miter line direction is b; its normal c points along the segment (sign)
        let cx = -b[1]
        let cy = b[0]
        if ((cx * t[0] + cy * t[1]) * sign < 0) {
          cx = -cx
          cy = -cy
        }
        return { px: V[vi][0], py: V[vi][1], cx, cy }
      }
      const pA = plane(d.a, -1) // keep points with dot(P - A, c) <= 0  (c points back past A)
      const pB = plane(d.b, 1) // keep dot(P - B, c) <= 0                (c points forward past B)
      // free ends (no base): a flat cut at the vertex instead of a miter
      const free = (vi) => !withBase && vi !== 1
      // longest miter overhang along the segment
      const over = (vi) => {
        if (free(vi)) return 0
        const b = bis[vi]
        const sin = Math.abs(b[0] * t[1] - b[1] * t[0]) || 1e-3
        const cos = Math.abs(b[0] * t[0] + b[1] * t[1])
        return (hw * cos) / sin + 1e-4
      }
      return { A, B, t, n: [nx, ny], L, pA, pB, oA: over(d.a), oB: over(d.b), freeA: free(d.a), freeB: free(d.b), stroke: d.stroke, a: d.a, b: d.b }
    })

    // ── arches
    const family = archFamily(n, params.archShape ?? 0.5, params.archSpread ?? 1, params.archHeight ?? 1)
    const arches = family.map(({ v, foot }) => {
      const pts = []
      const m = 260
      for (let i = 0; i <= m; i++) {
        // ease the parameter so the steep feet get as many vertices as the crown
        const u = i / m
        const X = -foot + 2 * foot * (0.5 - 0.5 * Math.cos(Math.PI * u))
        pts.push([X, v(X) * APEX])
      }
      return curveTable(pts)
    })

    // ── union bookkeeping: one distance field per solid (outline = 0, arch k = k + 1)
    const pad = hw * 3 + 0.05
    const grid = createGrid(-1 - pad - 0.3, -pad, 1 + pad + 0.3, APEX + pad + 0.2, Math.max(0.004, hw / 6))
    const band = hw * 1.6 + grid.cell * 3
    const outlineSegs = [
      [V[0][0], V[0][1], V[1][0], V[1][1]],
      [V[1][0], V[1][1], V[2][0], V[2][1]],
    ]
    if (withBase) outlineSegs.push([V[0][0], V[0][1], V[2][0], V[2][1]])
    const fields = [distanceField(grid, outlineSegs, band)]
    for (const arc of arches) {
      const s = []
      const p = {}
      const q = {}
      const steps = Math.max(80, Math.ceil(arc.length / (grid.cell * 2)))
      arc.at(0, p)
      for (let i = 1; i <= steps; i++) {
        arc.at((i / steps) * arc.length, q)
        s.push([p.x, p.y, q.x, q.y])
        p.x = q.x
        p.y = q.y
      }
      fields.push(distanceField(grid, s, band))
    }
    const solids = fields.length
    // inside the union of other solids? lower index wins on shared (coplanar) faces
    const hidden = (x, y, z, own) => {
      const zz = Math.pow(Math.min(Math.abs(z) / hd, 1), e)
      for (let j = 0; j < solids; j++) {
        if (j === own) continue
        const d = fields[j](x, y)
        if (d >= hw) continue
        const f = Math.pow(d / hw, e) + zz
        if (f < (j < own ? 1.02 : 0.985)) return true
      }
      return false
    }

    // ── sample
    const strokes = []
    for (const sg of segs) strokes.push({ kind: 'seg', sg, length: sg.L + sg.oA + sg.oB, solid: 0 })
    arches.forEach((arc, k) => strokes.push({ kind: 'arc', arc, length: arc.length, solid: k + 1, k }))
    const total = strokes.reduce((a, s) => a + s.length, 0)
    const cdf = []
    let acc = 0
    for (const s of strokes) {
      acc += s.length / total
      cdf.push(acc)
    }
    // aux offsets: outline 0, arch k 0.15·k, base after the last arch
    const auxOffset = (st) => (st.kind === 'arc' ? 0.15 * (st.k + 1) : st.sg.stroke === 2 ? 0.15 * (n + 1) : 0)

    const positions = []
    const normals = []
    const group = []
    const size = []
    const aux = []
    const c = {}
    const P = {}
    let guard = maxCount * 40
    while (group.length < maxCount && guard-- > 0) {
      const r = rng.next()
      let si = 0
      while (si < cdf.length - 1 && r > cdf[si]) si++
      const st = strokes[si]
      cs.pick(rng.next(), c)
      let x, y, nx, ny, u
      if (st.kind === 'seg') {
        const sg = st.sg
        const l = -sg.oA + rng.next() * st.length
        x = sg.A[0] + sg.t[0] * l + sg.n[0] * c.s
        y = sg.A[1] + sg.t[1] * l + sg.n[1] * c.s
        // miter (or flat cut at a free end)
        if (sg.freeA ? l < 0 : (x - sg.pA.px) * sg.pA.cx + (y - sg.pA.py) * sg.pA.cy > 0) continue
        if (sg.freeB ? l > sg.L : (x - sg.pB.px) * sg.pB.cx + (y - sg.pB.py) * sg.pB.cy > 0) continue
        nx = sg.n[0] * c.ns
        ny = sg.n[1] * c.ns
        const f = Math.min(Math.max(l / sg.L, 0), 1)
        if (sg.stroke === 2) u = f
        else u = sg.a === 0 ? f * 0.5 : 0.5 + f * 0.5 // BL → apex → BR as one path
      } else {
        const arc = st.arc
        const l = rng.next() * arc.length
        arc.at(l, P)
        // left normal; area element shrinks on the inside of a bend
        const Nx = -P.ty
        const Ny = P.tx
        const jac = 1 - P.k * c.s
        if (rng.next() * (1 + Math.min(arc.kMax * hw, 1.5)) > jac) continue
        x = P.x + Nx * c.s
        y = P.y + Ny * c.s
        nx = Nx * c.ns
        ny = Ny * c.ns
        u = l / arc.length
      }
      const z = c.z
      if (hidden(x, y, z, st.solid)) continue
      const nz = c.nz
      const nl = Math.hypot(nx, ny, nz) || 1
      positions.push(x, y, z)
      normals.push(nx / nl, ny / nl, nz / nl)
      group.push(st.kind === 'arc' ? 1 : 0)
      size.push(defaultSize(rng, 0.34))
      aux.push(u + auxOffset(st))
    }
    // pathological params (everything hidden): pad with outline points rather than fail
    while (group.length < maxCount) {
      const i = rng.int(Math.max(1, group.length)) * 3
      positions.push(positions[i] ?? 0, positions[i + 1] ?? 0, positions[i + 2] ?? 0)
      normals.push(0, 0, 1)
      group.push(0)
      size.push(defaultSize(rng, 0.34))
      aux.push(0)
    }

    return finalizeShape(
      { positions, normal: normals, group, size, aux },
      {
        seed,
        maxCount,
        meta: {
          id: 'triangle',
          label: 'Triangle',
          life: 'wave',
          axis: [0, 1, 0],
          center: [0, APEX / 3, 0],
          frame: { h: 0.52 },
          groups: ['Outline', 'Arches'],
          aux: 'arc length along each stroke, 0..1 left to right, plus 0.15 per stroke (outline 0, arches 0.15·k, base last) so a wave cascades down the mark',
        },
      },
    )
  },
}
