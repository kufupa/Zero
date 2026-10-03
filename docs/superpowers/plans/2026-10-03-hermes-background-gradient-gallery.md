# Hermes Background Gradient Gallery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution posture:** User explicitly authorized end-to-end autonomous implementation and deployment. Do not pause for routine approval.

**Goal:** Publish a text-free, responsive page showing all 26 OpenSourceUI background-gradient styles, inspired by the uploaded NAVA gradient artwork, at `https://hermes.trynava.io/designs/background-gradient-gallery.html`.

**Architecture:** One self-contained HTML/CSS artifact is the canonical source. It is deployed as a new file into Hermes' existing static `/designs/` root; the existing Caddy mapping and Python static server already serve that directory, so no server or app configuration changes are needed.

**Tech Stack:** HTML5, CSS gradients and media queries; Node.js built-in assertions for static contract checks; `curl` and SHA-256 for live verification. No runtime JavaScript or external dependencies.

## Global Constraints

- Show exactly the 26 catalog entries, in the order and with the CSS visual mechanics in `docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery-design.md`.
- No visible text, labels, logo, brand, controls, or copy on the page; swatches get their exact component names through `role="img"` and `aria-label` only.
- Desktop/tablet/phone layouts are 3/2/1 columns. Each sample uses `aspect-ratio: 722 / 335`; the page scrolls vertically and never uses a page-level horizontal scroller.
- Keep the deliverable self-contained: no scripts, remote fonts, external assets, imports, packages, build steps, or network requests.
- Canonical source: `docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery.html`.
- Live path: `/home/orca/.gstack/projects/zero/designs/current-ui-showcase/background-gradient-gallery.html`; public URL: `https://hermes.trynava.io/designs/background-gradient-gallery.html`.
- Deployment may create only that new leaf file in the Hermes static root. Do not edit or replace `index.html`, `outlook-side-pane-demo.html`, `quote-rate-proof.png`, any other existing served file, Caddy configuration, or any application/service configuration. Do not restart services.
- This is not a Zero pilot application deployment: do not invoke `ops-deploy.sh`, `ops-restart.sh`, EC2 deployment wrappers, database migrations, or RDS-backed tests.
- Preserve the user's existing dirty worktree files. Stage only paths named in the current task.
- Never run Vitest or another test runner with `DATABASE_URL` pointing at `nava-zero-mail-pilot` or any production database. Never set or use `VITEST_ALLOW_PILOT_RDS=1`; never source `.env.production` into a test process. Database-required tests use a disposable non-production database only.

---

## Autonomous Execution Mandate

**User granted full autonomy.** Continue through implementation, review, deployment, and verification without routine checkpoints.

### Decision authority

- Choose the safest reversible option that satisfies this plan; preserve all listed requirements.
- This route is served by an existing static directory. The requested production action is limited to adding the single new HTML file at the path above.
- Do not broaden scope into the existing demo, app, infrastructure, or shared assets. If the intended target becomes occupied before deployment, do not overwrite it; investigate and use a different new `/designs/` filename only if the same requested result remains clear, then record the chosen URL.
- Use standard, non-fast subagents for implementation and reviews. Every orchestrator and subagent response uses `/caveman ultra`; technical terms remain exact.

### RCA loop

FAIL → reproduce minimally → identify the root cause and mechanism → research unfamiliar behavior when useful → choose the smallest correct fix → test → resume. Do not skip a gate or declare completion while a failure remains.

### Safety

- Follow repository rules and the Zero pilot RDS safety rule in Global Constraints.
- Never force-push protected branches, bypass hooks, run destructive git commands, expose secrets, or weaken safety guards.
- The working tree contains pre-existing user changes. Do not stage, edit, discard, or include them in commits or review packages.
- Before publishing, verify the exact target is absent and the three existing-file hashes below still match. Publish from the reviewed canonical file, then verify the live response and byte hash.
- Do not edit the Caddyfile, restart the static server, or touch production application/AWS/RDS resources for this static file addition.

### Verification loop

Implement → run the focused Node contract test red then green → run `git diff --check` → task review → deploy only the new HTML file → verify live HTTP 200, page contract, and SHA-256 equality → verify protected existing-file hashes are unchanged → run final feature-range review.

### Done criteria

