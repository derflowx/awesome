import { getDef } from './registry';
import { topoOrder } from './graph';
import type { CpuValue, GraphDoc, GraphNode, Link, Vec3 } from './types';

export type NodeDomain = 'cpu' | 'gpu';

export interface Analysis {
  order: GraphNode[];
  domain: Map<number, NodeDomain>;
  /** Links that cannot be honoured (a GPU field wired into a CPU-only input). */
  invalidLinks: Set<number>;
  linkInto: Map<string, Link>;
}

const key = (node: number, input: string) => `${node}:${input}`;

/**
 * Domain inference: signals live on the CPU, fields and shapes on the GPU.
 * "any" nodes (math, color...) go to the GPU only if one of their inputs does.
 */
export function analyze(doc: GraphDoc): Analysis {
  const order = topoOrder(doc);
  const domain = new Map<number, NodeDomain>();
  const invalidLinks = new Set<number>();
  const linkInto = new Map<string, Link>();
  for (const l of doc.links) linkInto.set(key(l.to, l.input), l);

  for (const node of order) {
    const def = getDef(node.type);
    const incoming = doc.links.filter((l) => l.to === node.id);
    if (def.domain === 'gpu') {
      domain.set(node.id, 'gpu');
    } else if (def.domain === 'cpu') {
      domain.set(node.id, 'cpu');
      for (const l of incoming) {
        const srcDom = domain.get(l.from);
        const inType = def.inputs.find((i) => i.name === l.input)?.type;
        // Output's shape socket is the one place GPU data enters a CPU node.
        if (srcDom === 'gpu' && inType !== 'sdf') invalidLinks.add(l.id);
      }
    } else {
      const gpu = incoming.some((l) => domain.get(l.from) === 'gpu');
      domain.set(node.id, gpu ? 'gpu' : 'cpu');
    }
  }
  return { order, domain, invalidLinks, linkInto };
}

export const asVec3 = (v: CpuValue | undefined): Vec3 =>
  typeof v === 'number' ? [v, v, v] : Array.isArray(v) ? v : [0, 0, 0];
export const asFloat = (v: CpuValue | undefined): number =>
  typeof v === 'number' ? v : Array.isArray(v) ? v[0] : 0;

/**
 * Evaluates all CPU-domain nodes for a given time. Stateful nodes (springs)
 * are simulated with a fixed timestep, and re-simulated from t=0 whenever
 * time jumps, so scrubbing is fully deterministic.
 */
export class Evaluator {
  values = new Map<number, CpuValue>();
  private state = new Map<number, Record<string, number>>();
  private lastT = 0;
  private hasRun = false;
  static readonly DT = 1 / 120;

  reset(): void {
    this.state.clear();
    this.hasRun = false;
  }

  evaluate(doc: GraphDoc, an: Analysis, t: number): Map<number, CpuValue> {
    const cpuNodes = an.order.filter((n) => an.domain.get(n.id) === 'cpu' && getDef(n.type).cpu);
    const stateful = cpuNodes.some((n) => getDef(n.type).stateful);
    if (!stateful) {
      this.step(doc, an, cpuNodes, t, 0, false);
      this.lastT = t;
      return this.values;
    }
    const DT = Evaluator.DT;
    let from = this.lastT;
    if (!this.hasRun || t < this.lastT - 1e-9 || t - this.lastT > 0.5) {
      // Time jumped: replay from zero.
      this.state.clear();
      this.step(doc, an, cpuNodes, 0, DT, true);
      from = 0;
    }
    const target = Math.min(t, 600);
    let cur = from;
    while (cur + DT <= target + 1e-9) {
      cur += DT;
      this.step(doc, an, cpuNodes, cur, DT, false);
    }
    // Final evaluation at the exact time for stateless nodes (no state advance).
    this.step(doc, an, cpuNodes, t, 0, false);
    this.lastT = cur;
    this.hasRun = true;
    return this.values;
  }

  private step(doc: GraphDoc, an: Analysis, nodes: GraphNode[], t: number, dt: number, reset: boolean): void {
    for (const node of nodes) {
      const def = getDef(node.type);
      const inputs: Record<string, CpuValue> = {};
      for (const inp of def.inputs) {
        if (inp.type === 'sdf') continue;
        if (inp.type === 'camera' || inp.type === 'particles') {
          const l = an.linkInto.get(key(node.id, inp.name));
          const v = l ? this.values.get(l.from) : undefined;
          if (v !== undefined) inputs[inp.name] = v;
          continue;
        }
        inputs[inp.name] = readInput(doc, an, this.values, node, inp.name);
      }
      let st = this.state.get(node.id);
      if (!st) this.state.set(node.id, (st = {}));
      if (def.stateful && dt === 0 && !reset) {
        // Peek without advancing the simulation.
        const x = st.x;
        this.values.set(node.id, x ?? asFloat(inputs.target));
        continue;
      }
      this.values.set(node.id, def.cpu!(inputs, { t, dt, state: st, reset, params: node.params }));
    }
  }
}

/** Value of a node input on the CPU: upstream CPU value, or its literal. */
export function readInput(doc: GraphDoc, an: Analysis, values: Map<number, CpuValue>, node: GraphNode, name: string): CpuValue {
  const def = getDef(node.type);
  const inp = def.inputs.find((i) => i.name === name)!;
  const link = an.linkInto.get(key(node.id, name));
  let v: CpuValue | undefined;
  if (link && !an.invalidLinks.has(link.id) && an.domain.get(link.from) === 'cpu') v = values.get(link.from);
  void doc;
  if (inp.type === 'camera' || inp.type === 'particles') return v as CpuValue;
  if (v === undefined) v = node.values[name] ?? inp.default ?? 0;
  return inp.type === 'float' ? asFloat(v) : asVec3(v);
}
