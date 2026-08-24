# Mail Content Dark-Mode Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep sanitized legacy email readable in Zero dark mode by making the mail reader host own an explicit light-paper surface instead of inheriting dark app text color into its Shadow DOM.

**Architecture:** `MailContent` is the display boundary for both server-processed mail and frontend-only demo mail. Give its Shadow DOM host explicit white background, black default text, and `color-scheme: light`; descendants without authored colors inherit black while retained `bgcolor="#ffffff"` remains white. Process every reader response as `theme: 'light'` so quote-toggle CSS matches that fixed canvas. Keep server-side `mailBodyDisplayStyleTag()` typography-only, keep sanitization unchanged, and prove browser inheritance with synthetic content.

**Tech Stack:** React 19, open Shadow DOM, CSS `color-scheme`, Tailwind utility classes, Vitest + happy-dom, Playwright Chromium, pnpm.

## Global Constraints

- Pilot-RDS safety: before every Vitest command run `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`; never use pilot/prod RDS or `VITEST_ALLOW_PILOT_RDS=1`.
- Set the surface directly on `MailContent`'s host for both processed and demo paths: `backgroundColor: '#ffffff'`, `color: '#000000'`, and `colorScheme: 'light'`.
- Remove only conflicting host text utilities (`text-black dark:text-white`); retain layout, scroll, focus, query, and Shadow DOM behavior.
- Keep `processEmailHtmlForDisplay`, `mailBodyDisplayStyleTag`, sanitizer allowlists, stored mail, and raw MIME unchanged. Reader request theme becomes constant `'light'` so server-injected quote controls match the fixed light host; retain `processingTheme` in `email-content-v3` as that literal and do not version-bump the cache.
- Do not reintroduce `fixNonReadableColors`, DOM traversal, contrast mutation, user-email CSS allowlisting, or arbitrary dark-template recoloring.
- Scope guarantees inherited-theme failure and normal legacy light-paper HTML, including retained white `bgcolor`. Sanitization strips authored foreground colors but intentionally retains arbitrary `bgcolor`, so contrasting arbitrary dark/tinted templates needs a separate display-policy design; do not claim this host-default fix recolors them. Print output remains out of scope.
- `color-scheme: light` controls browser-native rendering under the reader; it must not disable OS `forced-colors` accessibility overrides.
- Browser fixture uses only synthetic HTML, no login, no app server, no remote mail, and no PII.
- Remove package `color` only after confirming `apps/mail/lib/email-utils.ts` is its sole app import; retain unrelated transitive `color` packages when pnpm needs them.
- Add no runtime dependency and no cache-burst/version change.
- Commit only task-specific files. Land with a non-force fast-forward update to `origin/main`; never use `--no-verify`, force-push, reset, or destructive cleanup.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. No "which approach?" pause.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### Decision authority

- Choose best safe reversible option without asking.
- Better route to accepted goal may be taken; log what changed and why.
- Preserve requirements. Do not silently cut scope.
- Use standard non-fast subagents only; otherwise work inline.

### AWS / infra (use freely)

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

**Allowed:** ops wrappers, bundle sync, deploy, migrate (via `ops-deploy --migrate`), seed (no `--rotate` unless fix requires), read-only SSM checks, PM2 logs, health curl, and tests against a disposable non-production database.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds, any Vitest/test command pointed at pilot or production RDS, setting `VITEST_ALLOW_PILOT_RDS=1`, or sourcing `.env.production` into a test process.

### Pilot RDS safety (overrides autonomy)

Never run Vitest against `nava-zero-mail-pilot` or any production database. No overnight escape hatch exists.

Before every local or EC2 Vitest command:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

If a test requires Postgres, use a disposable test database. If none exists, use read-only SQL/API health checks where they prove the requirement; otherwise report a safety blocker. Never weaken this rule to make a gate green.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix → test → commit → resume. Do not stop at first failure.

