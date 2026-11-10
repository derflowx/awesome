import { describe, expect, it } from 'vitest';
import { Graph } from '../src/graph/graph';
import { analyze, Evaluator } from '../src/graph/evaluate';
import { compileGraph, fillSlots, MAX_SLOTS } from '../src/graph/compile';
import { DEMOS, blankDoc } from '../src/demos';
import { NODE_DEFS, sampleKeys } from '../src/graph/registry';
import { kitchenSink } from './kitchenSink';

function demoGraph(name: string): Graph {
  const g = new Graph();
  g.load(DEMOS.find((d) => d.name === name)!.build());
  return g;
}

describe('graph editing', () => {
  it('rejects cycles and bad types', () => {
    const g = new Graph();
    g.load(blankDoc());
    const [sphere, mat] = g.doc.nodes;
    expect(g.connect(mat.id, sphere.id, 'radius')).toMatch(/Cannot plug/);
    const t = g.addNode('time', 0, 0);
    const m = g.addNode('math', 0, 0);
    expect(g.connect(t.id, m.id, 'a')).toBeNull();
    expect(g.connect(m.id, t.id, 'speed')).toMatch(/loop/);
  });

  it('never deletes the output node', () => {
    const g = new Graph();
    g.load(blankDoc());
    g.removeNodes(g.doc.nodes.map((n) => n.id));
    expect(g.output()).toBeDefined();
  });
});

describe('domain inference', () => {
  it('puts signals on CPU and fields on GPU, math follows its inputs', () => {
    const g = new Graph();
    g.load(blankDoc());
    const t = g.addNode('time', 0, 0);
    const mCpu = g.addNode('math', 0, 0);
    const pos = g.addNode('position', 0, 0);
    const comp = g.addNode('component', 0, 0);
    const mGpu = g.addNode('math', 0, 0);
    g.connect(t.id, mCpu.id, 'a');
    g.connect(pos.id, comp.id, 'vector');
    g.connect(comp.id, mGpu.id, 'a');
    g.connect(mCpu.id, mGpu.id, 'b');
    const an = analyze(g.doc);
    expect(an.domain.get(t.id)).toBe('cpu');
    expect(an.domain.get(mCpu.id)).toBe('cpu');
    expect(an.domain.get(pos.id)).toBe('gpu');
    expect(an.domain.get(mGpu.id)).toBe('gpu');
  });

  it('flags a field wired into a CPU-only input as invalid', () => {
    const g = new Graph();
    g.load(blankDoc());
    const nf = g.addNode('noisefield', 0, 0);
    const sp = g.addNode('spring', 0, 0);
    g.connect(nf.id, sp.id, 'target');
    const an = analyze(g.doc);
    expect(an.invalidLinks.size).toBe(1);
  });
});

describe('compiler', () => {
  it('compiles every demo without errors and within the slot budget', () => {
    DEMOS.forEach((d) => {
      const g = demoGraph(d.name);
      const res = compileGraph(g.doc, analyze(g.doc));
      expect(res.errors).toEqual([]);
      expect(res.slots.length).toBeLessThan(MAX_SLOTS);
      expect(res.code).toContain('fn sceneMap');
    });
  });

  it('does not change code when only values change (no recompiles while tweaking)', () => {
    const g = demoGraph('Liquid Chrome');
    const a = compileGraph(g.doc, analyze(g.doc)).code;
    const sphere = g.doc.nodes.find((n) => n.type === 'sphere')!;
    g.setValue(sphere.id, 'radius', 3.3);
    const b = compileGraph(g.doc, analyze(g.doc)).code;
    expect(b).toBe(a);
  });

  it('changes code when an enum changes', () => {
    const g = new Graph();
    g.load(blankDoc());
    const p = g.addNode('position', 0, 0);
    const c = g.addNode('component', 0, 0);
    const s = g.doc.nodes.find((n) => n.type === 'sphere')!;
    g.connect(p.id, c.id, 'vector');
    g.connect(c.id, s.id, 'radius');
    const a = compileGraph(g.doc, analyze(g.doc)).code;
    g.setParam(c.id, 'axis', 'x');
    expect(compileGraph(g.doc, analyze(g.doc)).code).not.toBe(a);
  });

  it('fills uniform slots from literals and CPU signals', () => {
    const g = new Graph();
    g.load(blankDoc());
    const s = g.doc.nodes.find((n) => n.type === 'sphere')!;
    const v = g.addNode('value', 0, 0);
    g.setValue(v.id, 'value', 2.5);
    g.connect(v.id, s.id, 'radius');
    const an = analyze(g.doc);
    const res = compileGraph(g.doc, an);
    const ev = new Evaluator();
    const vals = ev.evaluate(g.doc, an, 0);
    const out = new Float32Array(MAX_SLOTS * 4);
    fillSlots(g.doc, an, vals, res.slots, out, 0);
    const idx = res.slots.findIndex((sl) => sl.node === s.id && sl.input === 'radius');
    expect(out[idx * 4]).toBeCloseTo(2.5);
  });

  it('compiles a kitchen-sink graph using every node type', () => {
    const doc = kitchenSink();
    const res = compileGraph(doc, analyze(doc));
    expect(res.errors).toEqual([]);
    for (const def of NODE_DEFS) if (def.gpu) expect(doc.nodes.some((n) => n.type === def.type)).toBe(true);
    expect(res.gpuNodes).toBeGreaterThan(60);
  });
});

