// The single config contract shared by editor, runtime and export.
// Everything here is JSON-serialisable: presets, localStorage and the exported
// HTML all carry exactly this object. See SPEC.md §Config.

export const MAX_COUNT = 8000
export const COUNT_PRESETS = [8000, 4000, 3000, 1500, 1000]

export const DEFAULT_CONFIG = {
  version: 1,
  shape: 'triangle', // shape id (registry key in src/shapes/index.js) or 'custom'
  seed: 1,
  count: 8000, // active particles, 1000..8000 (prefix of the progressive order)
  shapeParams: {}, // { [shapeId]: { param: value } } overrides of each shape's params

  particles: {
    size: 2.2, // CSS px diameter of a size-1 particle at the framed distance
    sizeVariance: 0.6, // 0 = uniform size, 1 = full per-particle size attribute
    sizeByCount: 0.5, // 0..1: fewer particles → slightly larger dots (keeps the read)
    softness: 0.1, // 0 = crisp antialiased disc, 1 = soft gaussian falloff
    opacity: 0.92,
    color: '#0d0d0d', // group 0 (primary)
    colorB: '#0d0d0d', // group 1 (secondary, e.g. head shell around the brain)
    opacityB: 0.5, // alpha multiplier for group 1
    colorC: '#0d0d0d', // group 2 (accent, e.g. DNA base pairs)
    opacityC: 0.8,
    shading: 0.3, // 0..1 light-facing modulation using normals
  },

  depth: {
    fade: 0.55, // 0..1 alpha loss towards the back of the shape
    dof: 0, // 0..1 depth-of-field (out-of-focus dots grow + soften, energy kept)
    focus: 0, // focus plane offset from shape centre, world units (-2..2)
  },

  dissolve: {
    amount: 0, // 0..1 portion of the shape that disintegrates into dust
    mode: 'linear', // 'linear' (one side) | 'mirror' (both ends of the axis) | 'radial' (rim)
    angle: 0, // degrees, screen-plane direction the dust blows towards (0 = right, 90 = up)
    softness: 0.35, // width of the transition band
    spread: 0.6, // how far dissolved particles scatter
    turbulence: 0.5, // noise in the scatter
    fade: 0.85, // alpha loss of fully dissolved particles
  },

  motion: {
    mode: 'sway', // 'still' | 'sway' | 'spin'
    speed: 0.25,
    swayAngle: 16, // degrees of yaw oscillation in sway mode
    yaw: 0, // static base rotation, degrees
    pitch: 0,
    roll: 0,
    float: 0.25, // 0..1 slow vertical bob
    noise: 0.25, // 0..1 per-particle wander
    noiseScale: 1.2,
    noiseSpeed: 0.3,
  },

  life: {
    enabled: true, // shape-specific behaviour from shape.meta.life
    amount: 0.6, // intensity 0..1
    rate: 1, // speed multiplier (heartbeat: 60 bpm × rate)
  },

  hover: {
    enabled: true,
    mode: 'repel', // 'repel' | 'attract' | 'swirl' | 'ripple'
    radius: 110, // CSS px
    strength: 0.6, // 0..1
    stiffness: 0.08, // spring back towards rest 0.01..0.3
    damping: 0.86, // velocity retention 0.5..0.98
    click: 'burst', // 'none' | 'burst' | 'shockwave'
  },

  morph: {
    duration: 1.8, // seconds
    stagger: 0.5, // 0..1 spread of per-particle start times
    turbulence: 0.6, // 0..1 curl-noise detour mid-flight
    style: 'flow', // 'flow' | 'explode' | 'sweep'
    intro: true, // assemble from a dust cloud on first load
  },

  dust: {
    count: 1800, // ambient particles, 0..8000
    size: 1, // relative to particles.size
    opacity: 0.2,
    radius: 1, // relative extent of the dust ellipsoid (0.5..2.5)
    drift: 0.25, // 0..1 slow motion
  },

  scene: {
    background: '#ffffff',
    glow: 0, // 0..1 soft tinted corner light (reference 05 has a faint blue one)
    glowColor: '#dce9f7',
  },

  camera: {
    fov: 30,
    autoFit: true, // distance from shape.meta.frame (fraction of viewport filled)
    frame: 1, // multiplier on the shape's own frame fraction (zoom), 0.4..1.6
    distance: 6, // used when autoFit is false
    azimuth: 0, // degrees, orbit around the shape
    elevation: 0,
    offsetX: 0, // framing shift, fraction of viewport (-0.5..0.5)
    offsetY: 0,
    orbit: true, // drag to orbit (springs back when released)
    zoom: false, // wheel / pinch zoom
  },
}

