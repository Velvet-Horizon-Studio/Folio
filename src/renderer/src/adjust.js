// Photo adjustments rendered with WebGL2. One fragment shader applies every slider,
// so the editor preview updates live and the export runs the same code at full
// resolution. Local effects (HDR, Clarity) need the image's local brightness: that
// comes from an edge-preserving guided filter, computed once per image on the CPU
// from a fixed-size copy (so the preview and the export see identical maps) and
// applied per pixel in the shader, which keeps edges sharp and halo-free.

export const ADJUSTMENTS = [
  {
    group: 'Light',
    items: [
      { key: 'exposure', label: 'Exposure', min: -100, max: 100, format: (v) => `${v > 0 ? '+' : ''}${(v * 0.025).toFixed(2)} EV` },
      { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
      { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
      { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
      { key: 'whites', label: 'Whites', min: -100, max: 100 },
      { key: 'blacks', label: 'Blacks', min: -100, max: 100 },
    ],
  },
  {
    group: 'Color',
    items: [
      { key: 'temperature', label: 'Temperature', min: -100, max: 100 },
      { key: 'tint', label: 'Tint', min: -100, max: 100 },
      { key: 'vibrance', label: 'Vibrance', min: -100, max: 100 },
      { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
    ],
  },
  {
    group: 'Effects',
    items: [
      { key: 'hdr', label: 'HDR', min: 0, max: 100 },
      { key: 'clarity', label: 'Clarity', min: -100, max: 100 },
      { key: 'sharpen', label: 'Sharpen', min: 0, max: 100 },
      { key: 'vignette', label: 'Vignette', min: -100, max: 100 },
      { key: 'fade', label: 'Fade', min: 0, max: 100 },
      { key: 'sepia', label: 'Sepia', min: 0, max: 100 },
      { key: 'grain', label: 'Grain', min: 0, max: 100 },
    ],
  },
]

export const NEUTRAL = Object.fromEntries(ADJUSTMENTS.flatMap((g) => g.items.map((i) => [i.key, 0])))

export const PRESETS = [
  { label: 'None', values: {} },
  { label: 'Vivid', values: { contrast: 20, vibrance: 45, saturation: 10, clarity: 15 } },
  { label: 'HDR', values: { hdr: 70, clarity: 20, vibrance: 25, highlights: -20, shadows: 15 } },
  { label: 'Dramatic', values: { contrast: 35, highlights: -35, shadows: 20, clarity: 45, saturation: -20, vignette: 35 } },
  { label: 'B&W', values: { saturation: -100, contrast: 25, clarity: 10 } },
  { label: 'Sepia', values: { sepia: 85, contrast: 10, fade: 15, vignette: 20 } },
  { label: 'Warm', values: { temperature: 30, vibrance: 10 } },
  { label: 'Cool', values: { temperature: -30, tint: -5, vibrance: 5 } },
  { label: 'Matte', values: { fade: 40, contrast: -15, saturation: -15 } },
  { label: 'Film', values: { fade: 20, contrast: 15, saturation: -10, temperature: 8, grain: 35, vignette: 20 } },
]

export const isNeutral = (p) => Object.keys(NEUTRAL).every((k) => !p[k])

// ── Luminance maps ────────────────────────────────────────────────────────────

const MAP_SIZE = 512

// Box sizes whose three passes approximate a Gaussian of the given sigma
function boxesForGauss(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1)
  let wl = Math.floor(wIdeal)
  if (wl % 2 === 0) wl--
  const wu = wl + 2
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4))
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu))
}

function boxH(src, dst, w, h, r) {
  const n = 2 * r + 1
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let i = -r; i <= r; i++) sum += src[row + Math.min(Math.max(i, 0), w - 1)]
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum / n
      sum += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)]
    }
  }
}

function boxV(src, dst, w, h, r) {
  const n = 2 * r + 1
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let i = -r; i <= r; i++) sum += src[Math.min(Math.max(i, 0), h - 1) * w + x]
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / n
      sum += src[Math.min(y + r + 1, h - 1) * w + x] - src[Math.max(y - r, 0) * w + x]
    }
  }
}

