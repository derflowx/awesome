import './style.css';
import { Graph, type ChangeKind } from './graph/graph';
import { History } from './graph/history';
import { analyze, Evaluator, type Analysis } from './graph/evaluate';
import { compileGraph, MAX_SLOTS, type CompileResult } from './graph/compile';
import type { GraphDoc, Vec3 } from './graph/types';
import { Renderer } from './gpu/renderer';
import { TextAtlas } from './gpu/textAtlas';
import { AudioPlayer } from './audio/player';
import { exportVideo } from './export/video';
import { buildFrame } from './engine';
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
const atlas = new TextAtlas();
const audio = new AudioPlayer();
let renderer: Renderer | null = null;
let an: Analysis = analyze(graph.doc);
let compiled: CompileResult = compileGraph(graph.doc, an);
let lastCode = '';

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
    particleReset = true;
    void recompile();
  }
  if (kind === 'load') {
    timeline.setDuration(graph.doc.duration ?? 10);
  }
  autosave();
});

timeline.onSeek = () => {
  particleReset = true;
};
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

// panel resize (desktop: width, mobile: height)
const appEl = $('app');
const splitter = $('splitter');
splitter.addEventListener('pointerdown', (e) => {
  splitter.setPointerCapture(e.pointerId);
  const mobile = window.matchMedia('(max-width: 820px)').matches;
  const move = (ev: PointerEvent) => {
    if (mobile) appEl.style.setProperty('--panel-h', `${Math.min(80, Math.max(20, (1 - ev.clientY / window.innerHeight) * 100))}vh`);
    else appEl.style.setProperty('--panel-w', `${Math.min(window.innerWidth - 240, Math.max(320, window.innerWidth - ev.clientX - 12))}px`);
    editor.updateWires();
  };
  const up = () => {
    splitter.removeEventListener('pointermove', move);
    splitter.removeEventListener('pointerup', up);
    editor.updateWires();
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
});

/** Offset (in CSS px) from the canvas centre to the centre of the area not covered by panels. */
function visibleCenterShift(): [number, number] {
  if (document.body.classList.contains('maximized')) return [0, 0];
  const panel = $('panel').getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  if (panel.width === 0) return [0, 0];
  if (panel.top > vh * 0.3) {
    // Bottom sheet: centre in the area above it.
    return [0, (panel.top - vh) / 2];
  }
  return [(panel.left - vw) / 2, 0];
}

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
  } else if (e.key === 'c' && !mod && graphCameraAvailable) {
    setGraphCamera(!useGraphCamera);
  }
});

// ------------------------------------------------------------------ render loop
const canvas = $<HTMLCanvasElement>('view');
const hud = $('hud');
camera.attach(canvas, () => {
  // Grabbing the viewport while a director camera runs switches to free camera.
  if (graphCameraAvailable && useGraphCamera) setGraphCamera(false, true);
});
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
let exporting = false;
let particleReset = true;
let lastPaletteAt = 0;
let lastShift: [number, number] = [0, 0];

function sameSig(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (exporting) return;
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
  audio.sync(t, timeline.playing);
  const values = evaluator.evaluate(graph.doc, an, t);
  editor.updateLive(values, t);
  atlas.sync(graph.doc);
  if (!renderer) return;

  camera.update(dt);
  const built = buildFrame({ doc: graph.doc, an, values, compiled, params, atlas, t, orbit: camera, useGraphCamera });
  if (built.graphCamera !== graphCameraAvailable) {
    graphCameraAvailable = built.graphCamera;
    paintCamButton();
  }
  const f = built.frame;

  // Is the scene still? Then render at full res and accumulate samples.
  const still = sameSig(built.signature, prevSig) && renderer.ready && !(f.particles && timeline.playing);
  prevSig = built.signature;
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
  const shift = visibleCenterShift();
  f.lensShift = [shift[0] * dpr * scale, shift[1] * dpr * scale];
  if (shift[0] !== lastShift[0] || shift[1] !== lastShift[1]) {
    lastShift = shift;
    sampleIndex = 0;
    f.sampleIndex = 0;
  }
  f.particleDt = timeline.playing ? dt : 0;
  f.particleReset = particleReset;
  particleReset = false;

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

  // The UI borrows its accent colors from the render.
  if (now - lastPaletteAt > 350) {
    lastPaletteAt = now;
    void renderer.samplePalette().then((pal) => pal && applyArtPalette(pal));
  }

  hud.textContent = `${fps.toFixed(0)} fps \u00b7 ${w}\u00d7${h}` +
    (sampleIndex > 0 ? ` \u00b7 ${Math.min(sampleIndex, MAX_SAMPLES)} spp` : '') +
    (f.particles ? ` \u00b7 ${(f.particles.count / 1000).toFixed(0)}k particles` : '') +
    (useGraphCamera && graphCameraAvailable ? ' \u00b7 \ud83c\udfac director' : '');
  if (renderer.lastError) setStatus(renderer.lastError, 'error');
}

