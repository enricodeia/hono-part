// Source → RGBA pixels. Images, SVG markup and text all end up as an
// ImageData-like { width, height, data } of about RASTER_SIDE px on the long side,
// which inkField.js then turns into particles.

export const RASTER_SIDE = 1024

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function context2d(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D is not available in this browser')
  return ctx
}

// Fit (w, h) so the long side is `side` (up or down scaled, aspect kept).
function fitSize(w, h, side) {
  const s = side / Math.max(w, h)
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]
}

function drawToPixels(drawable, sw, sh, side = RASTER_SIDE) {
  if (!sw || !sh) throw new Error('The image has no size (0 × 0 px)')
  const [w, h] = fitSize(sw, sh, side)
  const canvas = makeCanvas(w, h)
  const ctx = context2d(canvas)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  // large downscales in one drawImage alias; halve progressively first
  let src = drawable
  let cw = sw
  let ch = sh
  while (cw > w * 2.2 && ch > h * 2.2) {
    const nw = Math.round(cw / 2)
    const nh = Math.round(ch / 2)
    const step = makeCanvas(nw, nh)
    const sctx = context2d(step)
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(src, 0, 0, nw, nh)
    src = step
    cw = nw
    ch = nh
  }
  ctx.drawImage(src, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

/* ------------------------------------------------------------- bitmaps --- */

export async function rasterizeImage(blob) {
  let bmp
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none' })
  } catch (e) {
    throw new Error(`Could not decode the image${blob.name ? ` "${blob.name}"` : ''}: unsupported or corrupt file`)
  }
  try {
    return drawToPixels(bmp, bmp.width, bmp.height)
  } finally {
    if (bmp.close) bmp.close()
  }
}

/* ----------------------------------------------------------------- svg --- */

// Gives the SVG explicit pixel width/height from its viewBox so it rasterizes
// at full resolution (SVGs without width/height decode at 0 or 300 × 150 px).
function sizedSvg(markup, side) {
  if (typeof DOMParser === 'undefined') throw new Error('SVG input needs a browser (DOMParser)')
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')
  const svg = doc.documentElement
  if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
    throw new Error('Invalid SVG: could not parse the markup')
  }
  let vw = 0
  let vh = 0
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    vw = vb[2]
    vh = vb[3]
  } else {
    vw = parseFloat(svg.getAttribute('width')) || 0
    vh = parseFloat(svg.getAttribute('height')) || 0
    if (vw > 0 && vh > 0) svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`)
  }
  if (!(vw > 0 && vh > 0)) {
    vw = 1
    vh = 1
  }
  const [w, h] = fitSize(vw, vh, side)
  svg.setAttribute('width', String(w))
  svg.setAttribute('height', String(h))
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  return { markup: new XMLSerializer().serializeToString(svg), w, h }
}

// Rasterized on transparent: inkField's alpha detection then reads the drawing
// itself, so white-on-transparent marks work as well as black ones.
export async function rasterizeSvg(markup) {
  if (typeof markup !== 'string' || !/<svg[\s>]/i.test(markup)) throw new Error('Invalid SVG: no <svg> element found')
  const { markup: sized, w, h } = sizedSvg(markup, RASTER_SIDE)
  const url = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.decoding = 'async'
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = () => reject(new Error('Could not render the SVG (external references or invalid markup?)'))
      img.src = url
    })
    const canvas = makeCanvas(w, h)
    const ctx = context2d(canvas)
    ctx.drawImage(img, 0, 0, w, h)
    return ctx.getImageData(0, 0, w, h)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/* ---------------------------------------------------------------- text --- */

export const TEXT_FONTS = {
  'Inter Tight': { css: '"Inter Tight", "Helvetica Neue", Arial, sans-serif', google: 'Inter+Tight' },
  'JetBrains Mono': { css: '"JetBrains Mono", ui-monospace, Menlo, monospace', google: 'JetBrains+Mono' },
  Serif: { css: 'Georgia, "Times New Roman", Times, serif', google: null },
}

const fontLinks = new Map()

// Makes sure the face is usable by canvas: injects the Google Fonts stylesheet
// once if the family is not declared yet, then waits for document.fonts.load.
// Never hangs: falls back to the next family in the stack after ~2.5 s.
async function ensureFont(name, weight) {
  const f = TEXT_FONTS[name]
  if (!f || !f.google || typeof document === 'undefined' || !document.fonts) return
  const spec = `${weight} 64px "${name}"`
  const timeout = (ms) => new Promise((r) => setTimeout(r, ms))
  try {
    if (document.fonts.check(spec)) {
      const faces = await document.fonts.load(spec)
      if (faces.length) return
    }
    if (!fontLinks.has(name)) {
      const declared = [...document.fonts].some((ff) => ff.family.replace(/"/g, '') === name)
      if (!declared) {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = `https://fonts.googleapis.com/css2?family=${f.google}:wght@100..900&display=block`
        const loaded = new Promise((r) => {
          link.onload = r
          link.onerror = r
        })
        document.head.appendChild(link)
        fontLinks.set(name, loaded)
      } else {
        fontLinks.set(name, Promise.resolve())
      }
    }
    await Promise.race([fontLinks.get(name), timeout(2500)])
    await Promise.race([document.fonts.load(spec, 'Pulviscolo'), timeout(2500)])
  } catch {
    // fall back silently to the stack's next family
  }
}

