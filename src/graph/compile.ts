import { getDef } from './registry';
import { readInput, type Analysis } from './evaluate';
import type { CpuValue, GraphDoc, GraphNode, SocketType } from './types';

export const MAX_SLOTS = 1024;

export interface Slot {
  node: number;
  input: string;
  type: SocketType;
}

export interface CompileResult {
  /** Generated WGSL: one function per GPU node plus `sceneMap`. */
  code: string;
  slots: Slot[];
  errors: string[];
  gpuNodes: number;
}

const WGSL_TYPE: Record<SocketType, string> = { float: 'f32', vec3: 'vec3f', color: 'vec3f', sdf: 'Sd' };

function convert(expr: string, from: SocketType, to: SocketType): string {
  if (from === 'float' && (to === 'vec3' || to === 'color')) return `vec3f(${expr})`;
  return expr;
}

/**
 * Compiles the GPU part of the graph into WGSL. Every literal and every CPU
 * signal feeding the GPU becomes a uniform slot, so tweaking values or
 * animating never recompiles - only topology and enum changes do.
 */
export function compileGraph(doc: GraphDoc, an: Analysis): CompileResult {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const slots: Slot[] = [];
  const slotIndex = new Map<string, number>();
  const fns: string[] = [];
  const emitted = new Set<number>();
  const errors: string[] = [];

  const slotFor = (node: GraphNode, input: string, type: SocketType): string => {
    const k = `${node.id}:${input}`;
    let idx = slotIndex.get(k);
    if (idx === undefined) {
      idx = slots.length;
      if (idx >= MAX_SLOTS) {
        if (!errors.length) errors.push(`Too many parameters (max ${MAX_SLOTS})`);
        idx = MAX_SLOTS - 1;
      } else {
        slots.push({ node: node.id, input, type });
      }
      slotIndex.set(k, idx);
    }
    return type === 'float' ? `U.p[${idx}].x` : `U.p[${idx}].xyz`;
  };

  const inputExpr = (node: GraphNode, name: string, at: string): string => {
    const def = getDef(node.type);
    const inp = def.inputs.find((i) => i.name === name);
    if (!inp) throw new Error(`${def.type} has no input ${name}`);
    const link = an.linkInto.get(`${node.id}:${name}`);
    if (link && !an.invalidLinks.has(link.id) && an.domain.get(link.from) === 'gpu') {
      const src = byId.get(link.from)!;
      emit(src);
      return convert(`n${src.id}(${at})`, getDef(src.type).output!, inp.type);
    }
    if (inp.type === 'sdf') return 'sdEmpty()';
    return slotFor(node, name, inp.type);
  };

  const emit = (node: GraphNode): void => {
    if (emitted.has(node.id)) return;
    emitted.add(node.id);
    const def = getDef(node.type);
    if (!def.gpu || !def.output) {
      errors.push(`${def.title} cannot run on the GPU`);
      return;
    }
    const body = def.gpu({
      in: (name, at = 'p') => inputExpr(node, name, at),
      param: <T,>(name: string) => node.params[name] as T,
    });
    fns.push(`// ${def.title} #${node.id}\nfn n${node.id}(p: vec3f) -> ${WGSL_TYPE[def.output]} {\n  ${body}\n}`);
  };

  const out = doc.nodes.find((n) => n.type === 'output');
  const shape = out ? inputExpr(out, 'shape', 'p') : 'sdEmpty()';
  fns.push(`fn sceneMap(p: vec3f) -> Sd {\n  return ${shape};\n}`);

  return { code: fns.join('\n\n'), slots, errors, gpuNodes: emitted.size };
}

/** Writes the current value of every slot into the uniform array (vec4 per slot). */
export function fillSlots(
  doc: GraphDoc,
  an: Analysis,
  values: Map<number, CpuValue>,
  slots: Slot[],
  out: Float32Array,
  offset: number,
): void {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  slots.forEach((s, i) => {
    const node = byId.get(s.node);
    if (!node) return;
    const v = readInput(doc, an, values, node, s.input);
    const o = offset + i * 4;
    if (typeof v === 'number') {
      out[o] = v;
      out[o + 1] = out[o + 2] = 0;
    } else {
      out[o] = v[0];
      out[o + 1] = v[1];
      out[o + 2] = v[2];
    }
  });
}
