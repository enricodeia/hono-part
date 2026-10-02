// Studio state: { config, looks, exportOptions, custom, ui }.
//
// A shape's "look" is exactly the set of leaf keys present in its
// def.defaults. Tweaks to those keys are remembered per shape (as a diff
// against def.defaults, so improved defaults still reach old sessions);
// every other key is global and survives shape switches.

import { DEFAULT_CONFIG, mergeConfig, cloneConfig } from '../state.js'

const STATE_KEY = 'pulviscolo.studio.v1'
const CUSTOM_KEY = 'pulviscolo.custom.v1'

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// Always global, even when a shape's defaults mention them: the brief wants
// one particle colour (and background) that sticks across every specimen.
export const GLOBAL_PATHS = ['shape', 'seed', 'count', 'shapeParams', 'particles.color', 'particles.colorB', 'particles.colorC', 'scene.background']

const lookCache = new WeakMap()
// def.defaults minus the always-global keys: the shape's "look".
export function lookDefaults(defaults) {
  if (!isPlain(defaults)) return {}
  if (lookCache.has(defaults)) return lookCache.get(defaults)
  const out = cloneConfig(defaults)
  for (const p of GLOBAL_PATHS) deleteIn(out, p.split('.'))
  lookCache.set(defaults, out)
  return out
}

export function getIn(obj, path) {
  let o = obj
  for (const k of path) {
    if (o == null) return undefined
    o = o[k]
  }
  return o
}

export function setIn(obj, path, value) {
  let o = obj
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]
    if (!isPlain(o[k])) o[k] = {}
    o = o[k]
  }
  o[path[path.length - 1]] = value
  return obj
}

export function deleteIn(obj, path) {
  const stack = []
  let o = obj
  for (let i = 0; i < path.length - 1; i++) {
    if (!isPlain(o[path[i]])) return obj
    stack.push([o, path[i]])
    o = o[path[i]]
  }
  delete o[path[path.length - 1]]
  for (let i = stack.length - 1; i >= 0; i--) {
    const [parent, k] = stack[i]
    if (Object.keys(parent[k]).length) break
    delete parent[k]
  }
  return obj
}

export const patchFor = (path, value) => setIn({}, path, value)

export function leafPaths(obj, prefix = [], out = []) {
  if (!isPlain(obj)) return out
  for (const [k, v] of Object.entries(obj)) {
    if (isPlain(v)) leafPaths(v, [...prefix, k], out)
    else out.push([...prefix, k])
  }
  return out
}

const sameValue = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : JSON.stringify(a) === JSON.stringify(b))

export function isLookPath(defaults, path) {
  let o = defaults
  for (const k of path) {
    if (!isPlain(o) || !(k in o)) return false
    o = o[k]
  }
  return true
}

// Stores `value` at `path` in a look diff (removes it when it equals the default).
export function recordLook(looks, id, defaults, path, value) {
  const look = (looks[id] ||= {})
  if (sameValue(getIn(defaults, path), value)) deleteIn(look, path)
  else setIn(look, path, cloneConfig(value))
  if (!Object.keys(look).length) delete looks[id]
}

// The look diff of `config` against `defaults`, for every look key.
export function diffLook(config, defaults) {
  const out = {}
  for (const p of leafPaths(defaults)) {
    const v = getIn(config, p)
    if (v !== undefined && !sameValue(v, getIn(defaults, p))) setIn(out, p, cloneConfig(v))
  }
  return out
}

// config for a shape switch: the previous shape's look keys fall back to
// DEFAULT_CONFIG, then the next shape's defaults and stored look apply.
export function composeConfig(config, prevDefaults, nextDefaults, look) {
  let base = cloneConfig(config)
  for (const p of leafPaths(prevDefaults || {})) {
    const d = getIn(DEFAULT_CONFIG, p)
    if (d === undefined) deleteIn(base, p)
    else setIn(base, p, cloneConfig(d))
  }
  base = mergeConfig(base, nextDefaults || {})
  base = mergeConfig(base, look || {})
  return base
}

export function loadSaved() {
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw)
    return isPlain(s) ? s : null
  } catch {
    return null
  }
}

let saveTimer = 0
export function saveSoon(state, delay = 320) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => saveNow(state), delay)
}

export function saveNow(state) {
  clearTimeout(saveTimer)
  try {
    const { config, looks, exportOptions, ui } = state
    const custom = state.custom ? { kind: state.custom.kind, name: state.custom.name, text: state.custom.text, params: state.custom.params } : null
    localStorage.setItem(STATE_KEY, JSON.stringify({ v: 1, config, looks, exportOptions, custom, ui }))
  } catch {
    // storage full or blocked: the session still works, it just will not persist
  }
}

export function loadCustomShape(decode) {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY)
    if (!raw) return null
    return decode(JSON.parse(raw))
  } catch {
    return null
  }
}

export function saveCustomShape(encoded) {
  try {
    if (encoded) localStorage.setItem(CUSTOM_KEY, JSON.stringify(encoded))
    else localStorage.removeItem(CUSTOM_KEY)
    return true
  } catch {
    return false
  }
}

export function clearSaved() {
  try {
    localStorage.removeItem(STATE_KEY)
    localStorage.removeItem(CUSTOM_KEY)
  } catch {
    // ignore
  }
}
