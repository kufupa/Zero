---
title: "fix: remove the workflow navigation rollout flag"
date: 2026-09-02
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: user-request
plan_depth: standard
execution: code
---

# Workflow Navigation Flag Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development and superpowers:test-driven-development to implement this plan task-by-task. Keep the task ledger outside the product diff and review every task before continuing.

**Goal:** Make the completed Centurion workflow-folder navigation unconditional and remove the temporary `VITE_WORKFLOW_NAV_V6`/`WORKFLOW_NAV_V6` rollout flag from active code, server configuration, and deployment wiring.

**Architecture:** The mail UI will use the workflow taxonomy as its only navigation presentation for both demo and live category paths. Route normalization will remain mode-free and will preserve readable legacy slugs where they do not collide; the deliberate `bookings` collision is reclassified to the new canonical workflow route. The durable server `WORKFLOW_TRIAGE_V6` capability remains independent; only the nav rollout control is deleted.

**Tech Stack:** TypeScript, React Router, Vite, Vitest, Node `env.ts` parsing, Bash EC2 deployment scripts, pnpm workspace builds.

## Global Constraints

- The Centurion backfill is complete (`2822/2822` eligible coverage); do not add another backfill or migration.
- Active production code and deploy scripts must contain no `VITE_WORKFLOW_NAV_V6`, `WORKFLOW_NAV_V6`, `WorkflowNavEnv`, or `isWorkflowNavV6Enabled` references.
- `WORKFLOW_TRIAGE_V6` remains a separate server capability and must keep its current parsing and behavior.
- Keep spam out of the Folders section; Urgent remains the overlay folder and the eleven workflow primary folders remain visible.
- Rollback is a code rollback or redeploy of the previous commit, never an environment toggle.
- Dashboard/evidence UI, draft AI, tool invocation, and HMS activation remain out of scope.
- Never run Vitest with `DATABASE_URL` set to pilot/production or with `VITEST_ALLOW_PILOT_RDS`; unset both before every Vitest command. DB-backed tests require a disposable database.
- Delegated work uses `gpt-5.6-luna` with `max` reasoning when that standard model is available; otherwise work inline and record the limitation.
- Preserve unrelated dirty files in the primary checkout; only plan-owned paths may be staged or landed.

## Requirements Traceability

| ID | Requirement | Proof |
| --- | --- | --- |
| R1 | Workflow navigation is always on after the completed backfill. | Demo/live navigation tests show workflow primary IDs plus Urgent by default. |
| R2 | Legacy folder slugs remain readable without a mode flag; the colliding `bookings` slug intentionally becomes the workflow route. | Table-driven normalization and demo-list tests cover the canonical/legacy alias contract. |
| R3 | The nav rollout flag is removed completely from active frontend, server, and deploy code. | Removal contract test scans the production source/deploy inputs; helper and parser field are deleted. |
| R4 | Durable triage, AI, and HMS gates remain unchanged. | Server env tests retain `WORKFLOW_TRIAGE_V6`; diff review and live PM2 checks cover AI/HMS invariants. |
| R5 | The deployed SPA has no build-time flag dependency and serves the workflow folders. | Mail build plus live fresh HTML/asset inspection and authenticated UI spot-check. |

## Evidence and Existing Patterns

- `apps/mail/config/navigation.ts` currently carries the frontend gate and defaults three builders to it; the workflow definitions and managed-folder presentation already contain the desired final taxonomy.
- `apps/mail/lib/demo/folder-map.ts` has separate legacy/workflow maps; workflow-first lookup preserves non-colliding legacy URLs without a second rollout mode, while `bookings` intentionally resolves to the new workflow definition.
- `apps/mail/hooks/use-threads.ts` is the only runtime consumer that passes the frontend flag into route normalization.
- `apps/server-pilot/src/env.ts` parses `WORKFLOW_NAV_V6`, but the server has no consumer outside env parsing; `WORKFLOW_TRIAGE_V6` is consumed by the AI worker and must remain.
- `apps/server-pilot/deploy/deploy-ec2.sh` currently injects the Vite flag before `@zero/mail` build; `write-ec2-env.sh` currently persists the server key. Both injections are the regression source and are removed.
- `docs/solutions/ui-bugs/hotel-folder-ui-parity.md` establishes presentation-layer precedence for managed slugs; `docs/solutions/logic-errors/centurion-triage-audit-createdat-vs-finishedat-spam-at.md` establishes the completed backfill and independent spam/nav contract; EC2 deploy learnings require quiesced asset sync, health checks, VPN proof, and no pilot-RDS Vitest.
- Historical plans and handoff reports may retain the old flag as incident history. They are not build inputs; do not rewrite history merely to make repository-wide text search empty.

