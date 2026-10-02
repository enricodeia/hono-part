// Reference 03: anatomical heart, anterior view (apex down, slightly left).
//
// Body: the traced front outline is inflated with a Poisson "balloon"
// (∇²h = -1 inside, half-depth ∝ √h, so an ellipse inflates to an exact
// ellipsoid, no medial-axis creases). Its mid-plane is tilted so the apex leans
// towards the viewer and the base sits back, as in the chest. Auricles are
// small lobes smooth-unioned on top.
// Great vessels: true 3D tubes with open cut ends (no caps, thin rim + a hint
// of lumen): SVC, aortic arch with its three branches, pulmonary trunk,
// pulmonary veins, IVC. They match the reference stubs from the front and read
// as real anatomy when the piece sways or is orbited.
// Surface: coronary (AV) and interventricular grooves are implicit surfaces
// cutting the body; the coronary arteries run in them as finer, denser lines.

import { createRng } from './lib/rng.js'
import { finalizeShape, defaultSize } from './lib/sampling.js'
import { sdPolygon2D, opSmoothUnion, smoothstep, clamp } from './lib/sdf.js'
import { catmullRom } from './lib/curves.js'
import { createNoise3D, fbm3 } from './lib/noise.js'
import { BODY_OUTLINE, PX } from './data/heart-outline.js'

const S = PX.s
const P = (px, py, pz = 0) => [(px - PX.cx) / S, (PX.cy - py) / S, pz / S]

// Vessel centrelines in reference px (x right, y down, z towards the viewer;
// the body mid-plane is z = 0, its front surface sits around z ≈ +190).
// Each path starts buried in the body and ends at the open cut.
const VESSELS = [
  // superior vena cava: the left stub on top, enters the right atrium
  { kind: 'vein', r: [37, 34], cut: [-0.12, 0, 0.2], path: [[893, 600, -62], [897, 450, -58], [902, 330, -52], [905, 270, -50]] },
  // ascending aorta, then the arch running back over the pulmonary bifurcation, descending stump
  {
    kind: 'artery', r: [36, 31], smooth: 5, joinK: 0.05,
    path: [[1012, 640, 25], [1004, 500, 22], [992, 410, 4], [985, 372, -40], [990, 362, -95], [1000, 380, -145], [1008, 430, -178], [1012, 500, -190]],
  },
  // brachiocephalic trunk, left common carotid, left subclavian (front to back)
  { kind: 'artery', r: [23, 21], path: [[985, 372, -48], [982, 330, -48], [979, 278, -46]], joinK: 0.03 },
  { kind: 'artery', r: [16, 15], path: [[990, 362, -98], [993, 330, -102], [995, 292, -106]], joinK: 0.025 },
  { kind: 'artery', r: [17, 16], path: [[998, 372, -142], [1003, 340, -150], [1006, 296, -156]], joinK: 0.025 },
  // pulmonary trunk: leaves the right ventricle in front, climbs up, right and back
  { kind: 'artery', r: [49, 45], smooth: 5, cut: [-0.25, 0, 0.1], path: [[1082, 560, 92], [1118, 470, 90], [1150, 402, 68], [1167, 356, 40], [1175, 326, 18]] },
  // right pulmonary veins (the short horizontal stub on the left), from the left atrium behind the right atrium
  { kind: 'vein', r: [29, 27], cut: [0.15, 0.35, 0.1], path: [[960, 498, -150], [860, 494, -136], [770, 490, -122], [712, 482, -114]] },
  { kind: 'vein', r: [29, 27], cut: [0.1, -0.3, -0.1], path: [[960, 558, -146], [860, 556, -130], [774, 558, -116], [716, 566, -108]] },
  // left pulmonary veins, leaving the left atrium backwards (hidden from the front)
  { kind: 'vein', r: [25, 24], path: [[1080, 505, -170], [1150, 494, -212], [1196, 490, -250]] },
  { kind: 'vein', r: [25, 24], path: [[1080, 565, -166], [1152, 558, -206], [1200, 556, -244]] },
  // inferior vena cava, below and behind the right atrium
  { kind: 'vein', r: [35, 33], path: [[838, 800, -78], [835, 880, -118], [838, 960, -150]] },
]

// Lobes smooth-unioned into the body: auricles on the base, the left atrium
// bulging out of the back where the four pulmonary veins enter.
const LOBES = [
  { c: [930, 420, 112], r: [74, 34, 42], rot: -0.32, k: 0.045 }, // right auricle, over the aortic root
  { c: [1172, 456, 44], r: [46, 27, 44], rot: 0.55, k: 0.045 }, // left auricle, beside the pulmonary trunk
  { c: [1010, 540, -128], r: [150, 78, 78], rot: 0.04, k: 0.07 }, // left atrium
]

// Groove fields. Each groove is a blend of a front plane and a back plane
// (weighted by depth), so it can wrap the organ the way the real one does:
// the coronary sulcus is steep on the front (right border of the right
// atrium) and near-horizontal behind (coronary sinus); the interventricular
// groove keeps the left ventricle to a third of the front and most of the back.
const AV_FRONT = { a: [1022, 440], b: [800, 870], nz: 0.42 }
const AV_BACK = { y: 610, slope: 0.12 }
const SEPT_FRONT = { a: [1160, 462], b: [1032, 1108], nz: -0.08 }
const SEPT_BACK = { a: [890, 610], b: [968, 1112], nz: 0.08 }

const T0 = 190 / S // max half-depth (anterior-posterior), raw units
const GD = 0.024 // groove depth at grooves = 1
const GW_AV = 0.042 // groove half-widths (gaussian)
const GW_SE = 0.038
const VENTRICLE_CENTER = [1035, 800, 30]