### Cursor execution-backend flake (not a human gate)

Exact error: `Execution backend unavailable. Do not retry tool calls — the execution environment is down.`

This is Cursor's agent tool bridge, not Zero app/AWS/RDS. Full playbook: `docs/solutions/workflow-issues/cursor-execution-backend-unavailable.md`.

**Required agent behavior:**
1. Do **not** ask the user to wait or re-invoke.
2. Backoff-retry Shell/Write/StrReplace (≈5s → 15s → 45s) until `echo shell_ok` works or three attempts fail.
3. On recovery: `git status`, read `.superpowers/sdd/*progress*`, resume mid-task (resume subagent or re-dispatch with existing uncommitted work).
4. Only if retries exhaust **and** Shell still dead after ~5 minutes: record blocker in handoff with evidence; still do not invent an app RCA.

### Verification loop

Implement → focused tests → relevant broader tests/build/lint → browser gate → inspect evidence → fix any red → repeat.

### Done criteria

- [ ] Reader host owns `#ffffff` background, `#000000` default text, and `color-scheme: light`; no `dark:text-white` remains.
- [ ] Component and Chromium tests prove unstyled text remains black on retained white legacy HTML while app chrome is dark.
- [ ] Obsolete contrast mutator and its direct dependency are removed; docs capture the precise scope boundary.
- [ ] Targeted tests, browser test, lint, and mail build are green without database access.
- [ ] Correctness and simplicity reviews are clean; verified commits are fast-forwarded to `origin/main`.
- [ ] Isolated worktree and merged feature branch are removed without touching the user's original dirty worktree.

### True blockers

Stop only for missing credentials/access that cannot be obtained safely, required human-only interaction, destructive ambiguity, safety-policy conflict, or external outage that prevents required proof.

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Resume from first incomplete task and continue until all done criteria have evidence.

---

## Plan review disposition

- Engineering gate: added isolated dependency bootstrap, app-local Playwright resolution, processed-path test coverage, and server sanitizer regression coverage.
- Simplicity gate: removed unreachable Playwright tracing, redundant media emulation, and copied runner defaults; kept only an explicit Chromium project.
- Design gate: force reader processing to light for quote-toggle coherence, prove light quote styling and `forced-colors` remain enabled, prove native control scheme, and narrow claim for arbitrary retained dark/tinted `bgcolor`.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `apps/mail/components/mail/mail-content.tsx` | Modify | Own fixed light-paper surface at Shadow DOM host and remove theme-conflicting utilities. |
| `apps/mail/tests/mail-content-rendering.test.tsx` | Modify | Component contract for dark app theme, white legacy table, and host-owned surface values. |
| `apps/mail/playwright.mail-content-theme.config.ts` | Create | Isolated Chromium configuration resolved from mail package, with no auth, server, or external URL. |
| `apps/mail/tests/e2e/mail-content-theme-isolation.spec.ts` | Create | Real-browser assertion that host styling crosses into unstyled Shadow DOM descendants on a retained white `bgcolor` table. |
| `apps/server-pilot/tests/process-email-html-font.test.ts` | Modify | Assert sanitizer retains white legacy `bgcolor` while stripping authored foreground/background styles. |
| `apps/mail/lib/email-utils.ts` | Modify | Delete unused contrast mutator and private background walker. |
| `apps/mail/package.json` | Modify | Remove unused direct `color` dependency. |
| `pnpm-lock.yaml` | Modify | Regenerate importer resolution after dependency removal. |
| `docs/solutions/ui-bugs/centurion-mail-body-font-outlook-calibri.md` | Modify | Record reader-host ownership boundary and preserve typography helper's limited role. |

---

### Task 0: Bootstrap isolated dependencies and record clean baseline

**Files:** none.

**Interfaces:**
- Consumes: frozen repository lockfile.
- Produces: installed local package executables, baseline test evidence, and no source change.

