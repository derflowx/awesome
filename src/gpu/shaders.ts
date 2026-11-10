import { MAX_SLOTS } from '../graph/compile';

/** Number of vec4 header entries before the parameter array in the scene uniform. */
export const HEADER_VEC4S = 11;

export const SCENE_PRELUDE = /* wgsl */ `
struct Uniforms {
  res: vec4f,       // w, h, 1/w, 1/h
  camPos: vec4f,    // xyz, tan(fov/2)
  camRight: vec4f,
  camUp: vec4f,
  camFwd: vec4f,
  sky: vec4f,
  horizon: vec4f,
  sun: vec4f,       // rgb * power
  sunDir: vec4f,
  fx: vec4f,        // glow, fog, time, blendAlpha
  jit: vec4f,       // jitterX, jitterY, frame, maxSteps
  p: array<vec4f, ${MAX_SLOTS}>,
};
@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var prevTex: texture_2d<f32>;
@group(0) @binding(2) var atlasTex: texture_2d<f32>;
@group(0) @binding(3) var atlasSamp: sampler;

const ATLAS_W = 2048.0;
const ATLAS_H = 2048.0;
const ATLAS_ROW = 256.0;
const SDF_SPREAD = 24.0;

// 2D signed distance to baked text. info = (halfW px, halfH px, row, font px); k = world units per px.
fn textSdf2(q: vec2f, info: vec4f, k: f32) -> f32 {
  let px = q / k;
  let row0 = info.z * ATLAS_ROW;
  let uvPx = vec2f(clamp(ATLAS_W * 0.5 + px.x, 1.0, ATLAS_W - 1.0),
                   clamp(row0 + ATLAS_ROW * 0.5 - px.y, row0 + 1.0, row0 + ATLAS_ROW - 1.0));
  let s = textureSampleLevel(atlasTex, atlasSamp, uvPx / vec2f(ATLAS_W, ATLAS_H), 0.0).r;
  let dpx = (0.5 - s) * 2.0 * SDF_SPREAD;
  let b = abs(px) - info.xy;
  let boxD = length(max(b, vec2f(0.0)));
  // Outside the ink box the box distance is a tighter bound; inside keep the true (negative) distance.
  return select(dpx, max(dpx, boxD), boxD > 0.0) * k;
}

struct Sd {
  d: f32,
  col: vec3f,
  mat: vec4f, // roughness, metallic, emission, iridescence
};

fn sdMat(d: f32) -> Sd { return Sd(d, vec3f(0.82), vec4f(0.4, 0.0, 0.0, 0.0)); }
fn sdEmpty() -> Sd { return Sd(1e5, vec3f(0.0), vec4f(1.0, 0.0, 0.0, 0.0)); }

fn opU(a: Sd, b: Sd, k: f32) -> Sd {
  let kk = max(k, 1e-4);
  let h = clamp(0.5 + 0.5 * (b.d - a.d) / kk, 0.0, 1.0);
  return Sd(mix(b.d, a.d, h) - kk * h * (1.0 - h), mix(b.col, a.col, h), mix(b.mat, a.mat, h));
}
fn opS(a: Sd, b: Sd, k: f32) -> Sd {
  let kk = max(k, 1e-4);
  let h = clamp(0.5 - 0.5 * (a.d + b.d) / kk, 0.0, 1.0);
  return Sd(mix(a.d, -b.d, h) + kk * h * (1.0 - h), mix(a.col, b.col, h), mix(a.mat, b.mat, h));
}
fn opI(a: Sd, b: Sd, k: f32) -> Sd {
  let kk = max(k, 1e-4);
  let h = clamp(0.5 - 0.5 * (b.d - a.d) / kk, 0.0, 1.0);
  return Sd(mix(b.d, a.d, h) + kk * h * (1.0 - h), mix(b.col, a.col, h), mix(b.mat, a.mat, h));
}

fn safeDiv(x: f32) -> f32 { return select(x, 1e-6, abs(x) < 1e-6); }
fn modf1(a: f32, b: f32) -> f32 { let m = select(b, 1.0, abs(b) < 1e-6); return a - m * floor(a / m); }

fn rotX(v: vec3f, a: f32) -> vec3f { let c = cos(a); let s = sin(a); return vec3f(v.x, c * v.y - s * v.z, s * v.y + c * v.z); }
fn rotY(v: vec3f, a: f32) -> vec3f { let c = cos(a); let s = sin(a); return vec3f(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
fn rotZ(v: vec3f, a: f32) -> vec3f { let c = cos(a); let s = sin(a); return vec3f(c * v.x - s * v.y, s * v.x + c * v.y, v.z); }
fn invRotate(v: vec3f, r: vec3f) -> vec3f { return rotX(rotY(rotZ(v, -r.z), -r.y), -r.x); }

fn pcg3(v0: vec3u) -> vec3u {
  var v = v0 * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
fn hash33(p: vec3f) -> vec3f {
  let h = pcg3(bitcast<vec3u>(vec3i(p)));
  return vec3f(h) * (2.0 / 4294967295.0) - 1.0;
}
fn gnoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let n000 = dot(hash33(i + vec3f(0.0, 0.0, 0.0)), f - vec3f(0.0, 0.0, 0.0));
  let n100 = dot(hash33(i + vec3f(1.0, 0.0, 0.0)), f - vec3f(1.0, 0.0, 0.0));
  let n010 = dot(hash33(i + vec3f(0.0, 1.0, 0.0)), f - vec3f(0.0, 1.0, 0.0));
  let n110 = dot(hash33(i + vec3f(1.0, 1.0, 0.0)), f - vec3f(1.0, 1.0, 0.0));
  let n001 = dot(hash33(i + vec3f(0.0, 0.0, 1.0)), f - vec3f(0.0, 0.0, 1.0));
  let n101 = dot(hash33(i + vec3f(1.0, 0.0, 1.0)), f - vec3f(1.0, 0.0, 1.0));
  let n011 = dot(hash33(i + vec3f(0.0, 1.0, 1.0)), f - vec3f(0.0, 1.0, 1.0));
  let n111 = dot(hash33(i + vec3f(1.0, 1.0, 1.0)), f - vec3f(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
fn easeOutBack(x: f32) -> f32 { let c1 = 1.70158; let y = x - 1.0; return 1.0 + (c1 + 1.0) * y * y * y + c1 * y * y; }
fn easeInBack(x: f32) -> f32 { let c1 = 1.70158; return (c1 + 1.0) * x * x * x - c1 * x * x; }
fn twistY(p: vec3f, a: f32) -> vec3f {
  let k = a * clamp(1.0 - length(p.xz) * 0.15, 0.2, 1.0);
  let c = cos(k * p.y * 0.4 + k);
  let s = sin(k * p.y * 0.4 + k);
  return vec3f(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
}

fn fbm(p: vec3f, octaves: i32) -> f32 {
  var s = 0.0;
  var a = 0.5;
  var q = p;
  for (var i = 0; i < 6; i++) {
    if (i >= octaves) { break; }
    s += a * gnoise(q);
    q = q * 2.03 + vec3f(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s * 1.8;
}
`;

