# Pulviscolo: build spec

Particle-form studio. Turns five reference specimens (triangle mark, head + brain,
heart, DNA horizontal, DNA vertical) into living three.js particle pieces on a
white background, with a control panel, hover interaction, and a one-click
export to a self-contained HTML file.

Client brief (Enrico, translated): "Generate these images as particles. They must
scale 8000 / 4000 / 3000 / 1500 / 1000 particles. A control panel to manage it.
Mouse-over interaction. Particles must be circles (ellipses), NOT big square
pixels. Super smooth, super high quality. Must run on three.js in a canvas, and
the panel must export the code as HTML with CSS and libraries integrated. Amaze
me. Everything on WHITE background (head+brain and heart too, even though their
references are dark). Particle colour changeable independently; black for now."

Quality bar: Metalab-grade craft. Restraint, precision, editorial calm. No clunky
3D, no gimmicks that cheapen it. Every default should already look like a
finished poster.

> **CLIENT CHANGE (Enrico, 2026-10-02, supersedes anything below that mentions the triangle or the name "Pulviscolo"):**
> 1. Specimen 01 is now the **HONE wordmark** (`src/shapes/hone.js`, paths in `src/shapes/data/hone-logo.js`, extruded solid letters, life 'wave'). The triangle is RETIRED: hidden from `SHAPES` via `RETIRED` in `src/shapes/index.js` (still buildable by id); delete `src/shapes/triangle.js` + its data at cleanup. The index reads: 01 Hone, 02 Head, 03 Heart, 04 Helix, 05 Helix ↕, 06 Custom.
> 2. Branding is **HONE**, not "Pulviscolo": the top-left mark is the client's HONE SVG (in index.html). "Pulviscolo" survives only as the internal project/folder name.
> 3. The control panel must start **collapsed at the TOP RIGHT** (a small toggle there opens it). On load the only visible chrome is the bottom-left specimen index (kept exactly as it is) and the small HONE mark; the count control lives inside the panel (Specimen folder) rather than floating on the page.
> 4. The repo ships to https://github.com/enricodeia/hono-part (main).

---

## 0. Ground rules for every builder

- Project root: `projects/pulviscolo/`. Dev server ALREADY RUNNING at
  `http://localhost:5250` (Vite, HMR). Do not start another on 5250 and never
  kill it. If it is down, start it with `npx vite --port 5250 --strictPort` in
  the background.
- Dependencies are installed and frozen: three r186, tweakpane 4 +
  @tweakpane/plugin-essentials, @fortawesome (sharp-light / sharp-regular),
  vite 8, esbuild, playwright. Do NOT `npm install` anything. If you truly need a
  package, say so in your report.
- Edit ONLY the files you own (§9). Shared scaffold files (`src/state.js`,
  `src/shapes/lib/*`, `src/shapes/index.js`, `src/runtime/codec.js`,
  `vite.config.js`, `preview.html`, `src/preview.js`, `tools/shot.mjs`, this
  SPEC) are read-only: if you need a change there, put it in your final report.
  You MAY add brand-new helper files inside your own area.
- Screenshots: `node tools/shot.mjs "<path>" shots/<your-prefix>-<name>.png [--w= --h= --dpr=]`.
  Look at them with the Read tool. Iterate visually; compare against
  `reference/*.png` (also served at `/reference/*.png`).
- Copy rules for any UI text: no em dashes (use a colon, comma or middle dot),
  never italic display titles.
- Plain modern JS (ES2022 modules). No TypeScript. Comments only where they add
  information. Match the scaffold's style (2-space, no semicolons, single quotes).

## 1. Conventions

- Units: shapes are normalised by `finalizeShape` so the largest extent is 2.0
  (fits in [-1, 1]), centred at the origin.
- Orientation: the reference view is the FRONT view = camera on +Z looking at
  -Z, +X right, +Y up. A shape must look like its reference from the front
  (yaw 0, pitch 0) before any config rotation. The head faces LEFT (-X).
- Group ids: 0 = primary, 1 = secondary, 2 = accent. Each has its own colour +
  opacity in config (`color/opacity`, `colorB/opacityB`, `colorC/opacityC`).