- [x] **Step 1: Install locked workspace dependencies without lifecycle side effects**

Run:

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

Expected: installation succeeds without changing `package.json` or `pnpm-lock.yaml`.

- [x] **Step 2: Generate local Paraglide imports required by Vitest**

`apps/mail/vitest.config.ts` does not load the Vite Paraglide plugin, while `MailContent` imports generated `@/paraglide/messages`. Compile the existing i18n project locally before the mail test:

```bash
pnpm --filter @zero/mail exec paraglide-js compile --project ./project.inlang --outdir ./paraglide --strategy cookie baseLocale --silent
```

Expected: local `apps/mail/paraglide` files exist for test resolution. They are generated setup output, never staged, and will be removed as part of disposable-worktree cleanup.

- [x] **Step 3: Run existing focused baseline**

Run:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter @zero/mail exec vitest run tests/mail-content-rendering.test.tsx tests/mail-content-cache-key-contract.test.ts
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm -C apps/server-pilot exec vitest run tests/process-email-html-font.test.ts
```

Expected: baseline suites pass before any source edit. Any red triggers RCA under the autonomous mandate before Task 1.

---

### Task 1: Pin reader host to a light-paper surface

**Files:**
- Modify: `apps/mail/components/mail/mail-content.tsx:1-14,442-448`
- Test: `apps/mail/tests/mail-content-rendering.test.tsx`
- Test: `apps/mail/tests/mail-content-cache-key-contract.test.ts`
- Test: `apps/server-pilot/tests/process-email-html-font.test.ts`

**Interfaces:**
- Consumes: app theme only as unrelated chrome state; reader processing must use literal `'light'`.
- Produces: `.mail-content` with inline `background-color: #ffffff`, `color: #000000`, and `color-scheme: light`, including when `frontendOnlyDemo` bypasses server processing. `email-content-v3` retains `processingTheme` but its value is always `'light'`.

- [x] **Step 1: Add failing processed-path and demo-path host contracts**

Append this test to `describe('MailContent processing states', ...)`:

```tsx
  it('processes legacy mail onto a fixed light-paper surface', async () => {
    mocks.processEmailContent.mockResolvedValue({
      processedHtml:
        '<table bgcolor="#ffffff"><tr><td><span data-legacy-mail="true">Readable</span></td></tr></table>',
      hasBlockedImages: false,
    });

    renderMailContent();

    await waitFor(() => {
      expect(mocks.processEmailContent).toHaveBeenCalledWith({
        html: RAW_HTML,
        messageId: 'message-42',
        shouldLoadImages: false,
        theme: 'light',
      });
      expect(renderedHost()?.shadowRoot?.querySelector('[data-legacy-mail="true"]')?.textContent).toBe(
        'Readable',
      );
    });

    const host = renderedHost();
    expect(host?.className).not.toContain('text-black');
    expect(host?.className).not.toContain('dark:text-white');
    expect(host?.style.getPropertyValue('background-color')).toBe('#ffffff');
    expect(host?.style.getPropertyValue('color')).toBe('#000000');
    expect(host?.style.getPropertyValue('color-scheme')).toBe('light');
    expect(host?.style.getPropertyValue('forced-color-adjust')).toBe('');
  });
```

Extend the existing `keeps frontend-only demo on its local rendering path` test with the same three `host.style.getPropertyValue(...)` assertions. This protects the bypass path without duplicating a full fixture.

Remove the now-unused `resolvedTheme` field, reset assignment, and `vi.mock('next-themes', ...)` block. In the existing retry-focus test that formerly rerendered after `mocks.resolvedTheme = 'dark'`, rerender with `html={SECOND_RAW_HTML}` instead, so a real source change exercises the third processing request without keeping a dead theme dependency.

Extend `apps/mail/tests/mail-content-cache-key-contract.test.ts`:

```ts
    expect(source).toContain("const processingTheme = 'light';");
    expect(source).not.toContain('const { resolvedTheme } = useTheme()');
```

