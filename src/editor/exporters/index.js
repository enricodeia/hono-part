// Exporters API (SPEC §6). Every export embeds the same runtime the editor
// renders with, so what Enrico sees in the studio is what ships.

import { buildHTML, buildSnippet } from './html.js'
import { buildModule } from './module.js'
import { download } from './download.js'

export { DEFAULT_EXPORT_OPTIONS, buildPayload, sanitizeConfig, sanitizeExportOptions } from './payload.js'
export { exportPNG, recordWebM, pickRecordingMime } from './media.js'
export { presetFromState, presetToState, presetToJSON, PRESET_FORMAT, PRESET_VERSION } from './preset.js'
export { download, copyText } from './download.js'
export { THREE_VERSION, getRuntimeSource } from './runtimeSource.js'

export async function exportHTML({ config, shape, extraShapes = [], options, download: dl = true } = {}) {
  const { html, bytes, filename } = await buildHTML({ config, shape, extraShapes, options })
  if (dl) download(html, filename, 'text/html;charset=utf-8')
  return { html, bytes, filename }
}

export async function exportModule({ config, shape, extraShapes = [], options, download: dl = true } = {}) {
  const { code, bytes, filename, usage } = await buildModule({ config, shape, extraShapes, options })
  if (dl) download(code, filename, 'text/javascript;charset=utf-8')
  return { code, bytes, filename, usage }
}

// HTML to paste into an existing page (container + scripts, three from CDN).
export async function exportSnippet({ config, shape, extraShapes = [], options } = {}) {
  const { code, bytes } = await buildSnippet({ config, shape, extraShapes, options })
  return { code, bytes }
}

// Human file size: 1.2 MB, 84 KB.
export function formatBytes(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} MB`
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`
  return `${n} B`
}
