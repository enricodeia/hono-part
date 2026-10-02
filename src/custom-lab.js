// Custom sources lab: builds test sources in-page (transparent PNG logo, a
// photo-like JPEG, SVG markup, text, a GLB exported from three, an OBJ string),
// runs createCustomShape on each and draws them as a specimen grid.
// Query params:
//   only=logo,text        subset of case ids
//   rows=front8000,front1000,iso8000,side8000
//   size=1.7              dot size (CSS px)
//   params={"logo":{"edges":0}}   per-case param overrides
// Exposes window.__custom = { results, checks, errors }.

import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js'
import { createCustomShape, kindFromFile, CUSTOM_PARAMS, CUSTOM_KINDS } from './shapes/custom/index.js'

const q = new URLSearchParams(location.search)
const TAU = Math.PI * 2
const fail = (e) => {
  const el = document.getElementById('err')
  el.style.display = 'block'
  el.textContent = String(e && e.stack ? e.stack : e)
  console.error(e)
  document.body.dataset.ready = 'error'
}

/* --------------------------------------------------------- test sources --- */

function canvas2d(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')]
}
const toBlob = (c, type, quality) => new Promise((r) => c.toBlob(r, type, quality))
const asFile = (blob, name, type) => new File([blob], name, { type: type || blob.type })

async function logoPng() {
  const [c, g] = canvas2d(900, 900)
  g.fillStyle = '#121212'
  g.beginPath()
  g.arc(450, 450, 380, 0, TAU)
  g.arc(450, 450, 318, 0, TAU, true)
  g.fill()
  g.beginPath()
  g.arc(450, 455, 150, Math.PI, 0)
  g.closePath()
  g.fill()
  for (const [y, w] of [[505, 420], [565, 330], [625, 220]]) {
    g.beginPath()
    g.roundRect(450 - w / 2, y, w, 30, 15)
    g.fill()
  }
  return asFile(await toBlob(c, 'image/png'), 'logo.png')
}

async function photoJpg() {
  const W = 1200
  const H = 900
  const [c, g] = canvas2d(W, H)
  const paper = g.createLinearGradient(0, 0, 0, H)
  paper.addColorStop(0, '#f1efeb')
  paper.addColorStop(1, '#e6e3de')
  g.fillStyle = paper
  g.fillRect(0, 0, W, H)
  const cx = 600
  const cy = 420
  // contact shadow
  g.save()
  g.translate(cx + 40, cy + 285)
  g.scale(1, 0.18)
  const sh = g.createRadialGradient(0, 0, 0, 0, 0, 330)
  sh.addColorStop(0, 'rgba(20,20,20,0.75)')
  sh.addColorStop(1, 'rgba(20,20,20,0)')
  g.fillStyle = sh
  g.beginPath()
  g.arc(0, 0, 330, 0, TAU)
  g.fill()
  g.restore()
  // lit sphere
  const s = g.createRadialGradient(cx - 95, cy - 110, 10, cx, cy, 290)
  s.addColorStop(0, '#f2f2f2')
  s.addColorStop(0.3, '#a9a9a9')
  s.addColorStop(0.78, '#2c2c2c')
  s.addColorStop(1, '#161616')
  g.fillStyle = s
  g.beginPath()
  g.arc(cx, cy, 280, 0, TAU)
  g.fill()
  // film grain (seeded)
  const img = g.getImageData(0, 0, W, H)
  let a = 7
  for (let i = 0; i < img.data.length; i += 4) {
    a = (a * 1103515245 + 12345) >>> 0
    const n = ((a >>> 16) / 65536 - 0.5) * 14
    img.data[i] += n
    img.data[i + 1] += n
    img.data[i + 2] += n
  }
  g.putImageData(img, 0, 0)
  return asFile(await toBlob(c, 'image/jpeg', 0.88), 'photo.jpg')
}

const ARCHES_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 360">
  <g fill="none" stroke="#000" stroke-width="13" stroke-linejoin="round" stroke-linecap="round">
    <path d="M200 22 L382 338 L18 338 Z"/>
    <path d="M58 300 C120 300 150 150 200 150 C250 150 280 300 342 300"/>
    <path d="M40 330 C110 330 150 220 200 220 C250 220 290 330 360 330"/>
  </g>
  <circle cx="200" cy="96" r="20" fill="#000"/>
