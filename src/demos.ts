import { emptyDoc } from './graph/graph';
import { defaultParams, defaultValues, getDef } from './graph/registry';
import type { CpuValue, GraphDoc } from './graph/types';

class Builder {
  doc: GraphDoc;
  constructor(name: string, duration = 10) {
    this.doc = { ...emptyDoc(), name, duration };
  }
  add(type: string, x: number, y: number, values: Record<string, CpuValue> = {}, params: Record<string, unknown> = {}): number {
    const def = getDef(type);
    const id = this.doc.nextId++;
    this.doc.nodes.push({ id, type, x, y, values: { ...defaultValues(def), ...values }, params: { ...defaultParams(def), ...params } });
    return id;
  }
  link(from: number, to: number, input: string): this {
    this.doc.links.push({ id: this.doc.nextId++, from, to, input });
    return this;
  }
}

const COL = (i: number) => i * 270;

function liquidChrome(): GraphDoc {
  const b = new Builder('Liquid Chrome', 12);
  const time = b.add('time', COL(0), 0, { speed: 0.35 });
  const noise = b.add('noisefield', COL(1), 0, { scale: 0.9, detail: 2 });
  const sphere = b.add('sphere', COL(1), 200, { radius: 1.15 });
  const disp = b.add('displace', COL(2), 120, { amount: 0.42 });
  const lfo = b.add('lfo', COL(0), 230, { freq: 0.083, amp: 0.9 });
  const twist = b.add('twist', COL(3), 120);
  const chrome = b.add('material', COL(4), 60, { color: [0.95, 0.96, 1], roughness: 0.06, metallic: 1, iridescence: 0.45 });

  const spinA = b.add('time', COL(0), 470, { speed: 47 });
  const spinB = b.add('time', COL(0), 600, { speed: 29 });
  const rot = b.add('vec3', COL(1), 470);
  const torus = b.add('torus', COL(1), 680, { major: 1.95, minor: 0.035 });
  const xf = b.add('transform', COL(2), 470);
  const neon = b.add('material', COL(3), 470, { color: [1, 0.12, 0.55], emission: 7, roughness: 0.5 });
  const union = b.add('union', COL(5), 240, { smooth: 0.35 });
  const floor = b.add('floor', COL(4), 520, { height: -1.9 });
  const floorMat = b.add('material', COL(5), 520, { color: [0.02, 0.02, 0.03], roughness: 0.12, metallic: 0 });
  const scene = b.add('union', COL(6), 360, { smooth: 0 });
  const out = b.add('output', COL(7), 120, {
    sky: [0.01, 0.01, 0.03], horizon: [0.24, 0.06, 0.32], light: [1, 0.85, 0.9], lightPower: 3.2,
    lightYaw: -35, lightPitch: 50, bloom: 0.1, glow: 1.4, fog: 0.35, exposure: 0.2,
  });
  b.link(time, noise, 'evolve').link(sphere, disp, 'shape').link(noise, disp, 'field')
    .link(disp, twist, 'shape').link(lfo, twist, 'amount').link(twist, chrome, 'shape')
    .link(spinA, rot, 'x').link(spinB, rot, 'z').link(torus, xf, 'shape').link(rot, xf, 'rotate')
    .link(xf, neon, 'shape').link(chrome, union, 'a').link(neon, union, 'b')
    .link(floor, floorMat, 'shape').link(union, scene, 'a').link(floorMat, scene, 'b').link(scene, out, 'shape');
  b.doc.camera = { yaw: 0.5, pitch: 0.18, dist: 6.5, target: [0, 0, 0] };
  return b.doc;
}

