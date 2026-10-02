// Font Awesome Sharp Light (Sharp Regular where a heavier stroke reads better
// at 10 to 12 px). Returns inline SVG markup.

import { icon as faIcon, config as faConfig } from '@fortawesome/fontawesome-svg-core'
import {
  faArrowDownToLine,
  faCamera,
  faCheck,
  faCircleExclamation,
  faCopy,
  faCrosshairs,
  faEyeSlash,
  faFileCode,
  faFloppyDisk,
  faFolderOpen,
  faMinus,
  faPlus,
  faRotateLeft,
  faShuffle,
  faSliders,
  faUpload,
  faVideo,
  faXmark,
  faArrowsRotate,
  faFont,
} from '@fortawesome/sharp-light-svg-icons'
import { faXmark as faXmarkRegular, faSliders as faSlidersRegular } from '@fortawesome/sharp-regular-svg-icons'

faConfig.autoAddCss = false

const ICONS = {
  download: faArrowDownToLine,
  camera: faCamera,
  check: faCheck,
  alert: faCircleExclamation,
  copy: faCopy,
  target: faCrosshairs,
  hide: faEyeSlash,
  code: faFileCode,
  save: faFloppyDisk,
  open: faFolderOpen,
  minus: faMinus,
  plus: faPlus,
  reset: faRotateLeft,
  shuffle: faShuffle,
  sliders: faSliders,
  upload: faUpload,
  video: faVideo,
  close: faXmark,
  refresh: faArrowsRotate,
  text: faFont,
  closeBold: faXmarkRegular,
  slidersBold: faSlidersRegular,
}

const cache = new Map()

export function icon(name, cls = '') {
  const key = name + '|' + cls
  if (cache.has(key)) return cache.get(key)
  const def = ICONS[name]
  if (!def) return ''
  const html = faIcon(def, { classes: ['pv-i', ...(cls ? cls.split(' ') : [])] }).html.join('')
  cache.set(key, html)
  return html
}
