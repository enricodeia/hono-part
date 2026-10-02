// Specimen 02: head + brain, side view, face to the LEFT (-X).
//
// Built in reference pixels (reference/02-head-brain.png, y down, ~33 px per cm),
// flipped to y up at the end. Every part is an "inflated" 2D silhouette sampled
// parametrically: a point (x, y) inside the outline becomes the two surface
// points z = ±T(x, y), so the FRONT view reproduces the traced outline exactly
// and the gyri pattern (noise of x, y, |z|) lines up between both hemispheres.
//
//   group 0  brain: cerebrum (two hemispheres, longitudinal fissure, gyri and
//            sulci, Sylvian + central sulcus), cerebellum (folia), brainstem
//   group 1  head shell: skull, face profile, ear, neck, shoulders (sparse,
//            weighted towards the silhouette so the profile reads as a line)
//   group 2  spinal column, brainstem down the neck
//
// aux (life 'neural'): group 0 random spark seed; groups 1 + 2 run 0..1 down the
// body, top of the brainstem 0 → bottom cut 1 (signals travel downward).

import { createRng } from './lib/rng.js'
import { createNoise3D, fbm3 } from './lib/noise.js'
import { gridSDF2D, smoothstep, mix } from './lib/sdf.js'
import { finalizeShape, defaultSize } from './lib/sampling.js'
import { catmullRom, resample, transportFrames } from './lib/curves.js'
import {
  CEREBRUM, CEREBELLUM, BRAINSTEM, CORE, PROFILE,
  EAR_HELIX, EAR_ANTIHELIX, EAR_TRAGUS, SPINE,
  SYLVIAN, CENTRAL,
} from './data/head-outline.js'

const STEM_TOP = [1050, 500] // top of the brainstem (aux 0), reference px
const AUX_REACH = 1080 // distance from STEM_TOP to the far shoulder corner
const BRAIN_CENTER = [968, -372, 0] // life pivot, raw coords (y already flipped)

// Quarter-ellipse rise: 0 at the outline, 1 at depth D.
const prof = (t) => (t >= 1 ? 1 : t <= 0 ? 0 : Math.sqrt(1 - (1 - t) * (1 - t)))

/* ------------------------------------------------------------- grids --- */

let GRIDS = null
function grids() {
  if (GRIDS) return GRIDS
  // the face strip of the profile (forehead → throat), closed well inside the
  // head: only its first few px of depth matter (narrow nose / lips / chin)
  const i0 = PROFILE.findIndex((p) => p[1] > 420)
  let i1 = i0
  while (i1 < PROFILE.length && PROFILE[i1][1] < 935) i1++
  const face = PROFILE.slice(i0, i1).concat([[900, 935], [900, 420]])
  GRIDS = {
    cerebrum: gridSDF2D([CEREBRUM], { res: 200, pad: 0.06 }),
    cerebellum: gridSDF2D([CEREBELLUM], { res: 90, pad: 0.15 }),
    stem: gridSDF2D([BRAINSTEM], { res: 90, pad: 0.12 }),
    core: gridSDF2D([CORE], { res: 280, pad: 0.03 }),
    face: gridSDF2D([face], { res: 180, pad: 0.03 }),
  }
  return GRIDS
}

const bboxOf = (poly, pad = 2) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of poly) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad]
}

// 2D outward unit normal of a grid SDF (y down).
function normal2(grid, x, y, out) {
  const h = 1.5
  const gx = grid.sample(x + h, y) - grid.sample(x - h, y)
  const gy = grid.sample(x, y + h) - grid.sample(x, y - h)
  const l = Math.hypot(gx, gy) || 1
  out[0] = gx / l
  out[1] = gy / l
  return out
}

