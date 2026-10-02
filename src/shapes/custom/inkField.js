// Pixels → particles.
//
//   1. ink:     per-pixel 0..1 weight (alpha, or luminance against the detected
//               background), shaped by threshold + an S-curve contrast.
//   2. density: ink (tonal images keep their shading) + a Sobel edge boost, or a
//               band hugging the outline when strokeOnly.
//   3. sample:  systematic sampling along a Hilbert curve over the density
//               (each stratum holds 1/N of the ink), jittered inside the pixel.
//               Neighbouring strata are spatially close, so the dots come out
//               blue-noise-like at every density, no clumps, no scanlines.
//   4. lift:    a pillow from the distance transform. The local radius is a
//               max-filtered distance, so thin strokes become round tubes and
//               blobs become round cushions; optional slab extrusion with side
//               walls, and luminance relief. Normals from the height field.

import { createRng } from '../lib/rng.js'

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/* ----------------------------------------------------------------- ink --- */

export function computeInk(img, p = {}) {
  const { width: W, height: H, data } = img
  const n = W * H
  const lum = new Float32Array(n)
  const alpha = new Float32Array(n)
  let transparent = 0
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255
    // luminance of the pixel composited over white
    const l = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255
    lum[i] = l * a + (1 - a)
    alpha[i] = a
    if (a < 0.06) transparent++
  }
  let mode = p.ink || 'auto'
  if (mode === 'auto') mode = transparent > n * 0.02 ? 'alpha' : 'luma'

  const ink = new Float32Array(n)
  let lightOnDark = false
  if (mode === 'alpha') {
    // opaque near-white details inside a dark mark are not ink, unless the
    // whole mark is white (white logo on transparent)
    let sumL = 0
    let sumA = 0
    for (let i = 0; i < n; i++) {
      if (alpha[i] > 0.5) {
        const l = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255
        sumL += l
        sumA++
      }
    }
    const markIsWhite = sumA > 0 && sumL / sumA > 0.86
    for (let i = 0; i < n; i++) {
      const a = alpha[i]
      if (markIsWhite) ink[i] = a
      else {
        const l = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255
        ink[i] = a * (1 - smooth(0.86, 0.98, l))
      }
    }
  } else {
    // background = median luminance of a thin border ring; ink is measured
    // relative to it, so tinted paper or a grey backdrop reads as empty
    const ring = Math.max(2, Math.round(Math.min(W, H) * 0.03))
    const border = []
    for (let y = 0; y < H; y++) {
      const full = y < ring || y >= H - ring
      for (let x = 0; x < W; x++) {
        if (!full && x === ring) x = W - ring
        border.push(lum[y * W + x])
      }
    }
    const sorted = Float32Array.from(border).sort()
    const bg = sorted.length ? sorted[sorted.length >> 1] : 1
    lightOnDark = bg < 0.5
    // 1 px denoise: film grain / JPEG noise must not turn into stray dots
    const L = boxBlur(lum, W, H, 1)
    const span = lightOnDark ? Math.max(1 - bg, 0.05) : Math.max(bg, 0.05)
    for (let i = 0; i < n; i++) ink[i] = clamp01((lightOnDark ? L[i] - bg : bg - L[i]) / span)
  }
  if (p.invert) for (let i = 0; i < n; i++) ink[i] = 1 - ink[i]

  // threshold + S-curve contrast (1 = linear, >1 pushes towards a binary mask)
  const th = clamp01(+p.threshold || 0)
  const k = Math.max(0.2, +(p.contrast ?? 1))
  const inv = 1 / Math.max(1e-6, 1 - th)
  let total = 0
  for (let i = 0; i < n; i++) {
    let t = clamp01((ink[i] - th) * inv)
    if (k !== 1 && t > 0 && t < 1) {
      const a = Math.pow(t, k)
      t = a / (a + Math.pow(1 - t, k))
    }
    ink[i] = t
    total += t
  }
  if (total < 2) {
    throw new Error('The image is empty: no ink found. Try invert, a lower threshold, or another ink mode')
  }
  if (total > n * 0.985) {
    throw new Error('The whole image reads as ink: try invert or a higher threshold')
  }
  return { ink, mode, lightOnDark }
}

