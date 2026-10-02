// CPU noise for the runtime. Used only at shape-change time: coherent values
// are baked into per-particle attributes (band noise, curl turbulence, morph
// detours) so the GPU and the CPU hover simulation read identical numbers.

import { rng32 } from './util.js'

const GRAD3 = new Float32Array([1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1])
const F3 = 1 / 3
const G3 = 1 / 6

// Gustavson simplex noise, seeded permutation. Returns ~[-1, 1].
export function createSimplex3(seed = 1) {
  const rand = rng32(seed)
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = p[i]
    p[i] = p[j]
    p[j] = t
  }
  const perm = new Uint8Array(512)
  const permMod12 = new Uint8Array(512)
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255]
    permMod12[i] = perm[i] % 12
  }
  return function noise(x, y, z) {
    const s = (x + y + z) * F3
    const i = Math.floor(x + s)
    const j = Math.floor(y + s)
    const k = Math.floor(z + s)
    const t = (i + j + k) * G3
    const x0 = x - (i - t)
    const y0 = y - (j - t)
    const z0 = z - (k - t)
    let i1, j1, k1, i2, j2, k2
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0 }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1 }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1 }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1 }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1 }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0 }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3
    const ii = i & 255, jj = j & 255, kk = k & 255
    let n = 0
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0
    if (t0 > 0) {
      const g = permMod12[ii + perm[jj + perm[kk]]] * 3
      t0 *= t0
      n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0)
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1
    if (t1 > 0) {
      const g = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3
      t1 *= t1
      n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1)
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2
    if (t2 > 0) {
      const g = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3
      t2 *= t2
      n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2)
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3
    if (t3 > 0) {
      const g = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3
      t3 *= t3
      n += t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3)
    }
    return 32 * n
  }
}

// A static flow field sampled on a coarse grid and read back with trilinear
// interpolation: [band noise, curl.x, curl.y, curl.z] at any point.
// The curl is divergence-free, so dust and morph paths stream in ribbons
// instead of collapsing into clumps.
export function createFlowField(seed = 7, { res = 14, extent = 2.8, freq = 0.62 } = {}) {
  const a = createSimplex3(seed)
  const b = createSimplex3(seed + 101)
  const c = createSimplex3(seed + 202)
  const band = createSimplex3(seed + 303)
  const data = new Float32Array(res * res * res * 4)
  const step = (2 * extent) / (res - 1)
  const h = 0.08
  let maxLen = 1e-6
  for (let iz = 0; iz < res; iz++) {
    for (let iy = 0; iy < res; iy++) {
      for (let ix = 0; ix < res; ix++) {
        const x = (-extent + ix * step) * freq
        const y = (-extent + iy * step) * freq
        const z = (-extent + iz * step) * freq
        // potential ψ = (a, b, c); curl ψ by central differences
        const dCdy = (c(x, y + h, z) - c(x, y - h, z)) / (2 * h)
        const dBdz = (b(x, y, z + h) - b(x, y, z - h)) / (2 * h)
        const dAdz = (a(x, y, z + h) - a(x, y, z - h)) / (2 * h)
        const dCdx = (c(x + h, y, z) - c(x - h, y, z)) / (2 * h)
        const dBdx = (b(x + h, y, z) - b(x - h, y, z)) / (2 * h)
        const dAdy = (a(x, y + h, z) - a(x, y - h, z)) / (2 * h)
        const cx = dCdy - dBdz
        const cy = dAdz - dCdx
        const cz = dBdx - dAdy
        const o = ((iz * res + iy) * res + ix) * 4
        data[o] = band(x * 2.3, y * 2.3, z * 2.3) * 0.7 + band(x * 5.1 + 9.1, y * 5.1, z * 5.1) * 0.3
        data[o + 1] = cx
        data[o + 2] = cy
        data[o + 3] = cz
        const l = Math.hypot(cx, cy, cz)
        if (l > maxLen) maxLen = l
      }
    }
  }
  // normalise the curl so its largest vector is ~1.4 (typical ~0.6)
  const inv = 1.4 / maxLen
  for (let i = 0; i < data.length; i += 4) {
    data[i + 1] *= inv
    data[i + 2] *= inv
    data[i + 3] *= inv
  }
  const toGrid = (v) => {
    const g = (v + extent) / step
    return g < 0 ? 0 : g > res - 1.0001 ? res - 1.0001 : g
  }
  // writes 4 floats into out[o..o+3]
  function sample(x, y, z, out, o = 0) {
    const gx = toGrid(x), gy = toGrid(y), gz = toGrid(z)
    const x0 = gx | 0, y0 = gy | 0, z0 = gz | 0
    const fx = gx - x0, fy = gy - y0, fz = gz - z0
    for (let ch = 0; ch < 4; ch++) {
      let acc = 0
      for (let dz = 0; dz < 2; dz++) {
        const wz = dz ? fz : 1 - fz
        for (let dy = 0; dy < 2; dy++) {
          const wy = dy ? fy : 1 - fy
          const row = ((z0 + dz) * res + (y0 + dy)) * res
          const v0 = data[(row + x0) * 4 + ch]
          const v1 = data[(row + x0 + 1) * 4 + ch]
          acc += wz * wy * (v0 + (v1 - v0) * fx)
        }
      }
      out[o + ch] = acc
    }
    return out
  }
  return { sample, extent }
}
