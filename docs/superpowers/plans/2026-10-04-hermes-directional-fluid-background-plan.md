---
title: "Hermes Directional Fluid Background — Plan"
date: 2026-10-04
type: perf
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
origin:
  - "docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery-design.md"
---

# Hermes Directional Fluid Background — Plan

## Goal Capsule

Make the existing reference-derived background visibly travel across the page in both horizontal directions, with continuous, organic fluid motion rather than a whole-field wobble. Preserve the screenshot's violet and magenta-violet landmarks, nudge only the teal side regions slightly bluer, and deploy only the existing Hermes background page.

**Authority:** the user's supplied image and latest motion feedback; preserve the existing single-background-page experience.

**Execution profile:** autonomous, test-first, scoped static-page deployment. No framework migration, application deployment, or unrelated worktree cleanup.

**Done when:** the motion has a clearly observable edge-to-edge flow front plus smaller turbulent currents; the static frame still reads as the supplied image; reduced-motion, fallback, and lifecycle checks pass; and the public URL serves the verified source hash.

## Product Contract

### Summary

Replace the CPU-bound, low-resolution Canvas2D wobble with a small raw-WebGL2 shader that advects the screenshot-derived color field behind a moving horizontal flow front. Keep the page standalone and preserve its image-locked palette and composition.

### Problem Frame

The current page uses four smoothly changing values to warp the same low-resolution field. That makes the colors breathe and slosh, but no recognizable flow feature crosses the viewport. Increasing the wobble or changing frameworks would not by itself create directional travel. The implementation needs a moving flow front with turbulent variation, while keeping the uploaded artwork—not new blobs, particles, or colors—as the visual source.

### Requirements

- **R1 — Keep the reference recognizable.** Preserve the sampled 13×8 source-color map, irregular vertical sample positions, upper-middle violet, lower-left magenta-violet, and lower-middle blue landmarks. At animation time zero, retain the reference composition; during motion, bound displacement so the broad purple/blue/teal regions stay recognizable.
- **R2 — Refine only teal edges.** Add a restrained blue bias to the green-teal side regions; do not shift the purple or blue anchors or introduce colors outside the sampled palette's local range.
- **R3 — Make direction unmistakable.** One soft front must carry a recognizable color boundary fully across the viewport, left-to-right and then right-to-left. Smaller seeded curl-flow scales bend and locally advect that same front so it feels fluid and space-like, not like a brightness stripe or independent radial blobs. Keep motion continuous between passes, with per-visit variation and no abrupt 500 ms parameter jumps.
- **R4 — Use the smallest suitable renderer.** Use a raw WebGL2 full-screen shader and the existing inline image-derived data. Add no rendering framework, package, remote asset, font, or network request.
- **R5 — Preserve access and lifecycle behavior.** Keep the artwork accessible by name; honor reduced-motion as a still reference frame; pause the animation clock while the page is hidden; resize without overflow; and provide a static reference-colored fallback when WebGL2 is unavailable or its context is lost.
- **R6 — Keep the change narrow.** Change only the canonical background page, its focused contract checker, this plan, and the deployed background page. Do not edit the Outlook demo, gallery index, image assets, apps, server mapping, or infrastructure.
- **R7 — Prove the published result.** Verify motion and anchors in Chromium at desktop, tablet, reference-image, and phone sizes; verify the live route and hash; and confirm protected served files remain unchanged.

### Scope Boundaries

#### In scope

- The standalone page at `https://hermes.trynava.io/designs/background-gradient-gallery.html`.
- GPU rendering and explicit two-way horizontal flow, with limited image-derived color grading.
- Local visual comparison of a few shader motion drafts to select the clearest flow without adding visible controls to the page.
- Focused static and browser verification, followed by replacement of that one deployed HTML file.

#### Out of scope

- Rebuilding the larger site, adding a component gallery or visible draft selector, changing the Outlook side-pane demo, or editing any other served file.
- Introducing Three.js, PixiJS, WebGPU, a bundler, app framework, server route, or third-party runtime asset.
- Full Navier–Stokes fluid simulation, particle/star effects, new branding/text, or a new color palette.
- Committing, staging, or pushing the existing worktree's unrelated changes.

