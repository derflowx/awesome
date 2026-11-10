import { FONTS } from '../graph/registry';
import type { GraphDoc } from '../graph/types';
import { ATLAS_ROW, ATLAS_SIZE } from './renderer';

const SPREAD = 24; // must match SDF_SPREAD in shaders
const ROWS = ATLAS_SIZE / ATLAS_ROW;

/** 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

function edt2d(grid: Float64Array, w: number, h: number): void {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
}

export interface BakedText {
  data: Uint8Array;
  /** halfW px, halfH px, (row filled in later), font px */
  info: [number, number, number, number];
}

/** Rasterises a string and converts it into a signed distance field row. */
export function bakeText(text: string, font: string): BakedText {
  const W = ATLAS_SIZE, H = ATLAS_ROW;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  let css = FONTS[font] ?? FONTS.display;
  let px = 150;
  g.font = css;
  const maxW = W - SPREAD * 2 - 16;
  const measured = g.measureText(text || ' ').width;
  if (measured > maxW) {
    px = Math.max(20, Math.floor((150 * maxW) / measured));
    css = css.replace('150px', `${px}px`);
  }
  g.font = css;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const m = g.measureText(text || ' ');
  // Centre the ink box on the row.
  const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
  const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  const x = W / 2 + (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2;
  const y = H / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  g.fillStyle = '#fff';
  g.fillText(text, x, y);
  const img = g.getImageData(0, 0, W, H).data;
  const INF = 1e20;
  const outside = new Float64Array(W * H);
  const inside = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const a = img[i * 4 + 3];
    const ink = a > 127;
    outside[i] = ink ? 0 : INF;
    inside[i] = ink ? INF : 0;
  }
  edt2d(outside, W, H);
  edt2d(inside, W, H);
  const data = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const d = Math.sqrt(outside[i]) - Math.sqrt(inside[i]); // + outside, - inside
    data[i] = Math.round(Math.min(1, Math.max(0, 0.5 - d / (2 * SPREAD))) * 255);
  }
  return { data, info: [inkW / 2 + 1, inkH / 2 + 1, 0, px] };
}

/** Keeps one atlas row per Text node in sync with its text and font. */
export class TextAtlas {
  private rows = new Map<number, { key: string; row: number; info: number[] }>();
  private pending = new Set<number>();
  onUpload: (row: number, data: Uint8Array) => void = () => {};

  sync(doc: GraphDoc): void {
    const texts = doc.nodes.filter((n) => n.type === 'text').sort((a, b) => a.id - b.id);
    const alive = new Set(texts.map((n) => n.id));
    for (const id of [...this.rows.keys()]) if (!alive.has(id)) this.rows.delete(id);
    texts.forEach((n, i) => {
      const row = Math.min(i, ROWS - 1);
      const text = String(n.params.text ?? '');
      const font = String(n.params.font ?? 'display');
      const key = `${row}|${font}|${text}`;
      const cur = this.rows.get(n.id);
      if (cur?.key === key || this.pending.has(n.id)) return;
      this.pending.add(n.id);
      const css = FONTS[font] ?? FONTS.display;
      const ready = 'fonts' in document ? document.fonts.load(css, text || 'A').catch(() => []) : Promise.resolve([]);
      void ready.then(() => {
        const baked = bakeText(text, font);
        baked.info[2] = row;
        this.onUpload(row, baked.data);
        this.rows.set(n.id, { key, row, info: baked.info });
        this.pending.delete(n.id);
      });
    });
  }

  /** Forget everything so rows are re-uploaded (e.g. after a GPU reset). */
  reset(): void {
    this.rows.clear();
  }

  info(nodeId: number): number[] | undefined {
    return this.rows.get(nodeId)?.info;
  }
}
