/**
 * Offline audio analysis. A loaded track is analysed once into per-frame band
 * energies, so audio-reactive nodes are deterministic: scrubbing and video
 * export give exactly the same result as live playback.
 */
export type Band = 'bass' | 'mid' | 'high' | 'level' | 'beat';
export const BANDS: Band[] = ['bass', 'mid', 'high', 'level', 'beat'];

export interface AudioAnalysis {
  name: string;
  fps: number;
  duration: number;
  bands: Record<Band, Float32Array>;
}

let current: AudioAnalysis | null = null;
const listeners = new Set<() => void>();

export function setAnalysis(a: AudioAnalysis | null): void {
  current = a;
  listeners.forEach((l) => l());
}
export function getAnalysis(): AudioAnalysis | null {
  return current;
}
export function onAnalysisChange(fn: () => void): void {
  listeners.add(fn);
}

/** Built-in groove used when no track is loaded, so demos always move. 120 BPM. */
function synthetic(band: Band, t: number): number {
  const beat = 0.5;
  const ph = (t % beat) / beat;
  const kick = Math.exp(-ph * 7);
  const bar = Math.floor(t / beat) % 4;
  const hatPh = ((t + beat / 2) % beat) / beat;
  const hat = Math.exp(-hatPh * 18) * 0.8;
  const snare = bar % 2 === 1 ? Math.exp(-ph * 10) : 0;
  switch (band) {
    case 'bass': return 0.08 + kick * 0.9;
    case 'mid': return 0.25 + snare * 0.6 + 0.1 * Math.sin(t * 1.3);
    case 'high': return 0.1 + hat;
    case 'beat': return kick;
    default: return 0.2 + kick * 0.5 + snare * 0.2 + hat * 0.1;
  }
}

export function sampleAudio(band: Band, t: number): number {
  const a = current;
  if (!a) return synthetic(band, t);
  const arr = a.bands[band];
  const f = t * a.fps;
  if (f <= 0) return arr[0] ?? 0;
  const i = Math.floor(f);
  if (i >= arr.length - 1) return arr[arr.length - 1] ?? 0;
  const u = f - i;
  return arr[i] * (1 - u) + arr[i + 1] * u;
}

// ---------------------------------------------------------------- FFT
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function normalize(arr: Float32Array): void {
  const sorted = Float32Array.from(arr).sort();
  const p98 = sorted[Math.floor(sorted.length * 0.98)] || 1;
  for (let i = 0; i < arr.length; i++) arr[i] = Math.min(1.5, arr[i] / p98);
}

export interface PcmSource {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  getChannelData(ch: number): Float32Array;
}

export function analyze(buf: PcmSource, name = 'track', fps = 60): AudioAnalysis {
  const sr = buf.sampleRate;
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
  }
  const N = 2048;
  const hop = sr / fps;
  const frames = Math.max(1, Math.floor(buf.length / hop));
  const bands: Record<Band, Float32Array> = {
    bass: new Float32Array(frames), mid: new Float32Array(frames), high: new Float32Array(frames),
    level: new Float32Array(frames), beat: new Float32Array(frames),
  };
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const re = new Float32Array(N), im = new Float32Array(N);
  const binHz = sr / N;
  const range = (lo: number, hi: number) => [Math.max(1, Math.floor(lo / binHz)), Math.min(N / 2, Math.ceil(hi / binHz))];
  const [b0, b1] = range(25, 160), [m0, m1] = range(160, 2200), [h0, h1] = range(2200, 14000);
  const flux = new Float32Array(frames);
  let prevBass = 0;
  for (let f = 0; f < frames; f++) {
    const start = Math.floor(f * hop - N / 2);
    let rms = 0;
    for (let i = 0; i < N; i++) {
      const s = mono[start + i] ?? 0;
      re[i] = s * win[i];
      im[i] = 0;
      rms += s * s;
    }
    fft(re, im);
    const mag = (lo: number, hi: number) => {
      let s = 0;
      for (let k = lo; k < hi; k++) s += Math.hypot(re[k], im[k]);
      return s / Math.max(1, hi - lo);
    };
    const bass = mag(b0, b1);
    bands.bass[f] = bass;
    bands.mid[f] = mag(m0, m1);
    bands.high[f] = mag(h0, h1);
    bands.level[f] = Math.sqrt(rms / N);
    flux[f] = Math.max(0, bass - prevBass);
    prevBass = bass;
  }
  // Onset detection on bass flux with an adaptive threshold -> decaying beat envelope.
  const W = Math.round(fps * 0.5);
  let env = 0;
  let lastHit = -1e9;
  for (let f = 0; f < frames; f++) {
    let mean = 0, cnt = 0;
    for (let k = Math.max(0, f - W); k < Math.min(frames, f + W); k++) { mean += flux[k]; cnt++; }
    mean /= cnt;
    const hit = flux[f] > mean * 1.8 && flux[f] > 1e-4 && f - lastHit > fps * 0.18;
    if (hit) { env = 1; lastHit = f; }
    bands.beat[f] = env;
    env *= Math.exp(-7 / fps);
  }
  for (const b of ['bass', 'mid', 'high', 'level'] as Band[]) normalize(bands[b]);
  return { name, fps, duration: buf.length / sr, bands };
}
