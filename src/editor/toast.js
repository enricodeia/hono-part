// Small ink toasts, bottom-centre above the count control.
//   const t = toast('Building HTML', { busy: true })
//   t.update('Recording 2.4 s') · t.done('Saved') · t.fail('Could not export')

import { icon } from './icons.js'

const MAX = 3
let root = null

function host() {
  return (root ||= document.getElementById('pv-toasts'))
}

export function toast(message, { busy = false, error = false, duration = 2600 } = {}) {
  const el = document.createElement('div')
  el.className = 'pv-toast'
  const ic = document.createElement('span')
  ic.className = 'pv-toast-i'
  const tx = document.createElement('span')
  tx.className = 'pv-toast-t'
  el.append(ic, tx)
  const h = host()
  if (!h) return { update() {}, done() {}, fail() {}, close() {} }
  h.appendChild(el)
  while (h.children.length > MAX) h.firstElementChild.remove()

  let timer = 0
  const set = (msg, state) => {
    tx.textContent = msg
    el.dataset.state = state
    ic.innerHTML = state === 'busy' ? '<i class="pv-spin"></i>' : state === 'error' ? icon('alert') : state === 'ok' ? icon('check') : ''
  }
  const close = () => {
    clearTimeout(timer)
    el.classList.remove('is-in')
    el.classList.add('is-out')
    setTimeout(() => el.remove(), 260)
  }
  const arm = (ms) => {
    clearTimeout(timer)
    if (ms > 0) timer = setTimeout(close, ms)
  }
  set(message, busy ? 'busy' : error ? 'error' : 'plain')
  requestAnimationFrame(() => el.classList.add('is-in'))
  if (!busy) arm(error ? Math.max(duration, 4200) : duration)

  return {
    el,
    update(msg) {
      tx.textContent = msg
    },
    done(msg = message, ms = 2600) {
      set(msg, 'ok')
      arm(ms)
    },
    fail(msg, ms = 4800) {
      set(msg, 'error')
      arm(ms)
    },
    close,
  }
}