/* -------------------------------------------------- Poisson inflation ---- */

let INFLATION = null

function solveLevel(poly, ox, oy, cell, nx, ny, init, g0, its) {
  const n = nx * ny
  const d2 = new Float32Array(n)
  const inside = new Uint8Array(n)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      d2[k] = sdPolygon2D(ox + i * cell, oy + j * cell, poly)
      inside[k] = d2[k] < 0 ? 1 : 0
    }
  }
  const h = init || new Float32Array(n)
  // Dirichlet values outside follow the linear continuation of h, so the
  // interpolated zero level lands on the true outline at sub-cell precision.
  for (let k = 0; k < n; k++) if (!inside[k]) h[k] = -g0 * d2[k]
  const c2 = cell * cell
  const w = 2 / (1 + Math.sin(Math.PI / Math.max(nx, ny)))
  for (let it = 0; it < its; it++) {
    for (let parity = 0; parity < 2; parity++) {
      for (let j = 1; j < ny - 1; j++) {
        for (let i = 1 + ((j + parity) & 1); i < nx - 1; i += 2) {
          const k = j * nx + i
          if (!inside[k]) continue
          const gs = (h[k - 1] + h[k + 1] + h[k - nx] + h[k + nx] + c2) * 0.25
          h[k] += w * (gs - h[k])
        }
      }
    }
  }
  return { h, d2, inside }
}

function inflation() {
  if (INFLATION) return INFLATION
  const poly = BODY_OUTLINE
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of poly) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }
  const pad = 0.08
  const ox = minX - pad, oy = minY - pad
  const W = maxX - minX + 2 * pad, Hh = maxY - minY + 2 * pad
  // coarse solve with h = 0 outside, to measure the boundary slope g0
  let cell = 0.048
  let nx = Math.ceil(W / cell) + 1, ny = Math.ceil(Hh / cell) + 1
  let lvl = solveLevel(poly, ox, oy, cell, nx, ny, null, 0, 160)
  let gs = 0, gn = 0
  for (let k = 0; k < nx * ny; k++) {
    if (lvl.inside[k] && lvl.d2[k] > -1.6 * cell) { gs += lvl.h[k] / -lvl.d2[k]; gn++ }
  }
  const g0 = gs / Math.max(gn, 1)
  for (const [c, its] of [[0.024, 90], [0.012, 70]]) {
    const pnx = nx, pny = ny, pcell = cell, ph = lvl.h
    cell = c
    nx = Math.ceil(W / cell) + 1
    ny = Math.ceil(Hh / cell) + 1
    const init = new Float32Array(nx * ny)
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const fx = Math.min((i * cell) / pcell, pnx - 1.001)
        const fy = Math.min((j * cell) / pcell, pny - 1.001)
        const i0 = Math.floor(fx), j0 = Math.floor(fy)
        const tx = fx - i0, ty = fy - j0
        const a = ph[j0 * pnx + i0], b = ph[j0 * pnx + i0 + 1]
        const cc = ph[(j0 + 1) * pnx + i0], d = ph[(j0 + 1) * pnx + i0 + 1]
        init[j * nx + i] = (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty
      }
    }
    lvl = solveLevel(poly, ox, oy, cell, nx, ny, init, g0, its)
  }
  let hmax = 0
  for (let k = 0; k < nx * ny; k++) hmax = Math.max(hmax, lvl.h[k])
  INFLATION = { h: lvl.h, nx, ny, ox, oy, cell, g0, hmax, bounds: { minX, minY, maxX, maxY } }
  return INFLATION
}

// Bilinear h with its gradient; linear continuation outside the grid.
function makeSampler(inf) {
  const { h, nx, ny, ox, oy, cell, g0 } = inf
  const out = { h: 0, hx: 0, hy: 0 }
  return function sampleH(x, y) {
    let fx = (x - ox) / cell
    let fy = (y - oy) / cell
    let extra = 0
    if (fx < 0 || fy < 0 || fx > nx - 1.001 || fy > ny - 1.001) {
      const cx = clamp(fx, 0, nx - 1.001), cy = clamp(fy, 0, ny - 1.001)
      extra = Math.hypot(fx - cx, fy - cy) * cell
      fx = cx
      fy = cy
    }
    const i = Math.floor(fx), j = Math.floor(fy)
    const tx = fx - i, ty = fy - j
    const k = j * nx + i
    const a = h[k], b = h[k + 1], c = h[k + nx], d = h[k + nx + 1]
    out.h = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty - g0 * extra
    out.hx = ((b - a) * (1 - ty) + (d - c) * ty) / cell
    out.hy = ((c - a) * (1 - tx) + (d - b) * tx) / cell
    return out
  }
}

/* --------------------------------------------------------- vessels ------- */

