// Pulviscolo runtime: the renderer used by the editor AND every exported HTML.
// Contract: SPEC.md §5. Imports only three, ../state.js and ./ (export bundle).
//
// Layers, drawn in this order into one WebGL canvas:
//   1. background quad (solid + optional corner glow), skipped when transparent
//   2. dust: ambient points in a soft viewport-shaped ellipsoid
//   3. particles: the shape (morph, life, dissolve, wander on the GPU; hover
//      springs on the CPU through kinematics.js, uploaded as aOffset)

import * as THREE from 'three'
import { DEFAULT_CONFIG, MAX_COUNT, mergeConfig } from '../state.js'
import { PARTICLE_VERT, DUST_VERT, POINT_FRAG, BG_VERT, BG_FRAG } from './glsl.js'
import { Kinematics, createMotionState, LIFE_TYPES, MORPH_STYLES, DISSOLVE_MODES } from './kinematics.js'
import { createFlowField } from './noise.js'
import { clamp, damp, DEG, ease5, parseColor, rng32, bump, TAU } from './util.js'

const N = MAX_COUNT
const DUST_MAX = 8000
const HOVER_MODES = { repel: 0, attract: 1, swirl: 2, ripple: 3 }
const ORBIT_RETURN_DELAY = 1.2 // s after release before easing back to the configured view
const SHOCK_LIFE = 1.4 // s
const REF_W = 1600 // reference frame for particles.size (CSS px at this viewport)
const REF_H = 900

let FLOW = null
const flowField = () => (FLOW ||= createFlowField(7))