## Planning Contract

### Assumptions

- “Across the page” means a visible flow front crosses the full width in each direction, while the large-scale image composition remains recognizable over time.
- Prototype variants are for local evaluation only; the public page remains a single full-viewport artwork with no UI.
- On portrait viewports, map the full image-derived field edge-to-edge instead of using `cover` cropping; cropping would discard the approved side teals and lower-left violet. Verify that deliberate full-bleed treatment at phone size.
- A brief, small blue bias at teal edges is welcome, but the existing purple regions are already approved and should remain color-locked.
- If a GPU/browser cannot render WebGL2, a still image-derived fallback is preferable to a blank page or a new runtime dependency.

### Key Technical Decisions

- **KTD1 — Raw WebGL2, not a new framework.** The hot path computes one color sample per output pixel; the existing JavaScript Canvas2D loop is capped at 416px/24fps and has measured high per-pixel cost. WebGL2 is broadly available and moves this work to the GPU. A scene graph adds no useful capability for one full-screen field. WebGPU remains too unevenly supported for this public static page.
- **KTD2 — Treat the screenshot map as the color authority.** Upload the sampled field as an RGBA, linear-filtered texture; map normalized screen Y piecewise through the existing nonuniform row positions, with texel-center sampling. Apply a small teal-aware blue bias only near the left/right edges. Test texture orientation and time-zero anchors in a real browser.
- **KTD3 — Separate travel from turbulence.** Move one broad front explicitly across the X axis, then reverse it smoothly. Use seeded curl noise to bend that same front and carry the sampled color boundary with it. A seeded 2.72-second cycle computes its outbound and return legs in O(1), regardless of uptime; the direction-sensitive curl term is proportional to signed eased speed and reaches zero at each offscreen turnaround. Do not add a second competing front or rely on random oscillators to imply travel.
- **KTD4 — Preserve graceful behavior without adding a dependency.** Render WebGL2 on the primary canvas and use a separate small 2D canvas only for a static image-derived fallback. On context loss, prevent the default loss behavior, stop animation, and expose the fallback; on restoration, recreate shader/program/buffer/texture state before hiding fallback and resuming. Resize at device-pixel ratio at most 1.5 and no more than 163,840 framebuffer pixels, and leave the time-zero field frozen for reduced-motion users. The conservative pixel budget was selected after high-resolution SwiftShader rendering fell to 6–20 fps; the optimized field at the fixed cap measured a 16.7 ms median in final browser runs. Expose the artwork once through the stage label and mark both canvases decorative to assistive technology.
- **KTD5 — Deploy one static artifact.** The source already maps directly to the Hermes static root. Before replacing the deployed leaf, require its SHA-256 to equal `ccb8c7c5154063a67428f8c69b4b922eaa0122d6af6e439bffeaacbf58f38d69`; no service restart or application/AWS deploy is part of this task.

### Alternatives Considered

- **Keep Canvas2D and raise the cap/frame rate:** rejected because per-pixel JavaScript is the existing bottleneck; this raises CPU and battery costs without making motion directional.
- **Use Three.js/PixiJS:** rejected because the page needs one shader pass, not a scene graph, and a library does not make the flow itself more convincing.
- **Use WebGPU:** rejected because its current browser/OS availability is still less consistent than WebGL2 for a public page.
- **Use more moving radial gradients:** rejected because the page should keep the supplied field as its substrate; new blobs would alter rather than animate the approved composition.

### High-Level Technical Design

```text
13×8 reference samples ──> small linear WebGL texture ──┐
                                                         ├─> sample image field ─> subtle teal-edge grade ─> canvas
continuous travel path ──> moving horizontal front ─────┤
seeded multiscale curl ──> front meander / local advection┘
```

The initial shader frame samples the unwarped image map. On later frames, one soft front carries a bounded displacement and a recognizable image-color boundary from one edge to the other, then reverses smoothly. A small number of seeded curl-noise scales bend its path and vary the local advection without adding discrete shapes. The animation clock advances only while visible and only when reduced motion is not requested.

### Sources & References

