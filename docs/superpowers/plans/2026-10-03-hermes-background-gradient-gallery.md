# Hermes Background Gradient Gallery — Image-Locked Rework Plan

**Execution posture:** Overnight autonomous — user authorized plan, implementation, verification, and deployment without routine checkpoints.

> **For agentic workers:** Use the autonomous mandate below and execute the implementation units test-first. If isolated agent capacity is unavailable, continue inline; do not pause for a routine handoff.
>
> **Plan path:** `docs/superpowers/plans/2026-10-03-hermes-background-gradient-gallery.md`

---

## Summary

Correct the existing gallery so all 26 OpenSourceUI gradient treatments use one palette and composition derived from the user's uploaded image. The previous gallery incorrectly reused each component's native palette; this rework keeps teal, blue, violet, and magenta-violet fixed while varying only treatment geometry and texture. Deploy the corrected gallery at its current Hermes URL, changing no other served asset or service.

## Problem Frame

The gallery is intended to let the user compare the 26 OpenSourceUI background treatments against one visual reference. The first implementation followed the component pages' native colors, which produced unrelated cream, green, pink, amber, and red samples. The prior design spec explicitly made that wrong choice by saying each entry should retain its own color family. The corrected contract treats the uploaded artwork—not the source examples' color palettes—as the color and composition authority.

The screenshot is 722×334 pixels. Sampled background-only regions support the teal field, center violet bloom, lower-left magenta-violet wash, lower blue lift, and dark teal edges. The gallery must reproduce those background features without the NAVA wordmark or tagline.

## Requirements

- Show all 26 official OpenSourceUI category entries, in source order, retaining exact names and slugs.
- Use a single shared image-derived palette and underlying composition for every artwork; vary only each entry's geometry, texture, and effect placement.
- Place each component name below its artwork, outside the image-like background, to make user selection easy. Do not place text, logos, or controls over the art.
- Use three desktop columns, two tablet columns, one narrow-phone column, and normal vertical scrolling.
- Match the uploaded image's exact 722:334 aspect ratio.
- Keep the canonical page self-contained, with original HTML/CSS and no external dependencies or network requests.
- Replace only the existing gallery file served at `https://hermes.trynava.io/designs/background-gradient-gallery.html`; preserve the Outlook demo and every other served file.

## Key Technical Decisions

- **KTD-1 — Lock palette and composition; vary treatment only.** Define shared tokens from sampled image-background colors: teal edge/field (`#103935`, `#113f3f`, `#13454c`, `#145e6e`), blue/teal lift (`#1c5166`, `#35598d`, `#41699a`), indigo/violet bloom (`#6a5bb1`, `#986bcd`), and magenta-violet bloom (`#a566d1`, `#ac6ed7`). Derive translucent accents only from these colors.
- **KTD-2 — Shared substrate plus 26 CSS treatment overlays.** Preserve the broad teal field, central violet, lower-left magenta-violet, blue lower lift, and dark edge falloff in one common artwork layer. Make source-derived arcs, pools, meshes, dots, folds, streaks, and fragments separate CSS treatments. Keep the base composition recognizable.
- **KTD-3 — Label the comparison, not the artwork.** Put each exact component title in a small `figcaption` below the preview and expose the same title as the art's accessible name. Do not reproduce NAVA branding or image text.
- **KTD-4 — Replace the static artifact in place.** The route already exists and is served by the current static server/Caddy mapping. Change only the gallery leaf file; no app or service configuration is needed.

### Alternatives considered

- Reusing each source page's native palette is rejected; it caused the reported visual mismatch.
- Repeating one identical screenshot-derived gradient 26 times is rejected; it would not let the user compare treatments.
- The selected approach combines one screenshot-derived base with 26 original geometry/texture treatments.

## Global Constraints

- Show exactly the 26 catalog entries in the design spec's order. Every tile shares the sampled image palette and composition; no native source palette may be used.
- Artwork contains no text or branding. Component-name captions are the only visible text and sit below—not over—each sample.
- Use three/two/one columns at desktop/tablet/phone widths, exact `aspect-ratio: 722 / 334`, normal vertical scrolling, and no page-level horizontal overflow.
- Keep canonical HTML standalone: no JavaScript, remote fonts, external images/scripts, imports, packages, or network requests.
- Canonical source: `docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery.html`.
- Public URL: `https://hermes.trynava.io/designs/background-gradient-gallery.html`.
- Existing static root: `/home/orca/.gstack/projects/zero/designs/current-ui-showcase`. Replace only `background-gradient-gallery.html`.
- Do not edit `index.html`, `outlook-side-pane-demo.html`, `quote-rate-proof.png`, any other served file, Caddy, the static server, an application, or infrastructure.
- This is not a Zero pilot application deployment. Do not invoke app deployment/restart wrappers, database migrations, or RDS-backed tests.
- Preserve unrelated dirty worktree files. Stage only the plan, design spec, canonical HTML, and focused contract test.
- Never run Vitest or another test runner with `DATABASE_URL` pointed at `nava-zero-mail-pilot` or any production database. Never set/use `VITEST_ALLOW_PILOT_RDS=1` or source `.env.production` into tests.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** Continue through plan correction, implementation, review, deployment, and live verification without routine checkpoints.

