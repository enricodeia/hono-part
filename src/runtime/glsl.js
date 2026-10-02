// GLSL for the particle field. Written GLSL ES 1.0 style; three.js maps it to
// WebGL2 (attribute/varying/gl_FragColor) for ShaderMaterial.
//
// PARITY: the position math in PARTICLE_VERT (morph, life, dissolve) is
// mirrored on the CPU by kinematics.js so hover physics sees exactly what the
// GPU draws. Change both together. Wander noise is GPU-only by design (a few px).

export const COMMON = /* glsl */ `
#define PI 3.141592653589793
#define TAU 6.283185307179586

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float bump(float x, float w) {
  float u = clamp(1.0 - (x * x) / (w * w), 0.0, 1.0);
  return u * u;
}

vec3 rotAxis(vec3 v, vec3 a, float ang) {
  float c = cos(ang);
  float s = sin(ang);
  return v * c + cross(a, v) * s + a * dot(a, v) * (1.0 - c);
}

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

// Ashima / Gustavson simplex noise
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0)) +
    i.y + vec4(0.0, i1.y, i2.y, 1.0)) +
    i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

vec3 snoise3(vec3 p) {
  return vec3(snoise(p), snoise(p + vec3(31.416, -17.23, 9.71)), snoise(p + vec3(-11.37, 47.13, 23.91)));
}
`

// Shared point emission: sub-pixel energy rule, DOF, soft sprite padding.
// px = wanted diameter in device px; returns via varyings.
export const POINT_EMIT = /* glsl */ `
uniform float uMinPx;
uniform float uMaxPx;
uniform float uDof;
uniform float uFocusDepth;
uniform float uCocScale;
uniform float uCocMax;

varying vec3 vColor;
varying float vAlpha;
varying float vR;
varying float vSprite;
varying float vSoft;

void emitPoint(float px, float alpha, float soft, float depth, vec3 col) {
  float drawn = max(px, uMinPx);
  // dots smaller than one device pixel keep their energy as alpha, never as size
  alpha *= (px * px) / (drawn * drawn);
  if (uDof > 0.0) {
    float coc = min(uDof * abs(depth - uFocusDepth) * uCocScale, uCocMax);
    float d2 = sqrt(drawn * drawn + coc * coc);
    alpha *= (drawn * drawn) / (d2 * d2);
    soft = max(soft, clamp(coc / d2, 0.0, 1.0) * 0.92);
    drawn = d2;
  }
  float R = 0.5 * drawn;
  // sprite: disc + gaussian tail room + 1px antialias pad on each side
  float sprite = 2.0 * (R * (1.0 + 1.25 * soft) + 1.0);
  if (sprite > uMaxPx) {
    float f = uMaxPx / sprite;
    R *= f;
    sprite = uMaxPx;
  }
  gl_PointSize = sprite;
  vColor = col;
  vAlpha = clamp(alpha, 0.0, 1.0);
  vR = R;
  vSprite = sprite;
  vSoft = soft;
}
`

export const POINT_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vR;
varying float vSprite;
varying float vSoft;

void main() {
  // distance from the dot centre in device pixels
  float d = length(gl_PointCoord - 0.5) * vSprite;
  // isotropic screen-space derivative (fwidth is anisotropic on diagonals)
  float aa = max(length(vec2(dFdx(d), dFdy(d))), 0.75);
  // the 1px antialias ramp adds 0.05 / R^2 of extra ink; remove it so the look
  // is identical at any resolution (DPR 1, Retina, 4x snapshots)
  float disc = (1.0 - smoothstep(vR - 0.5 * aa, vR + 0.5 * aa, d)) * (vR * vR) / (vR * vR + 0.05);
  // equal-energy gaussian: sigma = R / sqrt(2)
  float g = exp(-(d * d) / (vR * vR));
  float a = mix(disc, g, vSoft) * vAlpha;
  if (a < 0.0015) discard;
  gl_FragColor = vec4(vColor, a);
}
`

export const PARTICLE_VERT = /* glsl */ `
${COMMON}

