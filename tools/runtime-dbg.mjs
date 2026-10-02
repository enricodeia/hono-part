// stress probe: worst-case GPU + CPU load, reports fps and cpu ms while hovering
import { chromium } from 'playwright'
const browser = await chromium.launch({ channel: 'chrome', args: ['--ignore-gpu-blocklist', '--disable-frame-rate-limit'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 })
const cfg = { morph: { intro: false }, dust: { count: 8000, opacity: 0.3 }, depth: { dof: 1, focus: 0.3 }, particles: { softness: 0.5, size: 3 }, dissolve: { amount: 0.4 }, life: { amount: 1 } }
await page.goto('http://localhost:5250/lab.html?shape=' + (process.argv[2] || 'heart') + '&cfg=' + encodeURIComponent(JSON.stringify(cfg)))
await page.waitForFunction(() => document.body.dataset.ready === 'true')
console.log(await page.evaluate(() => navigator.userAgent.includes('Headless') ? 'headless' : 'headed'), await page.evaluate(() => { const gl = window.__lab.field.renderer.getContext(); const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?' }))
await page.waitForTimeout(500)
const t0 = Date.now()
let frames0 = await page.evaluate(() => { window.__n = 0; window.__lab.field.on('frame', () => window.__n++); return 0 })
for (let i = 0; i < 150; i++) {
  await page.mouse.move(800 + Math.sin(i / 9) * 200, 450 + Math.cos(i / 7) * 120)
  await page.waitForTimeout(16)
}
const n = await page.evaluate(() => window.__n)
const s = await page.evaluate(() => window.__lab.field.stats)
console.log(`frames ${n} in ${((Date.now() - t0) / 1000).toFixed(2)} s → ${(n / ((Date.now() - t0) / 1000)).toFixed(1)} fps · stats`, JSON.stringify(s))
await browser.close()