## 2. ShapeData (produced by `finalizeShape`, consumed by the runtime)

```js
{
  count: 8000,                    // always MAX_COUNT
  positions: Float32Array(N*3),   // PROGRESSIVE order: any prefix k is a good specimen
  normal:    Float32Array(N*3),   // unit surface normals (shading, life, hover)
  group:     Uint8Array(N),       // 0 | 1 | 2
  size:      Float32Array(N),     // relative size multiplier, mean ≈ 1, range ~0.3..2.6
  aux:       Float32Array(N),     // shape-specific scalar, meaning in meta.aux
  bounds: { min:[x,y,z], max:[x,y,z], radius },
  meta: {
    id, label,
    life: 'none' | 'wave' | 'heartbeat' | 'helix' | 'neural' | 'breath',
    axis: [x,y,z],                // life/helix axis (unit), normalised space
    center: [x,y,z],              // life pivot (raw coords in, normalised out)
    frame: { h: 0.6 } | { w: 0.9 } | { h, w }, // viewport fraction the FRONT bbox fills
    groups: ['Brain', 'Head'],    // labels shown in the panel
    aux: 'description of aux',
    transform: { offset, scale }, // raw → normalised mapping (toNormalized)
    buildMs,
  },
}
```

Prefix rule: the runtime draws the first `count` particles. `finalizeShape`
enforces blue-noise prefixes and keeps group proportions in every prefix, so a
1000-particle specimen still reads clearly. Shapes control *where* density goes
(per-part budgets), never the order.

## 3. Shape modules (`src/shapes/<name>.js`)

Default export = one definition or an array of definitions. Auto-registered.

```js
export default {
  id: 'heart', label: 'Heart', order: 3,   // order sorts the specimen index
  params: {                                 // shape-specific knobs for the panel
    vessels: { value: 1, min: 0, max: 1, step: 0.01, label: 'Vessels' },
    style:   { value: 'surface', options: ['surface', 'volume'], label: 'Fill' },
  },
  defaults: { /* partial DEFAULT_CONFIG applied when this shape is selected:
                 its finished "look" (camera, motion, dissolve, life, particles, depth, dust) */ },
  generate(params, { seed, maxCount }) {   // pure + deterministic, < 350 ms on a laptop
    const rng = createRng(seed)
    // … sample ≥ maxCount points (exactly maxCount is fine) …
    return finalizeShape({ positions, normal, group, size, aux }, { seed, maxCount, meta: {...} })
  },
}
```

Toolkit (`src/shapes/lib/`): `rng.js` (createRng: next, range, normal, gauss,
onSphere, inSphere, inDisc, shuffle, weighted), `noise.js` (createNoise3D, fbm3,
ridged3), `curves.js` (catmullRom, bezier, createPath, resample,
transportFrames, vector ops), `sdf.js` (sdEllipsoid, sdCapsule,
sdTaperedCapsule, sdTorus, sdPolyline, smooth ops, rotX/Y/Z, gradient,
sdPolygon2D, gridSDF2D), `sampling.js` (sampleTube, sampleSDF, finalizeShape,
defaultSize, toNormalized, MAX_COUNT).

Silhouette inflation (recommended for organic forms): trace the reference
outline as a polygon (pixel coords → your units, Y flipped), build
`gridSDF2D([poly])`, then define a 3D implicit whose half-thickness at (x, y)
grows with the inside distance, e.g.
`d3 = max(d2, (|z| - T * sqrt(clamp(-d2 / D, 0, 1))))`-style blends, or a smooth
pillow `f = (z / (T·g(d2)))² + …`. Thin parts (vessels, neck) then become round
tubes automatically and the FRONT view matches the reference outline exactly.
Add true 3D detail on top (separate SDF parts, displacement, density masks).

### Life behaviours (runtime implements, shapes provide the data)

