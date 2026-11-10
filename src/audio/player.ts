import { analyze, setAnalysis, type AudioAnalysis } from './analysis';

/** Loads a track, analyses it, and keeps playback locked to the timeline. */
export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private startedAt = 0; // ctx time when timeline t=0 would have played
  private playing = false;
  muted = false;

  get loaded(): boolean {
    return !!this.buffer;
  }

  async load(file: File | Blob, name: string): Promise<AudioAnalysis> {
    this.ctx ??= new AudioContext();
    const bytes = await file.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(bytes);
    const a = analyze(this.buffer, name);
    setAnalysis(a);
    this.stop();
    return a;
  }

  unload(): void {
    this.stop();
    this.buffer = null;
    setAnalysis(null);
  }

  /** Call every frame with the timeline state. */
  sync(t: number, playing: boolean): void {
    if (!this.buffer || !this.ctx) return;
    if (!playing || this.muted) {
      if (this.playing) this.stop();
      return;
    }
    const expected = this.ctx.currentTime - this.startedAt;
    if (!this.playing || Math.abs(expected - t) > 0.08) this.start(t);
  }

  private start(t: number): void {
    if (!this.buffer || !this.ctx) return;
    this.stop();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this.gain ??= this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer;
    s.connect(this.gain);
    const off = Math.max(0, t) % this.buffer.duration;
    s.start(0, off);
    this.src = s;
    this.startedAt = this.ctx.currentTime - t;
    this.playing = true;
  }

  stop(): void {
    try {
      this.src?.stop();
    } catch {
      /* already stopped */
    }
    this.src?.disconnect();
    this.src = null;
    this.playing = false;
  }

  /** Full decoded buffer, for muxing into exported video. */
  get audioBuffer(): AudioBuffer | null {
    return this.buffer;
  }
}
