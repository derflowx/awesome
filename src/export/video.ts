import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { Evaluator, type Analysis } from '../graph/evaluate';
import type { CompileResult } from '../graph/compile';
import type { GraphDoc } from '../graph/types';
import type { Renderer } from '../gpu/renderer';
import type { TextAtlas } from '../gpu/textAtlas';
import type { OrbitCamera } from '../ui/camera';
import { buildFrame } from '../engine';

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  start: number;
  duration: number;
  /** Sub-frames rendered and averaged per frame: anti-aliasing + motion blur. */
  samples: number;
  /** Fraction of a frame the virtual shutter stays open (0 = no motion blur). */
  shutter: number;
  bitrate: number;
}

export interface ExportContext {
  renderer: Renderer;
  canvas: HTMLCanvasElement;
  doc: GraphDoc;
  an: Analysis;
  compiled: CompileResult;
  atlas: TextAtlas;
  orbit: OrbitCamera;
  useGraphCamera: boolean;
  audio: AudioBuffer | null;
}

async function pickVideoCodec(w: number, h: number, fps: number, bitrate: number): Promise<{ codec: string; mux: 'avc' | 'vp9' }> {
  // H.264 first (plays everywhere), VP9 as a fallback for browsers without an H.264 encoder.
  const candidates: [string, 'avc' | 'vp9'][] = [
    ['avc1.640034', 'avc'], ['avc1.640033', 'avc'], ['avc1.640028', 'avc'], ['avc1.4d0034', 'avc'], ['avc1.42003e', 'avc'],
    ['vp09.00.51.08', 'vp9'], ['vp09.00.41.08', 'vp9'], ['vp09.00.31.08', 'vp9'],
  ];
  for (const [codec, mux] of candidates) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate, framerate: fps });
      if (r.supported) return { codec, mux };
    } catch {
      /* not supported */
    }
  }
  throw new Error('This browser cannot encode video at this size (try Chrome or Edge, or a smaller format).');
}

async function pickAudio(sampleRate: number, ch: number): Promise<{ codec: string; mux: 'aac' | 'opus' } | null> {
  for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']] as const) {
    try {
      const r = await AudioEncoder.isConfigSupported({ codec, sampleRate, numberOfChannels: ch, bitrate: 192000 });
      if (r.supported) return { codec, mux };
    } catch {
      /* unsupported */
    }
  }
  return null;
}

export async function exportVideo(
  ctx: ExportContext,
  o: ExportOptions,
  onProgress: (frac: number, frame: number, total: number) => void,
  signal: AbortSignal,
): Promise<Blob> {
  if (!('VideoEncoder' in window)) throw new Error('Video export needs WebCodecs (Chrome, Edge or Safari 17+).');
  const w = o.width & ~1, h = o.height & ~1;
  const { codec, mux } = await pickVideoCodec(w, h, o.fps, o.bitrate);
  const audioBuf = ctx.audio;
  const audioCfg = audioBuf ? await pickAudio(audioBuf.sampleRate, Math.min(2, audioBuf.numberOfChannels)) : null;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: mux, width: w, height: h, frameRate: o.fps },
    audio: audioCfg && audioBuf ? { codec: audioCfg.mux, sampleRate: audioBuf.sampleRate, numberOfChannels: Math.min(2, audioBuf.numberOfChannels) } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let encErr: Error | null = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (encErr = e),
  });
  venc.configure({ codec, width: w, height: h, bitrate: o.bitrate, framerate: o.fps, latencyMode: 'quality' });

  const prevW = ctx.canvas.width, prevH = ctx.canvas.height;
  ctx.canvas.width = w;
  ctx.canvas.height = h;
  const evaluator = new Evaluator();
  const params = new Float32Array(ctx.compiled.slots.length * 4 + 4096);
  const total = Math.max(1, Math.round(o.duration * o.fps));
  const S = Math.max(1, Math.round(o.samples));
  try {
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (encErr) throw encErr;
      for (let s = 0; s < S; s++) {
        const t = o.start + (i + (S > 1 ? (s / S) * o.shutter : 0)) / o.fps;
        const values = evaluator.evaluate(ctx.doc, ctx.an, t);
        const { frame } = buildFrame({
          doc: ctx.doc, an: ctx.an, values, compiled: ctx.compiled, params, atlas: ctx.atlas, t,
          orbit: ctx.orbit, useGraphCamera: ctx.useGraphCamera,
        });
        frame.sampleIndex = s;
        frame.steps = 260;
        frame.particleReset = i === 0 && s === 0;
        frame.particleDt = 1 / o.fps / S;
        ctx.renderer.render(frame);
      }
      const img = await ctx.renderer.capture();
      if (!img) throw new Error('Frame capture failed');
      const vf = new VideoFrame(img.data, {
        format: 'RGBA', codedWidth: img.width, codedHeight: img.height,
        timestamp: Math.round((i * 1e6) / o.fps), duration: Math.round(1e6 / o.fps),
      });
      venc.encode(vf, { keyFrame: i % (o.fps * 2) === 0 });
      vf.close();
      while (venc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 5));
      onProgress((i + 1) / total, i + 1, total);
    }
    await venc.flush();

    if (audioCfg && audioBuf) {
      const ch = Math.min(2, audioBuf.numberOfChannels);
      const sr = audioBuf.sampleRate;
      const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (encErr = e) });
      aenc.configure({ codec: audioCfg.codec, sampleRate: sr, numberOfChannels: ch, bitrate: 192000 });
      const startS = Math.floor(o.start * sr);
      const endS = Math.min(audioBuf.length, Math.floor((o.start + o.duration) * sr));
      const block = 4096;
      for (let p = startS; p < endS; p += block) {
        const n = Math.min(block, endS - p);
        const planar = new Float32Array(n * ch);
        for (let c = 0; c < ch; c++) planar.set(audioBuf.getChannelData(c).subarray(p, p + n), c * n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round(((p - startS) / sr) * 1e6), data: planar });
        aenc.encode(ad);
        ad.close();
      }
      await aenc.flush();
    }
    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  } finally {
    if (venc.state !== 'closed') venc.close();
    ctx.canvas.width = prevW;
    ctx.canvas.height = prevH;
  }
}
