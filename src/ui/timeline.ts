import { el } from '../editor/widgets';

/** Transport bar: play / scrub / loop. */
export class Timeline {
  time = 0;
  duration = 10;
  playing = true;
  loop = true;
  readonly root: HTMLElement;
  private playBtn: HTMLButtonElement;
  private readout: HTMLElement;
  private track: HTMLElement;
  private head: HTMLElement;
  private fill: HTMLElement;
  private durInput: HTMLInputElement;
  private loopBtn: HTMLButtonElement;
  private ticks: HTMLElement;
  /** Fires on user-initiated jumps (scrub, rewind). */
  onSeek: () => void = () => {};
  onDuration: (d: number) => void = () => {};

  constructor(host: HTMLElement) {
    this.root = el('div', 'tl');
    this.playBtn = el('button', 'tl-btn tl-play');
    this.playBtn.title = 'Play / pause (Space)';
    const rew = el('button', 'tl-btn', '⏮');
    rew.title = 'Back to start (Home)';
    this.readout = el('span', 'tl-time');
    this.track = el('div', 'tl-track');
    this.ticks = el('div', 'tl-ticks');
    this.fill = el('div', 'tl-fill');
    this.head = el('div', 'tl-head');
    this.track.append(this.ticks, this.fill, this.head);
    this.loopBtn = el('button', 'tl-btn tl-loop', '∞');
    this.loopBtn.title = 'Loop';
    const durWrap = el('label', 'tl-dur');
    durWrap.append(el('span', undefined, 'length'));
    this.durInput = el('input');
    this.durInput.type = 'number';
    this.durInput.min = '1';
    this.durInput.step = '1';
    durWrap.append(this.durInput, el('span', undefined, 's'));
    this.root.append(rew, this.playBtn, this.readout, this.track, this.loopBtn, durWrap);
    host.append(this.root);

    rew.addEventListener('click', () => this.seek(0));
    this.playBtn.addEventListener('click', () => this.toggle());
    this.loopBtn.addEventListener('click', () => {
      this.loop = !this.loop;
      this.paint();
    });
    this.durInput.addEventListener('change', () => {
      const d = Math.max(1, Number(this.durInput.value) || 10);
      this.setDuration(d);
      this.onDuration(d);
    });
    this.durInput.addEventListener('keydown', (e) => e.stopPropagation());
    this.track.addEventListener('pointerdown', (e) => {
      this.track.setPointerCapture(e.pointerId);
      const wasPlaying = this.playing;
      this.playing = false;
      const set = (ev: PointerEvent) => {
        const r = this.track.getBoundingClientRect();
        this.seek(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * this.duration);
      };
      set(e);
      const up = () => {
        this.track.removeEventListener('pointermove', set);
        this.track.removeEventListener('pointerup', up);
        this.playing = wasPlaying;
        this.paint();
      };
      this.track.addEventListener('pointermove', set);
      this.track.addEventListener('pointerup', up);
    });
    this.setDuration(this.duration);
  }

  setDuration(d: number): void {
    this.duration = d;
    this.durInput.value = String(d);
    this.ticks.replaceChildren();
    for (let s = 0; s <= d; s++) {
      const t = el('span', s % 5 === 0 ? 'major' : '');
      t.style.left = `${(s / d) * 100}%`;
      if (s % 5 === 0) t.textContent = `${s}s`;
      this.ticks.append(t);
    }
    this.paint();
  }

  toggle(): void {
    this.playing = !this.playing;
    this.paint();
  }

  seek(t: number): void {
    this.time = t;
    this.onSeek();
    this.paint();
  }

  tick(dt: number): void {
    if (!this.playing) return;
    this.time += dt;
    if (this.time >= this.duration) {
      if (this.loop) {
        this.time = this.time % this.duration;
        this.onSeek();
      } else {
        this.time = this.duration;
        this.playing = false;
      }
    }
    this.paint();
  }

  private paint(): void {
    this.playBtn.textContent = this.playing ? '❚❚' : '▶';
    this.playBtn.classList.toggle('on', this.playing);
    this.loopBtn.classList.toggle('on', this.loop);
    const u = this.time / this.duration;
    this.head.style.left = `${u * 100}%`;
    this.fill.style.width = `${u * 100}%`;
    const fr = Math.floor((this.time % 1) * 60);
    this.readout.textContent = `${this.time.toFixed(2)}s · f${Math.floor(this.time) * 60 + fr}`;
  }
}