// `amount` scales the free part of the vessel (beyond where it leaves the
// tissue it grows from, tested with `inside`), so the cut slides towards the root.
function buildVessel(def, amount, inside) {
  let pts = def.path.map((p) => P(p[0], p[1], p[2]))
  if (def.smooth) pts = catmullRom(pts, def.smooth)
  const cum = [0]
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]))
  }
  const total = cum[cum.length - 1]
  const at = (sArc) => {
    let i = 1
    while (i < cum.length - 1 && cum[i] < sArc) i++
    const t = (sArc - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)
    const a = pts[i - 1], b = pts[i]
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
  }
  let exit = 0
  for (let k = 0; k <= 48; k++) {
    const q = at((total * k) / 48)
    if (inside(q[0], q[1], q[2])) exit = (total * k) / 48
    else if (k > 0) break
  }
  const keep = Math.min(total, exit + (total - exit) * amount + 1e-4)
  const lengthScale = keep / total
  const out = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] < keep) { out.push(pts[i]); continue }
    const t = (keep - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)
    const a = pts[i - 1], b = pts[i]
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t])
    break
  }
  const segs = []
  let acc = 0
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i]
    const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2]
    const len = Math.hypot(bx, by, bz) || 1e-9
    segs.push({ ax: a[0], ay: a[1], az: a[2], bx, by, bz, inv: 1 / (len * len), u0: acc / keep, du: len / keep })
    acc += len
  }
  const last = segs[segs.length - 1]
  const tl = Math.hypot(last.bx, last.by, last.bz)
  const end = out[out.length - 1]
  // cut plane normal: the vessel direction, optionally tilted for an oblique cut
  let tEnd = [last.bx / tl, last.by / tl, last.bz / tl]
  if (def.cut) {
    const cx = tEnd[0] + def.cut[0], cy = tEnd[1] + def.cut[1], cz = tEnd[2] + def.cut[2]
    const cl = Math.hypot(cx, cy, cz)
    tEnd = [cx / cl, cy / cl, cz / cl]
  }
  const r0 = def.r[0] / S
  const r1 = r0 + (def.r[1] / S - r0) * lengthScale
  // run the tube on past the cut so an oblique cut never exposes the capsule's round end
  const ux = last.bx / tl, uy = last.by / tl, uz = last.bz / tl
  const ext = 1.6 * r1
  segs.push({ ax: end[0], ay: end[1], az: end[2], bx: ux * ext, by: uy * ext, bz: uz * ext, inv: 1 / (ext * ext), u0: 1, du: 0 })
  out.push([end[0] + ux * ext, end[1] + uy * ext, end[2] + uz * ext])
  // bounding sphere for early outs
  let cx = 0, cy = 0, cz = 0
  for (const p of out) { cx += p[0]; cy += p[1]; cz += p[2] }
  cx /= out.length; cy /= out.length; cz /= out.length
  let br = 0
  for (const p of out) br = Math.max(br, Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz))
  br += Math.max(r0, r1)
  return { kind: def.kind, segs, end, tEnd, r0, r1, joinK: def.joinK ?? 0.035, cx, cy, cz, br, length: keep }
}

// Open tube: capsule chain intersected with the half-space behind the cut.
// Writes the tube / plane terms into `info` when given.
function vesselDist(v, x, y, z, info) {
  let best = Infinity, bu = 0
  for (let s = 0; s < v.segs.length; s++) {
    const g = v.segs[s]
    const px = x - g.ax, py = y - g.ay, pz = z - g.az
    let t = (px * g.bx + py * g.by + pz * g.bz) * g.inv
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const dx = px - g.bx * t, dy = py - g.by * t, dz = pz - g.bz * t
    const d = dx * dx + dy * dy + dz * dz
    if (d < best) { best = d; bu = g.u0 + g.du * t }
  }
  const tube = Math.sqrt(best) - (v.r0 + (v.r1 - v.r0) * bu)
  const plane = (x - v.end[0]) * v.tEnd[0] + (y - v.end[1]) * v.tEnd[1] + (z - v.end[2]) * v.tEnd[2]
  if (info) { info.tube = tube; info.plane = plane; info.u = bu }
  return tube > plane ? tube : plane
}

/* ------------------------------------------------------- the shape ------- */

