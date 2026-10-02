// Point sampling + the ShapeData contract.
//
// Every shape generator ends with finalizeShape(), which:
//   1. normalises the cloud (centre at bbox centre, largest extent = `fit`),
//   2. orders points PROGRESSIVELY (blue-noise prefixes, group proportions kept),
//      so the first k points are a good specimen for any k in [1000, 8000],
//   3. returns the frozen ShapeData object the runtime consumes.

import { createRng } from './rng.js'
import { createPath, transportFrames, resample } from './curves.js'
import { gradient } from './sdf.js'

export const MAX_COUNT = 8000

/* --------------------------------------------------------- tube / ribbon -- */

// Samples `n` points on (or in) a tube that follows `polyline`.
// opts:
//   radius      number | (u) => number   tube radius (u = arc fraction 0..1)
//   profile     'round' | 'ribbon'        ribbon = rounded-rect cross-section (width × depth)
//   width,depth ribbon half-extents along the frame N / B axes
//   shell       0..1  fraction of points on the surface (rest fill the volume)
//   jitter      gaussian noise (world units) added to every point
//   uRange      [u0, u1] restrict sampling to part of the path
// returns { positions: number[], normals: number[], u: number[] }
export function sampleTube(polyline, n, rng, opts = {}) {
  const {
    radius = 0.02,
    profile = 'round',
    width = 0.03,
    depth = 0.03,
    shell = 1,
    jitter = 0,
    uRange = [0, 1],
    steps = 400,
  } = opts
  const pl = resample(polyline, steps)
  const path = createPath(pl)
  const frames = transportFrames(pl)
  const rAt = typeof radius === 'function' ? radius : () => radius
  // importance by circumference so a tapering tube keeps even density
  const cdf = new Float64Array(steps)
  let acc = 0
  for (let i = 0; i < steps; i++) {
    const u = i / (steps - 1)
    const inRange = u >= uRange[0] && u <= uRange[1]
    const w = !inRange ? 0 : profile === 'ribbon' ? 1 : Math.max(rAt(u), 1e-5)
    acc += w
    cdf[i] = acc
  }
  const positions = []
  const normals = []
  const us = []
  for (let k = 0; k < n; k++) {
    // pick a segment by circumference weight
    const r0 = rng.next() * acc
    let lo = 0, hi = steps - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cdf[mid] < r0) lo = mid + 1
      else hi = mid
    }
    const u = Math.min(Math.max((lo + rng.next() - 0.5) / (steps - 1), uRange[0]), uRange[1])
    const { p } = path.at(u)
    const f = frames[Math.min(Math.round(u * (steps - 1)), steps - 1)]
    const onShell = rng.next() < shell
    let ox, oy, nx, ny
    if (profile === 'ribbon') {
      // rounded rectangle perimeter: pick a point uniformly on the 4 sides
      const per = 2 * (width + depth)
      let s = rng.next() * per
      if (s < width) { ox = s - width / 2; oy = depth / 2; nx = 0; ny = 1 }
      else if ((s -= width) < depth) { ox = width / 2; oy = s - depth / 2; nx = 1; ny = 0 }
      else if ((s -= depth) < width) { ox = width / 2 - s; oy = -depth / 2; nx = 0; ny = -1 }
      else { s -= width; ox = -width / 2; oy = depth / 2 - s; nx = -1; ny = 0 }
      if (!onShell) { ox *= rng.next(); oy *= rng.next() }
    } else {
      const a = rng.next() * Math.PI * 2
      const r = rAt(u) * (onShell ? 1 : Math.sqrt(rng.next()))
      nx = Math.cos(a)
      ny = Math.sin(a)
      ox = nx * r
      oy = ny * r
    }
    positions.push(
      p[0] + f.N[0] * ox + f.B[0] * oy + (jitter ? rng.normal() * jitter : 0),
      p[1] + f.N[1] * ox + f.B[1] * oy + (jitter ? rng.normal() * jitter : 0),
      p[2] + f.N[2] * ox + f.B[2] * oy + (jitter ? rng.normal() * jitter : 0),
    )
    normals.push(f.N[0] * nx + f.B[0] * ny, f.N[1] * nx + f.B[1] * ny, f.N[2] * nx + f.B[2] * ny)
    us.push(u)
  }
  return { positions, normals, u: us }
}