Extend `apps/server-pilot/tests/process-email-html-font.test.ts`:

```ts
  it('retains a white legacy canvas while stripping authored colors', () => {
    const { processedHtml } = processEmailHtmlForDisplay({
      html: '<table bgcolor="#ffffff" style="background-color:#000000"><tr><td><span style="color:#ffffff">Readable</span></td></tr></table>',
      messageId: 'msg-legacy',
      shouldLoadImages: false,
      theme: 'light',
      origin: 'https://example.test',
      attachments: [],
    });

    expect(processedHtml).toContain('bgcolor="#ffffff"');
    expect(processedHtml).not.toMatch(/<(?:table|span)\b[^>]*\sstyle=/i);
  });

  it('renders collapsed quotes with light-paper controls', () => {
    const { processedHtml } = processEmailHtmlForDisplay({
      html: '<blockquote><p>Quoted reply</p></blockquote>',
      messageId: 'msg-quote',
      shouldLoadImages: false,
      theme: 'light',
      origin: 'https://example.test',
      attachments: [],
    });

    expect(processedHtml).toContain('background: #ffffff');
    expect(processedHtml).toContain('outline: 2px solid #71717a');
    expect(processedHtml).not.toContain('#313131');
  });
```

- [x] **Step 2: Run focused tests and verify red**

Run:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter @zero/mail exec vitest run tests/mail-content-rendering.test.tsx
```

Expected: the new processed-path test fails because request theme is `dark` and `.mail-content` still includes dark-mode text utilities with no explicit surface styles. The server sanitizer regression may already pass because it locks existing behavior.

- [x] **Step 3: Make minimal reader-host change**

In `apps/mail/components/mail/mail-content.tsx`, remove unused imports:

```ts
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';
```

Replace:

```ts
  const { resolvedTheme } = useTheme();
  // ...
  const processingTheme = (resolvedTheme as 'light' | 'dark') || 'light';
```

with:

```ts
  const processingTheme = 'light';
```

Replace the host element with:

```tsx
      <div
        ref={hostRef}
        role="region"
        aria-label="Message content"
        tabIndex={-1}
        className="mail-content w-full flex-1 overflow-scroll no-scrollbar px-4"
        style={{
          backgroundColor: '#ffffff',
          color: '#000000',
          colorScheme: 'light',
        }}
      />
```

Do not add a wrapper, media query, mutation effect, CSS parser, or theme branch.

- [x] **Step 4: Run focused regression and verify green**

Run:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter @zero/mail exec vitest run tests/mail-content-rendering.test.tsx tests/mail-content-cache-key-contract.test.ts
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm -C apps/server-pilot exec vitest run tests/process-email-html-font.test.ts
```

Expected: PASS; cache-key contract remains `email-content-v3` with literal light processing theme, processed and demo render tests pass, and sanitizer behavior is explicit.

- [x] **Step 5: Commit Task 1**

```bash
git add apps/mail/components/mail/mail-content.tsx apps/mail/tests/mail-content-rendering.test.tsx apps/mail/tests/mail-content-cache-key-contract.test.ts apps/server-pilot/tests/process-email-html-font.test.ts
git commit -m "$(cat <<'EOF'
fix(mail): isolate legacy content from dark theme

EOF
)"
```

---

### Task 2: Prove browser inheritance with a synthetic legacy message

**Files:**
- Create: `apps/mail/playwright.mail-content-theme.config.ts`
- Create: `apps/mail/tests/e2e/mail-content-theme-isolation.spec.ts`

**Interfaces:**
- Consumes: Task 1 component-tested browser contract (`#ffffff`, `#000000`, `light`) and native Shadow DOM inheritance.
- Produces: Chromium-only test run with no auth storage state, no `baseURL`, no web server, and no remote dependencies.

- [x] **Step 1: Add the isolated Playwright configuration**

