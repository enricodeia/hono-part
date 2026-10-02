// CPU twin of the particle vertex shader (glsl.js PARTICLE_VERT): morph path,
// life displacement, dissolve scatter, model transform. The hover simulation
// and the morph capture both read positions through here, so what the cursor
// pushes is exactly what is on screen. Keep the two in sync line by line.

import { PI, TAU, bump } from './util.js'

const HELIX_LUT = 1024

export const LIFE_TYPES = { none: 0, wave: 1, heartbeat: 2, helix: 3, neural: 4, breath: 5 }
export const MORPH_STYLES = { flow: 0, explode: 1, sweep: 2 }
export const DISSOLVE_MODES = { linear: 0, mirror: 1, radial: 2 }

// Plain-number mirror of every uniform that moves a particle. ParticleField
// writes it once per frame, then copies it to the GPU uniforms.
export function createMotionState() {
  return {
    morphP: 1,
    stagger: 0,
    morphTurb: 0,
    morphStyle: 0,
    lifeType: 0,
    lifeAmt: 0,
    lifeT: 0,
    helixPh: 0,
    center: [0, 0, 0],
    axis: [0, 1, 0],
    model: null, // THREE.Matrix4.elements (column-major), shared by reference
    frameRot: null, // THREE.Matrix3.elements
    viewRotInv: null, // THREE.Matrix3.elements
    dissMode: 0,
    dirX: 1,
    dirY: 0,
    dissAmt: 0,
    dissSoft: 0.35,
    dissLen: 0.7,
    dissTurb: 0.5,
    dissT: 0,
    dissMin: -1,
    dissMax: 1,
    dissRad: 1,
  }
}

export class Kinematics {
  constructor(A, M) {
    this.A = A
    this.M = M
    this.pre = new Float64Array(3) // after morph, before life (dissolve band + wander input)
    this.base = new Float64Array(3) // after life, object space
    this.nrm = new Float64Array(3)
    this.world = new Float64Array(3) // after model + dissolve, before hover offset
    this.e = 1
    this.k = 0
    // helix rotation as a function of aux, tabulated once per frame (see prepare)
    this.hcos = new Float64Array(HELIX_LUT + 1)
    this.hsin = new Float64Array(HELIX_LUT + 1)
  }

  // per-frame precomputation; call after the motion state changed, before local()/worldAt()
  prepare() {
    const M = this.M
    if (M.lifeType !== 3) return
    const hc = this.hcos, hs = this.hsin
    for (let j = 0; j <= HELIX_LUT; j++) {
      const ang = M.helixPh + M.lifeAmt * 0.3 * Math.sin((j / HELIX_LUT) * TAU - M.lifeT * 0.8)
      hc[j] = Math.cos(ang)
      hs[j] = Math.sin(ang)
    }
  }

  // object-space position after morph + life
  local(i) {
    const { A, M } = this
    const i3 = i * 3
    let t = 1
    if (M.morphP < 1) {
      const S = M.stagger
      t = (M.morphP - A.fromData[i * 4 + 2] * S) / Math.max(1 - S, 1e-4)
      t = t < 0 ? 0 : t > 1 ? 1 : t
    }
    const e = t * t * t * (t * (t * 6 - 15) + 10)
    this.e = e
    let dm = 0
    if (M.morphTurb > 0 && t > 0 && t < 1) dm = (M.morphStyle === 1 ? Math.sin(PI * Math.pow(t, 0.55)) : Math.sin(PI * e)) * M.morphTurb
    const P = A.position, F = A.from, D = A.detour
    let x = F[i3] + (P[i3] - F[i3]) * e + D[i3] * dm
    let y = F[i3 + 1] + (P[i3 + 1] - F[i3 + 1]) * e + D[i3 + 1] * dm
    let z = F[i3 + 2] + (P[i3 + 2] - F[i3 + 2]) * e + D[i3 + 2] * dm
    const pre = this.pre
    pre[0] = x
    pre[1] = y
    pre[2] = z

    const Nn = A.normal, FN = A.fromNormal
    let nx = FN[i3] + (Nn[i3] - FN[i3]) * e
    let ny = FN[i3 + 1] + (Nn[i3 + 1] - FN[i3 + 1]) * e
    let nz = FN[i3 + 2] + (Nn[i3 + 2] - FN[i3 + 2]) * e
    const nl = Math.max(Math.sqrt(nx * nx + ny * ny + nz * nz), 1e-4)
    nx /= nl
    ny /= nl
    nz /= nl

    const type = M.lifeType
    const amt = M.lifeAmt
    if (type === 3) {
      // ang = helixPh + amt * 0.3 * sin(aux * TAU - lifeT * 0.8), periodic in aux: read the table
      const aux = A.data[i * 4 + 2]
      let u = (aux - Math.floor(aux)) * HELIX_LUT
      const j = u | 0
      u -= j
      const co = this.hcos[j] + (this.hcos[j + 1] - this.hcos[j]) * u
      const si = this.hsin[j] + (this.hsin[j + 1] - this.hsin[j]) * u
      const c = M.center, a = M.axis
      const vx = x - c[0], vy = y - c[1], vz = z - c[2]
      const d = a[0] * vx + a[1] * vy + a[2] * vz
      x = c[0] + vx * co + (a[1] * vz - a[2] * vy) * si + a[0] * d * (1 - co)
      y = c[1] + vy * co + (a[2] * vx - a[0] * vz) * si + a[1] * d * (1 - co)
      z = c[2] + vz * co + (a[0] * vy - a[1] * vx) * si + a[2] * d * (1 - co)
      const dn = a[0] * nx + a[1] * ny + a[2] * nz
      const rx = nx * co + (a[1] * nz - a[2] * ny) * si + a[0] * dn * (1 - co)
      const ry = ny * co + (a[2] * nx - a[0] * nz) * si + a[1] * dn * (1 - co)
      const rz = nz * co + (a[0] * ny - a[1] * nx) * si + a[2] * dn * (1 - co)
      nx = rx
      ny = ry
      nz = rz
    } else if (amt > 0) {
      const aux = A.data[i * 4 + 2]
      if (type === 1) {
        const ph = aux * 18.85 - M.lifeT * 1.7
        const w = (Math.sin(ph) * 0.7 + Math.sin(ph * 0.43 + 1.3) * 0.3) * amt * 0.028
        x += nx * w
        y += ny * w
        z += nz * w
      } else if (type === 2) {
        let tau = M.lifeT - aux * 0.13
        tau -= Math.floor(tau)
        const c = bump(tau - 0.1, 0.075) + 0.6 * bump(tau - 0.3, 0.085)
        const s = c * amt * 0.07
        const sn = c * amt * 0.012
        const C = M.center
        x -= (x - C[0]) * s + nx * sn
        y -= (y - C[1]) * s + ny * sn
        z -= (z - C[2]) * s + nz * sn
      } else if (type === 5) {
        const s = 1 + Math.sin(M.lifeT * 1.15) * amt * 0.03
        const C = M.center
        x = C[0] + (x - C[0]) * s
        y = C[1] + (y - C[1]) * s
        z = C[2] + (z - C[2]) * s
      }
      // type 4 (neural) changes size and tone only
    }
    const b = this.base
    b[0] = x
    b[1] = y
    b[2] = z
    const n = this.nrm
    n[0] = nx
    n[1] = ny
    n[2] = nz
    return b
  }

