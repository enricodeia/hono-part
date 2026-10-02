// Browser file hand-off helpers.

export function download(blobOrText, filename = 'pulviscolo.txt', mime) {
  let blob = blobOrText
  if (!(blob instanceof Blob)) {
    const text = typeof blobOrText === 'string' ? blobOrText : JSON.stringify(blobOrText, null, 2)
    blob = new Blob([text], { type: mime || guessMime(filename) })
  } else if (mime && blob.type !== mime) {
    blob = new Blob([blob], { type: mime })
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Safari needs the URL alive for a moment after the click.
  setTimeout(() => URL.revokeObjectURL(url), 30000)
  return blob
}

export function guessMime(filename) {
  const ext = String(filename).split('.').pop().toLowerCase()
  return (
    {
      html: 'text/html;charset=utf-8',
      js: 'text/javascript;charset=utf-8',
      mjs: 'text/javascript;charset=utf-8',
      json: 'application/json',
      png: 'image/png',
      webm: 'video/webm',
      mp4: 'video/mp4',
      txt: 'text/plain;charset=utf-8',
    }[ext] || 'application/octet-stream'
  )
}

export async function copyText(text) {
  const s = String(text)
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(s)
      return true
    }
  } catch {
    // fall through to the textarea path (permissions, unfocused document)
  }
  const ta = document.createElement('textarea')
  ta.value = s
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.appendChild(ta)
  const sel = document.getSelection()
  const prev = sel && sel.rangeCount ? sel.getRangeAt(0) : null
  ta.select()
  ta.setSelectionRange(0, s.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  if (prev && sel) {
    sel.removeAllRanges()
    sel.addRange(prev)
  }
  return ok
}