Create `apps/mail/playwright.mail-content-theme.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /mail-content-theme-isolation\.spec\.ts/,
  forbidOnly: !!process.env.CI,
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
```

- [x] **Step 2: Add browser-level inheritance proof**

Create `apps/mail/tests/e2e/mail-content-theme-isolation.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('dark app chrome cannot turn unstyled white-paper mail text white', async ({ page }) => {
  await page.setContent(`
    <style>
      :root { color-scheme: dark; }
      #app { background: rgb(20, 20, 20); color: rgb(255, 255, 255); }
    </style>
    <div id="app">
      <div
        id="mail-content"
        style="background-color: #ffffff; color: #000000; color-scheme: light;"
      ></div>
    </div>
  `);

  const computed = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('#mail-content');
    if (!host) throw new Error('mail-content host missing');

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<table bgcolor="#ffffff"><tbody><tr><td><span data-legacy-copy="true">Readable</span><input data-native-control="true"></td></tr></tbody></table>';

    const text = root.querySelector<HTMLElement>('[data-legacy-copy="true"]');
    const table = root.querySelector<HTMLElement>('table');
    const nativeControl = root.querySelector<HTMLInputElement>('[data-native-control="true"]');
    if (!text || !table || !nativeControl) throw new Error('legacy fixture missing');

    return {
      hostBackground: getComputedStyle(host).backgroundColor,
      hostColor: getComputedStyle(host).color,
      hostColorScheme: getComputedStyle(host).colorScheme,
      tableBackground: getComputedStyle(table).backgroundColor,
      textColor: getComputedStyle(text).color,
      nativeControlColorScheme: getComputedStyle(nativeControl).colorScheme,
    };
  });

  expect(computed).toEqual({
    hostBackground: 'rgb(255, 255, 255)',
    hostColor: 'rgb(0, 0, 0)',
    hostColorScheme: 'light',
    tableBackground: 'rgb(255, 255, 255)',
    textColor: 'rgb(0, 0, 0)',
    nativeControlColorScheme: 'light',
  });

  await page.emulateMedia({ forcedColors: 'active' });
  const forcedColors = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('#mail-content');
    if (!host) throw new Error('mail-content host missing');
    return {
      mediaActive: matchMedia('(forced-colors: active)').matches,
      adjustment: getComputedStyle(host).forcedColorAdjust,
    };
  });

  expect(forcedColors).toEqual({ mediaActive: true, adjustment: 'auto' });
});
```

- [x] **Step 3: Run isolated browser test**

Run from repository root:

```bash
pnpm --filter @zero/mail exec playwright test -c playwright.mail-content-theme.config.ts
```

Expected: one Chromium test passes without starting a server or using a login; it checks normal and `forced-colors` states in the same fixture.

- [x] **Step 4: Commit Task 2**

```bash
git add apps/mail/playwright.mail-content-theme.config.ts apps/mail/tests/e2e/mail-content-theme-isolation.spec.ts
git commit -m "$(cat <<'EOF'
test(mail): cover dark theme reader isolation

EOF
)"
```

---

### Task 3: Delete obsolete contrast mutator and document boundary

**Files:**
- Modify: `apps/mail/lib/email-utils.ts:1-55`
- Modify: `apps/mail/package.json:17-122`
- Modify: `pnpm-lock.yaml`
- Modify: `docs/solutions/ui-bugs/centurion-mail-body-font-outlook-calibri.md:38-63`

**Interfaces:**
- Consumes: Task 1 fixed host defaults; no caller may depend on `fixNonReadableColors`.
- Produces: no direct `color` dependency in `@zero/mail`; display typography remains server-owned while canvas colors remain client-reader-owned.

- [x] **Step 1: Confirm refactor precondition**

Run:

```bash
rg "from ['\"]color['\"]|fixNonReadableColors" apps/mail --glob '*.{ts,tsx}'
```