/* ------------------------------------------------------------------ SDF --- */

// Samples `n` points from an implicit sdf(x, y, z) inside `bounds` {min:[..], max:[..]}.
// opts:
//   mode     'surface' (projected onto the zero set) | 'volume' (inside) | 'shell'
//   shell    band half-width used for rejection (world units)
//   density  optional (x, y, z, nx, ny, nz) => [0..1] acceptance probability
//            (use it for sulci lines, gradients, sparse regions …)
//   maxTries safety cap on candidates
// returns { positions: number[], normals: number[], count }
export function sampleSDF(sdf, bounds, n, rng, opts = {}) {
  const { mode = 'surface', shell = 0.02, density = null, maxTries = n * 4000, eps = 1e-3 } = opts
  const [x0, y0, z0] = bounds.min
  const [x1, y1, z1] = bounds.max
  const positions = []
  const normals = []
  const g = [0, 0, 0]
  let tries = 0
  let count = 0
  while (count < n && tries < maxTries) {
    tries++
    let x = x0 + (x1 - x0) * rng.next()
    let y = y0 + (y1 - y0) * rng.next()
    let z = z0 + (z1 - z0) * rng.next()
    let d = sdf(x, y, z)
    if (mode === 'volume') {
      if (d > 0) continue
      gradient(sdf, x, y, z, eps, g)
    } else {
      if (Math.abs(d) > shell) continue
      gradient(sdf, x, y, z, eps, g)
      if (mode === 'surface') {
        // two Newton steps onto the zero set
        for (let it = 0; it < 2; it++) {
          x -= g[0] * d
          y -= g[1] * d
          z -= g[2] * d
          d = sdf(x, y, z)
          gradient(sdf, x, y, z, eps, g)
        }
        if (Math.abs(d) > shell * 0.5) continue
      }
    }
    if (density && rng.next() > density(x, y, z, g[0], g[1], g[2])) continue
    positions.push(x, y, z)
    normals.push(g[0], g[1], g[2])
    count++
  }
  if (count < n) {
    console.warn(`[sampleSDF] only ${count}/${n} points after ${tries} tries; widen shell or bounds`)
  }
  return { positions, normals, count }
}

/* ---------------------------------------------------- progressive order --- */

// Weighted random permutation (Efraimidis-Spirakis): heavier items tend to come first.
function weightedShuffle(indices, w, rng) {
  const keyed = indices.map((i) => [Math.log(Math.max(rng.next(), 1e-12)) / Math.max(w[i], 1e-6), i])
  keyed.sort((a, b) => b[0] - a[0])
  return keyed.map((k) => k[1])
}

// Blue-noise-prefix ordering of the given indices (dart throwing with a
// shrinking radius). Optional `priority` (per point, > 0) biases which points
// win the early, sparse slots, e.g. contours over fills. Returns a new array.
function blueOrder(indices, P, rng, priority = null) {
  const m = indices.length
  const cand = priority ? weightedShuffle(indices, priority, rng) : rng.shuffle(indices.slice())
  if (m < 4) return cand
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const i of cand) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1
  const used = new Uint8Array(m)
  const out = []
  let r = diag / 6
  while (out.length < m * 0.92 && r > diag * 1e-4) {
    const inv = 1 / r
    const grid = new Map()
    const key = (ix, iy, iz) => ix * 73856093 + iy * 19349663 + iz * 83492791
    const insert = (li) => {
      const i = cand[li]
      const k = key(Math.floor(P[i * 3] * inv), Math.floor(P[i * 3 + 1] * inv), Math.floor(P[i * 3 + 2] * inv))
      const b = grid.get(k)
      if (b) b.push(i)
      else grid.set(k, [i])
    }
    for (let li = 0; li < m; li++) if (used[li]) insert(li)
    const r2 = r * r
    for (let li = 0; li < m; li++) {
      if (used[li]) continue
      const i = cand[li]
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]
      const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv)
      let ok = true
      for (let dx = -1; dx <= 1 && ok; dx++) {
        for (let dy = -1; dy <= 1 && ok; dy++) {
          for (let dz = -1; dz <= 1 && ok; dz++) {
            const b = grid.get(key(cx + dx, cy + dy, cz + dz))
            if (!b) continue
            for (let q = 0; q < b.length; q++) {
              const j = b[q]
              const ex = P[j * 3] - x, ey = P[j * 3 + 1] - y, ez = P[j * 3 + 2] - z
              if (ex * ex + ey * ey + ez * ez < r2) { ok = false; break }
            }
          }
        }
      }
      if (ok) {
        used[li] = 1
        out.push(i)
        insert(li)
      }
    }
    r *= 0.78
  }
  for (let li = 0; li < m; li++) if (!used[li]) out.push(cand[li])
  return out
}