attribute vec4 aData;      // size, group, aux, index
attribute vec4 aFromData;  // size, group, delay, alpha
attribute vec3 aFrom;
attribute vec3 aFromNormal;
attribute vec3 aDetour;
attribute vec3 aOffset;
attribute vec3 aScatter;
attribute vec4 aRand;
attribute vec4 aNoise;     // band noise, curl xyz (target shape)
attribute vec4 aNoiseFrom; // same for the morph source

uniform float uMorphP;
uniform float uStagger;
uniform float uMorphTurb;
uniform int uMorphStyle;

uniform int uLifeType;
uniform float uLifeAmt;
uniform float uLifeT;
uniform float uHelixPh;
uniform vec3 uCenter;
uniform vec3 uAxis;

uniform float uWander;
uniform float uWanderScale;
uniform float uWanderT;

uniform mat3 uFrameRot;
uniform mat3 uViewRotInv;
uniform int uDissMode;
uniform vec2 uDissDir;
uniform float uDissAmt;
uniform float uDissSoft;
uniform float uDissLen;
uniform float uDissTurb;
uniform float uDissFade;
uniform float uDissT;
uniform float uDissMin;
uniform float uDissMax;
uniform float uDissRad;

uniform float uCount;
uniform float uCountBand;

uniform float uSize;
uniform float uPR;
uniform float uFrameDist;
uniform float uSizeVar;
uniform float uCountComp;
uniform float uSoftness;
uniform vec3 uColor0;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform float uOpacity0;
uniform float uOpacity1;
uniform float uOpacity2;
uniform float uShading;
uniform vec3 uLight;
uniform float uFadeNear;
uniform float uFadeFar;
uniform float uDepthFade;

${POINT_EMIT}

vec3 groupColor(float g) { return g < 0.5 ? uColor0 : (g < 1.5 ? uColor1 : uColor2); }
float groupOpacity(float g) { return g < 0.5 ? uOpacity0 : (g < 1.5 ? uOpacity1 : uOpacity2); }

