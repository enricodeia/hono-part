# Hone · Particles

Particle studio for the Hone identity. The HONE wordmark and four anatomical
specimens (head + brain, heart, DNA horizontal, DNA vertical) rendered as
smooth circular particles in three.js on white, with hover physics, morphs,
dissolve-to-dust, and a one-click export to a self-contained HTML file.

- Particle counts 8000 / 4000 / 3000 / 1500 / 1000 (progressive blue-noise
  order, so every count reads as a finished piece).
- Mouse interaction: repel, attract, swirl, ripple, click burst.
- Controls panel (top right, collapsed): particles, depth, motion, life,
  hover, dissolve, morph, atmosphere, camera, reference overlay, export.
- Export: single HTML (three.js inlined, works offline) or CDN version,
  JS module, embed snippet, PNG up to 4×, WebM, presets.
- Custom specimens: drop an image, SVG, text or GLB/OBJ/STL.

## Run

```bash
npm install        # Font Awesome Pro icons need the FA token in ~/.npmrc
npm run dev        # http://localhost:5250
npm run build
npm run verify     # end-to-end checks (Playwright, real Chrome)
```

Keys: `1`–`6` specimens · `H` hide UI · `P` PNG · `E` export HTML · `R` reroll · `O` reference overlay.

## Structure

- `src/runtime/` the renderer used by the editor AND every export (ParticleField, mount, codec)
- `src/shapes/` procedural specimens (`hone.js` from the client SVG, `headBrain.js`, `heart.js`, `dna.js`) + `custom/`
- `src/editor/` studio UI + `exporters/`
- `SPEC.md` contracts (data formats, config, runtime API, export payload)
- `tools/shot.mjs` screenshots, `preview.html` raw shape preview