// ------------------------------------------------------------------ art-reactive UI colors
const artA: Vec3 = [0.24, 0.95, 0.77];
const artB: Vec3 = [1, 0.37, 0.54];
function applyArtPalette(pal: Vec3[]): void {
  // Pick the two most saturated, reasonably bright samples.
  const score = (c: Vec3) => {
    const mx = Math.max(...c), mn = Math.min(...c);
    return (mx - mn) / (mx + 1e-4) * Math.min(1, mx * 4);
  };
  const sorted = [...pal].filter((c) => c.every(isFinite)).sort((a, b) => score(b) - score(a));
  if (!sorted.length) return;
  const norm = (c: Vec3): Vec3 => {
    const mx = Math.max(...c, 1e-4);
    const v = c.map((x) => x / mx) as Vec3;
    // Keep it vivid: push saturation up, never let it go grey.
    const avg = (v[0] + v[1] + v[2]) / 3;
    return v.map((x) => Math.min(1, Math.max(0.08, avg + (x - avg) * 1.6))) as Vec3;
  };
  const a = norm(sorted[0]);
  let bc = sorted.find((c) => {
    const n = norm(c);
    return Math.hypot(n[0] - a[0], n[1] - a[1], n[2] - a[2]) > 0.45;
  });
  const b = bc ? norm(bc) : ([a[2], a[0], a[1]] as Vec3);
  for (let i = 0; i < 3; i++) {
    artA[i] += (a[i] - artA[i]) * 0.15;
    artB[i] += (b[i] - artB[i]) * 0.15;
  }
  const css = (c: Vec3) => `rgb(${c.map((x) => Math.round(x * 255)).join(' ')})`;
  document.documentElement.style.setProperty('--art-a', css(artA));
  document.documentElement.style.setProperty('--art-b', css(artB));
}

// ------------------------------------------------------------------ director / free camera
let useGraphCamera = true;
let graphCameraAvailable = false;
const camBtn = $('btn-cam');
function paintCamButton(): void {
  camBtn.hidden = !graphCameraAvailable;
  camBtn.textContent = useGraphCamera ? '\ud83c\udfac Director' : '\u270b Free cam';
  camBtn.classList.toggle('on', useGraphCamera);
}
function setGraphCamera(on: boolean, quiet = false): void {
  if (!on && useGraphCamera) {
    // Hand over smoothly: start the free camera where the director was.
    const values = evaluator.values;
    const built = buildFrame({ doc: graph.doc, an, values, compiled, params, atlas, t: timeline.time, orbit: camera, useGraphCamera: true });
    const p = built.frame.camPos, fw = built.frame.fwd;
    const dist = 6;
    const target: Vec3 = [p[0] + fw[0] * dist, p[1] + fw[1] * dist, p[2] + fw[2] * dist];
    const yaw = Math.atan2(p[0] - target[0], p[2] - target[2]);
    const pitch = Math.asin(Math.max(-1, Math.min(1, (p[1] - target[1]) / dist)));
    camera.set({ yaw, pitch, dist, target }, true);
  }
  useGraphCamera = on;
  paintCamButton();
  if (!quiet) toast(on ? 'Director camera' : 'Free camera: drag to orbit');
}
camBtn.addEventListener('click', () => setGraphCamera(!useGraphCamera));

