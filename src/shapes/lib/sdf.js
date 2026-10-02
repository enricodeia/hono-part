// Signed distance helpers (negative inside). Scalar args for speed:
// every function takes plain numbers and returns a number.

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x)
export const mix = (a, b, t) => a + (b - a) * t
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export function sdSphere(x, y, z, r) {
  return Math.hypot(x, y, z) - r
}

// iq's ellipsoid bound (good near the surface, which is all sampling needs).
export function sdEllipsoid(x, y, z, rx, ry, rz) {
  const k0 = Math.hypot(x / rx, y / ry, z / rz)
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz))
  return k1 === 0 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1
}

export function sdBox(x, y, z, bx, by, bz, r = 0) {
  const qx = Math.abs(x) - bx + r
  const qy = Math.abs(y) - by + r
  const qz = Math.abs(z) - bz + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r
}

// Capsule from A to B with radius r.
export function sdCapsule(x, y, z, ax, ay, az, bx, by, bz, r) {
  const pax = x - ax, pay = y - ay, paz = z - az
  const bax = bx - ax, bay = by - ay, baz = bz - az
  const h = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0, 1)
  return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r
}

// Capsule whose radius blends from ra (at A) to rb (at B). Approximate but smooth.
export function sdTaperedCapsule(x, y, z, ax, ay, az, bx, by, bz, ra, rb) {
  const pax = x - ax, pay = y - ay, paz = z - az
  const bax = bx - ax, bay = by - ay, baz = bz - az
  const h = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0, 1)
  return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - (ra + (rb - ra) * h)
}

export function sdTorus(x, y, z, R, r) {
  const q = Math.hypot(x, z) - R
  return Math.hypot(q, y) - r
}

// Tube around a polyline [[x,y,z],...] with radius r (or r(u) function of arc fraction).
export function sdPolyline(x, y, z, pl, r) {
  let best = Infinity
  let bestU = 0
  let acc = 0
  let total = 0
  for (let i = 1; i < pl.length; i++) total += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1], pl[i][2] - pl[i - 1][2])
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i]
    const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2]
    const len2 = bax * bax + bay * bay + baz * baz || 1e-12
    const h = clamp(((x - a[0]) * bax + (y - a[1]) * bay + (z - a[2]) * baz) / len2, 0, 1)
    const d = Math.hypot(x - a[0] - bax * h, y - a[1] - bay * h, z - a[2] - baz * h)
    if (d < best) {
      best = d
      bestU = (acc + h * Math.sqrt(len2)) / (total || 1)
    }
    acc += Math.sqrt(len2)
  }
  return best - (typeof r === 'function' ? r(bestU) : r)
}

export const opUnion = (a, b) => Math.min(a, b)
export const opSubtract = (a, b) => Math.max(a, -b) // a minus b
export const opIntersect = (a, b) => Math.max(a, b)

export function opSmoothUnion(a, b, k) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1)
  return mix(b, a, h) - k * h * (1 - h)
}
export function opSmoothSubtract(a, b, k) {
  // a minus b, smoothed
  const h = clamp(0.5 - (0.5 * (a + b)) / k, 0, 1)
  return mix(a, -b, h) + k * h * (1 - h)
}
export function opSmoothIntersect(a, b, k) {
  const h = clamp(0.5 - (0.5 * (b - a)) / k, 0, 1)
  return mix(b, a, h) + k * h * (1 - h)
}

// Rotations returning a new [x, y, z] (use sparingly in hot loops).
export function rotX(x, y, z, a) {
  const c = Math.cos(a), s = Math.sin(a)
  return [x, c * y - s * z, s * y + c * z]
}
export function rotY(x, y, z, a) {
  const c = Math.cos(a), s = Math.sin(a)
  return [c * x + s * z, y, -s * x + c * z]
}
export function rotZ(x, y, z, a) {
  const c = Math.cos(a), s = Math.sin(a)
  return [c * x - s * y, s * x + c * y, z]
}

// Central-difference gradient of an sdf(x, y, z) → number. Returns unit [gx, gy, gz].
export function gradient(sdf, x, y, z, eps = 1e-3, out = [0, 0, 0]) {
  const gx = sdf(x + eps, y, z) - sdf(x - eps, y, z)
  const gy = sdf(x, y + eps, z) - sdf(x, y - eps, z)
  const gz = sdf(x, y, z + eps) - sdf(x, y, z - eps)
  const l = Math.hypot(gx, gy, gz) || 1
  out[0] = gx / l
  out[1] = gy / l
  out[2] = gz / l
  return out
}

/* ------------------------------------------------------------------ 2D ---- */

// Signed distance to a closed polygon [[x, y], ...] (negative inside, even-odd rule).
export function sdPolygon2D(x, y, poly) {
  let d = Infinity
  let inside = false
  const n = poly.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[j][0], ay = poly[j][1]
    const bx = poly[i][0], by = poly[i][1]
    const ex = bx - ax, ey = by - ay
    const wx = x - ax, wy = y - ay
    const h = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey || 1e-12), 0, 1)
    const dx = wx - ex * h, dy = wy - ey * h
    const dd = dx * dx + dy * dy
    if (dd < d) d = dd
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
  }
  return inside ? -Math.sqrt(d) : Math.sqrt(d)
}

// Precomputed 2D signed-distance grid for one or more closed polygons (union).
// Returns { sample(x, y) → bilinear distance, bounds }. Much faster than
// sdPolygon2D in hot loops (silhouette inflation with 100k+ candidates).
export function gridSDF2D(polys, { res = 256, pad = 0.1 } = {}) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const poly of polys) for (const [x, y] of poly) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  const w = maxX - minX, h = maxY - minY
  const size = Math.max(w, h) * (1 + 2 * pad)
  const ox = (minX + maxX) / 2 - size / 2
  const oy = (minY + maxY) / 2 - size / 2
  const cell = size / (res - 1)
  const grid = new Float32Array(res * res)
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = ox + i * cell
      const y = oy + j * cell
      let d = Infinity
      for (const poly of polys) d = Math.min(d, sdPolygon2D(x, y, poly))
      grid[j * res + i] = d
    }
  }
  function sample(x, y) {
    const fx = (x - ox) / cell
    const fy = (y - oy) / cell
    if (fx < 0 || fy < 0 || fx > res - 1 || fy > res - 1) {
      // outside the grid: distance to grid edge + clamp sample
      const cx = clamp(fx, 0, res - 1), cy = clamp(fy, 0, res - 1)
      return sample(ox + cx * cell, oy + cy * cell) + Math.hypot((fx - cx) * cell, (fy - cy) * cell)
    }
    const i0 = Math.min(Math.floor(fx), res - 2)
    const j0 = Math.min(Math.floor(fy), res - 2)
    const tx = fx - i0, ty = fy - j0
    const a = grid[j0 * res + i0], b = grid[j0 * res + i0 + 1]
    const c = grid[(j0 + 1) * res + i0], d = grid[(j0 + 1) * res + i0 + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
  }
  return { sample, bounds: { minX, minY, maxX, maxY }, grid, res, origin: [ox, oy], cell }
}
