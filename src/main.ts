import './style.css';
import { Graph, type ChangeKind } from './graph/graph';
import { History } from './graph/history';
import { analyze, asFloat, asVec3, Evaluator, readInput, type Analysis } from './graph/evaluate';
import { compileGraph, fillSlots, MAX_SLOTS, type CompileResult } from './graph/compile';
import type { GraphDoc, Vec3 } from './graph/types';
import { Renderer, type FrameInputs } from './gpu/renderer';
import { NodeEditor } from './editor/NodeEditor';
import { Timeline } from './ui/timeline';
import { OrbitCamera, DEFAULT_CAMERA } from './ui/camera';
import { blankDoc, DEMOS } from './demos';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const STORAGE_KEY = 'fluxion.autosave.v1';

// ------------------------------------------------------------------ state
const graph = new Graph();
const history = new History(graph);
const evaluator = new Evaluator();
const camera = new OrbitCamera();
const editor = new NodeEditor($('editor'), graph, history);
const timeline = new Timeline($('timeline'));
let renderer: Renderer | null = null;
let an: Analysis = analyze(graph.doc);
let compiled: CompileResult = compileGraph(graph.doc, an);
let lastCode = '';
let compileMs = 0;

// ------------------------------------------------------------------ status
const toastEl = $('toast');
let toastTimer = 0;
function toast(msg: string, kind: 'info' | 'error' = 'info'): void {
  toastEl.textContent = msg;
  toastEl.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.className = 'toast'), 2600);
}
editor.onStatus = toast;

const statusEl = $('status');
function setStatus(msg: string, kind: 'ok' | 'busy' | 'error'): void {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`;
}

// ------------------------------------------------------------------ graph -> GPU
async function recompile(): Promise<void> {
  an = analyze(graph.doc);
  compiled = compileGraph(graph.doc, an);
  editor.setAnalysis(an);
  if (compiled.errors.length) setStatus(compiled.errors[0], 'error');
  if (!renderer || compiled.code === lastCode) return;
  lastCode = compiled.code;
  setStatus('compiling…', 'busy');
  const res = await renderer.setScene(compiled.code);
  compileMs = res.ms;
  const errBox = $('gpu-error');
  if (res.ok) {
    setStatus(`compiled ${compiled.gpuNodes} GPU nodes · ${res.ms.toFixed(0)} ms`, 'ok');
    errBox.hidden = true;
  } else {
    setStatus('shader error', 'error');
    errBox.hidden = false;
    errBox.textContent = `Shader failed to compile (showing the last good one):\n${res.errors.slice(0, 4).join('\n')}`;
    console.error(res.errors.join('\n'));
  }
}

let saveTimer = 0;
function autosave(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...graph.doc, camera: camera.target }));
    } catch {
      /* storage unavailable */
    }
  }, 400);
}

graph.on((kind: ChangeKind) => {
  if (kind === 'structure' || kind === 'load') {
    editor.rebuild();
    evaluator.reset();
    void recompile();
  }
  if (kind === 'load') {
    timeline.setDuration(graph.doc.duration ?? 10);
  }
  autosave();
});

timeline.onSeek = () => {};
timeline.onDuration = (d) => {
  graph.doc.duration = d;
  history.commit();
  autosave();
};

function loadDoc(doc: GraphDoc, frame = true): void {
  graph.load(doc);
  history.reset();
  camera.set(doc.camera ?? DEFAULT_CAMERA, true);
  timeline.seek(0);
  if (frame) requestAnimationFrame(() => editor.frameAll());
}

// ------------------------------------------------------------------ share links
async function encodeDoc(doc: GraphDoc): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = '';
  buf.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function decodeDoc(code: string): Promise<GraphDoc> {
  const bin = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return JSON.parse(await new Response(stream).text());
}

// ------------------------------------------------------------------ toolbar
const demoSel = $<HTMLSelectElement>('demo');
demoSel.append(new Option('Demo scenes…', ''));
DEMOS.forEach((d, i) => demoSel.append(new Option(d.name, String(i))));
demoSel.addEventListener('change', () => {
  const d = DEMOS[Number(demoSel.value)];
  if (d) {
    loadDoc(d.build());
    toast(`Loaded “${d.name}”`);
  }
  demoSel.value = '';
});
$('btn-new').addEventListener('click', () => loadDoc(blankDoc()));
$('btn-save').addEventListener('click', saveFile);
function saveFile(): void {
  const doc = { ...graph.doc, camera: camera.target };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(doc.name || 'scene').replace(/\W+/g, '-').toLowerCase()}.flux.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const fileInput = $<HTMLInputElement>('file');
$('btn-open').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  try {
    loadDoc(JSON.parse(await f.text()));
    toast(`Opened ${f.name}`);
  } catch (e) {
    toast(`Could not open file: ${(e as Error).message}`, 'error');
  }
  fileInput.value = '';
});
$('btn-share').addEventListener('click', async () => {
  const code = await encodeDoc({ ...graph.doc, camera: camera.target });
  const url = `${location.origin}${location.pathname}#g=${code}`;
  history.commit();
  try {
    await navigator.clipboard.writeText(url);
    toast('Share link copied to clipboard');
  } catch {
    window.prompt('Copy this link:', url);
  }
});
$('btn-undo').addEventListener('click', () => history.undo());
$('btn-redo').addEventListener('click', () => history.redo());
const orbitBtn = $('btn-orbit');
orbitBtn.addEventListener('click', () => {
  camera.autoRotate = !camera.autoRotate;
  orbitBtn.classList.toggle('on', camera.autoRotate);
});
let snapshotRequested = false;
$('btn-snap').addEventListener('click', () => (snapshotRequested = true));
const maxBtn = $('btn-max');
function toggleMax(): void {
  document.body.classList.toggle('maximized');
  maxBtn.classList.toggle('on', document.body.classList.contains('maximized'));
  requestAnimationFrame(() => editor.updateWires());
}
maxBtn.addEventListener('click', toggleMax);