## File Map

| Responsibility | Files |
| --- | --- |
| Unconditional frontend navigation | `apps/mail/config/navigation.ts`, `apps/mail/components/ui/app-sidebar.tsx`, `apps/mail/hooks/use-threads.ts`, `apps/mail/lib/demo/folder-map.ts` |
| Frontend regression coverage | `apps/mail/tests/hotel-folder-presentation.test.ts`, `apps/mail/tests/workflow-demo-routing.test.ts`, `apps/mail/tests/use-threads-content-query-ownership.test.ts`, `apps/mail/tests/e2e/real-mail-launch-readonly.spec.ts` |
| Server flag removal | `apps/server-pilot/src/env.ts`, `apps/server-pilot/tests/env.test.ts` |
| Deployment flag removal/contract | `apps/server-pilot/deploy/deploy-ec2.sh`, `apps/server-pilot/deploy/write-ec2-env.sh`, delete `apps/server-pilot/deploy/workflow-nav-v6.sh`, delete `apps/server-pilot/tests/deploy-workflow-nav-v6.test.ts`, create `apps/server-pilot/tests/workflow-nav-removal.test.ts` |
| Durable plan/review evidence | `docs/superpowers/plans/2026-09-02-workflow-nav-flag-removal.md`, one CE solution produced by Task 4 under `docs/solutions/` |

---

### Task 1: Make workflow navigation and demo routing unconditional

**Files:**

- Modify: `apps/mail/config/navigation.ts`
- Modify: `apps/mail/components/ui/app-sidebar.tsx`
- Modify: `apps/mail/hooks/use-threads.ts`
- Modify: `apps/mail/lib/demo/folder-map.ts`
- Modify: `apps/mail/tests/hotel-folder-presentation.test.ts`
- Modify: `apps/mail/tests/workflow-demo-routing.test.ts`
- Modify: `apps/mail/tests/use-threads-content-query-ownership.test.ts`
- Modify: `apps/mail/tests/e2e/real-mail-launch-readonly.spec.ts`

**Interfaces:**

- `buildLiveCategoryNavItems(categories: LiveCategoryNavInput[]): NavItem[]` always filters to `HOTEL_WORKFLOW_PRIMARY_SLUGS` plus `urgent`, hides `spam`, and uses the fixed `urgent`-first `HOTEL_WORKFLOW_PRIMARY_SLUGS` sequence; API `sortOrder` is not a second customer-facing order.
- `injectLiveCategoryNavSection(sections: NavSection[], categories: LiveCategoryNavInput[]): NavSection[]` delegates to the unconditional live builder.
- `buildDemoMailFolderNavItems(): NavItem[]` always maps `WORKFLOW_MAIL_FOLDER_DEFINITIONS` and excludes `spam`.
- `getDemoMailFolderDefinition(slug: string): DemoMailFolderDefinition | undefined` and `normalizeDemoMailFolderSlug(folder?: string): string` no longer accept a boolean mode; workflow definitions win, so `/mail/bookings` deliberately resolves to `bookings`, while `/mail/new-bookings`, `new-booking`, `at_risk`, `risk`, `groups`, `events`, `mice`, `operations`, and `handover` remain readable through the legacy map. These aliases are demo-only; live routes use exact category slugs through `resolveMailRouteFilter`.

