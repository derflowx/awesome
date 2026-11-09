import { BLOOM_DOWN, BLOOM_UP, COMPOSITE, HEADER_VEC4S, buildSceneShader } from './shaders';
import { MAX_SLOTS } from '../graph/compile';
import type { Vec3 } from '../graph/types';

export interface FrameInputs {
  camPos: Vec3;
  right: Vec3;
  up: Vec3;
  fwd: Vec3;
  tanHalfFov: number;
  sky: Vec3;
  horizon: Vec3;
  sun: Vec3;
  sunDir: Vec3;
  glow: number;
  fog: number;
  time: number;
  steps: number;
  /** Index of the progressive sample; 0 means start fresh. */
  sampleIndex: number;
  params: Float32Array; // MAX_SLOTS * 4
  exposure: number;
  bloom: number;
  vignette: number;
  grain: number;
  aberration: number;
}

export interface CompileOutcome {
  ok: boolean;
  errors: string[];
  ms: number;
}

const HDR: GPUTextureFormat = 'rgba16float';
const BLOOM_LEVELS = 6;

function halton(i: number, b: number): number {
  let f = 1, r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
}

export class Renderer {
  readonly device: GPUDevice;
  private ctx: GPUCanvasContext;
  private format: GPUTextureFormat;
  private sceneBGL: GPUBindGroupLayout;
  private sceneLayout: GPUPipelineLayout;
  private scenePipeline: GPURenderPipeline | null = null;
  private downPipeline: GPURenderPipeline;
  private upPipeline: GPURenderPipeline;
  private compositePipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private sceneUBO: GPUBuffer;
  private postUBO: GPUBuffer;
  private uniformData = new Float32Array((HEADER_VEC4S + MAX_SLOTS) * 4);
  private accum: GPUTexture[] = [];
  private bloom: GPUTexture[] = [];
  private sceneBG: GPUBindGroup[] = [];
  private downBG: GPUBindGroup[][] = []; // [accumIndex][level]
  private upBG: GPUBindGroup[] = [];
  private compositeBG: GPUBindGroup[] = [];
  private cur = 0;
  private w = 0;
  private h = 0;
  private compileVersion = 0;
  lastError: string | null = null;
  onLost: (msg: string) => void = () => {};

  /** When false, frames are rendered but not presented (headless testing; use capture()). */
  present = true;

  static async create(canvas: HTMLCanvasElement): Promise<Renderer> {
    if (!('gpu' in navigator)) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const device = await adapter.requestDevice();
    return new Renderer(canvas, device);
  }

