import type { CpuValue, Keyframe, SocketType, Vec3 } from './types';

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
  | { name: string; label?: string; kind: 'keys'; default: Keyframe[] };

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

export type Category = 'Signal' | 'Math' | 'Field' | 'Shape' | 'Combine' | 'Deform' | 'Material' | 'Output';

export const CATEGORY_COLORS: Record<Category, string> = {
  Signal: '#ff9f43',
  Math: '#9aa4ff',
  Field: '#c56cff',
  Shape: '#3cf2c4',
  Combine: '#2ec8ff',
  Deform: '#ff5e8a',
  Material: '#ffd166',
  Output: '#ffffff',
};

// ---------- small CPU helpers ----------
const n = (v: CpuValue | undefined): number => (typeof v === 'number' ? v : v ? v[0] : 0);
const v3 = (v: CpuValue | undefined): Vec3 => (typeof v === 'number' ? [v, v, v] : v ?? [0, 0, 0]);
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
    description: 'Surface look: color, roughness, metal, glow and thin-film iridescence.',
    inputs: [
      { name: 'shape', type: 'sdf' },
      { name: 'color', type: 'color', default: [0.9, 0.9, 0.95] },
      { name: 'roughness', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01 },
      { name: 'metallic', type: 'float', default: 0, min: 0, max: 1, step: 0.01 },
      { name: 'emission', type: 'float', default: 0, min: 0, step: 0.01 },
      { name: 'iridescence', type: 'float', default: 0, min: 0, max: 1, step: 0.01 },
    ],
    gpu: (g) => `var h = ${g.in('shape')};
  h.col = ${g.in('color')};
  h.mat = vec4f(clamp(${g.in('roughness')}, 0.0, 1.0), clamp(${g.in('metallic')}, 0.0, 1.0), max(${g.in('emission')}, 0.0), clamp(${g.in('iridescence')}, 0.0, 1.0));
  return h;`,
  },

  // ===== Output =====
  {
    type: 'output', title: 'Output', category: 'Output', domain: 'cpu', output: null,
    description: 'The final render: scene, environment light and lens effects.',
    inputs: [
      { name: 'shape', type: 'sdf' },
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