- [ ] **Step 1: Rewrite the navigation tests to express the final contract.**

  Remove the flag parser test and boolean arguments. Make the default demo builder assertion expect `urgent` followed by the eleven workflow IDs (`bookings`, `groups-events`, `manage-stay`, `confirm-reconcile`, `money-billing`, `documents-delivery`, `exceptions-recovery`, `guest-experience`, `internal-partner`, `automated-channel`, `unknown-review`) and no `spam`; assert Urgent carries its red-stripe theme. Make the live builder test use shuffled/contradictory `sortOrder` values and expect the exact same canonical order, with Urgent first and the Urgent stripe preserved. Add an `injectLiveCategoryNavSection(navigationConfig.mail.sections, fixtureCategories)` contract asserting `Core -> Folders -> Management`, Core IDs `inbox/drafts/sent`, Management IDs `archive/snoozed/trash/spam`, and no Spam in Folders; do not expect the static `navigationConfig.mail.sections` to contain a live Folders section before injection. Replace the custom-category display case with an exclusion assertion. Rewrite `workflow-demo-routing.test.ts` as the single table-driven alias contract: `bookings -> bookings`, `new-bookings -> new-bookings`, `new-booking -> new-bookings`, `at_risk/risk -> at-risk`, `groups/events/mice -> groups-events`, and `operations/handover -> ops`; assert both `getDemoMailFolderDefinition(alias)?.id` and `normalizeDemoMailFolderSlug(alias)` plus the corresponding demo list calls use the intended canonical folder semantics. Remove duplicate alias assertions from `demo-folder-map.test.ts` while retaining its non-alias folder-map coverage. Update the nearby folder-map comment so it no longer says the sidebar waits for a nav flag flip.

  The core assertions should remain explicit rather than snapshot-only:

  ```typescript
  const expectedWorkflowIds = [
    'urgent', 'bookings', 'groups-events', 'manage-stay', 'confirm-reconcile',
    'money-billing', 'documents-delivery', 'exceptions-recovery',
    'guest-experience', 'internal-partner', 'automated-channel', 'unknown-review',
  ];
  expect(buildDemoMailFolderNavItems().map((item) => item.id)).toEqual(expectedWorkflowIds);
  const shuffledCategories = expectedWorkflowIds.map((slug, index) => ({
    slug,
    name: slug,
    sortOrder: expectedWorkflowIds.length - index,
  }));
  expect(buildLiveCategoryNavItems(shuffledCategories).map((item) => item.id))
    .toEqual(expectedWorkflowIds);
  expect(normalizeDemoMailFolderSlug(' bookings ')).toBe('bookings');
  expect(normalizeDemoMailFolderSlug('new-booking')).toBe('new-bookings');
  ```

- [ ] **Step 2: Run the focused mail tests to verify RED.**

  Run from `apps/mail` with `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`:

  ```bash
  unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
  pnpm exec vitest run tests/hotel-folder-presentation.test.ts tests/workflow-demo-routing.test.ts tests/demo-folder-map.test.ts tests/use-threads-content-query-ownership.test.ts --reporter=dot
  ```

  Expected: FAIL because the old implementation still exposes the flag parser, uses legacy defaults, honors API sort orders instead of the fixed workflow sequence, and accepts boolean mode arguments.

- [ ] **Step 3: Remove the frontend flag and implement workflow-first normalization.**

  Delete `WorkflowNavEnv`, `isWorkflowNavV6Enabled`, and `WORKFLOW_NAV_V6`. Remove the boolean parameters/defaults from the three navigation builders, remove `HOTEL_LEGACY_PRIMARY_CATEGORY_SLUGS`/the legacy-custom live predicate, remove the unused legacy demo definitions/order aliases from this navigation module, and use the fixed workflow constants directly. Remove `LiveCategoryNavInput.sortOrder` and the `category.order` pass-through because only the workflow allowlist is rendered. Inline the one-caller demo-folder theme helper and direct `getHotelFolderNavTheme` into the map result. Update comments to describe unconditional post-backfill behavior. In `folder-map.ts`, remove the mode parameter from both lookup/normalization functions, delete `ALL_MAIL_FOLDER_DEFINITIONS`/`demoMailFolderBySlug`, and use `workflowDemoMailFolderBySlug.get(slug) ?? legacyDemoMailFolderBySlug.get(slug)` (and the OR of those maps for `isDemoMailFolderSlug`) to select workflow before legacy. Remove the import and second argument from `useThreads`.

  The exported boundaries after the edit are mode-free:

  ```typescript
  export function buildLiveCategoryNavItems(categories: LiveCategoryNavInput[]): NavItem[];
  export function injectLiveCategoryNavSection(
    sections: NavSection[], categories: LiveCategoryNavInput[],
  ): NavSection[];
  export function buildDemoMailFolderNavItems(): NavItem[];
  export function normalizeDemoMailFolderSlug(folder?: string): string;
  ```