export const SCENE_MAIN = /* wgsl */ `
var<private> gGlow: vec3f;

fn mapD(p: vec3f) -> f32 { return sceneMap(p).d; }

fn calcNormal(p: vec3f, t: f32) -> vec3f {
  let e = max(0.0004, 0.0004 * t);
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * mapD(p + k.xyy * e) + k.yyx * mapD(p + k.yyx * e) +
                   k.yxy * mapD(p + k.yxy * e) + k.xxx * mapD(p + k.xxx * e));
}

fn march(ro: vec3f, rd: vec3f, tmax: f32, maxSteps: i32, glow: bool) -> f32 {
  var t = 0.01;
  var last = 1e5;
  for (var i = 0; i < 400; i++) {
    if (i >= maxSteps) { break; }
    let h = sceneMap(ro + rd * t);
    if (glow && h.mat.z > 0.0) {
      let dd = max(h.d, 0.0);
      gGlow += h.col * h.mat.z * min(dd, 0.6) * 0.06 / (1.0 + dd * dd * 18.0);
    }
    last = h.d;
    if (h.d < max(0.00025 * t, 0.0001)) { return t; }
    t += h.d * 0.85;
    if (t > tmax) { return -1.0; }
  }
  if (last < 0.03) { return t; }
  return -1.0;
}

fn softShadow(ro: vec3f, rd: vec3f, k: f32) -> f32 {
  var res = 1.0;
  var t = 0.02;
  for (var i = 0; i < 48; i++) {
    let h = mapD(ro + rd * t);
    res = min(res, k * h / t);
    t += clamp(h, 0.02, 0.4);
    if (res < 0.002 || t > 25.0) { break; }
  }
  return clamp(res, 0.0, 1.0);
}

fn calcAO(p: vec3f, n: vec3f) -> f32 {
  var occ = 0.0;
  var sca = 1.0;
  for (var i = 0; i < 5; i++) {
    let h = 0.01 + 0.14 * f32(i) / 4.0;
    let d = mapD(p + h * n);
    occ += (h - d) * sca;
    sca *= 0.92;
  }
  return clamp(1.0 - 2.6 * occ, 0.0, 1.0);
}

fn skyCol(rd: vec3f) -> vec3f {
  let y = rd.y;
  var c = mix(U.horizon.rgb, U.sky.rgb, pow(clamp(y, 0.0, 1.0), 0.5));
  c = mix(c, U.horizon.rgb * 0.18 + U.sky.rgb * 0.12, 1.0 - smoothstep(-0.25, 0.0, y));
  let s = max(dot(rd, U.sunDir.xyz), 0.0);
  c += U.sun.rgb * (pow(s, 900.0) * 8.0 + pow(s, 14.0) * 0.05);
  return c;
}

fn ambientCol(n: vec3f) -> vec3f {
  return mix(U.horizon.rgb * 0.8, U.sky.rgb * 1.4 + U.horizon.rgb * 0.2, n.y * 0.5 + 0.5) + U.sun.rgb * 0.02;
}

fn fogMix(col: vec3f, rd: vec3f, t: f32) -> vec3f {
  return mix(col, skyCol(rd), 1.0 - exp(-t * t * U.fx.y * 0.0015));
}

fn shadeSurface(p: vec3f, n: vec3f, rd: vec3f, h: Sd, doRefl: bool) -> vec3f {
  let base = max(h.col, vec3f(0.0));
  let rough = clamp(h.mat.x, 0.03, 1.0);
  let metal = h.mat.y;
  let emit = h.mat.z;
  let irid = h.mat.w;
  let v = -rd;
  let l = U.sunDir.xyz;
  let hv = normalize(l + v);
  let ndl = max(dot(n, l), 0.0);
  let ndv = max(dot(n, v), 1e-3);
  let ndh = max(dot(n, hv), 0.0);

  // Thin-film interference approximation: hue rotates with view angle.
  let film = 0.5 + 0.5 * cos(6.2831853 * (vec3f(0.0, 0.33, 0.67) + ndv * 1.7 + irid * 0.4));
  var F0 = mix(vec3f(0.04), base, metal);
  F0 = mix(F0, film, irid);
  let F = F0 + (1.0 - F0) * pow(1.0 - ndv, 5.0);

  let a = rough * rough;
  let a2 = a * a;
  let dd = ndh * ndh * (a2 - 1.0) + 1.0;
  let D = a2 / (3.14159 * dd * dd);
  let kk = (rough + 1.0) * (rough + 1.0) / 8.0;
  let G = (ndv / (ndv * (1.0 - kk) + kk)) * (ndl / (ndl * (1.0 - kk) + kk));
  let FL = F0 + (1.0 - F0) * pow(1.0 - max(dot(hv, v), 0.0), 5.0);
  let spec = D * G * FL / max(4.0 * ndv * ndl, 1e-3);

  var sh = 0.0;
  if (ndl > 0.0) { sh = softShadow(p + n * 0.004, l, 10.0); }
  let ao = calcAO(p, n);
  let sunL = U.sun.rgb * ndl * sh;
  let amb = ambientCol(n);

  let kd = (1.0 - metal) * (1.0 - irid * 0.7);
  var col = kd * base * (sunL / 3.14159 + amb * ao * 0.55);
  col += spec * sunL;

  let r = reflect(rd, n);
  var env = skyCol(r);
  if (doRefl && rough < 0.75) {
    let ro = p + n * 0.01;
    let tr = march(ro, r, 30.0, 90, false);
    if (tr > 0.0) {
      let rp = ro + r * tr;
      let rh = sceneMap(rp);
      let rn = calcNormal(rp, tr);
      let rl = max(dot(rn, l), 0.0);
      env = max(rh.col, vec3f(0.0)) * (U.sun.rgb * rl * 0.25 + ambientCol(rn) * 0.5) + rh.col * rh.mat.z;
      env = fogMix(env, r, tr);
    }
  }
  env = mix(env, amb, rough * rough);
  col += env * F * ao * (1.0 - rough * 0.6);
  col += base * emit;
  return col;
}

var<private> gHitT: f32;

fn render(ro: vec3f, rd: vec3f) -> vec3f {
  gGlow = vec3f(0.0);
  gHitT = 1e4;
  let t = march(ro, rd, 80.0, i32(U.jit.w), U.fx.x > 0.0);
  var col: vec3f;
  if (t > 0.0) {
    gHitT = t;
    let p = ro + rd * t;
    let h = sceneMap(p);
    let n = calcNormal(p, t);
    col = shadeSurface(p, n, rd, h, true);
    col = fogMix(col, rd, t);
  } else {
    col = skyCol(rd);
  }
  return col + gGlow * U.fx.x;
}

struct VOut { @builtin(position) pos: vec4f };

@vertex fn vsFull(@builtin(vertex_index) i: u32) -> VOut {
  let q = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.pos = vec4f(q * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

@fragment fn fsScene(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = fc.xy + U.jit.xy;
  let uv = (px - 0.5 * U.res.xy - vec2f(U.camRight.w, U.camUp.w)) / U.res.y;
  let rd = normalize(U.camFwd.xyz + (uv.x * U.camRight.xyz - uv.y * U.camUp.xyz) * 2.0 * U.camPos.w);
  var col = render(U.camPos.xyz, rd);
  col = select(col, vec3f(0.0), col != col);
  col = clamp(col, vec3f(0.0), vec3f(48.0));
  let prev = textureLoad(prevTex, vec2i(fc.xy), 0);
  // Alpha carries hit distance for depth-aware particles.
  return mix(prev, vec4f(col, gHitT), U.fx.w);
}
`;

