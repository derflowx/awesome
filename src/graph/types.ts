/** Value types that flow through sockets. */
export type SocketType = 'float' | 'vec3' | 'color' | 'sdf' | 'camera' | 'particles' | 'hud';

export type Vec3 = [number, number, number];

/** A camera pose produced by camera nodes. */
export interface CameraValue {
  kind: 'camera';
  pos: Vec3;
  target: Vec3;
  fov: number;
  roll: number;
}

/** Settings for the GPU particle system. */
export interface ParticleValue {
  kind: 'particles';
  emitter: string;
  count: number;
  size: number;
  speed: number;
  turbulence: number;
  cling: number;
  life: number;
  spread: number;
  intensity: number;
  color: Vec3;
  color2: Vec3;
  gravity: number;
  colorMode: string;
  streak: number;
  trails: number;
  vortex: number;
  attract: number;
}

/** A heads-up display drawn over the frame (live and in exports). */
export interface HudValue {
  kind: 'hud';
  style: string;
  opacity: number;
  color: Vec3;
  label: string;
  seed: number;
}

export type CpuValue = number | Vec3 | CameraValue | ParticleValue | HudValue;

/** Socket types that only connect to themselves and have no literal value. */
export const OPAQUE_TYPES: SocketType[] = ['sdf', 'camera', 'particles', 'hud'];
/** Opaque socket types carried by CPU values (everything except sdf). */
export const CPU_OBJECT_TYPES: SocketType[] = ['camera', 'particles', 'hud'];

export interface Keyframe {
  t: number;
  v: number;
}

/** A node instance stored in the graph document. */
export interface GraphNode {
  id: number;
  type: string;
  x: number;
  y: number;
  /** Literal values for inputs (used when the input is not connected). */
  values: Record<string, CpuValue>;
  /** Non-socket parameters: enums, keyframe lists, etc. */
  params: Record<string, unknown>;
}

export interface Link {
  id: number;
  from: number; // source node id (single output per node)
  to: number; // target node id
  input: string; // target input name
}

export interface CameraState {
  yaw: number;
  pitch: number;
  dist: number;
  target: Vec3;
}

export interface GraphDoc {
  version: 1;
  name: string;
  nodes: GraphNode[];
  links: Link[];
  nextId: number;
  duration: number;
  camera?: CameraState;
}

export function canConnect(from: SocketType, to: SocketType): boolean {
  if (from === to) return true;
  if (OPAQUE_TYPES.includes(from) || OPAQUE_TYPES.includes(to)) return false;
  if (to === 'float') return false; // vec3 -> float is ambiguous
  return true; // float -> vec3/color, vec3 <-> color
}

export const TYPE_COLORS: Record<SocketType, string> = {
  float: '#9aa4ff',
  vec3: '#ffcf5c',
  color: '#ff6ec7',
  sdf: '#3cf2c4',
  camera: '#f4f1ff',
  particles: '#ffb347',
  hud: '#ff3b3b',
};