function neonFractal(): GraphDoc {
  const b = new Builder('Neon Fractal', 20);
  const lfo = b.add('lfo', COL(0), 0, { freq: 0.05, amp: 2.2, offset: 7 }, { wave: 'sine' });
  const spring = b.add('spring', COL(1), 0, { stiffness: 30, damping: 4 });
  const bulb = b.add('mandelbulb', COL(2), 0, { iterations: 7, scale: 1.4 });
  const spin = b.add('time', COL(0), 260, { speed: 9 });
  const rot = b.add('vec3', COL(1), 260, { x: 15 });
  const xf = b.add('transform', COL(3), 0);
  const dist = b.add('distance', COL(2), 380);
  const t2 = b.add('time', COL(2), 500, { speed: 0.12 });
  const pal = b.add('palette', COL(3), 330, { }, { preset: 'neon' });
  const mul = b.add('math', COL(2), 620, { a: 1, b: 1.4 }, { op: 'multiply' });
  const mat = b.add('material', COL(4), 120, { roughness: 0.35, metallic: 0.2, emission: 0.55, iridescence: 0.2 });
  const out = b.add('output', COL(5), 60, {
    sky: [0.0, 0.0, 0.01], horizon: [0.02, 0.1, 0.16], light: [0.8, 0.9, 1], lightPower: 2.5,
    lightYaw: 60, lightPitch: 35, bloom: 0.14, glow: 2.2, fog: 0.15, aberration: 0.6, exposure: 0.3,
  });
  b.link(lfo, spring, 'target').link(spring, bulb, 'power').link(bulb, xf, 'shape')
    .link(spin, rot, 'y').link(rot, xf, 'rotate').link(xf, mat, 'shape')
    .link(dist, mul, 'a').link(mul, pal, 't').link(t2, pal, 'shift').link(pal, mat, 'color')
    .link(mat, out, 'shape');
  b.doc.camera = { yaw: 0.9, pitch: 0.35, dist: 5.2, target: [0, 0, 0] };
  return b.doc;
}

function gyroidCore(): GraphDoc {
  const b = new Builder('Gyroid Heart', 8);
  const pulse = b.add('pulse', COL(0), 0, { bpm: 96, decay: 5, amp: 1 });
  const spring = b.add('spring', COL(1), 0, { stiffness: 220, damping: 9 });
  const radius = b.add('remap', COL(2), 0, { inMin: 0, inMax: 1, outMin: 0.55, outMax: 0.75 });
  const emit = b.add('remap', COL(2), 250, { inMin: 0, inMax: 1, outMin: 2, outMax: 14 });
  const core = b.add('sphere', COL(3), 0);
  const coreMat = b.add('material', COL(4), 0, { color: [1, 0.35, 0.08], roughness: 0.6 });

  const gyr = b.add('gyroid', COL(2), 500, { scale: 5.5, thickness: 0.045 });
  const ball = b.add('sphere', COL(2), 680, { radius: 1.45 });
  const inter = b.add('intersect', COL(3), 520, { smooth: 0.05 });
  const shell = b.add('sphere', COL(3), 720, { radius: 0.95 });
  const hollow = b.add('subtract', COL(4), 560, { smooth: 0.08 });
  const spin = b.add('time', COL(3), 900, { speed: 14 });
  const rot = b.add('vec3', COL(4), 860, { x: 20 });
  const xf = b.add('transform', COL(5), 560);
  const gold = b.add('material', COL(6), 520, { color: [1, 0.72, 0.36], roughness: 0.22, metallic: 1, iridescence: 0.15 });
  const both = b.add('union', COL(7), 260, { smooth: 0.02 });
  const floor = b.add('floor', COL(6), 900, { height: -1.6 });
  const wave = b.add('wavefield', COL(6), 1030, { freq: 5 }, { mode: 'radial' });
  const t = b.add('time', COL(5), 1100, { speed: -2.5 });
  const fd = b.add('displace', COL(7), 900, { amount: 0.03 });
  const floorMat = b.add('material', COL(8), 900, { color: [0.03, 0.025, 0.03], roughness: 0.08 });
  const scene = b.add('union', COL(8), 360, { smooth: 0 });
  const out = b.add('output', COL(9), 120, {
    sky: [0.02, 0.01, 0.01], horizon: [0.28, 0.08, 0.03], light: [1, 0.8, 0.6], lightPower: 2.4,
    lightYaw: 120, lightPitch: 40, bloom: 0.12, glow: 1.6, fog: 0.4, exposure: 0.1,
  });
  b.link(pulse, spring, 'target').link(spring, radius, 'value').link(spring, emit, 'value')
    .link(radius, core, 'radius').link(core, coreMat, 'shape').link(emit, coreMat, 'emission')
    .link(gyr, inter, 'a').link(ball, inter, 'b').link(inter, hollow, 'a').link(shell, hollow, 'b')
    .link(spin, rot, 'y').link(hollow, xf, 'shape').link(rot, xf, 'rotate').link(xf, gold, 'shape')
    .link(coreMat, both, 'a').link(gold, both, 'b')
    .link(t, wave, 'phase').link(floor, fd, 'shape').link(wave, fd, 'field').link(fd, floorMat, 'shape')
    .link(both, scene, 'a').link(floorMat, scene, 'b').link(scene, out, 'shape');
  b.doc.camera = { yaw: 0.3, pitch: 0.12, dist: 5.2, target: [0, -0.1, 0] };
  return b.doc;
}