const FULLSCREEN_UV = /* wgsl */ `
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> VOut {
  let q = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.pos = vec4f(q * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(q.x, 1.0 - q.y);
  return o;
}
`;

export const BLOOM_DOWN = /* wgsl */ `
${FULLSCREEN_UV}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
fn s(uv: vec2f) -> vec3f { return textureSampleLevel(src, samp, uv, 0.0).rgb; }
@fragment fn fsDown(v: VOut) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  let uv = v.uv;
  let a = s(uv + t * vec2f(-2.0, 2.0)); let b = s(uv + t * vec2f(0.0, 2.0)); let c = s(uv + t * vec2f(2.0, 2.0));
  let d = s(uv + t * vec2f(-2.0, 0.0)); let e = s(uv);                       let f = s(uv + t * vec2f(2.0, 0.0));
  let g = s(uv + t * vec2f(-2.0, -2.0)); let h = s(uv + t * vec2f(0.0, -2.0)); let i = s(uv + t * vec2f(2.0, -2.0));
  let j = s(uv + t * vec2f(-1.0, 1.0)); let k = s(uv + t * vec2f(1.0, 1.0));
  let l = s(uv + t * vec2f(-1.0, -1.0)); let m = s(uv + t * vec2f(1.0, -1.0));
  let o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  return vec4f(o, 1.0);
}
`;