- [x] Canonical HTML contains the exact 26 unique `data-gradient` slugs, in catalog order, with 26 corresponding accessible names.
- [x] No visible text/branding or external asset, script, font, or network dependency is present.
- [x] Responsive 3/2/1-column layouts and 722:335 swatch ratio are verified; document remains vertically scrollable.
- [x] The source passes the Node contract test and `git diff --check`; task review found no unresolved Critical or Important issue.
- [x] Final whole-change review finds no unresolved Critical or Important issue.
- [x] The new URL returns HTTP 200 and its bytes hash exactly matches the reviewed canonical file.
- [x] Existing served files retain these pre-deployment SHA-256 values: demo `eaf04bfb9b09d205deabf2efc50979308b5282356a31e2674039caa00e32da9c`, index `b7384087bed648558e3328a8c2acdd847dafb30533723b9387a2c0a2720c2178`, and image `288d4893df4fc063e7a9878b09666ab0f2cfe1604798ada943eac02edeffa27b`.
- [x] No unrelated working-tree file is modified, staged, or committed by this feature.
- [x] No unresolved blocker affects the requested live page.

### True blockers

Stop only if safe access to the intended static root is unavailable, an occupied target cannot be safely avoided, required verification cannot be obtained due to an external outage, or a safety-policy conflict prevents the limited static deployment. Do not pause for routine design, implementation, or verification choices.

## Execution Mode

Autonomous. Use `subagent-driven-development`, TDD, fresh task-scoped review, and final whole-change review. After the task reviewer approves the local artifact, the orchestrator performs the narrow static-file deployment gate below and continues through live verification without asking which option to choose.

## Files and Task Decomposition

### Task 1: Build and verify the standalone gradient gallery

**Files:**

- Create: `docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery.html`
- Reference design: `docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery-design.md`

**Interfaces:**

- Consumes: the 26-entry ordered design mapping in the referenced design spec and the uploaded artwork's wide, atmospheric gradient composition.
- Produces: a zero-dependency HTML page with one accessible swatch per catalog entry, ready to copy unchanged to the Hermes static root.

- [x] **Step 1: Run the static contract test before implementation (RED).**

Run from the repository root:

```bash
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const file = 'docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery.html';
const html = existsSync(file) ? readFileSync(file, 'utf8') : '';
const expected = [
  'arc-bands-background', 'aurora-background', 'cherry-petal-background',
  'coral-glow-background', 'dark-arc-bands-background', 'dark-aurora-background',
  'dark-carbon-spotlight-background', 'dark-ember-background', 'dark-ink-field-background',
  'dark-midnight-mesh-background', 'dark-rose-noir-background', 'dark-teal-depth-background',
  'frost-mesh-background', 'halftone-pop-background', 'honey-ember-background',
  'ink-wash-background', 'linen-weave-background', 'mint-lagoon-background',
  'paper-fold-background', 'rain-prism-background', 'sand-drift-background',
  'soft-spotlight-background', 'sunrise-horizon-background', 'sunset-bloom-background',
  'terrazzo-fragment-background', 'tropical-tide-background',
];
const expectedLabels = [
  'Arc Bands', 'Aurora Background', 'Cherry Petal', 'Coral Glow', 'Dark Arc Bands',
  'Dark Aurora', 'Dark Carbon Spotlight', 'Dark Ember', 'Dark Ink Field', 'Dark Midnight Mesh',
  'Dark Rose Noir', 'Dark Teal Depth', 'Frost Mesh', 'Halftone Pop', 'Honey Ember',
  'Ink Wash', 'Linen Weave', 'Mint Lagoon', 'Paper Fold', 'Rain Prism', 'Sand Drift',
  'Soft Spotlight', 'Sunrise Horizon', 'Sunset Bloom', 'Terrazzo Fragment', 'Tropical Tide',
];
const actual = [...html.matchAll(/data-gradient="([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(actual, expected, 'all 26 catalog slugs must appear once and in order');
const labels = [...html.matchAll(/role="img" aria-label="([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(labels, expectedLabels, 'every swatch must expose its exact component title');
assert.equal(new Set(actual).size, 26, 'gradient slugs must be unique');

const css = html.match(/<style>([\s\S]*?)<\/style>/i)?.[1] ?? '';
assert.match(css, /aspect-ratio:\s*722\s*\/\s*335/i, 'swatches must match the reference proportion');
assert.match(css, /\.gallery\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/i, 'desktop must show three columns');
assert.match(css, /@media\s*\(max-width:\s*920px\)[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/i, 'tablet must show two columns');
assert.match(css, /@media\s*\(max-width:\s*620px\)[\s\S]*?grid-template-columns:\s*1fr/i, 'phone must show one column');
assert.doesNotMatch(css, /overflow-y:\s*hidden/i, 'page must remain vertically scrollable');

const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? '';
assert.ok(body, 'document must have a body');
assert.doesNotMatch(body, />[^<]*[^\s<][^<]*</, 'gallery must have no visible text nodes');
assert.doesNotMatch(html, /NAVA|Autonomous Agents for Big Insurance|<script\b|<img\b|<link\b|@import|https?:\/\//i, 'page must omit branding and external dependencies');
console.log('PASS: 26 accessible, ordered swatches; text-free; responsive; self-contained.');
NODE
```

