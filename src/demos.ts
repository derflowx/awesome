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


function titleSequence(): GraphDoc {
  const b = new Builder('Title Sequence', 10);
  const text = b.add('text', COL(0), 0, { size: 1.15, depth: 0.42, bevel: 0.03 }, { text: 'FLUXION', font: 'display' });
  const build = b.add('curve', COL(0), 240, { amp: 1 }, {
    keys: [{ t: 0, v: 0 }, { t: 0.4, v: 0 }, { t: 2.6, v: 1 }, { t: 10, v: 1 }], interp: 'expo', loop: 'once',
  });
  const reveal = b.add('reveal', COL(1), 0, { extent: 4.6, edge: 9, edgeColor: [0.25, 1, 0.9] }, { mode: 'wipe' });
  const pos = b.add('position', COL(1), 420);
  const comp = b.add('component', COL(2), 420, {}, { axis: 'x' });
  const t1 = b.add('time', COL(2), 560, { speed: 0.15 });
  const pal = b.add('palette', COL(3), 420, { }, { preset: 'chrome' });
  const chrome = b.add('material', COL(3), 0, { roughness: 0.08, metallic: 1, iridescence: 0.7 });
  const parts = b.add('particles', COL(4), 860, { count: 90000, size: 0.009, speed: 0.5, cling: 0.92, life: 2.6, spread: 2.2, intensity: 5, color: [0.3, 1, 0.95], color2: [0.9, 0.3, 1] }, { emitter: 'surface' });
  const dir = b.add('director', COL(5), 520, { distance: 6.2, height: 0.6, shot: 3.3, shake: 0.35, fov: 38, seed: 7, arc: 110 }, { mode: 'director', cut: 'smooth' });
  const flash = b.add('curve', COL(5), 900, { amp: 1 }, {
    keys: [{ t: 0, v: 0 }, { t: 2.55, v: 0 }, { t: 2.62, v: 1.2 }, { t: 3.2, v: 0 }, { t: 10, v: 0 }], interp: 'linear', loop: 'once',
  });
  const glitch = b.add('curve', COL(6), 900, { amp: 1 }, {
    keys: [{ t: 0, v: 0.8 }, { t: 0.5, v: 0 }, { t: 2.5, v: 0 }, { t: 2.65, v: 0.7 }, { t: 2.9, v: 0 }, { t: 10, v: 0 }], interp: 'linear', loop: 'once',
  });
  const out = b.add('output', COL(7), 120, {
    sky: [0.005, 0.005, 0.015], horizon: [0.05, 0.12, 0.2], light: [0.85, 0.9, 1], lightPower: 3.2,
    lightYaw: -50, lightPitch: 38, bloom: 0.11, glow: 1.6, fog: 0.25, exposure: 0.25, letterbox: 0.85, aberration: 0.45, grain: 0.05,
  });
  b.link(text, reveal, 'shape').link(build, reveal, 'progress').link(reveal, chrome, 'shape')
    .link(pos, comp, 'vector').link(comp, pal, 't').link(t1, pal, 'shift').link(pal, chrome, 'color')
    .link(chrome, out, 'shape')
    .link(parts, out, 'particles').link(dir, out, 'camera').link(flash, out, 'flash').link(glitch, out, 'glitch');
  b.doc.camera = { yaw: 0.25, pitch: 0.1, dist: 6.5, target: [0, 0, 0] };
  return b.doc;
}

