import { asFloat, asVec3, readInput, type Analysis } from './graph/evaluate';
import { fillSlots, type CompileResult } from './graph/compile';
import type { CameraValue, CpuValue, GraphDoc, ParticleValue, Vec3 } from './graph/types';
import type { FrameInputs } from './gpu/renderer';
import type { TextAtlas } from './gpu/textAtlas';
import type { OrbitCamera } from './ui/camera';

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export interface Basis {
  pos: Vec3;
  fwd: Vec3;
  right: Vec3;
  up: Vec3;
  tanHalfFov: number;
}

export function basisFromCamera(c: CameraValue): Basis {
  const fwd = norm(sub(c.target, c.pos));
  const worldUp: Vec3 = Math.abs(fwd[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  let right = norm(cross(fwd, worldUp));
  let up = cross(right, fwd);
  if (c.roll) {
    const cr = Math.cos(c.roll), sr = Math.sin(c.roll);
    const r2 = right.map((x, i) => x * cr + up[i] * sr) as Vec3;
    up = up.map((x, i) => x * cr - right[i] * sr) as Vec3;
    right = r2;
  }
  return { pos: c.pos, fwd, right, up, tanHalfFov: Math.tan((Math.max(5, Math.min(150, c.fov)) * Math.PI) / 360) };
}

export interface FrameContext {
  doc: GraphDoc;
  an: Analysis;
  values: Map<number, CpuValue>;
  compiled: CompileResult;
  params: Float32Array;
  atlas: TextAtlas;
  t: number;
  orbit: OrbitCamera;
  /** Use the graph's camera (Director etc.) when one is wired into Output. */
  useGraphCamera: boolean;
}

export interface BuiltFrame {
  frame: FrameInputs;
  graphCamera: boolean;
  /** Values that, if unchanged, mean the image can keep refining. */
  signature: Float32Array;
}

export function buildFrame(c: FrameContext): BuiltFrame {
  const out = c.doc.nodes.find((n) => n.type === 'output');
  const get = (name: string): CpuValue | undefined => (out ? readInput(c.doc, c.an, c.values, out, name) : undefined);
  fillSlots(c.doc, c.an, c.values, c.compiled.slots, c.params, 0, (id) => c.atlas.info(id));

  const cam = get('camera') as CameraValue | undefined;
  const graphCamera = !!cam && cam.kind === 'camera';
  let b: Basis;
  if (graphCamera && c.useGraphCamera) b = basisFromCamera(cam!);
  else {
    const ob = c.orbit.basis();
    b = { ...ob, tanHalfFov: Math.tan((c.orbit.fov * Math.PI) / 360) };
  }

  const f = (name: string) => asFloat(get(name));
  const yaw = (f('lightYaw') * Math.PI) / 180;
  const pitch = (f('lightPitch') * Math.PI) / 180;
  const sunDir: Vec3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const lp = f('lightPower');
  const parts = get('particles') as ParticleValue | undefined;
  const frame: FrameInputs = {
    camPos: b.pos, right: b.right, up: b.up, fwd: b.fwd, tanHalfFov: b.tanHalfFov,
    sky: asVec3(get('sky')), horizon: asVec3(get('horizon')),
    sun: asVec3(get('light')).map((x) => x * lp) as Vec3, sunDir,
    glow: f('glow'), fog: f('fog'), time: c.t,
    steps: 180, sampleIndex: 0, params: c.params,
    exposure: f('exposure'), bloom: f('bloom'), vignette: f('vignette'), grain: f('grain'), aberration: f('aberration'),
    flash: f('flash'), glitch: f('glitch'), letterbox: f('letterbox'), hue: f('hue'),
    particles: parts && parts.kind === 'particles' ? parts : null,
    particleDt: 0,
    particleReset: false,
  };
  const signature = new Float32Array([
    ...b.pos, ...b.fwd, ...b.up, b.tanHalfFov, ...frame.sky, ...frame.horizon, ...frame.sun, ...sunDir,
    frame.glow, frame.fog, frame.flash, frame.glitch, frame.hue,
    ...c.params.subarray(0, c.compiled.slots.length * 4),
  ]);
  return { frame, graphCamera, signature };
}