Expected before edit: only `apps/mail/lib/email-utils.ts` imports `color` and declares `fixNonReadableColors`.

- [x] **Step 2: Delete unused contrast mutation**

From `apps/mail/lib/email-utils.ts`, delete:

```ts
import Color from 'color';
```

Delete the complete `fixNonReadableColors` export and private `getEffectiveBackgroundColor` helper. Leave the remaining address parsing, sanitization, and result-schema utilities byte-for-byte unchanged.

- [x] **Step 3: Remove direct dependency and refresh lockfile**

Delete this direct dependency from `apps/mail/package.json`:

```json
"color": "5.0.0",
```

Then regenerate only dependency metadata:

```bash
pnpm install --lockfile-only --ignore-scripts
pnpm install --frozen-lockfile --ignore-scripts
```

Verify `pnpm-lock.yaml` no longer has `color: 5.0.0` under the `apps/mail` importer. Do not remove unrelated transitive `color` packages.

- [x] **Step 4: Update durable solution note**

Amend `docs/solutions/ui-bugs/centurion-mail-body-font-outlook-calibri.md` so its root-cause and fix sections state:

```md
- Sanitized inbound mail keeps structural `bgcolor` but removes arbitrary authored `style`; an unstyled fragment therefore inherits `color` through the Shadow DOM host.
- `mailBodyDisplayStyleTag()` owns fixed Calibri/wrapping behavior only. It must not force reader text color.
- `MailContent` owns the fixed light-paper display surface (`#ffffff` / `#000000` / `color-scheme: light`) so a dark Zero shell cannot produce white text on retained white legacy mail.
```

Document intended boundary: no dynamic per-node contrast rewriting and no claim to recolor intentionally dark/tinted authored templates.

- [x] **Step 5: Run deletion and reader regressions**

Run:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter @zero/mail exec vitest run tests/mail-content-rendering.test.tsx tests/mail-content-cache-key-contract.test.ts
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm -C apps/server-pilot exec vitest run tests/process-email-html-font.test.ts
pnpm --filter @zero/mail exec eslint components/mail/mail-content.tsx lib/email-utils.ts tests/mail-content-rendering.test.tsx tests/e2e/mail-content-theme-isolation.spec.ts
pnpm --filter @zero/mail exec playwright test -c playwright.mail-content-theme.config.ts
```

Expected: all commands pass; dependency deletion introduces no import or lint error.

- [x] **Step 6: Commit Task 3**

```bash
git add apps/mail/lib/email-utils.ts apps/mail/package.json pnpm-lock.yaml docs/solutions/ui-bugs/centurion-mail-body-font-outlook-calibri.md
git commit -m "$(cat <<'EOF'
refactor(mail): remove obsolete contrast mutator

EOF
)"
```

---

### Task 4: Fresh verification, review, fast-forward landing, and cleanup

**Files:**
- Modify: `docs/superpowers/plans/2026-08-23-mail-content-dark-mode-isolation.md` (check completed tasks, review record, and final evidence only)
- Modify: `.gitignore` (ignore generated app-local Playwright results)

**Interfaces:**
- Consumes: all task commits; remote `origin/main`.
- Produces: verified commit on remote `main`, no linked feature worktree, and no stale local feature branch.

- [x] **Step 1: Run fresh complete local gates**

Run:

```bash
pnpm --filter @zero/mail build
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter @zero/mail test
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm -C apps/server-pilot exec vitest run tests/process-email-html-font.test.ts
pnpm --filter @zero/mail exec playwright test -c playwright.mail-content-theme.config.ts
pnpm --filter @zero/mail exec eslint components/mail/mail-content.tsx lib/email-utils.ts tests/mail-content-rendering.test.tsx tests/e2e/mail-content-theme-isolation.spec.ts
```

Expected: all targeted tests, Chromium proof, lint, and mail build pass without database access.

- [x] **Step 2: Run final review gates**

