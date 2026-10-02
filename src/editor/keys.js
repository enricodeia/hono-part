// Keyboard: 1..9 specimens, H interface, P PNG, E HTML, R reroll, O reference,
// Esc closes sheets. Ignored while typing and with modifier keys (so Cmd+R,
// Cmd+P and Cmd+E keep their browser meaning).

const TYPING = new Set(['text', 'search', 'email', 'url', 'number', 'password', 'tel'])

function isTyping(t) {
  if (!t || t === document.body) return false
  if (t.isContentEditable) return true
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true
  return t.tagName === 'INPUT' && TYPING.has((t.type || 'text').toLowerCase())
}

export function bindKeys(app) {
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
    if (isTyping(e.target)) {
      if (e.key === 'Escape') e.target.blur()
      return
    }
    const k = e.key
    if (/^[1-9]$/.test(k)) {
      const entry = app.entries[+k - 1]
      if (!entry) return
      e.preventDefault()
      if (!e.repeat) app.selectEntry(entry.id)
      return
    }
    const actions = {
      h: () => app.chrome.toggleUI(),
      p: () => app.actions.savePNG(),
      e: () => app.actions.exportHTML(),
      r: () => app.reroll(),
      o: () => app.reference.toggle(),
      escape: () => {
        if (app.custom.isOpen()) app.custom.close()
        else if (app.chrome.mobile.matches && app.chrome.panelOpen()) app.chrome.setPanelOpen(false)
        else if (document.body.classList.contains('pv-ui-hidden')) app.chrome.toggleUI(true)
      },
    }
    const fn = actions[k.toLowerCase()]
    if (!fn) return
    e.preventDefault()
    if (!e.repeat) fn()
  })
}
