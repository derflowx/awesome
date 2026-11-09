import type { Graph } from './graph';

/** Snapshot-based undo/redo. Call commit() after each finished user action. */
export class History {
  private stack: string[] = [];
  private idx = -1;
  constructor(private graph: Graph, private limit = 200) {}

  reset(): void {
    this.stack = [JSON.stringify(this.graph.doc)];
    this.idx = 0;
  }

  commit(): void {
    const snap = JSON.stringify(this.graph.doc);
    if (snap === this.stack[this.idx]) return;
    this.stack = this.stack.slice(0, this.idx + 1);
    this.stack.push(snap);
    if (this.stack.length > this.limit) this.stack.shift();
    this.idx = this.stack.length - 1;
  }

  undo(): boolean {
    if (this.idx <= 0) return false;
    this.idx--;
    this.graph.load(JSON.parse(this.stack[this.idx]));
    return true;
  }

  redo(): boolean {
    if (this.idx >= this.stack.length - 1) return false;
    this.idx++;
    this.graph.load(JSON.parse(this.stack[this.idx]));
    return true;
  }
}