function gaussBlur(data, w, h, sigma) {
  const a = Float32Array.from(data)
  const b = new Float32Array(data.length)
  for (const size of boxesForGauss(sigma, 3)) {
    const r = (size - 1) / 2
    boxH(a, b, w, h, r)
    boxV(b, a, w, h, r)
  }
  return a
}

// Self-guided filter (He et al.) on a luminance map. Returns its per-pixel linear
// coefficients interleaved (a, b): local brightness at full resolution is then
// a·L + b with L the full-resolution pixel, which follows edges sharper than the map.
// Flat areas are smoothed over the radius; edges stronger than ~sqrt(eps) are kept.
function guidedCoefficients(I, w, h, sigma, eps) {
  const n = I.length
  const II = new Float32Array(n)
  for (let i = 0; i < n; i++) II[i] = I[i] * I[i]
  const meanI = gaussBlur(I, w, h, sigma)
  const meanII = gaussBlur(II, w, h, sigma)
  const a = new Float32Array(n), b = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, meanII[i] - meanI[i] * meanI[i])
    a[i] = v / (v + eps)
    b[i] = meanI[i] - a[i] * meanI[i]
  }
  const ma = gaussBlur(a, w, h, sigma), mb = gaussBlur(b, w, h, sigma)
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) { out[i * 2] = ma[i]; out[i * 2 + 1] = mb[i] }
  return out
}

// Local-brightness coefficients for the whole image at two radii (relative to its
// size): large for HDR's lighting, medium for Clarity's local contrast
export function luminanceMaps(image) {
  const s = Math.min(1, MAP_SIZE / Math.max(image.width, image.height))
  const w = Math.max(1, Math.round(image.width * s))
  const h = Math.max(1, Math.round(image.height * s))
  // Halve in steps so the small copy doesn't alias
  let src = image, sw = image.width, sh = image.height
  while (sw / 2 >= w && sh / 2 >= h) {
    const step = new OffscreenCanvas(Math.round(sw / 2), Math.round(sh / 2))
    const sctx = step.getContext('2d')
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(src, 0, 0, sw, sh, 0, 0, step.width, step.height)
    src = step; sw = step.width; sh = step.height
  }
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, sw, sh, 0, 0, w, h)
  const px = ctx.getImageData(0, 0, w, h).data
  const lum = new Float32Array(w * h)
  for (let i = 0; i < lum.length; i++) {
    lum[i] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255
  }
  const long = Math.max(w, h)
  return {
    width: w,
    height: h,
    large: guidedCoefficients(lum, w, h, Math.max(1, long * 0.04), 0.02),
    medium: guidedCoefficients(lum, w, h, Math.max(0.7, long * 0.012), 0.01),
  }
}

// ── Shaders ───────────────────────────────────────────────────────────────────