Expected before implementation: non-zero exit at the 26-slug assertion (`actual` is empty). Do not weaken the assertion to make the red run pass.

- [x] **Step 2: Implement the page.** Create only the canonical HTML file. Use a semantic `<main class="gallery">` containing 26 empty, accessible image-role elements in the exact source order. Give each element `data-gradient` equal to the source detail slug and `aria-label` equal to the source component title. Keep the CSS in one `<style>` element in this file.

  Use the design spec's component-by-component palette and geometry: layered native `radial-gradient`, `linear-gradient`, `repeating-linear-gradient`, and `conic-gradient` where appropriate; use pseudo-elements only for shape/textures, never copy source markup/styles verbatim. Give the overall page the quiet deep-teal surround and soft blended atmosphere of the reference. Set the swatches to `aspect-ratio: 722 / 335`; define the 3-column `.gallery` default; at `max-width: 920px` use 2 columns; at `max-width: 620px` use 1. Keep the document in normal vertical flow and avoid any visible text or external dependency.

- [x] **Step 3: Run the same static contract test (GREEN).** Re-run the exact Step 1 command; expected output is `PASS: 26 accessible, ordered swatches; text-free; responsive; self-contained.`

- [x] **Step 4: Check the focused diff and commit only this artifact.** Run:

```bash
git add docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery.html
git diff --cached --check -- docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery.html
git diff --cached --stat -- docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery.html
git commit -m "feat: add Hermes background gradient gallery"
```

Confirm the staged and committed path list contains only the canonical HTML file. Preserve all pre-existing dirty files.

## Controller-owned Hermes deployment gate

Run only after Task 1's task-scoped reviewer approves the source. No service restart or repository push is needed.

1. Confirm the process still serves `/home/orca/.gstack/projects/zero/designs/current-ui-showcase` on port `9898`, Caddy still maps `/designs/*` to that server, the new target is absent, and the three existing-file hashes in Done criteria still match.
2. Copy the reviewed canonical file to the exact new target path with mode `0644`; create no other persistent served file. Recheck the source/target SHA-256 equality before serving verification.
3. Fetch `https://hermes.trynava.io/designs/background-gradient-gallery.html`; require HTTP 200, 26 `data-gradient` values in the same order, and a response SHA-256 equal to the canonical source.
4. Re-hash `outlook-side-pane-demo.html`, `index.html`, and `quote-rate-proof.png`; each must match its baseline. If any differ, investigate without overwriting or restoring existing files.
5. Capture commands and outputs in the task report/SDD ledger; then run final feature-range review.

## Completion Record

- Task reviewer approved the canonical source at `034e8d1e`; no Critical, Important, or Minor findings.
- Chromium verified the local page at 1440, 800, and 390 pixel viewport widths: 3/2/1 columns, 26 backgrounds, no visible text or horizontal overflow, vertical scrolling, and no network requests.
- Deployed route: `https://hermes.trynava.io/designs/background-gradient-gallery.html` returned HTTP 200 with 26 ordered swatches. Served bytes match the canonical source SHA-256 `391afef529d2281de52b45a47d0d11b95188e359fa8fdf2ad52586e117dd0637`.
- Existing live demo, index, and image hashes match the pre-deployment values above. No Caddy or service changes were made.
- Independent final feature review approved with no Critical, Important, or Minor findings.
