// Single-file HTML + paste-in snippet builders.
//   inline: <script> runtime IIFE (three bundled), works from file:// offline
//   cdn:    import map → jsDelivr three, runtime as an inline module
// The payload sits in <script type="application/json" id="…-data">, so the file
// stays readable and can be dropped back into the studio (presetToState).

import { getRuntimeSource, THREE_VERSION } from './runtimeSource.js'
import { buildPayload, payloadJSON, sanitizeExportOptions, shapeName, slug, byteLength } from './payload.js'

export const CDN_BASE = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}`
export const CDN_THREE = `${CDN_BASE}/build/three.module.min.js`
export const IMPORT_MAP = {
  imports: {
    three: CDN_THREE,
    'three/addons/': `${CDN_BASE}/examples/jsm/`,
    'three/examples/': `${CDN_BASE}/examples/`,
  },
}

// Code inlined in <script> must not close the element or open an HTML comment.
// "<\/script" and "<\!--" mean the same thing inside JS strings and regexes.
export function escapeScript(code) {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
}

const escapeHTML = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const escapeComment = (s) => String(s).replace(/--+/g, '-').replace(/[<>]/g, '')

// Rewrites bare `three` imports to absolute CDN URLs (snippet: no import map,
// which a host page may already have or may declare after its own modules).
export function absolutiseThree(code) {
  const map = (spec) => {
    if (spec === 'three') return CDN_THREE
    if (spec.startsWith('three/addons/')) return `${CDN_BASE}/examples/jsm/${spec.slice(13)}`
    if (spec.startsWith('three/examples/')) return `${CDN_BASE}/examples/${spec.slice(15)}`
    return spec
  }
  return code
    .replace(/(\bfrom\s*|\bimport\s*)(["'])(three(?:\/[^"']*)?)\2/g, (_, kw, q, spec) => `${kw}${q}${map(spec)}${q}`)
    .replace(/(\bimport\s*\(\s*)(["'])(three(?:\/[^"']*)?)\2/g, (_, kw, q, spec) => `${kw}${q}${map(spec)}${q}`)
}

function stamp() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

function headerLines(shape, payload, opts, kind) {
  const label = shape.meta?.label || shape.meta?.id || 'shape'
  const n = payload.shapes[0].n
  const extra = payload.shapes.length > 1 ? ` · sequence of ${payload.shapes.length}` : ''
  return [
    'Pulviscolo · particle specimen',
    `generator: Pulviscolo studio · ${stamp()}`,
    `shape: ${label} · ${payload.config.count} of ${n} particles${extra}`,
    `runtime: three r${THREE_VERSION.split('.')[1]} (${kind === 'cdn' ? 'jsDelivr CDN' : 'inline, works offline'})`,
    'handle: window.pulviscolo = { field, shapes, next(), destroy() }',
  ].map(escapeComment)
}

function styles(cfg, opts, id) {
  const bg = opts.transparent ? 'transparent' : cfg.scene.background
  const full = opts.layout === 'fullscreen'
  const h = full ? '100vh' : opts.height
  return [
    '*,*::before,*::after{box-sizing:border-box}',
    `html,body{margin:0;padding:0;background:${bg}}`,
    full ? 'html,body{height:100%;overflow:hidden}' : '',
    `#${id}{position:relative;width:100%;height:${h};${full ? 'height:100dvh;' : ''}overflow:hidden;cursor:default;touch-action:pan-y;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none}`,
    `#${id} canvas{display:block;width:100%;height:100%;outline:none}`,
  ]
    .filter(Boolean)
    .join('\n')
}

const mountCall = (id) =>
  `(function(){var el=document.getElementById('${id}');` +
  `var data=JSON.parse(document.getElementById('${id}-data').textContent);` +
  `window.pulviscolo=window.Pulviscolo.mount(el,data)})()`

export async function buildHTML({ config, shape, extraShapes = [], options }) {
  const opts = sanitizeExportOptions(options)
  const payload = buildPayload({ config, shape, extraShapes, options: opts })
  const kind = opts.three
  const runtime = escapeScript(await getRuntimeSource(kind === 'cdn' ? 'cdn' : 'iife'))
  const id = 'pulviscolo'
  const label = shape.meta?.label || 'Particle specimen'
  const head = [
    '<!doctype html>',
    `<!--\n  ${headerLines(shape, payload, opts, kind).join('\n  ')}\n-->`,
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="Pulviscolo">',
    `<title>${escapeHTML(opts.title)}</title>`,
    '<link rel="icon" href="data:,">',
  ]
  if (kind === 'cdn') {
    head.push(`<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>`)
    head.push(`<script type="importmap">${JSON.stringify(IMPORT_MAP)}</script>`)
    head.push(`<link rel="modulepreload" href="${CDN_THREE}">`, `<link rel="modulepreload" href="${CDN_BASE}/build/three.core.js">`)
  }
  head.push(`<style>\n${styles(payload.config, opts, id)}\n</style>`, '</head>')
  const body = [
    '<body>',
    `<div id="${id}" role="img" aria-label="${escapeHTML(label)}, particle specimen"></div>`,
    `<script type="application/json" id="${id}-data">${payloadJSON(payload)}</script>`,
  ]
  if (kind === 'cdn') {
    body.push(`<script type="module">\n${runtime}\n;${mountCall(id)}\n</script>`)
  } else {
    body.push(`<script>\n${runtime}\n</script>`, `<script>${mountCall(id)}</script>`)
  }
  body.push('</body>', '</html>', '')
  const html = [...head, ...body].join('\n')
  return {
    html,
    bytes: byteLength(html),
    filename: `pulviscolo-${shapeName(shape)}${kind === 'cdn' ? '-cdn' : ''}.html`,
    payload,
  }
}

// Paste-in snippet for an existing page: one container + one module script.
// three comes from jsDelivr by absolute URL, so no import map is needed.
export async function buildSnippet({ config, shape, extraShapes = [], options }) {
  const opts = sanitizeExportOptions({ ...options, layout: 'embed' })
  const payload = buildPayload({ config, shape, extraShapes, options: opts })
  const runtime = escapeScript(absolutiseThree(await getRuntimeSource('cdn')))
  const id = `pulviscolo-${slug(shapeName(shape)).slice(0, 24)}-${Math.random().toString(36).slice(2, 6)}`
  const bg = opts.transparent ? 'transparent' : payload.config.scene.background
  const style =
    `position:relative;width:100%;height:${opts.height};overflow:hidden;background:${bg};` +
    'cursor:default;touch-action:pan-y;-webkit-tap-highlight-color:transparent;user-select:none'
  const label = shape.meta?.label || 'Particle specimen'
  const code = [
    `<!-- Pulviscolo · ${escapeComment(label)} · ${payload.config.count} particles · three r${THREE_VERSION.split('.')[1]} via jsDelivr. Paste inside <body>. -->`,
    `<div id="${id}" role="img" aria-label="${escapeHTML(label)}, particle specimen" style="${style}"></div>`,
    `<script type="application/json" id="${id}-data">${payloadJSON(payload)}</script>`,
    `<script type="module">\n${runtime}\n;(function(){var el=document.getElementById('${id}');` +
      `var data=JSON.parse(document.getElementById('${id}-data').textContent);` +
      `(window.pulviscoloPieces=window.pulviscoloPieces||{})['${id}']=window.Pulviscolo.mount(el,data)})()\n</script>`,
    '',
  ].join('\n')
  return { code, bytes: byteLength(code), id, payload }
}
