import type { Graph } from '../graph/graph';
import type { History } from '../graph/history';
import type { Analysis } from '../graph/evaluate';
import { CATEGORY_COLORS, getDef, type NodeDef } from '../graph/registry';
import { canConnect, TYPE_COLORS, type CpuValue, type GraphNode, type Keyframe, type SocketType, type Vec3 } from '../graph/types';
import { QuickAdd } from './quickadd';
import { colorField, CurveEditor, el, enumField, fmt, numberField, Sparkline } from './widgets';

const SVGNS = 'http://www.w3.org/2000/svg';

interface WireDrag {
  fromNode?: number;
  toNode?: number;
  toInput?: string;
  type: SocketType;
  start: [number, number];
}

export class NodeEditor {
  readonly root: HTMLElement;
  private world: HTMLElement;
  private svg: SVGSVGElement;
  private tempWire: SVGPathElement;
  private nodeEls = new Map<number, HTMLElement>();
  private wireEls = new Map<number, SVGPathElement>();
  private sparks = new Map<number, Sparkline>();
  private curves = new Map<number, CurveEditor>();
  private liveLabels = new Map<string, HTMLElement>();
  private quick: QuickAdd;
  private view = { x: 40, y: 30, z: 0.8 };
  private an: Analysis | null = null;
  private mouse: [number, number] = [200, 200];
  private hovering = false;
  private clipboard: { nodes: GraphNode[]; links: { from: number; to: number; input: string }[] } | null = null;
  selection = new Set<number>();
  onStatus: (msg: string, kind?: 'info' | 'error') => void = () => {};

  constructor(host: HTMLElement, private graph: Graph, private history: History) {
    this.root = el('div', 'ne');
    this.world = el('div', 'ne-world');
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.classList.add('ne-wires');
    this.tempWire = document.createElementNS(SVGNS, 'path');
    this.tempWire.classList.add('wire', 'temp');
    this.svg.append(this.tempWire);
    this.world.append(this.svg);
    this.root.append(this.world);
    const hint = el('div', 'ne-hint', 'Tab / double-click: add node · drag wires from sockets · wheel: zoom · drag background: pan · F: frame all');
    this.root.append(hint);
    host.append(this.root);
    this.quick = new QuickAdd(this.root);
    this.bindRoot();
    this.applyView();
  }

  // ---------------------------------------------------------------- view
  private applyView(): void {
    const { x, y, z } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    this.root.style.backgroundPosition = `${x}px ${y}px`;
    this.root.style.backgroundSize = `${28 * z}px ${28 * z}px`;
  }

  private toWorld(cx: number, cy: number): [number, number] {
    const r = this.root.getBoundingClientRect();
    return [(cx - r.left - this.view.x) / this.view.z, (cy - r.top - this.view.y) / this.view.z];
  }