function shotReel(): GraphDoc {
  const b = new Builder('Shot Reel', 12);
  const t1 = b.add('text', COL(0), 0, { size: 1.3, depth: 0.5 }, { text: 'DROP', font: 'condensed' });
  const bulb = b.add('mandelbulb', COL(0), 220, { scale: 1.25 });
  const gyr = b.add('gyroid', COL(0), 420, { scale: 5, thickness: 0.05 });
  const ball = b.add('sphere', COL(0), 600, { radius: 1.35 });
  const gi = b.add('intersect', COL(1), 480);
  const t2 = b.add('text', COL(0), 760, { size: 0.95, depth: 0.35 }, { text: 'the bass', font: 'serif' });
  const shots = b.add('shots', COL(2), 120, { shot: 3, length: 0.9, edge: 7, edgeColor: [1, 0.25, 0.65] }, { transition: 'dissolve' });
  const bass = b.add('audio', COL(2), 620, { gain: 0.12, offset: 1 }, { band: 'bass' });
  const xf = b.add('transform', COL(3), 120);
  const spin = b.add('time', COL(2), 800, { speed: 20 });
  const rot = b.add('vec3', COL(3), 700);
  const dist = b.add('distance', COL(3), 900);
  const tt = b.add('time', COL(3), 1040, { speed: 0.2 });
  const pal = b.add('palette', COL(4), 900, {}, { preset: 'neon' });
  const mat = b.add('material', COL(4), 120, { roughness: 0.25, metallic: 0.7, emission: 0.25, iridescence: 0.35 });
  const beat = b.add('audio', COL(5), 700, { gain: 0.18 }, { band: 'beat' });
  const hue = b.add('lfo', COL(5), 880, { freq: 0.05, amp: 0.08 });
  const parts = b.add('particles', COL(5), 1040, { count: 120000, size: 0.008, speed: 1.1, turbulence: 1.4, cling: 0.15, life: 2, intensity: 3.5, color: [1, 0.4, 0.8], color2: [0.2, 0.6, 1] }, { emitter: 'burst' });
  const dir = b.add('director', COL(6), 520, { distance: 5.5, shot: 3, shake: 0.5, seed: 11, arc: 120 }, { mode: 'director', cut: 'cut' });
  const out = b.add('output', COL(7), 120, {
    sky: [0.01, 0.0, 0.02], horizon: [0.2, 0.03, 0.18], light: [1, 0.85, 0.95], lightPower: 3,
    lightYaw: 70, lightPitch: 35, bloom: 0.14, glow: 2, fog: 0.2, exposure: 0.2, letterbox: 0.5, aberration: 0.7,
  });
  b.link(t1, shots, 'a').link(bulb, shots, 'b').link(gyr, gi, 'a').link(ball, gi, 'b').link(gi, shots, 'c').link(t2, shots, 'd')
    .link(shots, xf, 'shape').link(bass, xf, 'scale').link(spin, rot, 'y').link(rot, xf, 'rotate')
    .link(xf, mat, 'shape').link(dist, pal, 't').link(tt, pal, 'shift').link(pal, mat, 'color')
    .link(mat, out, 'shape').link(beat, out, 'flash').link(hue, out, 'hue').link(parts, out, 'particles').link(dir, out, 'camera');
  b.doc.camera = { yaw: 0.6, pitch: 0.2, dist: 5.5, target: [0, 0, 0] };
  return b.doc;
}