// Closest point on an open polyline; out = { d, x, y, ux, uy } with (ux, uy)
// the unit direction from that point towards (x, y).
function closestOnPolyline(x, y, pl, out) {
  let best = Infinity
  for (let i = 1; i < pl.length; i++) {
    const ax = pl[i - 1][0], ay = pl[i - 1][1]
    const ex = pl[i][0] - ax, ey = pl[i][1] - ay
    const t = Math.min(Math.max(((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey), 0), 1)
    const cx = ax + ex * t, cy = ay + ey * t
    const d = (x - cx) * (x - cx) + (y - cy) * (y - cy)
    if (d < best) {
      best = d
      out.x = cx
      out.y = cy
    }
  }
  out.d = Math.sqrt(best)
  out.ux = out.d > 1e-6 ? (x - out.x) / out.d : 0
  out.uy = out.d > 1e-6 ? (y - out.y) / out.d : 1
  return out
}

/* --------------------------------------------------------- thickness --- */

// Cerebrum half-width: egg-shaped from above (narrow frontal, widest parietal).
function cerebrumT(g, x, y) {
  const s = -g.cerebrum.sample(x, y)
  if (s <= 0) return 0
  const w = 228 * (0.78 + 0.22 * smoothstep(705, 1010, x)) * (1 - 0.08 * smoothstep(1120, 1240, x))
  const D = mix(150, 85, smoothstep(400, 500, y))
  return w * prof(s / D)
}

function cerebellumT(g, x, y) {
  const s = -g.cerebellum.sample(x, y)
  if (s <= 0) return 0
  return 152 * prof(s / 42)
}

function stemT(g, x, y) {
  const s = -g.stem.sample(x, y)
  if (s <= 0) return 0
  const w = mix(58, 40, smoothstep(540, 660, y)) // pons → medulla
  return w * prof(s / 26)
}

// Head half-width knots [y, front W, back W, x where front ends, x where back starts].
const HEAD_KNOTS = [
  [120, 252, 252, 700, 900],
  [530, 246, 252, 680, 880], // forehead / temples
  [610, 200, 246, 680, 900], // cheekbones
  [720, 150, 230, 690, 940], // mouth
  [830, 112, 206, 690, 990], // jaw, narrow at the chin, wide at the angle
  [905, 150, 192, 700, 1000],
  [960, 182, 182, 700, 1000], // neck
]
function headW(x, y, shoulderTop) {
  let w
  if (y <= HEAD_KNOTS[0][0]) w = HEAD_KNOTS[0][2]
  else if (y >= HEAD_KNOTS[HEAD_KNOTS.length - 1][0]) w = HEAD_KNOTS[HEAD_KNOTS.length - 1][2]
  else {
    let i = 1
    while (HEAD_KNOTS[i][0] < y) i++
    const a = HEAD_KNOTS[i - 1], b = HEAD_KNOTS[i]
    const t = smoothstep(a[0], b[0], y)
    const wa = mix(a[1], a[2], smoothstep(a[3], a[4], x))
    const wb = mix(b[1], b[2], smoothstep(b[3], b[4], x))
    w = mix(wa, wb, t)
  }
  // trapezius → shoulders, lower in front than at the back
  const y0 = mix(1062, 966, smoothstep(860, 1240, x))
  return mix(w, shoulderTop, smoothstep(y0, y0 + 138, y))
}

// Nose, lips and chin: narrow features in front of the facial plane.
function featureW(y) {
  if (y < 600) return mix(22, 46, smoothstep(500, 600, y)) // bridge → wings
  if (y < 665) return mix(46, 54, smoothstep(600, 650, y))
  if (y < 775) return mix(54, 78, smoothstep(660, 700, y)) // lips
  return mix(78, 70, smoothstep(775, 830, y)) // chin
}

function headT(g, x, y) {
  let t = 0
  const sc = -g.core.sample(x, y)
  if (sc > 0) {
    const jaw = smoothstep(780, 860, y) * (1 - smoothstep(905, 950, y)) * (1 - smoothstep(960, 1060, x))
    t = headW(x, y, 520) * prof(sc / mix(170, 60, jaw))
  }
  if (x < 900 && y > 420 && y < 935) {
    const sf = -g.face.sample(x, y)
    if (sf > 0) {
      const tf = featureW(y) * prof(sf / 24)
      if (tf > t) t = tf
    }
  }
  return t
}

/* ----------------------------------------------------------- samplers --- */

function makeOut() {
  return { p: [], n: [], g: [], s: [], a: [], r: [] }
}
// rf: spacing factor for thinInto (< 1 packs dots tighter, e.g. sulcus lips)
function push(out, x, y, z, nx, ny, nz, group, size, aux, rf = 1) {
  out.p.push(x, y, z)
  out.n.push(nx, ny, nz)
  out.g.push(group)
  out.s.push(size)
  out.a.push(aux)
  out.r.push(rf)
}
// neural aux for groups 1 + 2: distance from the top of the brainstem, so the
// runtime's travelling signal runs down the spinal column and spreads over the
// shell as a ring around the brainstem (not a flat scan line across the face)
const downAux = (x, y, z) => Math.min(Math.hypot(x - STEM_TOP[0], y - STEM_TOP[1], z) / AUX_REACH, 1)

// Generic parametric sampler for an inflated silhouette. Optional
// snap(c) may move the drawn (c.x, c.y) first (onto a fold line) and set c.rf;
// returns false to reject. accept(c) gets the surface point (x, y, z, T,
// normal, side), returns a probability and may displace the point.
function sampleInflated(n, rng, Tfn, bbox, { cap = 6, areaExp = 0.5, maxTries = 80, snap = null }, accept, emit) {
  const [x0, y0, x1, y1] = bbox
  const w = x1 - x0, hgt = y1 - y0
  const h = 1.25
  const capW = Math.pow(cap, areaExp)
  const c = { x: 0, y: 0, z: 0, T: 0, nx: 0, ny: 0, nz: 0, side: 1, rf: 1 }
  let count = 0
  let tries = 0
  const limit = n * maxTries
  while (count < n && tries < limit) {
    tries++
    c.x = x0 + rng.next() * w
    c.y = y0 + rng.next() * hgt
    c.rf = 1
    if (snap && !snap(c)) continue
    const x = c.x, y = c.y
    const T = Tfn(x, y)
    if (T <= 0) continue
    const Tx = (Tfn(x + h, y) - Tfn(x - h, y)) / (2 * h)
    const Ty = (Tfn(x, y + h) - Tfn(x, y - h)) / (2 * h)
    const A = Math.sqrt(1 + Tx * Tx + Ty * Ty)
    if (rng.next() * capW > Math.pow(Math.min(A, cap), areaExp)) continue
    const side = rng.next() < 0.5 ? -1 : 1
    c.z = side * T
    c.T = T
    c.nx = -Tx / A
    c.ny = -Ty / A
    c.nz = side / A
    c.side = side
    const p = accept(c)
    if (p <= 0 || rng.next() > p) continue
    emit(c)
    count++
  }
  return count
}

// Even (blue-noise) subset of n candidates: dart throwing in 3D with a
// shrinking radius, so gyri and folia read as clean bands of evenly spaced
// dots instead of Poisson clumps. r0 is a first guess of the spacing.
function thinInto(buf, n, rng, out, r0, zw = 1) {
  const m = buf.g.length
  const order = rng.shuffle(Array.from({ length: m }, (_, i) => i))
  const take = (i) => push(out, buf.p[i * 3], buf.p[i * 3 + 1], buf.p[i * 3 + 2], buf.n[i * 3], buf.n[i * 3 + 1], buf.n[i * 3 + 2], buf.g[i], buf.s[i], buf.a[i])
  if (m <= n) {
    for (const i of order) take(i)
    return m
  }
  // distances measured with z scaled by zw: < 1 lets the side view keep a
  // little rim density where the surface turns away from the camera
  const P = Float32Array.from(buf.p)
  for (let i = 2; i < P.length; i += 3) P[i] *= zw
  const R = buf.r
  const used = new Uint8Array(m)
  const chosen = []
  let r = r0
  for (let pass = 0; chosen.length < n && pass < 40; pass++) {
    const inv = 1 / r
    const grid = new Map()
    const key = (ix, iy, iz) => (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)
    const insert = (i) => {
      const k = key(Math.floor(P[i * 3] * inv), Math.floor(P[i * 3 + 1] * inv), Math.floor(P[i * 3 + 2] * inv))
      const b = grid.get(k)
      if (b) b.push(i)
      else grid.set(k, [i])
    }
    for (const i of chosen) insert(i)
    for (let li = 0; li < m && chosen.length < n; li++) {
      const i = order[li]
      if (used[i]) continue
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]
      const ri = R[i]
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
              const rr = r * 0.5 * (ri + R[j])
              if (ex * ex + ey * ey + ez * ez < rr * rr) { ok = false; break }
            }
          }
        }
      }
      if (ok) {
        used[i] = 1
        chosen.push(i)
        insert(i)
      }
    }
    r *= 0.86
  }
  for (const i of chosen) take(i)
  return chosen.length
}