// splitter
const split = $('split');
const splitter = $('splitter');
splitter.addEventListener('pointerdown', (e) => {
  splitter.setPointerCapture(e.pointerId);
  const vertical = getComputedStyle(split).flexDirection === 'column';
  const move = (ev: PointerEvent) => {
    const r = split.getBoundingClientRect();
    const f = vertical ? (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width;
    split.style.setProperty('--view', `${Math.min(85, Math.max(15, f * 100))}%`);
  };
  const up = () => {
    splitter.removeEventListener('pointermove', move);
    splitter.removeEventListener('pointerup', up);
    editor.updateWires();
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
});

// global keys
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.code === 'Space') {
    e.preventDefault();
    timeline.toggle();
  } else if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) history.redo();
    else history.undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    history.redo();
  } else if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveFile();
  } else if (e.key === 'Home') {
    timeline.seek(0);
  } else if (e.key === '`') {
    toggleMax();
  }
});

// ------------------------------------------------------------------ render loop
const canvas = $<HTMLCanvasElement>('view');
const hud = $('hud');
camera.attach(canvas, () => {});
const params = new Float32Array(MAX_SLOTS * 4);
let prevSig = new Float32Array(0);
let sampleIndex = 0;
let stillFrames = 0;
// ?scale=0.5 caps render resolution (handy on slow GPUs).
let maxScale = Math.min(1, Math.max(0.1, Number(new URLSearchParams(location.search).get('scale')) || 1));
let dynScale = maxScale;
let lastScaleChange = 0;
let smoothDt = 1 / 60;
let lastNow = performance.now();
let fpsAcc = 0, fpsFrames = 0, fps = 0;

