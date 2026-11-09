import type { Keyframe, Vec3 } from '../graph/types';
import { sampleKeys } from '../graph/registry';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function fmt(v: number): string {
  if (!isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

export interface NumberOpts {
  label?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onInput: (v: number) => void;
  onCommit: () => void;
}

/** Blender-style scrubbable number: drag to scrub, click to type. */
export function numberField(o: NumberOpts): HTMLElement {
  const root = el('div', 'num');
  const fill = el('div', 'num-fill');
  const lab = el('span', 'num-label', o.label ?? '');
  const val = el('span', 'num-value');
  root.append(fill, lab, val);
  let value = o.value;
  const step = o.step ?? 0.01;
  const hasRange = o.min !== undefined && o.max !== undefined;
  const clamp = (v: number) => {
    if (o.min !== undefined) v = Math.max(o.min, v);
    if (o.max !== undefined) v = Math.min(o.max, v);
    return v;
  };
  const paint = () => {
    val.textContent = fmt(value);
    if (hasRange) fill.style.width = `${((value - o.min!) / (o.max! - o.min!)) * 100}%`;
  };
  paint();

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || root.querySelector('input')) return;
    e.stopPropagation();
    e.preventDefault();
    root.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = value;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 3) moved = true;
      if (!moved) return;
      const mult = ev.shiftKey ? 0.1 : ev.ctrlKey || ev.metaKey ? 10 : 1;
      const per = hasRange ? (o.max! - o.min!) / 200 : Math.max(step, 0.001) * 1.5;
      let nv = start + dx * per * mult;
      if (step >= 1) nv = Math.round(nv);
      value = clamp(nv);
      paint();
      o.onInput(value);
    };
    const up = () => {
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', up);
      root.removeEventListener('pointercancel', up);
      if (moved) o.onCommit();
      else edit();
    };
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
  });

  const edit = () => {
    const inp = el('input', 'num-input');
    inp.value = String(+value.toFixed(5));
    root.append(inp);
    inp.focus();
    inp.select();
    const done = (apply: boolean) => {
      if (apply) {
        try {
          // Allow simple math like "2*pi" or "1/3".
          const expr = inp.value.replace(/pi/gi, String(Math.PI));
          if (/^[\d\s.+\-*/()eE]+$/.test(expr)) {
            const nv = Function(`"use strict";return (${expr})`)() as number;
            if (isFinite(nv)) {
              value = clamp(nv);
              o.onInput(value);
              o.onCommit();
            }
          }
        } catch {
          /* ignore bad input */
        }
      }
      inp.remove();
      paint();
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    inp.addEventListener('blur', () => inp.isConnected && done(true));
  };
  return root;
}

// ---- color helpers: UI shows sRGB, graph stores linear ----
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
export function linearToHex(v: Vec3): string {
  return '#' + v.map((c) => Math.round(Math.min(1, Math.max(0, toSrgb(c))) * 255).toString(16).padStart(2, '0')).join('');
}
export function hexToLinear(hex: string): Vec3 {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => toLinear(c / 255)) as Vec3;
}

export function colorField(value: Vec3, onInput: (v: Vec3) => void, onCommit: () => void): HTMLElement {
  const root = el('label', 'color-field');
  const sw = el('span', 'swatch');
  const inp = el('input');
  inp.type = 'color';
  inp.value = linearToHex(value);
  sw.style.background = inp.value;
  root.append(sw, inp);
  root.addEventListener('pointerdown', (e) => e.stopPropagation());
  inp.addEventListener('input', () => {
    sw.style.background = inp.value;
    onInput(hexToLinear(inp.value));
  });
  inp.addEventListener('change', onCommit);
  return root;
}

