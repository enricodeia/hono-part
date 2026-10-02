// Self-contained ES module: runtime (bare `three` import) + embedded payload.

import { getRuntimeSource, THREE_VERSION } from './runtimeSource.js'
import { buildPayload, payloadJSON, sanitizeExportOptions, shapeName, byteLength } from './payload.js'
import { CDN_THREE } from './html.js'

const PLACEHOLDER = /(["'])__PULVISCOLO_PAYLOAD__\1/g

export function injectPayload(source, json) {
  const hits = source.match(PLACEHOLDER) || []
  if (hits.length !== 1) throw new Error(`Pulviscolo export: expected one payload placeholder in the module runtime, found ${hits.length}`)
  // Function replacer: "$" in the JSON must not be read as a replacement pattern.
  return source.replace(PLACEHOLDER, () => json)
}

export async function buildModule({ config, shape, extraShapes = [], options }) {
  const opts = sanitizeExportOptions(options)
  const payload = buildPayload({ config, shape, extraShapes, options: opts })
  const name = shapeName(shape)
  const filename = `pulviscolo-${name}.js`
  const body = injectPayload(await getRuntimeSource('esm'), payloadJSON(payload))
  const label = shape.meta?.label || name
  const header = [
    '/*',
    ` * Pulviscolo · ${label} · ${payload.config.count} particles`,
    ` * generated ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} by Pulviscolo studio`,
    ` * peer dependency: three@${THREE_VERSION} (import map or bundler)`,
    ' * exports: mountPulviscolo(container, overrides?), mount, ParticleField, decodeShape, encodeShape, payload',
    ' */',
  ].join('\n')
  const code = `${header}\n${body}\n`
  const usage = [
    '<!-- 1. Plain HTML: map three, then import the module -->',
    `<script type="importmap">{ "imports": { "three": "${CDN_THREE}" } }</script>`,
    '<div id="pulviscolo" style="height: 100vh"></div>',
    '<script type="module">',
    `  import { mountPulviscolo } from './${filename}'`,
    `  const piece = mountPulviscolo(document.getElementById('pulviscolo'))`,
    '  // piece.field.setConfig({ particles: { color: \'#1a1a1a\' } }) · piece.destroy()',
    '</script>',
    '',
    `// 2. Bundlers (Vite, Next, Astro): npm i three@${THREE_VERSION}`,
    `import { mountPulviscolo } from './${filename}'`,
    `const piece = mountPulviscolo(el, { config: { count: 3000 } })`,
  ].join('\n')
  return { code, bytes: byteLength(code), filename, usage, payload }
}