void main() {
  float idx = aData.w;

  // count: indices past the animated count shrink and fade over a soft band
  float vis = clamp((uCount - 0.5 - idx) / uCountBand + 0.5, 0.0, 1.0);
  vis = vis * vis * (3.0 - 2.0 * vis);
  if (vis <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0); vAlpha = 0.0; vR = 0.0; vSprite = 1.0; vSoft = 0.0;
    return;
  }

  // morph: per-particle window inside the global progress, quintic in-out
  float S = uStagger;
  float t = clamp((uMorphP - aFromData.z * S) / max(1.0 - S, 1e-4), 0.0, 1.0);
  float e = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  float env = 0.0;
  if (uMorphTurb > 0.0 && t > 0.0 && t < 1.0) env = uMorphStyle == 1 ? sin(PI * pow(t, 0.55)) : sin(PI * e);
  vec3 pre = mix(aFrom, position, e) + aDetour * (env * uMorphTurb);
  vec3 nrm = mix(aFromNormal, normal, e);
  nrm = nrm / max(length(nrm), 1e-4);
  vec3 base = pre;

  // life (object space)
  float lifeSize = 1.0;
  float lifeDark = 0.0;
  float aux = aData.z;
  if (uLifeType == 3) {
    float ang = uHelixPh + uLifeAmt * 0.3 * sin(aux * TAU - uLifeT * 0.8);
    base = uCenter + rotAxis(base - uCenter, uAxis, ang);
    nrm = rotAxis(nrm, uAxis, ang);
  } else if (uLifeAmt > 0.0) {
    if (uLifeType == 1) {
      float ph = aux * 18.85 - uLifeT * 1.7;
      float w = sin(ph) * 0.7 + sin(ph * 0.43 + 1.3) * 0.3;
      base += nrm * (w * uLifeAmt * 0.028);
    } else if (uLifeType == 2) {
      float tau = fract(uLifeT - aux * 0.13);
      float c = bump(tau - 0.1, 0.075) + 0.6 * bump(tau - 0.3, 0.085);
      base -= (base - uCenter) * (c * uLifeAmt * 0.07) + nrm * (c * uLifeAmt * 0.012);
    } else if (uLifeType == 4) {
      if (aData.y < 0.5) {
        float sl = uLifeT * 0.8 + aRand.w * 23.0;
        float fs = floor(sl);
        float fr = sl - fs;
        float on = step(hash12(vec2(idx * 0.7123 + 1.0, fs)), 0.012 + 0.04 * uLifeAmt);
        float f = on * smoothstep(0.0, 0.1, fr) * (1.0 - smoothstep(0.22, 0.85, fr)) * min(1.0, uLifeAmt * 1.6);
        lifeSize = 1.0 + 1.7 * f;
        lifeDark = f;
      } else {
        float s1 = fract(uLifeT * 0.22);
        float s2 = fract(uLifeT * 0.22 + 0.5);
        float f = max(bump(aux - s1, 0.06), bump(aux - s2, 0.06)) * min(1.0, uLifeAmt * 1.4);
        lifeSize = 1.0 + 0.9 * f;
        lifeDark = 0.8 * f;
      }
    } else if (uLifeType == 5) {
      base = uCenter + (base - uCenter) * (1.0 + sin(uLifeT * 1.15) * uLifeAmt * 0.03);
    }
  }

  // dissolve: band from the pre-life position seen from the configured view
  float k = 0.0;
  float streamEnv = 1.0;
  vec3 offV = vec3(0.0);
  vec4 nz = mix(aNoiseFrom, aNoise, e);
  if (uDissAmt > 0.0) {
    vec3 q = uFrameRot * pre;
    float s;
    vec2 dir2;
    if (uDissMode == 2) {
      float l = length(q.xy);
      s = l / max(uDissRad, 1e-4);
      dir2 = l > 1e-4 ? q.xy / l : uDissDir;
    } else {
      float pr = dot(q.xy, uDissDir);
      if (uDissMode == 1) {
        float mid = 0.5 * (uDissMin + uDissMax);
        float hw = max(0.5 * (uDissMax - uDissMin), 1e-4);
        s = abs(pr - mid) / hw;
        dir2 = pr >= mid ? uDissDir : -uDissDir;
      } else {
        s = (pr - uDissMin) / max(uDissMax - uDissMin, 1e-4);
        dir2 = uDissDir;
      }
    }
    float sj = s + nz.x * uDissSoft * 0.5 + (aRand.x - 0.5) * uDissSoft * 0.35;
    float edge = mix(1.0 + 1.2 * uDissSoft, -1.2 * uDissSoft, uDissAmt);
    k = smoothstep(edge - 0.5 * uDissSoft, edge + 0.5 * uDissSoft, sj);
    if (k > 0.0) {
      float ph = fract(uDissT * (0.5 + 0.8 * aRand.z) + aRand.w);
      streamEnv = smoothstep(0.0, 0.15, ph) * (1.0 - smoothstep(0.6, 1.0, ph));
      vec3 dirV = vec3(dir2, 0.0);
      offV = dirV * (uDissLen * ((0.1 + 0.6 * aRand.y) * (0.3 + 0.7 * k) + 0.4 * ph))
           + (nz.yzw * 0.8 + aScatter * 0.35) * (uDissLen * 0.4 * uDissTurb);
      // band dots mostly fade; only the fully dissolved ones travel
      offV *= k * k;
    }
  }

  // wander (GPU only, a few px): dissolved dust wanders more
  float wAmp = uWander * (1.0 + 2.5 * k);
  if (wAmp > 0.0) base += snoise3(pre * uWanderScale + vec3(uWanderT, uWanderT * 0.73, -uWanderT * 0.61)) * wAmp;

  vec4 world = modelMatrix * vec4(base, 1.0);
  world.xyz += uViewRotInv * offV + aOffset;
  vec4 mv = viewMatrix * world;
  gl_Position = projectionMatrix * mv;
  float depth = -mv.z;

  float sz = mix(aFromData.x, aData.x, e);
  float px = uSize * uPR * mix(1.0, sz, uSizeVar) * uCountComp * (uFrameDist / max(depth, 1e-3))
    * lifeSize * mix(1.0, 0.42, k) * (0.3 + 0.7 * vis);

  vec3 col = mix(groupColor(aFromData.y), groupColor(aData.y), e);
  float alpha = mix(groupOpacity(aFromData.y), groupOpacity(aData.y), e) * mix(aFromData.w, 1.0, e) * vis;

  float dz = clamp((depth - uFadeNear) / max(uFadeFar - uFadeNear, 1e-3), 0.0, 1.0);
  alpha *= 1.0 - uDepthFade * dz * (0.6 + 0.4 * dz);

  vec3 nv = normalize(mat3(viewMatrix) * (mat3(modelMatrix) * nrm));
  float lam = dot(nv, uLight) * 0.5 + 0.5;
  alpha *= 1.0 + uShading * (0.5 - lam) * 1.2;

  col = mix(col, col * 0.55, lifeDark);
  alpha = mix(alpha, min(1.0, alpha * 1.5 + 0.3), lifeDark);

  alpha *= (1.0 - uDissFade * k) * mix(1.0, streamEnv, k);

  emitPoint(px, alpha, uSoftness, depth, col);
}
`

export const DUST_VERT = /* glsl */ `
${COMMON}