</svg>`

async function knotGlb() {
  const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.34, 360, 48, 2, 3), new THREE.MeshStandardMaterial())
  const buf = await new GLTFExporter().parseAsync(mesh, { binary: true })
  return asFile(new Blob([buf], { type: 'model/gltf-binary' }), 'knot.glb')
}

function vaseObj() {
  const prof = [[0, 0], [0.42, 0], [0.56, 0.08], [0.66, 0.34], [0.64, 0.66], [0.5, 0.98], [0.3, 1.22], [0.24, 1.42], [0.3, 1.56], [0.33, 1.6], [0, 1.6]]
  const pts = []
  for (let i = 0; i < prof.length - 1; i++) {
    for (let k = 0; k < 6; k++) {
      const t = k / 6
      pts.push(new THREE.Vector2(prof[i][0] + (prof[i + 1][0] - prof[i][0]) * t, prof[i][1] + (prof[i + 1][1] - prof[i][1]) * t))
    }
  }
  pts.push(new THREE.Vector2(0, 1.6))
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 96))
  return new OBJExporter().parse(mesh)
}

/* ------------------------------------------------------------- renderer --- */

const VERT = /* glsl */ `
  attribute float aSize;
  uniform float uSize, uFade, uRadius, uDist;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float px = uSize * aSize * (uDist / -mv.z);
    float drawn = max(px, 1.0);
    gl_PointSize = drawn;
    float depth = clamp((-mv.z - (uDist - uRadius)) / (2.0 * uRadius), 0.0, 1.0);
    vAlpha = (px * px) / (drawn * drawn) * (1.0 - uFade * depth);
  }`
const FRAG = /* glsl */ `
  uniform vec3 uCol;
  varying float vAlpha;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float aa = fwidth(r);
    float a = 1.0 - smoothstep(1.0 - aa, 1.0 + aa * 0.5, r);
    if (a <= 0.0) discard;
    gl_FragColor = vec4(uCol, a * vAlpha * 0.92);
  }`

const ROWS = {
  front8000: { label: 'Front · 8000', count: 8000, yaw: 0, pitch: 0 },
  front1000: { label: 'Front · 1000', count: 1000, yaw: 0, pitch: 0 },
  iso8000: { label: 'Three quarter · 8000', count: 8000, yaw: 38, pitch: -14 },
  side8000: { label: 'Side · 8000', count: 8000, yaw: 90, pitch: 0 },
}

function hashArray(a) {
  let h = 2166136261
  const u = new Uint32Array(a.buffer, a.byteOffset, a.length)
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619) >>> 0
  return h
}

async function run() {
  const t0 = performance.now()
  const [logo, photo, knot] = await Promise.all([logoPng(), photoJpg(), knotGlb()])
  const obj = vaseObj()
  const overrides = q.get('params') ? JSON.parse(q.get('params')) : {}

  const CASES = [
    { id: 'logo', title: 'Image · logo.png', source: { kind: 'image', file: logo } },
    { id: 'photo', title: 'Image · photo.jpg', source: { kind: 'image', file: photo } },
    { id: 'svg', title: 'SVG · arches.svg', source: { kind: 'svg', text: ARCHES_SVG, name: 'arches.svg' } },
    { id: 'text', title: 'Text · Pulviscolo', source: { kind: 'text', text: 'Pulviscolo' } },
    { id: 'glb', title: 'Model · knot.glb', source: { kind: 'model', file: knot } },
    { id: 'obj', title: 'Model · vase.obj', source: { kind: 'model', data: obj, name: 'vase.obj' } },
    { id: 'glbvol', title: 'Model · volume 0.5', source: { kind: 'model', file: knot }, params: { volume: 0.5 } },
    { id: 'outline', title: 'SVG · outline + extrude', source: { kind: 'svg', text: ARCHES_SVG, name: 'arches.svg' }, params: { strokeOnly: true, extrude: 0.06 } },
  ]
  const only = q.get('only') ? q.get('only').split(',') : null
  const cases = CASES.filter((c) => !only || only.includes(c.id))
  const rowIds = (q.get('rows') || 'front8000,front1000,iso8000').split(',').filter((r) => ROWS[r])

  const results = []
  for (const c of cases) {
    const params = { ...(c.params || {}), ...(overrides[c.id] || {}) }
    try {
      const shape = await createCustomShape(c.source, params, { seed: 1 })
      // warm rebuild: timing without font / loader warm-up, plus determinism
      const tw = performance.now()
      const again = await createCustomShape(c.source, params, { seed: 1 })
      const warmMs = Math.round(performance.now() - tw)
      const other = await createCustomShape(c.source, params, { seed: 2 })
      results.push({
        ...c,
        shape,
        out: {
          id: c.id,
          kind: c.source.kind,
          label: shape.meta.label,
          count: shape.count,
          ms: shape.meta.buildMs,
          warmMs,
          deterministic: hashArray(shape.positions) === hashArray(again.positions),
          seedChanges: hashArray(shape.positions) !== hashArray(other.positions),
          bounds: { min: shape.bounds.min.map((v) => +v.toFixed(3)), max: shape.bounds.max.map((v) => +v.toFixed(3)) },
          frame: shape.meta.frame,
          life: shape.meta.life,
          source: shape.meta.source,
        },
      })
    } catch (e) {
      console.error(e)
      results.push({ ...c, error: String(e.message || e), out: { id: c.id, error: String(e.message || e) } })
    }
  }

  // contract checks: file kinds + error messages
  const f = (name, type = '') => new File([new Uint8Array(4)], name, { type })
  const checks = {
    kinds: CUSTOM_KINDS,
    paramKinds: Object.keys(CUSTOM_PARAMS),
    kindFromFile: {
      'a.PNG': kindFromFile(f('a.PNG')),
      'b.jpeg': kindFromFile(f('b.jpeg')),
      'c.webp': kindFromFile(f('c.webp')),
      'd.svg': kindFromFile(f('d.svg')),
      'e.glb': kindFromFile(f('e.glb')),
      'f.gltf': kindFromFile(f('f.gltf')),
      'g.obj': kindFromFile(f('g.obj')),
      'h.stl': kindFromFile(f('h.stl')),
      'i.pdf': kindFromFile(f('i.pdf', 'application/pdf')),
      'noext(image/png)': kindFromFile(f('blob', 'image/png')),
    },
    errors: {},
  }
  const expectError = async (name, fn) => {
    try {
      await fn()
      checks.errors[name] = 'NO ERROR'
    } catch (e) {
      checks.errors[name] = String(e.message || e)
    }
  }
  const [wc, wg] = canvas2d(64, 64)
  wg.fillStyle = '#fff'
  wg.fillRect(0, 0, 64, 64)
  const blank = asFile(await toBlob(wc, 'image/png'), 'blank.png')
  await expectError('unsupported', () => createCustomShape({ file: f('i.pdf', 'application/pdf') }))
  await expectError('emptyImage', () => createCustomShape({ kind: 'image', file: blank }))
  await expectError('emptyText', () => createCustomShape({ kind: 'text', text: '   ' }))
  await expectError('badSvg', () => createCustomShape({ kind: 'svg', text: '<div>no</div>' }))
  await expectError('corruptImage', () => createCustomShape({ kind: 'image', file: f('x.png', 'image/png') }))
  await expectError('noMeshes', () => createCustomShape({ kind: 'model', data: '# empty\nv 0 0 0\n', name: 'empty.obj' }))
  await expectError('badModelExt', () => createCustomShape({ kind: 'model', data: 'xx', name: 'thing.fbx' }))

  // more source flavours: STL, glTF JSON with embedded buffers, white mark on
  // transparent, light-on-dark photo
  const extra = async (name, fn) => {
    try {
      const s = await fn()
      checks.extra[name] = { ok: true, ms: s.meta.buildMs, frame: s.meta.frame, src: s.meta.source }
    } catch (e) {
      checks.extra[name] = { ok: false, error: String(e.message || e) }
    }
  }
  checks.extra = {}
  const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js')
  const box = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3))
  await extra('stl', () => createCustomShape({ kind: 'model', data: new STLExporter().parse(box, { binary: true }), name: 'ico.stl' }))
  const gltfJson = await new GLTFExporter().parseAsync(box, { binary: false })
  await extra('gltfJson', () => createCustomShape({ kind: 'model', file: new File([JSON.stringify(gltfJson)], 'ico.gltf') }, { upAxis: '+Z', yaw: 30 }))
  const [lc, lg] = canvas2d(600, 300)
  lg.fillStyle = '#fff'
  lg.font = '700 220px sans-serif'
  lg.fillText('W', 200, 250)
  await extra('whiteOnTransparent', async () => createCustomShape({ kind: 'image', file: asFile(await toBlob(lc, 'image/png'), 'white.png') }))
  const [dc, dg] = canvas2d(800, 500)
  dg.fillStyle = '#101418'
  dg.fillRect(0, 0, 800, 500)
  const rg = dg.createRadialGradient(400, 250, 10, 400, 250, 200)
  rg.addColorStop(0, '#fff')
  rg.addColorStop(1, '#101418')
  dg.fillStyle = rg
  dg.fillRect(0, 0, 800, 500)
  await extra('lightOnDark', async () => createCustomShape({ kind: 'image', file: asFile(await toBlob(dc, 'image/jpeg', 0.9), 'glow.jpg') }))

  render(results, rowIds)
  const summary = results.map((r) => r.out)
  document.getElementById('sum').textContent =
    `${results.filter((r) => !r.error).length}/${results.length} built · total ${Math.round(performance.now() - t0)} ms`
  window.__custom = { results: summary, checks }
  document.body.dataset.ready = 'true'
}

function render(results, rowIds) {
  const canvas = document.getElementById('c')
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  renderer.setPixelRatio(dpr)
  const Wv = window.innerWidth
  const Hv = window.innerHeight
  renderer.setSize(Wv, Hv, false)
  renderer.setClearColor('#ffffff', 1)
  renderer.autoClear = false
  renderer.clear()

  const top = 36
  const left = 24
  const cols = results.length
  const cw = (Wv - left) / cols
  const ch = (Hv - top) / rowIds.length
  const size = +q.get('size') || 1.7

  rowIds.forEach((rid, ri) => {
    const row = document.createElement('div')
    row.className = 'row'
    row.style.top = `${top + ri * ch}px`
    row.style.height = `${ch}px`
    row.style.boxSizing = 'border-box'
    row.textContent = ROWS[rid].label
    document.body.appendChild(row)
  })

  results.forEach((res, ci) => {
    rowIds.forEach((rid, ri) => {
      const view = ROWS[rid]
      const x = left + ci * cw
      const y = top + ri * ch
      const cell = document.createElement('div')
      cell.className = 'cell' + (res.error ? ' err' : '')
      Object.assign(cell.style, { left: `${x}px`, top: `${y}px`, width: `${cw}px`, height: `${ch}px` })
      const num = String(ci + 1).padStart(2, '0')
      cell.innerHTML = `<div class="t"><b>${num}</b>${res.title}</div>` +
        `<div class="b"><span>${res.error ? res.error : `${view.count} pts`}</span><span>${res.error ? '' : `${res.out.ms} ms · warm ${res.out.warmMs} ms`}</span></div>`
      document.body.appendChild(cell)
      if (res.error) return
      const shape = res.shape
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(shape.positions, 3))
      geo.setAttribute('aSize', new THREE.BufferAttribute(shape.size, 1))
      geo.setDrawRange(0, view.count)
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uSize: { value: size * dpr * Math.pow(8000 / view.count, 0.2) },
          uFade: { value: 0.45 },
          uRadius: { value: shape.bounds.radius },
          uDist: { value: 1 },
          uCol: { value: new THREE.Color('#0d0d0d') },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
      })
      const scene = new THREE.Scene()
      scene.add(new THREE.Points(geo, mat))
      const aspect = cw / (ch - 44)
      const cam = new THREE.PerspectiveCamera(30, aspect, 0.01, 100)
      const tan = Math.tan(THREE.MathUtils.degToRad(15))
      const fill = 0.8
      let dist
      if (view.yaw === 0 && view.pitch === 0) {
        const hx = (shape.bounds.max[0] - shape.bounds.min[0]) / 2
        const hy = (shape.bounds.max[1] - shape.bounds.min[1]) / 2
        dist = Math.max(hy / fill, hx / (fill * aspect)) / tan + shape.bounds.max[2]
      } else {
        const r = shape.bounds.radius
        dist = Math.max(r / fill, r / (fill * aspect)) / tan
      }
      const yaw = THREE.MathUtils.degToRad(view.yaw)
      const pitch = THREE.MathUtils.degToRad(view.pitch)
      cam.position.set(dist * Math.sin(yaw) * Math.cos(pitch), -dist * Math.sin(pitch), dist * Math.cos(yaw) * Math.cos(pitch))
      cam.lookAt(0, 0, 0)
      mat.uniforms.uDist.value = dist
      // viewport in GL coords (origin bottom-left), leave room for the captions
      const vx = x
      const vy = Hv - (y + ch) + 22
      renderer.setViewport(vx, vy, cw, ch - 44)
      renderer.setScissor(vx, vy, cw, ch - 44)
      renderer.setScissorTest(true)
      renderer.render(scene, cam)
    })
  })
}

run().catch(fail)