// ------------------------------------------------------------------ audio
const audioBtn = $('btn-audio');
const audioInput = $<HTMLInputElement>('audio-file');
async function loadAudio(file: File): Promise<void> {
  setStatus(`analysing ${file.name}\u2026`, 'busy');
  try {
    const a = await audio.load(file, file.name);
    if (a.duration > timeline.duration) {
      timeline.setDuration(Math.ceil(a.duration));
      graph.doc.duration = Math.ceil(a.duration);
    }
    audioBtn.textContent = `\u266b ${file.name.replace(/\.[^.]+$/, '').slice(0, 18)}`;
    audioBtn.classList.add('on');
    setStatus(`audio: ${a.duration.toFixed(1)}s analysed`, 'ok');
    toast('Audio loaded \u2013 Audio nodes now follow your track');
    timeline.seek(0);
  } catch (e) {
    setStatus('audio failed', 'error');
    toast(`Could not read audio: ${(e as Error).message}`, 'error');
  }
}
audioBtn.addEventListener('click', () => {
  if (audio.loaded) {
    audio.unload();
    audioBtn.textContent = '\u266b Audio';
    audioBtn.classList.remove('on');
    toast('Audio removed \u2013 back to the built-in groove');
  } else audioInput.click();
});
audioInput.addEventListener('change', () => {
  const f = audioInput.files?.[0];
  if (f) void loadAudio(f);
  audioInput.value = '';
});
const viewportEl = $('viewport');
viewportEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  viewportEl.classList.add('dropping');
});
viewportEl.addEventListener('dragleave', () => viewportEl.classList.remove('dropping'));
viewportEl.addEventListener('drop', (e) => {
  e.preventDefault();
  viewportEl.classList.remove('dropping');
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  if (f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(f.name)) void loadAudio(f);
  else if (f.name.endsWith('.json')) void f.text().then((txt) => loadDoc(JSON.parse(txt)));
  else toast('Drop an audio file or a .flux.json scene', 'error');
});

// ------------------------------------------------------------------ export
const exportDlg = $<HTMLDialogElement>('export-dialog');
$('btn-export').addEventListener('click', () => {
  ($('ex-duration') as HTMLInputElement).value = String(timeline.duration);
  $('ex-progress').hidden = true;
  $('ex-go').removeAttribute('disabled');
  exportDlg.showModal();
});
$('ex-cancel').addEventListener('click', () => {
  exportAbort?.abort();
  exportDlg.close();
});
let exportAbort: AbortController | null = null;
$('ex-go').addEventListener('click', async () => {
  if (!renderer || exporting) return;
  const [w, h] = ($('ex-res') as HTMLSelectElement).value.split('x').map(Number);
  const fpsOut = Number(($('ex-fps') as HTMLSelectElement).value);
  const quality = ($('ex-quality') as HTMLSelectElement).value;
  const samples = quality === 'draft' ? 1 : quality === 'high' ? 8 : 16;
  const duration = Math.max(0.1, Number(($('ex-duration') as HTMLInputElement).value) || timeline.duration);
  const bar = $('ex-bar');
  const label = $('ex-label');
  $('ex-progress').hidden = false;
  $('ex-go').setAttribute('disabled', '');
  exporting = true;
  exportAbort = new AbortController();
  audio.stop();
  const t0 = performance.now();
  try {
    const blob = await exportVideo(
      { renderer, canvas, doc: graph.doc, an, compiled, atlas, orbit: camera, useGraphCamera, audio: audio.audioBuffer },
      { width: w, height: h, fps: fpsOut, start: 0, duration, samples, shutter: samples > 1 ? 0.5 : 0, bitrate: Math.round(w * h * fpsOut * 0.25) },
      (frac, i, total) => {
        bar.style.width = `${(frac * 100).toFixed(1)}%`;
        const el = (performance.now() - t0) / 1000;
        const eta = frac > 0 ? (el / frac) * (1 - frac) : 0;
        label.textContent = `frame ${i}/${total} \u00b7 ${eta.toFixed(0)}s left`;
      },
      exportAbort.signal,
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(graph.doc.name || 'fluxion').replace(/\W+/g, '-').toLowerCase()}.mp4`;
    a.click();
    toast(`Exported ${(blob.size / 1e6).toFixed(1)} MB MP4`);
    exportDlg.close();
  } catch (e) {
    if ((e as Error).name !== 'AbortError') toast(`Export failed: ${(e as Error).message}`, 'error');
  } finally {
    exporting = false;
    particleReset = true;
    sampleIndex = 0;
    prevSig = new Float32Array(0);
    $('ex-go').removeAttribute('disabled');
  }
});

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
  const r = renderer;
  atlas.onUpload = (row, data) => r.writeAtlasRow(row, data);
  atlas.reset();
  particleReset = true;
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
Object.assign(window, { fluxion: { graph, history, editor, timeline, camera, captureDataURL, audio, setGraphCamera, get renderer() { return renderer; }, get compiled() { return compiled; } } });
