// Seeded randomness. Every shape is a pure function of (params, seed), so the
// same seed always rebuilds the same specimen (editor, export, verify).

export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Mixes strings / numbers into one uint32 seed: hashSeed('heart', 7) !== hashSeed('dna', 7).
export function hashSeed(...parts) {
  let h = 2166136261 >>> 0
  for (const part of parts) {
    const s = String(part)
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619) >>> 0
    }
    h ^= 0x9e3779b9
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

export function createRng(seed) {
  const next = mulberry32(typeof seed === 'number' ? seed : hashSeed(seed))
  let spare = null

  const rng = {
    next,
    range: (a, b) => a + (b - a) * next(),
    int: (n) => Math.floor(next() * n),
    sign: () => (next() < 0.5 ? -1 : 1),
    chance: (p) => next() < p,

    // Standard normal (Box-Muller, caches the second value).
    normal() {
      if (spare !== null) {
        const v = spare
        spare = null
        return v
      }
      let u = 0
      while (u === 0) u = next()
      const v = next()
      const m = Math.sqrt(-2 * Math.log(u))
      spare = m * Math.sin(2 * Math.PI * v)
      return m * Math.cos(2 * Math.PI * v)
    },
    gauss: (mean = 0, sd = 1) => mean + sd * rng.normal(),

    // Uniform direction on the unit sphere.
    onSphere(out = [0, 0, 0]) {
      const z = 2 * next() - 1
      const t = 2 * Math.PI * next()
      const r = Math.sqrt(1 - z * z)
      out[0] = r * Math.cos(t)
      out[1] = r * Math.sin(t)
      out[2] = z
      return out
    },
    // Uniform point inside the unit sphere.
    inSphere(out = [0, 0, 0]) {
      rng.onSphere(out)
      const r = Math.cbrt(next())
      out[0] *= r
      out[1] *= r
      out[2] *= r
      return out
    },
    // Uniform point inside the unit disc (x, y).
    inDisc(out = [0, 0]) {
      const r = Math.sqrt(next())
      const t = 2 * Math.PI * next()
      out[0] = r * Math.cos(t)
      out[1] = r * Math.sin(t)
      return out
    },

    pick: (arr) => arr[Math.floor(next() * arr.length)],

    // In-place Fisher-Yates.
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        const t = arr[i]
        arr[i] = arr[j]
        arr[j] = t
      }
      return arr
    },

    // Index drawn with probability proportional to weights[i].
    weighted(weights) {
      let total = 0
      for (const w of weights) total += w
      let r = next() * total
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i]
        if (r <= 0) return i
      }
      return weights.length - 1
    },
  }
  return rng
}
