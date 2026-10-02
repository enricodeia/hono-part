// CPU cost breakdown of one frame's hover simulation at 8000 particles
import { chromium } from 'playwright'
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
await page.goto('http://localhost:5250/lab.html?shape=' + (process.argv[2] || 'heart') + '&cfg=' + encodeURIComponent(JSON.stringify({ morph: { intro: false } })))
await page.waitForFunction(() => document.body.dataset.ready === 'true')
await page.waitForTimeout(400)
await page.mouse.move(800, 450)
await page.waitForTimeout(300)
const r = await page.evaluate(() => {
  const f = window.__lab.field
  const run = (label, patch) => {
    f.setConfig(patch)
    f._advance(1 / 60); f._updateMotion(); f._updateCamera(); f._pushUniforms()
    for (let i = 0; i < 30; i++) f._simulate(1 / 60) // warm
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) f._simulate(1 / 60)
    const sim = (performance.now() - t0) / 200
    const t1 = performance.now()
    for (let i = 0; i < 200; i++) { f._advance(1 / 60); f._updateMotion(); f._updateCamera(); f._pushUniforms() }
    const rest = (performance.now() - t1) / 200
    return `${label}: sim ${sim.toFixed(3)} ms · advance+uniforms ${rest.toFixed(3)} ms`
  }
  return [
    run('plain', { dissolve: { amount: 0 }, life: { enabled: false } }),
    run('life', { life: { enabled: true, amount: 1 } }),
    run('life+dissolve', { dissolve: { amount: 0.4 } }),
    run('life+dissolve+swirl', { hover: { mode: 'swirl' } }),
  ]
})
console.log(r.join('\n'))
await browser.close()