| life        | meta used        | aux meaning                                         | behaviour |
|-------------|------------------|-----------------------------------------------------|-----------|
| `wave`      | –                | arc-length along the stroke, 0..1 (+ stroke offset) | slow ripple travels along strokes, displacement along normal |
| `heartbeat` | center           | contraction delay 0..1 (atria 0 → ventricles 1)      | lub-dub pulse about center, normal push, ~60 bpm × rate |
| `helix`     | axis, center     | coordinate along the axis 0..1                       | spin about the helix axis + gentle travelling twist |
| `neural`    | –                | group 0: random 0..1; group 1/2: 0..1 down the spine | sparks: sparse group-0 dots flash (grow + darken); signals travel down the spinal column |
| `breath`    | center           | unused                                               | slow scale breathing |

## 4. Config (`src/state.js`)

`DEFAULT_CONFIG` is the single JSON contract (editor state, presets,
localStorage, exported HTML). `CONFIG_SCHEMA` holds ranges/labels/options for the
panel. `mergeConfig(base, patch)` deep-merges. Read state.js for every key; each
is documented inline. Shape `defaults` are partial configs merged over it.

## 5. Runtime (`src/runtime/ParticleField.js`)

```js
const field = new ParticleField(container, { config, shape, pixelRatio, interactive = true, preserveDrawingBuffer = false })
field.setConfig(patch)                 // deep-merge; cheap; called on every panel tweak
field.setShape(shape, { morph = true }) // index-paired morph using config.morph
field.setCount(n)                      // animated (same as setConfig({ count }))
field.resetView()
field.burst(xCss?, yCss?)              // click effect at a point (centre if omitted)
field.snapshot({ scale = 2, transparent = false }) → Promise<Blob>   // PNG, identical look at any scale
field.captureStream(fps) → MediaStream
field.getCameraState() → { azimuth, elevation, distance }
field.on('frame' | 'morphend' | 'ready', fn) → unsubscribe;  field.off(evt, fn)
field.stats → { fps, particles, dust, cpuMs }
field.resize(); field.dispose()
field.canvas / renderer / scene / camera
```

Must deliver:
- Circular particles: GL points, analytic antialiased disc (`fwidth`), softness
  blend to a gaussian. Sub-pixel dots are drawn at ≥ 1 device px with alpha
  scaled by area (energy kept), so nothing shimmers or turns into squares.
  Perspective size attenuation. DPR ≤ 2 (snapshot can go higher).
- White-background correct blending: dark dots with straight alpha, no
  additive glow, no depth write; result must not depend on draw order (same
  colour per group; depth fade expressed as alpha).
- Per-particle size: `mix(1, aSize, sizeVariance)`, `sizeByCount` compensation
  `(8000 / count)^(0.35 · sizeByCount)`.
- Depth fade (alpha towards the back), shading from normals, DOF (out-of-focus
  dots grow and soften with alpha / area so brightness is kept).
- Dissolve: linear / mirror / radial along `dissolve.angle` in the screen plane,
  soft band with noise, scatter + fade + shrink, slow living drift in the
  dissolved region. Must look like references 01 and 04/05: shape dissolving
  into fine dust on one side.
- Dust: separate ambient points (count, size, opacity, radius, drift) in a large
  soft ellipsoid around the shape, very faint and fine (see every reference).
- Motion: still / sway / spin, static yaw/pitch/roll, float, per-particle wander
  (GPU noise). Life behaviours (table above).
- Hover: screen-space radius (CSS px), modes repel / attract / swirl / ripple,
  spring physics (stiffness / damping) so dots ease back with a hint of
  overshoot; click `burst` (impulse) or `shockwave` (expanding ring). Must feel
  silky at 60 fps with 8000 + dust. Touch works (pointer events).
- Count change animates (dots beyond the new count fade/shrink out in reverse
  progressive order; new ones grow in).
- Morph between shapes: styles flow (curl-noise detour) / explode / sweep,
  stagger, duration; intro assemble from dust on first load (`morph.intro`).
- Camera: autoFit from `shape.meta.frame` × `camera.frame` using the FRONT
  bbox and viewport aspect; azimuth/elevation/offset; drag orbit with inertia
  that eases back to the configured view; optional wheel zoom.
