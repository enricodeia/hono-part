// timing probes for setShape / snapshot / sim (dev helper)
import { chromium } from 'playwright'
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://localhost:5250/lab.html?shape=heart&cfg=' + encodeURIComponent(JSON.stringify({ morph: { intro: false } })))
await page.waitForFunction(() => document.body.dataset.ready === 'true')
await page.waitForTimeout(500)
const r = await page.evaluate(async () => {
  const L = window.__lab
  const a = L.buildShape('dna', {}, 1)
  const b = L.buildShape('heart', {}, 1)
  const out = {}
  let t0 = performance.now()
  for (let i = 0; i < 20; i++) L.field.setShape(i % 2 ? a : b, { morph: true })
  out.setShapeMorphMs = (performance.now() - t0) / 20
  t0 = performance.now()
  for (let i = 0; i < 20; i++) L.field.setShape(i % 2 ? a : b, { morph: false })
  out.setShapeInstantMs = (performance.now() - t0) / 20
  await L.frames(3)
  // first-frame upload after a setShape
  L.field.setShape(a, { morph: true })
  t0 = performance.now()
  L.field._renderNow()
  L.field.renderer.getContext().finish()
  out.renderAfterShapeMs = performance.now() - t0
  return out
})
console.log(r)
await browser.close()
