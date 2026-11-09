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

fn render(ro: vec3f, rd: vec3f) -> vec3f {
  gGlow = vec3f(0.0);
  let t = march(ro, rd, 80.0, i32(U.jit.w), U.fx.x > 0.0);
  var col: vec3f;
  if (t > 0.0) {
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
  let uv = (px - 0.5 * U.res.xy) / U.res.y;
  let rd = normalize(U.camFwd.xyz + (uv.x * U.camRight.xyz - uv.y * U.camUp.xyz) * 2.0 * U.camPos.w);
  var col = render(U.camPos.xyz, rd);
  col = select(col, vec3f(0.0), col != col);
  col = clamp(col, vec3f(0.0), vec3f(48.0));
  let prev = textureLoad(prevTex, vec2i(fc.xy), 0).rgb;
  return vec4f(mix(prev, col, U.fx.w), 1.0);
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
};
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var bloomTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> P: Post;

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

@fragment fn fsComposite(v: VOut) -> @location(0) vec4f {
  let uv = v.uv;
  let c = uv - 0.5;
  let ab = P.b.x * 0.012 * c * length(c);
  var col = vec3f(
    textureSampleLevel(hdr, samp, uv - ab, 0.0).r,
    textureSampleLevel(hdr, samp, uv, 0.0).g,
    textureSampleLevel(hdr, samp, uv + ab, 0.0).b);
  let bl = textureSampleLevel(bloomTex, samp, uv, 0.0).rgb / max(P.b.z, 1.0);
  col = mix(col, bl, clamp(P.a.y, 0.0, 1.0));
  col *= exp2(P.a.x);
  col = agx(col);
  let lum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
  col = mix(vec3f(lum), col, 1.15);
  col *= clamp(1.0 - P.a.z * dot(c, c) * 2.4, 0.0, 1.0);
  let res = vec2f(textureDimensions(hdr));
  let g = hash12(uv * res + fract(P.b.y * 7.13) * 911.0) - 0.5;
  col += g * P.a.w;
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

export function buildSceneShader(generated: string): string {
  return `${SCENE_PRELUDE}\n// ===== generated from node graph =====\n${generated}\n// ===== renderer =====\n${SCENE_MAIN}`;
}
