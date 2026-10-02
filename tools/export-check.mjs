#!/usr/bin/env node
// End-to-end check of every export, the way Enrico will use them.
//
//   node tools/export-check.mjs [--shape=heart] [--seq] [--allow-warnings] [--keep-server]
//
// 1. loads /export-lab.html on the dev server (BASE, default :5250) and collects
//    the generated files into shots/export/
// 2. inline HTML via file:// with EVERY non-file request aborted (offline proof)
// 3. CDN HTML + transparent CDN HTML via file:// with network
// 4. JS module through a host page with an import map, and the paste-in snippet
//    inside a host page with its own content, both served by python3 on :5299
// Each page must render (dark pixels in the centre of the canvas) with zero
// console errors / warnings / page errors. Exit 1 on any failure.

import { chromium } from 'playwright'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'shots/export')
const BASE = process.env.BASE || 'http://localhost:5250'
const PORT = 5299
const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, ...v] = a.slice(2).split('=')
    return [k, v.length ? v.join('=') : 'true']
  }),
)
const ALLOW_WARN = flags['allow-warnings'] === 'true'
fs.mkdirSync(OUT, { recursive: true })

const results = []
const kb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(1)} KB`)
const pass = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  · ' + detail : ''}`)
}

let browser
try {
  browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
} catch {
  browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] })
}

function watch(page) {
  const log = { errors: [], warnings: [], requests: [], blocked: [] }
  page.on('pageerror', (e) => log.errors.push('[pageerror] ' + (e.message || e).toString().split('\n')[0]))
  page.on('console', (m) => {
    if (m.type() === 'error') log.errors.push('[console.error] ' + m.text().slice(0, 300))
    else if (m.type() === 'warning') log.warnings.push('[warn] ' + m.text().slice(0, 300))
  })
  page.on('requestfailed', (r) => {
    if (!log.blocked.includes(r.url())) log.errors.push('[requestfailed] ' + r.url().slice(0, 160))
  })
  page.on('request', (r) => log.requests.push(r.url()))
  return log
}

// Dark-pixel coverage of the centre 50% of a screenshot (PIL), 0..1.
function inkCoverage(png) {
  const py = `
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]).convert('L')
w, h = im.size
c = im.crop((w // 4, h // 4, w * 3 // 4, h * 3 // 4))
px = list(c.getdata())
dark = sum(1 for p in px if p < 200)
print(json.dumps({'dark': dark, 'total': len(px), 'min': min(px)}))
`
  const r = spawnSync('python3', ['-c', py, png], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('python PIL failed: ' + r.stderr)
  const j = JSON.parse(r.stdout)
  return { ...j, ratio: j.dark / j.total }
}

async function checkPage(name, url, { offline = false, viewport = { width: 1440, height: 900 }, wait = 2600, after } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  const log = watch(page)
  if (offline) {
    await page.route('**/*', (route) => {
      const u = route.request().url()
      if (u.startsWith('file:') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue()
      log.blocked.push(u)
      return route.abort()
    })
  }
  const t0 = Date.now()
  let canvasMs = -1
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 })
    await page.waitForSelector('canvas', { timeout: 20000 })
    canvasMs = Date.now() - t0
    await page.waitForTimeout(wait)
    if (after) await after(page, log)
    const shot = path.join(OUT, `check-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.png`)
    const box = await page.evaluate(() => {
      const c = document.querySelector('canvas')
      const r = c.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height, cw: c.width, ch: c.height }
    })
    await page.screenshot({ path: shot, clip: { x: box.x, y: box.y, width: Math.min(box.width, viewport.width), height: Math.min(box.height, viewport.height - box.y) } })
    const ink = inkCoverage(shot)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    const problems = [...log.errors, ...(ALLOW_WARN ? [] : log.warnings)]
    const rendered = ink.dark > 150
    const detail = [
      `canvas ${box.cw}x${box.ch} in ${canvasMs} ms`,
      `ink ${(ink.ratio * 100).toFixed(2)}% (${ink.dark} px, darkest ${ink.min})`,
      offline ? `blocked ${log.blocked.length}` : `requests ${log.requests.filter((u) => /^https?:/.test(u)).length}`,
      overflow ? 'HORIZONTAL OVERFLOW' : '',
    ].filter(Boolean).join(' · ')
    pass(name, rendered && !problems.length && !overflow && (!offline || log.blocked.length === 0), detail)
    for (const p of problems) console.log('        ' + p)
    if (ALLOW_WARN) for (const w of log.warnings) console.log('        (allowed) ' + w)
    for (const b of log.blocked) console.log('        blocked ' + b)
  } catch (e) {
    pass(name, false, e.message.split('\n')[0])
    for (const p of [...log.errors, ...log.warnings]) console.log('        ' + p)
  }
  await ctx.close()
}