- [ ] **Step 4: Run the focused mail tests to verify GREEN.**

  ```bash
  unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
  pnpm exec vitest run tests/hotel-folder-presentation.test.ts tests/workflow-demo-routing.test.ts tests/demo-folder-map.test.ts tests/use-threads-content-query-ownership.test.ts --reporter=dot
  ```

  Expected: all selected files pass with zero failures; the navigation section, Urgent theme, canonical ordering, and alias semantics are covered without a mode argument.

- [ ] **Step 5: Run the task review and record it in the SDD ledger.**

  Generate the task diff package, dispatch a fresh standard `gpt-5.6-luna` reviewer for spec-compliance and code-quality findings, fix every Critical/Important finding, rerun the focused tests, and append `Task 1: complete (...)` to `.superpowers/sdd/progress.md` only after the re-review is clean.

---

### Task 2: Remove server/env/deployment flag plumbing and add a removal guard

**Files:**

- Modify: `apps/server-pilot/src/env.ts`
- Modify: `apps/server-pilot/tests/env.test.ts`
- Modify: `apps/server-pilot/deploy/deploy-ec2.sh`
- Modify: `apps/server-pilot/deploy/write-ec2-env.sh`
- Delete: `apps/server-pilot/deploy/workflow-nav-v6.sh`
- Delete: `apps/server-pilot/tests/deploy-workflow-nav-v6.test.ts`
- Create: `apps/server-pilot/tests/workflow-nav-removal.test.ts`

**Interfaces:**

- `MailEnv` retains `WORKFLOW_TRIAGE_V6: boolean` and has no `WORKFLOW_NAV_V6` property.
- `parseEnv` continues to default/parse/reject `WORKFLOW_TRIAGE_V6` exactly as before.
- `deploy-ec2.sh` exports only the existing public build settings before `pnpm --filter @zero/mail build`; it does not source a nav resolver or inject a nav variable.
- `write-ec2-env.sh` writes no nav key; the production env remains valid for the server parser.

- [ ] **Step 1: Add the failing removal contract test and narrow env expectations.**

  Create `workflow-nav-removal.test.ts` that reads only these active production inputs: `apps/mail/config/navigation.ts`, `apps/mail/components/ui/app-sidebar.tsx`, `apps/mail/hooks/use-threads.ts`, `apps/mail/lib/demo/folder-map.ts`, `apps/server-pilot/src/env.ts`, `apps/server-pilot/deploy/deploy-ec2.sh`, and `apps/server-pilot/deploy/write-ec2-env.sh`. Assert none contains the exact identifiers `VITE_WORKFLOW_NAV_V6`, `WORKFLOW_NAV_V6`, `WorkflowNavEnv`, or `isWorkflowNavV6Enabled`; assert the frontend files contain no generic `workflowNav` boolean parameter/branch and `app-sidebar.tsx` no longer passes `sortOrder: category.order`; assert the helper path does not exist; assert `deploy-ec2.sh` still contains the mail build command and no resolver call. Update `env.test.ts` to test only independent triage defaults/accepted/rejected values and remove nav assertions.

  The removal guard should use exact file reads and a boundary regex, not a repository-wide historical-doc grep. Add compile-time Vitest type assertions for the exported tuples so a renamed optional boolean cannot survive the source scan:

  ```typescript
  for (const file of ACTIVE_INPUTS) {
    const source = readFileSync(file, 'utf8');
    expect(source, file).not.toMatch(/VITE_WORKFLOW_NAV_V6|WORKFLOW_NAV_V6/);
    expect(source, file).not.toMatch(/\bworkflowNav\b/);
  }
  expect(existsSync(helperPath)).toBe(false);
  expectTypeOf(buildLiveCategoryNavItems).parameters
    .toEqualTypeOf<[LiveCategoryNavInput[]]>();
  expectTypeOf(injectLiveCategoryNavSection).parameters
    .toEqualTypeOf<[NavSection[], LiveCategoryNavInput[]]>();
  expectTypeOf(buildDemoMailFolderNavItems).parameters.toEqualTypeOf<[]>();
  expectTypeOf(getDemoMailFolderDefinition).parameters.toEqualTypeOf<[string]>();
  expectTypeOf(normalizeDemoMailFolderSlug).parameters.toEqualTypeOf<[string?]>();
  ```