// Panel metadata: ranges, steps, options, labels. The panel is built from this
// so ranges live in one place. Keys mirror DEFAULT_CONFIG sections.
export const CONFIG_SCHEMA = {
  particles: {
    size: { min: 0.4, max: 8, step: 0.05, label: 'Size' },
    sizeVariance: { min: 0, max: 1, step: 0.01, label: 'Size variance' },
    sizeByCount: { min: 0, max: 1, step: 0.01, label: 'Size by count' },
    softness: { min: 0, max: 1, step: 0.01, label: 'Softness' },
    opacity: { min: 0, max: 1, step: 0.01, label: 'Opacity' },
    color: { color: true, label: 'Color' },
    colorB: { color: true, label: 'Color B' },
    opacityB: { min: 0, max: 1, step: 0.01, label: 'Opacity B' },
    colorC: { color: true, label: 'Color C' },
    opacityC: { min: 0, max: 1, step: 0.01, label: 'Opacity C' },
    shading: { min: 0, max: 1, step: 0.01, label: 'Shading' },
  },
  depth: {
    fade: { min: 0, max: 1, step: 0.01, label: 'Depth fade' },
    dof: { min: 0, max: 1, step: 0.01, label: 'Depth of field' },
    focus: { min: -2, max: 2, step: 0.01, label: 'Focus' },
  },
  dissolve: {
    amount: { min: 0, max: 1, step: 0.01, label: 'Amount' },
    mode: { options: ['linear', 'mirror', 'radial'], label: 'Mode' },
    angle: { min: -180, max: 180, step: 1, label: 'Direction' },
    softness: { min: 0.02, max: 1, step: 0.01, label: 'Softness' },
    spread: { min: 0, max: 2, step: 0.01, label: 'Spread' },
    turbulence: { min: 0, max: 1, step: 0.01, label: 'Turbulence' },
    fade: { min: 0, max: 1, step: 0.01, label: 'Fade' },
  },
  motion: {
    mode: { options: ['still', 'sway', 'spin'], label: 'Mode' },
    speed: { min: 0, max: 2, step: 0.01, label: 'Speed' },
    swayAngle: { min: 0, max: 90, step: 1, label: 'Sway angle' },
    yaw: { min: -180, max: 180, step: 1, label: 'Yaw' },
    pitch: { min: -90, max: 90, step: 1, label: 'Pitch' },
    roll: { min: -180, max: 180, step: 1, label: 'Roll' },
    float: { min: 0, max: 1, step: 0.01, label: 'Float' },
    noise: { min: 0, max: 1, step: 0.01, label: 'Wander' },
    noiseScale: { min: 0.1, max: 6, step: 0.01, label: 'Wander scale' },
    noiseSpeed: { min: 0, max: 2, step: 0.01, label: 'Wander speed' },
  },
  life: {
    enabled: { label: 'Alive' },
    amount: { min: 0, max: 1, step: 0.01, label: 'Amount' },
    rate: { min: 0.1, max: 3, step: 0.01, label: 'Rate' },
  },
  hover: {
    enabled: { label: 'Hover' },
    mode: { options: ['repel', 'attract', 'swirl', 'ripple'], label: 'Mode' },
    radius: { min: 20, max: 400, step: 1, label: 'Radius px' },
    strength: { min: 0, max: 1, step: 0.01, label: 'Strength' },
    stiffness: { min: 0.01, max: 0.3, step: 0.005, label: 'Spring' },
    damping: { min: 0.5, max: 0.98, step: 0.01, label: 'Damping' },
    click: { options: ['none', 'burst', 'shockwave'], label: 'Click' },
  },
  morph: {
    duration: { min: 0.3, max: 5, step: 0.05, label: 'Duration s' },
    stagger: { min: 0, max: 1, step: 0.01, label: 'Stagger' },
    turbulence: { min: 0, max: 1, step: 0.01, label: 'Turbulence' },
    style: { options: ['flow', 'explode', 'sweep'], label: 'Style' },
    intro: { label: 'Intro assemble' },
  },
  dust: {
    count: { min: 0, max: 8000, step: 100, label: 'Count' },
    size: { min: 0.2, max: 3, step: 0.01, label: 'Size' },
    opacity: { min: 0, max: 1, step: 0.01, label: 'Opacity' },
    radius: { min: 0.5, max: 2.5, step: 0.01, label: 'Radius' },
    drift: { min: 0, max: 1, step: 0.01, label: 'Drift' },
  },
  scene: {
    background: { color: true, label: 'Background' },
    glow: { min: 0, max: 1, step: 0.01, label: 'Corner glow' },
    glowColor: { color: true, label: 'Glow color' },
  },
  camera: {
    fov: { min: 10, max: 75, step: 1, label: 'FOV' },
    autoFit: { label: 'Auto fit' },
    frame: { min: 0.4, max: 1.6, step: 0.01, label: 'Frame' },
    distance: { min: 1, max: 30, step: 0.05, label: 'Distance' },
    azimuth: { min: -180, max: 180, step: 1, label: 'Azimuth' },
    elevation: { min: -89, max: 89, step: 1, label: 'Elevation' },
    offsetX: { min: -0.5, max: 0.5, step: 0.005, label: 'Offset X' },
    offsetY: { min: -0.5, max: 0.5, step: 0.005, label: 'Offset Y' },
    orbit: { label: 'Drag orbit' },
    zoom: { label: 'Wheel zoom' },
  },
}

// Deep merge for plain objects (arrays and primitives replace). Returns a new object.
export function mergeConfig(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch
  const out = Array.isArray(base) ? base.slice() : { ...(base || {}) }
  for (const k of Object.keys(patch)) {
    const v = patch[k]
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])
        ? mergeConfig(base[k], v)
        : v
  }
  return out
}

export const cloneConfig = (c) => JSON.parse(JSON.stringify(c))
