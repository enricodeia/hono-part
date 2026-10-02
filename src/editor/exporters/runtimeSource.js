// Returns the bundled runtime as source text, for inlining into exports.
//   kind 'iife' → three inlined, defines window.Pulviscolo (offline HTML, ~0.55 MB)
//   kind 'cdn'  → same entry as ESM importing bare 'three': inline it in a
//                 <script type="module"> after a CDN import map (small HTML)
//   kind 'esm'  → src/runtime/module.js: ES module with exports + the
//                 '__PULVISCOLO_PAYLOAD__' placeholder (JS module export)
// Dev fetches a fresh esbuild bundle from the Vite middleware (vite.config.js);
// production builds read the strings baked into the virtual module.

/* global __THREE_VERSION__ */
export const THREE_VERSION = typeof __THREE_VERSION__ !== 'undefined' ? __THREE_VERSION__ : '0.186.1'

const cache = new Map()

export async function getRuntimeSource(kind = 'iife') {
  if (import.meta.env.DEV) {
    const res = await fetch(`/__pulviscolo/runtime.${kind}.js?t=${performance.now()}`)
    if (!res.ok) throw new Error(`runtime bundle failed: ${await res.text()}`)
    return res.text()
  }
  if (!cache.has(kind)) {
    const mod = await import('virtual:pulviscolo-runtime')
    cache.set(kind, mod[kind])
  }
  return cache.get(kind)
}