- [ ] **Step 2: Run the focused server/deploy tests to verify RED.**

  ```bash
  unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
  pnpm --filter @zero/server exec vitest run tests/env.test.ts tests/workflow-nav-removal.test.ts --reporter=dot
  ```

  Expected: FAIL because the current source still defines/parses the nav field, retains mode APIs, deploy scripts still reference the helper/key, and the helper still exists.

- [ ] **Step 3: Remove the server field, parser branch, writer/build wiring, and helper.**

  Delete the `MailEnv` nav property, default, and `parseEnv` branch while leaving `WORKFLOW_TRIAGE_V6` untouched. Remove the helper source/resolver block from `deploy-ec2.sh`; remove the helper import, default, validation, and `WORKFLOW_NAV_V6=` heredoc line from `write-ec2-env.sh`. Delete the now-obsolete helper and old durable-flag test. Do not source `.env.production` for the SPA build and do not add a replacement toggle.

- [ ] **Step 4: Run shell syntax, focused tests, and build-input checks to verify GREEN.**

  ```bash
  bash -n apps/server-pilot/deploy/deploy-ec2.sh apps/server-pilot/deploy/write-ec2-env.sh
  unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
  pnpm --filter @zero/server exec vitest run tests/env.test.ts tests/workflow-nav-removal.test.ts --reporter=dot
  ```

  Expected: shell syntax succeeds; selected tests pass; the removal guard proves active source/deploy inputs have no nav flag or helper. Run `git diff --check` before review.

- [ ] **Step 5: Run the task review and record it in the SDD ledger.**

  Dispatch a fresh `gpt-5.6-luna` reviewer against the Task 2 diff package. Resolve all Critical/Important findings, rerun shell/tests, then append the completed Task 2 evidence to `.superpowers/sdd/progress.md`.

---

### Task 3: Integrate, build, land, deploy, and verify the final artifact

**Files:**

- Verify only: all Task 1/2 files and the final plan.
- Do not modify: dashboard, draft-AI, HMS activation, database schema, or unrelated dirty paths.

**Interfaces:**

- The final mail build is produced with no nav environment variable and contains workflow navigation as ordinary code.
- Landing must preserve the tested patch exactly on `main`; the primary dirty checkout is not a landing target.
- Deployment uses the existing quiesced asset-sync path and does not mutate PM2 for a static SPA change; launch-readiness proves the existing `http`, `worker`, `ai-worker`, and `remote-http` state plus absent HMS state afterward.

- [ ] **Step 1: Run fresh repository verification before landing.**

  With `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`, run the focused mail/server suites, the relevant deploy-config tests that do not require pilot RDS, `pnpm --filter @zero/server build`, and `pnpm --filter @zero/mail build`. Inspect the generated mail assets and assert no `VITE_WORKFLOW_NAV_V6` marker exists while the workflow folder IDs are present in the built JavaScript. Record command output and the baseline SHA `d5188396d48024642759f603d345b611eec31db6` in the ledger.

- [ ] **Step 2: Run final code review against the plan.**

  Run `ce-code-review mode:agent plan:docs/superpowers/plans/2026-09-02-workflow-nav-flag-removal.md` on the complete diff. Apply verified Critical/Important fixes, rerun every covering test/build, and repeat the review if source changes materially.

- [ ] **Step 3: Commit the tested implementation and plan on the feature branch.**

  Stage only the Task 1/2 files and this plan, confirm the staged paths, run `git diff --check`, and create a value-focused commit such as `fix(mail): remove workflow navigation rollout flag`. Do not stage the interim durable-flag files/plan or unrelated user files.