function makeModel(params) {
  const inf = inflation()
  const sampleH = makeSampler(inf)
  const depth = params.depth
  const kF = (T0 * depth) / Math.sqrt(inf.hmax)
  const ikF2 = 1 / (kF * kF)
  // back half-depth: fuller behind the atria, flatter over the diaphragmatic surface
  const kBack = (y) => kF * (0.9 - 0.2 * smoothstep(0.25, -0.75, y))
  const kBackDy = (y) => {
    const e = 1e-3
    return (kBack(y + e) - kBack(y - e)) / (2 * e)
  }
  // apex forward, base back: mid-plane z = zc0 + zs * y
  const zs = -0.2 * params.apexTilt
  const zc0 = 0.02
  const zMid = (y) => zc0 + zs * y

  const lobes = LOBES.map((a) => {
    const c = P(a.c[0], a.c[1], a.c[2])
    return { c, rx: a.r[0] / S, ry: a.r[1] / S, rz: a.r[2] / S, cs: Math.cos(a.rot), sn: Math.sin(a.rot), k: a.k }
  })

  function core(x, y, z) {
    const H = sampleH(x, y)
    const dz = z - zMid(y)
    let ik2 = ikF2, dk = 0
    if (dz < 0) {
      const kb = kBack(y)
      ik2 = 1 / (kb * kb)
      dk = (-2 * dz * dz * ik2 * kBackDy(y)) / kb
    }
    const G = dz * dz * ik2 - H.h
    const gx = -H.hx
    const gy = -H.hy - 2 * dz * ik2 * zs + dk
    const gz = 2 * dz * ik2
    return G / Math.max(Math.sqrt(gx * gx + gy * gy + gz * gz), 0.06)
  }

  function body(x, y, z) {
    let d = core(x, y, z)
    for (let i = 0; i < lobes.length; i++) {
      const a = lobes[i]
      const px = x - a.c[0], py = y - a.c[1], pz = z - a.c[2]
      const qx = a.cs * px + a.sn * py, qy = -a.sn * px + a.cs * py
      const k0 = Math.hypot(qx / a.rx, qy / a.ry, pz / a.rz)
      const k1 = Math.hypot(qx / (a.rx * a.rx), qy / (a.ry * a.ry), pz / (a.rz * a.rz))
      const e = k1 === 0 ? -a.rx : (k0 * (k0 - 1)) / k1
      d = opSmoothUnion(d, e, a.k)
    }
    return d
  }

  // built in order, so a branch measures its free length from the aortic arch
  const vessels = []
  if (params.vessels > 0.01) {
    const inside = (x, y, z) => {
      if (body(x, y, z) < 0) return true
      for (const v of vessels) if (vesselDist(v, x, y, z) < 0) return true
      return false
    }
    for (const def of VESSELS) vessels.push(buildVessel(def, params.vessels, inside))
  }

  function vesselsMin(x, y, z, bound) {
    let best = Infinity, bi = -1
    for (let i = 0; i < vessels.length; i++) {
      const v = vessels[i]
      const c = Math.hypot(x - v.cx, y - v.cy, z - v.cz) - v.br
      if (c > Math.min(best, bound)) continue
      const d = vesselDist(v, x, y, z)
      if (d < best) { best = d; bi = i }
    }
    return { d: best, i: bi }
  }

  function F(x, y, z) {
    const b = body(x, y, z)
    if (!vessels.length) return b
    const vm = vesselsMin(x, y, z, b + 0.08)
    if (vm.i < 0) return b
    return opSmoothUnion(b, vm.d, vessels[vm.i].joinK)
  }

  // Groove fields (signed, raw units). AV: + towards the ventricles.
  const avA = P(AV_FRONT.a[0], AV_FRONT.a[1]), avB = P(AV_FRONT.b[0], AV_FRONT.b[1])
  const avN = (() => {
    const dx = avB[0] - avA[0], dy = avB[1] - avA[1]
    const l = Math.hypot(dx, dy)
    const n = [-dy / l, dx / l, 0]
    if (n[0] < 0) { n[0] *= -1; n[1] *= -1 }
    n[2] = AV_FRONT.nz
    const m = Math.hypot(n[0], n[1], n[2])
    return [n[0] / m, n[1] / m, n[2] / m]
  })()
  const avMid = [(avA[0] + avB[0]) / 2, (avA[1] + avB[1]) / 2]
  const avBackY = P(0, AV_BACK.y)[1]
  // plane through the front-view line a → b (px), normal pointing to +x, tilted by nz
  const linePlane = (L) => {
    const A = P(L.a[0], L.a[1]), B = P(L.b[0], L.b[1])
    const dx = B[0] - A[0], dy = B[1] - A[1]
    const l = Math.hypot(dx, dy)
    let n = [-dy / l, dx / l, 0]
    if (n[0] < 0) n = [-n[0], -n[1], 0]
    n[2] = L.nz
    const m = Math.hypot(n[0], n[1], n[2])
    return { n: [n[0] / m, n[1] / m, n[2] / m], m: [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2] }
  }
  const sfP = linePlane(SEPT_FRONT), sbP = linePlane(SEPT_BACK)
  const frontZ = (x, y) => {
    const H = sampleH(x, y)
    return zMid(y) + kF * Math.sqrt(Math.max(H.h, 0))
  }
  const avZ0 = frontZ(avMid[0], avMid[1])
  sfP.z = frontZ(sfP.m[0], sfP.m[1])
  sbP.z = zMid(sbP.m[1]) - kBack(sbP.m[1]) * Math.sqrt(Math.max(sampleH(sbP.m[0], sbP.m[1]).h, 0))

  function sAV(x, y, z) {
    const f = avN[0] * (x - avMid[0]) + avN[1] * (y - avMid[1]) + avN[2] * (z - avZ0)
    const b = avBackY - y + AV_BACK.slope * x
    const w = smoothstep(0.12, -0.16, z - zMid(y))
    return f + (b - f) * w
  }
  function sSept(x, y, z) {
    const f = sfP.n[0] * (x - sfP.m[0]) + sfP.n[1] * (y - sfP.m[1]) + sfP.n[2] * (z - sfP.z)
    const b = sbP.n[0] * (x - sbP.m[0]) + sbP.n[1] * (y - sbP.m[1]) + sbP.n[2] * (z - sbP.z)
    return f + (b - f) * smoothstep(0.1, -0.1, z - zMid(y))
  }

  // bounds of everything (raw)
  const bb = inf.bounds
  const min = [bb.minX - 0.05, bb.minY - 0.05, -T0 * depth * 1.25 - 0.2]
  const max = [bb.maxX + 0.05, bb.maxY + 0.05, T0 * depth * 1.25 + 0.15]
  for (const v of vessels) {
    for (const s of v.segs) {
      for (const p of [[s.ax, s.ay, s.az], [s.ax + s.bx, s.ay + s.by, s.az + s.bz]]) {
        for (let c = 0; c < 3; c++) {
          min[c] = Math.min(min[c], p[c] - v.r0 - 0.03)
          max[c] = Math.max(max[c], p[c] + v.r0 + 0.03)
        }
      }
    }
  }

  // reference px on the front (or back) surface of the inflated body, null outside it
  const surfacePoint = (px, py, side = 'front') => {
    const q = P(px, py)
    const H = sampleH(q[0], q[1])
    if (H.h <= 0) return null
    const r = Math.sqrt(H.h)
    return [q[0], q[1], zMid(q[1]) + (side === 'front' ? kF * r : -kBack(q[1]) * r)]
  }
  const frontPoint = (px, py) => surfacePoint(px, py, 'front')

  return { F, body, vessels, vesselsMin, sAV, sSept, zMid, frontPoint, surfacePoint, min, max }
}

function grad(f, x, y, z, out, e = 1.5e-3) {
  const gx = f(x + e, y, z) - f(x - e, y, z)
  const gy = f(x, y + e, z) - f(x, y - e, z)
  const gz = f(x, y, z + e) - f(x, y, z - e)
  const l = Math.hypot(gx, gy, gz) || 1
  out[0] = gx / l
  out[1] = gy / l
  out[2] = gz / l
  return out
}