- Background + corner glow rendered INSIDE WebGL (so PNG/WebM match);
  `transparent` snapshot drops them.
- Performance: no per-frame allocations, CPU work < 2 ms/frame at 8000; pause
  when the tab is hidden or the canvas is off-screen; respect
  `prefers-reduced-motion` (no wander/sway, hover still works).

## 6. Export

Payload embedded in every export (built by `src/editor/exporters/`):

```js
{
  config,                       // full DEFAULT_CONFIG-shaped object
  shapes: [encodeShape(shape, n), …],   // codec.js; first = initial shape
  sequence: { enabled, interval: 6, trigger: 'auto' | 'click' | 'both' }, // cycle shapes with morph
  options: { interactive: true, transparent: false },
}
```

`mount(container, payload)` (src/runtime/mount.js) decodes the shapes, creates
the field, wires the sequence, returns `{ field, shapes, next(), destroy() }`.

Bundles (vite.config.js → `getRuntimeSource(kind)` in
`src/editor/exporters/runtimeSource.js`):
- `iife`: standalone.js, three inlined, defines `window.Pulviscolo = { ParticleField, decodeShape, mount }`. For the offline single-file HTML.
- `cdn`: same entry as ESM with bare `three`: inline in `<script type="module">` after an import map to `https://cdn.jsdelivr.net/npm/three@<THREE_VERSION>/build/three.module.min.js`.
- `esm`: module.js. The exporter replaces the string literal `'__PULVISCOLO_PAYLOAD__'` (quotes included) with the JSON payload, giving a self-contained ES module exporting `mountPulviscolo(container, overrides)`.

Exports offered: single-file HTML (offline or CDN), JS module, PNG (1×/2×/4×,
transparent option), WebM recording, preset JSON (save/load, includes custom
shape data when the shape is custom).

### Custom sources (`src/shapes/custom/index.js`)

```js
export const CUSTOM_KINDS = ['image', 'svg', 'text', 'model']
export const CUSTOM_PARAMS = { image: {...}, svg: {...}, text: {...}, model: {...} } // same schema style as shape params
export async function createCustomShape(source, params = {}, { seed = 1, maxCount = 8000 } = {}) → ShapeData
//   source: { kind: 'image' | 'svg' | 'text' | 'model', file?: File | Blob, text?: string, name?: string }
export function kindFromFile(file) → 'image' | 'svg' | 'model' | null
```
ShapeData from custom sources has `meta.id = 'custom'`, `meta.label` = file name or text,
`meta.life = 'breath'`, `meta.frame = { h: 0.62 }` (or w for wide sources).

### Exporters API (`src/editor/exporters/index.js`)

```js
export const DEFAULT_EXPORT_OPTIONS = {
  title: 'Pulviscolo', three: 'inline' | 'cdn', layout: 'fullscreen' | 'embed', height: '100vh',
  transparent: false, interactive: true, allCounts: false,
  sequence: { enabled: false, shapes: [], interval: 6, trigger: 'both' },
}
export async function exportHTML({ config, shape, extraShapes = [], options, download = true }) → { html, bytes, filename }
export async function exportModule({ config, shape, extraShapes = [], options, download = true }) → { code, bytes, filename, usage }
export async function exportPNG(field, { scale = 2, transparent = false, filename }) → Blob
export async function recordWebM(field, { seconds = 6, fps = 60, bitrate = 16e6, onProgress }) → Blob
export function presetFromState(state) / async presetToState(fileOrText) // JSON, custom shape data encoded
export function download(blobOrText, filename, mime)
export async function copyText(text)
```

### Python tooling

`python3` has PIL, numpy and OpenCV (cv2): use them to threshold the references
and trace contours (cv2.findContours + approxPolyDP) into polygon data files.

## 7. Editor (index.html, src/main.js, src/editor/*)

