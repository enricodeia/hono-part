// 3D models (GLB / glTF / OBJ / STL) → particles.
// Every mesh is merged with its world transform (instances included), the
// surface is sampled area-weighted with MeshSurfaceSampler (4× candidates) and
// thinned to a Poisson-disk-like set by weighted sample elimination. 'volume'
// moves a share of the dots inside: the mesh is voxelised, the outside flood
// filled, and the remaining cells sampled the same way.

import * as THREE from 'three'
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js'
import { createRng } from '../lib/rng.js'
import { eliminate } from './poisson.js'

export const MODEL_EXT = ['glb', 'gltf', 'obj', 'stl']
const DRACO_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/'

function extOf(name = '') {
  const m = /\.([a-z0-9]+)$/i.exec(name)
  return m ? m[1].toLowerCase() : ''
}

async function readBuffer(src) {
  if (src instanceof ArrayBuffer) return src
  if (ArrayBuffer.isView(src)) return src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength)
  if (typeof src === 'string') return new TextEncoder().encode(src).buffer
  if (src && typeof src.arrayBuffer === 'function') return src.arrayBuffer()
  throw new Error('Model source must be a File, Blob, ArrayBuffer or string')
}

let dracoLoader = null

export async function loadModel(data, name = 'model.glb') {
  const ext = extOf(name)
  const buf = await readBuffer(data)
  if (!buf.byteLength) throw new Error(`"${name}" is empty`)
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength))
  const isGlb = head[0] === 0x67 && head[1] === 0x6c && head[2] === 0x54 && head[3] === 0x46 // 'glTF'
  if (isGlb || ext === 'glb' || ext === 'gltf') {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
    const loader = new GLTFLoader()
    const text = isGlb ? '' : new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 1 << 20)))
    if (isGlb || /KHR_draco_mesh_compression/.test(text)) {
      if (!dracoLoader) {
        const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js')
        dracoLoader = new DRACOLoader().setDecoderPath(DRACO_PATH)
      }
      loader.setDRACOLoader(dracoLoader)
    }
    try {
      const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js')
      loader.setMeshoptDecoder(MeshoptDecoder)
    } catch {
      // meshopt is optional
    }
    if (!isGlb && /"uri"\s*:\s*"(?!data:)/.test(text)) {
      throw new Error('This .gltf references external files (.bin / textures). Export it as a single .glb instead')
    }
    try {
      const gltf = await loader.parseAsync(buf, '')
      return gltf.scene || (gltf.scenes && gltf.scenes[0])
    } catch (e) {
      throw new Error(`Could not read "${name}" as glTF: ${e && e.message ? e.message : e}`)
    }
  }
  if (ext === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js')
    return new OBJLoader().parse(new TextDecoder().decode(buf))
  }
  if (ext === 'stl') {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js')
    const geo = new STLLoader().parse(buf)
    return new THREE.Mesh(geo)
  }
  throw new Error(`Unsupported model type ".${ext || '?'}": use GLB, glTF, OBJ or STL`)
}

const UP = {
  '+Y': [0, 0, 0],
  '-Y': [Math.PI, 0, 0],
  '+Z': [-Math.PI / 2, 0, 0],
  '-Z': [Math.PI / 2, 0, 0],
  '+X': [0, 0, Math.PI / 2],
  '-X': [0, 0, -Math.PI / 2],
}

