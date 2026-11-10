import type { HudValue, Vec3 } from '../graph/types';

export interface HudState {
  t: number;
  camPos: Vec3;
  fwd: Vec3;
  right: Vec3;
  up: Vec3;
  tanHalfFov: number;
  /** World point the camera is aiming at (gets the lock box). */
  target: Vec3;
  /** Optical centre offset in canvas pixels. */
  shift: [number, number];
  /** Pixels per projected unit (the render's full height). Defaults to the HUD height. */
  projScale?: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const fract = (x: number) => x - Math.floor(x);
const hash = (i: number, s: number) => fract(Math.sin(i * 127.1 + s * 311.7) * 43758.5453);
const pad = (n: number, w = 2) => String(Math.floor(Math.abs(n))).padStart(w, '0');

function timecode(t: number, fps = 30): string {
  const f = Math.floor((t % 1) * fps);
  const s = Math.floor(t);
  return `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
}

/** Projects a world point to canvas pixels (null if behind the camera). */
function project(p: Vec3, s: HudState, w: number, h: number): [number, number, number] | null {
  const rel: Vec3 = [p[0] - s.camPos[0], p[1] - s.camPos[1], p[2] - s.camPos[2]];
  const z = dot(rel, s.fwd);
  if (z < 0.05) return null;
  const x = dot(rel, s.right) / (z * s.tanHalfFov * 2);
  const y = dot(rel, s.up) / (z * s.tanHalfFov * 2);
  const k = s.projScale ?? h;
  return [w / 2 + s.shift[0] + x * k, h / 2 + s.shift[1] - y * k, z];
}

/** Draws a heads-up display. Used for the live overlay and composited into exports. */
export function drawHud(g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number, hud: HudValue, s: HudState): void {
  const u = h / 1000; // design unit
  const [r, gg, b] = hud.color.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255));
  const col = (a: number) => `rgba(${r},${gg},${b},${a * hud.opacity})`;
  const white = (a: number) => `rgba(235,235,240,${a * hud.opacity})`;
  const cx = w / 2 + s.shift[0], cy = h / 2 + s.shift[1];
  const t = s.t;
  g.save();
  g.lineCap = 'square';
  g.textBaseline = 'middle';
  const font = (px: number, weight = 400) => `${weight} ${Math.round(px * u)}px "Share Tech Mono", "JetBrains Mono", monospace`;
  const text = (str: string, x: number, y: number, px = 18, align: CanvasTextAlign = 'left', c = col(1)) => {
    g.font = font(px);
    g.textAlign = align;
    g.fillStyle = c;
    g.fillText(str, x, y);
  };
  const line = (x0: number, y0: number, x1: number, y1: number, c = col(0.9), lw = 2) => {
    g.strokeStyle = c;
    g.lineWidth = lw * u;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  };
  const brackets = (x: number, y: number, bw: number, bh: number, len: number, c = col(0.9), lw = 2) => {
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const px = x + (sx * bw) / 2, py = y + (sy * bh) / 2;
      line(px, py, px - sx * len, py, c, lw);
      line(px, py, px, py - sy * len, c, lw);
    }
  };
  const heading = ((Math.atan2(s.fwd[0], s.fwd[2]) * 180) / Math.PI + 360) % 360;
  const pitch = (Math.asin(Math.max(-1, Math.min(1, s.fwd[1]))) * 180) / Math.PI;
  const tgt = project(s.target, s, w, h);
  const range = Math.hypot(s.target[0] - s.camPos[0], s.target[1] - s.camPos[1], s.target[2] - s.camPos[2]);
  const blink = Math.floor(t * 2) % 2 === 0;
  const m = 46 * u; // margin

  // ---- frame chrome shared by all styles
  brackets(w / 2, h / 2, w - m * 2, h - m * 2, 46 * u, col(0.75), 2);
  if (blink) {
    g.fillStyle = 'rgba(255,40,40,' + hud.opacity + ')';
    g.beginPath();
    g.arc(w - m - 120 * u, m + 30 * u, 7 * u, 0, Math.PI * 2);
    g.fill();
  }
  text('REC', w - m - 104 * u, m + 30 * u, 20, 'left', white(0.95));
  text(timecode(t), w - m - 16 * u, m + 62 * u, 20, 'right', white(0.85));

  if (hud.style === 'minimal') {
    text(hud.label, m + 16 * u, h - m - 24 * u, 20, 'left', white(0.9));
    g.restore();
    return;
  }

  if (hud.style === 'tactical' || hud.style === 'drone') {
    // Compass tape
    const tapeW = Math.min(w * 0.5, 640 * u);
    const ty = m + 36 * u;
    g.save();
    g.beginPath();
    g.rect(cx - tapeW / 2, ty - 30 * u, tapeW, 60 * u);
    g.clip();
    for (let d = -60; d <= 60; d += 5) {
      const deg = Math.round(heading / 5) * 5 + d;
      const x = cx + ((deg - heading) / 60) * (tapeW / 2);
      const major = ((deg % 30) + 30) % 30 === 0;
      line(x, ty + 14 * u, x, ty + (major ? -2 : 6) * u, col(major ? 0.9 : 0.5), major ? 2 : 1.4);
      if (major) {
        const v = ((deg % 360) + 360) % 360;
        const lab = v === 0 ? 'N' : v === 90 ? 'E' : v === 180 ? 'S' : v === 270 ? 'W' : pad(v, 3);
        text(lab, x, ty - 16 * u, 15, 'center', col(0.85));
      }
    }
    g.restore();
    g.fillStyle = col(1);
    g.beginPath();
    g.moveTo(cx, ty + 20 * u);
    g.lineTo(cx - 7 * u, ty + 32 * u);
    g.lineTo(cx + 7 * u, ty + 32 * u);
    g.fill();
    text(pad(heading, 3) + '°', cx, ty + 50 * u, 18, 'center', white(0.9));
  }

  if (hud.style === 'tactical') {
    // Reticle
    const gap = 18 * u, arm = 46 * u;
    line(cx - gap - arm, cy, cx - gap, cy, col(0.85));
    line(cx + gap, cy, cx + gap + arm, cy, col(0.85));
    line(cx, cy - gap - arm, cx, cy - gap, col(0.85));
    line(cx, cy + gap, cx, cy + gap + arm, col(0.85));
    g.strokeStyle = col(0.5);
    g.lineWidth = 1.2 * u;
    g.beginPath();
    g.arc(cx, cy, 120 * u, -Math.PI * 0.2, Math.PI * 0.2);
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, 120 * u, Math.PI * 0.8, Math.PI * 1.2);
    g.stroke();
    // Pitch ladder
    for (let p = -30; p <= 30; p += 10) {
      const y = cy - ((p - pitch) / 30) * 220 * u;
      if (Math.abs(y - cy) > 260 * u) continue;
      line(cx - 300 * u, y, cx - 250 * u, y, col(p === 0 ? 0.9 : 0.45), 1.5);
      line(cx + 250 * u, y, cx + 300 * u, y, col(p === 0 ? 0.9 : 0.45), 1.5);
      text(`${p > 0 ? '+' : ''}${p}`, cx - 312 * u, y, 13, 'right', col(0.6));
    }
  }

  // ---- target lock
  if (tgt && hud.style !== 'drone') {
    const lockT = fract(t / 4);
    const lockIn = Math.min(1, lockT * 3);
    const sz = (180 - 70 * lockIn) * u;
    const spin = lockIn < 1 ? (1 - lockIn) * Math.PI : 0;
    g.save();
    g.translate(tgt[0], tgt[1]);
    g.rotate(spin);
    brackets(0, 0, sz, sz, 22 * u, col(1), 2.5);
    g.restore();
    if (lockIn >= 1 && blink) {
      g.strokeStyle = col(0.5);
      g.lineWidth = 1 * u;
      g.strokeRect(tgt[0] - sz / 2 - 8 * u, tgt[1] - sz / 2 - 8 * u, sz + 16 * u, sz + 16 * u);
    }
    const lx = tgt[0] + sz / 2 + 18 * u, ly = tgt[1] - sz / 2 + 10 * u;
    line(tgt[0] + sz / 2, tgt[1] - sz / 2, lx - 4 * u, ly, col(0.6), 1.2);
    text(`TGT-${pad(hud.seed * 7 + 1, 2)}`, lx, ly, 18, 'left', col(1));
    text(lockIn >= 1 ? hud.label : 'ACQUIRING' + '.'.repeat(Math.floor(t * 6) % 4), lx, ly + 24 * u, 15, 'left', white(0.9));
    text(`RNG ${range.toFixed(2)}m`, lx, ly + 46 * u, 14, 'left', col(0.75));
  }

  // ---- surveillance: many tracked subjects
  if (hud.style === 'surveillance') {
    for (let i = 0; i < 7; i++) {
      const a = hash(i, hud.seed) * Math.PI * 2;
      const rr = 0.6 + hash(i + 9, hud.seed) * 2.6;
      const wob = Math.sin(t * (0.3 + hash(i + 3, hud.seed)) + i) * 0.4;
      const p: Vec3 = [s.target[0] + Math.cos(a + wob) * rr, s.target[1] + (hash(i + 5, hud.seed) - 0.5) * 2, s.target[2] + Math.sin(a + wob) * rr];
      const q = project(p, s, w, h);
      if (!q) continue;
      const bs = (60 + hash(i + 2, hud.seed) * 60) * u * (6 / Math.max(q[2], 1));
      g.strokeStyle = col(0.8);
      g.lineWidth = 1.5 * u;
      g.strokeRect(q[0] - bs / 2, q[1] - bs / 2, bs, bs);
      g.fillStyle = col(0.85);
      g.fillRect(q[0] - bs / 2, q[1] - bs / 2 - 20 * u, Math.max(bs, 90 * u), 20 * u);
      text(`ID ${pad(hash(i, hud.seed + 1) * 9000 + 1000, 4)}`, q[0] - bs / 2 + 5 * u, q[1] - bs / 2 - 10 * u, 13, 'left', 'rgba(0,0,0,0.9)');
      text(`${(90 + hash(i + 7, hud.seed) * 9.9).toFixed(1)}%`, q[0] - bs / 2, q[1] + bs / 2 + 14 * u, 13, 'left', col(0.85));
    }
    const d = new Date(Date.UTC(2031, 10, 10, 23, 14, 7) + t * 1000);
    text(`CAM ${pad(hud.seed, 2)} • ${d.toISOString().replace('T', ' ').slice(0, 19)}`, m + 16 * u, m + 30 * u, 20, 'left', white(0.9));
    text(hud.label, m + 16 * u, m + 58 * u, 16, 'left', col(0.95));
  }

  // ---- drone: horizon, altitude ladder, coordinates
  if (hud.style === 'drone') {
    const roll = Math.atan2(-s.right[1], s.up[1]);
    g.save();
    g.translate(cx, cy);
    g.rotate(roll);
    line(-340 * u, 0, -90 * u, 0, col(0.9), 2);
    line(90 * u, 0, 340 * u, 0, col(0.9), 2);
    g.restore();
    g.strokeStyle = col(0.9);
    g.lineWidth = 2 * u;
    g.beginPath();
    g.arc(cx, cy, 70 * u, 0, Math.PI * 2);
    g.stroke();
    line(cx - 10 * u, cy, cx + 10 * u, cy, col(1));
    line(cx, cy - 10 * u, cx, cy + 10 * u, col(1));
    const alt = s.camPos[1] * 100 + 1200;
    for (let k = -4; k <= 4; k++) {
      const v = Math.round(alt / 50) * 50 + k * 50;
      const y = cy - ((v - alt) / 50) * 50 * u;
      line(w - m - 90 * u, y, w - m - 70 * u, y, col(0.6), 1.5);
      text(String(v), w - m - 96 * u, y, 13, 'right', col(0.7));
    }
    text(`ALT ${alt.toFixed(0)}`, w - m - 70 * u, cy, 18, 'left', white(0.95));
    const lat = 34.0522 + s.camPos[2] * 0.0011, lon = -118.2437 + s.camPos[0] * 0.0011;
    text(`${lat.toFixed(5)}N  ${Math.abs(lon).toFixed(5)}W`, m + 16 * u, h - m - 52 * u, 18, 'left', white(0.9));
    text(blink ? '■ ARMED' : '□ ARMED', m + 16 * u, h - m - 24 * u, 18, 'left', col(1));
  }

  // ---- telemetry + data stream
  if (hud.style !== 'surveillance') {
    const lines = [
      `HDG ${pad(heading, 3)}   PCH ${pitch.toFixed(1)}`,
      `FOV ${((Math.atan(s.tanHalfFov) * 360) / Math.PI).toFixed(1)}   RNG ${range.toFixed(2)}`,
      `POS ${s.camPos.map((v) => v.toFixed(2)).join(' ')}`,
    ];
    if (hud.style !== 'drone') lines.forEach((l, i) => text(l, m + 16 * u, h - m - 76 * u + i * 24 * u, 15, 'left', col(0.85)));
  }
  const colX = w - m - 16 * u;
  for (let i = 0; i < 14; i++) {
    const v = Math.floor(hash(i + Math.floor(t * 8), hud.seed) * 0xffffff);
    text(v.toString(16).toUpperCase().padStart(6, '0'), colX, h * 0.36 + i * 20 * u, 13, 'right', col(0.25 + (i === Math.floor(t * 8) % 14 ? 0.6 : 0)));
  }
  // Sweep line
  const sy = m + fract(t * 0.25) * (h - m * 2);
  g.fillStyle = col(0.06);
  g.fillRect(m, sy, w - m * 2, 3 * u);
  g.restore();
}
