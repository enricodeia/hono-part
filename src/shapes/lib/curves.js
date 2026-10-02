// Polyline / spline helpers. Points are plain [x, y, z] arrays (z optional → 0).

const v3 = (p) => [p[0], p[1], p[2] || 0]

// Centripetal Catmull-Rom through `points`; `samples` points per span.
export function catmullRom(points, samples = 24, closed = false, alpha = 0.5) {
  const pts = points.map(v3)
  if (pts.length < 2) return pts
  const out = []
  const n = pts.length
  const get = (i) => {
    if (closed) return pts[((i % n) + n) % n]
    if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1], 2 * pts[0][2] - pts[1][2]]
    if (i >= n) {
      const a = pts[n - 1]
      const b = pts[n - 2]
      return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]]
    }
    return pts[i]
  }
  const spans = closed ? n : n - 1
  const tj = (ti, a, b) => {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    return ti + Math.max(Math.pow(d, alpha), 1e-6)
  }
  for (let s = 0; s < spans; s++) {
    const p0 = get(s - 1), p1 = get(s), p2 = get(s + 1), p3 = get(s + 2)
    const t0 = 0
    const t1 = tj(t0, p0, p1)
    const t2 = tj(t1, p1, p2)
    const t3 = tj(t2, p2, p3)
    const last = !closed && s === spans - 1
    const count = last ? samples + 1 : samples
    for (let k = 0; k < count; k++) {
      const t = t1 + ((t2 - t1) * k) / samples
      const p = [0, 0, 0]
      for (let c = 0; c < 3; c++) {
        const a1 = ((t1 - t) / (t1 - t0)) * p0[c] + ((t - t0) / (t1 - t0)) * p1[c]
        const a2 = ((t2 - t) / (t2 - t1)) * p1[c] + ((t - t1) / (t2 - t1)) * p2[c]
        const a3 = ((t3 - t) / (t3 - t2)) * p2[c] + ((t - t2) / (t3 - t2)) * p3[c]
        const b1 = ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2
        const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3
        p[c] = ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2
      }
      out.push(p)
    }
  }
  if (closed) out.push(out[0].slice())
  return out
}

// Cubic Bezier sampled into `n` + 1 points.
export function bezier(p0, p1, p2, p3, n = 32) {
  const a = v3(p0), b = v3(p1), c = v3(p2), d = v3(p3)
  const out = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t
    out.push([
      w0 * a[0] + w1 * b[0] + w2 * c[0] + w3 * d[0],
      w0 * a[1] + w1 * b[1] + w2 * c[1] + w3 * d[1],
      w0 * a[2] + w1 * b[2] + w2 * c[2] + w3 * d[2],
    ])
  }
  return out
}

export function polylineLength(pl) {
  let L = 0
  for (let i = 1; i < pl.length; i++) {
    L += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1], (pl[i][2] || 0) - (pl[i - 1][2] || 0))
  }
  return L
}

// Arc-length parameterised path. at(u) with u in [0,1] → { p, t } (point, unit tangent).
export function createPath(polyline) {
  const pl = polyline.map(v3)
  const n = pl.length
  const cum = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1], pl[i][2] - pl[i - 1][2])
  }
  const length = cum[n - 1]
  function at(u) {
    const s = Math.min(Math.max(u, 0), 1) * length
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid] < s) lo = mid
      else hi = mid
    }
    const seg = cum[hi] - cum[lo] || 1
    const f = (s - cum[lo]) / seg
    const a = pl[lo], b = pl[hi]
    const tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2]
    const tl = Math.hypot(tx, ty, tz) || 1
    return {
      p: [a[0] + tx * f, a[1] + ty * f, a[2] + tz * f],
      t: [tx / tl, ty / tl, tz / tl],
    }
  }
  return { points: pl, length, cumulative: cum, at }
}

// Evenly re-spaced copy of a polyline with `n` points.
export function resample(polyline, n) {
  const path = createPath(polyline)
  const out = []
  for (let i = 0; i < n; i++) out.push(path.at(i / (n - 1)).p)
  return out
}

// Parallel-transport frames along a polyline: [{ T, N, B }] per vertex (no twist flips).
export function transportFrames(polyline) {
  const pl = polyline.map(v3)
  const n = pl.length
  const T = []
  for (let i = 0; i < n; i++) {
    const a = pl[Math.max(i - 1, 0)]
    const b = pl[Math.min(i + 1, n - 1)]
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const l = Math.hypot(d[0], d[1], d[2]) || 1
    T.push([d[0] / l, d[1] / l, d[2] / l])
  }
  // initial normal: any vector not parallel to T0
  const t0 = T[0]
  let ref = Math.abs(t0[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  let N = cross(cross(t0, ref), t0)
  N = norm(N)
  const frames = []
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      // rotate previous N by the rotation taking T[i-1] to T[i]
      const axis = cross(T[i - 1], T[i])
      const s = Math.hypot(axis[0], axis[1], axis[2])
      if (s > 1e-8) {
        const c = dot(T[i - 1], T[i])
        const ang = Math.atan2(s, c)
        N = rotateAxis(N, norm(axis), ang)
      }
      // re-orthogonalise
      N = norm(sub(N, scale(T[i], dot(N, T[i]))))
    }
    const B = cross(T[i], N)
    frames.push({ T: T[i], N: N.slice(), B })
  }
  return frames
}

export function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
export function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
export function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
export function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
export function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s] }
export function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
export function rotateAxis(v, k, a) {
  // Rodrigues
  const c = Math.cos(a), s = Math.sin(a)
  const kxv = cross(k, v)
  const kdv = dot(k, v)
  return [
    v[0] * c + kxv[0] * s + k[0] * kdv * (1 - c),
    v[1] * c + kxv[1] * s + k[1] * kdv * (1 - c),
    v[2] * c + kxv[2] * s + k[2] * kdv * (1 - c),
  ]
}