  // world position the GPU draws, minus the hover offset (aOffset) and wander
  worldAt(i) {
    const { A, M } = this
    this.local(i)
    const b = this.base
    const m = M.model
    let wx = m[0] * b[0] + m[4] * b[1] + m[8] * b[2] + m[12]
    let wy = m[1] * b[0] + m[5] * b[1] + m[9] * b[2] + m[13]
    let wz = m[2] * b[0] + m[6] * b[1] + m[10] * b[2] + m[14]
    this.k = 0
    if (M.dissAmt > 0) {
      const p = this.pre
      const R = M.frameRot
      const qx = R[0] * p[0] + R[3] * p[1] + R[6] * p[2]
      const qy = R[1] * p[0] + R[4] * p[1] + R[7] * p[2]
      let s, dx, dy
      if (M.dissMode === 2) {
        const l = Math.sqrt(qx * qx + qy * qy)
        s = l / Math.max(M.dissRad, 1e-4)
        if (l > 1e-4) {
          dx = qx / l
          dy = qy / l
        } else {
          dx = M.dirX
          dy = M.dirY
        }
      } else {
        const pr = qx * M.dirX + qy * M.dirY
        if (M.dissMode === 1) {
          const mid = 0.5 * (M.dissMin + M.dissMax)
          const hw = Math.max(0.5 * (M.dissMax - M.dissMin), 1e-4)
          s = Math.abs(pr - mid) / hw
          const sg = pr >= mid ? 1 : -1
          dx = M.dirX * sg
          dy = M.dirY * sg
        } else {
          s = (pr - M.dissMin) / Math.max(M.dissMax - M.dissMin, 1e-4)
          dx = M.dirX
          dy = M.dirY
        }
      }
      const e = this.e
      const i4 = i * 4
      const NZ = A.noise, NF = A.noiseFrom, RA = A.rand
      const soft = M.dissSoft
      const sj = s + (NF[i4] + (NZ[i4] - NF[i4]) * e) * soft * 0.5 + (RA[i4] - 0.5) * soft * 0.35
      const edge = 1 + 1.2 * soft + (-2.4 * soft - 1) * M.dissAmt
      let k = (sj - (edge - 0.5 * soft)) / soft
      k = k < 0 ? 0 : k > 1 ? 1 : k
      k = k * k * (3 - 2 * k)
      if (k > 0) {
        let ph = M.dissT * (0.5 + 0.8 * RA[i4 + 2]) + RA[i4 + 3]
        ph -= Math.floor(ph)
        const along = M.dissLen * ((0.1 + 0.6 * RA[i4 + 1]) * (0.3 + 0.7 * k) + 0.4 * ph)
        const tb = M.dissLen * 0.4 * M.dissTurb
        const kk = k * k
        const SC = A.scatter
        const i3 = i * 3
        const cx = NF[i4 + 1] + (NZ[i4 + 1] - NF[i4 + 1]) * e
        const cy = NF[i4 + 2] + (NZ[i4 + 2] - NF[i4 + 2]) * e
        const cz = NF[i4 + 3] + (NZ[i4 + 3] - NF[i4 + 3]) * e
        const ox = (dx * along + (cx * 0.8 + SC[i3] * 0.35) * tb) * kk
        const oy = (dy * along + (cy * 0.8 + SC[i3 + 1] * 0.35) * tb) * kk
        const oz = (cz * 0.8 + SC[i3 + 2] * 0.35) * tb * kk
        const V = M.viewRotInv
        wx += V[0] * ox + V[3] * oy + V[6] * oz
        wy += V[1] * ox + V[4] * oy + V[7] * oz
        wz += V[2] * ox + V[5] * oy + V[8] * oz
      }
      this.k = k
    }
    const w = this.world
    w[0] = wx
    w[1] = wy
    w[2] = wz
    return w
  }
}
