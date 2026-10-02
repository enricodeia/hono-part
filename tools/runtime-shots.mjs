#!/usr/bin/env node
// Runtime verification battery (lab.html). Runs named cases, saves
// shots/runtime-<case>.png and prints numbers.
//
//   node tools/runtime-shots.mjs [case ...] [--w=1600 --h=900 --dpr=1]
//   cases: looks counts hover modes dissolve dof dust morph intro snapshot perf life transparent
//          (no args = all)

import { chromium } from 'playwright'
import fs from 'node:fs'

const args = process.argv.slice(2)
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')))
const wanted = args.filter((a) => !a.startsWith('--'))
const BASE = process.env.BASE || 'http://localhost:5250'
const W = +(flags.w || 1600)
const H = +(flags.h || 900)
const DPR = +(flags.dpr || 1)
fs.mkdirSync('shots', { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', args: ['--ignore-gpu-blocklist'] }).catch(() => chromium.launch())
const errors = []

async function open(query = '', { w = W, h = H, dpr = DPR } = {}) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr })
  page.on('pageerror', (e) => errors.push(`[pageerror ${query}] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(`[console.error ${query}] ${m.text().slice(0, 300)}`)
    if (m.type() === 'warning') errors.push(`[warn ${query}] ${m.text().slice(0, 300)}`)
  })
  await page.goto(`${BASE}/lab.html?${query}`, { waitUntil: 'load' })
  await page.waitForFunction(() => document.body.dataset.ready === 'true' || document.body.dataset.ready === 'error', null, { timeout: 60000 })
  if ((await page.evaluate(() => document.body.dataset.ready)) === 'error') {
    errors.push(`[lab error ${query}] ` + (await page.evaluate(() => document.getElementById('err').textContent.slice(0, 400))))
  }
  return page
}

const enc = (o) => encodeURIComponent(JSON.stringify(o))
const still = { morph: { intro: false }, motion: { mode: 'still', float: 0, noise: 0 }, life: { enabled: false } }
const shot = (page, name) => page.screenshot({ path: `shots/runtime-${name}.png` }).then(() => console.log('  saved', `shots/runtime-${name}.png`))
const stats = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__lab.field.stats)))

const cases = {
  async looks() {
    const page = await open('cfg=' + enc({ morph: { intro: false } }))
    const ids = await page.evaluate(() => window.__lab.shapes)
    await page.close()
    for (const id of ids) {
      const p = await open(`shape=${id}&cfg=` + enc({ morph: { intro: false } }))
      await p.waitForTimeout(1600)
      const meta = await p.evaluate(() => ({ frame: window.__lab.field.shape.meta.frame, life: window.__lab.field.shape.meta.life, cam: window.__lab.field.getCameraState() }))
      console.log(' ', id, JSON.stringify(meta), JSON.stringify(await stats(p)))
      await shot(p, `look-${id}`)
      await p.close()
    }
  },
  async counts() {
    const shape = flags.shape || 'triangle'
    for (const n of [8000, 1000]) {
      const p = await open(`shape=${shape}&count=${n}&cfg=` + enc(still))
      await p.waitForTimeout(800)
      await shot(p, `count-${n}`)
      await p.close()
    }
    // animated change, mid-flight
    const p = await open(`shape=${shape}&cfg=` + enc(still))
    await p.waitForTimeout(500)
    await p.evaluate(() => window.__lab.field.setCount(1000))
    await p.waitForTimeout(380)
    await shot(p, 'count-mid')
    await p.waitForTimeout(1500)
    console.log('  after count change', JSON.stringify(await stats(p)))
    await p.close()
  },
  async hover() {
    const shape = flags.shape || 'triangle'
    for (const mode of ['repel', 'attract', 'swirl', 'ripple']) {
      const p = await open(`shape=${shape}&cfg=` + enc({ ...still, hover: { mode, radius: 130, strength: 0.8 } }))
      await p.waitForTimeout(400)
      // move onto the shape's centre region in a few steps
      const tx = W * 0.5, ty = H * 0.55
      await p.mouse.move(tx - 160, ty - 40)
      for (let i = 1; i <= 8; i++) {
        await p.mouse.move(tx - 160 + (160 * i) / 8, ty - 40 + (40 * i) / 8)
        await p.waitForTimeout(16)
      }
      await p.waitForTimeout(900)
      console.log(' ', mode, JSON.stringify(await stats(p)))
      await shot(p, `hover-${mode}`)
      await p.close()
    }
  },
  async click() {
    const shape = flags.shape || 'triangle'
    for (const click of ['burst', 'shockwave']) {
      const p = await open(`shape=${shape}&cfg=` + enc({ ...still, hover: { click, strength: 0.8 } }))
      await p.waitForTimeout(400)
      await p.mouse.click(W * 0.5, H * 0.55)
      await p.waitForTimeout(click === 'burst' ? 140 : 260)
      await shot(p, `click-${click}`)
      await p.close()
    }
  },
  async dissolve() {
    const shape = flags.shape || 'triangle'
    for (const mode of ['linear', 'mirror', 'radial']) {
      const p = await open(`shape=${shape}&cfg=` + enc({ ...still, dissolve: { amount: 0.4, mode, angle: mode === 'linear' ? -18 : 0 } }))
      await p.waitForTimeout(900)
      await shot(p, `dissolve-${mode}`)
      await p.close()
    }
  },
  async dof() {
    const shape = flags.shape || 'heart'
    const p = await open(`shape=${shape}&cfg=` + enc({ ...still, motion: { mode: 'still', yaw: 35 }, depth: { dof: 0.8, focus: 0.4 } }))
    await p.waitForTimeout(800)
    await shot(p, 'dof')
    await p.close()
  },
  async dust() {
    const p = await open(`shape=${flags.shape || 'triangle'}&cfg=` + enc({ ...still, dust: { count: 3000, opacity: 0.25 } }))
    await p.waitForTimeout(800)
    await shot(p, 'dust')
    await p.close()
  },
  async morph() {
    const ids = flags.pair ? flags.pair.split(',') : ['triangle', 'heart']
    for (const style of ['flow', 'explode', 'sweep']) {
      const p = await open(`shape=${ids[0]}&cfg=` + enc({ morph: { intro: false, style, duration: 2 } }))
      await p.waitForTimeout(500)
      await p.evaluate(([id, style]) => window.__lab.setShape(id, true, { cfg: { morph: { style, duration: 2 } } }), [ids[1], style])
      await p.waitForTimeout(900)
      await shot(p, `morph-${style}`)
      const t0 = Date.now()
      await p.evaluate(() => window.__lab.waitMorph())
      console.log(`  ${style} morph ended after ~${Date.now() - t0 + 900} ms`, JSON.stringify(await stats(p)))
      await p.close()
    }
  },
  async intro() {
    const p = await open(`shape=${flags.shape || 'heart'}`)
    await p.waitForTimeout(250)
    await shot(p, 'intro-a')
    await p.waitForTimeout(1300)
    await shot(p, 'intro-b')
    await p.close()
  },
  async snapshot() {
    const p = await open(`shape=${flags.shape || 'triangle'}&cfg=` + enc({ morph: { intro: false } }))
    await p.waitForTimeout(600)
    for (const [scale, transparent] of [[2, false], [1, true]]) {
      const r = await p.evaluate(async ([scale, transparent]) => {
        const t0 = performance.now()
        const blob = await window.__lab.field.snapshot({ scale, transparent })
        const ms = performance.now() - t0
        const bmp = await createImageBitmap(blob)
        const c = document.createElement('canvas')
        c.width = bmp.width
        c.height = bmp.height
        const ctx = c.getContext('2d')
        ctx.drawImage(bmp, 0, 0)
        const d = ctx.getImageData(0, 0, c.width, c.height).data
        let dark = 0, transp = 0
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 8) transp++
          else if (d[i] < 128) dark++
        }
        const buf = new Uint8Array(await blob.arrayBuffer())
        let bin = ''
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
        return { w: bmp.width, h: bmp.height, bytes: blob.size, ms: Math.round(ms), dark, transp, b64: btoa(bin) }
      }, [scale, transparent])
      const file = `shots/runtime-snapshot-x${scale}${transparent ? '-transparent' : ''}.png`
      fs.writeFileSync(file, Buffer.from(r.b64, 'base64'))
      delete r.b64
      console.log('  snapshot', scale, transparent, JSON.stringify(r), '→', file)
    }
    await shot(p, 'snapshot-after')
    await p.close()
  },
  async perf() {
    for (const shape of (flags.shapes || 'triangle,heart,head').split(',')) {
      const p = await open(`shape=${shape}&cfg=` + enc({ morph: { intro: false } }))
      await p.waitForTimeout(400)
      // keep the cursor moving over the shape so the full sim runs every frame
      for (let i = 0; i < 90; i++) {
        await p.mouse.move(W * 0.5 + Math.sin(i / 9) * 160, H * 0.5 + Math.cos(i / 7) * 90)
        await p.waitForTimeout(16)
      }
      const s = await stats(p)
      const sim = await p.evaluate(() => {
        const f = window.__lab.field
        const t0 = performance.now()
        for (let i = 0; i < 50; i++) f._simulate(1 / 60)
        return (performance.now() - t0) / 50
      })
      console.log(`  ${shape} hovering:`, JSON.stringify(s), `sim(direct) ${sim.toFixed(3)} ms`)
      await p.close()
    }
  },
  async life() {
    for (const shape of (flags.shapes || 'triangle,heart,head').split(',')) {
      const p = await open(`shape=${shape}&cfg=` + enc({ morph: { intro: false }, life: { amount: 1 } }))
      await p.waitForTimeout(1500)
      await shot(p, `life-${shape}-a`)
      await p.waitForTimeout(430)
      await shot(p, `life-${shape}-b`)
      await p.close()
    }
  },
  async glow() {
    const p = await open(`shape=${flags.shape || 'heart'}&cfg=` + enc({ ...still, scene: { glow: 0.8 }, camera: { offsetX: -0.12, offsetY: 0.05 } }))
    await p.waitForTimeout(600)
    await shot(p, 'glow-offset')
    const px = await p.evaluate(() => {
      const c = document.createElement('canvas')
      return null
    })
    await p.close()
  },
  async orbit() {
    const p = await open(`shape=${flags.shape || 'heart'}&cfg=` + enc({ ...still }))
    await p.waitForTimeout(400)
    await p.mouse.move(700, 450)
    await p.mouse.down()
    await p.mouse.move(980, 400, { steps: 12 })
    await p.mouse.up()
    const a = await p.evaluate(() => window.__lab.field.getCameraState())
    await shot(p, 'orbit-drag')
    await p.waitForTimeout(700)
    const b = await p.evaluate(() => window.__lab.field.getCameraState())
    await p.waitForTimeout(2600)
    const c = await p.evaluate(() => window.__lab.field.getCameraState())
    console.log('  after drag', JSON.stringify(a), '\n  +0.7s (inertia)', JSON.stringify(b), '\n  +3.3s (returned)', JSON.stringify(c))
    // wheel: ignored unless camera.zoom
    const d0 = (await p.evaluate(() => window.__lab.field.getCameraState())).distance
    await p.mouse.move(800, 450)
    await p.mouse.wheel(0, 400)
    await p.waitForTimeout(100)
    const d1 = (await p.evaluate(() => window.__lab.field.getCameraState())).distance
    await p.evaluate(() => window.__lab.field.setConfig({ camera: { zoom: true } }))
    await p.mouse.wheel(0, 400)
    await p.waitForTimeout(100)
    const d2 = (await p.evaluate(() => window.__lab.field.getCameraState())).distance
    console.log(`  wheel: zoom off ${d0.toFixed(3)} → ${d1.toFixed(3)} · zoom on → ${d2.toFixed(3)}`)
    await p.close()
  },
  async robustness() {
    const p = await open(`shape=${flags.shape || 'heart'}&cfg=` + enc({ morph: { intro: false } }))
    await p.waitForTimeout(400)
    // context loss and restore
    const lost = await p.evaluate(async () => {
      const f = window.__lab.field
      const ext = f.renderer.getContext().getExtension('WEBGL_lose_context')
      ext.loseContext()
      await new Promise((r) => setTimeout(r, 300))
      const during = f._lost
      ext.restoreContext()
      await new Promise((r) => setTimeout(r, 600))
      return { during, after: f._lost }
    })
    await p.waitForTimeout(500)
    await shot(p, 'after-context-restore')
    console.log('  context lost flag', JSON.stringify(lost))
    // off-screen pause: shrink the container out of view, frames must stop
    const pause = await p.evaluate(async () => {
      const f = window.__lab.field
      let n = 0
      const off = f.on('frame', () => n++)
      const st = document.getElementById('stage')
      st.style.transform = 'translateY(200vh)'
      await new Promise((r) => setTimeout(r, 300))
      const n0 = n
      await new Promise((r) => setTimeout(r, 500))
      const n1 = n
      st.style.transform = ''
      await new Promise((r) => setTimeout(r, 400))
      off()
      return { offscreenFrames: n1 - n0, resumed: n - n1 }
    })
    console.log('  off-screen pause', JSON.stringify(pause))
    // setConfig at 60 Hz is cheap
    const cost = await p.evaluate(() => {
      const f = window.__lab.field
      const t0 = performance.now()
      for (let i = 0; i < 600; i++) f.setConfig({ particles: { size: 1.5 + (i % 10) / 10 }, dissolve: { amount: (i % 50) / 100, angle: i % 360 } })
      return (performance.now() - t0) / 600
    })
    console.log(`  setConfig cost ${cost.toFixed(4)} ms/call`)
    // dispose
    const disp = await p.evaluate(() => {
      window.__lab.field.dispose()
      return document.querySelectorAll('canvas').length
    })
    console.log('  canvases after dispose', disp)
    await p.close()
  },
  async reduced() {
    const page = await browser.newPage({ viewport: { width: W, height: H } })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    page.on('pageerror', (e) => errors.push(`[pageerror reduced] ${e.message}`))
    await page.goto(`${BASE}/lab.html?shape=${flags.shape || 'heart'}`)
    await page.waitForFunction(() => document.body.dataset.ready === 'true')
    await page.waitForTimeout(800)
    const a = await page.screenshot()
    await page.waitForTimeout(700)
    const b = await page.screenshot()
    let diff = 0
    for (let i = 0; i < a.length && i < b.length; i++) if (a[i] !== b[i]) diff++
    const st = await page.evaluate(() => ({ reduced: window.__lab.field._reduced, intro: window.__lab.field._morph.intro, life: window.__lab.field._M.lifeAmt }))
    console.log('  reduced motion', JSON.stringify(st), 'png bytes differing between frames 0.7 s apart:', diff)
    // hover still works
    await page.mouse.move(W / 2 - 100, H / 2)
    await page.mouse.move(W / 2, H / 2, { steps: 6 })
    await page.waitForTimeout(700)
    await page.screenshot({ path: 'shots/runtime-reduced-hover.png' })
    await page.close()
  },
  async fidelity() {
    // everything frozen: the live frame and the snapshots are the same instant
    const frozen = { morph: { intro: false }, motion: { mode: 'still', float: 0, noise: 0 }, life: { enabled: false }, dust: { drift: 0 } }
    const p = await open(`shape=${flags.shape || 'triangle'}&cfg=` + enc(frozen))
    await p.waitForTimeout(700)
    await shot(p, 'fidelity-live')
    for (const scale of [1, 2, 4]) {
      const b64 = await p.evaluate(async (scale) => {
        const blob = await window.__lab.field.snapshot({ scale })
        const buf = new Uint8Array(await blob.arrayBuffer())
        let bin = ''
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
        return btoa(bin)
      }, scale)
      fs.writeFileSync(`shots/runtime-fidelity-x${scale}.png`, Buffer.from(b64, 'base64'))
    }
    await p.close()
  },
  async parity() {
    // hover hole must stay centred on the cursor while the shape sways, beats and dissolves
    const shape = flags.shape || 'heart'
    const p = await open(`shape=${shape}&cfg=` + enc({ morph: { intro: false }, motion: { mode: 'sway', swayAngle: 40, speed: 1.5, noise: 0 }, life: { amount: 1 }, dissolve: { amount: 0.3 }, hover: { radius: 90, strength: 1 } }))
    await p.waitForTimeout(500)
    const tx = W * 0.5 + 40, ty = H * 0.5
    await p.mouse.move(tx - 120, ty)
    await p.mouse.move(tx, ty, { steps: 8 })
    await p.waitForTimeout(1200)
    await shot(p, `parity-${shape}`)
    await p.waitForTimeout(900)
    await shot(p, `parity-${shape}-b`)
    console.log('  cursor at', tx, ty)
    await p.close()
  },
  async film() {
    // filmstrip of one morph: shots/runtime-film-<style>-<k>.png
    const ids = flags.pair ? flags.pair.split(',') : ['heart', 'dna']
    const style = flags.style || 'flow'
    const p = await open(`shape=${ids[0]}&cfg=` + enc({ morph: { intro: false } }))
    await p.waitForTimeout(500)
    await p.evaluate(([id, style]) => {
      window.__lab.setShape(id, true, { cfg: { morph: { style, duration: 2 } } })
      window.__lab.field._morph.t = 0
    }, [ids[1], style])
    for (let k = 0; k < 6; k++) {
      await p.evaluate((t) => new Promise((res) => {
        const f = window.__lab.field
        const off = f.on('frame', () => {
          if (f._morph.t >= t || !f.morphing) {
            off()
            res()
          }
        })
      }), k * 0.38)
      await shot(p, `film-${style}-${k}`)
    }
    await p.close()
  },
  async transparent() {
    const p = await open(`shape=${flags.shape || 'heart'}&transparent=1&cfg=` + enc({ morph: { intro: false } }))
    await p.evaluate(() => (document.body.style.background = 'repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0 / 24px 24px'))
    await p.waitForTimeout(600)
    await shot(p, 'transparent')
    await p.close()
  },
}

const run = wanted.length ? wanted : Object.keys(cases)
for (const name of run) {
  if (!cases[name]) {
    console.log('unknown case', name)
    continue
  }
  console.log(`[${name}]`)
  try {
    await cases[name]()
  } catch (e) {
    errors.push(`[case ${name}] ${e.message}`)
  }
}
await browser.close()
if (errors.length) {
  console.log(`errors (${errors.length}):`)
  for (const e of errors.slice(0, 30)) console.log('  ' + e)
} else console.log('no errors')