  private constructor(private canvas: HTMLCanvasElement, device: GPUDevice) {
    this.device = device;
    this.ctx = canvas.getContext('webgpu')!;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    device.lost.then((info) => {
      if (info.reason === 'destroyed') return;
      this.lastError = `GPU device lost: ${info.message}`;
      this.onLost(info.message);
    });

    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.sceneUBO = device.createBuffer({ size: this.uniformData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.postUBO = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.sceneBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    this.sceneLayout = device.createPipelineLayout({ bindGroupLayouts: [this.sceneBGL] });

    const down = device.createShaderModule({ code: BLOOM_DOWN, label: 'bloom-down' });
    const up = device.createShaderModule({ code: BLOOM_UP, label: 'bloom-up' });
    const comp = device.createShaderModule({ code: COMPOSITE, label: 'composite' });
    this.downPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: down, entryPoint: 'vsFull' },
      fragment: { module: down, entryPoint: 'fsDown', targets: [{ format: HDR }] },
    });
    this.upPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: up, entryPoint: 'vsFull' },
      fragment: {
        module: up,
        entryPoint: 'fsUp',
        targets: [{ format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } } }],
      },
    });
    this.compositePipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: comp, entryPoint: 'vsFull' },
      fragment: { module: comp, entryPoint: 'fsComposite', targets: [{ format: this.format }] },
    });
  }

  /** Compile a new scene shader. The previous one keeps rendering until this succeeds. */
  async setScene(generated: string): Promise<CompileOutcome> {
    const version = ++this.compileVersion;
    const t0 = performance.now();
    const code = buildSceneShader(generated);
    const module = this.device.createShaderModule({ code, label: 'scene' });
    const info = await module.getCompilationInfo();
    const errs = info.messages.filter((m) => m.type === 'error').map((m) => `line ${m.lineNum}: ${m.message}`);
    if (errs.length) return { ok: false, errors: errs, ms: performance.now() - t0 };
    try {
      const pipe = await this.device.createRenderPipelineAsync({
        layout: this.sceneLayout,
        vertex: { module, entryPoint: 'vsFull' },
        fragment: { module, entryPoint: 'fsScene', targets: [{ format: HDR }] },
      });
      if (version === this.compileVersion) this.scenePipeline = pipe;
      return { ok: true, errors: [], ms: performance.now() - t0 };
    } catch (e) {
      return { ok: false, errors: [String((e as Error).message ?? e)], ms: performance.now() - t0 };
    }
  }

  private ensureTargets(): void {
    const w = Math.max(1, this.canvas.width);
    const h = Math.max(1, this.canvas.height);
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    for (const t of [...this.accum, ...this.bloom]) t.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.accum = [0, 1].map(() => this.device.createTexture({ size: [w, h], format: HDR, usage }));
    this.bloom = [];
    let bw = w, bh = h;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
      this.bloom.push(this.device.createTexture({ size: [bw, bh], format: HDR, usage }));
      if (bw <= 4 || bh <= 4) break;
    }
    const d = this.device;
    this.sceneBG = [0, 1].map((i) =>
      d.createBindGroup({
        layout: this.sceneBGL,
        entries: [
          { binding: 0, resource: { buffer: this.sceneUBO } },
          { binding: 1, resource: this.accum[1 - i].createView() },
        ],
      }),
    );
    const texBG = (pipe: GPURenderPipeline, tex: GPUTexture) =>
      d.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: tex.createView() },
          { binding: 1, resource: this.sampler },
        ],
      });
    this.downBG = [0, 1].map((a) => this.bloom.map((_, lvl) => texBG(this.downPipeline, lvl === 0 ? this.accum[a] : this.bloom[lvl - 1])));
    this.upBG = this.bloom.map((_, lvl) => (lvl + 1 < this.bloom.length ? texBG(this.upPipeline, this.bloom[lvl + 1]) : (null as unknown as GPUBindGroup)));
    this.compositeBG = [0, 1].map((a) =>
      d.createBindGroup({
        layout: this.compositePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.accum[a].createView() },
          { binding: 1, resource: this.bloom[0].createView() },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: { buffer: this.postUBO } },
        ],
      }),
    );
  }

  /** Reads back the last rendered frame (tone mapped) as pixels. */
  async capture(): Promise<ImageData | null> {
    if (!this.w || !this.compositeBG.length) return null;
    const { w, h } = this;
    const tex = this.device.createTexture({ size: [w, h], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
    const buf = this.device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    const p = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    p.setPipeline(this.compositePipeline);
    p.setBindGroup(0, this.compositeBG[1 - this.cur]); // last written accumulation buffer
    p.draw(3);
    p.end();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow }, [w, h]);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const out = new Uint8ClampedArray(w * h * 4);
    const bgra = this.format === 'bgra8unorm';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * bytesPerRow + x * 4;
        const o = (y * w + x) * 4;
        out[o] = src[i + (bgra ? 2 : 0)];
        out[o + 1] = src[i + 1];
        out[o + 2] = src[i + (bgra ? 0 : 2)];
        out[o + 3] = 255;
      }
    }
    buf.unmap();
    buf.destroy();
    tex.destroy();
    return new ImageData(out, w, h);
  }

  destroy(): void {
    this.device.destroy();
  }

  get ready(): boolean {
    return this.scenePipeline !== null;
  }

  render(f: FrameInputs): void {
    if (!this.scenePipeline) return;
    this.ensureTargets();
    const u = this.uniformData;
    const set = (i: number, x: number, y: number, z: number, w: number) => {
      u[i * 4] = x; u[i * 4 + 1] = y; u[i * 4 + 2] = z; u[i * 4 + 3] = w;
    };
    const progressive = f.sampleIndex > 0;
    const jx = progressive ? halton(f.sampleIndex, 2) - 0.5 : 0;
    const jy = progressive ? halton(f.sampleIndex, 3) - 0.5 : 0;
    set(0, this.w, this.h, 1 / this.w, 1 / this.h);
    set(1, ...f.camPos, f.tanHalfFov);
    set(2, ...f.right, 0);
    set(3, ...f.up, 0);
    set(4, ...f.fwd, 0);
    set(5, ...f.sky, 0);
    set(6, ...f.horizon, 0);
    set(7, ...f.sun, 0);
    set(8, ...f.sunDir, 0);
    set(9, f.glow, f.fog, f.time, 1 / (f.sampleIndex + 1));
    set(10, jx, jy, f.sampleIndex, f.steps);
    u.set(f.params.subarray(0, MAX_SLOTS * 4), HEADER_VEC4S * 4);
    this.device.queue.writeBuffer(this.sceneUBO, 0, u);
    this.device.queue.writeBuffer(
      this.postUBO,
      0,
      new Float32Array([f.exposure, f.bloom, f.vignette, f.grain, f.aberration, f.time, this.bloom.length, 0]),
    );

    const enc = this.device.createCommandEncoder();
    const pass = (view: GPUTextureView, load: GPULoadOp = 'clear') =>
      enc.beginRenderPass({ colorAttachments: [{ view, loadOp: load, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });

    const a = this.cur;
    let p = pass(this.accum[a].createView());
    p.setPipeline(this.scenePipeline);
    p.setBindGroup(0, this.sceneBG[a]);
    p.draw(3);
    p.end();

    for (let lvl = 0; lvl < this.bloom.length; lvl++) {
      p = pass(this.bloom[lvl].createView());
      p.setPipeline(this.downPipeline);
      p.setBindGroup(0, this.downBG[a][lvl]);
      p.draw(3);
      p.end();
    }
    for (let lvl = this.bloom.length - 2; lvl >= 0; lvl--) {
      p = pass(this.bloom[lvl].createView(), 'load');
      p.setPipeline(this.upPipeline);
      p.setBindGroup(0, this.upBG[lvl]);
      p.draw(3);
      p.end();
    }

    if (this.present) {
      p = pass(this.ctx.getCurrentTexture().createView());
      p.setPipeline(this.compositePipeline);
      p.setBindGroup(0, this.compositeBG[a]);
      p.draw(3);
      p.end();
    }

    this.device.queue.submit([enc.finish()]);
    this.cur = 1 - a;
  }
}
