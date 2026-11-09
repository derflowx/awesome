import type { CameraState, Vec3 } from '../graph/types';

export const DEFAULT_CAMERA: CameraState = { yaw: 0.6, pitch: 0.25, dist: 6, target: [0, 0, 0] };

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Orbit camera with damped motion. */
export class OrbitCamera {
  state: CameraState = structuredClone(DEFAULT_CAMERA);
  private goal: CameraState = structuredClone(DEFAULT_CAMERA);
  autoRotate = false;
  fov = 45;
  private moving = false;

  set(s: CameraState, instant = false): void {
    this.goal = structuredClone(s);
    if (instant) this.state = structuredClone(s);
  }
  get target(): CameraState {
    return this.goal;
  }

  attach(el: HTMLElement, onInteract: () => void): void {
    let drag: { x: number; y: number; button: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, button: e.button };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.button === 0 && !e.shiftKey) {
        this.goal.yaw -= dx * 0.008;
        this.goal.pitch = Math.max(-1.5, Math.min(1.5, this.goal.pitch + dy * 0.008));
      } else {
        const { right, up } = this.basis(this.goal);
        const k = this.goal.dist * 0.0015;
        for (let i = 0; i < 3; i++) this.goal.target[i] += (-right[i] * dx + up[i] * dy) * k;
      }
      onInteract();
    });
    const end = () => (drag = null);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.goal.dist = Math.max(0.5, Math.min(60, this.goal.dist * Math.exp(e.deltaY * 0.0012)));
        onInteract();
      },
      { passive: false },
    );
    el.addEventListener('dblclick', () => {
      this.goal = structuredClone(DEFAULT_CAMERA);
      onInteract();
    });
  }

  /** Advance damping. Returns true while the camera is still moving. */
  update(dt: number): boolean {
    if (this.autoRotate) this.goal.yaw += dt * 0.25;
    const k = 1 - Math.exp(-dt * 14);
    const s = this.state;
    const g = this.goal;
    let delta = 0;
    const lerp = (a: number, b: number) => {
      delta += Math.abs(b - a);
      return a + (b - a) * k;
    };
    s.yaw = lerp(s.yaw, g.yaw);
    s.pitch = lerp(s.pitch, g.pitch);
    s.dist = lerp(s.dist, g.dist);
    for (let i = 0; i < 3; i++) s.target[i] = lerp(s.target[i], g.target[i]);
    if (delta < 1e-5) {
      this.state = structuredClone(g);
      this.moving = false;
    } else this.moving = true;
    return this.moving;
  }

  position(s: CameraState = this.state): Vec3 {
    const cp = Math.cos(s.pitch);
    return [s.target[0] + Math.sin(s.yaw) * cp * s.dist, s.target[1] + Math.sin(s.pitch) * s.dist, s.target[2] + Math.cos(s.yaw) * cp * s.dist];
  }

  basis(s: CameraState = this.state): { pos: Vec3; fwd: Vec3; right: Vec3; up: Vec3 } {
    const pos = this.position(s);
    const fwd = norm(sub(s.target, pos));
    const right = norm(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);
    return { pos, fwd, right, up };
  }
}
