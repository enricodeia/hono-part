// per-frame CPU distribution of the runtime frame (advance → simulate) under live hover
import { chromium } from 'playwright'
const shape = process.argv[2] || 'triangle'
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
await page.goto('http://localhost:5250/lab.html?shape=' + shape + '&cfg=' + encodeURIComponent(JSON.stringify({ morph: { intro: false } })))
await page.waitForFunction(() => document.body.dataset.ready === 'true')
await page.evaluate(() => {
  const f = window.__lab.field
  window.__cpu = []
  const sim = f._simulate.bind(f)
  const adv = f._advance.bind(f)
  let t0 = 0
  f._advance = (dt) => { t0 = performance.now(); adv(dt) }
  f._simulate = (dt) => { sim(dt); window.__cpu.push(performance.now() - t0) }
})
await page.waitForTimeout(300)
for (let i = 0; i < 240; i++) {
  await page.mouse.move(800 + Math.sin(i / 9) * 200, 450 + Math.cos(i / 7) * 120)
  await page.waitForTimeout(16)
}
const c = await page.evaluate(() => window.__cpu.slice(30).sort((a, b) => a - b))
const q = (p) => c[Math.min(c.length - 1, Math.floor(p * c.length))].toFixed(3)
console.log(`${shape}: frames ${c.length} · p50 ${q(0.5)} ms · p90 ${q(0.9)} ms · p99 ${q(0.99)} ms · max ${c[c.length - 1].toFixed(3)} ms`)
await browser.close()