const VS = `#version 300 es
in vec2 aPos;
uniform vec4 uRect; // image region to draw, in uv: x, y, w, h
out vec2 vUv;
void main() {
  vec2 p = aPos * 0.5 + 0.5;
  // Row 0 of an uploaded image is its top, and the canvas's top is clip y = +1
  vUv = uRect.xy + vec2(p.x, 1.0 - p.y) * uRect.zw;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
uniform sampler2D uImg;
uniform sampler2D uLarge;
uniform sampler2D uMedium;
uniform vec2 uTexel;    // one source pixel, in uv
uniform vec2 uFullSize; // full-resolution image size, so grain matches the export
uniform vec4 uFrame;    // output frame (the crop) in uv, for the vignette
uniform vec3 uWB;
uniform float uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform float uVibrance, uSaturation, uHdr, uClarity, uSharpen, uVignette, uFade, uSepia, uGrain;
out vec4 outColor;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float hash(vec2 p) {
  uvec2 u = uvec2(p);
  uint h = (u.x * 73856093u) ^ (u.y * 19349663u);
  h ^= h >> 16; h *= 2246822519u; h ^= h >> 13; h *= 3266489917u; h ^= h >> 16;
  return float(h) / 4294967295.0;
}

void main() {
  vec4 src = texture(uImg, vUv);
  vec3 c = src.rgb;

  if (uSharpen > 0.0) {
    vec3 n = texture(uImg, vUv + vec2(uTexel.x, 0.0)).rgb + texture(uImg, vUv - vec2(uTexel.x, 0.0)).rgb
           + texture(uImg, vUv + vec2(0.0, uTexel.y)).rgb + texture(uImg, vUv - vec2(0.0, uTexel.y)).rgb;
    c = clamp(c + (c - n * 0.25) * uSharpen * 2.0, 0.0, 1.0);
  }

  // White balance and exposure in linear light
  float gain = exp2(uExposure);
  vec3 v = min(pow(pow(c, vec3(2.2)) * uWB * gain, vec3(1.0 / 2.2)), 1.0);
  float L = luma(v);

  // Local brightness from the guided-filter coefficients (a·L + b), with the
  // pixel's exposure applied to the offset as well
  float g = pow(gain, 1.0 / 2.2);
  vec2 cl = texture(uLarge, vUv).rg;
  vec2 cm = texture(uMedium, vUv).rg;
  float bl = clamp(cl.x * L + cl.y * g, 0.0, 1.0);
  float bm = clamp(cm.x * L + cm.y * g, 0.0, 1.0);

  float L1 = L;
  if (uHdr > 0.0) {
    // Flatten the large-scale lighting and boost the detail on top of it
    float base = mix(bl, 0.5 + (bl - 0.5) * 0.3, uHdr * 0.9);
    L1 = base + (L - bl) * (1.0 + uHdr * 1.5);
  }
  if (uClarity != 0.0) {
    float mid = 1.0 - pow(abs(2.0 * L - 1.0), 2.0);
    L1 += (L - bm) * uClarity * 1.5 * mid;
  }
  L1 = clamp(L1, 0.0, 1.0);

  // Shadows and highlights move the tones in between and leave black and white in place
  if (uShadows != 0.0) L1 += uShadows * (uShadows > 0.0 ? 1.4 : 0.9) * L1 * (1.0 - L1) * (1.0 - L1);
  if (uHighlights != 0.0) L1 += uHighlights * (uHighlights < 0.0 ? 1.8 : 0.9) * L1 * L1 * (1.0 - L1);
  if (uContrast > 0.0) L1 = mix(L1, L1 * L1 * (3.0 - 2.0 * L1), uContrast);
  else if (uContrast < 0.0) L1 = mix(L1, 0.5, -uContrast * 0.5);

  // Carry the luminance change over to the color: scaled where that stays sane,
  // added where the pixel is too dark to scale
  float ratio = L1 / max(L, 1e-4);
  v = mix(v * ratio, v + (L1 - L), clamp((ratio - 2.0) / 4.0, 0.0, 1.0));

  // Whites and blacks move the end points
  if (uWhites > 0.0) v /= 1.0 - uWhites * 0.2;
  else v *= 1.0 + uWhites * 0.2;
  if (uBlacks > 0.0) v = uBlacks * 0.12 + v * (1.0 - uBlacks * 0.12);
  else v = (v + uBlacks * 0.12) / (1.0 + uBlacks * 0.12);
  v = clamp(v, 0.0, 1.0);

  v = mix(v, vec3(0.1) + v * 0.8, uFade);

  // Vibrance favors muted colors; HDR adds a little saturation of its own
  float l2 = luma(v);
  float sat = max(v.r, max(v.g, v.b)) - min(v.r, min(v.g, v.b));
  float vib = uVibrance * (uVibrance > 0.0 ? 1.0 - sat : 1.0);
  v = mix(vec3(l2), v, max(0.0, 1.0 + vib + uSaturation + uHdr * 0.15));

  vec3 sep = vec3(dot(v, vec3(0.393, 0.769, 0.189)), dot(v, vec3(0.349, 0.686, 0.168)), dot(v, vec3(0.272, 0.534, 0.131)));
  v = mix(v, sep, uSepia);

  if (uVignette != 0.0) {
    vec2 q = (vUv - uFrame.xy) / uFrame.zw - 0.5;
    float d = smoothstep(0.2, 1.0, dot(q, q) * 2.0); // 1 at the frame's corners
    if (uVignette > 0.0) v *= 1.0 - uVignette * 0.8 * d;
    else v = mix(v, vec3(1.0), -uVignette * 0.6 * d);
  }

  if (uGrain > 0.0) v += (hash(floor(vUv * uFullSize)) - 0.5) * uGrain * 0.18;

  outColor = vec4(clamp(v, 0.0, 1.0), src.a);
}`