export const BLOOM_UP = /* wgsl */ `
${FULLSCREEN_UV}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
fn s(uv: vec2f) -> vec3f { return textureSampleLevel(src, samp, uv, 0.0).rgb; }
@fragment fn fsUp(v: VOut) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  let uv = v.uv;
  var o = s(uv) * 4.0;
  o += (s(uv + vec2f(t.x, 0.0)) + s(uv - vec2f(t.x, 0.0)) + s(uv + vec2f(0.0, t.y)) + s(uv - vec2f(0.0, t.y))) * 2.0;
  o += s(uv + t) + s(uv - t) + s(uv + vec2f(t.x, -t.y)) + s(uv + vec2f(-t.x, t.y));
  return vec4f(o / 16.0, 1.0);
}
`;

export const COMPOSITE = /* wgsl */ `
${FULLSCREEN_UV}
struct Post {
  a: vec4f, // exposure (stops), bloom, vignette, grain
  b: vec4f, // aberration, time, bloomLevels, unused
  c: vec4f, // flash, glitch, letterbox, hue shift
  d: vec4f, // sun uv, rays, look
  e: vec4f, // outline, scanlines, pixelate, sun visible
};
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var bloomTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> P: Post;

fn hueRotate(c: vec3f, a: f32) -> vec3f {
  let k = vec3f(0.57735);
  let ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}

// AgX tone mapping (Troy Sobotka's AgX, polynomial fit by Benjamin Wrensch).
fn agxContrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
fn agx(c: vec3f) -> vec3f {
  let m = mat3x3f(
    vec3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051),
    vec3f(0.0784335999999992, 0.878468636469772, 0.0784336),
    vec3f(0.0792237451477643, 0.0791661274605434, 0.879142973793104));
  let minEv = -12.47393;
  let maxEv = 4.026069;
  var v = m * c;
  v = clamp(log2(max(v, vec3f(1e-10))), vec3f(minEv), vec3f(maxEv));
  v = (v - minEv) / (maxEv - minEv);
  return agxContrast(v);
}
fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn ironbow(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0);
  return clamp(vec3f(
    smoothstep(0.15, 0.55, x) + smoothstep(0.85, 1.0, x) * 0.2,
    smoothstep(0.45, 0.9, x),
    smoothstep(0.0, 0.25, x) * (1.0 - smoothstep(0.3, 0.55, x)) * 0.7 + smoothstep(0.85, 1.0, x)), vec3f(0.0), vec3f(1.0));
}

fn grade(c: vec3f, look: i32, uv: vec2f, t: f32) -> vec3f {
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  if (look == 1) { // black mirror: cold monochrome, red signal in the highlights
    let m = vec3f(pow(l, 1.25)) * vec3f(0.92, 0.96, 1.0);
    return mix(m, vec3f(1.0, 0.07, 0.05) * (0.4 + l), smoothstep(0.6, 0.95, l) * 0.85);
  }
  if (look == 2) { return ironbow(pow(l, 0.8)); } // thermal
  if (look == 3) { // night vision
    let n = hash12(uv * 931.0 + t * 37.0) * 0.18;
    return vec3f(0.12, 1.0, 0.3) * pow(clamp(l * 1.5 + n, 0.0, 1.0), 0.85);
  }
  if (look == 4) { // bleach bypass: crushed, cold, desaturated
    var b = mix(vec3f(l), c, 0.32);
    b = clamp((b - 0.5) * 1.3 + 0.48, vec3f(0.0), vec3f(1.0));
    return b * vec3f(0.9, 1.0, 1.06);
  }
  if (look == 5) { return vec3f(1.0 - l) * vec3f(0.72, 0.93, 1.0); } // x-ray
  return c;
}

@fragment fn fsComposite(v: VOut) -> @location(0) vec4f {
  var uv = v.uv;
  let resF = vec2f(textureDimensions(hdr));
  if (P.e.z > 1.0) { uv = (floor(uv * resF / P.e.z) + 0.5) * P.e.z / resF; }
  let gl = P.c.y;
  var glitchShift = 0.0;
  if (gl > 0.0) {
    // Block tearing: horizontal bands jump sideways, RGB splits apart.
    let tt = floor(P.b.y * 24.0);
    let band = floor(uv.y * mix(6.0, 40.0, hash12(vec2f(tt, 1.0))));
    let r = hash12(vec2f(band, tt));
    if (r < gl * 0.45) { uv.x = fract(uv.x + (hash12(vec2f(band, tt + 7.0)) - 0.5) * 0.25 * gl); }
    let blk = floor(uv * vec2f(16.0, 9.0));
    if (hash12(blk + tt) < gl * 0.08) { uv = (blk + 0.5) / vec2f(16.0, 9.0); }
    glitchShift = gl * 0.02 * (hash12(vec2f(tt, 3.0)) - 0.5);
  }
  let c = uv - 0.5;
  let ab = P.b.x * 0.012 * c * length(c) + vec2f(glitchShift, 0.0);
  var col = vec3f(
    textureSampleLevel(hdr, samp, uv - ab, 0.0).r,
    textureSampleLevel(hdr, samp, uv, 0.0).g,
    textureSampleLevel(hdr, samp, uv + ab, 0.0).b);
  let bl = textureSampleLevel(bloomTex, samp, uv, 0.0).rgb / max(P.b.z, 1.0);
  col = mix(col, bl, clamp(P.a.y, 0.0, 1.0));
  // Screen-space god rays from the sun, masked to sky pixels (alpha = hit distance).
  if (P.d.z > 0.0 && P.e.w > 0.5) {
    var acc = vec3f(0.0);
    var wgt = 1.0;
    let delta = (uv - P.d.xy) / 48.0 * 0.95;
    var suv = uv;
    for (var i = 0; i < 48; i++) {
      suv -= delta;
      let sm = textureSampleLevel(hdr, samp, suv, 0.0);
      acc += sm.rgb * step(500.0, sm.a) * wgt;
      wgt *= 0.965;
    }
    col += acc / 48.0 * P.d.z;
  }
  col *= exp2(P.a.x);
  col += vec3f(P.c.x) * (1.0 + bl * 2.0);
  if (P.c.w != 0.0) { col = max(hueRotate(col, P.c.w * 6.2831853), vec3f(0.0)); }
  col = agx(col);
  let lum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
  col = mix(vec3f(lum), col, 1.15);
  // Depth outlines: tactical wireframe edges.
  if (P.e.x > 0.0) {
    let pc = vec2i(uv * resF);
    let dc = textureLoad(hdr, pc, 0).a;
    let dl = textureLoad(hdr, pc + vec2i(-1, 0), 0).a;
    let dr = textureLoad(hdr, pc + vec2i(1, 0), 0).a;
    let du = textureLoad(hdr, pc + vec2i(0, -1), 0).a;
    let dd = textureLoad(hdr, pc + vec2i(0, 1), 0).a;
    let lap = abs(dl + dr + du + dd - 4.0 * dc) / max(min(dc, 200.0), 0.05);
    let edge = smoothstep(0.02, 0.12, lap);
    col *= mix(1.0, 0.12, clamp(P.e.x - 1.0, 0.0, 1.0));
    col = mix(col, vec3f(1.0), edge * min(P.e.x, 1.0));
  }
  col = grade(col, i32(P.d.w), uv, P.b.y);
  col *= clamp(1.0 - P.a.z * dot(c, c) * 2.4, 0.0, 1.0);
  let res = vec2f(textureDimensions(hdr));
  let g = hash12(uv * res + fract(P.b.y * 7.13) * 911.0) - 0.5;
  col += g * P.a.w;
  if (gl > 0.0) { col *= 0.9 + 0.1 * sin(v.uv.y * res.y * 1.5); }
  if (P.e.y > 0.0) {
    // CRT: line mask plus a slow rolling bar.
    col *= 1.0 - P.e.y * 0.45 * (0.5 + 0.5 * sin(v.uv.y * res.y * 3.14159));
    col += P.e.y * 0.05 * smoothstep(0.0, 0.08, 0.08 - abs(fract(v.uv.y - P.b.y * 0.12) - 0.5));
  }
  // Cinematic bars (2.39:1 at full strength).
  let aspect = res.x / res.y;
  let barH = clamp(0.5 - aspect / (2.0 * 2.39), 0.0, 0.5) * P.c.z;
  if (v.uv.y < barH || v.uv.y > 1.0 - barH) { col = vec3f(0.0); }
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

export function buildSceneShader(generated: string): string {
  return `${SCENE_PRELUDE}\n// ===== generated from node graph =====\n${generated}\n// ===== renderer =====\n${SCENE_MAIN}`;
}

