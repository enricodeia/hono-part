// Compact, JSON-safe encoding of ShapeData for the exported HTML.
// positions → Int16 quantised to the bounds, normals → Int8, size/group → Uint8,
// aux → Uint16 over its own range. 8000 points ≈ 120 KB of base64.

export function toBase64(u8) {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK))
  return btoa(s)
}

export function fromBase64(str) {
  const bin = atob(str)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

const SIZE_MAX = 4

export function encodeShape(shape, count = shape.count) {
  const n = Math.min(count, shape.count)
  const { min, max } = shape.bounds
  const pos = new Int16Array(n * 3)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const span = max[c] - min[c] || 1
      const t = (shape.positions[i * 3 + c] - min[c]) / span
      pos[i * 3 + c] = Math.round(t * 65534 - 32767)
    }
  }
  const nrm = new Int8Array(n * 3)
  for (let i = 0; i < n * 3; i++) nrm[i] = Math.round(Math.max(-1, Math.min(1, shape.normal[i])) * 127)
  const size = new Uint8Array(n)
  for (let i = 0; i < n; i++) size[i] = Math.round((Math.min(shape.size[i], SIZE_MAX) / SIZE_MAX) * 255)
  const grp = shape.group.slice(0, n)
  let a0 = Infinity, a1 = -Infinity
  for (let i = 0; i < n; i++) {
    a0 = Math.min(a0, shape.aux[i])
    a1 = Math.max(a1, shape.aux[i])
  }
  if (!isFinite(a0)) { a0 = 0; a1 = 1 }
  const aux = new Uint16Array(n)
  for (let i = 0; i < n; i++) aux[i] = Math.round(((shape.aux[i] - a0) / (a1 - a0 || 1)) * 65535)
  const { transform, ...meta } = shape.meta
  return {
    v: 1,
    n,
    bounds: shape.bounds,
    meta,
    auxRange: [a0, a1],
    pos: toBase64(new Uint8Array(pos.buffer)),
    nrm: toBase64(new Uint8Array(nrm.buffer)),
    size: toBase64(size),
    grp: toBase64(grp),
    aux: toBase64(new Uint8Array(aux.buffer)),
  }
}

export function decodeShape(enc) {
  const n = enc.n
  const { min, max } = enc.bounds
  const posI = new Int16Array(fromBase64(enc.pos).buffer)
  const positions = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const t = (posI[i * 3 + c] + 32767) / 65534
      positions[i * 3 + c] = min[c] + t * (max[c] - min[c])
    }
  }
  const nrmI = new Int8Array(fromBase64(enc.nrm).buffer)
  const normal = new Float32Array(n * 3)
  for (let i = 0; i < n * 3; i++) normal[i] = nrmI[i] / 127
  const sizeU = fromBase64(enc.size)
  const size = new Float32Array(n)
  for (let i = 0; i < n; i++) size[i] = (sizeU[i] / 255) * SIZE_MAX
  const group = fromBase64(enc.grp)
  const auxU = new Uint16Array(fromBase64(enc.aux).buffer)
  const [a0, a1] = enc.auxRange
  const aux = new Float32Array(n)
  for (let i = 0; i < n; i++) aux[i] = a0 + (auxU[i] / 65535) * (a1 - a0)
  return { count: n, positions, normal, group, size, aux, bounds: enc.bounds, meta: enc.meta }
}