// Ordering for the whole cloud: blue-noise per group, then interleaved so every
// prefix keeps the groups' proportions (largest-deficit first).
export function progressiveOrder(P, n, rng, group = null, priority = null) {
  if (!group) return Uint32Array.from(blueOrder(Array.from({ length: n }, (_, i) => i), P, rng, priority))
  const buckets = new Map()
  for (let i = 0; i < n; i++) {
    const g = group[i]
    if (!buckets.has(g)) buckets.set(g, [])
    buckets.get(g).push(i)
  }
  const lists = [...buckets.keys()].sort((a, b) => a - b).map((g) => blueOrder(buckets.get(g), P, rng, priority))
  const totals = lists.map((l) => l.length)
  const taken = lists.map(() => 0)
  const order = new Uint32Array(n)
  for (let k = 0; k < n; k++) {
    let best = -1
    let bestDef = -Infinity
    for (let g = 0; g < lists.length; g++) {
      if (taken[g] >= totals[g]) continue
      const def = (totals[g] / n) * (k + 1) - taken[g]
      if (def > bestDef) { bestDef = def; best = g }
    }
    order[k] = lists[best][taken[best]++]
  }
  return order
}

/* ------------------------------------------------------------ finalize --- */

// Default per-particle size multiplier: log-normal around 1, clamped. Gives
// the mix of fine dust and a few fatter dots seen in the references.
export function defaultSize(rng, spread = 0.38) {
  return Math.min(Math.max(Math.exp(rng.normal() * spread - (spread * spread) / 2), 0.35), 2.6)
}

/**
 * Turns raw arrays into a ShapeData (see SPEC.md).
 *
 * @param {object} raw
 *   positions  number[] | Float32Array  (≥ maxCount * 3)
 *   group?     number[] | Uint8Array    0 = primary, 1 = secondary, 2 = accent
 *   size?      number[] | Float32Array  relative size multiplier (mean ≈ 1)
 *   normal?    number[] | Float32Array  unit normals (radial from centre if absent)
 *   aux?       number[] | Float32Array  shape-specific scalar, documented in meta.aux
 *   priority?  number[] | Float32Array  ordering weight (> 0, default 1): higher = more
 *                                       likely in small prefixes (contours of a logo)
 * @param {object} opts
 *   seed, maxCount (8000), fit (largest extent after normalisation, 2),
 *   center (true), meta (merged into ShapeData.meta)
 */