function compile(gl, type, source) {
  const s = gl.createShader(type)
  gl.shaderSource(s, source)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
  return s
}

function makeTexture(gl, unit) {
  const tex = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}

// White-balance multipliers, normalized so they don't change brightness
function whiteBalance(temperature, tint) {
  const t = temperature / 100, ti = tint / 100
  const wb = [1 + 0.3 * t, 1 - 0.25 * ti, 1 - 0.3 * t]
  const k = 0.2126 * wb[0] + 0.7152 * wb[1] + 0.0722 * wb[2]
  return wb.map((x) => x / k)
}

// Renderer bound to a canvas (on-screen or OffscreenCanvas). setImage() uploads the
// source pixels; render() draws `rect` of it to the whole canvas with the given
// adjustments. Rects are in image uv (0–1).
export function createAdjustRenderer(canvas, maps) {
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false })
  if (!gl) throw new Error('WebGL2 is not available.')

  const prog = gl.createProgram()
  const vs = compile(gl, gl.VERTEX_SHADER, VS)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FS)
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog))
  gl.useProgram(prog)
  const u = (name) => gl.getUniformLocation(prog, name)

  // One triangle covering the viewport
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  const imgTex = makeTexture(gl, 0)
  const largeTex = makeTexture(gl, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, maps.width, maps.height, 0, gl.RG, gl.FLOAT, maps.large)
  const mediumTex = makeTexture(gl, 2)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, maps.width, maps.height, 0, gl.RG, gl.FLOAT, maps.medium)
  gl.uniform1i(u('uImg'), 0)
  gl.uniform1i(u('uLarge'), 1)
  gl.uniform1i(u('uMedium'), 2)

  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE)
  const maxView = gl.getParameter(gl.MAX_VIEWPORT_DIMS)
  const tooBig = (w, h) => w > maxTex || h > maxTex || w > maxView[0] || h > maxView[1]

  return {
    canvas,

    // fullSize is the original image's size; the source may be a smaller copy of it
    setImage(source, fullSize) {
      if (tooBig(source.width, source.height)) {
        throw new Error(`The image is too large for adjustments (limit ${maxTex} px per side).`)
      }
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, imgTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
      gl.uniform2f(u('uTexel'), 1 / source.width, 1 / source.height)
      gl.uniform2f(u('uFullSize'), fullSize.w, fullSize.h)
    },

    render(p, rect, frame) {
      if (tooBig(canvas.width, canvas.height)) {
        throw new Error(`The output is too large for adjustments (limit ${maxView[0]} px per side).`)
      }
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.uniform4f(u('uRect'), rect.x, rect.y, rect.w, rect.h)
      gl.uniform4f(u('uFrame'), frame.x, frame.y, frame.w, frame.h)
      gl.uniform3fv(u('uWB'), whiteBalance(p.temperature, p.tint))
      gl.uniform1f(u('uExposure'), p.exposure * 0.025)
      for (const k of ['contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation',
        'hdr', 'clarity', 'sharpen', 'vignette', 'fade', 'sepia', 'grain']) {
        gl.uniform1f(u('u' + k[0].toUpperCase() + k.slice(1)), p[k] / 100)
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },

    dispose(loseContext = false) {
      for (const t of [imgTex, largeTex, mediumTex]) gl.deleteTexture(t)
      gl.deleteBuffer(buf)
      gl.deleteProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      if (loseContext) gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