  frameAll(): void {
    const nodes = this.graph.doc.nodes;
    if (!nodes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      const e = this.nodeEls.get(n.id);
      const w = e?.offsetWidth ?? 230, h = e?.offsetHeight ?? 120;
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + w); y1 = Math.max(y1, n.y + h);
    }
    const r = this.root.getBoundingClientRect();
    const pad = 40;
    const z = Math.min(1.1, Math.max(0.2, Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0))));
    this.view = { z, x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z };
    this.applyView();
  }

  // ---------------------------------------------------------------- build
  rebuild(): void {
    for (const e of this.nodeEls.values()) e.remove();
    for (const w of this.wireEls.values()) w.remove();
    this.nodeEls.clear();
    this.wireEls.clear();
    this.liveLabels.clear();
    this.curves.clear();
    const alive = new Set(this.graph.doc.nodes.map((n) => n.id));
    for (const id of [...this.sparks.keys()]) if (!alive.has(id)) this.sparks.delete(id);
    for (const id of [...this.selection]) if (!alive.has(id)) this.selection.delete(id);
    for (const n of this.graph.doc.nodes) {
      const e = this.buildNode(n);
      this.nodeEls.set(n.id, e);
      this.world.append(e);
    }
    for (const l of this.graph.doc.links) {
      const p = document.createElementNS(SVGNS, 'path');
      p.classList.add('wire');
      const t = getDef(this.graph.node(l.from)!.type).output!;
      p.style.setProperty('--wire', TYPE_COLORS[t]);
      this.svg.insertBefore(p, this.tempWire);
      this.wireEls.set(l.id, p);
    }
    if (this.an) this.setAnalysis(this.an);
    this.updateWires();
  }

  private buildNode(n: GraphNode): HTMLElement {
    const def = getDef(n.type);
    const e = el('div', 'node');
    e.dataset.id = String(n.id);
    e.style.left = `${n.x}px`;
    e.style.top = `${n.y}px`;
    e.style.setProperty('--cat', CATEGORY_COLORS[def.category]);
    if (def.type === 'output') e.classList.add('node-output');
    if (this.selection.has(n.id)) e.classList.add('selected');
    e.title = def.description;

    const head = el('div', 'node-head');
    head.append(el('span', 'node-title', def.title), el('span', 'node-dom'));
    if (def.output) {
      const s = el('span', 'sock out');
      s.dataset.type = def.output;
      s.style.setProperty('--sock', TYPE_COLORS[def.output]);
      s.addEventListener('pointerdown', (ev) => this.startWire(ev, { fromNode: n.id, type: def.output! }));
      head.append(s);
    }
    head.addEventListener('pointerdown', (ev) => this.startNodeDrag(ev, n.id));
    e.append(head);

    const body = el('div', 'node-body');
    body.addEventListener('pointerdown', (ev) => {
      if (ev.button === 0) this.select(n.id, ev.shiftKey);
      ev.stopPropagation();
    });

    for (const p of def.params ?? []) {
      if (p.kind === 'enum') {
        const row = el('div', 'row param');
        row.append(el('span', 'row-label', p.label ?? p.name));
        row.append(
          enumField(String(n.params[p.name]), p.options, (v) => {
            this.graph.setParam(n.id, p.name, v);
            this.history.commit();
          }),
        );
        body.append(row);
      } else if (p.kind === 'keys') {
        const keys = (n.params[p.name] as Keyframe[]) ?? [];
        const ce = new CurveEditor(
          keys,
          () => ({ interp: String(n.params.interp ?? 'smooth'), loop: String(n.params.loop ?? 'loop') }),
          (k) => this.graph.setParam(n.id, p.name, k),
          () => this.history.commit(),
        );
        this.curves.set(n.id, ce);
        const wrap = el('div', 'row curve-row');
        wrap.append(ce.canvas);
        body.append(wrap);
      }
    }

    for (const inp of def.inputs) {
      const row = el('div', 'row');
      row.dataset.input = inp.name;
      const s = el('span', 'sock in');
      s.dataset.type = inp.type;
      s.style.setProperty('--sock', TYPE_COLORS[inp.type]);
      row.append(s);
      const link = this.graph.linkInto(n.id, inp.name);
      s.addEventListener('pointerdown', (ev) => {
        const cur = this.graph.linkInto(n.id, inp.name);
        if (cur) {
          // Pick up the existing wire and re-route it.
          const from = cur.from;
          this.graph.disconnect(n.id, inp.name);
          this.startWire(ev, { fromNode: from, type: getDef(this.graph.node(from)!.type).output! });
        } else {
          this.startWire(ev, { toNode: n.id, toInput: inp.name, type: inp.type });
        }
      });
      const label = inp.label ?? inp.name;
      if (link) {
        row.classList.add('linked');
        row.append(el('span', 'row-label', label));
        if (inp.type !== 'sdf') {
          const live = el('span', 'row-live');
          this.liveLabels.set(`${n.id}:${inp.name}`, live);
          row.append(live);
        }
      } else if (inp.type === 'float') {
        row.append(
          numberField({
            label,
            value: n.values[inp.name] as number,
            min: inp.min,
            max: inp.max,
            step: inp.step,
            onInput: (v) => this.graph.setValue(n.id, inp.name, v),
            onCommit: () => this.history.commit(),
          }),
        );
      } else if (inp.type === 'vec3') {
        row.classList.add('vec-row');
        row.append(el('span', 'row-label', label));
        const vec = el('div', 'vec');
        const cur = [...((n.values[inp.name] as Vec3) ?? [0, 0, 0])] as Vec3;
        ['x', 'y', 'z'].forEach((axis, k) => {
          vec.append(
            numberField({
              label: axis,
              value: cur[k],
              step: inp.step,
              onInput: (v) => {
                cur[k] = v;
                this.graph.setValue(n.id, inp.name, [...cur] as Vec3);
              },
              onCommit: () => this.history.commit(),
            }),
          );
        });
        row.append(vec);
      } else if (inp.type === 'color') {
        row.append(el('span', 'row-label', label));
        row.append(
          colorField(
            (n.values[inp.name] as Vec3) ?? [1, 1, 1],
            (v) => this.graph.setValue(n.id, inp.name, v),
            () => this.history.commit(),
          ),
        );
      } else {
        row.append(el('span', 'row-label', label));
      }
      body.append(row);
    }

    if ((def.domain === 'cpu' || def.domain === 'any') && def.output === 'float') {
      let sp = this.sparks.get(n.id);
      if (!sp) this.sparks.set(n.id, (sp = new Sparkline(CATEGORY_COLORS[def.category])));
      const wrap = el('div', 'row spark-row');
      wrap.append(sp.canvas);
      body.append(wrap);
    }
    e.append(body);
    return e;
  }

  setAnalysis(an: Analysis): void {
    this.an = an;
    for (const [id, e] of this.nodeEls) {
      const d = an.domain.get(id) ?? 'cpu';
      const dom = e.querySelector('.node-dom')!;
      const def = getDef(this.graph.node(id)!.type);
      dom.textContent = def.type === 'output' ? '' : d.toUpperCase();
      e.classList.toggle('dom-gpu', d === 'gpu');
      e.classList.toggle('dom-cpu', d === 'cpu');
    }
    for (const l of this.graph.doc.links) {
      const w = this.wireEls.get(l.id);
      if (!w) continue;
      w.classList.toggle('invalid', an.invalidLinks.has(l.id));
      w.classList.toggle('signal', an.domain.get(l.from) === 'cpu');
    }
  }

  private sockPos(elm: Element): [number, number] {
    const r = elm.getBoundingClientRect();
    return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  private static path(a: [number, number], b: [number, number]): string {
    const dx = Math.max(40, Math.abs(b[0] - a[0]) * 0.5);
    return `M${a[0]},${a[1]} C${a[0] + dx},${a[1]} ${b[0] - dx},${b[1]} ${b[0]},${b[1]}`;
  }

  updateWires(onlyNodes?: Set<number>): void {
    for (const l of this.graph.doc.links) {
      if (onlyNodes && !onlyNodes.has(l.from) && !onlyNodes.has(l.to)) continue;
      const w = this.wireEls.get(l.id);
      const fromEl = this.nodeEls.get(l.from)?.querySelector('.sock.out');
      const toEl = this.nodeEls.get(l.to)?.querySelector(`.row[data-input="${l.input}"] .sock.in`);
      if (!w || !fromEl || !toEl) continue;
      w.setAttribute('d', NodeEditor.path(this.sockPos(fromEl), this.sockPos(toEl)));
    }
  }

  /** Per-frame: sparklines, live values on linked inputs, curve playheads. */
  updateLive(values: Map<number, CpuValue>, t: number): void {
    if (!this.an) return;
    for (const [id, sp] of this.sparks) {
      const v = values.get(id);
      const isCpu = this.an.domain.get(id) === 'cpu';
      sp.canvas.parentElement?.classList.toggle('hidden', !isCpu);
      if (isCpu && typeof v === 'number') sp.push(v);
    }
    for (const [k, label] of this.liveLabels) {
      const [nid, inp] = k.split(':');
      const link = this.an.linkInto.get(k);
      if (!link) continue;
      if (this.an.domain.get(link.from) === 'gpu') {
        label.textContent = 'field';
        continue;
      }
      const v = values.get(link.from);
      label.textContent = v === undefined ? '' : typeof v === 'number' ? fmt(v) : v.map((x) => x.toFixed(2)).join(' ');
      void nid; void inp;
    }
    for (const ce of this.curves.values()) ce.setPlayhead(t);
  }

  // ---------------------------------------------------------------- selection
  select(id: number, additive: boolean): void {
    if (!additive && !this.selection.has(id)) this.selection.clear();
    this.selection.add(id);
    this.paintSelection();
  }
  private paintSelection(): void {
    for (const [id, e] of this.nodeEls) e.classList.toggle('selected', this.selection.has(id));
  }

  // ---------------------------------------------------------------- interactions
  private bindRoot(): void {
    const r = this.root;
    r.addEventListener('pointerenter', () => (this.hovering = true));
    r.addEventListener('pointerleave', () => (this.hovering = false));
    r.addEventListener('pointermove', (e) => {
      const b = r.getBoundingClientRect();
      this.mouse = [e.clientX - b.left, e.clientY - b.top];
    });
    r.addEventListener('pointerdown', (e) => {
      const tgt = e.target as Element;
      if (tgt !== r && tgt !== this.world && tgt !== this.svg && !tgt.classList.contains('ne-hint')) return;
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      r.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY;
      const v0 = { ...this.view };
      let moved = false;
      r.classList.add('panning');
      const move = (ev: PointerEvent) => {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) moved = true;
        this.view.x = v0.x + ev.clientX - sx;
        this.view.y = v0.y + ev.clientY - sy;
        this.applyView();
      };
      const up = () => {
        r.classList.remove('panning');
        r.removeEventListener('pointermove', move);
        r.removeEventListener('pointerup', up);
        if (!moved) {
          this.selection.clear();
          this.paintSelection();
        }
      };
      r.addEventListener('pointermove', move);
      r.addEventListener('pointerup', up);
    });
    r.addEventListener(
      'wheel',
      (e) => {
        if ((e.target as Element).closest('.quickadd')) return;
        e.preventDefault();
        const b = r.getBoundingClientRect();
        const mx = e.clientX - b.left, my = e.clientY - b.top;
        const z0 = this.view.z;
        const z = Math.min(2, Math.max(0.15, z0 * Math.exp(-e.deltaY * 0.0015)));
        this.view.x = mx - ((mx - this.view.x) / z0) * z;
        this.view.y = my - ((my - this.view.y) / z0) * z;
        this.view.z = z;
        this.applyView();
      },
      { passive: false },
    );
    r.addEventListener('dblclick', (e) => {
      const tgt = e.target as Element;
      if (tgt === r || tgt === this.world || tgt === this.svg) this.openQuickAdd();
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.hovering || this.quick.open) return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Tab' || (e.key === 'a' && !mod) || (e.key === 'A' && e.shiftKey)) {
      e.preventDefault();
      this.openQuickAdd();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.graph.removeNodes(this.selection);
      this.history.commit();
    } else if (mod && e.key === 'd') {
      e.preventDefault();
      this.copy();
      this.paste(30);
    } else if (mod && e.key === 'c') {
      this.copy();
    } else if (mod && e.key === 'v') {
      this.paste(40);
    } else if (mod && e.key === 'a') {
      e.preventDefault();
      this.graph.doc.nodes.forEach((n) => this.selection.add(n.id));
      this.paintSelection();
    } else if (e.key === 'f' && !mod) {
      this.frameAll();
    }
  }

  private copy(): void {
    const ids = new Set([...this.selection].filter((id) => this.graph.node(id)?.type !== 'output'));
    if (!ids.size) return;
    this.clipboard = {
      nodes: this.graph.doc.nodes.filter((n) => ids.has(n.id)).map((n) => structuredClone(n)),
      links: this.graph.doc.links.filter((l) => ids.has(l.from) && ids.has(l.to)).map(({ from, to, input }) => ({ from, to, input })),
    };
  }

  private paste(offset: number): void {
    if (!this.clipboard) return;
    const map = new Map<number, number>();
    const doc = this.graph.doc;
    this.selection.clear();
    for (const n of this.clipboard.nodes) {
      const id = doc.nextId++;
      map.set(n.id, id);
      doc.nodes.push({ ...structuredClone(n), id, x: n.x + offset, y: n.y + offset });
      this.selection.add(id);
    }
    for (const l of this.clipboard.links) doc.links.push({ id: doc.nextId++, from: map.get(l.from)!, to: map.get(l.to)!, input: l.input });
    // Shift the clipboard so repeated pastes cascade.
    this.clipboard.nodes.forEach((n) => { n.x += offset; n.y += offset; });
    this.graph.emit('structure');
    this.history.commit();
  }

  private openQuickAdd(filter: { accepts?: SocketType; produces?: SocketType } = {}, at?: [number, number], then?: (n: GraphNode) => void): void {
    const pos = at ?? this.mouse;
    const r = this.root.getBoundingClientRect();
    const [wx, wy] = this.toWorld(r.left + pos[0], r.top + pos[1]);
    this.quick.show(pos[0], pos[1], filter, (def: NodeDef) => {
      const n = this.graph.addNode(def.type, wx - 20, wy - 14);
      this.selection.clear();
      this.selection.add(n.id);
      then?.(n);
      this.history.commit();
    });
  }

  private startNodeDrag(e: PointerEvent, id: number): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    this.select(id, e.shiftKey);
    const head = e.currentTarget as HTMLElement;
    head.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY;
    const moving = [...this.selection].map((nid) => this.graph.node(nid)!).filter(Boolean);
    const starts = moving.map((n) => [n.x, n.y]);
    const ids = new Set(moving.map((n) => n.id));
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / this.view.z;
      const dy = (ev.clientY - sy) / this.view.z;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      moving.forEach((n, i) => {
        n.x = Math.round(starts[i][0] + dx);
        n.y = Math.round(starts[i][1] + dy);
        const ne = this.nodeEls.get(n.id)!;
        ne.style.left = `${n.x}px`;
        ne.style.top = `${n.y}px`;
      });
      this.updateWires(ids);
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      if (moved) {
        this.graph.emit('layout');
        this.history.commit();
      }
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  }

  private startWire(e: PointerEvent, d: Omit<WireDrag, 'start'>): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const sock = e.currentTarget as HTMLElement;
    const start = d.fromNode !== undefined
      ? this.sockPos(this.nodeEls.get(d.fromNode)?.querySelector('.sock.out') ?? sock)
      : this.sockPos(sock);
    const drag: WireDrag = { ...d, start };
    this.tempWire.style.setProperty('--wire', TYPE_COLORS[d.type]);
    this.tempWire.style.display = '';
    this.root.classList.add('wiring', `wiring-${d.fromNode !== undefined ? 'out' : 'in'}`);
    this.root.dataset.wireType = d.type;
    const draw = (cx: number, cy: number) => {
      const p = this.toWorld(cx, cy);
      this.tempWire.setAttribute('d', d.fromNode !== undefined ? NodeEditor.path(start, p) : NodeEditor.path(p, start));
    };
    draw(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => draw(ev.clientX, ev.clientY);
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.tempWire.style.display = 'none';
      this.root.classList.remove('wiring', 'wiring-out', 'wiring-in');
      this.finishWire(drag, ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private finishWire(d: WireDrag, ev: PointerEvent): void {
    const hit = document.elementFromPoint(ev.clientX, ev.clientY);
    const nodeEl = hit?.closest('.node') as HTMLElement | null;
    const report = (err: string | null) => {
      if (err) this.onStatus(err, 'error');
      this.history.commit();
    };
    if (d.fromNode !== undefined) {
      if (nodeEl) {
        const target = Number(nodeEl.dataset.id);
        const row = hit?.closest('.row[data-input]') as HTMLElement | null;
        const input = row?.dataset.input ?? this.firstCompatibleInput(target, d.type);
        if (input) report(this.graph.connect(d.fromNode, target, input));
        else report(`No ${d.type} input on that node`);
        return;
      }
      if (this.root.contains(hit)) {
        const r = this.root.getBoundingClientRect();
        const from = d.fromNode;
        this.openQuickAdd({ accepts: d.type }, [ev.clientX - r.left, ev.clientY - r.top], (n) => {
          const input = this.firstCompatibleInput(n.id, d.type);
          if (input) this.graph.connect(from, n.id, input);
        });
      }
      this.history.commit();
      return;
    }
    // Dragging backwards from an input.
    if (nodeEl) {
      const src = Number(nodeEl.dataset.id);
      report(this.graph.connect(src, d.toNode!, d.toInput!));
      return;
    }
    if (this.root.contains(hit)) {
      const r = this.root.getBoundingClientRect();
      const { toNode, toInput } = d;
      this.openQuickAdd({ produces: d.type }, [ev.clientX - r.left - 240, ev.clientY - r.top], (n) => {
        this.graph.connect(n.id, toNode!, toInput!);
      });
    }
  }

  private firstCompatibleInput(nodeId: number, type: SocketType): string | undefined {
    const n = this.graph.node(nodeId);
    if (!n) return;
    const ins = getDef(n.type).inputs.filter((i) => canConnect(type, i.type));
    return (ins.find((i) => !this.graph.linkInto(nodeId, i.name)) ?? ins[0])?.name;
  }
}