// All triangles of all meshes, world space, rotated for the front view.
function mergeMeshes(root, p) {
  root.updateMatrixWorld(true)
  const up = UP[p.upAxis] || UP['+Y']
  const D = THREE.MathUtils.DEG2RAD
  const orient = new THREE.Matrix4()
    .makeRotationFromEuler(new THREE.Euler((+p.pitch || 0) * D, (+p.yaw || 0) * D, (+p.roll || 0) * D, 'YXZ'))
    .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(up[0], up[1], up[2])))

  const meshes = []
  let tris = 0
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return
    const g = o.geometry
    const count = g.index ? g.index.count : g.attributes.position.count
    const inst = o.isInstancedMesh ? o.count : 1
    tris += Math.floor(count / 3) * inst
    meshes.push(o)
  })
  if (!meshes.length || !tris) throw new Error('The model has no meshes (only points, lines or empty nodes)')

  const pos = new Float32Array(tris * 9)
  const nrm = new Float32Array(tris * 9)
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  const n = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  const fn = new THREE.Vector3()
  const world = new THREE.Matrix4()
  const im = new THREE.Matrix4()
  const nm = new THREE.Matrix3()
  let t = 0
  for (const o of meshes) {
    const g = o.geometry
    const P = g.attributes.position
    const Nn = g.attributes.normal || null
    const idx = g.index
    const count = idx ? idx.count : P.count
    const inst = o.isInstancedMesh ? o.count : 1
    for (let k = 0; k < inst; k++) {
      world.copy(o.matrixWorld)
      if (o.isInstancedMesh) {
        o.getMatrixAt(k, im)
        world.multiply(im)
      }
      world.premultiply(orient)
      nm.getNormalMatrix(world)
      const flip = world.determinant() < 0
      for (let i = 0; i + 2 < count; i += 3) {
        for (let c = 0; c < 3; c++) {
          const vi = idx ? idx.getX(i + c) : i + c
          v[c].fromBufferAttribute(P, vi).applyMatrix4(world)
          if (Nn) n[c].fromBufferAttribute(Nn, vi).applyMatrix3(nm).normalize()
        }
        if (!Nn) {
          e1.subVectors(v[1], v[0])
          e2.subVectors(v[2], v[0])
          fn.crossVectors(e1, e2).normalize()
          if (flip) fn.negate()
          n[0].copy(fn)
          n[1].copy(fn)
          n[2].copy(fn)
        }
        for (let c = 0; c < 3; c++) {
          pos[t * 9 + c * 3] = v[c].x
          pos[t * 9 + c * 3 + 1] = v[c].y
          pos[t * 9 + c * 3 + 2] = v[c].z
          nrm[t * 9 + c * 3] = n[c].x
          nrm[t * 9 + c * 3 + 1] = n[c].y
          nrm[t * 9 + c * 3 + 2] = n[c].z
        }
        t++
      }
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, t * 9), 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm.subarray(0, t * 9), 3))
  let area = 0
  for (let i = 0; i < t; i++) {
    const o = i * 9
    const ax = pos[o + 3] - pos[o], ay = pos[o + 4] - pos[o + 1], az = pos[o + 5] - pos[o + 2]
    const bx = pos[o + 6] - pos[o], by = pos[o + 7] - pos[o + 1], bz = pos[o + 8] - pos[o + 2]
    area += 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx)
  }
  if (!(area > 0)) throw new Error('The model has no surface area (degenerate triangles)')
  geo.computeBoundingBox()
  return { geo, area, triangles: t, meshes: meshes.length }
}

// Voxelised inside of the mesh: cells not reachable from outside, at least one
// cell away from the surface. Returns null for open meshes (nothing enclosed).
function interiorCells(sampler, box, area) {
  const size = box.getSize(new THREE.Vector3())
  const ext = Math.max(size.x, size.y, size.z)
  const h = ext / 80
  const nx = Math.ceil(size.x / h) + 3
  const ny = Math.ceil(size.y / h) + 3
  const nz = Math.ceil(size.z / h) + 3
  const ox = box.min.x - h * 1.5
  const oy = box.min.y - h * 1.5
  const oz = box.min.z - h * 1.5
  const grid = new Uint8Array(nx * ny * nz) // 1 surface, 2 outside
  const id = (x, y, z) => x + nx * (y + ny * z)
  const S = Math.min(400000, Math.max(30000, Math.round((area / (h * h)) * 8)))
  const p = new THREE.Vector3()
  for (let i = 0; i < S; i++) {
    sampler.sample(p)
    const x = Math.floor((p.x - ox) / h), y = Math.floor((p.y - oy) / h), z = Math.floor((p.z - oz) / h)
    grid[id(x, y, z)] = 1
  }
  // seal pinholes: dilate the shell by one cell
  const shell = grid.slice()
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    if (!shell[id(x, y, z)]) continue
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) grid[id(x + dx, y + dy, z + dz)] = 1
  }
  // flood fill the outside from a corner
  const stack = new Int32Array(nx * ny * nz)
  let sp = 0
  stack[sp++] = 0
  grid[0] = 2
  while (sp) {
    const c = stack[--sp]
    const x = c % nx
    const y = Math.floor(c / nx) % ny
    const z = Math.floor(c / (nx * ny))
    const push = (xx, yy, zz) => {
      if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) return
      const k = id(xx, yy, zz)
      if (grid[k]) return
      grid[k] = 2
      stack[sp++] = k
    }
    push(x - 1, y, z)
    push(x + 1, y, z)
    push(x, y - 1, z)
    push(x, y + 1, z)
    push(x, y, z - 1)
    push(x, y, z + 1)
  }
  const cells = []
  for (let k = 0; k < grid.length; k++) if (grid[k] === 0) cells.push(k)
  if (cells.length < 8) return null
  return { cells, nx, ny, h, ox, oy, oz, volume: cells.length * h * h * h }
}