function audioReactor(): GraphDoc {
  const b = new Builder('Audio Reactor', 16);
  const bass = b.add('audio', COL(0), 0, { gain: 0.55 }, { band: 'bass' });
  const t = b.add('time', COL(0), 200, { speed: 0.6 });
  const noise = b.add('noisefield', COL(1), 160, { scale: 1.1, detail: 3 });
  const core = b.add('sphere', COL(1), 0, { radius: 1 });
  const disp = b.add('displace', COL(2), 0);
  const coreMat = b.add('material', COL(3), 0, { color: [0.04, 0.04, 0.05], roughness: 0.1, metallic: 1, iridescence: 0.8 });
  const cube = b.add('box', COL(1), 420, { size: [0.12, 0.12, 0.12], round: 0.02 });
  const scat = b.add('scatter', COL(2), 380, { spacing: 0.75, density: 0.35, radius: 3.6, spin: 1 });
  const t2 = b.add('time', COL(1), 640, { speed: 0.8 });
  const shell = b.add('sphere', COL(2), 700, { radius: 1.75 });
  const carve = b.add('subtract', COL(3), 420, { smooth: 0.2 });
  const high = b.add('audio', COL(3), 700, { gain: 9, offset: 0.5 }, { band: 'high' });
  const pal = b.add('palette', COL(4), 700, {}, { preset: 'acid' });
  const comp = b.add('component', COL(3), 880, {}, { axis: 'length' });
  const pos = b.add('position', COL(2), 900);
  const cubeMat = b.add('material', COL(4), 420, { roughness: 0.3 });
  const all = b.add('union', COL(5), 160, { smooth: 0.05 });
  const beat = b.add('audio', COL(5), 520, { gain: 0.25 }, { band: 'beat' });
  const parts = b.add('particles', COL(5), 700, { count: 150000, size: 0.007, speed: 0.9, turbulence: 1.2, cling: 0, life: 3.5, spread: 2.3, intensity: 3, color: [0.6, 1, 0.3], color2: [1, 0.3, 0.2] }, { emitter: 'ring' });
  const dir = b.add('director', COL(6), 360, { distance: 7.5, height: 1.5, shot: 4, shake: 0.4, seed: 21 }, { mode: 'director', cut: 'whip' });
  const out = b.add('output', COL(7), 100, {
    sky: [0.0, 0.0, 0.0], horizon: [0.05, 0.08, 0.02], light: [0.9, 1, 0.8], lightPower: 2.8,
    lightYaw: 30, lightPitch: 60, bloom: 0.13, glow: 1.8, fog: 0.15, exposure: 0.3, aberration: 0.5,
  });
  b.link(t, noise, 'evolve').link(core, disp, 'shape').link(noise, disp, 'field').link(bass, disp, 'amount').link(disp, coreMat, 'shape')
    .link(cube, scat, 'shape').link(t2, scat, 'evolve').link(scat, carve, 'a').link(shell, carve, 'b').link(carve, cubeMat, 'shape')
    .link(pos, comp, 'vector').link(comp, pal, 't').link(pal, cubeMat, 'color').link(high, cubeMat, 'emission')
    .link(coreMat, all, 'a').link(cubeMat, all, 'b').link(all, out, 'shape')
    .link(beat, out, 'glitch').link(parts, out, 'particles').link(dir, out, 'camera');
  b.doc.camera = { yaw: 0.4, pitch: 0.3, dist: 7.5, target: [0, 0, 0] };
  return b.doc;
}

function typeLab(): GraphDoc {
  const b = new Builder('Type Lab', 9);
  const w1 = b.add('text', COL(0), 0, { size: 1.6, depth: 0.6, bevel: 0.04 }, { text: 'MAKE', font: 'grotesk' });
  const w2 = b.add('text', COL(0), 200, { size: 2.2, depth: 0.5, bevel: 0.05 }, { text: 'it', font: 'script' });
  const w3 = b.add('text', COL(0), 400, { size: 1.9, depth: 0.8, bevel: 0.03 }, { text: 'LOUD', font: 'condensed' });
  const shots = b.add('shots', COL(1), 100, { shot: 1.5, length: 0.45 }, { transition: 'pop' });
  const wave = b.add('wavefield', COL(1), 560, { freq: 2.5 }, { mode: 'x' });
  const t = b.add('time', COL(0), 620, { speed: 4 });
  const disp = b.add('displace', COL(2), 100, { amount: 0.08 });
  const pos = b.add('position', COL(2), 520);
  const comp = b.add('component', COL(3), 520, {}, { axis: 'y' });
  const pal = b.add('palette', COL(4), 520, {}, { preset: 'sunset' });
  const mat = b.add('material', COL(3), 100, { roughness: 0.18, metallic: 0.3, iridescence: 0.5, emission: 0.15 });
  const floor = b.add('floor', COL(3), 760, { height: -1.3 });
  const fm = b.add('material', COL(4), 760, { color: [0.9, 0.35, 0.2], roughness: 0.35 });
  const scene = b.add('union', COL(5), 300, { smooth: 0.25 });
  const parts = b.add('particles', COL(5), 620, { count: 80000, size: 0.006, speed: 1.4, turbulence: 0.6, cling: 0, gravity: 0.6, life: 3, spread: 4, intensity: 2.5, color: [1, 0.9, 0.7], color2: [1, 0.4, 0.2] }, { emitter: 'rain' });
  const dir = b.add('director', COL(6), 300, { distance: 7, height: 0.8, shot: 1.5, shake: 0.2, arc: 70, seed: 4 }, { mode: 'vertigo', cut: 'cut' });
  const beat = b.add('pulse', COL(6), 620, { bpm: 80, decay: 9, amp: 0.25 });
  const out = b.add('output', COL(7), 100, {
    sky: [0.9, 0.4, 0.25], horizon: [1, 0.75, 0.55], light: [1, 0.95, 0.9], lightPower: 3.4,
    lightYaw: 35, lightPitch: 50, bloom: 0.06, glow: 1, fog: 0.4, exposure: -0.2, vignette: 0.5,
  });
  b.link(w1, shots, 'a').link(w2, shots, 'b').link(w3, shots, 'c')
    .link(shots, disp, 'shape').link(t, wave, 'phase').link(wave, disp, 'field').link(disp, mat, 'shape')
    .link(pos, comp, 'vector').link(comp, pal, 't').link(pal, mat, 'color')
    .link(floor, fm, 'shape').link(mat, scene, 'a').link(fm, scene, 'b').link(scene, out, 'shape')
    .link(parts, out, 'particles').link(dir, out, 'camera').link(beat, out, 'flash');
  b.doc.camera = { yaw: 0, pitch: 0.1, dist: 7, target: [0, 0, 0] };
  return b.doc;
}

