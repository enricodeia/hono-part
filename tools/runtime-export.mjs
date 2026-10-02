#!/usr/bin/env node
// Export smoke test for the runtime bundle.
//   1. fetch /__pulviscolo/runtime.{iife,cdn,esm}.js from the dev server
//   2. build a minimal single-file HTML: runtime in a <script>, then
//      Pulviscolo.mount(el, { config, shapes: [encodeShape(…)], sequence, options })
//   3. open it via file:// with EVERY network request blocked; expect zero errors,
//      a rendered frame, a working sequence (auto + click) and a clean destroy().
//
//   node tools/runtime-export.mjs [--shapes=triangle,heart]

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.BASE || 'http://localhost:5250'
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')))
const ids = (flags.shapes || 'triangle,heart').split(',')

const bundles = {}
for (const kind of ['iife', 'cdn', 'esm']) {
  const res = await fetch(`${BASE}/__pulviscolo/runtime.${kind}.js`)
  const text = await res.text()
  if (!res.ok) throw new Error(`bundle ${kind} failed: ${text.slice(0, 400)}`)
  bundles[kind] = text
  console.log(`bundle ${kind}: ${(text.length / 1024).toFixed(1)} KB`, kind === 'esm' ? `(payload placeholder ${text.includes("'__PULVISCOLO_PAYLOAD__'") || text.includes('"__PULVISCOLO_PAYLOAD__"') ? 'present' : 'MISSING'})` : '')
}
if (/from\s*["']\.\.?\//.test(bundles.cdn) || /\bimport\(["']\.\//.test(bundles.cdn)) console.log('WARN: cdn bundle has relative imports')
if (!/from\s*["']three["']/.test(bundles.cdn)) console.log('WARN: cdn bundle does not import bare "three"')

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())

// encoded shapes + looks, produced by the real shape registry inside the lab page
const lab = await browser.newPage()
await lab.goto(`${BASE}/lab.html?shape=${ids[0]}`)
await lab.waitForFunction(() => document.body.dataset.ready === 'true' || document.body.dataset.ready === 'error')
const data = await lab.evaluate((ids) => {
  const L = window.__lab
  const shapes = ids.map((id) => L.encodeShape(L.buildShape(id, {}, 1)))
  const configs = ids.map((id) => L.lookFor(id, {}))
  return { shapes, configs }
}, ids)
await lab.close()

const payload = {
  config: data.configs[0],
  configs: data.configs,
  shapes: data.shapes,
  sequence: { enabled: true, interval: 1.2, trigger: 'both' },
  options: { interactive: true, transparent: false },
}
const safe = (s) => s.replace(/<\/script/gi, '<\\/script')
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pulviscolo export smoke test</title>
<style>html,body{margin:0;height:100%;background:#fff;overflow:hidden}#pv{position:fixed;inset:0}</style>
</head>
<body>
<div id="pv"></div>
<script>${safe(bundles.iife)}</script>
<script>
const payload = ${safe(JSON.stringify(payload))};
const app = Pulviscolo.mount(document.getElementById('pv'), payload);
window.__app = app;
app.field.on('ready', () => { document.body.dataset.ready = 'true' });
</script>
</body>
</html>
`
fs.mkdirSync('shots', { recursive: true })
const file = path.resolve('shots/runtime-export.html')
fs.writeFileSync(file, html)
console.log(`export html: ${(html.length / 1024).toFixed(1)} KB → ${file}`)

const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
const page = await ctx.newPage()
const blocked = []
const errors = []
await page.route('**/*', (route) => {
  const u = route.request().url()
  if (u.startsWith('file:')) return route.continue()
  blocked.push(u)
  return route.abort()
})
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`)
})
await page.goto('file://' + file)
await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 30000 })
await page.waitForTimeout(600)
await page.screenshot({ path: 'shots/runtime-export.png' })
const s0 = await page.evaluate(() => ({ index: window.__app.index, stats: window.__app.field.stats, shapes: window.__app.shapes.length }))
// auto sequence: interval 1.2 s after the first morph settles
await page.waitForTimeout(3600)
const s1 = await page.evaluate(() => ({ index: window.__app.index, morphing: window.__app.field.morphing }))
await page.screenshot({ path: 'shots/runtime-export-seq.png' })
// click advances (a drag does not)
await page.mouse.move(800, 450)
await page.mouse.down()
await page.mouse.move(900, 470, { steps: 6 })
await page.mouse.up()
const sDrag = await page.evaluate(() => window.__app.index)
await page.mouse.click(800, 450)
const sClick = await page.evaluate(() => window.__app.index)
// destroy frees the canvas
const destroyed = await page.evaluate(() => {
  window.__app.destroy()
  return document.querySelectorAll('canvas').length
})
console.log('initial', JSON.stringify(s0))
console.log('after auto interval', JSON.stringify(s1))
console.log('after drag index', sDrag, '· after click index', sClick, '· canvases after destroy', destroyed)
console.log('network requests blocked:', blocked.length, blocked.slice(0, 5))
console.log(errors.length ? `errors (${errors.length}):\n  ` + errors.join('\n  ') : 'no errors')
await browser.close()
