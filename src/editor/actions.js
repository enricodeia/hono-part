// Export / capture / preset actions. The exporters module is loaded lazily
// (SPEC §6 Exporters API) so the studio keeps working if it is mid-edit.

const loaders = import.meta.glob('./exporters/index.js')
let modPromise = null
function exporters() {
  const load = loaders['./exporters/index.js']
  if (!load) return Promise.reject(new Error('Exporters are not available in this build yet'))
  return (modPromise ||= load().catch((e) => {
    modPromise = null
    throw e
  }))
}

// Mirrors DEFAULT_EXPORT_OPTIONS (SPEC §6) until the exporters module loads.
export const LOCAL_EXPORT_DEFAULTS = {
  title: 'Pulviscolo',
  three: 'inline',
  layout: 'fullscreen',
  height: '100vh',
  transparent: false,
  interactive: true,
  allCounts: false,
  sequence: { enabled: false, shapes: [], interval: 6, trigger: 'both' },
}

const bytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`)
const slug = (s) => String(s || 'shape').toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shape'

export function createActions(app) {
  const { state } = app
  const busy = new Set()

  async function run(key, startMsg, fn) {
    if (busy.has(key)) return
    busy.add(key)
    document.body.classList.add(`pv-busy-${key}`)
    const t = app.toast(startMsg, { busy: true })
    try {
      const msg = await fn(t)
      if (msg) t.done(msg)
      else t.close()
    } catch (e) {
      console.error(e)
      t.fail(e?.message || String(e))
    } finally {
      busy.delete(key)
      document.body.classList.remove(`pv-busy-${key}`)
    }
  }

  const exportInput = () => ({
    config: state.config,
    shape: app.current.shape,
    extraShapes: app.sequenceExtras(),
    options: state.exportOptions,
  })

  function exportHTML() {
    return run('html', 'Building HTML', async () => {
      const ex = await exporters()
      const res = await ex.exportHTML({ ...exportInput(), download: true })
      return `${res.filename} · ${bytes(res.bytes)}`
    })
  }

  function exportModule() {
    return run('module', 'Building JS module', async () => {
      const ex = await exporters()
      const res = await ex.exportModule({ ...exportInput(), download: true })
      return `${res.filename} · ${bytes(res.bytes)}`
    })
  }

  function copySnippet() {
    return run('snippet', 'Building embed snippet', async () => {
      const ex = await exporters()
      let code
      if (typeof ex.exportSnippet === 'function') code = (await ex.exportSnippet(exportInput())).code
      else code = (await ex.exportModule({ ...exportInput(), download: false })).usage
      const ok = await ex.copyText(code)
      if (!ok) throw new Error('Clipboard is blocked in this context')
      return `Embed snippet copied · ${bytes(new Blob([code]).size)}`
    })
  }

  function savePNG() {
    const { pngScale = 2, pngTransparent = false } = state.ui.capture || {}
    return run('png', `Rendering PNG at ${pngScale}×`, async () => {
      const ex = await exporters()
      const blob = await ex.exportPNG(app.field, { scale: pngScale, transparent: pngTransparent })
      const dims = blob && blob.width ? `${blob.width} × ${blob.height}` : bytes(blob?.size || 0)
      return `PNG saved · ${dims}`
    })
  }

  function recordWebM() {
    const seconds = state.ui.capture?.seconds || 6
    return run('webm', `Recording 0.0 s of ${seconds} s`, async (t) => {
      const ex = await exporters()
      const blob = await ex.recordWebM(app.field, {
        seconds,
        onProgress: (p) => t.update(`Recording ${(p * seconds).toFixed(1)} s of ${seconds} s`),
      })
      return `Video saved · ${bytes(blob?.size || 0)}`
    })
  }

  function savePreset() {
    return run('preset', 'Saving preset', async () => {
      const ex = await exporters()
      const custom = state.config.shape === 'custom' && app.customShape ? { ...state.custom, shape: app.customShape } : null
      const preset = ex.presetFromState({ config: state.config, looks: state.looks, exportOptions: state.exportOptions, custom })
      const json = typeof ex.presetToJSON === 'function' ? ex.presetToJSON(preset) : JSON.stringify(preset)
      const name = `pulviscolo-${slug(app.current.id === 'custom' ? app.current.label : app.current.id)}-preset.json`
      ex.download(json, name, 'application/json')
      return `${name} · ${bytes(json.length)}`
    })
  }

  let picker = null
  function loadPreset() {
    if (!picker) {
      picker = document.createElement('input')
      picker.type = 'file'
      picker.accept = '.json,.html,application/json,text/html'
      picker.hidden = true
      document.body.appendChild(picker)
      picker.addEventListener('change', () => {
        const f = picker.files && picker.files[0]
        picker.value = ''
        if (f) loadPresetFile(f)
      })
    }
    picker.click()
  }

  function loadPresetFile(file) {
    return run('load', `Reading ${file.name}`, async () => {
      const ex = await exporters()
      const res = await ex.presetToState(file)
      app.applyLoadedState(res)
      return `Preset loaded · ${app.current.label}`
    })
  }

  return { exportHTML, exportModule, copySnippet, savePNG, recordWebM, savePreset, loadPreset, loadPresetFile, exporters }
}