### Communication

Keep progress updates concise. Any worker or reviewer must use a standard non-fast model and return concise findings. If isolated agent capacity is unavailable, execute inline; do not pause.

### Decision authority

Choose the smallest safe, reversible approach that meets the user's clarified intent. Do not broaden the task into the Outlook demo, product UI, apps, server configuration, or AWS. If the expected live file changes before deployment, inspect it and do not overwrite an unrelated change. If a gate fails, reproduce it, identify the mechanism, fix it, and rerun the gate.

### AWS / infra inventory — out of scope

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| **Primary deploy** | `apps/server-pilot/deploy/ops-deploy.sh` (`--migrate` when schema) |
| **Primary app bounce** | `apps/server-pilot/deploy/ops-restart.sh` |
| **Primary box reboot** | `apps/server-pilot/deploy/ops-reboot.sh` |
| Guts (fallback) | `sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh` |

This task does not change any resource in this inventory. The table is retained only to make the deployment boundary explicit.

**Allowed for this task:** read-only checks of the existing static mapping/process, local Node and Chromium verification, temporary backup of the current gallery, replacement of that one static HTML file, and read-only public HTTP/hash checks.

**Forbidden for this task:** `ops-deploy.sh`, `ops-restart.sh`, `ops-reboot.sh`, bundle sync, EC2/SSM deploys, seed/migration actions, or any AWS/EC2/RDS/S3 change; force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail credentials, tests against pilot/production RDS, `VITEST_ALLOW_PILOT_RDS=1`, or sourcing `.env.production` into tests.

### Pilot RDS safety (overrides autonomy)

Never run Vitest against `nava-zero-mail-pilot` or any production database. No overnight escape hatch exists.

Before every local or EC2 Vitest command:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

If a test requires Postgres, use a disposable non-production database. If none exists, use read-only checks where they prove the requirement; otherwise report a safety blocker. Never weaken this rule to make a gate green.

The pilot wrappers above are not applicable and must not be invoked. The only deployment action in scope is replacing the existing gallery HTML in the current Hermes static root.

### RCA loop

FAIL → reproduce minimally → identify root cause and mechanism → research unfamiliar behavior when useful → choose the smallest correct fix → test → resume. Do not skip a gate or declare completion while a failure remains.

### Verification loop

Review the updated plan/spec → run the focused Node contract test red then green → inspect the page in Chromium at desktop, tablet, and phone widths → run `git diff --check` and task-scoped reviews → confirm static mapping and baseline hashes → replace only the gallery leaf → verify public HTTP 200, exact source/live SHA-256 equality, and unchanged protected-file hashes → perform fresh final review.

### Done criteria

- [ ] Plan and design spec require one screenshot-derived palette/composition for all 26 treatments; the native-palette instruction is gone.
- [ ] All 26 official titles/order/slugs have distinct original CSS geometry/texture treatments using only the screenshot-derived artwork palette.
- [ ] Captions identify samples outside text-free artwork; no NAVA branding or tagline appears.
- [ ] Exact 722:334 ratio, responsive 3/2/1 grid, vertical scroll, and no horizontal overflow are verified.
- [ ] Focused static contract test fails against the old implementation for the expected reason and passes after the correction.
- [ ] Desktop/tablet/phone Chromium captures are inspected against the reloaded reference.
- [ ] Task-scoped and final reviews have no unresolved Critical/Important findings; `git diff --check` passes.
- [ ] Only the intended gallery file is replaced; the public route serves the reviewed source hash.
- [ ] Existing demo/index/image hashes and unrelated dirty worktree files remain unchanged.
- [ ] No abandoned experiment or unresolved blocker remains.

### True blockers

Stop only if safe access to the expected static root is unavailable, the live gallery changed to an unrelated file before replacement, required proof is unavailable due to external outage, or a safety/policy conflict prevents the narrow update. Do not stop for routine visual or implementation decisions.

## Execution Mode

Autonomous end-to-end execution as explicitly requested. Continue through the first incomplete unit without routine approval. Never stage unrelated work or push this feature to `main`.

## Implementation Units

### U1. Lock the corrected visual contract

**Goal:** Correct the stored plan/spec so the native-palette mistake cannot recur.
**Requirements:** One shared screenshot palette/composition; only treatment geometry/texture varies; component labels do not overlay artwork.
**Dependencies:** None.
**Files:** `docs/superpowers/plans/2026-10-03-hermes-background-gradient-gallery.md`; `docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery-design.md`.
**Approach:** Replace native-color direction with image-locked tokens, 722×334 sizing, geometry-only treatment descriptions, external captions, and explicit deployment non-goals. Keep the existing plan/spec paths; do not create a sibling plan.
**Test scenarios:** Confirm all 26 source treatments remain named and the docs explicitly forbid native palettes, off-reference artwork hues, branding, and changes to other served files.
**Verification:** Re-read both docs; the corrected fixed-palette contract is consistent.

