// Export lab: runs every exporter (download:false) against the live runtime.
// Query: shape=<id> (default: first real shape, else zz-smoke), count=8000,
//        webm=0 to skip the recording, seq=1 to add a sequence of all shapes.
// Exposes window.__exp = { html, module, snippet, preset, png, webm, sizes, checks }.

import { DEFAULT_CONFIG, mergeConfig } from './state.js'
import { SHAPES, buildShape, getShapeDef } from './shapes/index.js'
import { ParticleField } from './runtime/ParticleField.js'
import {
  exportHTML,
  exportModule,
  exportSnippet,
  exportPNG,
  recordWebM,
  presetFromState,
  presetToState,
  download,
  formatBytes,
  DEFAULT_EXPORT_OPTIONS,
} from './editor/exporters/index.js'

const q = new URLSearchParams(location.search)
const rows = document.getElementById('rows')
const log = (s) => (document.getElementById('log').textContent += s + '\n')

const PREFERRED = ['triangle', 'head', 'headBrain', 'heart', 'dna', 'dna-h', 'dna-v']

async function run() {
  const ids = SHAPES.map((s) => s.id)
  const real = ids.filter((id) => id !== 'zz-smoke')
  const id = q.get('shape') || PREFERRED.find((p) => ids.includes(p)) || real[0] || 'zz-smoke'
  const def = getShapeDef(id)
  const shape = buildShape(id)
  const count = Math.min(+q.get('count') || 8000, 8000)
  const config = mergeConfig(mergeConfig(DEFAULT_CONFIG, def?.defaults || {}), { shape: id, count, editorOnly: { panel: true } })
  const extra = q.get('seq') === '1' ? ids.filter((s) => s !== id).map((s) => ({ shape: buildShape(s), config: getShapeDef(s)?.defaults || {} })) : []
  const options = {
    ...DEFAULT_EXPORT_OPTIONS,
    title: `Pulviscolo · ${shape.meta?.label || id}`,
    sequence: { ...DEFAULT_EXPORT_OPTIONS.sequence, enabled: extra.length > 0, shapes: extra.map((e) => e.shape.meta.id) },
  }
  log(`shapes available: ${ids.join(', ')}`)
  log(`exporting: ${id} · ${count} particles${extra.length ? ` + ${extra.length} in sequence` : ''}`)

  const field = new ParticleField(document.getElementById('stage'), { config, shape, preserveDrawingBuffer: true })
  window.__field = field
  const base = { config, shape, extraShapes: extra, download: false }

  const t = performance.now()
  const inline = await exportHTML({ ...base, options: { ...options, three: 'inline' } })
  const cdn = await exportHTML({ ...base, options: { ...options, three: 'cdn' } })
  const embed = await exportHTML({ ...base, options: { ...options, three: 'inline', layout: 'embed', height: '640px' } })
  const transparent = await exportHTML({ ...base, options: { ...options, three: 'cdn', transparent: true } })
  const mod = await exportModule({ ...base, options })
  const snippet = await exportSnippet({ ...base, options: { ...options, height: '80vh' } })
  const all = await exportHTML({ ...base, options: { ...options, three: 'cdn', allCounts: true } })
  const exportMs = Math.round(performance.now() - t)

  const state = {
    config,
    looks: { [id]: { particles: { size: 2.4 } }, junk: 'x' },
    exportOptions: options,
    custom: { kind: 'text', name: 'Lab', text: 'Lab', params: { weight: 700 }, shape },
  }
  const preset = presetFromState(state)
  const presetText = JSON.stringify(preset)
  const back = await presetToState(presetText)
  const backFromBlob = await presetToState(new Blob([presetText], { type: 'application/json' }))
  const fromHtml = await presetToState(inline.html)
  const legacy = await presetToState(JSON.stringify({ particles: { size: 3, bogus: 1 }, alien: true }))

  // Let the field draw a few frames before capturing.
  await new Promise((r) => setTimeout(r, 400))
  const png = await exportPNG(field, { scale: 2, download: false })
  const pngT = await exportPNG(field, { scale: 1, transparent: true, download: false })
  let webm = null
  if (q.get('webm') !== '0') {
    try {
      const progress = []
      webm = await recordWebM(field, { seconds: 1, fps: 30, bitrate: 8e6, download: false, onProgress: (p) => progress.push(p) })
      webm.progressCalls = progress.length
    } catch (e) {
      log('webm: ' + e.message)
    }
  }

  const checks = {
    htmlHasDoctype: inline.html.startsWith('<!doctype html>'),
    htmlNoStrayScriptClose: (inline.html.match(/<\/script>/g) || []).length === 3,
    cdnScriptCloses: (cdn.html.match(/<\/script>/g) || []).length === 3,
    editorKeysStripped: !inline.html.includes('editorOnly'),
    moduleNoPlaceholder: !mod.code.includes('__PULVISCOLO_PAYLOAD__'),
    presetRoundtrip: JSON.stringify(back.config) === JSON.stringify(preset.config),
    presetBlob: JSON.stringify(backFromBlob.config) === JSON.stringify(preset.config),
    presetLooksFiltered: !('junk' in back.looks) && back.looks[id]?.particles?.size === 2.4,
    presetCustomShape: back.custom?.shape?.count === shape.count && back.custom?.params?.weight === 700,
    presetFromHtml: fromHtml.source === 'html' && fromHtml.config.count === config.count && fromHtml.shapes[0].count === config.count,
    presetLegacy: legacy.config.particles.size === 3 && !('bogus' in legacy.config.particles) && !('alien' in legacy.config),
    pngSize: png.width > 0 && png.size > 1000,
    pngTransparent: pngT.size > 100,
    webm: q.get('webm') === '0' || (webm && webm.size > 0),
  }
  const sizes = {
    inline: inline.bytes,
    cdn: cdn.bytes,
    embed: embed.bytes,
    transparent: transparent.bytes,
    allCounts: all.bytes,
    module: mod.bytes,
    snippet: snippet.bytes,
    preset: presetText.length,
    png: png.size,
    webm: webm ? webm.size : 0,
    exportMs,
  }

  const files = [
    ['HTML · inline (offline)', inline.filename, inline.bytes, () => download(inline.html, inline.filename)],
    ['HTML · CDN', cdn.filename, cdn.bytes, () => download(cdn.html, cdn.filename)],
    ['HTML · embed 640px', embed.filename, embed.bytes, () => download(embed.html, 'embed-' + embed.filename)],
    ['HTML · all counts (CDN)', all.filename, all.bytes, () => download(all.html, 'all-' + all.filename)],
    ['JS module', mod.filename, mod.bytes, () => download(mod.code, mod.filename)],
    ['Snippet', 'snippet.html', snippet.bytes, () => download(snippet.code, 'snippet.html')],
    ['Preset', 'preset.json', presetText.length, () => download(presetText, `pulviscolo-${id}.json`)],
    ['PNG 2x', png.filename, png.size, () => download(png, png.filename)],
    ['PNG transparent', pngT.filename, pngT.size, () => download(pngT, pngT.filename)],
  ]
  if (webm) files.push([`Video (${webm.mimeType})`, webm.filename, webm.size, () => download(webm, webm.filename)])
  for (const [label, name, bytes, fn] of files) {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td>${label}<br><span style="color:#999">${name}</span></td><td>${formatBytes(bytes)}<button>save</button></td>`
    tr.querySelector('button').onclick = fn
    rows.appendChild(tr)
  }
  for (const [k, v] of Object.entries(checks)) log(`${v ? 'ok  ' : 'FAIL'} ${k}`)
  log(`exports built in ${exportMs} ms`)

  window.__exp = {
    id,
    html: { inline: inline.html, cdn: cdn.html, embed: embed.html, transparent: transparent.html, allCounts: all.html, filename: inline.filename },
    module: { code: mod.code, filename: mod.filename, usage: mod.usage },
    snippet: snippet.code,
    preset: presetText,
    png: { width: png.width, height: png.height, bytes: png.size, filename: png.filename },
    webm: webm ? { bytes: webm.size, mime: webm.mimeType, progressCalls: webm.progressCalls } : null,
    sizes,
    checks,
  }
  document.body.dataset.ready = 'true'
}

run().catch((e) => {
  console.error(e)
  log('ERROR ' + (e.stack || e.message))
  window.__exp = { error: String(e.stack || e.message) }
  document.body.dataset.ready = 'error'
})