export function sampleModel(root, p = {}, { N = 8000, seed = 1 } = {}) {
  const t0 = performance.now()
  const rng = createRng(seed)
  const { geo, area, triangles, meshes } = mergeMeshes(root, p)
  const mesh = new THREE.Mesh(geo)
  const sampler = new MeshSurfaceSampler(mesh).setRandomGenerator(rng.next).build()
  const box = geo.boundingBox

  let Nv = Math.round(N * Math.min(Math.max(+p.volume || 0, 0), 1))
  let inside = null
  if (Nv > 0) {
    inside = interiorCells(sampler, box, area)
    if (!inside) {
      console.warn('[custom] model is open (no enclosed volume): volume fill skipped')
      Nv = 0
    }
  }
  const Ns = N - Nv

  const positions = new Float32Array(N * 3)
  const normal = new Float32Array(N * 3)

  // surface: 4× candidates → elimination
  const M = Ns * 4
  const cp = new Float32Array(M * 3)
  const cn = new Float32Array(M * 3)
  const vp = new THREE.Vector3()
  const vn = new THREE.Vector3()
  for (let i = 0; i < M; i++) {
    sampler.sample(vp, vn)
    vn.normalize()
    cp[i * 3] = vp.x
    cp[i * 3 + 1] = vp.y
    cp[i * 3 + 2] = vp.z
    cn[i * 3] = vn.x
    cn[i * 3 + 1] = vn.y
    cn[i * 3 + 2] = vn.z
  }
  const keep = eliminate(cp, M, Ns, Math.sqrt(area / (2 * Math.sqrt(3) * Ns)))
  for (let k = 0; k < Ns; k++) {
    const i = keep[k]
    for (let c = 0; c < 3; c++) {
      positions[k * 3 + c] = cp[i * 3 + c]
      normal[k * 3 + c] = cn[i * 3 + c]
    }
  }

  if (Nv > 0) {
    const { cells, nx, ny, h, ox, oy, oz, volume } = inside
    const Mv = Nv * 3
    const vpv = new Float32Array(Mv * 3)
    for (let i = 0; i < Mv; i++) {
      const c = cells[Math.floor(rng.next() * cells.length)]
      vpv[i * 3] = ox + ((c % nx) + rng.next()) * h
      vpv[i * 3 + 1] = oy + ((Math.floor(c / nx) % ny) + rng.next()) * h
      vpv[i * 3 + 2] = oz + (Math.floor(c / (nx * ny)) + rng.next()) * h
    }
    const keepV = eliminate(vpv, Mv, Nv, Math.cbrt(volume / (4 * Math.SQRT2 * Nv)))
    const cx = (box.min.x + box.max.x) / 2
    const cy = (box.min.y + box.max.y) / 2
    const cz = (box.min.z + box.max.z) / 2
    for (let k = 0; k < Nv; k++) {
      const i = keepV[k]
      const o = (Ns + k) * 3
      positions[o] = vpv[i * 3]
      positions[o + 1] = vpv[i * 3 + 1]
      positions[o + 2] = vpv[i * 3 + 2]
      const dx = positions[o] - cx, dy = positions[o + 1] - cy, dz = positions[o + 2] - cz
      const l = Math.hypot(dx, dy, dz) || 1
      normal[o] = dx / l
      normal[o + 1] = dy / l
      normal[o + 2] = dz / l
    }
  }

  // aux: height 0..1 (bottom → top)
  const aux = new Float32Array(N)
  const hy = box.max.y - box.min.y || 1
  for (let k = 0; k < N; k++) aux[k] = Math.min(Math.max((positions[k * 3 + 1] - box.min.y) / hy, 0), 1)
  geo.dispose()

  const sz = box.getSize(new THREE.Vector3())
  return {
    positions,
    normal,
    aux,
    info: {
      triangles,
      meshes,
      area,
      volumeFill: Nv,
      aspect: sz.x / Math.max(sz.y, 1e-9),
      ms: Math.round(performance.now() - t0),
    },
  }
}
