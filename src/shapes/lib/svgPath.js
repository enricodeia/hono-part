// Minimal SVG path → polygon flattener (M L H V C S Q T Z, absolute + relative).
// Returns closed rings [[x, y], ...] in SVG units (y down); arcs are not needed
// for the wordmarks this project ships.

const TOKEN = /[MLHVCSQTZmlhvcsqtz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g

export function flattenPath(d, { tolerance = 1.5 } = {}) {
  const tokens = d.match(TOKEN) || []
  const rings = []
  let ring = null
  let i = 0
  let cmd = 'M'
  let x = 0, y = 0, sx = 0, sy = 0
  let lastCx = null, lastCy = null // reflection point for S / T
  const num = () => parseFloat(tokens[i++])
  const isCmd = (t) => /^[a-zA-Z]$/.test(t)
  const push = (px, py) => ring.push([px, py])
  const close = () => {
    if (ring && ring.length > 2) rings.push(ring)
    ring = null
  }
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    const chord = Math.hypot(x3 - x, y3 - y) + Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)
    const n = Math.min(Math.max(Math.ceil(chord / (tolerance * 6)), 4), 64)
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t
      push(
        u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      )
    }
    lastCx = x2
    lastCy = y2
    x = x3
    y = y3
  }
  const quad = (x1, y1, x2, y2) => {
    cubic(x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y), x2 + (2 / 3) * (x1 - x2), y2 + (2 / 3) * (y1 - y2), x2, y2)
    lastCx = x1
    lastCy = y1
  }

  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++]
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    if (C === 'Z') {
      x = sx
      y = sy
      close()
      lastCx = lastCy = null
      continue
    }
    if (C === 'M') {
      close()
      x = ox + num()
      y = oy + num()
      sx = x
      sy = y
      ring = [[x, y]]
      cmd = rel ? 'l' : 'L' // implicit lineto after moveto
      lastCx = lastCy = null
      continue
    }
    if (!ring) ring = [[x, y]]
    if (C === 'L') {
      x = ox + num()
      y = oy + num()
      push(x, y)
      lastCx = lastCy = null
    } else if (C === 'H') {
      x = ox + num()
      push(x, y)
      lastCx = lastCy = null
    } else if (C === 'V') {
      y = oy + num()
      push(x, y)
      lastCx = lastCy = null
    } else if (C === 'C') {
      const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num(), x3 = ox + num(), y3 = oy + num()
      cubic(x1, y1, x2, y2, x3, y3)
    } else if (C === 'S') {
      const x1 = lastCx === null ? x : 2 * x - lastCx
      const y1 = lastCy === null ? y : 2 * y - lastCy
      const x2 = ox + num(), y2 = oy + num(), x3 = ox + num(), y3 = oy + num()
      cubic(x1, y1, x2, y2, x3, y3)
    } else if (C === 'Q') {
      const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num()
      quad(x1, y1, x2, y2)
    } else if (C === 'T') {
      const x1 = lastCx === null ? x : 2 * x - lastCx
      const y1 = lastCy === null ? y : 2 * y - lastCy
      quad(x1, y1, ox + num(), oy + num())
    } else {
      throw new Error(`[svgPath] unsupported command ${cmd}`)
    }
  }
  close()
  // drop duplicate closing points
  for (const r of rings) {
    const a = r[0], b = r[r.length - 1]
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) r.pop()
  }
  return rings
}

// Even-odd inside test across ALL rings (holes such as the O's counter work).
export function insideRings(px, py, rings) {
  let inside = false
  for (const r of rings) {
    for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
      const ay = r[a][1], by = r[b][1]
      if ((ay > py) !== (by > py) && px < ((r[b][0] - r[a][0]) * (py - ay)) / (by - ay) + r[a][0]) inside = !inside
    }
  }
  return inside
}