/* ------------------------------------------------------ coronaries ------ */

function gradRaw(f, x, y, z, out, e = 1.5e-3) {
  out[0] = (f(x + e, y, z) - f(x - e, y, z)) / (2 * e)
  out[1] = (f(x, y + e, z) - f(x, y - e, z)) / (2 * e)
  out[2] = (f(x, y, z + e) - f(x, y, z - e)) / (2 * e)
  return out
}

// Walks along the myocardium (body = 0). With `follow` (a groove field) the
// path stays on follow = 0; otherwise it turns towards `target` with a little
// noise, the way branches fan out over the ventricles.
function walk(M, start, opts) {
  const F = M.body
  const { dir, follow = null, target = null, steer = 0.3, wobble = 0.35, step = 0.011, maxLen = 1, stop = null, noise } = opts
  const g = [0, 0, 0]
  const gs = [0, 0, 0]
  let x = start[0], y = start[1], z = start[2]
  const settle = () => {
    for (let it = 0; it < 3; it++) {
      const d = F(x, y, z)
      grad(F, x, y, z, g)
      x -= g[0] * d; y -= g[1] * d; z -= g[2] * d
      if (follow) {
        const sv = follow(x, y, z)
        gradRaw(follow, x, y, z, gs)
        const dn = gs[0] * g[0] + gs[1] * g[1] + gs[2] * g[2]
        const tx = gs[0] - dn * g[0], ty = gs[1] - dn * g[1], tz = gs[2] - dn * g[2]
        const t2 = tx * tx + ty * ty + tz * tz || 1
        x -= (sv * tx) / t2; y -= (sv * ty) / t2; z -= (sv * tz) / t2
      }
    }
    const d = F(x, y, z)
    grad(F, x, y, z, g)
    x -= g[0] * d; y -= g[1] * d; z -= g[2] * d
  }
  settle()
  const pts = [[x, y, z]]
  const nors = [[g[0], g[1], g[2]]]
  let dx = dir[0], dy = dir[1], dz = dir[2]
  let len = 0
  while (len < maxLen) {
    let tx, ty, tz
    if (follow) {
      gradRaw(follow, x, y, z, gs)
      tx = g[1] * gs[2] - g[2] * gs[1]
      ty = g[2] * gs[0] - g[0] * gs[2]
      tz = g[0] * gs[1] - g[1] * gs[0]
      if (tx * dx + ty * dy + tz * dz < 0) { tx = -tx; ty = -ty; tz = -tz }
    } else {
      const wx = target[0] - x, wy = target[1] - y, wz = target[2] - z
      const wl = Math.hypot(wx, wy, wz) || 1
      const ns = 2.4
      tx = dx * (1 - steer) + (wx / wl) * steer + wobble * noise(x * ns + 11, y * ns, z * ns)
      ty = dy * (1 - steer) + (wy / wl) * steer + wobble * noise(x * ns, y * ns + 23, z * ns)
      tz = dz * (1 - steer) + (wz / wl) * steer + wobble * noise(x * ns, y * ns, z * ns + 37)
    }
    const dn = tx * g[0] + ty * g[1] + tz * g[2]
    tx -= dn * g[0]; ty -= dn * g[1]; tz -= dn * g[2]
    const tl = Math.hypot(tx, ty, tz) || 1
    dx = tx / tl; dy = ty / tl; dz = tz / tl
    x += dx * step; y += dy * step; z += dz * step
    settle()
    len += step
    pts.push([x, y, z])
    nors.push([g[0], g[1], g[2]])
    if (stop && stop(x, y, z, len)) break
  }
  return { pts, nors, len }
}

// Left main → LAD (anterior interventricular groove, wrapping the apex) and
// circumflex (left AV groove, round the obtuse margin); RCA (right AV groove)
// → posterior descending at the crux; diagonals and marginals over the walls.
function traceCoronaries(M, rng, noise) {
  const { sAV, sSept, zMid, surfacePoint } = M
  const apexY = P(0, 1122)[1]
  const back = (x, y, z) => z < zMid(y) - 0.06
  const out = []
  const add = (path, r0, r1, groove = true) => {
    if (path.pts.length > 3) out.push({ pts: path.pts, nors: path.nors, len: path.len, r0, r1, groove })
    return path
  }
  const lad = add(walk(M, surfacePoint(1150, 488), {
    dir: [0, -1, 0], follow: sSept, maxLen: 2.6, noise,
    stop: (x, y, z) => back(x, y, z) && y > apexY + 0.14,
  }), 0.0078, 0.0036)
  const lcx = add(walk(M, surfacePoint(1150, 470), {
    dir: [1, 0.1, -0.3], follow: sAV, maxLen: 1.6, noise,
    stop: (x, y, z) => back(x, y, z) && sSept(x, y, z) < 0.12,
  }), 0.0074, 0.0045)
  const rca = add(walk(M, surfacePoint(985, 440), {
    dir: [-0.35, -1, 0], follow: sAV, maxLen: 2.8, noise,
    stop: (x, y, z) => back(x, y, z) && sSept(x, y, z) > 0,
  }), 0.008, 0.0055)
  const crux = rca.pts[rca.pts.length - 1]
  add(walk(M, crux, {
    dir: [0, -1, 0], follow: sSept, maxLen: 1.4, noise,
    stop: (x, y) => y < apexY + 0.1,
  }), 0.0064, 0.0034)

  // a branch leaves its parent heading for `aim` (front-view px on a surface side)
  const branch = (parent, u, aim, len, r0) => {
    const m = parent.pts.length
    const i = Math.min(Math.max(Math.round(u * (m - 1)), 1), m - 2)
    const A = parent.pts[i - 1], B = parent.pts[i + 1], o = parent.pts[i]
    const target = surfacePoint(aim[0], aim[1], aim[2]) || P(aim[0], aim[1], 0)
    let tx = B[0] - A[0], ty = B[1] - A[1], tz = B[2] - A[2]
    const tl = Math.hypot(tx, ty, tz) || 1
    let wx = target[0] - o[0], wy = target[1] - o[1], wz = target[2] - o[2]
    const wl = Math.hypot(wx, wy, wz) || 1
    wx /= wl; wy /= wl; wz /= wl
    const sg = (tx * wx + ty * wy + tz * wz) < 0 ? -1 : 1
    add(walk(M, o, {
      dir: [0.3 * sg * tx / tl + 0.7 * wx, 0.3 * sg * ty / tl + 0.7 * wy, 0.3 * sg * tz / tl + 0.7 * wz],
      target, steer: 0.08, wobble: 0.16, maxLen: len, noise,
      stop: (x, y) => y < apexY + 0.05,
    }), r0, r0 * 0.4, false)
  }
  const j = () => (rng.next() - 0.5) * 0.1
  branch(lad, 0.2 + j(), [1285, 820, 'front'], 0.46 + j(), 0.0058) // first diagonal
  branch(lad, 0.42 + j(), [1250, 1000, 'front'], 0.36 + j(), 0.0052) // second diagonal
  branch(lcx, 0.5 + j(), [1200, 1040, 'back'], 0.55 + j(), 0.0054) // obtuse marginal
  branch(rca, 0.42 + j(), [1000, 1080, 'front'], 0.42 + j(), 0.0052) // acute marginal
  return out
}

