// Weighted sample elimination (Yuksel 2015): from M random candidates keep the
// N best-spread ones. Turns white-noise surface samples (clumps + holes) into a
// Poisson-disk-like distribution. Deterministic (no randomness inside).
//
//   P      Float32Array(M*3) candidate positions
//   N      how many to keep
//   rmax   expected Poisson radius for N points:
//          surface (area A):  sqrt(A / (2·√3·N))
//          volume  (vol V):   cbrt(V / (4·√2·N))
// returns Uint32Array of kept candidate indices (length N)

export function eliminate(P, M, N, rmax) {
  if (N >= M) return Uint32Array.from({ length: M }, (_, i) => i)
  const r2 = 2 * rmax
  const rmin = r2 * (1 - Math.pow(N / M, 1.5)) * 0.65

  // uniform grid with cell = 2·rmax (count sort)
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < M; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  let cell = r2
  let nx, ny, nz
  for (;;) {
    nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1)
    ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1)
    nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1)
    if (nx * ny * nz <= 4e6) break
    cell *= 1.5
  }
  const cellOf = new Uint32Array(M)
  const counts = new Uint32Array(nx * ny * nz + 1)
  for (let i = 0; i < M; i++) {
    const cx = Math.floor((P[i * 3] - minX) / cell)
    const cy = Math.floor((P[i * 3 + 1] - minY) / cell)
    const cz = Math.floor((P[i * 3 + 2] - minZ) / cell)
    const c = cx + nx * (cy + ny * cz)
    cellOf[i] = c
    counts[c + 1]++
  }
  for (let c = 1; c < counts.length; c++) counts[c] += counts[c - 1]
  const start = counts.slice()
  const items = new Uint32Array(M)
  const fill = counts.slice()
  for (let i = 0; i < M; i++) items[fill[cellOf[i]]++] = i

  // neighbour lists (CSR) with weights w = (1 - d̂/2r)^8, d̂ = max(d, rmin)
  const nbStart = new Uint32Array(M + 1)
  let nbIdx = new Uint32Array(M * 16)
  let nbW = new Float32Array(M * 16)
  let used = 0
  const R2 = r2 * r2
  for (let i = 0; i < M; i++) {
    nbStart[i] = used
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]
    const c = cellOf[i]
    const cx = c % nx
    const cy = Math.floor(c / nx) % ny
    const cz = Math.floor(c / (nx * ny))
    for (let dz = -1; dz <= 1; dz++) {
      const zz = cz + dz
      if (zz < 0 || zz >= nz) continue
      for (let dy = -1; dy <= 1; dy++) {
        const yy = cy + dy
        if (yy < 0 || yy >= ny) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = cx + dx
          if (xx < 0 || xx >= nx) continue
          const cc = xx + nx * (yy + ny * zz)
          for (let q = start[cc]; q < start[cc + 1]; q++) {
            const j = items[q]
            if (j === i) continue
            const ex = P[j * 3] - x, ey = P[j * 3 + 1] - y, ez = P[j * 3 + 2] - z
            const d2 = ex * ex + ey * ey + ez * ez
            if (d2 >= R2) continue
            if (used >= nbIdx.length) {
              const a = new Uint32Array(nbIdx.length * 2)
              a.set(nbIdx)
              nbIdx = a
              const b = new Float32Array(nbW.length * 2)
              b.set(nbW)
              nbW = b
            }
            const d = Math.max(Math.sqrt(d2), rmin)
            nbIdx[used] = j
            nbW[used] = Math.pow(1 - d / r2, 8)
            used++
          }
        }
      }
    }
  }
  nbStart[M] = used

  const W = new Float64Array(M)
  for (let i = 0; i < M; i++) {
    let s = 0
    for (let q = nbStart[i]; q < nbStart[i + 1]; q++) s += nbW[q]
    W[i] = s
  }

  // indexed max-heap
  const heap = new Uint32Array(M)
  const pos = new Int32Array(M)
  for (let i = 0; i < M; i++) {
    heap[i] = i
    pos[i] = i
  }
  let size = M
  const swap = (a, b) => {
    const ia = heap[a], ib = heap[b]
    heap[a] = ib
    heap[b] = ia
    pos[ib] = a
    pos[ia] = b
  }
  // ties broken by index so the result never depends on the engine's sort
  const greater = (a, b) => W[a] > W[b] || (W[a] === W[b] && a > b)
  const down = (k) => {
    for (;;) {
      const l = 2 * k + 1
      const r = l + 1
      let m = k
      if (l < size && greater(heap[l], heap[m])) m = l
      if (r < size && greater(heap[r], heap[m])) m = r
      if (m === k) return
      swap(k, m)
      k = m
    }
  }
  for (let k = (size >> 1) - 1; k >= 0; k--) down(k)

  const removed = new Uint8Array(M)
  for (let left = M; left > N; left--) {
    const i = heap[0]
    removed[i] = 1
    swap(0, size - 1)
    size--
    pos[i] = -1
    down(0)
    for (let q = nbStart[i]; q < nbStart[i + 1]; q++) {
      const j = nbIdx[q]
      if (removed[j]) continue
      W[j] -= nbW[q]
      down(pos[j])
    }
  }
  const out = new Uint32Array(N)
  let k = 0
  for (let i = 0; i < M && k < N; i++) if (!removed[i]) out[k++] = i
  return out
}