export function finalizeShape(raw, opts = {}) {
  const { seed = 1, maxCount = MAX_COUNT, fit = 2, center = true, meta = {} } = opts
  const rng = createRng(seed ^ 0x51ed27)
  const total = Math.floor(raw.positions.length / 3)
  if (total < maxCount) {
    throw new Error(`[finalizeShape] ${meta.id || 'shape'}: got ${total} points, need ${maxCount}`)
  }
  // if over-sampled, keep a random maxCount subset (proportions preserved statistically)
  let pick = null
  if (total > maxCount) {
    pick = rng.shuffle(Array.from({ length: total }, (_, i) => i)).slice(0, maxCount)
  }
  const N = maxCount
  const src = (arr, i, k = 1, c = 0) => arr[(pick ? pick[i] : i) * k + c]
  const P = new Float32Array(N * 3)
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) P[i * 3 + c] = src(raw.positions, i, 3, c)

  // normalise
  let min = [Infinity, Infinity, Infinity]
  let max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) {
    const v = P[i * 3 + c]
    if (v < min[c]) min[c] = v
    if (v > max[c]) max[c] = v
  }
  const ext = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1
  const s = fit / ext
  const cx = center ? (min[0] + max[0]) / 2 : 0
  const cy = center ? (min[1] + max[1]) / 2 : 0
  const cz = center ? (min[2] + max[2]) / 2 : 0
  for (let i = 0; i < N; i++) {
    P[i * 3] = (P[i * 3] - cx) * s
    P[i * 3 + 1] = (P[i * 3 + 1] - cy) * s
    P[i * 3 + 2] = (P[i * 3 + 2] - cz) * s
  }
  min = [(min[0] - cx) * s, (min[1] - cy) * s, (min[2] - cz) * s]
  max = [(max[0] - cx) * s, (max[1] - cy) * s, (max[2] - cz) * s]

  const G = new Uint8Array(N)
  if (raw.group) for (let i = 0; i < N; i++) G[i] = src(raw.group, i)
  const S = new Float32Array(N)
  if (raw.size) for (let i = 0; i < N; i++) S[i] = src(raw.size, i)
  else for (let i = 0; i < N; i++) S[i] = defaultSize(rng)
  const A = new Float32Array(N)
  if (raw.aux) for (let i = 0; i < N; i++) A[i] = src(raw.aux, i)
  const Nr = new Float32Array(N * 3)
  if (raw.normal) {
    for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) Nr[i * 3 + c] = src(raw.normal, i, 3, c)
  } else {
    for (let i = 0; i < N; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]
      const l = Math.hypot(x, y, z) || 1
      Nr[i * 3] = x / l
      Nr[i * 3 + 1] = y / l
      Nr[i * 3 + 2] = z / l
    }
  }

  let W = null
  if (raw.priority) {
    W = new Float32Array(N)
    for (let i = 0; i < N; i++) W[i] = src(raw.priority, i)
  }

  // progressive order + permute every attribute
  const order = progressiveOrder(P, N, rng, raw.group ? G : null, W)
  const positions = new Float32Array(N * 3)
  const normal = new Float32Array(N * 3)
  const group = new Uint8Array(N)
  const size = new Float32Array(N)
  const aux = new Float32Array(N)
  for (let k = 0; k < N; k++) {
    const i = order[k]
    for (let c = 0; c < 3; c++) {
      positions[k * 3 + c] = P[i * 3 + c]
      normal[k * 3 + c] = Nr[i * 3 + c]
    }
    group[k] = G[i]
    size[k] = S[i]
    aux[k] = A[i]
  }
  let radius = 0
  for (let k = 0; k < N; k++) {
    radius = Math.max(radius, Math.hypot(positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]))
  }

  const outMeta = {
    id: 'shape',
    label: 'Shape',
    life: 'none',
    axis: [0, 1, 0],
    frame: { h: 0.6 },
    groups: ['Primary'],
    aux: 'unused',
    ...meta,
    // meta.center is given in RAW (pre-normalisation) coordinates; mapped here
    center: meta.center
      ? [(meta.center[0] - cx) * s, (meta.center[1] - cy) * s, (meta.center[2] - cz) * s]
      : [0, 0, 0],
    // where the original units ended up (see toNormalized)
    transform: { offset: [cx, cy, cz], scale: s },
  }

  return {
    count: N,
    positions,
    normal,
    group,
    size,
    aux,
    bounds: { min, max, radius },
    meta: outMeta,
  }
}

// Helper: map a point given in a shape's raw (pre-finalize) coordinates into
// the normalised space of a finished ShapeData.
export function toNormalized(shape, p) {
  const { offset, scale } = shape.meta.transform
  return [(p[0] - offset[0]) * scale, (p[1] - offset[1]) * scale, (p[2] - offset[2]) * scale]
}
