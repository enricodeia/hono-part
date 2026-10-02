// Shape preview harness (dev tool, independent of the real runtime).
// Renders one shape from several fixed views, black dots on white, so shape
// builders can iterate without the editor. Query params:
//   shape=heart  count=8000  seed=1  size=2.2 (px)  fade=0.5
//   views=front,side,top,iso,back or yaw:pitch pairs, e.g. views=front,30:10
//   groups=1     colour groups (0 black, 1 red, 2 blue) to debug group split
//   params={"turns":3}   JSON overrides of the shape's params
//   bg=ffffff fg=0d0d0d  hex without '#'
//   module=/src/shapes/data/x.js  render an UNREGISTERED shape module directly
// Exposes window.__preview = { id, count, buildMs, bounds, meta, groupCounts }.

import * as THREE from 'three'
import { SHAPES, buildShape, paramDefaults } from './shapes/index.js'
import { hashSeed } from './shapes/lib/rng.js'

const q = new URLSearchParams(location.search)
const fail = (e) => {
  const el = document.getElementById('err')
  el.style.display = 'block'
  el.textContent = String(e && e.stack ? e.stack : e)
  console.error(e)
  document.body.dataset.ready = 'error'
}

async function loadUnregistered() {
  if (!q.get('module')) return null
  const mod = await import(/* @vite-ignore */ q.get('module'))
  const defs = [].concat(mod.default)
  const def = defs.find((d) => d.id === q.get('shape')) || defs[0]
  const params = { ...paramDefaults(def), ...(q.get('params') ? JSON.parse(q.get('params')) : {}) }
  const t0 = performance.now()
  const shape = def.generate(params, { seed: hashSeed(def.id, +q.get('seed') || 1), maxCount: 8000 })
  shape.meta.buildMs = Math.round(performance.now() - t0)
  return shape
}

loadUnregistered()
  .then((pre) => run(pre))
  .catch(fail)

function run(pre) {
  if (!pre && !SHAPES.length) throw new Error('no shapes registered yet (src/shapes/*.js)')
  const id = pre ? pre.meta.id : q.get('shape') || SHAPES[0].id
  const count = Math.min(+q.get('count') || 8000, 8000)
  const seed = +q.get('seed') || 1
  const size = +q.get('size') || 2.2
  const fade = q.has('fade') ? +q.get('fade') : 0.5
  const params = q.get('params') ? JSON.parse(q.get('params')) : {}
  const bg = '#' + (q.get('bg') || 'ffffff')
  const fg = '#' + (q.get('fg') || '0d0d0d')
  const debugGroups = q.get('groups') === '1'
  const viewNames = (q.get('views') || 'front').split(',').filter(Boolean)

  const shape = pre || buildShape(id, params, seed)
  const n = Math.min(count, shape.count)

  const canvas = document.getElementById('c')
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  renderer.setPixelRatio(dpr)
  renderer.setSize(window.innerWidth, window.innerHeight, false)
  renderer.setClearColor(bg, 1)
  renderer.autoClear = false

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(shape.positions, 3))
  geo.setAttribute('aSize', new THREE.BufferAttribute(shape.size, 1))
  geo.setAttribute('aGroup', new THREE.BufferAttribute(Float32Array.from(shape.group), 1))
  geo.setDrawRange(0, n)

  const groupCol = debugGroups
    ? [new THREE.Color('#0d0d0d'), new THREE.Color('#e0312b'), new THREE.Color('#2b6be0')]
    : [new THREE.Color(fg), new THREE.Color(fg), new THREE.Color(fg)]

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uSize: { value: size * dpr },
      uFade: { value: fade },
      uRadius: { value: shape.bounds.radius },
      uDist: { value: 1 },
      uCol: { value: groupCol },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aGroup;
      uniform float uSize, uFade, uRadius, uDist;
      uniform vec3 uCol[3];
      varying vec3 vCol;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float px = uSize * aSize * (uDist / -mv.z);
        // sub-pixel dots: draw at 1px, keep energy via alpha
        float drawn = max(px, 1.0);
        gl_PointSize = drawn;
        float depth = clamp((-mv.z - (uDist - uRadius)) / (2.0 * uRadius), 0.0, 1.0);
        vAlpha = (px * px) / (drawn * drawn) * (1.0 - uFade * depth);
        int g = int(aGroup + 0.5);
        vCol = g == 1 ? uCol[1] : (g == 2 ? uCol[2] : uCol[0]);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      varying float vAlpha;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float aa = fwidth(r);
        float a = 1.0 - smoothstep(1.0 - aa, 1.0 + aa * 0.5, r);
        if (a <= 0.0) discard;
        gl_FragColor = vec4(vCol, a * vAlpha);
      }`,
  })
  const points = new THREE.Points(geo, mat)
  const scene = new THREE.Scene()
  scene.add(points)

  const VIEWS = {
    front: [0, 0],
    side: [90, 0],
    left: [-90, 0],
    back: [180, 0],
    top: [0, -89.9],
    bottom: [0, 89.9],
    iso: [35, 20],
  }
  const views = viewNames.map((v) => {
    if (VIEWS[v]) return { name: v, yaw: VIEWS[v][0], pitch: VIEWS[v][1] }
    const [y, p] = v.split(':').map(Number)
    return { name: v, yaw: y || 0, pitch: p || 0 }
  })

  const W = window.innerWidth
  const H = window.innerHeight
  const cols = views.length
  const vw = W / cols
  const cams = views.map((v, i) => {
    const cam = new THREE.PerspectiveCamera(30, vw / H, 0.01, 100)
    const r = shape.bounds.radius
    const dist = (r * 1.08) / Math.sin(THREE.MathUtils.degToRad(15)) / Math.min(1, vw / H)
    const yaw = THREE.MathUtils.degToRad(v.yaw)
    const pitch = THREE.MathUtils.degToRad(v.pitch)
    cam.position.set(
      dist * Math.sin(yaw) * Math.cos(pitch),
      -dist * Math.sin(pitch),
      dist * Math.cos(yaw) * Math.cos(pitch),
    )
    cam.lookAt(0, 0, 0)
    const lbl = document.createElement('div')
    lbl.className = 'lbl'
    lbl.style.left = `${i * vw}px`
    lbl.style.top = '0px'
    lbl.textContent = `${v.name}  (yaw ${v.yaw}°, pitch ${v.pitch}°)`
    document.body.appendChild(lbl)
    return { cam, dist }
  })

  renderer.clear()
  cams.forEach(({ cam, dist }, i) => {
    mat.uniforms.uDist.value = dist
    renderer.setViewport(i * vw, 0, vw, H)
    renderer.setScissor(i * vw, 0, vw, H)
    renderer.setScissorTest(true)
    renderer.render(scene, cam)
  })

  const groupCounts = [0, 0, 0]
  for (let i = 0; i < n; i++) groupCounts[shape.group[i]] = (groupCounts[shape.group[i]] || 0) + 1
  document.getElementById('info').textContent =
    `${shape.meta.label || id} · ${n} pts · build ${shape.meta.buildMs} ms · groups ${groupCounts.join('/')} · ` +
    `bounds ${shape.bounds.min.map((v) => v.toFixed(2))} → ${shape.bounds.max.map((v) => v.toFixed(2))} · life ${shape.meta.life}`
  window.__preview = { id, count: n, buildMs: shape.meta.buildMs, bounds: shape.bounds, meta: shape.meta, groupCounts }
  document.body.dataset.ready = 'true'
}
