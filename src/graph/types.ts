/** Value types that flow through sockets. */
export type SocketType = 'float' | 'vec3' | 'color' | 'sdf';

export type Vec3 = [number, number, number];
export type CpuValue = number | Vec3;

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
  if (from === 'sdf' || to === 'sdf') return false;
  if (to === 'float') return false; // vec3 -> float is ambiguous
  return true; // float -> vec3/color, vec3 <-> color
}

export const TYPE_COLORS: Record<SocketType, string> = {
  float: '#9aa4ff',
  vec3: '#ffcf5c',
  color: '#ff6ec7',
  sdf: '#3cf2c4',
};