export async function rasterizeText(text, p = {}) {
  const content = String(text ?? '').replace(/\r/g, '').replace(/\t/g, '  ')
  const lines = content.split('\n')
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  while (lines.length && !lines[0].trim()) lines.shift()
  if (!lines.length) throw new Error('Text is empty: type something to turn into particles')
  const fontName = TEXT_FONTS[p.font] ? p.font : 'Inter Tight'
  const weight = Math.round(Math.min(Math.max(+p.weight || 600, 100), 900))
  await ensureFont(fontName, weight)

  const BASE = 200
  const font = (px) => `${weight} ${px}px ${TEXT_FONTS[fontName].css}`
  const tracking = +p.tracking || 0
  const leading = +p.leading || 1.05
  const align = ['left', 'center', 'right'].includes(p.align) ? p.align : 'center'

  const measureCtx = context2d(makeCanvas(8, 8))
  const metrics = (px) => {
    measureCtx.font = font(px)
    if ('letterSpacing' in measureCtx) measureCtx.letterSpacing = `${tracking * px}px`
    const m = lines.map((l) => measureCtx.measureText(l || ' '))
    const width = Math.max(...m.map((x) => Math.max(x.actualBoundingBoxRight + x.actualBoundingBoxLeft, x.width)))
    const asc = Math.max(...m.map((x) => x.actualBoundingBoxAscent), px * 0.7)
    const desc = Math.max(...m.map((x) => x.actualBoundingBoxDescent), 0)
    return { m, width, asc, desc }
  }
  const m0 = metrics(BASE)
  const h0 = m0.asc + m0.desc + (lines.length - 1) * BASE * leading
  const pad0 = BASE * 0.12
  const px = BASE * (RASTER_SIDE - 2) / (Math.max(m0.width, h0) + pad0 * 2)
  const mm = metrics(px)
  const pad = pad0 * (px / BASE)
  const lineH = px * leading
  const W = Math.ceil(mm.width + pad * 2)
  const H = Math.ceil(mm.asc + mm.desc + (lines.length - 1) * lineH + pad * 2)
  const canvas = makeCanvas(W, H)
  const ctx = context2d(canvas)
  ctx.font = font(px)
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${tracking * px}px`
  ctx.fillStyle = '#000'
  ctx.textBaseline = 'alphabetic'
  lines.forEach((line, i) => {
    const lm = mm.m[i]
    const lw = lm.actualBoundingBoxRight + lm.actualBoundingBoxLeft
    const x = align === 'left' ? pad : align === 'right' ? W - pad - lw : (W - lw) / 2
    ctx.fillText(line, x + lm.actualBoundingBoxLeft, pad + mm.asc + i * lineH)
  })
  return ctx.getImageData(0, 0, W, H)
}