attribute vec4 aRand;

uniform vec3 uDustRadii;
uniform float uDustT;
uniform float uDustAmp;
uniform float uSize;
uniform float uPR;
uniform float uFrameDist;
uniform float uDustSize;
uniform float uDustOpacity;
uniform float uDustFade;
uniform float uSoftness;
uniform vec3 uColor0;
uniform vec2 uCursor;
uniform vec2 uResCss;
uniform float uCursorR;
uniform float uCursorPush;
uniform vec2 uParallax;

${POINT_EMIT}

void main() {
  vec3 p = position;
  p += snoise3(p * 1.3 + vec3(uDustT * 0.35, uDustT * 0.21, -uDustT * 0.27)) * uDustAmp;
  vec4 mv = viewMatrix * modelMatrix * vec4(p * uDustRadii, 1.0);
  // parallax: layers in front of the shape slide against the pointer, layers behind follow it
  float rel = clamp((-mv.z - uFrameDist) / max(uDustRadii.z, 1e-3), -1.0, 1.0);
  mv.xy += uParallax * rel * uDustRadii.y * 0.035;
  vec4 clip = projectionMatrix * mv;
  float depth = -mv.z;

  // stateless screen-space push around the (smoothed) cursor
  if (uCursorPush != 0.0) {
    vec2 ndc = clip.xy / clip.w;
    vec2 sp = vec2((ndc.x * 0.5 + 0.5) * uResCss.x, (0.5 - ndc.y * 0.5) * uResCss.y);
    vec2 d = sp - uCursor;
    float dd = length(d);
    if (dd < uCursorR && dd > 1e-3) {
      float x = dd / uCursorR;
      float f = (1.0 - x * x);
      sp += d / dd * (f * f * uCursorR * uCursorPush);
      ndc = vec2(sp.x / uResCss.x * 2.0 - 1.0, 1.0 - sp.y / uResCss.y * 2.0);
      clip.xy = ndc * clip.w;
    }
  }
  gl_Position = clip;

  // soft oval: fade on the projected radius so dust in front of the shape stays visible
  float r = length(position.xy);
  float px = uSize * uPR * uDustSize * (0.42 + 0.58 * aRand.y * aRand.y) * min(uFrameDist / max(depth, 1e-3), 1.6);
  float alpha = uDustOpacity * 2.6 * (0.22 + 0.78 * aRand.z) * (1.0 - smoothstep(0.6, 1.0, r)) * uDustFade;
  emitPoint(px, alpha, uSoftness, depth, uColor0);
}
`

export const BG_VERT = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

export const BG_FRAG = /* glsl */ `
uniform vec3 uBg;
uniform vec3 uGlowColor;
uniform float uGlow;
uniform vec2 uRes;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 col = uBg;
  if (uGlow > 0.0) {
    // soft tinted light pooling in the bottom-right corner
    vec2 d = (uv - vec2(1.04, -0.06)) * vec2(uRes.x / uRes.y, 1.0);
    float r = length(d);
    float g = exp(-r * r * 2.4) * 0.85 + exp(-r * r * 9.0) * 0.15;
    col = mix(col, uGlowColor, clamp(g * uGlow * 1.25, 0.0, 1.0));
    // dither: kills 8-bit banding in the faint gradient (flat backgrounds stay exact)
    col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  }
  gl_FragColor = vec4(col, 1.0);
}
`
