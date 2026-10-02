import { defineConfig } from 'vite'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const THREE_VERSION = JSON.parse(readFileSync(resolve(ROOT, 'node_modules/three/package.json'), 'utf8')).version

// The exported HTML embeds the SAME runtime the editor renders with
// (src/runtime/*). esbuild bundles it to a string, three kinds:
//   iife → src/runtime/standalone.js, three inlined, sets window.Pulviscolo (offline HTML)
//   cdn  → src/runtime/standalone.js as ESM, bare `three` (HTML + CDN import map)
//   esm  → src/runtime/module.js as ESM, bare `three`, exports + payload
//          placeholder '__PULVISCOLO_PAYLOAD__' (JS module export)
// Dev: served fresh on every request from /__pulviscolo/runtime.<kind>.js
// Build: inlined as strings into the virtual module 'virtual:pulviscolo-runtime'.
const KINDS = {
  iife: { entry: 'src/runtime/standalone.js', format: 'iife', external: [] },
  cdn: { entry: 'src/runtime/standalone.js', format: 'esm', external: ['three'] },
  esm: { entry: 'src/runtime/module.js', format: 'esm', external: ['three'] },
}
async function bundleRuntime(kind) {
  const k = KINDS[kind]
  const result = await build({
    entryPoints: [resolve(ROOT, k.entry)],
    bundle: true,
    format: k.format,
    external: k.external,
    minify: true,
    write: false,
    target: 'es2020',
    legalComments: 'none',
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

function runtimeBundle() {
  const VIRTUAL = 'virtual:pulviscolo-runtime'
  const RESOLVED = '\0' + VIRTUAL
  let isBuild = false
  return {
    name: 'pulviscolo-runtime-bundle',
    configResolved(config) {
      isBuild = config.command === 'build'
    },
    resolveId(id) {
      if (id === VIRTUAL) return RESOLVED
    },
    async load(id) {
      if (id !== RESOLVED) return
      if (!isBuild) return 'export const iife = null\nexport const cdn = null\nexport const esm = null\n'
      const [iife, cdn, esm] = await Promise.all([bundleRuntime('iife'), bundleRuntime('cdn'), bundleRuntime('esm')])
      return [
        `export const iife = ${JSON.stringify(iife)}`,
        `export const cdn = ${JSON.stringify(cdn)}`,
        `export const esm = ${JSON.stringify(esm)}`,
      ].join('\n')
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const m = req.url && req.url.match(/^\/__pulviscolo\/runtime\.(iife|cdn|esm)\.js/)
        if (!m) return next()
        try {
          const code = await bundleRuntime(m[1])
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(code)
        } catch (err) {
          res.statusCode = 500
          res.end(String(err && err.message ? err.message : err))
        }
      })
    },
  }
}

export default defineConfig({
  base: './',
  define: {
    __THREE_VERSION__: JSON.stringify(THREE_VERSION),
  },
  server: { port: 5250, strictPort: true },
  preview: { port: 5251 },
  plugins: [runtimeBundle()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: {
        main: resolve(ROOT, 'index.html'),
        preview: resolve(ROOT, 'preview.html'),
      },
    },
  },
})