function particleStorm(): GraphDoc {
  const b = new Builder('Particle Storm', 14);
  const torus = b.add('torus', COL(0), 0, { major: 1.4, minor: 0.32 });
  const tw = b.add('twist', COL(1), 0, { amount: 1.6 });
  const xf = b.add('transform', COL(2), 0, { rotate: [90, 0, 0] });
  const oct = b.add('octahedron', COL(0), 260, { size: 1.6 });
  const shell = b.add('onion', COL(1), 260, { thickness: 0.05 });
  const gyr = b.add('gyroid', COL(1), 440, { scale: 6, thickness: 0.06 });
  const inter = b.add('intersect', COL(2), 300);
  const shots = b.add('shots', COL(3), 100, { shot: 3.5, length: 1.1 }, { transition: 'slice' });
  const spin = b.add('time', COL(2), 620, { speed: 12 });
  const rot = b.add('vec3', COL(3), 560, { x: 10 });
  const xf2 = b.add('transform', COL(4), 100);
  const mat = b.add('material', COL(5), 100, { color: [0.05, 0.05, 0.06], roughness: 0.05, metallic: 1, iridescence: 0.25 });
  const parts = b.add('particles', COL(5), 400, { count: 400000, size: 0.006, speed: 1.2, turbulence: 1.6, cling: 0.45, life: 4, spread: 3.2, intensity: 1.6, color: [0.2, 0.7, 1], color2: [1, 0.25, 0.4] }, { emitter: 'sphere' });
  const dir = b.add('director', COL(6), 300, { distance: 6.5, height: 1, shot: 3.5, shake: 0.3, seed: 2 }, { mode: 'spiral', cut: 'smooth' });
  const out = b.add('output', COL(7), 100, {
    sky: [0, 0, 0.005], horizon: [0.02, 0.03, 0.08], light: [0.7, 0.8, 1], lightPower: 2.2,
    lightYaw: -30, lightPitch: 40, bloom: 0.16, glow: 1, fog: 0.1, exposure: 0.4, aberration: 0.6, letterbox: 0.4,
  });
  b.link(torus, tw, 'shape').link(tw, xf, 'shape').link(xf, shots, 'a')
    .link(oct, shell, 'shape').link(shell, inter, 'a').link(gyr, inter, 'b').link(inter, shots, 'b')
    .link(shots, xf2, 'shape').link(spin, rot, 'y').link(rot, xf2, 'rotate').link(xf2, mat, 'shape')
    .link(mat, out, 'shape').link(parts, out, 'particles').link(dir, out, 'camera');
  b.doc.camera = { yaw: 0.5, pitch: 0.3, dist: 6.5, target: [0, 0, 0] };
  return b.doc;
}

export const DEMOS: { name: string; build: () => GraphDoc }[] = [
  { name: 'Title Sequence', build: titleSequence },
  { name: 'Shot Reel', build: shotReel },
  { name: 'Audio Reactor', build: audioReactor },
  { name: 'Type Lab', build: typeLab },
  { name: 'Particle Storm', build: particleStorm },
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