// Outward normal of a closed polygon edge (works for either winding).
function polygonOrientation(poly) {
  let a = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] - poly[i][0]) * (poly[j][1] + poly[i][1])
  return a > 0 ? 1 : -1
}

/* ---------------------------------------------------------- generator --- */

function generate(params, { seed, maxCount }) {
  const t0 = performance.now()
  const rng = createRng(seed)
  const noise = createNoise3D(seed ^ 0x2b1d)
  const warp = createNoise3D(seed ^ 0x77e3)
  const g = grids()
  const P = params
  const out = makeOut()
  const n2 = [0, 0]

  // budgets: shares are normalised so they always add up to maxCount
  const wBrain = P.brainShare
  const wHead = P.headDensity * 0.5
  const wSpine = P.spine
  const wSum = wBrain + wHead + wSpine
  const nBrain = Math.round((maxCount * wBrain) / wSum)
  const nSpine = Math.round((maxCount * wSpine) / wSum)
  const nHead = maxCount - nBrain - nSpine
  const nCerebellum = Math.round(nBrain * 0.1)
  const nStem = Math.round(nBrain * 0.085)
  const nWall = Math.round(nBrain * 0.04 * P.fissure)
  const nCerebrum = nBrain - nCerebellum - nStem - nWall

  const yCut = mix(1010, 1340, P.shoulders)
  const folds = P.folds
  const freq = 1 / (64 * P.gyri)
  const lineShare = 0.85 * folds // chance a candidate near a sulcus is snapped onto it
  const lineRf = mix(1, 0.3, folds) // spacing of the dots along a sulcus line
  const clear = mix(0, 4.5, folds) // empty px each side of a sulcus line
  const sulcusDepth = 14 * folds
  const gap = 4 + 9 * P.fissure // half-width of the longitudinal fissure
  const lipL = 44
  const lipDepth = 4 + 16 * P.fissure
  const sylW = 1 + 5 * P.fissure // extra clear px either side of the Sylvian line
  const fld = [0, 0, 0]
  const near = { d: 0, x: 0, y: 0, ux: 0, uy: 0 }

  // Sulci: the zero set of a domain-warped simplex field, stretched along x so
  // gyri run mostly front to back. Mirrored in z (noise of x, y, |z|), so both
  // hemispheres carry the same pattern. Fills fld = [n, dn/dx, dn/dy] (per px)
  // and returns the distance in px to the nearest sulcus line.
  const sulcusField = (x, y, az) => {
    const qx = x * freq, qy = y * freq, qz = az * freq
    const wx = fbm3(warp, qx * 0.5, qy * 0.5, qz * 0.5 + 3.1, 2) * 0.6
    const wy = fbm3(warp, qx * 0.5 + 7.7, qy * 0.5, qz * 0.5, 2) * 0.6
    const ax = qx * 0.8 + wx, ay = qy * 1.15 + wy
    const ex = 0.4 * freq, ey = 0.575 * freq // half a px in each stretched axis
    fld[0] = noise(ax, ay, qz)
    fld[1] = noise(ax + ex, ay, qz) - noise(ax - ex, ay, qz)
    fld[2] = noise(ax, ay + ey, qz) - noise(ax, ay - ey, qz)
    return Math.abs(fld[0]) / (Math.hypot(fld[1], fld[2]) + 1e-6)
  }

  /* cerebrum ---------------------------------------------------------- */
  // On white, a sulcus reads as a fine dotted line (ink in the fold) with a
  // hair of clear paper either side; the gyri between are evenly stippled.
  const cT = (x, y) => cerebrumT(g, x, y)
  const brainBox = bboxOf(CEREBRUM)
  const buf = makeOut()
  {
    const [bx0, by0, bx1, by1] = brainBox
    const target = Math.round(nCerebrum * 3)
    const capW = Math.pow(6, 0.35)
    const h = 1.25
    for (let tries = 0; buf.g.length < target && tries < target * 60; tries++) {
      let x = bx0 + rng.next() * (bx1 - bx0)
      let y = by0 + rng.next() * (by1 - by0)
      let T = cT(x, y)
      if (T <= 0) continue
      let line = false
      // Sylvian fissure: a clear channel with the deep fold as one line
      closestOnPolyline(x, y, SYLVIAN, near)
      if (near.d < sylW + 14 && rng.next() < lineShare) {
        const off = (rng.next() - 0.5) * 1.6
        x = near.x + near.ux * off
        y = near.y + near.uy * off
        line = true
      } else if (near.d < sylW + clear) continue
      if (!line) {
        // central sulcus: a single line, like the others but always present
        closestOnPolyline(x, y, CENTRAL, near)
        if (near.d < 14 && rng.next() < lineShare) {
          const off = (rng.next() - 0.5) * 1.6
          x = near.x + near.ux * off
          y = near.y + near.uy * off
          line = true
        } else if (near.d < 1 + clear) continue
      }
      if (!line) {
        let d = sulcusField(x, y, T)
        if (d < 14 && rng.next() < lineShare) {
          // two Newton steps onto the zero set
          for (let it = 0; it < 3; it++) {
            const g2 = fld[1] * fld[1] + fld[2] * fld[2] + 1e-9
            x -= (fld[0] * fld[1]) / g2
            y -= (fld[0] * fld[2]) / g2
            d = sulcusField(x, y, T)
          }
          if (d > 1.5) continue
          line = true
        } else if (d < 1 + clear) continue
      }
      T = cT(x, y)
      if (T <= 0) continue
      const Tx = (cT(x + h, y) - cT(x - h, y)) / (2 * h)
      const Ty = (cT(x, y + h) - cT(x, y - h)) / (2 * h)
      const A = Math.sqrt(1 + Tx * Tx + Ty * Ty)
      if (rng.next() * capW > Math.pow(Math.min(A, 6), 0.35)) continue
      const side = rng.next() < 0.5 ? -1 : 1
      const nx = -Tx / A, ny = -Ty / A, nz = side / A
      // longitudinal fissure along the dorsal rim (not underneath)
      normal2(g.cerebrum, x, y, n2)
      const fw = 1 - smoothstep(0.1, 0.55, n2[1])
      if (fw > 0 && rng.next() < fw * (1 - smoothstep(gap * 0.7, gap * 1.35, T))) continue
      let px = x, py = y
      if (fw > 0 && T < lipL) {
        const k = 1 - T / lipL
        const d = fw * lipDepth * k * k
        px -= n2[0] * d
        py -= n2[1] * d
      }
      // lines sit at the bottom of their fold
      const disp = line ? sulcusDepth : 0
      // line dots are kept even in size so a fold reads as one continuous stroke
      const size = line ? mix(defaultSize(rng, 0.34), 1.05 + rng.normal() * 0.08, folds) : defaultSize(rng, 0.34) * 0.94
      push(buf, px - nx * disp, py - ny * disp, side * T - nz * disp, nx, ny, nz, 0, size, rng.next(), line ? lineRf : 1)
    }
  }
  thinInto(buf, nCerebrum, rng, out, 13, 0.5)

  // medial walls of the longitudinal fissure (seen from above / behind)
  if (nWall > 0) {
    const wb = makeOut()
    for (let tries = 0; wb.g.length < nWall * 2.5 && tries < nWall * 800; tries++) {
      const x = brainBox[0] + rng.next() * (brainBox[2] - brainBox[0])
      const y = brainBox[1] + rng.next() * (brainBox[3] - brainBox[1])
      const s = -g.cerebrum.sample(x, y)
      if (s <= 2 || s > 70) continue
      const T = cT(x, y)
      if (T < gap * 1.3) continue
      normal2(g.cerebrum, x, y, n2)
      const fw = 1 - smoothstep(0.1, 0.55, n2[1])
      if (rng.next() > fw * (1 - smoothstep(30, 70, s))) continue
      const side = rng.next() < 0.5 ? -1 : 1
      const z = side * gap
      push(wb, x - n2[0] * lipDepth, y - n2[1] * lipDepth, z, 0, 0, -side, 0, defaultSize(rng, 0.34) * 0.9, rng.next())
    }
    thinInto(wb, nWall, rng, out, 14)
  }

  /* cerebellum: folia as fine concentric arcs around the fastigium ------- */
  const cbT = (x, y) => cerebellumT(g, x, y)
  const foliaStep = 10
  const foliaR = (x, y) => Math.hypot(x - 1050, y - 458) + 3 * noise(x * 0.03, y * 0.03, 5.5)
  const cb = makeOut()
  sampleInflated(Math.round(nCerebellum * 2.6), rng, cbT, bboxOf(CEREBELLUM), {
    cap: 6,
    areaExp: 0.5,
    snap: (c) => {
      const r = foliaR(c.x, c.y)
      const k = Math.round(r / foliaStep)
      const off = k * foliaStep - r
      if (rng.next() < lineShare) {
        const dx = c.x - 1050, dy = c.y - 458
        const l = Math.hypot(dx, dy) || 1
        const j = off + (rng.next() - 0.5) * 1.2
        c.x += (dx / l) * j
        c.y += (dy / l) * j
        c.rf = mix(1, 0.4, folds)
        return true
      }
      return Math.abs(off) > 1 + clear * 0.6
    },
  }, (c) => {
    // vermis notch at the back
    normal2(g.cerebellum, c.x, c.y, n2)
    if (n2[0] > 0 && c.T < 26) {
      const k = 1 - c.T / 26
      const d = 7 * n2[0] * k * k
      c.x -= n2[0] * d
      c.y -= n2[1] * d
    }
    if (c.rf < 1) {
      const d = 4 * folds
      c.x -= c.nx * d
      c.y -= c.ny * d
      c.z -= c.nz * d
    }
    return 1
  }, (c) => push(cb, c.x, c.y, c.z, c.nx, c.ny, c.nz, 0, defaultSize(rng, 0.3) * 0.8, rng.next(), c.rf))
  thinInto(cb, nCerebellum, rng, out, 9)

  /* brainstem ---------------------------------------------------------- */
  const bsT = (x, y) => stemT(g, x, y)
  const bs = makeOut()
  sampleInflated(Math.round(nStem * 2), rng, bsT, bboxOf(BRAINSTEM), { cap: 5, areaExp: 0.6 }, (c) => {
    // a little fade where it hands over to the spinal column
    return 1 - 0.55 * smoothstep(660, 718, c.y)
  }, (c) => push(bs, c.x, c.y, c.z, c.nx, c.ny, c.nz, 0, defaultSize(rng, 0.34) * 0.92, rng.next()))
  thinInto(bs, nStem, rng, out, 10)

  /* spinal column (group 2) -------------------------------------------- */
  {
    const line = resample(catmullRom(SPINE.map(([x, y]) => [x, y, 0]), 24), 180)
    const frames = transportFrames(line)
    const L = line.length - 1
    const vertebrae = 9
    for (let k = 0, tries = 0; k < nSpine && tries < nSpine * 200; tries++) {
      const u = rng.next()
      const r = mix(46, 31, u)
      const rhythm = 0.5 + 0.5 * smoothstep(-0.35, 0.65, Math.cos(2 * Math.PI * (u * vertebrae + 0.25)))
      const ends = smoothstep(0, 0.09, u) * (1 - 0.6 * smoothstep(0.82, 1, u))
      if (rng.next() > rhythm * ends * (r / 46)) continue
      const i = Math.min(Math.round(u * L), L)
      const f = frames[i]
      const p = line[i]
      const a = rng.next() * Math.PI * 2
      const ca = Math.cos(a), sa = Math.sin(a)
      const rr = r * (rng.next() < 0.62 ? 1 + rng.normal() * 0.05 : Math.sqrt(rng.next()))
      const nx = f.N[0] * ca + f.B[0] * sa
      const ny = f.N[1] * ca + f.B[1] * sa
      const nz = f.N[2] * ca + f.B[2] * sa
      const x = p[0] + nx * rr, y = p[1] + ny * rr, z = p[2] + nz * rr
      push(out, x, y, z, nx, ny, nz, 2, defaultSize(rng, 0.38), downAux(x, y, z))
      k++
    }
  }

  /* head shell (group 1) ----------------------------------------------- */
  const nEar = Math.round(nHead * 0.07 * P.ear)
  const nLine = Math.round(nHead * 0.2 * P.profile)
  const nShell = nHead - nEar - nLine
  const hT = (x, y) => headT(g, x, y)
  const rimK = 0.5 * P.profile
  const shellDensity = (y) => {
    const neck = smoothstep(880, 990, y)
    const fade = smoothstep(1030, yCut, y)
    return mix(1, 0.8, neck) * mix(1, 0.14, fade)
  }
  const sizeHead = () => defaultSize(rng, 0.3) * 0.88
  sampleInflated(nShell, rng, hT, [560, 118, 1500, yCut], { cap: 12, areaExp: 1, maxTries: 400 }, (c) => {
    const rim = 1 - Math.abs(c.nz)
    return shellDensity(c.y) * ((1 - rimK) + rimK * rim * rim)
  }, (c) => push(out, c.x, c.y, c.z, c.nx, c.ny, c.nz, 1, sizeHead(), downAux(c.x, c.y, c.z)))

  // the sagittal profile itself (z ≈ 0 rim): a fine dotted contour that makes
  // forehead, nose, lips and chin read at a glance
  if (nLine > 0) {
    const orient = polygonOrientation(PROFILE)
    const segs = []
    let total = 0
    for (let i = 0; i < PROFILE.length; i++) {
      const a = PROFILE[i], b = PROFILE[(i + 1) % PROFILE.length]
      if (a[1] > yCut && b[1] > yCut) continue
      // the face (forehead → throat) carries most of the line
      const face = a[0] < 860 && a[1] > 300 && a[1] < 940 ? 2.6 : 1
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) * face
      total += len
      segs.push({ a, b, len, acc: total })
    }
    for (let k = 0, tries = 0; k < nLine && tries < nLine * 50; tries++) {
      const t = rng.next() * total
      let lo = 0, hi = segs.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (segs[mid].acc < t) lo = mid + 1
        else hi = mid
      }
      const sg = segs[lo]
      const f = 1 - (sg.acc - t) / sg.len
      const x = sg.a[0] + (sg.b[0] - sg.a[0]) * f
      const y = sg.a[1] + (sg.b[1] - sg.a[1]) * f
      if (y > yCut || rng.next() > shellDensity(y)) continue
      const el = Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]) || 1
      const nx = (orient * (sg.b[1] - sg.a[1])) / el
      const ny = (-orient * (sg.b[0] - sg.a[0])) / el
      const j = rng.normal() * 1.2
      push(out, x + nx * j, y + ny * j, rng.normal() * 3, nx, ny, 0, 1, sizeHead() * 0.92, downAux(x, y, 0))
      k++
    }
  }

  // ear relief: helix rim, antihelix, tragus (both sides)
  if (nEar > 0) {
    const parts = [
      { pl: resample(EAR_HELIX, 120), lift: (u) => 10 + 20 * Math.sin(Math.PI * Math.min(u * 1.15, 1)), w: 0.58 },
      { pl: resample(EAR_ANTIHELIX, 80), lift: () => 9, w: 0.3 },
      { pl: resample(EAR_TRAGUS, 20), lift: () => 8, w: 0.12 },
    ]
    for (let k = 0; k < nEar; k++) {
      const part = parts[rng.weighted(parts.map((q) => q.w))]
      const u = rng.next()
      const q = part.pl[Math.min(Math.round(u * (part.pl.length - 1)), part.pl.length - 1)]
      const x = q[0] + rng.normal() * 1.2
      const y = q[1] + rng.normal() * 1.2
      const side = rng.next() < 0.5 ? -1 : 1
      const z = side * (hT(x, y) + part.lift(u) + rng.normal() * 1.5)
      push(out, x, y, z, 0, 0, side, 1, sizeHead(), downAux(x, y, z))
    }
  }

  // top up if any sampler hit its try limit (never expected; keeps the contract)
  let fill = 0
  while (out.g.length < maxCount) {
    const i = (fill++ * 7919) % out.g.length
    push(out, out.p[i * 3] + rng.normal(), out.p[i * 3 + 1] + rng.normal(), out.p[i * 3 + 2] + rng.normal(),
      out.n[i * 3], out.n[i * 3 + 1], out.n[i * 3 + 2], out.g[i], out.s[i], out.a[i])
  }
  if (fill) console.warn(`[head] topped up ${fill} points`)

  // y down → y up
  for (let i = 1; i < out.p.length; i += 3) {
    out.p[i] = -out.p[i]
    out.n[i] = -out.n[i]
  }

  const shape = finalizeShape(
    { positions: out.p, normal: out.n, group: out.g, size: out.s, aux: out.a },
    {
      seed,
      maxCount,
      meta: {
        id: 'head',
        label: 'Head',
        life: 'neural',
        axis: [0, 1, 0],
        center: BRAIN_CENTER,
        frame: { h: 0.86 },
        groups: ['Brain', 'Head', 'Spine'],
        aux: 'group 0: random spark seed 0..1 · groups 1, 2: distance from the top of the brainstem, 0..1 (down the spine, out over the shell)',
      },
    },
  )
  shape.meta.genMs = Math.round(performance.now() - t0)
  return shape
}

