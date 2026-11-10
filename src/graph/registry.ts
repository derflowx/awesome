import type { CameraValue, CpuValue, Keyframe, SocketType, Vec3 } from './types';
import { BANDS, sampleAudio, type Band } from '../audio/analysis';

/** Fonts available to Text nodes (loaded from Google Fonts in index.html). */
export const FONTS: Record<string, string> = {
  display: '800 150px "Unbounded"',
  grotesk: '700 150px "Space Grotesk"',
  serif: 'italic 400 150px "Instrument Serif"',
  condensed: '400 150px "Bebas Neue"',
  mono: '700 150px "JetBrains Mono"',
  sans: '800 150px "Inter"',
  script: '400 150px "Pacifico"',
  tactical: '400 150px "Black Ops One"',
  wide: '400 150px "Michroma"',
  terminal: '400 150px "Share Tech Mono"',
};

export interface InputDef {
  name: string;
  label?: string;
  type: SocketType;
  default?: CpuValue;
  min?: number;
  max?: number;
  step?: number;
}

export type ParamDef =
  | { name: string; label?: string; kind: 'enum'; options: string[]; default: string }
  | { name: string; label?: string; kind: 'keys'; default: Keyframe[] }
  | { name: string; label?: string; kind: 'text'; default: string };

export interface CpuCtx {
  t: number;
  dt: number;
  /** Per-node persistent state (for springs etc). Cleared on reset. */
  state: Record<string, number>;
  reset: boolean;
  params: Record<string, unknown>;
}

export interface GpuCtx {
  /** WGSL expression for an input, evaluated at position variable `at` (default `p`). */
  in(name: string, at?: string): string;
  param<T = string>(name: string): T;
  /** A vec4 uniform holding node-internal data supplied by the app (e.g. text atlas rect). */
  data(name: string): string;
  /** Whether an input socket has a wire. */
  connected(name: string): boolean;
}

export type Domain = 'cpu' | 'gpu' | 'any';

export interface NodeDef {
  type: string;
  title: string;
  category: Category;
  description: string;
  inputs: InputDef[];
  output: SocketType | null;
  params?: ParamDef[];
  domain: Domain;
  /** Stateful nodes need deterministic re-simulation when scrubbing. */
  stateful?: boolean;
  cpu?: (inp: Record<string, CpuValue>, ctx: CpuCtx) => CpuValue;
  /** Body of `fn nID(p: vec3f) -> T`. Must end with a return statement. */
  gpu?: (g: GpuCtx) => string;
}

export type Category = 'Signal' | 'Math' | 'Field' | 'Shape' | 'Combine' | 'Deform' | 'Material' | 'Camera' | 'FX' | 'Output';

export const CATEGORY_COLORS: Record<Category, string> = {
  Signal: '#ff9f43',
  Math: '#9aa4ff',
  Field: '#c56cff',
  Shape: '#3cf2c4',
  Combine: '#2ec8ff',
  Deform: '#ff5e8a',
  Material: '#ffd166',
  Camera: '#b8f2ff',
  FX: '#ffb347',
  Output: '#ffffff',
};

// ---------- small CPU helpers ----------
const n = (v: CpuValue | undefined): number => (typeof v === 'number' ? v : Array.isArray(v) ? v[0] : 0);
const v3 = (v: CpuValue | undefined): Vec3 => (typeof v === 'number' ? [v, v, v] : Array.isArray(v) ? v : [0, 0, 0]);
const TAU = Math.PI * 2;
const fract = (x: number) => x - Math.floor(x);
const smooth = (x: number) => x * x * (3 - 2 * x);
const hash1 = (i: number, seed: number) => fract(Math.sin(i * 127.1 + seed * 311.7) * 43758.5453);
function valueNoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  return (hash1(i, seed) * (1 - smooth(f)) + hash1(i + 1, seed) * smooth(f)) * 2 - 1;
}