// ---------------------------------------------------------------- particles
const PARTICLE_COMMON = /* wgsl */ `
struct Particle { pos: vec4f, vel: vec4f, col: vec4f }; // pos.w = age, vel.w = lifetime, col = rgb + speed
struct PU {
  a: vec4f, // count, dt, time, seed
  b: vec4f, // size, speed, turbulence, cling
  c: vec4f, // life, spread, emitter, intensity
  d: vec4f, // color rgb, gravity
  e: vec4f, // color2 rgb, reset
  f: vec4f, // streak, trails, vortex, attract
  g: vec4f, // colorMode, unused...
};
`;

export const PARTICLE_COMPUTE = /* wgsl */ `
${PARTICLE_COMMON}
@group(1) @binding(0) var<storage, read_write> parts: array<Particle>;
@group(1) @binding(1) var<uniform> PP: PU;

fn pD(p: vec3f) -> f32 { return particleMap(p).d; }
fn rnd(i: u32, s: u32) -> vec3f {
  let h = pcg3(vec3u(i, s, i ^ (s * 747796405u)));
  return vec3f(h) / 4294967295.0;
}
fn sdfGrad(p: vec3f) -> vec3f {
  let e = 0.002;
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * pD(p + k.xyy * e) + k.yyx * pD(p + k.yyx * e) +
                   k.yxy * pD(p + k.yxy * e) + k.xxx * pD(p + k.xxx * e) + vec3f(1e-7));
}
fn potential(p: vec3f) -> vec3f {
  return vec3f(gnoise(p), gnoise(p + vec3f(31.4, 12.7, 5.3)), gnoise(p + vec3f(-7.1, 44.2, 19.9)));
}
fn curlNoise(p: vec3f) -> vec3f {
  let e = 0.08;
  let dx = vec3f(e, 0.0, 0.0);
  let dy = vec3f(0.0, e, 0.0);
  let dz = vec3f(0.0, 0.0, e);
  let x = potential(p + dx) - potential(p - dx);
  let y = potential(p + dy) - potential(p - dy);
  let z = potential(p + dz) - potential(p - dz);
  return vec3f(y.z - z.y, z.x - x.z, x.y - y.x) / (2.0 * e);
}

fn spawn(i: u32, salt: u32) -> Particle {
  let r = rnd(i, salt);
  let r2 = rnd(i, salt + 101u);
  let spread = PP.c.y;
  let em = i32(PP.c.z);
  let dir = normalize(r2 * 2.0 - 1.0 + vec3f(1e-4));
  var pos = dir * spread * pow(r.x, 0.333);
  var vel = vec3f(0.0);
  if (em == 0) {
    pos = (r * 2.0 - 1.0) * spread;
    for (var k = 0; k < 8; k++) {
      let d = pD(pos);
      pos -= sdfGrad(pos) * d;
    }
  } else if (em == 2) {
    let a = r.x * 6.2831853;
    pos = vec3f(cos(a) * spread, (r.y - 0.5) * 0.05 * spread, sin(a) * spread);
  } else if (em == 3) {
    pos = dir * 0.05;
    vel = dir * PP.b.y * 4.0 * (0.4 + r.z);
  } else if (em == 4) {
    pos = vec3f((r.x * 2.0 - 1.0) * spread, spread, (r.z * 2.0 - 1.0) * spread);
    vel = vec3f(0.0, -PP.b.y, 0.0);
  }
  return Particle(vec4f(pos, 0.0), vec4f(vel, PP.c.x * (0.5 + r.z)), vec4f(PP.d.rgb, 0.0));
}

fn shadeParticle(pt: Particle, sd: Sd) -> vec4f {
  let u = clamp(pt.pos.w / max(pt.vel.w, 1e-3), 0.0, 1.0);
  let spd = length(pt.vel.xyz);
  let mode = i32(PP.g.x);
  var c = mix(PP.d.rgb, PP.e.rgb, u);
  if (mode == 1) {
    c = mix(PP.d.rgb, PP.e.rgb, clamp(spd / max(PP.b.y * 2.0, 1e-3), 0.0, 1.0));
  } else if (mode == 2) {
    c = max(sd.col, vec3f(0.0)) * (1.0 + sd.mat.z * 0.5);
  } else if (mode == 3) {
    let k = dot(pt.pos.xyz, vec3f(0.11, 0.17, 0.07)) + spd * 0.25 + PP.a.z * 0.03 + u * 0.3;
    c = 0.5 + 0.5 * cos(6.2831853 * (vec3f(k) + vec3f(0.0, 0.33, 0.67)));
    c = c * c * 1.4;
  }
  return vec4f(c, spd);
}

@compute @workgroup_size(256)
fn csParticles(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(PP.a.x)) { return; }
  var pt = parts[i];
  let dt = PP.a.y;
  let em = i32(PP.c.z);
  if (PP.e.w > 0.5) {
    pt = spawn(i, u32(PP.a.w));
    let r = rnd(i, 999u);
    if (em != 3) { pt.pos.w = -r.x * pt.vel.w; }
    pt.col = shadeParticle(pt, particleMap(pt.pos.xyz));
    parts[i] = pt;
    return;
  }
  if (dt <= 0.0) { return; }
  pt.pos.w += dt;
  if (pt.pos.w < 0.0) { parts[i] = pt; return; }
  if (pt.pos.w > pt.vel.w) {
    let born = pt.pos.w - pt.vel.w;
    pt = spawn(i, u32(PP.a.w) + u32(PP.a.z * 37.0) + i % 7u);
    pt.pos.w = born;
    pt.col = shadeParticle(pt, particleMap(pt.pos.xyz));
    parts[i] = pt;
    return;
  }
  var p = pt.pos.xyz;
  var v = pt.vel.xyz;
  var flow = curlNoise(p * 0.55 + vec3f(0.0, PP.a.z * 0.07, 0.0)) * PP.b.z * PP.b.y;
  // Vortex around the vertical axis and a soft attractor to the origin.
  let rxz = vec2f(p.x, p.z);
  flow += vec3f(-rxz.y, 0.0, rxz.x) / max(length(rxz), 0.2) * PP.f.z;
  flow -= p / max(length(p), 0.2) * PP.f.w;
  v = mix(v, flow, 1.0 - exp(-dt * 1.8));
  v.y -= PP.d.w * dt;
  let cl = PP.b.w;
  var sd = particleMap(p);
  if (cl > 0.0 && abs(sd.d) < 2.5) {
    let n = sdfGrad(p);
    v -= n * dot(v, n) * cl;
    p -= n * sd.d * min(1.0, cl * dt * 10.0);
  }
  p += v * dt;
  sd = particleMap(p);
  if (sd.d < 0.0) {
    let n = sdfGrad(p);
    p -= n * sd.d;
    v = reflect(v, n) * 0.4;
  }
  pt.pos = vec4f(p, pt.pos.w);
  pt.vel = vec4f(v, pt.vel.w);
  pt.col = shadeParticle(pt, sd);
  parts[i] = pt;
}
`;