function sameSig(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  smoothDt += (dt - smoothDt) * 0.1;
  fpsAcc += dt;
  fpsFrames++;
  if (fpsAcc > 0.5) {
    fps = fpsFrames / fpsAcc;
    fpsAcc = 0;
    fpsFrames = 0;
  }

  timeline.tick(dt);
  const t = timeline.time;
  const values = evaluator.evaluate(graph.doc, an, t);
  editor.updateLive(values, t);
  if (!renderer) return;

  camera.update(dt);
  const out = graph.output();
  const get = (name: string) => (out ? readInput(graph.doc, an, values, out, name) : 0);
  fillSlots(graph.doc, an, values, compiled.slots, params, 0);

  const cb = camera.basis();
  const yaw = (asFloat(get('lightYaw')) * Math.PI) / 180;
  const pitch = (asFloat(get('lightPitch')) * Math.PI) / 180;
  const sunDir: Vec3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const lp = asFloat(get('lightPower'));
  const f: FrameInputs = {
    camPos: cb.pos, right: cb.right, up: cb.up, fwd: cb.fwd,
    tanHalfFov: Math.tan((camera.fov * Math.PI) / 360),
    sky: asVec3(get('sky')), horizon: asVec3(get('horizon')),
    sun: asVec3(get('light')).map((c) => c * lp) as Vec3, sunDir,
    glow: asFloat(get('glow')), fog: asFloat(get('fog')), time: t,
    steps: 0, sampleIndex: 0, params,
    exposure: asFloat(get('exposure')), bloom: asFloat(get('bloom')), vignette: asFloat(get('vignette')),
    grain: asFloat(get('grain')), aberration: asFloat(get('aberration')),
  };

  // Is the scene still? Then render at full res and accumulate samples.
  const sig = new Float32Array([...cb.pos, ...cb.fwd, ...f.sky, ...f.horizon, ...f.sun, ...sunDir, f.glow, f.fog, ...params.subarray(0, compiled.slots.length * 4)]);
  const still = sameSig(sig, prevSig) && renderer.ready;
  prevSig = sig;
  stillFrames = still ? stillFrames + 1 : 0;

  // Dynamic resolution while things move.
  if (stillFrames === 0 && now - lastScaleChange > 400) {
    if (smoothDt > 1 / 40 && dynScale > 0.35) { dynScale = Math.max(0.35, dynScale * 0.85); lastScaleChange = now; }
    else if (smoothDt < 1 / 56 && dynScale < maxScale) { dynScale = Math.min(maxScale, dynScale * 1.1); lastScaleChange = now; }
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = stillFrames > 2 ? maxScale : dynScale;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr * scale));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr * scale));
  let resized = false;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    resized = true;
  }
  sampleIndex = still && !resized ? sampleIndex + 1 : 0;
  f.sampleIndex = sampleIndex;
  f.steps = sampleIndex === 0 ? 180 : 280;

  const MAX_SAMPLES = 96;
  if (sampleIndex <= MAX_SAMPLES || snapshotRequested) renderer.render(f);

  if (snapshotRequested) {
    snapshotRequested = false;
    void captureDataURL().then((url) => {
      if (!url) return;
      const a = document.createElement('a');
      a.href = url;
      a.download = `fluxion-${Date.now()}.png`;
      a.click();
      toast('Snapshot saved');
    });
  }

  hud.textContent = `${fps.toFixed(0)} fps · ${w}×${h}` +
    (sampleIndex > 0 ? ` · ${Math.min(sampleIndex, MAX_SAMPLES)} spp` : '') +
    (compileMs ? ` · shader ${compileMs.toFixed(0)}ms` : '');
  if (renderer.lastError) setStatus(renderer.lastError, 'error');
}

async function captureDataURL(): Promise<string | null> {
  const img = await renderer?.capture();
  if (!img) return null;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

let lostCount = 0;
async function initRenderer(): Promise<void> {
  renderer = await Renderer.create(canvas);
  renderer.present = new URLSearchParams(location.search).get('present') !== '0';
  renderer.onLost = (msg) => {
    renderer = null;
    if (++lostCount > 3) {
      setStatus(`GPU lost: ${msg}`, 'error');
      return;
    }
    // GPU resets happen (driver timeouts, sleep). Recover automatically at lower resolution.
    maxScale = Math.max(0.25, maxScale * 0.6);
    dynScale = Math.min(dynScale, maxScale);
    toast('GPU reset \u2013 recovering at lower resolution', 'error');
    setTimeout(() => void initRenderer().catch((e) => setStatus(String(e), 'error')), 500);
  };
  lastCode = '';
  await recompile();
}

// ------------------------------------------------------------------ boot
async function boot(): Promise<void> {
  let initial: GraphDoc | null = null;
  const m = location.hash.match(/#g=([\w-]+)/);
  if (m) {
    try {
      initial = await decodeDoc(m[1]);
      history.commit();
    } catch {
      toast('Share link could not be decoded', 'error');
    }
  }
  if (!initial) {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) initial = JSON.parse(saved);
    } catch {
      /* ignore */
    }
  }
  loadDoc(initial ?? DEMOS[0].build());

  try {
    await initRenderer();
  } catch (e) {
    const box = $('gpu-error');
    box.hidden = false;
    box.classList.add('fatal');
    box.textContent = `${(e as Error).message}\n\nFluxion needs WebGPU: use a recent Chrome, Edge or Arc (desktop), or Safari 26+. The node editor still works.`;
    setStatus('no WebGPU', 'error');
  }
  requestAnimationFrame(frame);
}

void boot();

// Expose for debugging / automation.
Object.assign(window, { fluxion: { graph, history, editor, timeline, camera, captureDataURL, get compiled() { return compiled; } } });
