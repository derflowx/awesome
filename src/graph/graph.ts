import { canConnect, type CpuValue, type GraphDoc, type GraphNode, type Link } from './types';
import { defaultParams, defaultValues, getDef, REGISTRY } from './registry';

export type ChangeKind = 'structure' | 'values' | 'layout' | 'load';
type Listener = (kind: ChangeKind) => void;

export function emptyDoc(): GraphDoc {
  return { version: 1, name: 'Untitled', nodes: [], links: [], nextId: 1, duration: 10 };
}

/** Mutable graph document with change notifications. */
export class Graph {
  doc: GraphDoc = emptyDoc();
  private listeners = new Set<Listener>();

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(kind: ChangeKind): void {
    for (const l of this.listeners) l(kind);
  }

  node(id: number): GraphNode | undefined {
    return this.doc.nodes.find((n) => n.id === id);
  }

  addNode(type: string, x: number, y: number): GraphNode {
    const def = getDef(type);
    const node: GraphNode = {
      id: this.doc.nextId++,
      type,
      x: Math.round(x),
      y: Math.round(y),
      values: defaultValues(def),
      params: defaultParams(def),
    };
    this.doc.nodes.push(node);
    this.emit('structure');
    return node;
  }

  removeNodes(ids: Iterable<number>): void {
    const set = new Set(ids);
    for (const id of set) if (this.node(id)?.type === 'output') set.delete(id); // keep the output
    if (!set.size) return;
    this.doc.nodes = this.doc.nodes.filter((n) => !set.has(n.id));
    this.doc.links = this.doc.links.filter((l) => !set.has(l.from) && !set.has(l.to));
    this.emit('structure');
  }

  linkInto(to: number, input: string): Link | undefined {
    return this.doc.links.find((l) => l.to === to && l.input === input);
  }

  /** Returns an error message, or null when connected. */
  connect(from: number, to: number, input: string): string | null {
    const a = this.node(from);
    const b = this.node(to);
    if (!a || !b) return 'Missing node';
    if (from === to) return 'Cannot connect a node to itself';
    const outType = getDef(a.type).output;
    const inDef = getDef(b.type).inputs.find((i) => i.name === input);
    if (!outType || !inDef) return 'Invalid socket';
    if (!canConnect(outType, inDef.type)) return `Cannot plug ${outType} into ${inDef.type}`;
    if (this.reaches(to, from)) return 'That would create a loop';
    this.doc.links = this.doc.links.filter((l) => !(l.to === to && l.input === input));
    this.doc.links.push({ id: this.doc.nextId++, from, to, input });
    this.emit('structure');
    return null;
  }

  disconnect(to: number, input: string): void {
    const before = this.doc.links.length;
    this.doc.links = this.doc.links.filter((l) => !(l.to === to && l.input === input));
    if (this.doc.links.length !== before) this.emit('structure');
  }

  /** True when `target` is reachable downstream from `start`. */
  reaches(start: number, target: number): boolean {
    const stack = [start];
    const seen = new Set<number>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const l of this.doc.links) if (l.from === cur) stack.push(l.to);
    }
    return false;
  }

  setValue(id: number, name: string, v: CpuValue): void {
    const nd = this.node(id);
    if (!nd) return;
    nd.values[name] = v;
    this.emit('values');
  }

  setParam(id: number, name: string, v: unknown): void {
    const nd = this.node(id);
    if (!nd) return;
    nd.params[name] = v;
    // Enum params change generated code; keyframes only change values.
    const def = getDef(nd.type).params?.find((p) => p.name === name);
    this.emit(def?.kind === 'enum' ? 'structure' : 'values');
  }

  load(doc: GraphDoc): void {
    const clean = structuredClone(doc);
    clean.nodes = clean.nodes.filter((n) => REGISTRY[n.type]);
    // Fill in values/params added in newer versions of a node.
    for (const n of clean.nodes) {
      const def = getDef(n.type);
      n.values = { ...defaultValues(def), ...n.values };
      n.params = { ...defaultParams(def), ...n.params };
    }
    const ids = new Set(clean.nodes.map((n) => n.id));
    clean.links = clean.links.filter((l) => ids.has(l.from) && ids.has(l.to));
    if (!clean.nodes.some((n) => n.type === 'output')) {
      clean.nodes.push({ id: clean.nextId++, type: 'output', x: 600, y: 100, values: defaultValues(getDef('output')), params: {} });
    }
    this.doc = clean;
    this.emit('load');
  }

  toJSON(): GraphDoc {
    return structuredClone(this.doc);
  }

  output(): GraphNode | undefined {
    return this.doc.nodes.find((n) => n.type === 'output');
  }
}

/** Topological order (sources first). Assumes the graph is acyclic. */
export function topoOrder(doc: GraphDoc): GraphNode[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const indeg = new Map<number, number>(doc.nodes.map((n) => [n.id, 0]));
  for (const l of doc.links) indeg.set(l.to, (indeg.get(l.to) ?? 0) + 1);
  const queue = doc.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const out: GraphNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    out.push(byId.get(id)!);
    for (const l of doc.links) {
      if (l.from !== id) continue;
      const d = (indeg.get(l.to) ?? 0) - 1;
      indeg.set(l.to, d);
      if (d === 0) queue.push(l.to);
    }
  }
  return out;
}
