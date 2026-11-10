import { Graph } from '../src/graph/graph';
import { blankDoc } from '../src/demos';
import { NODE_DEFS } from '../src/graph/registry';
import type { GraphDoc } from '../src/graph/types';

/** A graph that uses every node type, with every "any" node forced onto the GPU. */
export function kitchenSink(): GraphDoc {
  const g = new Graph();
  g.load(blankDoc());
  const out = g.output()!;
  const pieces: number[] = [];
  const field = () => g.addNode('noisefield', 0, 0).id;
  const sig = () => g.addNode('lfo', 0, 0).id;
  for (const def of NODE_DEFS) {
    if (def.type === 'output') continue;
    const n = g.addNode(def.type, 0, 0);
    for (const inp of def.inputs) {
      if (inp.type === 'sdf') g.connect(g.addNode('sphere', 0, 0).id, n.id, inp.name);
      else if (inp.type === 'float') g.connect(def.domain === 'cpu' ? sig() : field(), n.id, inp.name);
    }
    if (def.output === 'camera' || def.output === 'particles') g.connect(n.id, out.id, def.output);
    else if (def.output === 'sdf') pieces.push(n.id);
    else if (def.output === 'float') {
      const d = g.addNode('displace', 0, 0);
      g.connect(g.addNode('sphere', 0, 0).id, d.id, 'shape');
      g.connect(n.id, d.id, def.domain === 'cpu' ? 'amount' : 'field');
      pieces.push(d.id);
    } else if (def.output) {
      const m = g.addNode('material', 0, 0);
      g.connect(g.addNode('box', 0, 0).id, m.id, 'shape');
      g.connect(n.id, m.id, 'color');
      pieces.push(m.id);
    }
  }
  let acc = pieces[0];
  for (const p of pieces.slice(1)) {
    const u = g.addNode('union', 0, 0);
    g.connect(acc, u.id, 'a');
    g.connect(p, u.id, 'b');
    acc = u.id;
  }
  g.connect(acc, out.id, 'shape');
  return g.toJSON();
}
