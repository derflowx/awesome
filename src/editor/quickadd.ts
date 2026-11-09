import { CATEGORY_COLORS, NODE_DEFS, type NodeDef } from '../graph/registry';
import { canConnect, type SocketType } from '../graph/types';
import { el } from './widgets';

export interface QuickAddFilter {
  /** Dragging out of an output of this type: node must accept it. */
  accepts?: SocketType;
  /** Dragging out of an input of this type: node must produce it. */
  produces?: SocketType;
}

function score(def: NodeDef, q: string): number {
  if (!q) return 1;
  const hay = `${def.title} ${def.type} ${def.category} ${def.description}`.toLowerCase();
  const title = def.title.toLowerCase();
  if (title.startsWith(q)) return 100 - title.length;
  if (title.includes(q)) return 60;
  if (hay.includes(q)) return 30;
  // fuzzy subsequence over title
  let i = 0;
  for (const ch of title) if (ch === q[i]) i++;
  return i === q.length ? 10 : 0;
}

/** Floating command palette for adding nodes. */
export class QuickAdd {
  private root = el('div', 'quickadd');
  private input = el('input', 'qa-input');
  private list = el('div', 'qa-list');
  private items: NodeDef[] = [];
  private active = 0;
  private onPick: ((def: NodeDef) => void) | null = null;
  private filter: QuickAddFilter = {};

  constructor(host: HTMLElement) {
    this.input.placeholder = 'Add node…  (type to search)';
    this.root.append(this.input, this.list);
    this.root.hidden = true;
    host.append(this.root);
    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') { this.highlight(Math.min(this.items.length - 1, this.active + 1)); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { this.highlight(Math.max(0, this.active - 1)); e.preventDefault(); }
      else if (e.key === 'Enter') this.pick(this.items[this.active]);
      else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); this.close(); }
    });
    this.input.addEventListener('blur', () => setTimeout(() => this.close(), 120));
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  show(x: number, y: number, filter: QuickAddFilter, onPick: (def: NodeDef) => void): void {
    this.filter = filter;
    this.onPick = onPick;
    this.root.hidden = false;
    const host = this.root.parentElement!.getBoundingClientRect();
    this.root.style.left = `${Math.min(Math.max(8, x), host.width - 290)}px`;
    this.root.style.top = `${Math.min(Math.max(8, y), host.height - 340)}px`;
    this.input.value = '';
    this.refresh();
    this.input.focus();
  }

  close(): void {
    this.root.hidden = true;
    this.onPick = null;
  }

  private pick(def: NodeDef | undefined): void {
    if (!def) return;
    const cb = this.onPick;
    this.close();
    cb?.(def);
  }

  private refresh(): void {
    const q = this.input.value.trim().toLowerCase();
    const f = this.filter;
    this.items = NODE_DEFS.filter((d) => d.type !== 'output')
      .filter((d) => !f.accepts || d.inputs.some((i) => canConnect(f.accepts!, i.type)))
      .filter((d) => !f.produces || (d.output !== null && canConnect(d.output, f.produces)))
      .map((d) => [d, score(d, q)] as const)
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([d]) => d);
    this.active = 0;
    this.paint();
  }

  private highlight(i: number): void {
    this.active = i;
    [...this.list.children].forEach((c, k) => c.classList.toggle('active', k === i));
    this.list.children[i]?.scrollIntoView({ block: 'nearest' });
  }

  private paint(): void {
    this.list.replaceChildren(
      ...this.items.map((d, i) => {
        const row = el('div', 'qa-item' + (i === this.active ? ' active' : ''));
        const dot = el('span', 'qa-dot');
        dot.style.background = CATEGORY_COLORS[d.category];
        const t = el('span', 'qa-title', d.title);
        const c = el('span', 'qa-cat', d.category);
        const desc = el('div', 'qa-desc', d.description);
        row.append(dot, t, c, desc);
        row.addEventListener('pointerdown', (e) => { e.preventDefault(); this.pick(d); });
        row.addEventListener('pointerenter', () => this.highlight(i));
        return row;
      }),
    );
    this.list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }
}
