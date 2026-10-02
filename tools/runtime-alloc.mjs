// Allocation probe: sampling heap profiler while the field runs with the full
// hover sim active; reports allocations attributed to runtime source files.
import { chromium } from 'playwright'
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
await page.goto('http://localhost:5250/lab.html?shape=' + (process.argv[2] || 'heart') + '&cfg=' + encodeURIComponent(JSON.stringify({ morph: { intro: false }, dissolve: { amount: 0.3 } })))
await page.waitForFunction(() => document.body.dataset.ready === 'true')
await page.waitForTimeout(800)
await page.mouse.move(700, 450)
const cdp = await page.context().newCDPSession(page)
await cdp.send('HeapProfiler.enable')
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 256 })
for (let i = 0; i < 180; i++) {
  await page.mouse.move(800 + Math.sin(i / 10) * 150, 450 + Math.cos(i / 13) * 80)
  await page.waitForTimeout(16)
}
const { profile } = await cdp.send('HeapProfiler.stopSampling')
const rows = new Map()
const walk = (node, stack) => {
  const cf = node.callFrame
  const here = cf.url && /src\/runtime\//.test(cf.url) ? `${cf.functionName || '(anon)'} @ ${cf.url.split('/src/')[1]}:${cf.lineNumber + 1}` : null
  const st = here ? [...stack, here] : stack
  if (node.selfSize && st.length) {
    const key = st[st.length - 1]
    rows.set(key, (rows.get(key) || 0) + node.selfSize)
  }
  for (const c of node.children || []) walk(c, st)
}
walk(profile.head, [])
const sorted = [...rows.entries()].sort((a, b) => b[1] - a[1])
console.log('allocations attributed to runtime frames over ~180 hover frames:')
for (const [k, v] of sorted.slice(0, 15)) console.log(`  ${(v / 1024).toFixed(1).padStart(8)} KB  ${k}`)
if (!sorted.length) console.log('  none')
await browser.close()