/* ------------------------------------------------------------ fields ----- */

// Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher), 1D pass.
function edt1d(f, n, d, v, z) {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    let s
    for (;;) {
      const r = v[k]
      s = (f[q] + q * q - (f[r] + r * r)) / (2 * q - 2 * r)
      if (s <= z[k] && k > 0) k--
      else break
    }
    if (s <= z[k]) {
      v[0] = q
      z[0] = -Infinity
      z[1] = Infinity
      k = 0
      continue
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const r = v[k]
    d[q] = (q - r) * (q - r) + f[r]
  }
}

// Distance (px) from every inside pixel to the nearest outside pixel; the
// canvas border counts as outside.
export function insideDistance(mask, W, H) {
  const PW = W + 2
  const PH = H + 2
  const INF = 1e20
  const g = new Float64Array(PW * PH)
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      const inside = x > 0 && y > 0 && x <= W && y <= H && mask[(y - 1) * W + (x - 1)]
      g[y * PW + x] = inside ? INF : 0
    }
  }
  const m = Math.max(PW, PH)
  const f = new Float64Array(m)
  const d = new Float64Array(m)
  const v = new Int32Array(m)
  const z = new Float64Array(m + 1)
  for (let x = 0; x < PW; x++) {
    for (let y = 0; y < PH; y++) f[y] = g[y * PW + x]
    edt1d(f, PH, d, v, z)
    for (let y = 0; y < PH; y++) g[y * PW + x] = d[y]
  }
  for (let y = 0; y < PH; y++) {
    const o = y * PW
    for (let x = 0; x < PW; x++) f[x] = g[o + x]
    edt1d(f, PW, d, v, z)
    for (let x = 0; x < PW; x++) g[o + x] = d[x]
  }
  const out = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) out[y * W + x] = Math.sqrt(g[(y + 1) * PW + x + 1])
  }
  return out
}

// Running max over a window of `r` px each side (van Herk / Gil-Werman), separable.
function maxFilter(src, W, H, r) {
  const tmp = new Float32Array(W * H)
  const out = new Float32Array(W * H)
  const pass = (inp, outp, len, count, stride, step) => {
    const k = 2 * r + 1
    const g = new Float32Array(len + k)
    const h = new Float32Array(len + k)
    for (let c = 0; c < count; c++) {
      const base = c * stride
      const at = (i) => (i < r || i >= len + r ? 0 : inp[base + (i - r) * step])
      const L = len + 2 * r
      for (let i = 0; i < L; i++) g[i] = i % k === 0 ? at(i) : Math.max(g[i - 1], at(i))
      for (let i = L - 1; i >= 0; i--) h[i] = i === L - 1 || (i + 1) % k === 0 ? at(i) : Math.max(h[i + 1], at(i))
      for (let i = 0; i < len; i++) outp[base + i * step] = Math.max(h[i], g[Math.min(i + 2 * r, L - 1)])
    }
  }
  pass(src, tmp, W, H, W, 1)
  pass(tmp, out, H, W, 1, W)
  return out
}

// Box blur, radius r, separable (sliding sum), clamped edges.
export function boxBlur(src, W, H, r) {
  if (r < 1) return src.slice()
  const tmp = new Float32Array(W * H)
  const out = new Float32Array(W * H)
  const pass = (inp, outp, len, count, stride, step) => {
    const k = 2 * r + 1
    for (let c = 0; c < count; c++) {
      const base = c * stride
      const at = (i) => inp[base + Math.min(Math.max(i, 0), len - 1) * step]
      let s = 0
      for (let i = -r; i <= r; i++) s += at(i)
      for (let i = 0; i < len; i++) {
        outp[base + i * step] = s / k
        s += at(i + r + 1) - at(i - r)
      }
    }
  }
  pass(src, tmp, W, H, W, 1)
  pass(tmp, out, H, W, 1, W)
  return out
}

