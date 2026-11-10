// Compiles every demo + a kitchen-sink graph through real WebGPU (headless Chromium).
// Usage: start `npm run dev`, then `node scripts/validate-shaders.mjs [url]`.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const url = process.argv[2] ?? 'http://localhost:5173/?present=0';
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(url);
const results = await page.evaluate(async () => {
  const { analyze } = await import('/src/graph/evaluate.ts');
  const { compileGraph } = await import('/src/graph/compile.ts');
  const { buildSceneShader, buildParticleCompute, BLOOM_DOWN, BLOOM_UP, COMPOSITE, COMBINE, PARTICLE_RENDER } = await import('/src/gpu/shaders.ts');
  const { DEMOS } = await import('/src/demos.ts');
  const { kitchenSink } = await import('/tests/kitchenSink.ts');
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const check = async (name, code) => {
    const m = device.createShaderModule({ code });
    const info = await m.getCompilationInfo();
    const errs = info.messages.filter((x) => x.type === 'error').map((x) => `L${x.lineNum}: ${x.message}`);
    return { name, ok: errs.length === 0, errs: errs.slice(0, 5) };
  };
  const out = [];
  out.push(await check('bloom-down', BLOOM_DOWN));
  out.push(await check('bloom-up', BLOOM_UP));
  out.push(await check('composite', COMPOSITE));
  out.push(await check('combine', COMBINE));
  out.push(await check('particle-render', PARTICLE_RENDER));
  const docs = [...DEMOS.map((d) => [d.name, d.build()]), ['kitchen-sink', kitchenSink()]];
  for (const [name, doc] of docs) {
    const res = compileGraph(doc, analyze(doc));
    out.push(await check(name, buildSceneShader(res.code)));
    out.push(await check(name + ' (particles)', buildParticleCompute(res.code)));
  }
  return out;
});
let bad = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}`);
  for (const e of r.errs) console.log('     ', e);
  if (!r.ok) bad++;
}
await browser.close();
process.exit(bad ? 1 : 0);