- [ ] **Step 4: Land and push on `main` without touching the dirty primary checkout.**

  Fetch `origin/main`, use a clean temporary landing worktree, fast-forward/merge or cherry-pick the verified feature commit, rerun the landed-main focused verification, and push `main` normally. Confirm `origin/main` contains the exact plan-owned patch and record source/landed SHAs and patch IDs before retiring only the run-owned feature worktree/branch.

- [ ] **Step 5: Deploy the landed `main` revision safely.**

  Capture `LANDED_MAIN_SHA` and `PREVIOUS_MAIN_SHA` from the clean landing worktree. Create a run-owned immutable local ref at `LANDED_MAIN_SHA` (for example `deploy/workflow-nav-${LANDED_MAIN_SHA:0:12}`), pass that ref as `GIT_BRANCH` to `apps/server-pilot/deploy/ops-deploy.sh --quiesced`, and require the EC2 command to print `git rev-parse HEAD` equal to `LANDED_MAIN_SHA` before accepting the build. The bundle path is therefore pinned even if `main` advances. Quiesced publication needs no PM2 restart because nginx serves static assets; do not call `ops-restart.sh`, do not run migrations, and do not run production Vitest. If health/UI proof fails or `rsync --delete` is interrupted, rerun the same pinned asset sync, verify the complete fresh HTML/asset set, and only then retry readiness. For rollback, create a temporary ref at `PREVIOUS_MAIN_SHA`, run the same pinned `GIT_BRANCH`/quiesced deployment, verify the previous SHA and all gates, then remove only the run-owned temporary refs.

- [ ] **Step 6: Verify live behavior and safety invariants.**

  Capture fresh, redacted evidence for:

  - `curl` `200` on loopback `8788/health` and `8789/health`, canonical TLS health, and remote-admin health.
  - The EC2 source/build identity is the pinned `LANDED_MAIN_SHA`; fetch fresh HTML from the canonical origin with cache-busting, extract every referenced JS/CSS URL, download each asset, and assert the asset set contains Urgent plus all eleven workflow IDs/titles and no `VITE_WORKFLOW_NAV_V6` string. Record the HTML hash and asset URLs, not mail content or credentials.
  - Run the existing read-only browser proof through the SSM wrapper with an operator-owned non-PII fixture contract:

    ```bash
    : "${UI_FIXTURE_THREAD_ID:?set a pre-read fixture thread ID containing only [A-Za-z0-9_-]}"
    : "${UI_FIXTURE_MIN_LENGTH:?set a positive non-PII recipient-length integer}"
    printf -v UI_COMMAND 'cd /home/ubuntu/repos/zero && export BETTER_AUTH_URL=https://nava.legacyhotels.co.za UNDO_SEND_SECONDS=30 ZERO_DEMO_MODE=0 ZERO_DEMO_FRONTEND_ONLY=0 VITE_ZERO_DEMO_MODE=0 VITE_FRONTEND_ONLY=0 REAL_MAIL_UI_GATE=1 REAL_MAIL_READ_ONLY=1 REAL_MAIL_MESSAGE_HEADER_THREAD_ID=%q REAL_MAIL_MESSAGE_HEADER_RECIPIENT_MIN_LENGTH=%q && bash apps/server-pilot/deploy/playwright-real-mail-ui-gate.sh --read-only' "$UI_FIXTURE_THREAD_ID" "$UI_FIXTURE_MIN_LENGTH"
    bash apps/server-pilot/deploy/ssm-run-command.sh "$UI_COMMAND"
    ```

    The command must run from the EC2 checkout, use canonical HTTPS, force demo mode off, keep `UNDO_SEND_SECONDS=30`, and fail closed when either non-PII fixture variable is absent/invalid. Update `apps/mail/tests/e2e/real-mail-launch-readonly.spec.ts` so it asserts Urgent plus all eleven workflow links in order, Urgent's visible stripe/presentation, no Spam under Folders, Core `Inbox/Drafts/Sent`, Management `Archive/Snoozed/Bin/Spam`, and the existing forbidden-procedure audit. Store only sanitized command output and metadata in `.superpowers/sdd/workflow-nav-flag-removal/live-proof.json` and `.superpowers/sdd/workflow-nav-flag-removal/playwright.log`, with landed SHA and timestamp; never store credentials or mail content.
  - PM2 has the landed-baseline process contract: `http`, `worker`, `ai-worker`, and `remote-http` online, with AI gate values unchanged; `hms-ai-worker` absent; `launch-readiness.sh` returns `READY`; VPN/perimeter assertions remain green. Capture the pre-deploy PM2/readiness snapshot and compare it after the static publish.
  - No dashboard, draft AI, tool invocation, or HMS activation behavior changed.