export class ParticleField {
  constructor(container, { config = DEFAULT_CONFIG, shape = null, pixelRatio, interactive = true, preserveDrawingBuffer = false, transparent = false } = {}) {
    this.container = container
    this.config = mergeConfig(DEFAULT_CONFIG, config || {})
    this.interactive = !!interactive
    this.transparent = !!transparent
    this.shape = null
    this.ready = false
    this.stats = { fps: 60, particles: 0, dust: 0, cpuMs: 0 }
    this._listeners = Object.create(null)
    this._pr = pixelRatio || Math.min(window.devicePixelRatio || 1, 2)
    this._renderPR = this._pr
    this._w = 1
    this._h = 1
    this._mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
    this._reduced = !!(this._mq && this._mq.matches)

    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer, powerPreference: 'high-performance' })
    renderer.setPixelRatio(this._pr)
    renderer.setClearColor(0x000000, 0)
    this.renderer = renderer
    this.canvas = renderer.domElement
    const cs = this.canvas.style
    cs.display = 'block'
    cs.width = '100%'
    cs.height = '100%'
    cs.outline = 'none'
    cs.webkitTapHighlightColor = 'transparent'
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative'
    container.appendChild(this.canvas)
    const gl = renderer.getContext()
    const ps = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)
    this._glMaxPoint = ps && ps[1] ? ps[1] : 256
    this._glMaxRB = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS))

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(this.config.camera.fov, 1, 0.05, 200)

    // scratch objects (no allocation in the frame loop)
    this._model = new THREE.Matrix4()
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ')
    this._dustMat = new THREE.Matrix4()
    this._dustEuler = new THREE.Euler(0, 0, 0, 'YXZ')
    this._camRot = new THREE.Matrix4()
    this._viewRotInv = new THREE.Matrix3()
    this._viewRot = new THREE.Matrix3()
    this._modelRot = new THREE.Matrix3()
    this._frameRot = new THREE.Matrix3()
    this._vp = new THREE.Matrix4()
    this._v3a = new THREE.Vector3()
    this._origin = new THREE.Vector3()
    this._up = new THREE.Vector3(0, 1, 0)

    this._M = createMotionState()
    this._M.model = this._model.elements
    this._M.frameRot = this._frameRot.elements
    this._M.viewRotInv = this._viewRotInv.elements

    this._initUniforms()
    this._initParticles()
    this._initDust()
    this._initBackground()
    this._kin = new Kinematics(this._A, this._M)

    // animation state
    this._time = 0
    this._swayPh = 0
    this._swayAmp = 0
    this._spin = 0
    this._floatPh = 0
    this._floatAmp = 0
    this._wanderT = 0
    this._dustT = 0
    this._dustYaw = 0
    this._lifeAmt = 0
    this._lifeMix = 1
    this._dissAmt = 0
    this._dissTau = 0.08
    this._dissRange = [-1, 1, 1]
    this._morph = { active: false, t: 0, dur: 1, stagger: 0, intro: false }
    this._fadeIn = 1
    this._morphSeed = 1
    this._countShown = this.config.count
    this._countAnim = { active: false, from: 0, to: 0, t: 0, dur: 0.9, w: 1 }
    this._drawN = 0
    this._camD = 6
    this._camDTarget = 6
    this._camDLambda = 0
    this._camFrom = 6
    this._camStartP = 0
    this._viewScale = 1
    this._viewScaleTarget = 1
    this._dustFade = 1
    this._colorKeys = ''
    this._orbit = { az: 0, el: 0, vaz: 0, vel: 0, zoom: 1, dragging: false, sinceRelease: 99, lastT: 0 }
    this._pointer = { x: -1e4, y: -1e4, sx: -1e4, sy: -1e4, inside: false, presence: 0, vx: 0, vy: 0, lt: 0, downX: 0, downY: 0, downT: 0, down: false, id: -1, lastX: 0, lastY: 0, px: 0, py: 0 }
    this._shocks = []
    for (let i = 0; i < 6; i++) this._shocks.push({ active: false, burst: false, x: 0, y: 0, t: 0 })
    this._asleep = true
    this._dtAvg = 1 / 60
    this._paused = false
    this._inView = true
    this._lost = false

    this._applyConfig(null)
    this.resize()
    if (shape) this.setShape(shape, { morph: false })
    this._bindEvents()

    this._timer = new THREE.Timer()
    this._loop = (ts) => this._frame(ts)
    this._raf = requestAnimationFrame(this._loop)
  }

  /* ------------------------------------------------------------ events -- */

  on(evt, fn) {
    ;(this._listeners[evt] ||= []).push(fn)
    return () => this.off(evt, fn)
  }

  off(evt, fn) {
    const l = this._listeners[evt]
    if (!l) return
    const i = l.indexOf(fn)
    if (i >= 0) l.splice(i, 1)
  }

  _emit(evt, a, b) {
    const l = this._listeners[evt]
    if (!l) return
    for (let i = 0; i < l.length; i++) {
      try {
        l[i](a, b)
      } catch (err) {
        console.error(err)
      }
    }
  }

  /* ------------------------------------------------------------- setup -- */

  _initUniforms() {
    const u = (value) => ({ value })
    // shared between particles and dust
    const shared = {
      uSize: u(2.2),
      uPR: u(this._pr),
      uFrameDist: u(6),
      uMinPx: u(1),
      uMaxPx: u(this._glMaxPoint),
      uDof: u(0),
      uFocusDepth: u(6),
      uCocScale: u(10),
      uCocMax: u(24),
      uSoftness: u(0.1),
      uColor0: u(new THREE.Vector3(0.05, 0.05, 0.05)),
    }
    this._shared = shared
    this._pu = {
      ...shared,
      uMorphP: u(1),
      uStagger: u(0),
      uMorphTurb: u(0),
      uMorphStyle: u(0),
      uLifeType: u(0),
      uLifeAmt: u(0),
      uLifeT: u(0),
      uHelixPh: u(0),
      uCenter: u(new THREE.Vector3()),
      uAxis: u(new THREE.Vector3(0, 1, 0)),
      uWander: u(0),
      uWanderScale: u(1.2),
      uWanderT: u(0),
      uFrameRot: u(this._frameRot),
      uViewRotInv: u(this._viewRotInv),
      uDissMode: u(0),
      uDissDir: u(new THREE.Vector2(1, 0)),
      uDissAmt: u(0),
      uDissSoft: u(0.35),
      uDissLen: u(0.7),
      uDissTurb: u(0.5),
      uDissFade: u(0.85),
      uDissT: u(0),
      uDissMin: u(-1),
      uDissMax: u(1),
      uDissRad: u(1),
      uCount: u(N),
      uCountBand: u(1e-3),
      uSizeVar: u(0.6),
      uCountComp: u(1),
      uColor1: u(new THREE.Vector3(0.05, 0.05, 0.05)),
      uColor2: u(new THREE.Vector3(0.05, 0.05, 0.05)),
      uOpacity0: u(0.92),
      uOpacity1: u(0.5),
      uOpacity2: u(0.8),
      uShading: u(0.3),
      uLight: u(new THREE.Vector3(-0.5, 0.62, 0.6).normalize()),
      uFadeNear: u(5),
      uFadeFar: u(7),
      uDepthFade: u(0.55),
    }
    this._du = {
      ...shared,
      uDustRadii: u(new THREE.Vector3(3, 2, 2)),
      uDustT: u(0),
      uDustAmp: u(0.05),
      uDustSize: u(1),
      uDustOpacity: u(0.2),
      uDustFade: u(1),
      uCursor: u(new THREE.Vector2(-1e4, -1e4)),
      uResCss: u(new THREE.Vector2(1, 1)),
      uCursorR: u(100),
      uCursorPush: u(0),
      uParallax: u(new THREE.Vector2()),
    }
    this._bu = {
      uBg: u(new THREE.Vector3(1, 1, 1)),
      uGlowColor: u(new THREE.Vector3(0.86, 0.91, 0.97)),
      uGlow: u(0),
      uRes: u(new THREE.Vector2(1, 1)),
    }
  }

  _initParticles() {
    const A = (this._A = {
      position: new Float32Array(N * 3),
      normal: new Float32Array(N * 3),
      data: new Float32Array(N * 4),
      from: new Float32Array(N * 3),
      fromNormal: new Float32Array(N * 3),
      fromData: new Float32Array(N * 4),
      detour: new Float32Array(N * 3),
      offset: new Float32Array(N * 3),
      scatter: new Float32Array(N * 3),
      rand: new Float32Array(N * 4),
      noise: new Float32Array(N * 4),
      noiseFrom: new Float32Array(N * 4),
    })
    this._vel = new Float32Array(N * 3)
    this._scr = new Float32Array(N * 2).fill(-1e5) // last projected CSS px per particle (hover culling)
    this._simFrame = 0
    const rnd = rng32(0x5eed1)
    for (let i = 0; i < N; i++) {
      for (let c = 0; c < 4; c++) A.rand[i * 4 + c] = rnd()
      // uniform in the unit ball
      let x, y, z
      do {
        x = rnd() * 2 - 1
        y = rnd() * 2 - 1
        z = rnd() * 2 - 1
      } while (x * x + y * y + z * z > 1)
      A.scatter[i * 3] = x
      A.scatter[i * 3 + 1] = y
      A.scatter[i * 3 + 2] = z
      A.data[i * 4] = 1
      A.data[i * 4 + 3] = i
      A.fromData[i * 4] = 1
      A.fromData[i * 4 + 3] = 1
      A.normal[i * 3 + 2] = 1
      A.fromNormal[i * 3 + 2] = 1
    }
    const geo = new THREE.BufferGeometry()
    const add = (name, arr, size, dynamic) => {
      const a = new THREE.BufferAttribute(arr, size)
      if (dynamic) a.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute(name, a)
      return a
    }
    this._attr = {
      position: add('position', A.position, 3),
      normal: add('normal', A.normal, 3),
      data: add('aData', A.data, 4),
      from: add('aFrom', A.from, 3),
      fromNormal: add('aFromNormal', A.fromNormal, 3),
      fromData: add('aFromData', A.fromData, 4),
      detour: add('aDetour', A.detour, 3),
      offset: add('aOffset', A.offset, 3, true),
      scatter: add('aScatter', A.scatter, 3),
      rand: add('aRand', A.rand, 4),
      noise: add('aNoise', A.noise, 4),
      noiseFrom: add('aNoiseFrom', A.noiseFrom, 4),
    }
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5)
    geo.setDrawRange(0, 0)
    this._geo = geo
    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: this._pu,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
    })
    this.points = new THREE.Points(geo, this.material)
    this.points.frustumCulled = false
    this.points.matrixAutoUpdate = false
    this.points.renderOrder = 2
    this.scene.add(this.points)
  }

  _initDust() {
    const pos = new Float32Array(DUST_MAX * 3)
    const rand = new Float32Array(DUST_MAX * 4)
    const rnd = rng32(0xd057)
    for (let i = 0; i < DUST_MAX; i++) {
      // ball sample thinned towards the rim, random order so any prefix is uniform
      let x, y, z, r2
      for (;;) {
        x = rnd() * 2 - 1
        y = rnd() * 2 - 1
        z = rnd() * 2 - 1
        r2 = x * x + y * y + z * z
        if (r2 <= 1 && rnd() < 1 - 0.45 * r2) break
      }
      pos[i * 3] = x
      pos[i * 3 + 1] = y
      pos[i * 3 + 2] = z
      for (let c = 0; c < 4; c++) rand[i * 4 + c] = rnd()
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 4))
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5)
    geo.setDrawRange(0, 0)
    this._dustGeo = geo
    this._dustPos = pos
    this.dustMaterial = new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: this._du,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
    })
    this.dust = new THREE.Points(geo, this.dustMaterial)
    this.dust.frustumCulled = false
    this.dust.matrixAutoUpdate = false
    this.dust.renderOrder = 1
    this.scene.add(this.dust)
  }

  _initBackground() {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
    this._bgGeo = geo
    this.bgMaterial = new THREE.ShaderMaterial({
      vertexShader: BG_VERT,
      fragmentShader: BG_FRAG,
      uniforms: this._bu,
      depthTest: false,
      depthWrite: false,
    })
    this.background = new THREE.Mesh(geo, this.bgMaterial)
    this.background.frustumCulled = false
    this.background.renderOrder = -10
    this.scene.add(this.background)
  }

  _bindEvents() {
    this._ro = new ResizeObserver(() => this.resize())
    this._ro.observe(this.container)
    if (typeof IntersectionObserver === 'function') {
      this._io = new IntersectionObserver((entries) => {
        const e = entries[entries.length - 1]
        this._inView = e.isIntersecting
      })
      this._io.observe(this.container)
    }
    this._onVisibility = () => {
      this._paused = document.hidden
    }
    document.addEventListener('visibilitychange', this._onVisibility)
    if (this._mq) {
      this._onReduced = () => {
        this._reduced = this._mq.matches
      }
      this._mq.addEventListener?.('change', this._onReduced)
    }
    this._onLost = (e) => {
      e.preventDefault()
      this._lost = true
    }
    this._onRestored = () => {
      this._lost = false
      this._regeometry()
    }
    this.canvas.addEventListener('webglcontextlost', this._onLost)
    this.canvas.addEventListener('webglcontextrestored', this._onRestored)

    if (!this.interactive) return
    const c = this.canvas
    this._onMove = (e) => this._pointerMove(e)
    this._onDown = (e) => this._pointerDown(e)
    this._onUp = (e) => this._pointerUp(e)
    this._onLeave = (e) => {
      if (this._pointer.down && e.pointerId === this._pointer.id) return
      this._pointer.inside = false
    }
    this._onWheel = (e) => this._wheel(e)
    c.addEventListener('pointermove', this._onMove)
    c.addEventListener('pointerdown', this._onDown)
    c.addEventListener('pointerup', this._onUp)
    c.addEventListener('pointercancel', this._onUp)
    c.addEventListener('pointerleave', this._onLeave)
    this._syncWheel()
  }

  // After a context restore three.js rebuilds its GL state, but the old
  // geometry 'dispose' listeners would later delete buffers from the dead
  // context (console warnings). Fresh geometry objects over the same arrays.
  _regeometry() {
    const swap = (old, mesh) => {
      const geo = new THREE.BufferGeometry()
      for (const [name, a] of Object.entries(old.attributes)) {
        const b = new THREE.BufferAttribute(a.array, a.itemSize)
        b.setUsage(a.usage)
        geo.setAttribute(name, b)
      }
      geo.boundingSphere = old.boundingSphere
      geo.drawRange.start = old.drawRange.start
      geo.drawRange.count = old.drawRange.count
      mesh.geometry = geo
      return geo
    }
    this._geo = swap(this._geo, this.points)
    const at = this._geo.attributes
    this._attr = {
      position: at.position,
      normal: at.normal,
      data: at.aData,
      from: at.aFrom,
      fromNormal: at.aFromNormal,
      fromData: at.aFromData,
      detour: at.aDetour,
      offset: at.aOffset,
      scatter: at.aScatter,
      rand: at.aRand,
      noise: at.aNoise,
      noiseFrom: at.aNoiseFrom,
    }
    this._dustGeo = swap(this._dustGeo, this.dust)
    this._bgGeo = swap(this._bgGeo, this.background)
  }

  _syncWheel() {
    const want = this.interactive && !!this.config.camera.zoom
    if (want === !!this._wheelOn) return
    if (want) this.canvas.addEventListener('wheel', this._onWheel, { passive: false })
    else this.canvas.removeEventListener('wheel', this._onWheel)
    this._wheelOn = want
    this.canvas.style.touchAction = this.config.camera.orbit ? 'pan-y' : 'auto'
  }

  /* ------------------------------------------------------------ pointer -- */

  _pointerMove(e) {
    const P = this._pointer
    const x = e.offsetX
    const y = e.offsetY
    const now = performance.now()
    const dtm = Math.max((now - P.lt) / 1000, 1 / 240)
    if (P.inside && dtm < 0.2) {
      // smoothed cursor velocity, px/s
      const k = 0.35
      P.vx += ((x - P.x) / dtm - P.vx) * k
      P.vy += ((y - P.y) / dtm - P.vy) * k
    } else {
      P.vx = 0
      P.vy = 0
    }
    P.lt = now
    if (!P.inside) {
      P.sx = x
      P.sy = y
    }
    P.x = x
    P.y = y
    P.inside = true
    if (P.down && e.pointerId === P.id && this.config.camera.orbit) {
      const dx = e.clientX - P.lastX
      const dy = e.clientY - P.lastY
      P.lastX = e.clientX
      P.lastY = e.clientY
      const moved = Math.hypot(e.clientX - P.downX, e.clientY - P.downY)
      if (moved > 5) this._orbit.dragging = true
      if (this._orbit.dragging) {
        const O = this._orbit
        O.az -= dx * 0.3
        O.el = clamp(O.el + dy * 0.22, -80, 80)
        // velocity in deg/s, smoothed over the last few events
        const dts = Math.max((now - O.lastT) / 1000, 1 / 240)
        O.lastT = now
        O.vaz += ((-dx * 0.3) / dts - O.vaz) * 0.4
        O.vel += ((dy * 0.22) / dts - O.vel) * 0.4
        O.sinceRelease = 0
      }
    }
  }

  _pointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const P = this._pointer
    P.down = true
    P.id = e.pointerId
    P.downX = P.lastX = e.clientX
    P.downY = P.lastY = e.clientY
    P.downT = performance.now()
    P.x = e.offsetX
    P.y = e.offsetY
    if (!P.inside) {
      P.sx = P.x
      P.sy = P.y
    }
    P.inside = true
    this._orbit.vaz = 0
    this._orbit.vel = 0
    this._orbit.lastT = performance.now()
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {}
  }

  _pointerUp(e) {
    const P = this._pointer
    if (!P.down || e.pointerId !== P.id) return
    P.down = false
    try {
      this.canvas.releasePointerCapture(e.pointerId)
    } catch {}
    const O = this._orbit
    const wasDrag = O.dragging
    O.dragging = false
    O.sinceRelease = 0
    // a pause before release means no throw
    if (performance.now() - O.lastT > 90) O.vaz = O.vel = 0
    O.vaz = clamp(O.vaz, -160, 160)
    O.vel = clamp(O.vel, -120, 120)
    const moved = Math.hypot(e.clientX - P.downX, e.clientY - P.downY)
    const held = performance.now() - P.downT
    if (e.type === 'pointerup' && !wasDrag && moved < 6 && held < 650) {
      this._click(e.offsetX, e.offsetY)
      this._emit('click', e.offsetX, e.offsetY)
    }
    if (e.pointerType !== 'mouse') P.inside = false
  }

  _wheel(e) {
    if (!this.config.camera.zoom) return
    e.preventDefault()
    const O = this._orbit
    O.zoom = clamp(O.zoom * Math.exp(e.deltaY * 0.0012), 0.3, 3)
  }

  _click(x, y) {
    const mode = this.config.hover.click
    if (mode === 'none') return
    this._spawnShock(x, y, mode === 'burst')
  }

  _spawnShock(x, y, burst) {
    let slot = null
    for (const s of this._shocks) if (!s.active) slot = s
    if (!slot) slot = this._shocks.reduce((a, b) => (a.t > b.t ? a : b))
    slot.active = true
    slot.burst = burst
    slot.x = x
    slot.y = y
    slot.t = 0
    this._asleep = false
  }

  /* ---------------------------------------------------------- public API -- */

  setConfig(patch) {
    if (!patch) return
    const prev = this.config
    this.config = mergeConfig(prev, patch)
    this._applyConfig(prev)
  }

  setCount(n) {
    this.setConfig({ count: n })
  }

  setInteractive(on) {
    if (!!on === this.interactive) return
    this._unbindPointer()
    this.interactive = !!on
    if (this.interactive) {
      // rebind everything pointer-related
      const c = this.canvas
      this._onMove ||= (e) => this._pointerMove(e)
      this._onDown ||= (e) => this._pointerDown(e)
      this._onUp ||= (e) => this._pointerUp(e)
      this._onLeave ||= (e) => {
        if (this._pointer.down && e.pointerId === this._pointer.id) return
        this._pointer.inside = false
      }
      this._onWheel ||= (e) => this._wheel(e)
      c.addEventListener('pointermove', this._onMove)
      c.addEventListener('pointerdown', this._onDown)
      c.addEventListener('pointerup', this._onUp)
      c.addEventListener('pointercancel', this._onUp)
      c.addEventListener('pointerleave', this._onLeave)
    } else {
      this._pointer.inside = false
    }
    this._syncWheel()
  }

  setTransparent(on) {
    this.transparent = !!on
  }

  get morphing() {
    return this._morph.active
  }

  setShape(shape, { morph = true, intro } = {}) {
    if (!shape || !shape.positions) return
    const A = this._A
    const M = this._M
    const kin = this._kin
    const cfg = this.config.morph
    const first = !this.shape
    const useIntro = first && (intro ?? cfg.intro) && !this._reduced
    const animate = first ? !!useIntro : morph !== false
    const n = Math.min(shape.count || shape.positions.length / 3, N)

    // 1. the morph source is what is on screen right now (in-flight morphs, life included)
    if (animate && !first) {
      for (let i = 0; i < N; i++) {
        const b = kin.local(i)
        const e = kin.e
        const i3 = i * 3
        const i4 = i * 4
        A.from[i3] = b[0]
        A.from[i3 + 1] = b[1]
        A.from[i3 + 2] = b[2]
        A.fromNormal[i3] = kin.nrm[0]
        A.fromNormal[i3 + 1] = kin.nrm[1]
        A.fromNormal[i3 + 2] = kin.nrm[2]
        A.fromData[i4] += (A.data[i4] - A.fromData[i4]) * e
        A.fromData[i4 + 1] = e < 0.5 ? A.fromData[i4 + 1] : A.data[i4 + 1]
        A.fromData[i4 + 3] += (1 - A.fromData[i4 + 3]) * e
        for (let c = 0; c < 4; c++) A.noiseFrom[i4 + c] += (A.noise[i4 + c] - A.noiseFrom[i4 + c]) * e
      }
    }

    // 2. new targets (indices past the shape's own count reuse its points, hidden by count)
    const sp = shape.positions, sn = shape.normal, ss = shape.size, sg = shape.group, sa = shape.aux
    for (let i = 0; i < N; i++) {
      const j = i < n ? i : i % n
      const i3 = i * 3
      const j3 = j * 3
      A.position[i3] = sp[j3]
      A.position[i3 + 1] = sp[j3 + 1]
      A.position[i3 + 2] = sp[j3 + 2]
      if (sn) {
        A.normal[i3] = sn[j3]
        A.normal[i3 + 1] = sn[j3 + 1]
        A.normal[i3 + 2] = sn[j3 + 2]
      }
      A.data[i * 4] = ss ? ss[j] : 1
      A.data[i * 4 + 1] = sg ? sg[j] : 0
      A.data[i * 4 + 2] = sa ? sa[j] : 0
    }

    // 3. coherent noise for the band edge and the dust turbulence
    const flow = flowField()
    for (let i = 0; i < N; i++) flow.sample(A.position[i * 3], A.position[i * 3 + 1], A.position[i * 3 + 2], A.noise, i * 4)

    const R = shape.bounds?.radius || 1
    this.shape = shape
    this._radius = R
    if (first) this._updateFit(true)

    if (first && useIntro) {
      // condense out of a soft cloud shaped like the dust field
      const rnd = rng32(0x1a7f0)
      const rx = this._du.uDustRadii.value.x * 0.75
      const ry = this._du.uDustRadii.value.y * 0.75
      const rz = this._du.uDustRadii.value.z * 0.75
      for (let i = 0; i < N; i++) {
        let x, y, z
        do {
          x = rnd() * 2 - 1
          y = rnd() * 2 - 1
          z = rnd() * 2 - 1
        } while (x * x + y * y + z * z > 1)
        const r = Math.pow(rnd(), 0.6)
        const l = Math.hypot(x, y, z) || 1
        const i3 = i * 3
        const i4 = i * 4
        A.from[i3] = (x / l) * r * rx
        A.from[i3 + 1] = (y / l) * r * ry
        A.from[i3 + 2] = (z / l) * r * rz
        A.fromNormal[i3] = x / l
        A.fromNormal[i3 + 1] = y / l
        A.fromNormal[i3 + 2] = z / l
        A.fromData[i4] = 0.55
        A.fromData[i4 + 1] = A.data[i4 + 1]
        A.fromData[i4 + 3] = 0.3
        for (let c = 0; c < 4; c++) A.noiseFrom[i4 + c] = A.noise[i4 + c]
      }
      this._dustFade = 0
      this._fadeIn = 0
    }

    if (!animate) {
      A.from.set(A.position)
      A.fromNormal.set(A.normal)
      A.noiseFrom.set(A.noise)
      for (let i = 0; i < N; i++) {
        A.fromData[i * 4] = A.data[i * 4]
        A.fromData[i * 4 + 1] = A.data[i * 4 + 1]
        A.fromData[i * 4 + 3] = 1
      }
      A.detour.fill(0)
    } else {
      this._planMorph(useIntro ? 'intro' : cfg.style, R)
    }

    // life restarts with the new shape and fades in with the morph
    const meta = shape.meta || {}
    M.lifeType = LIFE_TYPES[meta.life] ?? 0
    const ctr = meta.center || [0, 0, 0]
    M.center[0] = ctr[0]
    M.center[1] = ctr[1]
    M.center[2] = ctr[2]
    const ax = meta.axis || [0, 1, 0]
    const al = Math.hypot(ax[0], ax[1], ax[2]) || 1
    M.axis[0] = ax[0] / al
    M.axis[1] = ax[1] / al
    M.axis[2] = ax[2] / al
    M.lifeT = 0
    M.helixPh = 0
    this._lifeAmt = 0
    this._lifeMix = animate ? 0 : 1

    const m = this._morph
    m.active = animate
    m.t = 0
    m.dur = animate ? Math.max(0.05, cfg.duration * (useIntro ? 1.5 : 1)) : 1
    m.intro = !!useIntro
    const st = clamp(cfg.stagger, 0, 1)
    const style = useIntro ? 'intro' : cfg.style
    m.stagger = !animate ? 0 : style === 'sweep' ? Math.max(st, 0.6) * 0.85 : style === 'explode' ? st * 0.5 : style === 'intro' ? Math.max(st, 0.5) * 0.85 : st * 0.85
    M.morphP = animate ? 0 : 1
    M.morphStyle = MORPH_STYLES[useIntro ? 'flow' : cfg.style] ?? 0
    this._dissTau = animate ? m.dur * 0.3 : 0.08
    if (!first) this._updateFit(!animate)
    if (!animate) this._dissAmt = this.config.dissolve.amount

    // count may be capped by a shape carrying fewer points (exports)
    const target = this._targetCount()
    if (Math.abs(target - this._countShown) > 0.5) this._startCount(target)
    this._drawN = this._computeDrawN()

    for (const a of Object.values(this._attr)) if (a !== this._attr.offset) a.needsUpdate = true
    this._asleep = false
    this.stats.particles = Math.round(this._countShown)
    if (!animate) this._emitLater = 'morphend'
  }

  _planMorph(style, R) {
    const A = this._A
    const rnd = rng32(0x6d0 + this._morphSeed++ * 7919)
    const flow = flowField()
    const tmp = this._corner4 || (this._corner4 = new Float32Array(4))
    const C = this._M.center
    let sweepMin = Infinity
    let sweepMax = -Infinity
    const sweep = style === 'sweep'
    if (sweep) {
      // screen-x order of the targets as seen now
      this._updateMotion()
      this._updateCamera()
    }
    const m = this._model.elements
    const vp = this._vp.elements
    for (let i = 0; i < N; i++) {
      const i3 = i * 3
      const i4 = i * 4
      const tx = A.position[i3], ty = A.position[i3 + 1], tz = A.position[i3 + 2]
      const fx = A.from[i3], fy = A.from[i3 + 1], fz = A.from[i3 + 2]
      // detour sampled near the source: neighbours leave together, in ribbons
      const mx = fx + (tx - fx) * 0.35
      const my = fy + (ty - fy) * 0.35
      const mz = fz + (tz - fz) * 0.35
      flow.sample(mx * 0.9, my * 0.9, mz * 0.9, tmp, 0)
      let dx, dy, dz
      if (style === 'explode') {
        let ox = mx - C[0], oy = my - C[1], oz = mz - C[2]
        const l = Math.hypot(ox, oy, oz) || 1
        const s = R * (0.55 + 0.6 * rnd())
        dx = (ox / l) * s + tmp[1] * R * 0.25
        dy = (oy / l) * s + tmp[2] * R * 0.25
        dz = (oz / l) * s + tmp[3] * R * 0.25
      } else if (sweep) {
        dx = tmp[1] * R * 0.22
        dy = tmp[2] * R * 0.22
        dz = tmp[3] * R * 0.22 + R * 0.28
      } else {
        const s = style === 'intro' ? 0.85 : 0.75
        dx = tmp[1] * R * s
        dy = tmp[2] * R * s
        dz = tmp[3] * R * s
      }
      A.detour[i3] = dx
      A.detour[i3 + 1] = dy
      A.detour[i3 + 2] = dz
      if (sweep) {
        const wx = m[0] * tx + m[4] * ty + m[8] * tz + m[12]
        const wy = m[1] * tx + m[5] * ty + m[9] * tz + m[13]
        const wz = m[2] * tx + m[6] * ty + m[10] * tz + m[14]
        const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15]
        const sx = (vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12]) / (cw || 1)
        A.fromData[i4 + 2] = sx
        if (sx < sweepMin) sweepMin = sx
        if (sx > sweepMax) sweepMax = sx
      } else if (style === 'explode') {
        A.fromData[i4 + 2] = rnd()
      } else {
        // an organic departure front: smooth noise over the source + a slow diagonal + grain
        flow.sample(fx * 0.55 + 3.1, fy * 0.55 - 1.7, fz * 0.55, tmp, 0)
        const wave = (fx - fy) / (2.8 * R) + 0.5
        A.fromData[i4 + 2] = clamp(0.5 + tmp[0] * 0.55, 0, 1) * 0.5 + clamp(wave, 0, 1) * 0.25 + rnd() * 0.25
      }
    }
    if (sweep) {
      const span = Math.max(sweepMax - sweepMin, 1e-6)
      for (let i = 0; i < N; i++) {
        const i4 = i * 4
        A.fromData[i4 + 2] = clamp(((A.fromData[i4 + 2] - sweepMin) / span) * 0.88 + rnd() * 0.12, 0, 1)
      }
    }
  }

  resetView() {
    const O = this._orbit
    O.az = O.el = O.vaz = O.vel = 0
    O.zoom = 1
    O.dragging = false
    this._updateFit(true)
  }

  burst(xCss, yCss) {
    const x = xCss ?? this._w / 2
    const y = yCss ?? this._h / 2
    const mode = this.config.hover.click
    this._spawnShock(x, y, mode !== 'shockwave')
  }

  getCameraState() {
    const c = this.config.camera
    return { azimuth: c.azimuth + this._orbit.az, elevation: c.elevation + this._orbit.el, distance: this.camera.position.length() }
  }

  captureStream(fps = 60) {
    return this.canvas.captureStream(fps)
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth || 1)
    const h = Math.max(1, this.container.clientHeight || 1)
    this._w = w
    this._h = h
    this.renderer.setSize(w, h, false)
    this._updateFit(true)
    this._setResolutionUniforms()
    if (this.ready && !this._lost) this._renderNow()
  }

  /* ---------------------------------------------------------- snapshot -- */

  async snapshot({ scale = 2, transparent = false } = {}) {
    const w = this._w
    const h = this._h
    let pr = this._pr * Math.max(0.1, scale)
    pr = Math.min(pr, this._glMaxRB / w, this._glMaxRB / h, Math.sqrt(120e6 / (w * h)))
    const keepT = this.transparent
    this._renderPR = pr
    this.renderer.setPixelRatio(pr)
    this.renderer.setSize(w, h, false)
    this._setResolutionUniforms()
    this.transparent = transparent || keepT
    this._pushUniforms()
    this._render()
    // the copy is taken synchronously, so no preserveDrawingBuffer is needed
    const blob = new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'))
    this.transparent = keepT
    this._renderPR = this._pr
    this.renderer.setPixelRatio(this._pr)
    this.renderer.setSize(w, h, false)
    this._setResolutionUniforms()
    this._pushUniforms()
    this._render()
    return blob
  }

  /* ------------------------------------------------------------ dispose -- */

  _unbindPointer() {
    const c = this.canvas
    if (!this._onMove) return
    c.removeEventListener('pointermove', this._onMove)
    c.removeEventListener('pointerdown', this._onDown)
    c.removeEventListener('pointerup', this._onUp)
    c.removeEventListener('pointercancel', this._onUp)
    c.removeEventListener('pointerleave', this._onLeave)
    if (this._wheelOn) c.removeEventListener('wheel', this._onWheel)
    this._wheelOn = false
  }

  dispose() {
    if (this._disposed) return
    this._disposed = true
    cancelAnimationFrame(this._raf)
    this._ro?.disconnect()
    this._io?.disconnect()
    document.removeEventListener('visibilitychange', this._onVisibility)
    if (this._mq && this._onReduced) this._mq.removeEventListener?.('change', this._onReduced)
    this._unbindPointer()
    this.canvas.removeEventListener('webglcontextlost', this._onLost)
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored)
    this._geo.dispose()
    this._dustGeo.dispose()
    this._bgGeo.dispose()
    this.material.dispose()
    this.dustMaterial.dispose()
    this.bgMaterial.dispose()
    this._timer?.dispose?.()
    this.renderer.dispose()
    this.renderer.forceContextLoss?.()
    this.canvas.remove()
    this._listeners = Object.create(null)
  }

  /* ------------------------------------------------------- config apply -- */

  _targetCount() {
    const cap = this.shape ? Math.min(this.shape.count || N, N) : N
    return clamp(Math.round(this.config.count || N), 1, cap)
  }

  _startCount(to) {
    const a = this._countAnim
    a.active = true
    a.from = this._countShown
    a.to = to
    a.t = 0
    a.dur = clamp(0.55 + Math.abs(to - this._countShown) / 9000, 0.55, 1.3)
    a.w = Math.abs(to - this._countShown) * 0.35 + 120
    this._asleep = false
  }

  _computeDrawN() {
    const a = this._countAnim
    const band = this._pu.uCountBand.value
    const m = a.active ? Math.max(this._countShown + band, a.to) : this._countShown
    return clamp(Math.ceil(m) + 1, 0, this.shape ? N : 0)
  }

  _applyConfig(prev) {
    const c = this.config
    const target = this._targetCount()
    if (!prev) {
      this._countShown = target
    } else if (c.count !== prev.count) {
      if (Math.abs(target - this._countShown) > 0.5 || this._countAnim.active) this._startCount(target)
    }
    // colours only re-parse when they change
    const p = c.particles
    const s = c.scene
    const key = `${p.color}|${p.colorB}|${p.colorC}|${s.background}|${s.glowColor}`
    if (key !== this._colorKeys) {
      this._colorKeys = key
      const tmp = [0, 0, 0]
      this._pu.uColor0.value.fromArray(parseColor(p.color, tmp))
      this._pu.uColor1.value.fromArray(parseColor(p.colorB, tmp))
      this._pu.uColor2.value.fromArray(parseColor(p.colorC, tmp))
      this._bu.uBg.value.fromArray(parseColor(s.background, tmp))
      this._bu.uGlowColor.value.fromArray(parseColor(s.glowColor, tmp))
    }
    if (!prev || c.dissolve.amount !== prev.dissolve.amount) this._asleep = false
    if (!prev) this._dissAmt = c.dissolve.amount
    // full-config pushes (editor) must not snap an in-flight camera transition
    const cam = c.camera
    const pc = prev && prev.camera
    const fitChanged = !pc || cam.fov !== pc.fov || cam.autoFit !== pc.autoFit || cam.frame !== pc.frame || cam.distance !== pc.distance
    if (fitChanged) this._updateFit(this._camDLambda === 0)
    else this._updateDustRadii()
    if (this.canvas && this._onWheel !== undefined) this._syncWheel()
    this._dustGeo.setDrawRange(0, clamp(Math.round(c.dust.count), 0, DUST_MAX))
    this.stats.dust = clamp(Math.round(c.dust.count), 0, DUST_MAX)
    this._drawN = this._computeDrawN()
  }

  // camera distance that frames the FRONT bbox per shape.meta.frame × camera.frame
  _fitDistance(w = this._w, h = this._h) {
    const c = this.config.camera
    if (!c.autoFit) return Math.max(0.5, c.distance)
    const sh = this.shape
    const b = sh?.bounds || { min: [-1, -1, -1], max: [1, 1, 1] }
    const fr = sh?.meta?.frame || { h: 0.6 }
    const tanH = Math.tan((c.fov * DEG) / 2)
    const aspect = w / h
    const bw = Math.max(b.max[0] - b.min[0], 1e-3)
    const bh = Math.max(b.max[1] - b.min[1], 1e-3)
    let d = 0
    if (fr.h) d = Math.max(d, bh / (2 * tanH * fr.h))
    if (fr.w) d = Math.max(d, bw / (2 * tanH * aspect * fr.w))
    if (!d) d = bh / (2 * tanH * 0.6)
    // never let the bbox overflow the viewport at frame 1 (portrait phones)
    d = Math.max(d, bh / (2 * tanH * 0.94), bw / (2 * tanH * aspect * 0.94))
    // the front face sits nearer than the centre
    d += Math.max(0, b.max[2]) * 0.5
    return d / clamp(c.frame || 1, 0.05, 10)
  }

  _updateFit(snap) {
    const d = this._fitDistance()
    this._camDTarget = d
    // dots and hover radius follow the poster's scale: px per world unit here vs on
    // a 1600 x 900 reference frame (sub-linear, clamped) so a phone or a small
    // embed reads like the same print, not a denser blob
    const ref = this._fitDistance(REF_W, REF_H)
    const r = (this._h / d) / (REF_H / ref)
    this._viewScaleTarget = Math.pow(clamp(r, 0.35, 1.7), 0.8)
    if (snap || !this.ready) this._viewScale = this._viewScaleTarget
    if (snap || !this.ready) {
      this._camD = d
      this._camDLambda = 0
    } else if (this._morph.active) {
      // the camera travels with the particles: distance follows morph progress
      this._camFrom = this._camD
      this._camStartP = this._M.morphP
      this._camDLambda = -1
    } else {
      this._camDLambda = 6
    }
    this._updateDustRadii()
  }

  _updateDustRadii() {
    const c = this.config
    const tanH = Math.tan((c.camera.fov * DEG) / 2)
    const halfH = this._camD * tanH
    const aspect = this._w / this._h
    const r = c.dust.radius
    const R = this._radius || 1
    const ry = Math.max(halfH * 0.98, R * 1.25) * r
    const rx = Math.max(halfH * aspect * 0.98, R * 1.25) * r
    const rz = Math.min(ry * 0.8, this._camD * 0.55)
    this._du.uDustRadii.value.set(rx, ry, rz)
  }

  _setResolutionUniforms() {
    const pr = this._renderPR
    this._shared.uPR.value = pr
    this._bu.uRes.value.set(this._w * pr, this._h * pr)
    this._du.uResCss.value.set(this._w, this._h)
  }

  /* ------------------------------------------------------------- frame -- */

  _frame(ts) {
    this._raf = requestAnimationFrame(this._loop)
    this._timer.update(ts)
    if (this._lost || this._paused || !this._inView) return
    const dt = clamp(this._timer.getDelta(), 0, 1 / 20)
    this._lastDt = dt
    const t0 = performance.now()
    this._advance(dt)
    this._updateMotion()
    this._updateCamera()
    this._pushUniforms()
    this._simulate(dt)
    const cpu = performance.now() - t0
    this._render()
    const st = this.stats
    if (dt > 0) {
      this._dtAvg += (dt - this._dtAvg) * 0.08
      st.fps = 1 / this._dtAvg
    }
    st.cpuMs += (cpu - st.cpuMs) * 0.1
    st.particles = Math.round(this._countShown)
    if (!this.ready) {
      this.ready = true
      this._emit('ready', this)
    }
    if (this._emitLater) {
      const evt = this._emitLater
      this._emitLater = null
      this._emit(evt, this.shape)
    }
    this._emit('frame', this._time, dt)
  }

  _render() {
    this.background.visible = !this.transparent
    this.renderer.render(this.scene, this.camera)
  }

  _renderNow() {
    this._updateMotion()
    this._updateCamera()
    this._pushUniforms()
    this._render()
  }

  _advance(dt) {
    const c = this.config
    const mo = c.motion
    const reduced = this._reduced
    this._time += dt

    // motion: amplitudes ease so mode switches never jump
    const swayTarget = !reduced && mo.mode === 'sway' ? mo.swayAngle * DEG : 0
    this._swayAmp = damp(this._swayAmp, swayTarget, 2.5, dt)
    this._swayPh += dt * mo.speed * 2
    if (!reduced && mo.mode === 'spin') {
      this._spin += dt * mo.speed * 0.6
    } else if (this._spin !== 0) {
      const home = Math.round(this._spin / TAU) * TAU
      this._spin = damp(this._spin, home, 2, dt)
      if (Math.abs(this._spin - home) < 1e-4) this._spin = 0
    }
    this._floatAmp = damp(this._floatAmp, reduced ? 0 : mo.float, 2, dt)
    this._floatPh += dt * 0.9
    if (this._viewScale !== this._viewScaleTarget) {
      this._viewScale = damp(this._viewScale, this._viewScaleTarget, 3, dt)
      if (Math.abs(this._viewScale - this._viewScaleTarget) < 1e-4) this._viewScale = this._viewScaleTarget
    }
    this._wanderT += dt * mo.noiseSpeed * 0.5
    if (this._fadeIn < 1) this._fadeIn = Math.min(1, this._fadeIn + dt / 0.7)

    // morph
    const m = this._morph
    const M = this._M
    if (m.active) {
      m.t += dt
      M.morphP = clamp(m.t / m.dur, 0, 1)
      this._lifeMix = clamp((M.morphP - 0.55) / 0.45, 0, 1)
      this._dustFade = Math.max(this._dustFade, m.intro ? clamp(M.morphP * 1.6, 0, 1) : 1)
      if (M.morphP >= 1) {
        m.active = false
        m.intro = false
        M.morphP = 1
        this._lifeMix = 1
        this._dissTau = 0.08
        this._emitLater = 'morphend'
      }
    } else {
      this._dustFade = Math.min(1, this._dustFade + dt)
    }

    // life
    const life = c.life
    const lifeOn = life.enabled && !reduced
    this._lifeAmt = damp(this._lifeAmt, lifeOn ? life.amount * this._lifeMix : 0, 4, dt)
    if (lifeOn) {
      M.lifeT += dt * life.rate
      if (M.lifeType === 3) M.helixPh += dt * 0.35 * life.rate * life.amount * this._lifeMix
    }
    M.lifeAmt = this._lifeAmt

    // dissolve
    const d = c.dissolve
    this._dissAmt = damp(this._dissAmt, d.amount, 1 / Math.max(this._dissTau, 0.01), dt)
    if (Math.abs(this._dissAmt - d.amount) < 1e-4) this._dissAmt = d.amount
    if (!reduced) M.dissT += dt * (0.012 + 0.09 * c.dust.drift)

    // dust
    if (!reduced) {
      this._dustT += dt * c.dust.drift * 0.25
      this._dustYaw += dt * c.dust.drift * 0.012
    }

    // count
    const ca = this._countAnim
    if (ca.active) {
      ca.t += dt / ca.dur
      const u = clamp(ca.t, 0, 1)
      this._countShown = ca.from + (ca.to - ca.from) * ease5(u)
      this._pu.uCountBand.value = ca.w * Math.sin(Math.PI * u) + 1e-3
      if (u >= 1) {
        ca.active = false
        this._countShown = ca.to
        this._pu.uCountBand.value = 1e-3
      }
      this._drawN = this._computeDrawN()
    }

    // camera distance easing (shape changes)
    if (this._camDLambda < 0) {
      if (this._morph.active) {
        const s0 = this._camStartP || 0
        const u = clamp((M.morphP - s0) / Math.max(1 - s0, 1e-3), 0, 1)
        this._camD = this._camFrom + (this._camDTarget - this._camFrom) * ease5(clamp((u - 0.08) / 0.84, 0, 1))
      } else {
        this._camD = this._camDTarget
        this._camDLambda = 0
      }
      this._updateDustRadii()
    } else if (this._camDLambda > 0) {
      this._camD = damp(this._camD, this._camDTarget, this._camDLambda, dt)
      if (Math.abs(this._camD - this._camDTarget) < 1e-4) {
        this._camD = this._camDTarget
        this._camDLambda = 0
      }
      this._updateDustRadii()
    }

    // orbit inertia, then ease back to the configured view
    const O = this._orbit
    if (!O.dragging) {
      O.sinceRelease += dt
      O.az += O.vaz * dt
      O.el = clamp(O.el + O.vel * dt, -80, 80)
      const f = Math.exp(-dt * 5)
      O.vaz *= f
      O.vel *= f
      if (O.sinceRelease > ORBIT_RETURN_DELAY) {
        O.az = damp(O.az, 0, 2.6, dt)
        O.el = damp(O.el, 0, 2.6, dt)
        if (Math.abs(O.az) < 1e-3) O.az = 0
        if (Math.abs(O.el) < 1e-3) O.el = 0
      }
    }

    // pointer presence + smoothed cursor (dust)
    const P = this._pointer
    const hoverOn = this.interactive && c.hover.enabled
    const want = hoverOn && P.inside ? (O.dragging ? 0.25 : 1) : 0
    P.presence = damp(P.presence, want, want > P.presence ? 9 : 5, dt)
    if (P.presence < 1e-3 && want === 0) P.presence = 0
    P.sx = damp(P.sx, P.x, 14, dt)
    P.sy = damp(P.sy, P.y, 14, dt)
    const vdec = Math.exp(-dt * 6)
    P.vx *= vdec
    P.vy *= vdec
    const tx = P.inside ? (P.x / this._w) * 2 - 1 : 0
    const ty = P.inside ? 1 - (P.y / this._h) * 2 : 0
    P.px = damp(P.px, reduced ? 0 : tx, 2.2, dt)
    P.py = damp(P.py, reduced ? 0 : ty, 2.2, dt)

    for (let i = 0; i < this._shocks.length; i++) {
      const s = this._shocks[i]
      if (!s.active) continue
      s.t += dt
      if (s.t > (s.burst ? 0.02 : SHOCK_LIFE)) s.active = false
    }
  }

  // model matrix (sway / spin / float), configured-view rotation, dissolve frame
  _updateMotion() {
    const c = this.config
    const mo = c.motion
    const yaw = mo.yaw * DEG + this._swayAmp * Math.sin(this._swayPh) + this._spin
    const pitch = mo.pitch * DEG + this._swayAmp * 0.12 * Math.sin(this._swayPh * 0.71 + 1.1)
    const roll = mo.roll * DEG
    this._euler.set(pitch, yaw, roll, 'YXZ')
    this._model.makeRotationFromEuler(this._euler)
    const R = this._radius || 1
    const fy = this._floatAmp * R * 0.045 * Math.sin(this._floatPh)
    const fx = this._floatAmp * R * 0.012 * Math.sin(this._floatPh * 0.53 + 0.7)
    this._model.setPosition(fx, fy, 0)
    this.points.matrix.copy(this._model)
    this.points.matrixWorldNeedsUpdate = true

    // dust layer turns slower than the shape: depth between the layers
    this._dustEuler.set(0, this._dustYaw + this._swayAmp * 0.3 * Math.sin(this._swayPh), 0, 'YXZ')
    this._dustMat.makeRotationFromEuler(this._dustEuler)
    this.dust.matrix.copy(this._dustMat)
    this.dust.matrixWorldNeedsUpdate = true

    // configured camera rotation (no drag): dissolve lives in this view space
    const cam = c.camera
    const az = cam.azimuth * DEG
    const el = clamp(cam.elevation, -89, 89) * DEG
    this._v3a.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    this._camRot.lookAt(this._v3a, this._origin, this._up)
    this._viewRotInv.setFromMatrix4(this._camRot)
    this._viewRot.copy(this._viewRotInv).transpose()
    this._modelRot.setFromMatrix4(this._model)
    this._frameRot.multiplyMatrices(this._viewRot, this._modelRot)

    // dissolve band range: projected bbox along the direction (smoothed across shape changes)
    const d = c.dissolve
    const ang = d.angle * DEG
    const dx = Math.cos(ang)
    const dy = Math.sin(ang)
    const b = this.shape?.bounds
    let lo = -1, hi = 1
    if (b) {
      lo = Infinity
      hi = -Infinity
      const F = this._frameRot.elements
      for (let k = 0; k < 8; k++) {
        const x = k & 1 ? b.max[0] : b.min[0]
        const y = k & 2 ? b.max[1] : b.min[1]
        const z = k & 4 ? b.max[2] : b.min[2]
        const qx = F[0] * x + F[3] * y + F[6] * z
        const qy = F[1] * x + F[4] * y + F[7] * z
        const pr = qx * dx + qy * dy
        if (pr < lo) lo = pr
        if (pr > hi) hi = pr
      }
    }
    const M = this._M
    const dr = this._dissRange
    if (this._dissTau > 0.1 && this._morph.active) {
      const lam = 1 / this._dissTau
      const dtt = this._lastDt || 1 / 60
      dr[0] = damp(dr[0], lo, lam, dtt)
      dr[1] = damp(dr[1], hi, lam, dtt)
      dr[2] = damp(dr[2], R, lam, dtt)
    } else {
      dr[0] = lo
      dr[1] = hi
      dr[2] = R
    }
    M.dissMode = DISSOLVE_MODES[d.mode] ?? 0
    M.dirX = dx
    M.dirY = dy
    M.dissAmt = this._dissAmt
    M.dissSoft = Math.max(0.02, d.softness)
    M.dissLen = d.spread * R
    M.dissTurb = d.turbulence
    M.dissMin = dr[0]
    M.dissMax = dr[1]
    M.dissRad = dr[2]
    M.stagger = this._morph.stagger
    M.morphTurb = this._morph.active ? c.morph.turbulence : 0
    this._kin.prepare()
  }

  _updateCamera() {
    const c = this.config.camera
    const O = this._orbit
    const cam = this.camera
    const D = this._camD * O.zoom
    const az = (c.azimuth + O.az) * DEG
    const el = clamp(c.elevation + O.el, -89, 89) * DEG
    cam.position.set(D * Math.sin(az) * Math.cos(el), D * Math.sin(el), D * Math.cos(az) * Math.cos(el))
    cam.up.set(0, 1, 0)
    cam.lookAt(this._origin)
    const R = this._radius || 1
    cam.fov = c.fov
    cam.aspect = this._w / this._h
    cam.near = Math.max(0.01, D * 0.05)
    cam.far = D * 4 + R * 8 + 20
    if (c.offsetX || c.offsetY) cam.setViewOffset(this._w, this._h, -c.offsetX * this._w, c.offsetY * this._h, this._w, this._h)
    else if (cam.view && cam.view.enabled) cam.clearViewOffset()
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
    this._vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
  }

  _pushUniforms() {
    const c = this.config
    const p = c.particles
    const pu = this._pu
    const du = this._du
    const sh = this._shared
    const M = this._M
    const R = this._radius || 1
    const pr = this._renderPR
    const D = this._camD * this._orbit.zoom

    sh.uSize.value = p.size * this._viewScale
    sh.uFrameDist.value = this._camD
    sh.uSoftness.value = p.softness
    sh.uMinPx.value = 1
    sh.uMaxPx.value = this._glMaxPoint
    sh.uDof.value = c.depth.dof
    sh.uFocusDepth.value = D - c.depth.focus
    sh.uCocScale.value = (11 * pr) / R
    sh.uCocMax.value = 26 * pr

    pu.uMorphP.value = M.morphP
    pu.uStagger.value = M.stagger
    pu.uMorphTurb.value = M.morphTurb
    pu.uMorphStyle.value = M.morphStyle
    pu.uLifeType.value = M.lifeType
    pu.uLifeAmt.value = M.lifeAmt
    pu.uLifeT.value = M.lifeT
    pu.uHelixPh.value = M.helixPh
    pu.uCenter.value.fromArray(M.center)
    pu.uAxis.value.fromArray(M.axis)
    pu.uWander.value = this._reduced ? 0 : c.motion.noise * 0.055 * R
    pu.uWanderScale.value = c.motion.noiseScale
    pu.uWanderT.value = this._wanderT
    pu.uDissMode.value = M.dissMode
    pu.uDissDir.value.set(M.dirX, M.dirY)
    pu.uDissAmt.value = M.dissAmt
    pu.uDissSoft.value = M.dissSoft
    pu.uDissLen.value = M.dissLen
    pu.uDissTurb.value = M.dissTurb
    pu.uDissFade.value = c.dissolve.fade
    pu.uDissT.value = M.dissT
    pu.uDissMin.value = M.dissMin
    pu.uDissMax.value = M.dissMax
    pu.uDissRad.value = M.dissRad
    pu.uCount.value = this._countShown
    pu.uSizeVar.value = p.sizeVariance
    pu.uCountComp.value = Math.pow(N / Math.max(this._countShown, 1), 0.35 * p.sizeByCount)
    const fade = this._fadeIn * this._fadeIn * (3 - 2 * this._fadeIn)
    pu.uOpacity0.value = p.opacity * fade
    pu.uOpacity1.value = p.opacity * p.opacityB * fade
    pu.uOpacity2.value = p.opacity * p.opacityC * fade
    pu.uShading.value = p.shading
    pu.uFadeNear.value = D - R
    pu.uFadeFar.value = D + R
    pu.uDepthFade.value = c.depth.fade

    const dc = c.dust
    du.uDustT.value = this._dustT
    du.uDustAmp.value = 0.05 + 0.05 * dc.drift
    du.uDustSize.value = dc.size
    du.uDustOpacity.value = dc.opacity
    du.uDustFade.value = this._dustFade
    const P = this._pointer
    const hv = c.hover
    du.uCursor.value.set(P.sx, P.sy)
    du.uCursorR.value = hv.radius * this._viewScale * 1.15
    du.uCursorPush.value = P.presence * hv.strength * 0.16 * (hv.mode === 'attract' ? -0.6 : 1)
    du.uParallax.value.set(P.px, P.py)

    const bu = this._bu
    bu.uGlow.value = c.scene.glow

    this._geo.setDrawRange(0, this._drawN)
  }

  /* --------------------------------------------------------- hover sim -- */

  _simulate(dt) {
    const n = this._drawN
    const P = this._pointer
    const hv = this.config.hover
    let shocks = 0
    for (let i = 0; i < this._shocks.length; i++) if (this._shocks[i].active) shocks++
    const forcing = (P.presence > 0 || shocks > 0) && n > 0
    if (!forcing && this._asleep) return
    const O = this._A.offset
    const V = this._vel
    const s = Math.min(dt * 60, 3)
    if (s <= 0) return
    const k = clamp(hv.stiffness, 0.002, 0.6) * s
    const dmp = Math.pow(clamp(hv.damping, 0, 0.995), s)
    let maxE = 0

    if (!forcing) {
      for (let j = 0, l = n * 3; j < l; j++) {
        const v = (V[j] - O[j] * k) * dmp
        V[j] = v
        O[j] += v * s
        const e = Math.abs(v) + Math.abs(O[j])
        if (e > maxE) maxE = e
      }
    } else {
      const kin = this._kin
      const vp = this._vp.elements
      const cm = this.camera.matrixWorld.elements
      const rX = cm[0], rY = cm[1], rZ = cm[2]
      const uX = cm[4], uY = cm[5], uZ = cm[6]
      const bX = cm[8], bY = cm[9], bZ = cm[10]
      const W = this._w
      const H = this._h
      const pxw = (2 * Math.tan((this.camera.fov * DEG) / 2)) / H
      const R = Math.max(hv.radius * this._viewScale, 1)
      const R2 = R * R
      const pres = P.presence
      const str = hv.strength
      const mode = HOVER_MODES[hv.mode] ?? 0
      const cx = P.x
      const cy = P.y
      const sweepX = clamp(P.vx * 0.04, -R * 0.6, R * 0.6)
      const sweepY = clamp(P.vy * 0.04, -R * 0.6, R * 0.6)
      const ripT = this._time * 7
      const rippleK = 1 / (R * 0.17)
      const r0 = R * 0.42
      const shockList = this._shocks
      const maxR = Math.max(Math.min(W, H) * 0.8, R * 3)
      // Culling: a particle at rest whose last known screen position is well
      // outside the cursor radius is skipped; cached positions refresh
      // round-robin (1/8 per frame), and everything runs during shocks/morphs.
      const SC = this._scr
      const cull = shocks === 0 && !this._morph.active
      const phase = this._simFrame++ & 7
      const Rc = R + 90
      const Rc2 = Rc * Rc
      const restEps = 1e-6 * (this._radius || 1)
      for (let i = 0; i < n; i++) {
        const i3 = i * 3
        let ox = O[i3], oy = O[i3 + 1], oz = O[i3 + 2]
        if (cull && (i & 7) !== phase) {
          const a = Math.abs(ox) + Math.abs(oy) + Math.abs(oz) + Math.abs(V[i3]) + Math.abs(V[i3 + 1]) + Math.abs(V[i3 + 2])
          if (a < restEps) {
            const ddx = SC[i * 2] - cx
            const ddy = SC[i * 2 + 1] - cy
            if (ddx * ddx + ddy * ddy > Rc2) continue
          }
        }
        const w = kin.worldAt(i)
        const wx = w[0] + ox, wy = w[1] + oy, wz = w[2] + oz
        const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15]
        let tx = 0, ty = 0, tz = 0
        let ix = 0, iy = 0, iz = 0
        if (cw > 1e-4) {
          const sx = ((vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12]) / cw) * 0.5 * W + 0.5 * W
          const sy = 0.5 * H - ((vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13]) / cw) * 0.5 * H
          SC[i * 2] = sx
          SC[i * 2 + 1] = sy
          const wpp = cw * pxw
          if (pres > 0) {
            const dx = sx - cx
            const dy = sy - cy
            const d2 = dx * dx + dy * dy
            if (d2 < R2) {
              const d = Math.sqrt(d2) + 1e-4
              const ux = dx / d
              const uy = dy / d
              const x = d / R
              const f = (1 - x * x) * (1 - x * x) * pres
              let mx = 0, my = 0, mz = 0
              if (mode === 0) {
                const m = str * R * 0.5 * f
                mx = ux * m
                my = uy * m
                mz = m * 0.45
              } else if (mode === 1) {
                let wgt
                if (d < r0) wgt = pres
                else {
                  const y = (d - r0) / (R - r0)
                  wgt = (1 - y * y) * (1 - y * y) * pres
                }
                const m = (r0 - d) * str * 0.9 * wgt
                mx = ux * m
                my = uy * m
                mz = -Math.abs(m) * 0.3
              } else if (mode === 2) {
                const m = str * R * 0.42 * f
                mx = -uy * m - ux * m * 0.12
                my = ux * m - uy * m * 0.12
                mz = m * 0.15
              } else {
                const m = str * R * 0.13 * Math.sin(d * rippleK - ripT) * f
                mx = ux * m
                my = uy * m
                mz = m * 0.9
              }
              mx += sweepX * f
              my += sweepY * f
              tx = (rX * mx - uX * my - bX * mz) * wpp
              ty = (rY * mx - uY * my - bY * mz) * wpp
              tz = (rZ * mx - uZ * my - bZ * mz) * wpp
            }
          }
          if (shocks > 0) {
            for (let q = 0; q < shockList.length; q++) {
              const S = shockList[q]
              if (!S.active) continue
              const dx = sx - S.x
              const dy = sy - S.y
              const d = Math.sqrt(dx * dx + dy * dy) + 1e-4
              let imp = 0
              if (S.burst) {
                const RB = R * 1.9
                if (d < RB) {
                  const x = d / RB
                  imp = str * R * 0.075 * (1 - x * x) * (1 - x * x)
                }
              } else {
                // ring decelerates as it spreads (ease-out) and loses energy
                const u = S.t / SHOCK_LIFE
                const rr = (1 - (1 - u) * (1 - u)) * maxR
                const fall = (1 - u) * (1 - u)
                imp = str * 5.5 * bump(d - rr, 30 + 46 * u) * fall * s
              }
              if (imp > 0) {
                const ux = dx / d
                const uy = dy / d
                const mz = imp * 0.5
                ix += (rX * ux * imp - uX * uy * imp - bX * mz) * wpp
                iy += (rY * ux * imp - uY * uy * imp - bY * mz) * wpp
                iz += (rZ * ux * imp - uZ * uy * imp - bZ * mz) * wpp
              }
            }
          }
        }
        let vx = (V[i3] + ix + (tx - ox) * k) * dmp
        let vy = (V[i3 + 1] + iy + (ty - oy) * k) * dmp
        let vz = (V[i3 + 2] + iz + (tz - oz) * k) * dmp
        ox += vx * s
        oy += vy * s
        oz += vz * s
        if (Math.abs(vx) + Math.abs(vy) + Math.abs(vz) + Math.abs(ox) + Math.abs(oy) + Math.abs(oz) < restEps) vx = vy = vz = ox = oy = oz = 0
        V[i3] = vx
        V[i3 + 1] = vy
        V[i3 + 2] = vz
        O[i3] = ox
        O[i3 + 1] = oy
        O[i3 + 2] = oz
        const e = Math.abs(vx) + Math.abs(vy) + Math.abs(vz) + Math.abs(ox) + Math.abs(oy) + Math.abs(oz)
        if (e > maxE) maxE = e
      }
    }

    const attr = this._attr.offset
    if (!forcing && maxE < 2e-5 * (this._radius || 1)) {
      // settled: snap to rest and stop simulating until something pokes the field
      O.fill(0)
      V.fill(0)
      attr.clearUpdateRanges()
      attr.needsUpdate = true
      this._asleep = true
      return
    }
    this._asleep = false
    attr.clearUpdateRanges()
    attr.addUpdateRange(0, n * 3)
    attr.needsUpdate = true
  }
}
