# FLUXION: Gameplan

> A node-based motion design engine running on the GPU in the browser.
> Every value can be animated, every node shows a live preview, and the whole graph compiles to a single shader.

---

## 1. The core idea

Most motion tools stack layers on a timeline. Most node tools are static. **Fluxion merges them.**

- **Time is a data type.** Every socket carries a *signal*: a value that changes over time. You can plug a spring, a noise, an audio band, a keyframe curve or a physics sim into any parameter.
- **Fields everywhere.** A field is a 3D function such as "distance to this sphere" or "noise at this point". You plug it into scale, color, emission or deformation to get effects that spread through space.
- **The graph is the program.** The node graph compiles live into fused **WGSL compute and render shaders**. There is no interpreter in the hot path, so the editor runs at full GPU speed.

---

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| GPU | **WebGPU** (WGSL compute and render) | Modern GPU API in the browser, with compute shaders |
| Language | TypeScript + Vite | Fast iteration, instant hot reload |
| UI | React + custom canvas for the node editor | Smooth pan and zoom over thousands of nodes |
| State | Zustand + undo/redo command stack | Simple and time-travel friendly |
| Collaboration (later) | Yjs CRDT | Google-Docs-style live editing of graphs |
| Export | WebCodecs (MP4/WebM), PNG sequence, GIF, embeddable `<fluxion-player>` | Real video export straight from the browser |

---

## 3. Headline features

### Rendering: a hybrid engine
1. **SDF raymarcher.** Smooth-union blobs, infinite repetition, fractals (Mandelbulb, KIFS) and morphing between any two shapes.
2. **GPU particle system.** Millions of particles driven by curl noise, flow fields, attractors and vortex forces, with trails and ribbons.
3. **Gaussian splats.** Import `.ply` / `.splat` scans and deform them with fields, for example by dissolving a real-world scan into particles.
4. **Materials.** Thin-film iridescence, spectral dispersion (prism rainbows), liquid chrome, subsurface glow and holographic foil.
5. **Progressive path-traced preview.** When the scene stops moving, the preview refines toward a photoreal render.

### Motion
6. **Springs as first-class nodes.** Values with physical inertia and overshoot, so motion stops looking robotic.
7. **Motion brush.** Draw a gesture with the mouse or pen and it becomes an animation curve, timing included.
8. **Deterministic, scrubbable simulations.** Seeded sims with checkpoint caching, so you can scrub physics backward.
9. **Audio-reactive.** Drop in a track and its FFT bands, beats and onsets become signals you can wire anywhere.
10. **Cloners and effectors.** Instance anything on grids, splines or surfaces, then push the instances around with fields.

### Node editor UX
11. **Live thumbnails on every node.** Each node renders its own output, so you can see the data flowing through the graph.
12. **Per-node scrubbing.** Hover a wire and scrub time to see that signal plotted as a curve.
13. **Code node.** Write WGSL inline; it compiles on keystroke and its errors appear right on the node.
14. **Subgraphs into custom nodes.** Collapse any group into a reusable node with exposed parameters.
15. **Command palette and quick-add.** Type "bloom" anywhere and the node appears already connected.

### Novel ideas
16. **AI copilot (Claude API).** Ask for something like *"make it feel like liquid chrome melting upward"* and the copilot builds or modifies the graph. It also explains graphs and suggests next nodes.
17. **Evolve mode.** Set the graph to mutate and get a grid of 9 variations. Pick favorites and breed them, like genetic art. Useful for getting past a creative block.
18. **Vibe sliders.** High-level macro knobs (calm to chaotic, organic to geometric) that map onto many parameters at once.
19. **Webcam and hand tracking input.** Your hands become fields and forces, for live VJ performance.
20. **Live mode.** Fullscreen output, MIDI and OSC control, and BPM sync. The same tool works for design and for live VJing.

### Post-processing stack
Bloom, anamorphic flares, chromatic aberration, film grain, depth of field, temporal motion blur, AgX/ACES tone mapping, LUTs, datamosh and pixel sorting.

---

## 4. Build phases

### Phase 0: Foundation (first build)
- [ ] Vite + TypeScript + WebGPU bootstrap, with a fallback message for browsers without WebGPU
- [ ] Node graph core: typed sockets, evaluation, undo/redo, save/load as JSON
- [ ] Canvas node editor: pan, zoom, wire dragging, quick-add search
- [ ] Graph-to-WGSL compiler for SDF scenes, with live recompile
- [ ] Viewport: raymarched SDF, orbit camera, bloom and tone mapping
- [ ] Signal nodes: Time, LFO, Noise, Spring, Keyframe curve
- [ ] Timeline: play, scrub, loop
- [ ] 3 demo scenes that look great out of the box

### Phase 1: Motion power
- [ ] GPU particles plus forces (curl, attractor, vortex)
- [ ] Fields and effectors, cloners
- [ ] Audio-reactive nodes
- [ ] Live per-node thumbnails
- [ ] MP4/WebM export via WebCodecs

### Phase 2: The novel ideas
- [ ] Evolve mode
- [ ] Motion brush
- [ ] Iridescence, dispersion and chrome materials
- [ ] Code node (inline WGSL)
- [ ] AI copilot

### Phase 3: Endgame
- [ ] Gaussian splat import and deformation
- [ ] Progressive path tracing
- [ ] Live/VJ mode (MIDI, OSC, webcam hands)
- [ ] Multiplayer collaboration (Yjs)
- [ ] `<fluxion-player>` web component for embedding

---

## 5. Look & feel
- Dark UI with glassy panels and a neon accent drawn from the current render's dominant color, so the UI reacts to your art.
- Animation in the UI itself: wires pulse with their signal's value and nodes spring into place.
- Keyboard-first, with every action available in the command palette.