// 1. Generate everything in the lab.
const lab = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const labLog = watch(lab)
const shapeQ = flags.shape ? `&shape=${encodeURIComponent(flags.shape)}` : ''
await lab.goto(`${BASE}/export-lab.html?webm=1${shapeQ}${flags.seq === 'true' ? '&seq=1' : ''}`, { waitUntil: 'load', timeout: 60000 })
await lab.waitForFunction(() => document.body.dataset.ready === 'true' || document.body.dataset.ready === 'error', null, { timeout: 90000 })
const exp = await lab.evaluate(() => window.__exp)
if (!exp || exp.error) {
  console.error('export lab failed:', exp && exp.error, labLog.errors)
  await browser.close()
  process.exit(1)
}
const labChecks = Object.entries(exp.checks)
pass('export-lab checks', labChecks.every(([, v]) => v), labChecks.filter(([, v]) => !v).map(([k]) => k).join(', ') || `${labChecks.length} ok`)
pass('export-lab console', labLog.errors.length === 0, labLog.errors.join(' | '))
await lab.close()

const base = exp.html.filename.replace(/\.html$/, '')
const files = {
  inline: `${base}.html`,
  cdn: `${base}-cdn.html`,
  embed: `${base}-embed.html`,
  transparent: `${base}-transparent-cdn.html`,
  allCounts: `${base}-all-cdn.html`,
  module: exp.module.filename,
  snippet: 'snippet.html',
  snippetHost: 'snippet-host.html',
  moduleHost: 'module-host.html',
  preset: `${base}.json`,
}
const write = (k, s) => fs.writeFileSync(path.join(OUT, files[k]), s)
write('inline', exp.html.inline)
write('cdn', exp.html.cdn)
write('embed', exp.html.embed)
write('transparent', exp.html.transparent)
write('allCounts', exp.html.allCounts)
write('module', exp.module.code)
write('snippet', exp.snippet)
write('preset', exp.preset)
fs.writeFileSync(path.join(OUT, 'module-usage.txt'), exp.module.usage)

// Host pages: an ordinary page that already has its own content.
const importMap = exp.module.usage.match(/<script type="importmap">[^\n]*<\/script>/)[0]
write(
  'moduleHost',
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>module host</title><link rel="icon" href="data:,">
${importMap}
<style>body{margin:0;font:14px system-ui;background:#fff}header{padding:16px}#piece{height:calc(100vh - 52px)}</style></head>
<body><header>Host page · JS module</header><div id="piece"></div>
<script type="module">
import { mountPulviscolo, payload } from './${files.module}'
window.piece = mountPulviscolo(document.getElementById('piece'))
window.embeddedCount = payload && payload.config.count
</script></body></html>`,
)
write(
  'snippetHost',
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>snippet host</title><link rel="icon" href="data:,">
<style>body{margin:0;font:14px system-ui;background:#fff}section{padding:24px}</style></head>
<body><section><h1>Existing page</h1><p>Content above the pasted snippet.</p></section>
${exp.snippet}
<section><p>Content below.</p></section></body></html>`,
)

// 2. Offline inline HTML.
const fileUrl = (k) => pathToFileURL(path.join(OUT, files[k])).href
await checkPage('inline · file:// offline', fileUrl('inline'), { offline: true })
await checkPage('inline · offline · phone 390', fileUrl('inline'), { offline: true, viewport: { width: 390, height: 844 } })
await checkPage('embed 640px · file:// offline', fileUrl('embed'), { offline: true })
// 3. CDN variants.
await checkPage('cdn · file://', fileUrl('cdn'))
await checkPage('cdn transparent · file://', fileUrl('transparent'))
await checkPage('all counts · setCount(1000)', fileUrl('allCounts'), {
  after: async (page) => {
    await page.evaluate(() => window.pulviscolo && window.pulviscolo.field.setCount(1000))
    await page.waitForTimeout(1500)
  },
})

// 4. Module + snippet over http.
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: OUT, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 700))
try {
  await checkPage('js module · host page + import map', `http://127.0.0.1:${PORT}/${files.moduleHost}`, {
    after: async (page) => {
      const n = await page.evaluate(() => window.embeddedCount)
      if (!n) throw new Error('module payload missing')
    },
  })
  await checkPage('snippet · pasted into a page', `http://127.0.0.1:${PORT}/${files.snippetHost}`)
} finally {
  if (flags['keep-server'] !== 'true') server.kill()
}

await browser.close()

console.log('\nsizes')
const rows = [
  ['HTML inline (offline)', fs.statSync(path.join(OUT, files.inline)).size],
  ['HTML CDN', fs.statSync(path.join(OUT, files.cdn)).size],
  ['HTML all counts (CDN)', fs.statSync(path.join(OUT, files.allCounts)).size],
  ['JS module', fs.statSync(path.join(OUT, files.module)).size],
  ['snippet', fs.statSync(path.join(OUT, files.snippet)).size],
  ['preset JSON', fs.statSync(path.join(OUT, files.preset)).size],
  ['PNG 2x (lab)', exp.png.bytes],
  [`video 1 s (${exp.webm ? exp.webm.mime : 'n/a'})`, exp.webm ? exp.webm.bytes : 0],
]
for (const [k, v] of rows) console.log(`  ${k.padEnd(28)} ${kb(v).padStart(10)}`)
console.log(`  shape: ${exp.id} · files in ${path.relative(ROOT, OUT)}/`)
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