export const PARTICLE_RENDER = /* wgsl */ `
${SCENE_PRELUDE}
${PARTICLE_COMMON}
@group(1) @binding(0) var<storage, read> partsR: array<Particle>;
@group(1) @binding(1) var<uniform> PP: PU;
@group(1) @binding(2) var depthTex: texture_2d<f32>;

struct PVOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) col: vec3f,
  @location(2) depth: f32,
  @location(3) segLen: f32,
};

fn project(w: vec3f) -> vec3f {
  let rel = w - U.camPos.xyz;
  let z = dot(rel, U.camFwd.xyz);
  let th = U.camPos.w;
  let aspect = U.res.x / U.res.y;
  let xy = vec2f(dot(rel, U.camRight.xyz) / (z * th * aspect), dot(rel, U.camUp.xyz) / (z * th))
         + vec2f(2.0 * U.camRight.w / U.res.x, -2.0 * U.camUp.w / U.res.y);
  return vec3f(xy, z);
}

@vertex fn vsPart(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> PVOut {
  var o: PVOut;
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
  let pt = partsR[ii];
  let age = pt.pos.w;
  let life = pt.vel.w;
  if (age < 0.0 || age > life) { return o; }
  let a = project(pt.pos.xyz);
  if (a.z < 0.05) { return o; }
  let aspect = U.res.x / U.res.y;
  let asp = vec2f(aspect, 1.0);
  let sizeNdc = PP.b.x / (a.z * U.camPos.w);
  let s = max(sizeNdc, 1.6 / U.res.y);
  var energy = (sizeNdc * sizeNdc) / (s * s);

  // Streak: stretch the sprite along its screen-space motion (aspect-corrected space).
  var axis = vec2f(0.0, 1.0);
  var len = 0.0;
  if (PP.f.x > 0.0) {
    let b = project(pt.pos.xyz - pt.vel.xyz * PP.f.x);
    if (b.z > 0.05) {
      let d = (a.xy - b.xy) * asp;
      len = min(length(d) * 0.5, 0.5);
      if (len > 1e-5) { axis = normalize(d); }
    }
  }
  let side = vec2f(-axis.y, axis.x);
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let cn = corners[vi];
  let center = a.xy - axis * len / asp;
  let offs = (axis * cn.y * (s + len) + side * cn.x * s) / asp;
  o.pos = vec4f(center + offs, 0.5, 1.0);
  o.uv = vec2f(cn.x, cn.y * (s + len) / s);
  o.segLen = len / s;
  energy = energy * s / (s + len);
  let u = age / life;
  let fade = smoothstep(0.0, 0.12, u) * (1.0 - smoothstep(0.55, 1.0, u));
  o.col = pt.col.rgb * PP.c.w * fade * max(energy, 0.08) * mix(1.0, 1.0 - PP.f.y, 0.75);
  o.depth = length(pt.pos.xyz - U.camPos.xyz);
  return o;
}

@fragment fn fsPart(v: PVOut) -> @location(0) vec4f {
  // Capsule falloff: round across, flat along the streak.
  let dy = max(abs(v.uv.y) - v.segLen, 0.0);
  let r2 = v.uv.x * v.uv.x + dy * dy;
  if (r2 > 1.0) { discard; }
  let sceneT = textureLoad(depthTex, vec2i(v.pos.xy), 0).a;
  let occl = 1.0 - smoothstep(sceneT - 0.02, sceneT + 0.05, v.depth);
  if (occl <= 0.0) { discard; }
  return vec4f(v.col * exp(-r2 * 3.5) * occl, 1.0);
}
`;