export const PALETTES: Record<string, [Vec3, Vec3, Vec3, Vec3]> = {
  rainbow: [[0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [1, 1, 1], [0, 0.33, 0.67]],
  sunset: [[0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [1, 1, 0.5], [0.8, 0.9, 0.3]],
  neon: [[0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [2, 1, 0], [0.5, 0.2, 0.25]],
  ice: [[0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [1, 0.7, 0.4], [0, 0.15, 0.2]],
  acid: [[0.8, 0.5, 0.4], [0.2, 0.4, 0.2], [2, 1, 1], [0, 0.25, 0.25]],
  chrome: [[0.55, 0.55, 0.6], [0.45, 0.45, 0.45], [1, 1, 1], [0, 0.05, 0.1]],
};

const wgslVec = (v: Vec3) => `vec3f(${v.map((x) => x.toFixed(4)).join(', ')})`;

export function sampleKeys(keys: Keyframe[], t: number, interp: string, loop: string): number {
  if (!keys.length) return 0;
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const t0 = sorted[0].t;
  const t1 = sorted[sorted.length - 1].t;
  const span = t1 - t0;
  if (span > 0 && loop !== 'once') {
    let u = (t - t0) / span;
    if (loop === 'loop') u = fract(u);
    else u = 1 - Math.abs(1 - 2 * fract(u * 0.5));
    t = t0 + u * span;
  }
  if (t <= t0) return sorted[0].v;
  if (t >= t1) return sorted[sorted.length - 1].v;
  let i = 0;
  while (i < sorted.length - 1 && sorted[i + 1].t < t) i++;
  const a = sorted[i];
  const b = sorted[i + 1];
  const u = (t - a.t) / Math.max(b.t - a.t, 1e-6);
  if (interp === 'step') return a.v;
  if (interp === 'linear') return a.v + (b.v - a.v) * u;
  if (interp === 'expo') {
    const e = u < 0.5 ? Math.pow(2, 20 * u - 10) / 2 : (2 - Math.pow(2, -20 * u + 10)) / 2;
    return a.v + (b.v - a.v) * e;
  }
  if (interp === 'back') {
    const c1 = 1.70158 * 1.525;
    const e =
      u < 0.5
        ? (Math.pow(2 * u, 2) * ((c1 + 1) * 2 * u - c1)) / 2
        : (Math.pow(2 * u - 2, 2) * ((c1 + 1) * (u * 2 - 2) + c1) + 2) / 2;
    return a.v + (b.v - a.v) * e;
  }
  // smooth: catmull-rom through neighbours
  const p0 = sorted[i - 1]?.v ?? a.v;
  const p3 = sorted[i + 2]?.v ?? b.v;
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * a.v + (-p0 + b.v) * u + (2 * p0 - 5 * a.v + 4 * b.v - p3) * u2 + (-p0 + 3 * a.v - 3 * b.v + p3) * u3);
}

const MATH_OPS = ['add', 'subtract', 'multiply', 'divide', 'power', 'min', 'max', 'modulo', 'sin', 'cos', 'abs', 'fract', 'smoothstep'];
function mathCpu(op: string, a: number, b: number): number {
  switch (op) {
    case 'add': return a + b;
    case 'subtract': return a - b;
    case 'multiply': return a * b;
    case 'divide': return a / (Math.abs(b) < 1e-6 ? 1e-6 : b);
    case 'power': return Math.pow(Math.abs(a), b);
    case 'min': return Math.min(a, b);
    case 'max': return Math.max(a, b);
    case 'modulo': return a - (b || 1) * Math.floor(a / (b || 1));
    case 'sin': return Math.sin(a * b);
    case 'cos': return Math.cos(a * b);
    case 'abs': return Math.abs(a);
    case 'fract': return fract(a);
    case 'smoothstep': { const x = Math.min(Math.max(a / (b || 1), 0), 1); return smooth(x); }
  }
  return 0;
}
function mathGpu(op: string, a: string, b: string): string {
  switch (op) {
    case 'add': return `${a} + ${b}`;
    case 'subtract': return `${a} - ${b}`;
    case 'multiply': return `${a} * ${b}`;
    case 'divide': return `${a} / safeDiv(${b})`;
    case 'power': return `pow(abs(${a}), ${b})`;
    case 'min': return `min(${a}, ${b})`;
    case 'max': return `max(${a}, ${b})`;
    case 'modulo': return `modf1(${a}, ${b})`;
    case 'sin': return `sin(${a} * ${b})`;
    case 'cos': return `cos(${a} * ${b})`;
    case 'abs': return `abs(${a})`;
    case 'fract': return `fract(${a})`;
    case 'smoothstep': return `smoothstep(0.0, 1.0, ${a} / safeDiv(${b}))`;
  }
  return '0.0';
}

const LFO_WAVES = ['sine', 'triangle', 'saw', 'square', 'bounce'];
export const LOOKS = ['cinematic', 'black mirror', 'thermal', 'night vision', 'bleach', 'x-ray'];

// ---------- automatic camera ----------
export const CAM_MODES = ['orbit', 'push-in', 'crane', 'flyby', 'spiral', 'top-down', 'vertigo'];
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
interface Pose { pos: Vec3; target: Vec3; fov: number; roll: number }

function shotPose(mode: string, u: number, k: number, t: number, i: Record<string, CpuValue>): Pose {
  const tgt = [...v3(i.target)] as Vec3; // copy: poses are mutated by shake
  const dist = n(i.distance), h = n(i.height), fov = n(i.fov), spd = n(i.speed), seed = n(i.seed);
  const r1 = hash1(k * 3.1 + 1, seed), r2 = hash1(k * 7.7 + 2, seed);
  // Shots are picked within an arc around the front (+z); 360 = anywhere.
  const arc = (Math.min(360, Math.max(0, n(i.arc ?? 360))) * Math.PI) / 180;
  const base = (r1 - 0.5) * arc;
  const at = (a: number, d: number, y: number): Vec3 => [tgt[0] + Math.sin(a) * d, tgt[1] + y, tgt[2] + Math.cos(a) * d];
  const e = easeInOut(Math.min(1, Math.max(0, u)));
  switch (mode) {
    case 'push-in':
      return { pos: at(base + u * 0.25 * spd, dist * (1.55 - 0.85 * e), h * 0.5), target: tgt, fov, roll: 0 };
    case 'crane':
      return { pos: at(base + u * 0.5 * spd, dist * 0.95, -0.6 + e * dist * 0.85), target: tgt, fov, roll: 0 };
    case 'flyby': {
      const along = (u - 0.5) * 2 * dist * 1.1 * spd;
      const fwd: Vec3 = [Math.sin(base), 0, Math.cos(base)];
      const side: Vec3 = [Math.cos(base), 0, -Math.sin(base)];
      const pos = [0, 1, 2].map((c) => tgt[c] + fwd[c] * dist * 0.75 + side[c] * along) as Vec3;
      pos[1] += h * 0.4;
      return { pos, target: tgt, fov, roll: (u - 0.5) * 0.25 };
    }
    case 'spiral':
      return { pos: at(base + u * TAU * 0.6 * spd, dist * (1.35 - 0.55 * e), h + (1 - e) * dist * 0.7), target: tgt, fov, roll: 0 };
    case 'top-down':
      return { pos: at(base + u * spd, dist * 0.3, dist * 1.05), target: tgt, fov, roll: u * 0.6 };
    case 'vertigo': {
      // Dolly zoom: move back while narrowing the lens so the subject keeps its size.
      const d0 = dist * 0.55, d = dist * (0.55 + 1.1 * e);
      const f = (2 * Math.atan((Math.tan((fov * Math.PI) / 360) * d0 * 1.6) / d) * 180) / Math.PI;
      return { pos: at(base, d, h * 0.3), target: tgt, fov: f, roll: 0 };
    }
    default: // orbit (ping-pongs inside the arc when it is limited)
      return { pos: at(arc >= TAU - 1e-3 ? base + t * 0.35 * spd : Math.sin(t * 0.35 * spd) * arc * 0.5, dist, h + Math.sin(t * 0.3) * 0.3), target: tgt, fov, roll: (r2 - 0.5) * 0.05 };
  }
}

function directorCamera(i: Record<string, CpuValue>, c: CpuCtx): CameraValue {
  const t = c.t;
  const shot = Math.max(0.25, n(i.shot));
  const seed = n(i.seed);
  const k = Math.floor(t / shot);
  const u = (t - k * shot) / shot;
  const pick = (kk: number) => {
    if (c.params.mode !== 'director') return String(c.params.mode);
    return CAM_MODES[Math.floor(hash1(kk * 13.7 + 5, seed) * CAM_MODES.length) % CAM_MODES.length];
  };
  const dutch = (kk: number) => (c.params.mode === 'director' ? (hash1(kk * 5.3 + 9, seed) - 0.5) * 0.35 : 0);
  let p = shotPose(pick(k), u, k, t, i);
  p.roll += dutch(k);
  const cut = String(c.params.cut);
  const blendLen = cut === 'whip' ? Math.min(0.3, shot * 0.3) : cut === 'smooth' ? Math.min(1.2, shot * 0.45) : 0;
  const into = shot - (t - k * shot); // seconds left in this shot
  if (blendLen > 0 && into < blendLen) {
    const w = easeInOut(1 - into / blendLen);
    const q = shotPose(pick(k + 1), 0, k + 1, t, i);
    q.roll += dutch(k + 1);
    const lerp = (a: number, b: number) => a + (b - a) * w;
    p = {
      pos: p.pos.map((x, j) => lerp(x, q.pos[j])) as Vec3,
      target: p.target.map((x, j) => lerp(x, q.target[j])) as Vec3,
      fov: lerp(p.fov, q.fov),
      roll: lerp(p.roll, q.roll) + (cut === 'whip' ? Math.sin(w * Math.PI) * 0.6 : 0),
    };
  }
  // Handheld shake: layered noise on position, aim and roll.
  const sh = n(i.shake);
  if (sh > 0) {
    const dist = n(i.distance);
    const wob = (o: number) => valueNoise(t * 1.3 + o, seed + o) * 0.6 + valueNoise(t * 3.1 + o, seed + o * 2) * 0.4;
    for (let a = 0; a < 3; a++) {
      p.pos[a] += wob(a * 11) * sh * 0.06 * dist;
      p.target[a] += wob(a * 23 + 5) * sh * 0.03 * dist;
    }
    p.roll += wob(71) * sh * 0.03;
  }
  return { kind: 'camera', pos: [...p.pos] as Vec3, target: [...p.target] as Vec3, fov: p.fov, roll: p.roll };
}

// ---------- definitions ----------
const defs: NodeDef[] = [
  // ===== Signals (CPU, animated) =====
  {
    type: 'time', title: 'Time', category: 'Signal', domain: 'cpu', output: 'float',
    description: 'Timeline time in seconds, scaled and offset.',
    inputs: [
      { name: 'speed', type: 'float', default: 1, step: 0.01 },
      { name: 'offset', type: 'float', default: 0, step: 0.01 },
    ],
    cpu: (i, c) => c.t * n(i.speed) + n(i.offset),
  },
  {
    type: 'lfo', title: 'LFO', category: 'Signal', domain: 'cpu', output: 'float',
    description: 'Low frequency oscillator: periodic waves.',
    params: [{ name: 'wave', kind: 'enum', options: LFO_WAVES, default: 'sine' }],
    inputs: [
      { name: 'freq', label: 'freq (Hz)', type: 'float', default: 0.5, min: 0, step: 0.01 },
      { name: 'amp', type: 'float', default: 1, step: 0.01 },
      { name: 'offset', type: 'float', default: 0, step: 0.01 },
      { name: 'phase', type: 'float', default: 0, step: 0.01 },
    ],
    cpu: (i, c) => {
      const ph = fract(c.t * n(i.freq) + n(i.phase));
      let w = 0;
      switch (c.params.wave) {
        case 'triangle': w = 1 - 4 * Math.abs(ph - 0.5); break;
        case 'saw': w = ph * 2 - 1; break;
        case 'square': w = ph < 0.5 ? 1 : -1; break;
        case 'bounce': w = Math.abs(Math.sin(ph * Math.PI)) * 2 - 1; break;
        default: w = Math.sin(ph * TAU);
      }
      return w * n(i.amp) + n(i.offset);
    },
  },
  {
    type: 'wiggle', title: 'Wiggle', category: 'Signal', domain: 'cpu', output: 'float',
    description: 'Smooth organic random motion (fractal noise over time).',
    inputs: [
      { name: 'speed', type: 'float', default: 1, step: 0.01 },
      { name: 'amp', type: 'float', default: 1, step: 0.01 },
      { name: 'offset', type: 'float', default: 0, step: 0.01 },
      { name: 'detail', type: 'float', default: 3, min: 1, max: 6, step: 1 },
      { name: 'seed', type: 'float', default: 1, step: 1 },
    ],
    cpu: (i, c) => {
      const oct = Math.max(1, Math.min(6, Math.round(n(i.detail))));
      let s = 0, a = 1, f = 1, norm = 0;
      for (let o = 0; o < oct; o++) {
        s += valueNoise(c.t * n(i.speed) * f + o * 17.3, n(i.seed) + o) * a;
        norm += a; a *= 0.5; f *= 2;
      }
      return (s / norm) * n(i.amp) + n(i.offset);
    },
  },
  {
    type: 'pulse', title: 'Pulse', category: 'Signal', domain: 'cpu', output: 'float',
    description: 'Rhythmic envelope: a sharp hit that decays, synced to BPM.',
    inputs: [
      { name: 'bpm', type: 'float', default: 120, min: 1, step: 1 },
      { name: 'decay', type: 'float', default: 6, min: 0, step: 0.1 },
      { name: 'amp', type: 'float', default: 1, step: 0.01 },
      { name: 'offset', type: 'float', default: 0, step: 0.01 },
    ],
    cpu: (i, c) => {
      const beat = 60 / Math.max(n(i.bpm), 1);
      const ph = (c.t % beat) / beat;
      return Math.exp(-ph * n(i.decay)) * n(i.amp) + n(i.offset);
    },
  },
  {
    type: 'spring', title: 'Spring', category: 'Signal', domain: 'cpu', output: 'float', stateful: true,
    description: 'Physically follows its target with inertia and overshoot. Wire anything into target.',
    inputs: [
      { name: 'target', type: 'float', default: 0, step: 0.01 },
      { name: 'stiffness', type: 'float', default: 120, min: 0, step: 1 },
      { name: 'damping', type: 'float', default: 8, min: 0, step: 0.1 },
    ],
    cpu: (i, c) => {
      const tgt = n(i.target);
      if (c.reset || c.state.x === undefined) { c.state.x = tgt; c.state.v = 0; return tgt; }
      const k = n(i.stiffness), d = n(i.damping);
      c.state.v += (k * (tgt - c.state.x) - d * c.state.v) * c.dt;
      c.state.x += c.state.v * c.dt;
      return c.state.x;
    },
  },
  {
    type: 'curve', title: 'Keyframes', category: 'Signal', domain: 'cpu', output: 'float',
    description: 'Hand-drawn animation curve. Click to add keys, drag to move, right-click to delete.',
    params: [
      { name: 'keys', kind: 'keys', default: [{ t: 0, v: 0 }, { t: 1.5, v: 1 }, { t: 3, v: 0 }] },
      { name: 'interp', kind: 'enum', options: ['smooth', 'linear', 'expo', 'back', 'step'], default: 'smooth' },
      { name: 'loop', kind: 'enum', options: ['loop', 'pingpong', 'once'], default: 'loop' },
    ],
    inputs: [
      { name: 'amp', type: 'float', default: 1, step: 0.01 },
      { name: 'offset', type: 'float', default: 0, step: 0.01 },
    ],
    cpu: (i, c) =>
      sampleKeys((c.params.keys as Keyframe[]) ?? [], c.t, String(c.params.interp), String(c.params.loop)) * n(i.amp) + n(i.offset),
  },

  // ===== Math (CPU or GPU, inferred) =====
  {
    type: 'value', title: 'Value', category: 'Math', domain: 'any', output: 'float',
    description: 'A constant number.',
    inputs: [{ name: 'value', type: 'float', default: 1, step: 0.01 }],
    cpu: (i) => n(i.value),
    gpu: (g) => `return ${g.in('value')};`,
  },
  {
    type: 'math', title: 'Math', category: 'Math', domain: 'any', output: 'float',
    description: 'Arithmetic on two numbers. Works on signals and on fields.',
    params: [{ name: 'op', kind: 'enum', options: MATH_OPS, default: 'multiply' }],
    inputs: [
      { name: 'a', type: 'float', default: 1, step: 0.01 },
      { name: 'b', type: 'float', default: 1, step: 0.01 },
    ],
    cpu: (i, c) => mathCpu(String(c.params.op), n(i.a), n(i.b)),
    gpu: (g) => `return ${mathGpu(g.param('op'), g.in('a'), g.in('b'))};`,
  },
  {
    type: 'remap', title: 'Remap', category: 'Math', domain: 'any', output: 'float',
    description: 'Map a range onto another range.',
    inputs: [
      { name: 'value', type: 'float', default: 0, step: 0.01 },
      { name: 'inMin', type: 'float', default: -1, step: 0.01 },
      { name: 'inMax', type: 'float', default: 1, step: 0.01 },
      { name: 'outMin', type: 'float', default: 0, step: 0.01 },
      { name: 'outMax', type: 'float', default: 1, step: 0.01 },
    ],
    cpu: (i) => {
      const u = (n(i.value) - n(i.inMin)) / (n(i.inMax) - n(i.inMin) || 1e-6);
      return n(i.outMin) + (n(i.outMax) - n(i.outMin)) * u;
    },
    gpu: (g) =>
      `let u = (${g.in('value')} - ${g.in('inMin')}) / safeDiv(${g.in('inMax')} - ${g.in('inMin')});\n  return mix(${g.in('outMin')}, ${g.in('outMax')}, u);`,
  },
  {
    type: 'vec3', title: 'Vector', category: 'Math', domain: 'any', output: 'vec3',
    description: 'Combine three numbers into a vector.',
    inputs: [
      { name: 'x', type: 'float', default: 0, step: 0.01 },
      { name: 'y', type: 'float', default: 0, step: 0.01 },
      { name: 'z', type: 'float', default: 0, step: 0.01 },
    ],
    cpu: (i) => [n(i.x), n(i.y), n(i.z)],
    gpu: (g) => `return vec3f(${g.in('x')}, ${g.in('y')}, ${g.in('z')});`,
  },
  {
    type: 'component', title: 'Component', category: 'Math', domain: 'any', output: 'float',
    description: 'Pick one axis out of a vector.',
    params: [{ name: 'axis', kind: 'enum', options: ['x', 'y', 'z', 'length'], default: 'y' }],
    inputs: [{ name: 'vector', type: 'vec3', default: [0, 0, 0] }],
    cpu: (i, c) => {
      const v = v3(i.vector);
      const a = c.params.axis;
      return a === 'x' ? v[0] : a === 'y' ? v[1] : a === 'z' ? v[2] : Math.hypot(...v);
    },
    gpu: (g) => {
      const a = g.param('axis');
      return a === 'length' ? `return length(${g.in('vector')});` : `return (${g.in('vector')}).${a};`;
    },
  },
  {
    type: 'color', title: 'Color', category: 'Math', domain: 'any', output: 'color',
    description: 'A color with HDR intensity (go above 1 for glowing light).',
    inputs: [
      { name: 'color', type: 'color', default: [1, 0.3, 0.6] },
      { name: 'intensity', type: 'float', default: 1, min: 0, step: 0.01 },
    ],
    cpu: (i) => v3(i.color).map((x) => x * n(i.intensity)) as Vec3,
    gpu: (g) => `return ${g.in('color')} * ${g.in('intensity')};`,
  },
  {
    type: 'palette', title: 'Palette', category: 'Math', domain: 'any', output: 'color',
    description: 'Cosine gradient palette. Feed it a field for psychedelic color.',
    params: [{ name: 'preset', kind: 'enum', options: Object.keys(PALETTES), default: 'rainbow' }],
    inputs: [
      { name: 't', type: 'float', default: 0, step: 0.01 },
      { name: 'shift', type: 'float', default: 0, step: 0.01 },
    ],
    cpu: (i, c) => {
      const [a, b, cc, d] = PALETTES[String(c.params.preset)] ?? PALETTES.rainbow;
      const t = n(i.t) + n(i.shift);
      return [0, 1, 2].map((k) => a[k] + b[k] * Math.cos(TAU * (cc[k] * t + d[k]))) as Vec3;
    },
    gpu: (g) => {
      const [a, b, c, d] = PALETTES[g.param('preset')] ?? PALETTES.rainbow;
      return `return ${wgslVec(a)} + ${wgslVec(b)} * cos(6.2831853 * (${wgslVec(c)} * (${g.in('t')} + ${g.in('shift')}) + ${wgslVec(d)}));`;
    },
  },
  {
    type: 'mixcolor', title: 'Mix Color', category: 'Math', domain: 'any', output: 'color',
    description: 'Blend between two colors.',
    inputs: [
      { name: 'a', type: 'color', default: [0.1, 0.2, 1] },
      { name: 'b', type: 'color', default: [1, 0.2, 0.5] },
      { name: 't', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01 },
    ],
    cpu: (i) => {
      const a = v3(i.a), b = v3(i.b), t = n(i.t);
      return [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * t) as Vec3;
    },
    gpu: (g) => `return mix(${g.in('a')}, ${g.in('b')}, clamp(${g.in('t')}, 0.0, 1.0));`,
  },

  // ===== Fields (GPU, depend on position) =====
  {
    type: 'position', title: 'Position', category: 'Field', domain: 'gpu', output: 'vec3',
    description: 'The 3D point being evaluated, in the local space of where it is used.',
    inputs: [],
    gpu: () => `return p;`,
  },
  {
    type: 'noisefield', title: 'Noise Field', category: 'Field', domain: 'gpu', output: 'float',
    description: '3D fractal gradient noise. Wire Time into evolve to make it flow.',
    inputs: [
      { name: 'scale', type: 'float', default: 1.5, step: 0.01 },
      { name: 'evolve', type: 'float', default: 0, step: 0.01 },
      { name: 'detail', type: 'float', default: 3, min: 1, max: 6, step: 1 },
    ],
    gpu: (g) => `let e = ${g.in('evolve')};\n  return fbm(p * ${g.in('scale')} + vec3f(e * 0.31, e, -e * 0.73), i32(${g.in('detail')}));`,
  },
  {
    type: 'wavefield', title: 'Wave Field', category: 'Field', domain: 'gpu', output: 'float',
    description: 'Ripples spreading through space.',
    params: [{ name: 'mode', kind: 'enum', options: ['radial', 'spherical', 'x', 'y', 'z'], default: 'radial' }],
    inputs: [
      { name: 'freq', type: 'float', default: 3, step: 0.01 },
      { name: 'phase', type: 'float', default: 0, step: 0.01 },
    ],
    gpu: (g) => {
      const m = g.param('mode');
      const coord = m === 'radial' ? 'length(p.xz)' : m === 'spherical' ? 'length(p)' : `p.${m}`;
      return `return sin(${coord} * ${g.in('freq')} - ${g.in('phase')});`;
    },
  },
  {
    type: 'distance', title: 'Distance', category: 'Field', domain: 'gpu', output: 'float',
    description: 'Distance from a point. Great for falloffs.',
    inputs: [{ name: 'center', type: 'vec3', default: [0, 0, 0], step: 0.01 }],
    gpu: (g) => `return length(p - ${g.in('center')});`,
  },

  // ===== Shapes =====
  {
    type: 'sphere', title: 'Sphere', category: 'Shape', domain: 'gpu', output: 'sdf',
    description: 'A perfect sphere.',
    inputs: [{ name: 'radius', type: 'float', default: 1, min: 0, step: 0.01 }],
    gpu: (g) => `return sdMat(length(p) - ${g.in('radius')});`,
  },
  {
    type: 'box', title: 'Box', category: 'Shape', domain: 'gpu', output: 'sdf',
    description: 'Rounded box.',
    inputs: [
      { name: 'size', type: 'vec3', default: [1, 1, 1], step: 0.01 },
      { name: 'round', type: 'float', default: 0.08, min: 0, step: 0.005 },
    ],
    gpu: (g) => `let r = ${g.in('round')};\n  let q = abs(p) - max(${g.in('size')} - vec3f(r), vec3f(0.0));\n  return sdMat(length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - r);`,
  },
  {
    type: 'torus', title: 'Torus', category: 'Shape', domain: 'gpu', output: 'sdf',
    description: 'A donut.',
    inputs: [
      { name: 'major', type: 'float', default: 1, min: 0, step: 0.01 },
      { name: 'minor', type: 'float', default: 0.3, min: 0, step: 0.01 },
    ],
    gpu: (g) => `let q = vec2f(length(p.xz) - ${g.in('major')}, p.y);\n  return sdMat(length(q) - ${g.in('minor')});`,
  },
  {
    type: 'octahedron', title: 'Octahedron', category: 'Shape', domain: 'gpu', output: 'sdf',
    description: 'A crystal-like diamond.',
    inputs: [{ name: 'size', type: 'float', default: 1, min: 0, step: 0.01 }],
    gpu: (g) => `let q = abs(p);\n  return sdMat((q.x + q.y + q.z - ${g.in('size')}) * 0.57735027);`,
  },
  {
    type: 'floor', title: 'Floor', category: 'Shape', domain: 'gpu', output: 'sdf',
    description: 'Infinite ground plane.',
    inputs: [{ name: 'height', type: 'float', default: -1, step: 0.01 }],
    gpu: (g) => `return sdMat(p.y - ${g.in('height')});`,
  },
  {
    type: 'gyroid', title: 'Gyroid', category: 'Shape', domain: 'gpu', output: 'sdf',
    description: 'Infinite minimal-surface lattice. Intersect it with a shape.',
    inputs: [
      { name: 'scale', type: 'float', default: 4, step: 0.01 },
      { name: 'thickness', type: 'float', default: 0.03, min: 0, step: 0.005 },
    ],
    gpu: (g) => `let s = ${g.in('scale')};\n  let q = p * s;\n  return sdMat((abs(dot(sin(q), cos(q.zxy))) / s - ${g.in('thickness')}) * 0.55);`,
  },
  {
    type: 'mandelbulb', title: 'Mandelbulb', category: 'Shape', domain: 'gpu', output: 'sdf',
    description: '3D fractal. Animate power for mind-melting morphs.',
    inputs: [
      { name: 'power', type: 'float', default: 8, step: 0.01 },
      { name: 'iterations', type: 'float', default: 6, min: 1, max: 12, step: 1 },
      { name: 'scale', type: 'float', default: 1, min: 0.01, step: 0.01 },
    ],
    gpu: (g) => `let s = max(${g.in('scale')}, 0.001);
  let c = p / s;
  let pw = ${g.in('power')};
  let it = i32(${g.in('iterations')});
  var z = c;
  var dr = 1.0;
  var r = length(z);
  var trap = 1e9;
  for (var i = 0; i < 12; i++) {
    if (i >= it || r > 2.0) { break; }
    let th = acos(clamp(z.y / max(r, 1e-6), -1.0, 1.0)) * pw;
    let ph = atan2(z.z, z.x) * pw;
    dr = pow(r, pw - 1.0) * pw * dr + 1.0;
    z = pow(r, pw) * vec3f(sin(th) * cos(ph), cos(th), sin(th) * sin(ph)) + c;
    r = length(z);
    trap = min(trap, r);
  }
  var h = sdMat(0.5 * log(max(r, 1e-6)) * r / dr * s);
  h.col = mix(vec3f(1.0, 0.55, 0.25), vec3f(0.25, 0.6, 1.0), clamp(trap * 0.8, 0.0, 1.0));
  return h;`,
  },

  // ===== Combine =====
  {
    type: 'union', title: 'Union', category: 'Combine', domain: 'gpu', output: 'sdf',
    description: 'Merge shapes. Raise smooth for gooey blobs.',
    inputs: [
      { name: 'a', type: 'sdf' },
      { name: 'b', type: 'sdf' },
      { name: 'smooth', type: 'float', default: 0.3, min: 0, step: 0.01 },
    ],
    gpu: (g) => `return opU(${g.in('a')}, ${g.in('b')}, ${g.in('smooth')});`,
  },
  {
    type: 'subtract', title: 'Subtract', category: 'Combine', domain: 'gpu', output: 'sdf',
    description: 'Carve B out of A. The cut takes B’s material.',
    inputs: [
      { name: 'a', type: 'sdf' },
      { name: 'b', type: 'sdf' },
      { name: 'smooth', type: 'float', default: 0.05, min: 0, step: 0.01 },
    ],
    gpu: (g) => `return opS(${g.in('a')}, ${g.in('b')}, ${g.in('smooth')});`,
  },
  {
    type: 'intersect', title: 'Intersect', category: 'Combine', domain: 'gpu', output: 'sdf',
    description: 'Keep only where A and B overlap.',
    inputs: [
      { name: 'a', type: 'sdf' },
      { name: 'b', type: 'sdf' },
      { name: 'smooth', type: 'float', default: 0.05, min: 0, step: 0.01 },
    ],
    gpu: (g) => `return opI(${g.in('a')}, ${g.in('b')}, ${g.in('smooth')});`,
  },
  {
    type: 'morph', title: 'Morph', category: 'Combine', domain: 'gpu', output: 'sdf',
    description: 'Blend shape A into shape B.',
    inputs: [
      { name: 'a', type: 'sdf' },
      { name: 'b', type: 'sdf' },
      { name: 't', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01 },
    ],
    gpu: (g) => `let a = ${g.in('a')};\n  let b = ${g.in('b')};\n  let t = clamp(${g.in('t')}, 0.0, 1.0);\n  return Sd(mix(a.d, b.d, t), mix(a.col, b.col, t), mix(a.mat, b.mat, t));`,
  },

  // ===== Deform =====
  {
    type: 'transform', title: 'Transform', category: 'Deform', domain: 'gpu', output: 'sdf',
    description: 'Move, rotate (degrees) and scale a shape.',
    inputs: [
      { name: 'shape', type: 'sdf' },
      { name: 'translate', type: 'vec3', default: [0, 0, 0], step: 0.01 },
      { name: 'rotate', type: 'vec3', default: [0, 0, 0], step: 0.5 },
      { name: 'scale', type: 'float', default: 1, min: 0.001, step: 0.01 },
    ],
    gpu: (g) => `let s = max(${g.in('scale')}, 0.001);
  let q = invRotate(p - ${g.in('translate')}, ${g.in('rotate')} * 0.01745329) / s;
  var h = ${g.in('shape', 'q')};
  h.d *= s;
  return h;`,
  },
  {
    type: 'twist', title: 'Twist', category: 'Deform', domain: 'gpu', output: 'sdf',
    description: 'Twist around the vertical axis.',
    inputs: [
      { name: 'shape', type: 'sdf' },
      { name: 'amount', type: 'float', default: 1, step: 0.01 },
    ],
    gpu: (g) => `let k = ${g.in('amount')};
  let c = cos(k * p.y);
  let s = sin(k * p.y);
  let q = vec3f(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
  var h = ${g.in('shape', 'q')};
  h.d /= 1.0 + abs(k) * 0.4;
  return h;`,
  },
  {
    type: 'bend', title: 'Bend', category: 'Deform', domain: 'gpu', output: 'sdf',
    description: 'Bend along the X axis.',
    inputs: [
      { name: 'shape', type: 'sdf' },
      { name: 'amount', type: 'float', default: 0.3, step: 0.01 },
    ],
    gpu: (g) => `let k = ${g.in('amount')};
  let c = cos(k * p.x);
  let s = sin(k * p.x);
  let q = vec3f(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
  var h = ${g.in('shape', 'q')};
  h.d /= 1.0 + abs(k) * 0.4;
  return h;`,
  },
  {
    type: 'repeat', title: 'Repeat', category: 'Deform', domain: 'gpu', output: 'sdf',
    description: 'Clone a shape on a grid. Count is copies per side (0 = off).',
    inputs: [
      { name: 'shape', type: 'sdf' },
      { name: 'spacing', type: 'vec3', default: [2.5, 2.5, 2.5], step: 0.01 },
      { name: 'count', type: 'vec3', default: [2, 0, 2], step: 1 },
    ],
    gpu: (g) => `let sp = max(${g.in('spacing')}, vec3f(0.001));
  let cell = clamp(round(p / sp), -${g.in('count')}, ${g.in('count')});
  let q = p - sp * cell;
  return ${g.in('shape', 'q')};`,
  },
  {
    type: 'kaleido', title: 'Radial Array', category: 'Deform', domain: 'gpu', output: 'sdf',
    description: 'Repeat a shape around a circle (kaleidoscope).',
    inputs: [
      { name: 'shape', type: 'sdf' },
      { name: 'count', type: 'float', default: 8, min: 1, step: 1 },
      { name: 'radius', type: 'float', default: 2, step: 0.01 },
      { name: 'spin', type: 'float', default: 0, step: 0.01 },
    ],
    gpu: (g) => `let cnt = max(round(${g.in('count')}), 1.0);
  let an = 6.2831853 / cnt;
  var a = atan2(p.z, p.x) + ${g.in('spin')};
  a = a - an * floor(a / an + 0.5);
  let r = length(p.xz);
  let q = vec3f(cos(a) * r - ${g.in('radius')}, p.y, sin(a) * r);
  return ${g.in('shape', 'q')};`,
  },
  {
    type: 'mirror', title: 'Mirror', category: 'Deform', domain: 'gpu', output: 'sdf',
    description: 'Fold space to mirror a shape.',
    params: [{ name: 'axis', kind: 'enum', options: ['x', 'y', 'z', 'xz', 'xyz'], default: 'x' }],
    inputs: [
      { name: 'shape', type: 'sdf' },
      { name: 'offset', type: 'float', default: 0, step: 0.01 },
    ],
    gpu: (g) => {
      const ax = g.param('axis');
      const comp = (c: string) => (ax.includes(c) ? `abs(p.${c}) - o` : `p.${c}`);
      return `let o = ${g.in('offset')};\n  let q = vec3f(${comp('x')}, ${comp('y')}, ${comp('z')});\n  return ${g.in('shape', 'q')};`;
    },
  },
  {
    type: 'displace', title: 'Displace', category: 'Deform', domain: 'gpu', output: 'sdf',
    description: 'Push the surface in and out using a field.',
    inputs: [
      { name: 'shape', type: 'sdf' },
      { name: 'field', type: 'float', default: 0, step: 0.01 },
      { name: 'amount', type: 'float', default: 0.3, step: 0.01 },
    ],
    gpu: (g) => `var h = ${g.in('shape')};\n  h.d = (h.d + ${g.in('field')} * ${g.in('amount')}) / (1.0 + abs(${g.in('amount')}) * 1.5);\n  return h;`,
  },
  {
    type: 'onion', title: 'Shell', category: 'Deform', domain: 'gpu', output: 'sdf',
    description: 'Turn a solid into a thin hollow shell.',
    inputs: [
      { name: 'shape', type: 'sdf' },
      { name: 'thickness', type: 'float', default: 0.04, min: 0, step: 0.005 },
    ],
    gpu: (g) => `var h = ${g.in('shape')};\n  h.d = abs(h.d) - ${g.in('thickness')};\n  return h;`,
  },

  // ===== Material =====
  {
    type: 'material', title: 'Material', category: 'Material', domain: 'gpu', output: 'sdf',
    description: 'Surface look: color, roughness, metal, glow, thin-film iridescence, plus a glowing tactical scan grid.',
    inputs: [
      { name: 'shape', type: 'sdf' },
      { name: 'color', type: 'color', default: [0.9, 0.9, 0.95] },
      { name: 'roughness', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01 },
      { name: 'metallic', type: 'float', default: 0, min: 0, max: 1, step: 0.01 },
      { name: 'emission', type: 'float', default: 0, min: 0, step: 0.01 },
      { name: 'iridescence', type: 'float', default: 0, min: 0, max: 1, step: 0.01 },
      { name: 'grid', label: 'scan grid', type: 'float', default: 0, min: 0, step: 0.05 },
      { name: 'gridScale', label: 'grid scale', type: 'float', default: 4, min: 0.1, step: 0.1 },
      { name: 'gridColor', label: 'grid color', type: 'color', default: [1, 0.1, 0.08] },
    ],
    gpu: (g) => `var h = ${g.in('shape')};
  h.col = ${g.in('color')};
  h.mat = vec4f(clamp(${g.in('roughness')}, 0.0, 1.0), clamp(${g.in('metallic')}, 0.0, 1.0), max(${g.in('emission')}, 0.0), clamp(${g.in('iridescence')}, 0.0, 1.0));
  let gi = ${g.in('grid')};
  if (gi > 0.0) {
    let gs = ${g.in('gridScale')};
    let gq = abs(fract(p * gs + 0.5) - 0.5) / gs;
    let lw = 0.012;
    let line = 1.0 - smoothstep(0.0, lw, min(gq.x, min(gq.y, gq.z)));
    let sweep = fract(U.fx.z * 0.22) * 8.0 - 4.0;
    let band = exp(-pow((p.y - sweep) * 3.0, 2.0));
    let gc = ${g.in('gridColor')};
    h.col = mix(h.col, gc, clamp(line + band * 0.3, 0.0, 1.0));
    h.mat.z += gi * (line * (0.35 + band * 2.0) + band * 0.25);
  }
  return h;`,
  },


  // ===== Text =====
  {
    type: 'text', title: 'Text', category: 'Shape', domain: 'gpu', output: 'sdf',
    description: 'Extruded 3D type with bevel. Any font, any word.',
    params: [
      { name: 'text', kind: 'text', default: 'FLUXION' },
      { name: 'font', kind: 'enum', options: Object.keys(FONTS), default: 'display' },
    ],
    inputs: [
      { name: 'size', type: 'float', default: 1, min: 0.01, step: 0.01 },
      { name: 'depth', type: 'float', default: 0.3, min: 0, step: 0.01 },
      { name: 'bevel', type: 'float', default: 0.025, min: 0, step: 0.005 },
    ],
    gpu: (g) => `let info = ${g.data('atlas')};
  let k = ${g.in('size')} / max(info.w, 1.0);
  let bev = ${g.in('bevel')};
  let d2 = textSdf2(p.xy, info, k);
  let w = vec2f(d2 + bev, abs(p.z) - ${g.in('depth')} * 0.5 + bev);
  return sdMat(min(max(w.x, w.y), 0.0) + length(max(w, vec2f(0.0))) - bev);`,
  },
  {
    type: 'reveal', title: 'Reveal', category: 'Deform', domain: 'gpu', output: 'sdf',
    description: 'Animated build-on with a glowing edge: wipe, radial, dissolve or slices. Animate progress 0→1.',
    params: [{ name: 'mode', kind: 'enum', options: ['wipe', 'radial', 'dissolve', 'slices'], default: 'wipe' }],
    inputs: [
      { name: 'shape', type: 'sdf' },
      { name: 'progress', type: 'float', default: 0.5, min: 0, max: 1, step: 0.005 },
      { name: 'angle', type: 'float', default: 0, step: 1 },
      { name: 'extent', type: 'float', default: 4, min: 0.01, step: 0.05 },
      { name: 'edge', label: 'edge glow', type: 'float', default: 6, min: 0, step: 0.1 },
      { name: 'edgeColor', label: 'edge color', type: 'color', default: [0.2, 1, 0.85] },
    ],
    gpu: (g) => {
      const m = g.param('mode');
      const cut =
        m === 'radial' ? `length(p) - pr * ext`
        : m === 'dissolve' ? `(fbm(p * 2.2, 3) * 0.5 + 0.5 - pr * 1.1 + 0.05) * 0.45`
        : m === 'slices' ? `abs(fract(p.y * 3.0) - 0.5) / 3.0 - pr * 0.1667`
        : `dot(p, vec3f(cos(an), sin(an), 0.0)) - mix(-ext, ext, pr)`;
      return `let pr = clamp(${g.in('progress')}, 0.0, 1.0);
  let ext = ${g.in('extent')};
  let an = ${g.in('angle')} * 0.01745329;
  let c = ${cut};
  var h = ${g.in('shape')};
  h.d = max(h.d, c);
  let e = exp(-abs(c) * 22.0) * step(0.002, pr) * step(pr, 0.998);
  h.col = mix(h.col, ${g.in('edgeColor')}, clamp(e * 1.4, 0.0, 1.0));
  h.mat.z += ${g.in('edge')} * e;
  return h;`;
    },
  },
  {
    type: 'shots', title: 'Shots', category: 'Combine', domain: 'gpu', output: 'sdf',
    description: 'Cuts between up to 4 shapes on a timer with cinematic transitions.',
    params: [{ name: 'transition', kind: 'enum', options: ['dissolve', 'pop', 'swirl', 'slice', 'wipe', 'morph'], default: 'dissolve' }],
    inputs: [
      { name: 'a', type: 'sdf' },
      { name: 'b', type: 'sdf' },
      { name: 'c', type: 'sdf' },
      { name: 'd', type: 'sdf' },
      { name: 'shot', label: 'shot length', type: 'float', default: 3, min: 0.2, step: 0.05 },
      { name: 'length', label: 'transition', type: 'float', default: 0.9, min: 0, step: 0.05 },
      { name: 'offset', label: 'time offset', type: 'float', default: 0, step: 0.05 },
      { name: 'edge', label: 'edge glow', type: 'float', default: 5, min: 0, step: 0.1 },
      { name: 'edgeColor', label: 'edge color', type: 'color', default: [1, 0.3, 0.7] },
    ],
    gpu: (g) => {
      const ins = ['a', 'b', 'c', 'd'].filter((x) => g.connected(x));
      const list = ins.length ? ins : ['a'];
      const N = list.length;
      const pick = (v: string, idx: string, at: string) =>
        list.map((name, i) => `${i ? ' else ' : ''}if (${idx} == ${i}) { ${v} = ${g.in(name, at)}; }`).join('');
      const mode = g.param('transition');
      let pre = '';
      let post = '';
      switch (mode) {
        case 'pop':
          pre = `let sa = max(1.0 - easeInBack(pr), 0.002);\n  let sb = max(easeOutBack(pr), 0.002);\n  qa = p / sa;\n  qb = p / sb;`;
          post = `A.d *= sa;\n  B.d *= sb;\n  return opU(A, B, 0.0);`;
          break;
        case 'swirl':
          pre = `qa = twistY(p, pr * 7.0);\n  qb = twistY(p, (pr - 1.0) * 7.0);`;
          post = `let w = smoothstep(0.25, 0.75, pr);\n  return Sd(mix(A.d, B.d, w) * 0.55, mix(A.col, B.col, w), mix(A.mat, B.mat, w));`;
          break;
        case 'slice':
          pre = `let sl = select(-1.0, 1.0, sin(p.y * 9.0) > 0.0) * 7.0;\n  qa = p - vec3f(sl * pr * pr * pr, 0.0, 0.0);\n  let q1 = 1.0 - pr;\n  qb = p + vec3f(sl * q1 * q1 * q1, 0.0, 0.0);`;
          post = `var r = opU(A, B, 0.0);\n  r.d *= 0.5;\n  return r;`;
          break;
        case 'wipe':
          post = `let sw = mix(-5.0, 5.0, pr);\n  let c = p.x - sw;\n  A.d = max(A.d, -c);\n  B.d = max(B.d, c);\n  var r = opU(A, B, 0.0);\n  let e = exp(-abs(c) * 20.0);\n  r.col = mix(r.col, EC, clamp(e * 1.4, 0.0, 1.0));\n  r.mat.z += EG * e;\n  return r;`;
          break;
        case 'morph':
          post = `return Sd(mix(A.d, B.d, pr), mix(A.col, B.col, pr), mix(A.mat, B.mat, pr));`;
          break;
        default: // dissolve
          post = `let nz = fbm(p * 2.4, 3) * 0.5 + 0.5;\n  A.d = max(A.d, (pr - nz) * 0.45);\n  B.d = max(B.d, (nz - pr) * 0.45);\n  var r = opU(A, B, 0.0);\n  let e = exp(-abs(nz - pr) * 30.0);\n  r.col = mix(r.col, EC, clamp(e * 1.4, 0.0, 1.0));\n  r.mat.z += EG * e;\n  return r;`;
      }
      return `let T = max(U.fx.z + ${g.in('offset')}, 0.0);
  let dur = max(${g.in('shot')}, 0.1);
  let tr = clamp(${g.in('length')}, 0.0, dur);
  let k = floor(T / dur);
  let local = T - k * dur;
  let i = i32(k) % ${N};
  let j = (i + 1) % ${N};
  var pr = 0.0;
  if (tr > 0.0) { pr = clamp((local - (dur - tr)) / tr, 0.0, 1.0); }
  pr = pr * pr * (3.0 - 2.0 * pr);
  let EC = ${g.in('edgeColor')};
  let EG = ${g.in('edge')};
  var qa = p;
  var qb = p;
  ${pre}
  var A = sdEmpty();
  ${pick('A', 'i', 'qa')}
  if (pr <= 0.0) { return A; }
  var B = sdEmpty();
  ${pick('B', 'j', 'qb')}
  ${post}`;
    },
  },
  {
    type: 'scatter', title: 'Scatter', category: 'Deform', domain: 'gpu', output: 'sdf',
    description: 'Scatter random copies through space: jitter, random scale, spin and gaps. Animate evolve.',
    inputs: [
      { name: 'shape', type: 'sdf' },
      { name: 'spacing', type: 'float', default: 1.2, min: 0.05, step: 0.01 },
      { name: 'jitter', type: 'float', default: 0.25, min: 0, max: 0.45, step: 0.01 },
      { name: 'scaleVar', label: 'scale var', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01 },
      { name: 'density', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01 },
      { name: 'spin', type: 'float', default: 0.5, step: 0.01 },
      { name: 'evolve', type: 'float', default: 0, step: 0.01 },
      { name: 'radius', label: 'bounds', type: 'float', default: 4, min: 0.1, step: 0.05 },
    ],
    gpu: (g) => `let sp = max(${g.in('spacing')}, 0.05);
  let cell = floor(p / sp + 0.5);
  let rnd = hash33(cell + vec3f(17.0, 3.0, 9.0)) * 0.5 + 0.5;
  let rnd2 = hash33(cell + vec3f(-5.0, 41.0, 13.0)) * 0.5 + 0.5;
  let ev = ${g.in('evolve')};
  let jit = (vec3f(sin(ev + rnd.x * 6.28), cos(ev * 0.8 + rnd.y * 6.28), sin(ev * 0.6 + rnd.z * 6.28)) * ${g.in('jitter')}) * sp;
  let sc = mix(1.0, rnd2.x * 0.8 + 0.2, ${g.in('scaleVar')});
  let ang = (rnd2.yzx - 0.5) * 6.28 * ${g.in('spin')} + vec3f(ev * (rnd2.x - 0.5));
  let q = invRotate(p - cell * sp - jit, ang) / sc;
  var h = ${g.in('shape', 'q')};
  h.d *= sc * 0.7;
  let keep = rnd2.z < ${g.in('density')} && length(cell * sp) < ${g.in('radius')};
  if (!keep) { h = sdEmpty(); h.d = sp * 0.5; }
  let bound = length(p) - ${g.in('radius')} - sp;
  if (bound > 0.0) { h.d = max(h.d, bound); }
  return h;`,
  },

  // ===== Camera =====
  {
    type: 'camera', title: 'Camera', category: 'Camera', domain: 'cpu', output: 'camera',
    description: 'A manual camera. Wire signals into position for your own moves.',
    inputs: [
      { name: 'position', type: 'vec3', default: [3, 1.5, 5], step: 0.01 },
      { name: 'target', type: 'vec3', default: [0, 0, 0], step: 0.01 },
      { name: 'fov', type: 'float', default: 45, min: 5, max: 140, step: 0.5 },
      { name: 'roll', type: 'float', default: 0, step: 0.5 },
    ],
    cpu: (i) => ({ kind: 'camera', pos: [...v3(i.position)] as Vec3, target: [...v3(i.target)] as Vec3, fov: n(i.fov), roll: (n(i.roll) * Math.PI) / 180 }),
  },
  {
    type: 'director', title: 'Director', category: 'Camera', domain: 'cpu', output: 'camera',
    description: 'Automatic cinematography: orbits, push-ins, cranes, fly-bys, vertigo zooms, handheld shake and cuts on the beat.',
    params: [
      { name: 'mode', kind: 'enum', options: ['director', ...CAM_MODES], default: 'director' },
      { name: 'cut', kind: 'enum', options: ['smooth', 'cut', 'whip'], default: 'smooth' },
    ],
    inputs: [
      { name: 'target', type: 'vec3', default: [0, 0, 0], step: 0.01 },
      { name: 'distance', type: 'float', default: 6, min: 0.2, step: 0.05 },
      { name: 'height', type: 'float', default: 1.2, step: 0.05 },
      { name: 'fov', type: 'float', default: 42, min: 5, max: 140, step: 0.5 },
      { name: 'shot', label: 'shot length', type: 'float', default: 4, min: 0.25, step: 0.05 },
      { name: 'speed', type: 'float', default: 1, step: 0.01 },
      { name: 'shake', type: 'float', default: 0.25, min: 0, step: 0.01 },
      { name: 'arc', label: 'arc (deg)', type: 'float', default: 360, min: 0, max: 360, step: 1 },
      { name: 'seed', type: 'float', default: 3, step: 1 },
    ],
    cpu: (i, c) => directorCamera(i, c),
  },

  // ===== Audio =====
  {
    type: 'audio', title: 'Audio', category: 'Signal', domain: 'cpu', output: 'float',
    description: 'Audio-reactive signal. Drop a track on the viewport; without one it plays a built-in 120 BPM groove.',
    params: [{ name: 'band', kind: 'enum', options: BANDS, default: 'bass' }],
    inputs: [
      { name: 'gain', type: 'float', default: 1, step: 0.01 },
      { name: 'offset', type: 'float', default: 0, step: 0.01 },
    ],
    cpu: (i, c) => sampleAudio(c.params.band as Band, c.t) * n(i.gain) + n(i.offset),
  },

  // ===== Particles =====
  {
    type: 'particles', title: 'Particles', category: 'FX', domain: 'cpu', output: 'particles',
    description: 'Up to 1M GPU particles in curl-noise flow. They cling to the scene, or to their own shape input (which stays invisible: pure particle sculptures). Streaks + trails for light painting.',
    params: [
      { name: 'emitter', kind: 'enum', options: ['surface', 'sphere', 'ring', 'burst', 'rain'], default: 'surface' },
      { name: 'colorMode', label: 'color', kind: 'enum', options: ['life', 'speed', 'surface', 'spectral'], default: 'life' },
    ],
    inputs: [
      { name: 'shape', label: 'sculpt (optional)', type: 'sdf' },
      { name: 'count', type: 'float', default: 60000, min: 100, max: 1000000, step: 1000 },
      { name: 'size', type: 'float', default: 0.012, min: 0.001, step: 0.001 },
      { name: 'speed', type: 'float', default: 0.6, step: 0.01 },
      { name: 'turbulence', type: 'float', default: 1, min: 0, step: 0.01 },
      { name: 'cling', type: 'float', default: 0.8, min: 0, max: 1, step: 0.01 },
      { name: 'gravity', type: 'float', default: 0, step: 0.01 },
      { name: 'life', type: 'float', default: 3, min: 0.1, step: 0.05 },
      { name: 'spread', type: 'float', default: 2.5, min: 0.01, step: 0.05 },
      { name: 'intensity', type: 'float', default: 4, min: 0, step: 0.05 },
      { name: 'color', type: 'color', default: [0.3, 1, 0.9] },
      { name: 'color2', label: 'fade to', type: 'color', default: [1, 0.2, 0.6] },
      { name: 'streak', type: 'float', default: 0, min: 0, step: 0.005 },
      { name: 'trails', type: 'float', default: 0, min: 0, max: 0.985, step: 0.005 },
      { name: 'vortex', type: 'float', default: 0, step: 0.01 },
      { name: 'attract', type: 'float', default: 0, step: 0.01 },
    ],
    cpu: (i, c) => ({
      kind: 'particles', emitter: String(c.params.emitter), count: Math.round(n(i.count)), size: n(i.size), speed: n(i.speed),
      turbulence: n(i.turbulence), cling: n(i.cling), gravity: n(i.gravity), life: n(i.life), spread: n(i.spread),
      intensity: n(i.intensity), color: v3(i.color), color2: v3(i.color2),
      colorMode: String(c.params.colorMode ?? 'life'), streak: n(i.streak), trails: Math.min(0.985, Math.max(0, n(i.trails))),
      vortex: n(i.vortex), attract: n(i.attract),
    }),
  },

  // ===== HUD =====
  {
    type: 'hud', title: 'HUD', category: 'FX', domain: 'cpu', output: 'hud',
    description: 'Heads-up display over the frame: tactical reticle, surveillance tracking or drone telemetry. Baked into exported video.',
    params: [
      { name: 'style', kind: 'enum', options: ['tactical', 'surveillance', 'drone', 'minimal'], default: 'tactical' },
      { name: 'label', kind: 'text', default: 'TARGET ACQUIRED' },
    ],
    inputs: [
      { name: 'opacity', type: 'float', default: 0.85, min: 0, max: 1, step: 0.01 },
      { name: 'color', type: 'color', default: [1, 0.12, 0.08] },
      { name: 'seed', type: 'float', default: 1, step: 1 },
    ],
    cpu: (i, c) => ({ kind: 'hud', style: String(c.params.style), label: String(c.params.label ?? ''), opacity: n(i.opacity), color: v3(i.color), seed: n(i.seed) }),
  },

  // ===== Output =====
  {
    type: 'output', title: 'Output', category: 'Output', domain: 'cpu', output: null,
    description: 'The final render: scene, camera, particles, HUD, light, lens effects and film look.',
    params: [{ name: 'look', kind: 'enum', options: LOOKS, default: 'cinematic' }],
    inputs: [
      { name: 'shape', type: 'sdf' },
      { name: 'camera', type: 'camera' },
      { name: 'particles', type: 'particles' },
      { name: 'hud', type: 'hud' },
      { name: 'sky', type: 'color', default: [0.05, 0.06, 0.12] },
      { name: 'horizon', type: 'color', default: [0.35, 0.2, 0.45] },
      { name: 'light', type: 'color', default: [1, 0.92, 0.85] },
      { name: 'lightPower', label: 'light power', type: 'float', default: 3, min: 0, step: 0.05 },
      { name: 'lightYaw', label: 'light yaw', type: 'float', default: 40, step: 1 },
      { name: 'lightPitch', label: 'light pitch', type: 'float', default: 45, step: 1 },
      { name: 'exposure', type: 'float', default: 0, step: 0.05 },
      { name: 'bloom', type: 'float', default: 0.08, min: 0, max: 1, step: 0.005 },
      { name: 'glow', type: 'float', default: 1, min: 0, step: 0.05 },
      { name: 'fog', type: 'float', default: 0.5, min: 0, step: 0.01 },
      { name: 'aberration', type: 'float', default: 0.3, min: 0, step: 0.01 },
      { name: 'grain', type: 'float', default: 0.04, min: 0, step: 0.005 },
      { name: 'vignette', type: 'float', default: 0.35, min: 0, step: 0.01 },
      { name: 'flash', type: 'float', default: 0, min: 0, step: 0.01 },
      { name: 'glitch', type: 'float', default: 0, min: 0, step: 0.01 },
      { name: 'letterbox', type: 'float', default: 0, min: 0, max: 1, step: 0.01 },
      { name: 'hue', label: 'hue shift', type: 'float', default: 0, step: 0.005 },
      { name: 'rays', label: 'god rays', type: 'float', default: 0, min: 0, step: 0.01 },
      { name: 'outline', type: 'float', default: 0, min: 0, max: 2, step: 0.01 },
      { name: 'scanlines', type: 'float', default: 0, min: 0, max: 1, step: 0.01 },
      { name: 'pixelate', type: 'float', default: 0, min: 0, step: 0.5 },
    ],
  },
];

export const REGISTRY: Record<string, NodeDef> = Object.fromEntries(defs.map((d) => [d.type, d]));
export const NODE_DEFS = defs;

export function getDef(type: string): NodeDef {
  const d = REGISTRY[type];
  if (!d) throw new Error(`Unknown node type: ${type}`);
  return d;
}

export function defaultParams(def: NodeDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of def.params ?? []) out[p.name] = structuredClone(p.default);
  return out;
}

export function defaultValues(def: NodeDef): Record<string, CpuValue> {
  const out: Record<string, CpuValue> = {};
  for (const i of def.inputs) if (i.default !== undefined) out[i.name] = structuredClone(i.default);
  return out;
}