// Sobel gradient of `v`; returns gx, gy and magnitude normalised to 0..1.
function sobel(v, W, H) {
  const gx = new Float32Array(W * H)
  const gy = new Float32Array(W * H)
  const mag = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(y - 1, 0) * W
    const y1 = y * W
    const y2 = Math.min(y + 1, H - 1) * W
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(x - 1, 0)
      const x2 = Math.min(x + 1, W - 1)
      const a = v[y0 + x0], b = v[y0 + x], c = v[y0 + x2]
      const d = v[y1 + x0], f = v[y1 + x2]
      const g = v[y2 + x0], h = v[y2 + x], i = v[y2 + x2]
      const sx = c + 2 * f + i - (a + 2 * d + g)
      const sy = g + 2 * h + i - (a + 2 * b + c)
      gx[y1 + x] = sx
      gy[y1 + x] = sy
      mag[y1 + x] = Math.min(1, Math.hypot(sx, sy) * 0.25)
    }
  }
  return { gx, gy, mag }
}

/* ----------------------------------------------------- hilbert sampling --- */

// Hilbert index → (x, y) for an n × n grid (n power of two).
function d2xy(n, d, out) {
  let x = 0
  let y = 0
  let t = d
  for (let s = 1; s < n; s *= 2) {
    const rx = 1 & (t >> 1)
    const ry = 1 & (t ^ rx)
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x
        y = s - 1 - y
      }
      const tmp = x
      x = y
      y = tmp
    }
    x += s * rx
    y += s * ry
    t >>= 2
  }
  out[0] = x
  out[1] = y
}

const hilbertCache = new Map()
// Pixel indices of a W × H grid in Hilbert order (cached per size).
function hilbertOrder(W, H) {
  const key = W + 'x' + H
  if (hilbertCache.has(key)) return hilbertCache.get(key)
  let n = 1
  while (n < Math.max(W, H)) n *= 2
  const order = new Uint32Array(W * H)
  const xy = [0, 0]
  let k = 0
  for (let d = 0, end = n * n; d < end && k < order.length; d++) {
    d2xy(n, d, xy)
    if (xy[0] < W && xy[1] < H) order[k++] = xy[1] * W + xy[0]
  }
  hilbertCache.set(key, order)
  if (hilbertCache.size > 3) hilbertCache.delete(hilbertCache.keys().next().value)
  return order
}

// N jittered sample positions (pixel coords) with density ∝ weight.
function hilbertSample(weight, W, H, N, rng) {
  const order = hilbertOrder(W, H)
  let total = 0
  for (let i = 0; i < weight.length; i++) total += weight[i]
  const step = total / N
  const xs = new Float32Array(N)
  const ys = new Float32Array(N)
  let acc = 0
  let k = 0
  let next = rng.next() * step
  for (let o = 0; o < order.length && k < N; o++) {
    const i = order[o]
    const w = weight[i]
    if (w <= 0) continue
    acc += w
    while (acc > next && k < N) {
      xs[k] = (i % W) + rng.next()
      ys[k] = Math.floor(i / W) + rng.next()
      k++
      next = (k + rng.next()) * step
    }
  }
  // float round-off can leave the last stratum or two empty
  while (k < N) {
    const j = Math.floor(rng.next() * Math.max(1, k))
    xs[k] = xs[j] + rng.next() - 0.5
    ys[k] = ys[j] + rng.next() - 0.5
    k++
  }
  return { xs, ys }
}

/* --------------------------------------------------------------- lift ---- */

