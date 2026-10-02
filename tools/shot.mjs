#!/usr/bin/env node
// Screenshot any page of the dev server (or a file:// export) with real Chrome.
//
//   node tools/shot.mjs "<path|url>" <out.png> [--w=1600] [--h=900] [--dpr=1]
//                       [--wait=1200] [--timeout=60000] [--eval="js expr"]
//
//   path is resolved against http://localhost:5250 (override with BASE=...).
//   Waits for body[data-ready="true"] when the page sets it (else just --wait ms).
//   Prints page errors / console errors, window.__preview, and --eval's result.
//   Exit code 1 when the page threw.
//
// Examples:
//   node tools/shot.mjs "/preview.html?shape=heart&views=front,side,top" shots/heart.png
//   node tools/shot.mjs "/" shots/app.png --w=1680 --h=945 --dpr=2
//   node tools/shot.mjs "file:///abs/path/export.html" shots/export.png

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => {
    const [k, ...v] = a.slice(2).split('=')
    return [k, v.length ? v.join('=') : 'true']
  }),
)
const [target, out = 'shots/shot.png'] = args.filter((a) => !a.startsWith('--'))
if (!target) {
  console.error('usage: node tools/shot.mjs "<path|url>" <out.png> [--w=] [--h=] [--dpr=] [--wait=] [--eval=]')
  process.exit(2)
}
const BASE = process.env.BASE || 'http://localhost:5250'
const url = /^(https?|file):/.test(target) ? target : BASE + (target.startsWith('/') ? target : '/' + target)
const W = +(flags.w || 1600)
const H = +(flags.h || 900)
const DPR = +(flags.dpr || 1)
const WAIT = +(flags.wait || 600)
const TIMEOUT = +(flags.timeout || 60000)

let browser
try {
  browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
} catch {
  browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] })
}
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR })
const errors = []
page.on('pageerror', (e) => errors.push('[pageerror] ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('[console.error] ' + m.text().slice(0, 400))
  else if (m.type() === 'warning' && /sampleSDF|finalizeShape|THREE/.test(m.text())) errors.push('[warn] ' + m.text().slice(0, 300))
})

let threw = false
try {
  await page.goto(url, { waitUntil: 'load', timeout: TIMEOUT })
  const hasReady = await page
    .waitForFunction(() => document.body && (document.body.dataset.ready === 'true' || document.body.dataset.ready === 'error'), null, { timeout: TIMEOUT })
    .then(() => true)
    .catch(() => false)
  if (!hasReady) console.log('(no data-ready signal; continuing after wait)')
  await page.waitForTimeout(WAIT)
  if (flags.eval) {
    const r = await page.evaluate((src) => {
      // eslint-disable-next-line no-eval
      return Promise.resolve(eval(src)).then((v) => JSON.stringify(v, null, 1))
    }, flags.eval)
    console.log('eval →', r)
  }
  const info = await page.evaluate(() => (window.__preview ? JSON.stringify(window.__preview) : null))
  if (info) console.log('preview →', info.slice(0, 1200))
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  await page.screenshot({ path: out })
  console.log('saved', out)
} catch (e) {
  threw = true
  console.error('shot failed:', e.message)
}
if (errors.length) {
  console.log(`errors (${errors.length}):`)
  for (const e of errors.slice(0, 20)) console.log('  ' + e)
}
await browser.close()
process.exit(threw || errors.some((e) => e.startsWith('[pageerror]')) ? 1 : 0)