---

### Task 4: Compound the verified incident after deployment

**Files:**

- Create or update exactly one solution document under `docs/solutions/` through `$ce-compound mode:headless`.

**Interfaces:**

- The document must describe the regression (build-time flag disappeared on a later deploy), root cause (temporary rollout gate coupled the SPA to env state), final solution (unconditional workflow nav and code rollback), and prevention (do not add a durable env toggle for completed UI cutovers).

- [ ] **Step 1: Run `$ce-compound mode:headless` once after live verification.**

  Use the final conversation/evidence as context. Let the skill perform its full research/overlap/frontmatter validation and write only its solution artifact (plus any justified vocabulary maintenance).

- [ ] **Step 2: Validate the compound artifact.**

  Read the created/updated document, verify YAML frontmatter and no credentials/PII, confirm it links the final plan and live proof without claiming unverified tests, and run the skill’s frontmatter validator when available.

- [ ] **Step 3: Commit and push the compound artifact.**

  Stage only the solution/vocabulary files produced by this run, run `git diff --check`, commit with a `docs:` message, land/push the resulting commit on `main`, and rerun the final `main` status/verification check. This post-deploy documentation commit is intentionally separate so the production code was already deployed and proven before compounding.

---

## Review Disposition

- `ce-plan` pipeline: applied to the inspected navigation, routing, env, deploy, test, and solution evidence.
- `gstack-plan-eng-review`: the named executable was unavailable, so the explicit `gpt-5.6-luna` substitute review found no P0s but required (and this plan now includes) a PM2-free quiesced deployment, read-only Playwright SSM proof, a broader mode-API removal guard, deterministic live ordering, immutable source provenance/rollback, and exported-boundary tests. Final rerun verdict: ready, with no P0/P1/P2 findings. Reports: `.plan-eng-review.md`, `.plan-eng-review-rerun.md`, `.plan-eng-review-final.md` (scratch only).
- `ponytail-review`: the repository skill found avoidable legacy/custom branches, duplicate folder maps/order aliases, the live `sortOrder` pass-through, one-caller theme/CSS wrappers, and mode-branch test duplication. Reconciled: delete the dead legacy/custom navigation branches, duplicate maps, sort-order pass-through, one-caller wrappers, and duplicate alias assertions while retaining `use-threads` source coverage and the explicit safety/evidence gates. Report: `.plan-ponytail-review.md` plus rerun `.plan-ponytail-review-rerun.md` (scratch only; estimated `net: -66` then `-25` lines before implementation).
- `gstack-plan-design-review`: the named executable was unavailable, so the explicit `gpt-5.6-luna` substitute review found the plan incomplete at 6.5/10. Reconciled: add the authenticated launch proof, fixed live order, explicit `bookings` alias-collision decision/table, section-level Core/Folders/Management tests, Urgent theme assertions, and auditable fresh-asset procedure. Report: `.plan-design-review.md` (scratch only).
- `gstack-plan-devex-review`: not required; this is an internal env/deploy removal with no new API, SDK, CLI, or onboarding surface.
- True blockers: none known. Missing executable review assets are an evidence limitation, not permission to weaken implementation or safety checks.

## Completion Checklist

- [x] Tasks 1–2 implemented test-first and independently reviewed.
- [x] Final code review is clean or all blocking findings are fixed and rechecked.
- [x] Feature commit landed on `main`; `origin/main` contains the verified patch.
- [x] Live SPA is rebuilt/deployed from `main` with no nav flag dependency and workflow folders visible.
- [x] Health, perimeter, PM2, worker, AI, and HMS invariants have fresh evidence.
- [x] `$ce-compound mode:headless` ran exactly once after deployment and its artifact is landed.
- [x] Unrelated primary-checkout changes remain untouched.