- Existing image-locked source contract: `docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery-design.md`.
- Existing page and focused checker: `docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery.html`; `scripts/check-hermes-background-gradient-gallery.mjs`.
- MDN, [WebGL2RenderingContext](https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext) — WebGL2 browser availability and API surface.
- MDN, [WebGL API](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API) — GPU-accelerated browser graphics.
- MDN, [WebGPU API](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API) — current limited availability.
- MDN, [HTMLCanvasElement.getContext](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/getContext) and [webglcontextlost](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/webglcontextlost_event) — context selection and recovery behavior.
- Perlin and Neyret, [Flow Noise](http://www-evasion.inrialpes.fr/Publications/2001/PN01/sketch_col.pdf) — pseudo-advection for moving layered detail rather than stationary swirling.
- Bridson et al., [Curl-Noise for Procedural Fluid Flow](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph2007-curlnoise.pdf) — controllable, multiscale procedural turbulent velocity fields.

## Implementation Units

### U1 — Lock the directional-flow contract and implement the shader

**Requirements:** R1–R5.
**Dependencies:** none.
**Files:** `docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery.html`; `scripts/check-hermes-background-gradient-gallery.mjs`.

**Approach:** Update the focused checker first and observe its expected red result against the current Canvas2D implementation. Replace renderer-specific assertions with contracts for the unchanged image grid/anchors, WebGL2 shader path, one explicit bidirectional traveling front, edge-only blue bias, standalone delivery, reduced motion, visibility pausing, resize, and static fallback. Implement the WebGL2 texture/shader and fallback in the existing HTML. In local Chromium, compare three temporary versions of that same front (smooth shear, curl-bent, and stronger curl-bent); keep the version with the clearest carried color boundary and least landmark drift, then remove the draft switch before deployment.

**Test scenarios:**

- The updated checker fails before implementation specifically because no WebGL2 or traveling-flow contract exists, then passes after implementation.
- Shader compiles in Chromium WebGL2; the still frame retains the upper-left/upper-middle/lower-left/lower-middle/lower-right anchors and the 13×8 source data. Piecewise Y mapping preserves the irregular source rows, RGBA upload preserves row alignment, and only the teal-edge output gets a blue bias.
- Seeded travel state moves one front from left edge to right edge and back without positional jumps; consecutive time samples change smoothly, and separate visit seeds vary secondary turbulence.
- At least one animated pass visibly carries the same image-color boundary across most of the viewport in both directions; screenshots show continuous fluid flow rather than a moving brightness band or stationary color pools.
- Reduced-motion mode is pixel-stable; changing the media preference freezes/resumes as expected; hiding the page does not advance the logical clock.
- Resizing at 1440×900, 800×900, 722×333, and 390×844 preserves full coverage, the palette map, and zero document overflow.
- Simulated WebGL2 unavailability and context loss show a nonblank static reference fallback; context loss is made restorable, context restoration recreates GPU resources, and only the labeled stage is exposed accessibly.
- The page requests no remote assets and contains no visible branding or controls.

### U2 — Measure, review, and deploy only the background page

**Requirements:** R3–R7.
**Dependencies:** U1.
**Files:** `docs/superpowers/plans/2026-10-04-hermes-directional-fluid-background-plan.md`; deployed `/home/orca/.gstack/projects/zero/designs/current-ui-showcase/background-gradient-gallery.html`.

**Approach:** Review the final field beside the supplied image at the reference aspect ratio and actual wide/narrow browser viewports. Use a fixed framebuffer cap (device-pixel ratio at most 1.5 and at most 163,840 pixels) and inspect Chromium animation-frame cadence on desktop and phone. Final headless Chromium 147 / SwiftShader runs measured 16.7 ms median and 16.8 ms p95 at both 1440×900 / DPR 2 (512×320 buffer) and 390×844 / DPR 3 (163,625-pixel buffer). These software-renderer results are a conservative browser check, not a claim about native-GPU hardware performance. Record SHA-256 hashes for the expected current page and protected `index.html`, Outlook demo, and proof image. If and only if the target page still matches the expected baseline, atomically replace that one file; do not restart services, stage, or push.

**Test scenarios:**

- `node scripts/check-hermes-background-gradient-gallery.mjs` and `git diff --check` pass.
- Browser captures at desktop, tablet, original-reference, and phone dimensions show the correct palette, full-width travel in both directions, no blank frames, and no overflow; reduced-motion remains static.
- Desktop and phone animation-frame cadence remains smooth at the fixed framebuffer cap (observed p95 16.8 ms for both profiles in Chromium 147 / SwiftShader); no adaptive profiling or render-scale control is added unless measurement exposes a real failure.
- The bounded travel function returns finite state after one simulated day of uptime, and actual framebuffer comparisons immediately before/after both turnarounds remain visually continuous.
- The live route returns HTTP 200, its SHA-256 matches the reviewed source, and the protected served-file hashes match their pre-deploy values.
- Final scoped review finds no unrelated worktree changes staged or deployed.

## Verification Contract

- Run the focused checker before and after implementation; preserve the red/green result.
- Compile and render the actual inline shaders in headless Chromium with WebGL2 enabled; treat any shader log, page error, unexpected network request, overflow, or fallback blank as a failure.
- Inspect actual screenshots at `1440×900`, `800×900`, `722×333`, and `390×844`. Compare both the static reference frame and several moments spanning a full left-right-left travel; code inspection alone does not prove the direction reads visually.
- Exercise reduced-motion, resize, hidden-tab, WebGL2 unavailable, context loss, and context restore in browser tests.
- Measure browser animation-frame cadence locally with a fixed framebuffer cap; report the observed median and p95 with the browser/software-renderer caveat, and do not claim “10×” based on framework choice or nominal refresh rate alone.
- Before deployment, verify that only the intended source page changed relative to its expected prior hash. After deployment, check HTTP 200, source/live SHA equality, and unchanged hashes for `index.html`, `outlook-side-pane-demo.html`, and `quote-rate-proof.png`.
- Run `git diff --check`; inspect final status and scoped diffs. Do not stage or commit the unrelated dirty worktree.

## Execution Record

- Focused contract checker: 7/7 passed. `git diff --check` passed.
- Local Chromium 147 / SwiftShader: WebGL2 compiled at desktop, tablet, source-image, and phone sizes; reduced motion, no-WebGL fallback, context loss/restore, visibility pause, and resize passed. A normal 700 ms pass changed 57.7% of pixels at the `delta ≥ 6` threshold; reverse travel changed 42.1%. Actual framebuffer differences across both endpoint reversals had 0 changed pixels and mean channel deltas below 0.001.
- RAF cadence at the fixed pixel cap: 1440×900 / DPR 2 and 390×844 / DPR 3 each measured 16.7 ms median and 16.8 ms p95 in headless SwiftShader. These are software-renderer measurements, not a native-GPU benchmark.
- Live Chromium verification: the public route returned HTTP 200, rendered WebGL2 and changed actual screenshots at 722×333 and 390×844, with no overflow, browser errors, or third-party asset requests. `readPixels` is not used for the public check because the production context correctly sets `preserveDrawingBuffer: false`; screenshot and RAF evidence confirmed live movement.
- Deployed page and source SHA-256: `67074d838afff1e760e18ea13dd78ce8d56a110e0851614c49665e4889967eed`.
- Protected deployed hashes remained unchanged: `index.html` `b7384087bed648558e3328a8c2acdd847dafb30533723b9387a2c0a2720c2178`; Outlook demo `eaf04bfb9b09d205deabf2efc50979308b5282356a31e2674039caa00e32da9c`; proof image `288d4893df4fc063e7a9878b09666ab0f2cfe1604798ada943eac02edeffa27b`.

## Definition of Done

- [x] The image-derived field remains recognizable, with the approved purple anchors preserved and only a restrained blue shift at teal edges.
- [x] A visible, smoothly varying flow front crosses the full viewport both directions; the field no longer merely wobbles in place.
- [x] Raw WebGL2 is used without a framework/dependency; one static fallback handles unsupported/lost contexts.
- [x] Reduced-motion, visibility pause, resize, accessibility, and no-network behavior pass in Chromium.
- [x] Focused static and browser checks pass; screenshots and p95 measurements are inspected.
- [x] Only the Hermes background page is replaced; the public URL serves the reviewed source hash and protected files retain their hashes.
- [x] Existing unrelated worktree changes remain unstaged, uncommitted, and untouched.