export const FADE = /* wgsl */ `
@group(0) @binding(0) var prevFx: texture_2d<f32>;
struct FU { k: vec4f };
@group(0) @binding(1) var<uniform> F: FU;
struct VOut { @builtin(position) pos: vec4f };
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> VOut {
  let q = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.pos = vec4f(q * 2.0 - 1.0, 0.0, 1.0);
  return o;
}
@fragment fn fsFade(v: VOut) -> @location(0) vec4f {
  return vec4f(textureLoad(prevFx, vec2i(v.pos.xy), 0).rgb * F.k.x, 1.0);
}
`;

export const COMBINE = /* wgsl */ `
@group(0) @binding(0) var a: texture_2d<f32>;
@group(0) @binding(1) var b: texture_2d<f32>;
struct VOut { @builtin(position) pos: vec4f };
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> VOut {
  let q = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.pos = vec4f(q * 2.0 - 1.0, 0.0, 1.0);
  return o;
}
@fragment fn fsCombine(v: VOut) -> @location(0) vec4f {
  let p = vec2i(v.pos.xy);
  let s = textureLoad(a, p, 0);
  return vec4f(s.rgb + textureLoad(b, p, 0).rgb, s.a);
}
`;

export function buildParticleCompute(generated: string): string {
  return `${SCENE_PRELUDE}\n${generated}\n${SCENE_MAIN_NO_ENTRY()}\n${PARTICLE_COMPUTE}`;
}

/** Scene helper functions (mapD etc.) without the fragment/vertex entry points. */
function SCENE_MAIN_NO_ENTRY(): string {
  return SCENE_MAIN.slice(0, SCENE_MAIN.indexOf('struct VOut'));
}
