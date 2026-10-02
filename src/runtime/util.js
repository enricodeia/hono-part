// Small math helpers shared by the runtime (no three.js, no allocations).

export const PI = Math.PI
export const TAU = Math.PI * 2
export const DEG = Math.PI / 180

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x)

export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

// quintic in-out: zero velocity and acceleration at both ends
export const ease5 = (t) => t * t * t * (t * (t * 6 - 15) + 10)

export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

export const fract = (x) => x - Math.floor(x)

// frame-rate independent exponential approach (lambda = 1 / time constant)
export const damp = (current, target, lambda, dt) => target + (current - target) * Math.exp(-lambda * dt)

// '#rgb' | '#rrggbb' | 'rgb(…)' | number → [r, g, b] in 0..1, sRGB as authored (no linearisation:
// dots are composited in display space, exactly like a design tool).
export function parseColor(input, out = [0, 0, 0]) {
  if (typeof input === 'number') {
    out[0] = ((input >> 16) & 255) / 255
    out[1] = ((input >> 8) & 255) / 255
    out[2] = (input & 255) / 255
    return out
  }
  let s = String(input || '').trim()
  if (s.startsWith('rgb')) {
    const m = s.match(/[\d.]+/g) || []
    out[0] = (+m[0] || 0) / 255
    out[1] = (+m[1] || 0) / 255
    out[2] = (+m[2] || 0) / 255
    return out
  }
  if (s[0] === '#') s = s.slice(1)
  if (s.length === 3 || s.length === 4) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
  const v = parseInt(s.slice(0, 6), 16)
  if (Number.isNaN(v)) {
    out[0] = out[1] = out[2] = 0
    return out
  }
  return parseColor(v, out)
}

// polynomial bump: 1 at x = 0, 0 for |x| >= w, C1-smooth (cheap gaussian stand-in, GLSL twin in glsl.js)
export function bump(x, w) {
  const u = clamp(1 - (x * x) / (w * w), 0, 1)
  return u * u
}

// seeded uniform randoms (mulberry32)
export function rng32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