export default {
  id: 'heart',
  label: 'Heart',
  order: 3,
  params: {
    vessels: { value: 1, min: 0, max: 1, step: 0.01, label: 'Vessels' },
    fill: { value: 0.25, min: 0, max: 0.8, step: 0.01, label: 'Fill' },
    grooves: { value: 0.6, min: 0, max: 1, step: 0.01, label: 'Grooves' },
    coronaries: { value: 0.7, min: 0, max: 1, step: 0.01, label: 'Coronaries' },
    apexTilt: { value: 0.6, min: -1, max: 1, step: 0.01, label: 'Apex tilt' },
    depth: { value: 1, min: 0.6, max: 1.4, step: 0.01, label: 'Depth' },
    organic: { value: 0.35, min: 0, max: 1, step: 0.01, label: 'Organic' },
  },
  defaults: {
    particles: { size: 2.0, sizeVariance: 0.6, sizeByCount: 0.5, softness: 0.1, opacity: 0.92, opacityB: 0.9, shading: 0.4 },
    depth: { fade: 0.5, dof: 0 },
    dissolve: { amount: 0 },
    motion: { mode: 'sway', speed: 0.22, swayAngle: 18, yaw: 0, pitch: 0, roll: 0, float: 0.2, noise: 0.14, noiseScale: 1.4, noiseSpeed: 0.25 },
    life: { enabled: true, amount: 0.5, rate: 1 },
    dust: { count: 1200, size: 0.85, opacity: 0.14, radius: 1.1, drift: 0.2 },
    scene: { background: '#ffffff', glow: 0 },
    camera: { azimuth: 0, elevation: 0, offsetX: 0, offsetY: 0, frame: 1 },
  },

  generate(params, { seed, maxCount }) {
    const p = {
      vessels: clamp(params.vessels ?? 1, 0, 1),
      fill: clamp(params.fill ?? 0.25, 0, 0.95),
      grooves: clamp(params.grooves ?? 0.6, 0, 1),
      coronaries: clamp(params.coronaries ?? 0.7, 0, 1),
      apexTilt: clamp(params.apexTilt ?? 0.6, -1, 1),
      depth: clamp(params.depth ?? 1, 0.4, 2),
      organic: clamp(params.organic ?? 0.35, 0, 1),
    }
    const rng = createRng(seed)
    const noise = createNoise3D(seed ^ 0x2c1b3c6d)
    const M = makeModel(p)
    const { F, body, vessels, sAV, sSept } = M
    const N = maxCount

    const nLum = vessels.length ? Math.round(N * 0.022) : 0
    const nCor = Math.round(N * 0.1 * p.coronaries)
    const rest = N - nLum - nCor
    const nVol = Math.round(rest * p.fill)
    const nSurf = rest - nVol

    const pos = new Float32Array(N * 3)
    const nor = new Float32Array(N * 3)
    const grp = new Uint8Array(N)
    const aux = new Float32Array(N)
    const siz = new Float32Array(N)
    let n = 0
    const push = (x, y, z, nx, ny, nz, g, a) => {
      if (n >= N) return
      pos[n * 3] = x; pos[n * 3 + 1] = y; pos[n * 3 + 2] = z
      nor[n * 3] = nx; nor[n * 3 + 1] = ny; nor[n * 3 + 2] = nz
      grp[n] = g
      aux[n] = a
      siz[n] = defaultSize(rng)
      n++
    }

    /* coarse occupancy grid: cells near the surface (band) and inside (volume) */
    const cell = 0.045
    const gmin = M.min, gmax = M.max
    const gx = Math.ceil((gmax[0] - gmin[0]) / cell)
    const gy = Math.ceil((gmax[1] - gmin[1]) / cell)
    const gz = Math.ceil((gmax[2] - gmin[2]) / cell)
    const near = []
    const inner = []
    const reach = cell * 0.87 * 1.35
    for (let k = 0; k < gz; k++) {
      for (let j = 0; j < gy; j++) {
        for (let i = 0; i < gx; i++) {
          const x = gmin[0] + (i + 0.5) * cell, y = gmin[1] + (j + 0.5) * cell, z = gmin[2] + (k + 0.5) * cell
          const d = F(x, y, z)
          if (Math.abs(d) < reach + 0.02) near.push(i, j, k)
          if (body(x, y, z) < reach) inner.push(i, j, k)
        }
      }
    }
    const nearCells = near.length / 3
    const innerCells = inner.length / 3
    const cand = (list, cells, out) => {
      const c = Math.floor(rng.next() * cells) * 3
      out[0] = gmin[0] + (list[c] + rng.next()) * cell
      out[1] = gmin[1] + (list[c + 1] + rng.next()) * cell
      out[2] = gmin[2] + (list[c + 2] + rng.next()) * cell
      return out
    }

    /* surface: body + vessels, uniform area density, open vessel ends */
    const shell = 0.016
    const g = [0, 0, 0]
    const q = [0, 0, 0]
    const info = { tube: 0, plane: 0, u: 0 }
    const gs3 = [0, 0, 0]
    let tries = 0
    let surf = 0
    const maxTries = 400000
    while (surf < nSurf && tries < maxTries) {
      tries++
      cand(near, nearCells, q)
      let x = q[0], y = q[1], z = q[2]
      let d = F(x, y, z)
      if (Math.abs(d) > shell) continue
      for (let it = 0; it < 2; it++) {
        grad(F, x, y, z, g)
        x -= g[0] * d; y -= g[1] * d; z -= g[2] * d
        d = F(x, y, z)
      }
      if (Math.abs(d) > 0.004) continue
      grad(F, x, y, z, g)
      const nx = g[0], ny = g[1], nz = g[2]
      const db = body(x, y, z)
      let group = 0
      let dens = 1
      let a = 0
      if (vessels.length) {
        const vm = M.vesselsMin(x, y, z, db + 0.05)
        if (vm.i >= 0 && vm.d < db) {
          const v = vessels[vm.i]
          vesselDist(v, x, y, z, info)
          if (info.plane > info.tube - 1e-4) continue // the cut face: leave it open
          const tc = -info.plane
          const rr = v.r0 + (v.r1 - v.r0) * info.u
          dens *= 0.62 + 0.38 * smoothstep(0, rr * 0.9, tc)
          group = 1
          a = v.kind === 'artery' ? 1 : 0
        }
      }
      if (group === 0) {
        const sa = sAV(x, y, z)
        const ss = sSept(x, y, z)
        const vent = smoothstep(-0.05, 0.05, sa)
        a = smoothstep(-0.07, 0.07, sa)
        const gAV = Math.exp(-(sa * sa) / (GW_AV * GW_AV))
        const gSe = Math.exp(-(ss * ss) / (GW_SE * GW_SE)) * vent
        const gr = Math.max(gAV, gSe) * p.grooves
        // body slightly thinner than the vessel walls: the stubs read as solid as in the reference
        dens *= 0.86 * (1 - 0.42 * gr)
        if (rng.next() > dens) continue
        let mx = nx, my = ny, mz = nz
        if (gr > 0.03) {
          // tilt the normal down the groove walls so shading draws the crease
          const useAV = gAV >= gSe
          const sv = useAV ? sa : ss, w = useAV ? GW_AV : GW_SE
          gradRaw(useAV ? sAV : sSept, x, y, z, gs3)
          const dn = gs3[0] * nx + gs3[1] * ny + gs3[2] * nz
          const slope = ((2 * GD * p.grooves * sv) / (w * w)) * (useAV ? gAV : gSe)
          mx = nx - slope * (gs3[0] - dn * nx)
          my = ny - slope * (gs3[1] - dn * ny)
          mz = nz - slope * (gs3[2] - dn * nz)
          const ml = Math.hypot(mx, my, mz) || 1
          mx /= ml; my /= ml; mz /= ml
        }
        const disp = -GD * gr + p.organic * 0.022 * fbm3(noise, x * 3.4, y * 3.4, z * 3.4, 3)
        push(x + nx * disp, y + ny * disp, z + nz * disp, mx, my, mz, 0, a)
        surf++
        continue
      }
      if (rng.next() > dens) continue
      push(x, y, z, nx, ny, nz, group, a)
      surf++
    }

    /* coronary arteries: traced on the surface, sampled as a fine tube lying on it */
    let corCount = 0
    const corStart = n
    if (nCor) {
      const tree = traceCoronaries(M, rng, noise)
      // budget by length and calibre; the back half of the tree is thinned (it
      // mostly reads through the depth fade) so the front lines stay legible
      const backKeep = 0.5
      let wsum = 0
      for (const c of tree) {
        let front = 0
        for (const q of c.pts) if (q[2] > M.zMid(q[1])) front++
        const ff = front / c.pts.length
        c.w = c.len * Math.sqrt((c.r0 + c.r1) / 0.015) * (ff + backKeep * (1 - ff))
        wsum += c.w
      }
      for (const c of tree) {
        const k = Math.round((nCor * c.w) / wsum)
        const m = c.pts.length
        let made = 0
        for (let guard = 0; made < k && corCount < nCor && guard < k * 6; guard++) {
          const f = rng.next() * (m - 1)
          const i0 = Math.min(Math.floor(f), m - 2)
          const t = f - i0
          const A = c.pts[i0], B = c.pts[i0 + 1], NA = c.nors[i0]
          const x = A[0] + (B[0] - A[0]) * t, y = A[1] + (B[1] - A[1]) * t, z = A[2] + (B[2] - A[2]) * t
          if (z < M.zMid(y) && rng.next() > backKeep) continue
          const u = f / (m - 1)
          // soft fade at the distal tip
          if (rng.next() > 1 - 0.75 * smoothstep(0.75, 1, u)) continue
          let tx = B[0] - A[0], ty = B[1] - A[1], tz = B[2] - A[2]
          const tl = Math.hypot(tx, ty, tz) || 1
          tx /= tl; ty /= tl; tz /= tl
          let bx = ty * NA[2] - tz * NA[1], by = tz * NA[0] - tx * NA[2], bz = tx * NA[1] - ty * NA[0]
          const bl = Math.hypot(bx, by, bz) || 1
          bx /= bl; by /= bl; bz /= bl
          const rc = c.r0 + (c.r1 - c.r0) * u
          const th = rng.next() * Math.PI * 2
          const rho = Math.sqrt(rng.next()) * rc
          const off = (c.groove ? rc * 0.75 - GD * p.grooves : rc * 0.45) + Math.cos(th) * rho
          const lat = Math.sin(th) * rho
          const cs = Math.cos(th), sn = Math.sin(th)
          push(
            x + NA[0] * off + bx * lat, y + NA[1] * off + by * lat, z + NA[2] * off + bz * lat,
            NA[0] * cs + bx * sn, NA[1] * cs + by * sn, NA[2] * cs + bz * sn,
            1, smoothstep(-0.07, 0.07, sAV(x, y, z)),
          )
          // vessels read as chains of slightly bolder dots
          siz[n - 1] = Math.min(siz[n - 1] * 1.22, 2.6)
          made++
          corCount++
        }
      }
    }

    /* lumen: a short ring of the inner wall seen through each open end */
    if (nLum) {
      let wsum = 0
      for (const v of vessels) wsum += v.r1
      for (const v of vessels) {
        const k = Math.round((nLum * v.r1) / wsum)
        const t = v.tEnd
        const ref = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
        let e1 = [t[1] * ref[2] - t[2] * ref[1], t[2] * ref[0] - t[0] * ref[2], t[0] * ref[1] - t[1] * ref[0]]
        const l1 = Math.hypot(e1[0], e1[1], e1[2])
        e1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1]
        const e2 = [t[1] * e1[2] - t[2] * e1[1], t[2] * e1[0] - t[0] * e1[2], t[0] * e1[1] - t[1] * e1[0]]
        for (let i = 0; i < k; i++) {
          const th = rng.next() * Math.PI * 2
          const depthIn = Math.pow(rng.next(), 1.6) * v.r1 * 0.9
          const rr = v.r1 * 0.84
          const cx = Math.cos(th), sx = Math.sin(th)
          const rx = e1[0] * cx + e2[0] * sx, ry = e1[1] * cx + e2[1] * sx, rz = e1[2] * cx + e2[2] * sx
          const lx = v.end[0] - t[0] * depthIn + rx * rr, ly = v.end[1] - t[1] * depthIn + ry * rr, lz = v.end[2] - t[2] * depthIn + rz * rr
          if (body(lx, ly, lz) < 0.004) continue
          push(lx, ly, lz, -rx, -ry, -rz, 1, v.kind === 'artery' ? 1 : 0)
        }
      }
    }

    /* myocardium volume: even fill so the body reads dense from any angle */
    let vt = 0
    while (n < N && vt < 400000) {
      vt++
      cand(inner, innerCells, q)
      const d = body(q[0], q[1], q[2])
      if (d > -0.012) continue
      grad(body, q[0], q[1], q[2], g)
      push(q[0], q[1], q[2], g[0], g[1], g[2], 0, smoothstep(-0.07, 0.07, sAV(q[0], q[1], q[2])))
    }
    // safety net: never return short (jittered copies of existing points)
    while (n < N) {
      const s = Math.floor(rng.next() * Math.max(n, 1))
      push(pos[s * 3] + rng.normal() * 0.004, pos[s * 3 + 1] + rng.normal() * 0.004, pos[s * 3 + 2] + rng.normal() * 0.004,
        nor[s * 3], nor[s * 3 + 1], nor[s * 3 + 2], grp[s], aux[s])
    }

    // preview-only views (?params={"debug":"aux"|"coronaries"} with groups=1)
    if (params.debug === 'aux') for (let i = 0; i < N; i++) grp[i] = aux[i] > 0.5 ? 1 : 0
    if (params.debug === 'coronaries') for (let i = corStart; i < corStart + corCount; i++) grp[i] = 2

    const center = P(VENTRICLE_CENTER[0], VENTRICLE_CENTER[1], VENTRICLE_CENTER[2])
    const apex = P(975, 1118, 0), base = P(1000, 420, 0)
    apex[2] = M.zMid(apex[1]); base[2] = M.zMid(base[1])
    const ax = [base[0] - apex[0], base[1] - apex[1], base[2] - apex[2]]
    const al = Math.hypot(ax[0], ax[1], ax[2])

    return finalizeShape(
      { positions: pos, normal: nor, group: grp, size: siz, aux },
      {
        seed,
        maxCount,
        meta: {
          id: 'heart',
          label: 'Heart',
          life: 'heartbeat',
          center,
          axis: [ax[0] / al, ax[1] / al, ax[2] / al],
          frame: { h: 0.62 },
          groups: ['Heart', 'Vessels'],
          aux: 'contraction delay: atria 0, ventricles 1 (veins follow the atria, arteries the ventricles)',
          stats: { tries, surf, vol: nVol, cor: corCount, lum: nLum, nearCells, innerCells },
        },
      },
    )
  },
}

export const __model = makeModel // TEMP dev