function bilinear(f, W, H, x, y) {
  const fx = Math.min(Math.max(x - 0.5, 0), W - 1.001)
  const fy = Math.min(Math.max(y - 0.5, 0), H - 1.001)
  const x0 = fx | 0
  const y0 = fy | 0
  const tx = fx - x0
  const ty = fy - y0
  const i = y0 * W + x0
  const a = f[i] + (f[i + 1] - f[i]) * tx
  const b = f[i + W] + (f[i + W + 1] - f[i + W]) * tx
  return a + (b - a) * ty
}

/**
 * Pixels → raw particle arrays (pixel units, Y up) ready for finalizeShape.
 * opts: N, seed, threshold, contrast, invert, ink, edges, strokeOnly,
 *       strokeWidth, depth, extrude, relief, volume
 */
export function sampleImage(img, opts = {}) {
  const t0 = performance.now()
  const { width: W, height: H } = img
  const N = opts.N || 8000
  const rng = createRng(opts.seed ?? 1)
  const { ink, mode } = computeInk(img, opts)
  const n = W * H

  // solid mask (for the distance transform / pillow) + its bbox
  const mask = new Uint8Array(n)
  let minX = W, minY = H, maxX = -1, maxY = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (ink[i] > 0.25) {
        mask[i] = 1
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) {
    // faint tonal image: fall back to its ink bbox
    for (let i = 0; i < n; i++) if (ink[i] > 0) {
      const x = i % W, y = (i / W) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const span = Math.max(maxX - minX + 1, maxY - minY + 1, 8)

  const dist = insideDistance(mask, W, H)
  let dMax = 0
  for (let i = 0; i < n; i++) if (dist[i] > dMax) dMax = dist[i]
  const { gx, gy, mag } = sobel(ink, W, H)

  // density
  const edges = clamp01(+opts.edges || 0)
  const weight = new Float32Array(n)
  if (opts.strokeOnly) {
    const sw = Math.max(0.75, +opts.strokeWidth || 3) * (W > H ? W : H) / 1024
    for (let i = 0; i < n; i++) {
      const band = mask[i] ? clamp01(1 - (dist[i] - sw) / 1.25) : ink[i] * 0.9
      weight[i] = Math.max(band, mag[i] * 0.6)
    }
  } else {
    for (let i = 0; i < n; i++) weight[i] = ink[i] + edges * 3 * mag[i] * mag[i]
  }
  let wSum = 0
  for (let i = 0; i < n; i++) wSum += weight[i]
  if (wSum < 1) throw new Error('The image is empty: nothing left to sample after threshold / stroke settings')

  // height fields (px): pillow half-thickness T, relief offset R
  const depth = Math.max(0, +(opts.depth ?? 0.6))
  const ext = Math.max(0, +opts.extrude || 0) * span * 0.5
  const relief = +opts.relief || 0
  let T = null
  if (depth > 0 && dMax > 0) {
    // local radius: max inside-distance within ~one stroke width, softened
    const r = Math.max(2, Math.min(Math.round(dMax * 1.2), Math.round(span * 0.2)))
    let S = maxFilter(dist, W, H, r)
    S = boxBlur(S, W, H, Math.max(1, Math.round(r * 0.35)))
    T = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const d = dist[i]
      if (d <= 0) continue
      const s = Math.max(S[i], d)
      T[i] = depth * Math.sqrt(Math.max(0, d * (2 * s - d)))
    }
    T = boxBlur(T, W, H, 1)
  }
  let R = null
  if (relief !== 0) {
    const soft = boxBlur(ink, W, H, Math.max(1, Math.round(span / 300)))
    R = new Float32Array(n)
    const amp = relief * span * 0.12
    for (let i = 0; i < n; i++) R[i] = amp * (soft[i] - 0.5)
  }

  // wall share when extruded: area of the side walls vs both faces
  let walls = null
  let Nw = 0
  if (ext > 0.5) {
    walls = []
    let area = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (!mask[i]) continue
        area++
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - W] || !mask[i + W]) walls.push(i)
      }
    }
    // boundary pixel count overestimates the perimeter (~×1.15 for curves)
    const perim = walls.length / 1.15
    const share = (perim * 2 * ext) / (perim * 2 * ext + 2 * area)
    Nw = opts.strokeOnly ? Math.round(N * share * 0.5) : Math.round(N * share)
    if (!walls.length) Nw = 0
  }
  const Nf = N - Nw
  const { xs, ys } = hilbertSample(weight, W, H, Nf, rng)

  const volume = clamp01(+opts.volume || 0)
  const cx = (minX + maxX + 1) / 2
  const cy = (minY + maxY + 1) / 2
  const positions = new Float32Array(N * 3)
  const normal = new Float32Array(N * 3)
  const aux = new Float32Array(N)
  const size = new Float32Array(N)
  const e = 1.25
  const gradAt = (f, x, y, out) => {
    out[0] = (bilinear(f, W, H, x + e, y) - bilinear(f, W, H, x - e, y)) / (2 * e)
    out[1] = (bilinear(f, W, H, x, y + e) - bilinear(f, W, H, x, y - e)) / (2 * e)
  }
  const gT = [0, 0]
  const gR = [0, 0]
  const put = (k, x, y, z, nx, ny, nz) => {
    positions[k * 3] = x - cx
    positions[k * 3 + 1] = cy - y // image Y down → world Y up
    positions[k * 3 + 2] = z
    const l = Math.hypot(nx, ny, nz) || 1
    normal[k * 3] = nx / l
    normal[k * 3 + 1] = -ny / l
    normal[k * 3 + 2] = nz / l
  }

  for (let k = 0; k < Nf; k++) {
    const x = xs[k]
    const y = ys[k]
    const t = (T ? bilinear(T, W, H, x, y) : 0) + (bilinear(dist, W, H, x, y) > 0.5 ? ext : 0)
    const r = R ? bilinear(R, W, H, x, y) : 0
    if (T) gradAt(T, x, y, gT)
    else gT[0] = gT[1] = 0
    if (R) gradAt(R, x, y, gR)
    else gR[0] = gR[1] = 0
    if (volume > 0 && rng.next() < volume) {
      const u = rng.next() * 2 - 1
      const z = r + t * u
      put(k, x, y, z, -gT[0] * Math.abs(u) - gR[0], -gT[1] * Math.abs(u) - gR[1], u)
    } else if (rng.next() < 0.5) {
      put(k, x, y, r + t, -(gT[0] + gR[0]), -(gT[1] + gR[1]), 1)
    } else {
      put(k, x, y, r - t, gT[0] - gR[0], gT[1] - gR[1], -1)
    }
    const v = bilinear(ink, W, H, x, y)
    aux[k] = clamp01(v)
  }
  // side walls of the extrusion: outward normal = -∇ink
  for (let k = Nf; k < N; k++) {
    const i = walls[Math.floor(rng.next() * walls.length)]
    const x = (i % W) + rng.next()
    const y = Math.floor(i / W) + rng.next()
    const t = (T ? bilinear(T, W, H, x, y) : 0) + ext
    const r = R ? bilinear(R, W, H, x, y) : 0
    const u = rng.next() * 2 - 1
    put(k, x, y, r + t * u, -gx[i], -gy[i], 0)
    aux[k] = 1
  }

  // size: log-normal, slightly larger in dense ink so tonal images keep weight
  let sMean = 0
  for (let k = 0; k < N; k++) {
    const s = Math.min(Math.max(Math.exp(rng.normal() * 0.36 - 0.065), 0.35), 2.6) * (0.8 + 0.35 * aux[k])
    size[k] = s
    sMean += s
  }
  sMean /= N
  for (let k = 0; k < N; k++) size[k] = Math.min(Math.max(size[k] / sMean, 0.3), 2.6)

  return {
    positions,
    normal,
    size,
    aux,
    info: {
      width: W,
      height: H,
      span,
      aspect: (maxX - minX + 1) / Math.max(1, maxY - minY + 1),
      inkMode: mode,
      walls: Nw,
      ms: Math.round(performance.now() - t0),
    },
  }
}