describe('signals', () => {
  it('springs are deterministic when scrubbing', () => {
    const g = demoGraph('Gyroid Heart'); // uses pulse -> spring
    const an = analyze(g.doc);
    const spring = g.doc.nodes.find((n) => n.type === 'spring')!;
    const playing = new Evaluator();
    let v = 0;
    for (let t = 0; t <= 2.0001; t += 1 / 60) v = playing.evaluate(g.doc, an, t).get(spring.id) as number;
    const jumped = new Evaluator();
    jumped.evaluate(g.doc, an, 5);
    const w = jumped.evaluate(g.doc, an, 2) as Map<number, number>;
    expect(w.get(spring.id)).toBeCloseTo(v, 2);
  });

  it('samples keyframes with looping', () => {
    const keys = [{ t: 0, v: 0 }, { t: 1, v: 10 }];
    expect(sampleKeys(keys, 0.5, 'linear', 'once')).toBeCloseTo(5);
    expect(sampleKeys(keys, 1.5, 'linear', 'loop')).toBeCloseTo(5);
    expect(sampleKeys(keys, 1.5, 'linear', 'pingpong')).toBeCloseTo(5);
    expect(sampleKeys(keys, 5, 'linear', 'once')).toBe(10);
  });
});

describe('motion nodes', () => {
  it('director camera is deterministic and moves', () => {
    const g = demoGraph('Title Sequence');
    const an = analyze(g.doc);
    const dir = g.doc.nodes.find((n) => n.type === 'director')!;
    const a = new Evaluator().evaluate(g.doc, an, 1.234).get(dir.id) as { pos: number[] };
    const b = new Evaluator().evaluate(g.doc, an, 1.234).get(dir.id) as { pos: number[] };
    const c = new Evaluator().evaluate(g.doc, an, 2.5).get(dir.id) as { pos: number[] };
    expect(a.pos).toEqual(b.pos);
    expect(a.pos).not.toEqual(c.pos);
    expect(a.pos.every(Number.isFinite)).toBe(true);
  });

  it('every director mode yields finite poses across a shot boundary', () => {
    const g = demoGraph('Title Sequence');
    const dir = g.doc.nodes.find((n) => n.type === 'director')!;
    for (const mode of ['director', 'orbit', 'push-in', 'crane', 'flyby', 'spiral', 'top-down', 'vertigo']) {
      for (const cut of ['smooth', 'cut', 'whip']) {
        g.setParam(dir.id, 'mode', mode);
        g.setParam(dir.id, 'cut', cut);
        const an = analyze(g.doc);
        for (let t = 0; t < 8; t += 0.37) {
          const v = new Evaluator().evaluate(g.doc, an, t).get(dir.id) as { pos: number[]; target: number[]; fov: number };
          expect([...v.pos, ...v.target, v.fov].every(Number.isFinite)).toBe(true);
        }
      }
    }
  });

  it('shots compiles one branch per connected input', () => {
    const g = demoGraph('Shot Reel');
    const res = compileGraph(g.doc, analyze(g.doc));
    const shots = g.doc.nodes.find((n) => n.type === 'shots')!;
    const fn = res.code.split(`fn n${shots.id}(`)[1].split('\nfn ')[0];
    expect(fn).toContain('if (i == 3)');
    expect(fn).not.toContain('if (i == 4)');
  });

  it('text nodes reserve an atlas data slot', () => {
    const g = demoGraph('Title Sequence');
    const res = compileGraph(g.doc, analyze(g.doc));
    expect(res.slots.some((s) => s.data && s.input === 'atlas')).toBe(true);
  });
});