function kineticRing(): GraphDoc {
  const b = new Builder('Kinetic Ring', 6);
  const keys = b.add('curve', COL(0), 0, { amp: 1 }, {
    keys: [{ t: 0, v: 0 }, { t: 1, v: 0.785 }, { t: 2, v: 1.571 }, { t: 3, v: 2.356 }, { t: 4, v: 3.142 }],
    interp: 'back', loop: 'loop',
  });
  const flip = b.add('curve', COL(0), 300, { amp: 180 }, {
    keys: [{ t: 0, v: 0 }, { t: 1.5, v: 1 }, { t: 3, v: 0 }], interp: 'expo', loop: 'loop',
  });
  const rot = b.add('vec3', COL(1), 300);
  const box = b.add('box', COL(1), 500, { size: [0.14, 0.75, 0.14], round: 0.06 });
  const xf = b.add('transform', COL(2), 300);
  const ring = b.add('kaleido', COL(3), 200, { count: 18, radius: 2.1 });
  const pos = b.add('position', COL(2), 620);
  const comp = b.add('component', COL(3), 560, {}, { axis: 'y' });
  const pal = b.add('palette', COL(4), 520, {}, { preset: 'sunset' });
  const mat = b.add('material', COL(5), 200, { roughness: 0.15, metallic: 0.6, iridescence: 0.6 });
  const orb = b.add('sphere', COL(4), 760, { radius: 0.5 });
  const lfo = b.add('lfo', COL(3), 860, { freq: 1 / 3, amp: 0.25, offset: 0.2 }, { wave: 'bounce' });
  const orbXf = b.add('transform', COL(5), 760);
  const ofs = b.add('vec3', COL(4), 940);
  const orbMat = b.add('material', COL(6), 760, { color: [0.3, 0.7, 1], emission: 9 });
  const u = b.add('union', COL(7), 360, { smooth: 0.1 });
  const floor = b.add('floor', COL(6), 1000, { height: -0.9 });
  const fm = b.add('material', COL(7), 1000, { color: [0.05, 0.05, 0.06], roughness: 0.2 });
  const scene = b.add('union', COL(8), 520, { smooth: 0 });
  const out = b.add('output', COL(9), 200, {
    sky: [0.03, 0.04, 0.09], horizon: [0.4, 0.22, 0.3], light: [1, 0.95, 0.9], lightPower: 3,
    lightYaw: 30, lightPitch: 55, bloom: 0.09, glow: 1.2, fog: 0.3,
  });
  b.link(flip, rot, 'x').link(box, xf, 'shape').link(rot, xf, 'rotate').link(xf, ring, 'shape').link(keys, ring, 'spin')
    .link(pos, comp, 'vector').link(comp, pal, 't').link(pal, mat, 'color').link(ring, mat, 'shape')
    .link(lfo, ofs, 'y').link(orb, orbXf, 'shape').link(ofs, orbXf, 'translate').link(orbXf, orbMat, 'shape')
    .link(mat, u, 'a').link(orbMat, u, 'b').link(floor, fm, 'shape').link(u, scene, 'a').link(fm, scene, 'b')
    .link(scene, out, 'shape');
  b.doc.camera = { yaw: 0.2, pitch: 0.42, dist: 6.4, target: [0, -0.2, 0] };
  return b.doc;
}

export const DEMOS: { name: string; build: () => GraphDoc }[] = [
  { name: 'Liquid Chrome', build: liquidChrome },
  { name: 'Neon Fractal', build: neonFractal },
  { name: 'Gyroid Heart', build: gyroidCore },
  { name: 'Kinetic Ring', build: kineticRing },
];

export function blankDoc(): GraphDoc {
  const b = new Builder('Untitled');
  const s = b.add('sphere', 0, 0);
  const m = b.add('material', 270, 0, { color: [1, 0.3, 0.6], roughness: 0.2, iridescence: 0.5 });
  const o = b.add('output', 540, 0);
  b.link(s, m, 'shape').link(m, o, 'shape');
  return b.doc;
}