Visual direction: a scientific specimen sheet. Pure white, hairline rules
(#e8e8e8), generous margins, tiny uppercase tracking labels, tabular numerals,
one accent at most (ink black). Typeface: Google Fonts "Inter Tight" (UI) +
"JetBrains Mono" or "IBM Plex Mono" (numbers, indices). Icons: Font Awesome
Sharp Light via `@fortawesome/fontawesome-svg-core` (`icon(faX).html`).
- Top-left: wordmark "Pulviscolo" + caption "Particle specimen studio".
- Bottom-left: specimen index `01 Triangle · 02 Head · 03 Heart · 04 Helix · 05 Helix ↕`
  plus "Custom" (upload image / SVG / GLB / text). Number keys 1..6 switch.
- Bottom-centre: count segmented control `8000 4000 3000 1500 1000`.
- Right: Tweakpane panel (light theme matching the sheet), folders:
  Specimen (shape params, seed reroll), Particles, Depth, Motion, Life, Hover,
  Dissolve, Morph, Atmosphere (dust, background, glow), Camera, Reference
  overlay (show the reference png over the canvas with opacity, to calibrate),
  Export. `H` hides all UI, `P` PNG, `E` export HTML, `R` reroll seed.
- Per-shape looks: selecting a shape applies its `defaults`; tweaks are kept
  per shape for the session and persisted to localStorage (wrapped in try/catch).
- Live stats line (fps · particles · dust).

## 8. Reference reading (what the defaults must reproduce)

- 01 triangle: equilateral-ish triangle outline, apex top-centre, with three
  arches stacked inside (bell curves rising from the left edge to the right
  edge) and the base line. Strokes are particle ribbons with real depth: the
  piece is extruded and slightly yawed, so the left edge shows two parallel
  lines (front and back faces). The right ~quarter dissolves into fine grey dust
  drifting right/down-right. Small dots, fine. Frame ≈ 50% of height.
- 02 head + brain (render on WHITE): side view, face to the LEFT. Dense brain
  (cerebrum with gyri texture, cerebellum lower-right, brainstem descending into
  the neck as a dense spinal column). Head shell / face / neck / shoulders are a
  sparse, lighter secondary group; shoulders spread and dissolve at the bottom.
  The brain is the hero. Frame ≈ 85% of height.
- 03 heart (render on WHITE): anatomical heart, front view, apex bottom slightly
  left, aorta + pulmonary trunk + vena cava stubs on top, a short vessel stub on
  the left, full rounded body. Densely and evenly filled. Frame ≈ 62% of height.
- 04 DNA horizontal: double helix along X, symmetric crossovers (strand phase
  offset π), ~2.5 visible turns, base-pair rungs as dotted lines between
  strands, bigger dots with strong size variance on the backbones, both ends
  fading into dust. Frame ≈ 90% of width.
- 05 DNA vertical: same helix vertical, ~1.5 turns, perspective, left strand
  dark, right side dissolving towards the right. Frame ≈ 70% of height.
- All: faint fine dust field across the frame; black dots on white.

## 9. File ownership

| Owner | Files |
|-------|-------|
| Scaffold (read-only) | src/state.js, src/shapes/lib/*, src/shapes/index.js, src/runtime/codec.js, vite.config.js, preview.html, src/preview.js, tools/shot.mjs, SPEC.md |
| Runtime | src/runtime/ParticleField.js, src/runtime/mount.js, src/runtime/standalone.js, src/runtime/module.js, new src/runtime/*.js (shaders, sim, …), lab.html + src/lab.js (runtime test page) |
| Strokes (triangle + DNA) | src/shapes/triangle.js, src/shapes/dna.js, src/shapes/data/triangle-*.js, src/shapes/data/dna-*.js |
| Heart | src/shapes/heart.js, src/shapes/data/heart-*.js |
| Head + brain | src/shapes/headBrain.js, src/shapes/data/head-*.js |
| Custom sources | src/shapes/custom/*.js, custom-lab.html + src/custom-lab.js (test page) |
| Editor UI | index.html, src/main.js, src/editor/*.js|css (except exporters/), public/ (non-reference) |
| Exporters | src/editor/exporters/* (incl. runtimeSource.js), export-lab.html + src/export-lab.js (test page) |

`src/shapes/zz-smoke.js` is a scaffold smoke test; the integrator deletes it.