Run a task-scoped correctness review plus `ponytail-review` against merge-base diff. Resolve all Critical or Important findings, rerun affected gates, and record review outcome in this plan before landing.

Review record:

- Correctness and adversarial review: no actionable defect. The documented limitation for arbitrary retained dark/tinted `bgcolor` remains intentional and out of scope.
- Testing review: the standalone Chromium command is intentionally separate from Vitest so it does not inherit app/auth/server E2E setup. It remains an explicit required gate here; no CI test runner currently exists to extend.
- Maintainability review: added `.gitignore` coverage for `apps/mail/test-results/`; `git check-ignore -v apps/mail/test-results/.last-run.json` passed.
- Simplicity review: retained the 13-line Playwright config. It deliberately isolates this synthetic browser contract from repository-wide E2E defaults, auth state, servers, and unrelated specs.

Fresh evidence: mail build passed; subsequent full mail suite passed 81 files / 406 tests after `build/client` existed; server font suite passed; Chromium isolation proof passed 1 test; scoped ESLint passed. All Vitest commands ran with `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS` unset.

- [ ] **Step 3: Commit plan, review evidence, and implementation**

Run:

```bash
git add docs/superpowers/plans/2026-08-23-mail-content-dark-mode-isolation.md
git commit -m "$(cat <<'EOF'
docs(mail): record dark mode reader isolation plan

EOF
)"
```

Expected: clean feature branch with all task commits recorded.

- [ ] **Step 4: Remove generated setup output before landing**

Run:

```bash
rm -rf apps/mail/paraglide
git status --short
```

Expected: no generated Paraglide artifact remains; only intentionally staged or committed theme-fix files may appear. Do not remove any tracked or user-authored file.

- [ ] **Step 5: Rebase safely onto latest remote main**

Run:

```bash
git fetch origin main
git rebase origin/main
```

Expected: fast-forward rebase or clean replay. If remote `main` advanced, rerun every Step 1 gate after successful rebase. If conflicts emerge, resolve only theme-fix files, rerun gates, and continue; never use force push or skip verification.

- [ ] **Step 6: Push a fast-forward update to remote main**

Run:

```bash
git push origin HEAD:main
git fetch origin main
git merge-base --is-ancestor HEAD origin/main
git status --short
```

Expected: push succeeds without force; `HEAD` is included in `origin/main`; worktree is clean.

- [ ] **Step 7: Remove merged worktree and branch from a different checkout**

Run from `C:/Users/gamin/Desktop/projs/emails hotels uis/zero`:

```bash
git worktree remove "C:/Users/gamin/.config/superpowers/worktrees/zero/mail-html-theme-isolation"
git branch -d fix/mail-html-theme-isolation
git worktree list
```

Expected: linked theme-fix worktree and merged branch no longer exist; original user worktree remains untouched.

---

## Out of scope

- Dark-converting arbitrary authored HTML email templates.
- Changing retained per-element `bgcolor` semantics.
- Changing stored mail, server processing implementation, sanitizer policy, or React Query cache-key shape. The client may pass the existing processing input as literal `'light'`.
- Reintroducing HTML `style` attributes or client-side text-color mutations.
- Print rendering and app chrome theming.

## Definition of done

- [ ] `MailContent` explicitly owns white background, black default text, and light color scheme without `dark:text-white`.
- [ ] Dark app + retained white legacy table is covered by both component and real Chromium tests.
- [ ] `fixNonReadableColors` and direct `color` dependency are removed with no remaining app import.
- [ ] Solution note records host/typography ownership and scope boundary.
- [ ] Targeted Vitest, isolated Playwright, lint, and mail build pass with no database access.
- [ ] Correctness and simplicity reviews have no unresolved Critical or Important finding.
- [ ] Verified commits land as a non-force fast-forward on `origin/main`.
- [ ] Linked feature worktree and local merged feature branch are removed; original dirty checkout is untouched.