export function enumField(value: string, options: string[], onChange: (v: string) => void): HTMLElement {
  const s = el('select', 'enum');
  for (const o of options) {
    const opt = el('option', undefined, o);
    opt.value = o;
    s.append(opt);
  }
  s.value = value;
  s.addEventListener('pointerdown', (e) => e.stopPropagation());
  s.addEventListener('keydown', (e) => e.stopPropagation());
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

/** Inline keyframe curve editor drawn on a canvas. */
export class CurveEditor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private range = { t0: 0, t1: 3, v0: -0.2, v1: 1.2 };
  private dragging = -1;
  playhead = 0;

  constructor(
    private keys: Keyframe[],
    private opts: () => { interp: string; loop: string },
    private onInput: (keys: Keyframe[]) => void,
    private onCommit: () => void,
  ) {
    this.canvas = el('canvas', 'curve');
    this.canvas.width = 216 * 2;
    this.canvas.height = 96 * 2;
    this.ctx = this.canvas.getContext('2d')!;
    this.fitRange();
    this.bind();
    this.draw();
  }

  private fitRange(): void {
    const ts = this.keys.map((k) => k.t);
    const vs = this.keys.map((k) => k.v);
    const t1 = Math.max(1, ...ts) * 1.08;
    let v0 = Math.min(0, ...vs);
    let v1 = Math.max(1, ...vs);
    const pad = (v1 - v0) * 0.18;
    v0 -= pad;
    v1 += pad;
    this.range = { t0: 0, t1, v0, v1 };
  }

  private toPx(t: number, v: number): [number, number] {
    const { t0, t1, v0, v1 } = this.range;
    const W = this.canvas.width, H = this.canvas.height;
    return [((t - t0) / (t1 - t0)) * W, H - ((v - v0) / (v1 - v0)) * H];
  }
  private fromPx(x: number, y: number): [number, number] {
    const { t0, t1, v0, v1 } = this.range;
    const W = this.canvas.width, H = this.canvas.height;
    return [t0 + (x / W) * (t1 - t0), v0 + ((H - y) / H) * (v1 - v0)];
  }
  private local(e: PointerEvent | MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * this.canvas.width, ((e.clientY - r.top) / r.height) * this.canvas.height];
  }
  private hit(x: number, y: number): number {
    return this.keys.findIndex((k) => {
      const [px, py] = this.toPx(k.t, k.v);
      return Math.hypot(px - x, py - y) < 14;
    });
  }

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const i = this.hit(...this.local(e));
      if (i >= 0 && this.keys.length > 1) {
        this.keys.splice(i, 1);
        this.onInput(this.keys);
        this.onCommit();
        this.draw();
      }
    });
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      c.setPointerCapture(e.pointerId);
      const [x, y] = this.local(e);
      let i = this.hit(x, y);
      if (i < 0) {
        const [t, v] = this.fromPx(x, y);
        this.keys.push({ t: Math.max(0, +t.toFixed(3)), v: +v.toFixed(3) });
        i = this.keys.length - 1;
        this.onInput(this.keys);
      }
      this.dragging = i;
      this.draw();
    });
    c.addEventListener('pointermove', (e) => {
      if (this.dragging < 0) return;
      const [t, v] = this.fromPx(...this.local(e));
      const k = this.keys[this.dragging];
      k.t = Math.max(0, +(e.shiftKey ? Math.round(t * 4) / 4 : t).toFixed(3));
      k.v = +(e.shiftKey ? Math.round(v * 4) / 4 : v).toFixed(3);
      this.onInput(this.keys);
      this.draw();
    });
    const up = () => {
      if (this.dragging < 0) return;
      this.dragging = -1;
      this.fitRange();
      this.draw();
      this.onCommit();
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  }

  draw(): void {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(0, 0, W, H);
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let s = 0; s <= this.range.t1; s += 0.5) {
      const [x] = this.toPx(s, 0);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    const [, y0] = this.toPx(0, 0);
    const [, y1] = this.toPx(0, 1);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    for (const y of [y0, y1]) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    // curve
    const { interp } = this.opts();
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#ff9f43');
    grad.addColorStop(1, '#ff5e8a');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 3) {
      const [t] = this.fromPx(x, 0);
      const v = sampleKeys(this.keys, t, interp, 'once');
      const [, y] = this.toPx(t, v);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // keys
    this.keys.forEach((k, i) => {
      const [x, y] = this.toPx(k.t, k.v);
      ctx.fillStyle = i === this.dragging ? '#fff' : '#ffd166';
      ctx.beginPath();
      ctx.moveTo(x, y - 9); ctx.lineTo(x + 9, y); ctx.lineTo(x, y + 9); ctx.lineTo(x - 9, y);
      ctx.closePath();
      ctx.fill();
    });
    // playhead
    const [px] = this.toPx(this.playhead, 0);
    ctx.strokeStyle = 'rgba(60,242,196,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
  }

  setPlayhead(t: number): void {
    const sorted = [...this.keys].sort((a, b) => a.t - b.t);
    const t0 = sorted[0]?.t ?? 0;
    const t1 = sorted[sorted.length - 1]?.t ?? 1;
    const span = t1 - t0;
    const { loop } = this.opts();
    let u = t;
    if (span > 0 && loop !== 'once') {
      let f = (t - t0) / span;
      if (loop === 'loop') f = f - Math.floor(f);
      else f = 1 - Math.abs(1 - 2 * ((f * 0.5) - Math.floor(f * 0.5)));
      u = t0 + f * span;
    }
    if (Math.abs(u - this.playhead) < 1e-4) return;
    this.playhead = u;
    this.draw();
  }
}

/** Tiny live plot of a signal. */
export class Sparkline {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private hist: number[] = [];
  constructor(private color: string) {
    this.canvas = el('canvas', 'spark');
    this.canvas.width = 216 * 2;
    this.canvas.height = 34 * 2;
    this.ctx = this.canvas.getContext('2d')!;
  }
  push(v: number): void {
    this.hist.push(v);
    if (this.hist.length > 140) this.hist.shift();
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    let lo = Math.min(...this.hist), hi = Math.max(...this.hist);
    if (hi - lo < 1e-3) { hi += 0.5; lo -= 0.5; }
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    this.hist.forEach((h, i) => {
      const x = (i / 139) * W;
      const y = H - 6 - ((h - lo) / (hi - lo)) * (H - 12);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}