### U2. Rebuild and regression-test the gallery

**Goal:** Render 26 distinct OpenSourceUI treatments over the shared reference-derived teal/violet/blue/magenta composition.
**Requirements:** Exact names/order/slugs, locked palette, captions and accessible names, exact image ratio, responsive grid, vertical flow, standalone page.
**Dependencies:** U1.
**Files:** Modify `docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery.html`; create `scripts/check-hermes-background-gradient-gallery.mjs`.
**Approach:** Keep one shared reference substrate and create 26 per-entry CSS overlays for the official geometry/texture. Use Node built-in assertions for catalog mapping, color boundary, unique treatments, captions/accessibility, proportion, responsive rules, branding exclusion, and lack of external dependencies.
**Execution note:** Add the contract test first and observe its expected failure before editing the canonical page.
**Patterns to follow:** Existing self-contained HTML; Node's built-in `assert/strict`; no package or app test harness.
**Test scenarios:**
- Happy path: all 26 exact slugs/names appear once and in order; each caption matches its accessible name and each sample has a unique effect selector.
- Palette invariant: required screenshot tokens and one shared base exist; treatment rules contain no literal off-palette colors.
- Layout: CSS specifies 3/2/1 columns, 722:334 ratio, and no fixed-height page clamp.
- Accessibility/scope: each background has a matching accessible label and visible caption; no NAVA/tagline, script, image, external stylesheet/font, import, or network URL exists.
- Browser integration: Chromium at 1440px, 800px, and 390px shows 3/2/1 columns, all captions, no horizontal overflow, vertical scroll, and no external requests.
**Verification:** Contract test passes; fresh screenshots show 26 distinguishable treatments of the supplied image palette/composition.

### U3. Publish only the corrected static gallery

**Goal:** Update the current public gallery without disturbing any other served file or service.
**Requirements:** Same URL, byte-for-byte reviewed source, HTTP 200, protected-file hashes unchanged.
**Dependencies:** U2 and task review.
**Files:** No additional tracked files; deploy only `background-gradient-gallery.html` under the existing static root.
**Approach:** Confirm the Caddy mapping and Python static-server directory. Verify the live gallery still matches the captured old hash before replacement; retain a temporary byte-for-byte rollback copy; replace only the gallery leaf. Verify public/source hashes and recheck protected files.
**Execution note:** Deploy after local visual inspection and clean task review. Do not restart services.
**Test scenarios:**
- Happy path: public route returns HTTP 200 with 26 ordered entries and SHA-256 matching the canonical source.
- Preservation: Outlook demo, index, and quote image retain their captured pre-deploy hashes.
- Failure path: if the target differs from the known old hash, stop before overwrite and investigate the changed file.
**Verification:** Live status/content/hash pass; service and all non-gallery files are unchanged.

## Verification Contract

| Gate | Evidence |
|---|---|
| Corrected artifact | `node scripts/check-hermes-background-gradient-gallery.mjs` passes after the intended RED run. |
| Responsive visual behavior | Fresh Chromium screenshots at 1440px, 800px, and 390px are inspected against the reloaded screenshot and treatment map. |
| Scope safety | `git diff --check`; the feature diff contains only the plan, design spec, canonical HTML, and focused test (plus an append-only task ledger note); pre-existing unrelated worktree changes remain untouched. |
| Deployment | Existing static mapping remains active; only the gallery is replaced; public route returns 200 and matches canonical SHA-256. |
| Preservation | Existing gallery target matched its captured old hash before replacement; Outlook demo/index/image hashes remain `eaf04bfb9b09d205deabf2efc50979308b5282356a31e2674039caa00e32da9c`, `b7384087bed648558e3328a8c2acdd847dafb30533723b9387a2c0a2720c2178`, `288d4893df4fc063e7a9878b09666ab0f2cfe1604798ada943eac02edeffa27b`. |
| Database safety | No database-backed test or pilot app deploy applies to this static page. |

## Definition of Done

- [ ] Corrected plan/spec and implementation agree.
- [ ] All 26 treatments share the screenshot palette/composition and differ by recognizable geometry/texture.
- [ ] Focused test passes and its intended failing baseline was observed.
- [ ] Chromium visual verification passes at all three widths.
- [ ] Final scoped review and whitespace check pass.
- [ ] Only the existing gallery file is replaced; live URL status and hash match canonical source.
- [ ] Protected served-file hashes and unrelated dirty worktree files remain unchanged.
- [ ] No unresolved blocker or abandoned experimental code remains.

## Sources and Evidence

- User-supplied 722×334 screenshot — visual source of truth; sampled unobstructed points confirm the shared palette.
- [Official OpenSourceUI background-gradient category](https://opensourceui.in/components/category/background-gradient) and the 26 linked detail pages — titles/order and signature geometry/texture only.
- Existing canonical HTML and live `/designs/*` static mapping — deployment pattern.