export default {
  id: 'head',
  label: 'Head',
  order: 2,
  params: {
    brainShare: { value: 0.6, min: 0.4, max: 0.8, step: 0.01, label: 'Brain share' },
    headDensity: { value: 0.64, min: 0.1, max: 1, step: 0.01, label: 'Head density' },
    spine: { value: 0.08, min: 0, max: 0.16, step: 0.005, label: 'Spine share' },
    folds: { value: 0.8, min: 0, max: 1, step: 0.01, label: 'Folds' },
    gyri: { value: 1, min: 0.6, max: 1.6, step: 0.01, label: 'Gyri scale' },
    fissure: { value: 0.6, min: 0, max: 1, step: 0.01, label: 'Fissures' },
    profile: { value: 0.7, min: 0, max: 1, step: 0.01, label: 'Profile line' },
    shoulders: { value: 0.8, min: 0, max: 1, step: 0.01, label: 'Shoulders' },
    ear: { value: 1, min: 0, max: 1, step: 0.01, label: 'Ear' },
  },
  defaults: {
    particles: {
      size: 1.9,
      color: '#0d0d0d',
      colorB: '#0d0d0d',
      colorC: '#0d0d0d',
      opacityB: 0.32,
      opacityC: 0.8,
    },
    dissolve: { amount: 0.2, mode: 'linear', angle: -90 },
    motion: { mode: 'sway', swayAngle: 10 },
    life: { enabled: true, amount: 0.5 },
  },
  generate,
}
