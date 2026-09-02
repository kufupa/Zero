# Nava FTE Overlay Implementation Plan

> **For agentic workers:** Execute **inline**. No subagent-driven-development. No per-task spec/code review passes. Write tests, implement, run tests, move on. Subagents only for isolated long jobs (e.g. submodule `npm install`), never for review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution posture: autonomous.** Do not pause for routine checkpoints. Continue until done criteria are verified or a true blocker is reached.

**Goal:** One Orca start path labeled **Nava** that paints a Cursor-class TUI FTE board (no model, no figlet, no `less`) then execs Prime on Gemini 3.7 Flash over allowlisted files, with honest first-response latency from the connected-mailbox dump.

**Architecture:** Overlay wrapper in Zero. Hours parser reads the gitignored dump through `createPrivateInputReader`, writes `.private/connected-mailbox-corpus/hours.json`. Dashboard generator interpolates frozen mix/HITL/tools into committable JSON+markdown. TUI reads that JSON via Prime's `@earendil-works/pi-tui` (file: dependency). Quit calls `TUI.stop()` (leave alt-screen) then `exec` `external/prime-agent/prime-agent.sh`. Kernel dump-deny is `sitecustomize` on `PYTHONPATH`.

**Tech Stack:** TypeScript, Vitest, bash, CPython sitecustomize, Prime Agent submodule (`external/prime-agent`), `@earendil-works/pi-tui`.

**Spec:** `/home/orca/.gstack/projects/zero/orca-feat-connected-mailbox-corpus-design-20260827-144235.md`

**Branch:** `feat/connected-mailbox-corpus`

**Eng-review auto-accepts (founder 2026-08-27):** full overlay (1A); npm install Prime + `file:` TUI dep (2A); Orca custom-TUI is probe/block (3A); `TUI.stop()` then exec (4A). Remaining review items use the recommended option.

## Global Constraints

- Pilot-RDS safety overrides this plan. Before every Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`. Never set `VITEST_ALLOW_PILOT_RDS=1`. Never source `.env.production` into a test shell.
- Hours tests use fixtures only. Parser may read the live dump at runtime, never in Vitest.
- Do not patch `external/prime-agent` sources. `npm install` / `npm run build` inside the submodule is allowed.
- Do not edit repo-root `AGENTS.md`.
- Display name **Nava**. Never ship a start button labeled Prime Agent.
- TUI must not look like `less`+header or figlet. Header word is `Nava`. No butterfly. No giant NAVA word-art.
- Do not label first-response latency “FTE hours saved.” No £ / ADR headline.
- Mix rows are inbound messages n=2957. Unknown 99 is inbound messages. Luna unknown route 152 threads is a different pass; never one cell.
- Ranked HMS tools: every row `live=false`, `shadow=false`. `hms_quote_stay` caption includes `bookable=false`.
- `retry.enabled: false` in project settings. Provider `google`, model `gemini-3.7-flash` (google-generative-ai row, not github-copilot / opencode).
- Raw dump and mail bodies never go to Git, web search, remote MCP, CI logs, or SSM.
- Do not commit `.gemini_api_key`.
- Standard non-fast subagents only. If unavailable, execute inline.
- This plan’s done criteria are **local**. Do not require `ops-deploy.sh` or EC2 Vitest.

## Autonomous Execution Mandate

**User granted autonomous execution for this plan.** Continue until the plan goal and done criteria are verified or a true blocker is reached. Do not pause for routine choices.

### Decision authority

- Choose best safe reversible option without asking.
- Better route to accepted goal may be taken; log what changed and why.
- Preserve requirements. Do not silently cut scope.
- Execute inline. Subagents allowed for long isolated jobs only. No SDD two-stage review. No “review pass then next task” gate.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**
- Code, commits, and this plan stay normal prose.

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

**This feature does not need EC2 deploy to be done.** Do not treat a missing remote gate as a blocker.

### Pilot RDS safety (overrides autonomy)

Never run Vitest against `nava-zero-mail-pilot` or any production database. No overnight escape hatch exists.

Before every local or EC2 Vitest command:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

If a test requires Postgres, use a disposable test database. If none exists, use read-only SQL/API health checks where they prove the requirement; otherwise report a safety blocker. Never weaken this rule to make a gate green.

### RCA loop

FAIL → reproduce minimally → identify root cause and mechanism → research unfamiliar behavior when useful → choose smallest correct fix → test → resume plan.

Symptom patches, skipped gates, and “user can finish later” are not completion.

### Cursor execution-backend flake (not a human gate)

Exact error: `Execution backend unavailable. Do not retry tool calls — the execution environment is down.`

This is Cursor's agent tool bridge, not Zero app/AWS/RDS. Full playbook: `docs/solutions/workflow-issues/cursor-execution-backend-unavailable.md`.

**Required agent behavior:**
1. Do **not** ask the user to wait or re-invoke.
2. Backoff-retry Shell/Write/StrReplace (≈5s → 15s → 45s) until `echo shell_ok` works or three attempts fail.
3. On recovery: `git status`, read `.superpowers/sdd/*progress*`, resume mid-task (resume subagent or re-dispatch with existing uncommitted work).
4. Only if retries exhaust **and** Shell still dead after ~5 minutes: record blocker in handoff with evidence; still do not invent an app RCA.

### Safety

- Follow repository rules and project overlays.
- Never force-push protected branches, bypass hooks, use destructive git, expose secrets/PII, or weaken safety guards.
- Tests requiring databases use disposable non-production databases only.
- Irreversible or production-data-affecting ambiguity is a true blocker.

### Verification loop

Implement → focused tests → relevant broader tests/build/lint → inspect evidence → fix any red → repeat.

### Done criteria

- [ ] `scripts/nava` exists, executable, cwd Zero repo root.
- [ ] Missing dump → launcher exits non-zero; no stub dashboard.
- [ ] Missing `.private/connected-mailbox-corpus/hours.json` → launcher runs hours parser then dashboard generator.
- [ ] TTY investor path: Nava TUI first (no Gemini forward pass), then after `q`/`Enter`: `TUI.stop()` without `preserveAltScreen`, then `exec external/prime-agent/prime-agent.sh`.
- [ ] Non-TTY: print `docs/infor-hms/nava-fte-dashboard.md` to stdout and exit 0 (no TUI, no exec).
- [ ] TUI header contains `Nava` and `gemini-3.7-flash · local`. Feel-test: not `less`, not figlet.
- [ ] Mix seven rows sum to 2957. Latency KPIs come from `hours.json` (`nEligibleFirstResponse` is parser output, not hardcoded 301). Inbound-only 2102/2403 (87.5%) + retained-outbound caveat visible without a prompt.
- [ ] Tool table matches design; every row live=false, shadow=false.
- [ ] `.prime/agent/settings.json` has `retry.enabled: false`, `defaultProvider: "google"`, `defaultModel: "gemini-3.7-flash"`, `telemetry.enabled: false`, `bundledSkills.websearch: false`, `quietStartup: true`.
- [ ] `PYTHONPATH` includes `scripts/nava-sitecustomize-path`. Opening `connected-mailbox-inbox.md` via `Path.read_text` / `io.open` raises `PermissionError` when `NAVA_ALLOW_DUMP=0`. Proof uses `python -m` (not `python -i`). If Prime kernel venv exists, same proof on that interpreter.
- [ ] Hours Vitest covers spoof-in-fence, unthreaded keys, outbound-first, missing ts, inbound-only, even-n median. `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` first.
- [ ] Dashboard JSON snapshot test green. Files `docs/infor-hms/nava-fte-dashboard.json` and `.md` exist.
- [ ] Orca ADE custom-TUI command field probed: if present, display name `Nava`, command `scripts/nava`. If absent, **true blocker** — do not ship a Prime-named button. Overlay code may still be complete.
- [ ] `external/prime-agent/node_modules/.bin/tsx` exists **and** `prime-agent.sh --help` (or equivalent non-interactive smoke) exits 0. Workspace packages that export `dist/` must be built, not merely installed.
- [ ] Dump-deny is documented as **Python kernel only**. Node `fs` / host bash remain residuals. Plan must not call this a sandbox.
- [ ] No unresolved blocker affecting plan goal. Live dump missing: unit tests and overlay code can still be **code-complete**; Task 8 and investor TTY are then a demo blocker, not a reason to fake hours.json.

### True blockers

Stop only for: missing dump file when proving live hours; missing `.gemini_api_key` line 1 when proving Prime boot; Orca ADE has no custom-TUI command field (name-gate); missing credentials/access that cannot be obtained safely; required human-only interaction; destructive ambiguity; safety-policy conflict; execution-backend dead after retries.

Host `@` / `!cat` / OS bash **and Prime Node file tools** can still read the dump. `sitecustomize` only wraps CPython `io`/`Path` (and `bash()` if that name exists in the kernel). Basename deny is bypassable via copy/rename. That residual is **not** a blocker. Do not claim an airtight sandbox.

## Execution Mode

Autonomous inline. Resume from first incomplete task. **Do not use subagent-driven-development.** No spec-review / code-review passes between tasks. Code → test → next task. Subagents only when a job is long and isolated (submodule install/build). Do not ask "which approach?"

---

## File map

| Path | Responsibility |
|------|----------------|
| `apps/server-pilot/src/ops/nava-fte-hours.ts` | Dump grammar parser + latency stats (pure, fixture-tested) |
| `apps/server-pilot/scripts/nava-fte-hours.ts` | CLI: read dump via private-output reader, write `hours.json` |
| `apps/server-pilot/tests/nava-fte-hours.test.ts` | Parser + stats tests |
| `apps/server-pilot/src/ops/nava-fte-dashboard.ts` | Frozen mix/HITL/tools + interpolate hours → JSON/markdown |
| `apps/server-pilot/src/ops/nava-fte-dashboard-view.ts` | Pure section lines for TUI (no TTY) |
| `apps/server-pilot/scripts/nava-fte-dashboard.ts` | CLI writer for `docs/infor-hms/nava-fte-dashboard.{json,md}` |
| `apps/server-pilot/tests/nava-fte-dashboard.test.ts` | Snapshot + mix sum + interpolation |
| `apps/server-pilot/tests/nava-fte-dashboard-view.test.ts` | Header/caveat/mix feel-test strings |
| `scripts/nava-dashboard-tui.ts` | pi-tui paint + keys; reads JSON only |
| `scripts/nava` | Launcher |
| `scripts/nava-sitecustomize-path/sitecustomize.py` | Dump path deny for `-m` kernels |
| `apps/server-pilot/tests/nava-sitecustomize.test.ts` | Spawn python `-c` / `-m` deny proof |
| `scripts/package.json` | `file:` dep on `@earendil-works/pi-tui` |
| `.prime/agent/settings.json` | Project Prime settings |
| `.prime/agent/skills/nava-fte/SKILL.md` | Allowlist Q&A skill |
| `.gitignore` | Ignore `.gemini_api_key`, `.prime/agent/sessions/`, `.prime/agent/logs/` |
| `docs/infor-hms/nava-fte-dashboard.json` | TUI source of truth (aggregates only) |
| `docs/infor-hms/nava-fte-dashboard.md` | Git/TTY twin |

```
 dump.md (gitignored)
    │  createPrivateInputReader
    ▼
 nava-fte-hours ──► hours.json (gitignored)
    │
    ▼
 nava-fte-dashboard ──► nava-fte-dashboard.json + .md (committed)
    │
    ▼
 nava-dashboard-tui  (TTY)  ──q/Enter──► TUI.stop() ──exec──► prime-agent.sh
    │
    └── (not a TTY) print .md, exit
```

## What already exists

- Dump grammar: `apps/server-pilot/src/ops/connected-mailbox-markdown-dump.ts` (`## Message N:`, `- **Thread ID:**`, fenced `text`/`html`).
- Private IO: `createPrivateInputReader` / `createPrivateOutputWriter` (`connected-mailbox-corpus`).
- Census/analysis: mix, HITL locks, tool ranking (frozen copy — do not recompute from dump).
- Prime launcher: `external/prime-agent/prime-agent.sh` (needs `npm install` in submodule).
- TUI widgets: `external/prime-agent/packages/tui` package name **`@earendil-works/pi-tui`** (not `prime-agent-tui`).
- Gemini row: `packages/ai/src/models.generated.ts` provider `google`, id `gemini-3.7-flash`, api `google-generative-ai`.
- Env key: `GEMINI_API_KEY` (`packages/ai/src/env-api-keys.ts`).
- Project settings path: `join(cwd, ".prime/agent", "settings.json")`.
- Kernel spawn inherits `process.env` (`repl-manager.ts` `...process.env`). `preserveAltScreen` is **in-process only**.

## NOT in scope

- Fork/rebrand Prime submodule strings / `APP_TITLE`.
- Patch `generate-models.ts`.
- Playwright, live HMS, mail send, £ headline.
- Host bash / `@` dump sandbox (residual).
- TPM token-bucket, Exa/Serper, residual `rlm()`.
- EC2 deploy of this overlay.
- Editing repo-root `AGENTS.md`.
- Public npm package.

## Git commit strategy

One conventional commit per completed task after tests green. No amend, no force-push, no `--no-verify`. Do not commit dump, `hours.json`, `.gemini_api_key`, or secrets.

| Task | Message |
|------|---------|
| 0 | `chore(nava): install prime-agent submodule deps and tui build` |
| 1 | `feat(nava): parse first-response latency from mailbox dump` |
| 2 | `feat(nava): generate frozen FTE dashboard json and markdown` |
| 3 | `feat(nava): add dashboard view model for TUI` |
| 4 | `feat(nava): add sitecustomize dump deny` |
| 5 | `feat(nava): add Nava dashboard TUI and launcher` |
| 6 | `feat(nava): add prime project settings and nava-fte skill` |
| 7 | `chore(nava): gitignore gemini key and prime session dirs` |

---

### Task 0: Prime submodule install + TUI file dependency

**Files:**
- Modify: `scripts/package.json`
- Modify: `external/prime-agent/package-lock.json` (from `npm install` in submodule; expected)
- Create: `external/prime-agent/node_modules/` (not committed)

- [ ] **Step 1: Install and build Prime workspace (tsx is not enough)**

`prime-agent.sh` without `--dist` runs `tsx packages/coding-agent/src/cli.ts`. That graph still imports workspace packages whose `"main"` is `dist/`. Install then build:

```bash
cd /home/ubuntu/projects/zero/external/prime-agent
npm install
npm run build
test -x node_modules/.bin/tsx
test -f packages/tui/dist/index.js
test -f packages/coding-agent/src/cli.ts
./prime-agent.sh --help >/tmp/nava-prime-help.txt
```

Expected: help/smoke exits 0. If `npm run build` is too heavy, minimum is build `packages/tui`, `packages/ai`, `packages/agent`, `packages/coding-agent` in that order (see root `package.json` `scripts.build`). Do not treat “tsx exists” as Prime boots.

First interactive Prime start may run `ensureKernelPython` (uv, `~/.prime/agent/kernel-venv`, network). Budget time. Kernel venv lives under **home** `~/.prime/agent/kernel-venv`, not the repo `.prime/` tree.

- [ ] **Step 2: Add file: dependency after TUI dist exists**

In `scripts/package.json` dependencies add:

```json
"@earendil-works/pi-tui": "file:../external/prime-agent/packages/tui"
```

Then from repo root: `pnpm install`. `file:` resolution requires `packages/tui/dist/index.js` already built.

- [ ] **Step 3: Gitignore secrets early** (do not wait for Task 7)

Add to `.gitignore` now:

```
.gemini_api_key
.prime/agent/sessions/
.prime/agent/logs/
```

Do **not** gitignore `~/.prime/agent/kernel-venv` via a repo path `.prime/agent/kernel-venv/` as if that were the kernel. Home venv is outside the repo.

- [ ] **Step 4: Commit lockfile changes that belong to Zero** (`scripts/package.json` + root lockfile + `.gitignore`). Do not commit `external/prime-agent/node_modules`.

---

### Task 1: Hours parser (TDD)

**Files:**
- Create: `apps/server-pilot/src/ops/nava-fte-hours.ts`
- Create: `apps/server-pilot/scripts/nava-fte-hours.ts`
- Test: `apps/server-pilot/tests/nava-fte-hours.test.ts`

**Interfaces:**

```ts
export type NavaHoursMessage = {
  messageId: string;
  threadKey: string;
  direction: 'inbound' | 'outbound';
  timestamp: Date | null;
};

export type NavaHoursStats = {
  asOf: string;
  threadCount: number;
  threadsWithOutbound: number;
  inboundOnlyThreads: number;
  nEligibleFirstResponse: number;
  medianFirstResponseMinutes: number | null;
  p90FirstResponseMinutes: number | null;
  droppedNegativeOrMissing: number;
  caveat: string;
};

export const NAVA_HOURS_CAVEAT =
  'Inbound-only is a retained-outbound gap, not proof of no reply elsewhere.';

export function parseConnectedMailboxDump(markdown: string): NavaHoursMessage[];
export function computeNavaHoursStats(
  messages: readonly NavaHoursMessage[],
  asOf: string,
): NavaHoursStats;
```

Parser rules (match dump renderer):

- Track fenced regions. A line that is exactly ` ```text `, ` ```html `, or ` ``` ` toggles/closes a fence. **Skip every line while inside a fence.** A body containing `- **Received:**` must not become a timestamp.
- Message starts at `/^## Message \d+:/` **outside** fences, typically after `---`.
- Fields only outside fences:
  - `- **Message ID:** \`$id\``
  - `- **Thread ID:** \`$id\`` or `- **Thread ID:** (unthreaded)`
  - `- **Direction:** $dir`
  - `- **Received:** $iso`
  - `- **Sent:** $iso`
  - `- **Created:** $iso`
- Thread key: if Thread ID is `(unthreaded)` then `unthreaded:${messageId}`. Never collapse all unthreaded into one thread.
- Drop direction other than `inbound` / `outbound`.
- Timestamp: inbound prefers Received then Created; outbound prefers Sent then Created. Empty → `timestamp: null`.
- Eligible latency: thread has ≥1 inbound and ≥1 outbound with parseable ts. Value minutes = `(min(outbound) - min(inbound)) / 60000`. Drop negatives (count in `droppedNegativeOrMissing`).
- Median: sort minutes; odd n → middle; even n → mean of two center values.
- p90 nearest-rank: 1-based rank `Math.round(0.9 * n)`, index `clamp(rank - 1, 0, n - 1)`.
- `threadCount` = distinct `threadKey`. `threadsWithOutbound` = keys with ≥1 outbound. `inboundOnlyThreads` = keys with ≥1 inbound and 0 outbound.
- `asOf`: parse `- Snapshot as of: ` from dump header; tests may pass it explicitly.

- [ ] **Step 1: Write failing tests** in `apps/server-pilot/tests/nava-fte-hours.test.ts`.

Include a golden block whose fenced body contains `- **Received:** 2099-01-01T00:00:00.000Z` and header Received `2026-01-02T00:00:00.000Z`. Assert parsed timestamp is 2026, not 2099.

Also: unthreaded two messages → two keys; outbound-first still eligible; missing ts dropped from latency but inbound-only counted; even-n median of `[10, 20, 30, 40]` → `25`; inbound-only thread does not enter eligible n.

- [ ] **Step 2: Run tests (must fail)**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
cd /home/ubuntu/projects/zero
pnpm --filter @zero/server exec vitest run tests/nava-fte-hours.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement parser + stats** in `nava-fte-hours.ts`. Put this diagram in a file comment:

```
 dump lines
   ├─ inFence? skip
   ├─ ## Message N:  start record
   ├─ **Message ID** / **Thread ID** / **Direction** / **Received|Sent|Created**
   └─ compute per threadKey
```

- [ ] **Step 4: CLI** `apps/server-pilot/scripts/nava-fte-hours.ts`:

```ts
const repoRoot = /* directory containing .git, walk up from import.meta.url */;
const reader = createPrivateInputReader({
  repoRoot,
  privateDirectoryName: 'connected-mailbox-corpus',
  allowedExtensions: ['.md'],
});
const writer = createPrivateOutputWriter({
  repoRoot,
  privateDirectoryName: 'connected-mailbox-corpus',
  allowedExtensions: ['.json'],
});
const markdown = await reader.read('connected-mailbox-inbox.md');
const stats = computeNavaHoursStats(parseConnectedMailboxDump(markdown), asOfFromDump);
await writer.write('hours.json', `${JSON.stringify(stats, null, 2)}\n`);
```

Missing dump must throw/exit non-zero (reader already fails). Print **counts only** to stdout (`nEligibleFirstResponse`, medians). Never print subjects, addresses, or bodies.

- [ ] **Step 5: Re-run tests. PASS. Commit.**

---

### Task 2: Dashboard generator (TDD)

**Files:**
- Create: `apps/server-pilot/src/ops/nava-fte-dashboard.ts`
- Create: `apps/server-pilot/scripts/nava-fte-dashboard.ts`
- Test: `apps/server-pilot/tests/nava-fte-dashboard.test.ts`
- Create: `docs/infor-hms/nava-fte-dashboard.json`
- Create: `docs/infor-hms/nava-fte-dashboard.md`

Frozen mix (inbound messages, n=2957):

| class | count | share |
| --- | ---: | ---: |
| stay-human-other | 1069 | 36.2% |
| stay-human-at-risk | 841 | 28.4% |
| stay-human-groups | 446 | 15.1% |
| stay-human-new-bookings | 419 | 14.2% |
| unknown | 99 | 3.3% |
| file-spam | 78 | 2.6% |
| file-ops | 5 | 0.2% |

HITL locks (names only): failure, payment, policy, cancellation-fee, complaint, security, VIP/privacy, documents, low-confidence, SLA/unpaid.

Extra: Luna human-lock **1134 / 2403**. Line: `security quarantine ≠ spam`.

Tools (all live=false, shadow=false):

1. `hms_find_reservation` — confirmation_number 1094 threads
2. `hms_list_documents` — document_delivery 1015
3. `hms_find_reservation` (status) — reservation_status 947
4. `hms_read_folio` — payment_deposit 892
5. `hms_quote_stay` — rate_quote 849; `bookable=false`

Loaded block: 2 mailboxes, 3268 messages, 2403 threads, asOf `2026-08-25T22:24:55.657Z`.

Hours interpolation: read `hours.json` via private reader (`.json`). Put `nEligibleFirstResponse`, median, p90 from the parser. Inbound-only **display** stays the census line `2102 / 2403 (87.5%)` (frozen, spoken script). Also store `hours.inboundOnlyThreads` next to it. If they differ, markdown/TUI shows both numbers and a one-line drift warning. Do **not** hardcode 301 as nEligible. Mix 2957 vs loaded 3268 is two different denominators (inbound vs all messages); caption them, do not silently equate.

- [ ] **Step 1: Failing snapshot test** — `buildDashboard(hours)` mix counts reduce to 2957; JSON matches fixture hours; markdown contains caveat and `live=false`.

- [ ] **Step 2: Run. FAIL.**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/server exec vitest run tests/nava-fte-dashboard.test.ts
```

- [ ] **Step 3: Implement frozen tables + `buildDashboard` + markdown renderer. CLI writes both docs files.**

- [ ] **Step 4: PASS. Commit.**

---

### Task 3: Pure dashboard view (TDD)

**Files:**
- Create: `apps/server-pilot/src/ops/nava-fte-dashboard-view.ts`
- Test: `apps/server-pilot/tests/nava-fte-dashboard-view.test.ts`

Chrome (exact):

```
 Nava                          gemini-3.7-flash · local
 connected mailbox · asOf 2026-08-25 · 2 mailboxes
```

Footer: `↑↓ scroll · Enter start agent · q quit`

Four stacked sections: Loaded (2-column metrics), First-response (3 KPIs + dim caveat), Mix (bar + count + %), HITL + ranked reads (two tables).

- [ ] **Step 1: Tests assert header contains `Nava` and `gemini-3.7-flash`; caveat substring present; mix labels include `stay-human-at-risk`; no `FTE hours saved`; no `£`.**

- [ ] **Step 2: FAIL then implement `renderDashboardSections(dashboard): { header, meta, sections, footer }` as strings (ASCII bars ok, no ANSI required in the pure function).**

- [ ] **Step 3: PASS. Commit.**

---

### Task 4: sitecustomize dump deny (TDD)

**Files:**
- Create: `scripts/nava-sitecustomize-path/sitecustomize.py`
- Test: `apps/server-pilot/tests/nava-sitecustomize.test.ts`

Wrap `io.open`, `pathlib.Path.open`, `Path.read_text`, `Path.read_bytes`. If the resolved path basename is `connected-mailbox-inbox.md` and `NAVA_ALLOW_DUMP` is not `1`, raise `PermissionError`.

If `bash` exists in `__main__` or builtins after import, wrap it the same way.

- [ ] **Step 1: Vitest spawns:**

```bash
NAVA_ALLOW_DUMP=0 PYTHONPATH=scripts/nava-sitecustomize-path python3 -c "from pathlib import Path; Path('connected-mailbox-inbox.md').read_text()"
```

Expected: non-zero, stderr contains `PermissionError`.

Also `python3 -m` equivalent (`python3 -c` is not enough for the `-m` proof). Add:

```bash
NAVA_ALLOW_DUMP=0 PYTHONPATH=scripts/nava-sitecustomize-path python3 -m nava_dump_probe
```

Simplest `-m` proof: `python3 -m site` is wrong. Use:

```bash
python3 -c 'import runpy, sys; sys.path.insert(0, "scripts/nava-sitecustomize-path"); import sitecustomize; ...'
```

Required design proof: create a tiny module `scripts/nava-sitecustomize-path/nava_dump_probe.py` that opens the dump path, run `PYTHONPATH=scripts/nava-sitecustomize-path python3 -m nava_dump_probe`. Because `-m` loads sitecustomize first, the probe must fail.

If `~/.prime/agent/kernel-venv/bin/python` exists, repeat with that interpreter (`PRIME_AGENT_KERNEL_VENV` override if set). If PYTHONPATH is ignored, in-scope fallback: add a project Python skill under `.prime/agent/skills/` that installs sitecustomize behavior, prove with that venv’s `python -m rlm.repl` one-shot. Dump-deny stays **incomplete** until that proof passes. Do not gitignore the home venv.

- [ ] **Step 2: FAIL then implement. PASS. Commit.**

---

### Task 5: TUI + launcher

**Files:**
- Create: `scripts/nava-dashboard-tui.ts`
- Create: `scripts/nava`

TUI:

- Import `TUI`, `Box`, `Text`, `ProcessTerminal` from `@earendil-works/pi-tui` (scripts package `file:` dep).
- Import view helpers via a **relative path** from `scripts/nava-dashboard-tui.ts` to `apps/server-pilot/src/ops/nava-fte-dashboard-view.ts` (tsx + explicit `.ts` extension). Do not add `@zero/server` to `scripts/package.json` unless a one-line relative import fails; prefer relative to avoid a second workspace wiring project.
- Read `docs/infor-hms/nava-fte-dashboard.json` (repo-relative). Never read the dump. Never call Gemini.
- `tui.start()`; `enterFullscreen` if API requires it for scroll.
- Keys: arrows, PgUp/PgDn, j/k, mouse wheel, `q` and `Enter` → resolve quit.
- On quit: `tui.stop()` with **default options** (do **not** pass `preserveAltScreen: true`). Then process exits 0 so the launcher can exec.

Launcher `scripts/nava` (bash, `set -euo pipefail`):

1. `cd` repo root (parent of `scripts/`).
2. If `hours.json` missing **or older than the dump mtime**: run `pnpm exec tsx apps/server-pilot/scripts/nava-fte-hours.ts`. If that fails, exit non-zero.
3. Run dashboard generator.
4. If stdin is not a TTY: `cat docs/infor-hms/nava-fte-dashboard.md` and exit 0.
5. Else run `pnpm exec tsx scripts/nava-dashboard-tui.ts`.
6. Export:

```bash
GEMINI_API_KEY=$(head -n1 "$REPO/.gemini_api_key")
PRIME_AGENT_TELEMETRY=0
PYTHONPATH="$REPO/scripts/nava-sitecustomize-path${PYTHONPATH:+:$PYTHONPATH}"
NAVA_ALLOW_DUMP=0
```

Missing key file: exit non-zero with a short message, no stub agent.

7. `exec "$REPO/external/prime-agent/prime-agent.sh"`

`chmod +x scripts/nava`.

Feel-test (manual, investor path): TUI looks like Cursor session header + dense ops board.

- [ ] **Step 1: Add a launcher smoke test** in `apps/server-pilot/tests/nava-launcher.test.ts`: spawn `scripts/nava` with stdin not a TTY and `hours.json` + dashboard fixtures in a temp layout **or** mock by testing a small exported `shouldUseTty(stdin.isTTY)` helper. Prefer: `NAVA_SKIP_PRIME=1` env for tests so exec is skipped. Add that env: if set, launcher stops after TUI/markdown.

- [ ] **Step 2: Implement. Verify:**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --filter @zero/server exec vitest run tests/nava-fte-hours.test.ts tests/nava-fte-dashboard.test.ts tests/nava-fte-dashboard-view.test.ts tests/nava-sitecustomize.test.ts tests/nava-launcher.test.ts
```

- [ ] **Step 3: Commit.**

---

### Task 6: Prime project settings + skill

**Files:**
- Create: `.prime/agent/settings.json`
- Create: `.prime/agent/skills/nava-fte/SKILL.md`

`settings.json` exact:

```json
{
  "quietStartup": true,
  "defaultProvider": "google",
  "defaultModel": "gemini-3.7-flash",
  "defaultThinkingLevel": "off",
  "retry": { "enabled": false, "maxRetries": 0 },
  "telemetry": { "enabled": false },
  "bundledSkills": { "websearch": false },
  "terminal": { "fullscreen": true }
}
```

Skill: Q&A over **only**:

- `.private/connected-mailbox-corpus/hours.json`
- `docs/infor-hms/nava-fte-dashboard.json`
- `docs/infor-hms/nava-fte-dashboard.md`
- `docs/infor-hms/connected-mailbox-corpus-analysis-2026-08-25.md`
- `docs/infor-hms/centurion-kpi-catalog-2026-08-24.md`

Refuse revenue/£/ADR invention. Refuse reading `connected-mailbox-inbox.md`. Say we will not send mail on this call.

- [ ] **Step 1: Add a JSON parse test** that reads `.prime/agent/settings.json` and asserts `retry.enabled === false` and `defaultProvider === 'google'`.

- [ ] **Step 2: Commit.**

---

### Task 7: gitignore + Orca name-gate probe

**Files:**
- Modify: `.gitignore`

If Task 0 already added `.gemini_api_key` and session/log ignores, skip. Do not add a repo `.prime/agent/kernel-venv/` ignore as a substitute for the home venv path.

Keep `.prime/agent/settings.json` and `.prime/agent/skills/` tracked.

Project settings **override** global via `deepMergeSettings(global, project)` (project last). After Prime smoke, confirm `retry.enabled` is false with project file present (do not assume `~/.prime/agent/settings.json` wins).

Orca probe (operator, true blocker if missing):

- Open ADE agent settings.
- If a custom TUI / custom command field exists: display name `Nava`, command `scripts/nava`, cwd Zero root.
- `agentDefaultArgs` is a closed codec list (`hermes`, `cursor`, …) with extra flags like `--yolo`. **Do not** hijack those keys.
- If no custom-TUI field: stop, write `docs/superpowers/plans/handoff-reports/2026-08-27-nava-fte-overlay.md` stating name-gate blocked. Overlay code can still be done.

- [ ] **Step 1: gitignore + commit.**
- [ ] **Step 2: Probe ADE. Record result in the handoff report. Do not invent a Prime-named button.**

---

### Task 8: Live hours once (not Vitest)

Only after Task 1+2. Dump path: `.private/connected-mailbox-corpus/connected-mailbox-inbox.md`.

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec tsx apps/server-pilot/scripts/nava-fte-hours.ts
pnpm exec tsx apps/server-pilot/scripts/nava-fte-dashboard.ts
```

Stdout: counts only. If dump missing: exit non-zero (blocker for live demo, not for unit tests).

Regenerate committed dashboard JSON/md from live `hours.json`. Diff should change hours KPIs only if parser nEligible ≠ placeholder.

---

## Test coverage diagram

```
CODE PATHS                                              USER FLOWS
[+] nava-fte-hours.parse                                [+] Investor TTY
  ├── [★★★] fence spoof Received skipped                  ├── [→E2E] scripts/nava TTY → TUI → q → prime
  ├── [★★★] unthreaded:<messageId>                        └── [★★] NAVA_SKIP_PRIME launcher
  ├── [★★★] inbound-only excluded from eligible
  ├── [★★★] negative latency dropped
  └── [★★★] even-n median
[+] nava-fte-dashboard                                  [+] CI / pipe
  ├── [★★★] mix sums 2957                                  └── [★★★] not-a-TTY prints markdown
  ├── [★★★] nEligible from hours.json
  └── [★★★] live=false on tools
[+] sitecustomize                                       [+] Error states
  ├── [★★★] Path.read_text deny                            ├── [★★★] missing dump → non-zero
  ├── [★★★] python -m probe deny                           ├── [★★★] missing gemini key → non-zero
  └── [★★] kernel venv if present                          └── [★] Orca field missing → blocker report
[+] TUI.stop then exec
  └── [★★] stop() without preserveAltScreen

COVERAGE target: all parser branches ★★★ before live dump run
LLM: no eval (TUI has no model). Skill is documentation not a prompt eval.
```

## Failure modes

| Path | Failure | Test | Handling | User sees |
|------|---------|------|----------|-----------|
| Hours CLI | Dump missing | launcher / reader throw | exit non-zero | error, no stub board |
| Parser | Body spoofs Received | ★★★ spoof fixture | skip fences | honest timestamps |
| TUI → Prime | leftover alt-screen | stop() contract | leave alt-screen | Prime boots |
| Kernel | dump open | sitecustomize | PermissionError | model cannot cat dump via pathlib |
| Host bash | `!cat dump` | none (residual) | none | still possible; do not claim sandbox |
| Gemini | 429 | retry.enabled false | fail closed | error, no retry storm |
| Orca | no custom TUI | probe | blocker | no Prime-named button |

**Critical gap if skipped:** TUI `preserveAltScreen` + exec (in-process token dies). Plan forbids that.

## Performance

- Parse dump **line-by-line**. Do not keep full message bodies.
- TUI reads JSON only (~few KB). Never 45MB.
- If `hours.json` exists **and** is newer than the dump file mtime, launcher skips parser. If dump is newer or `hours.json` is unreadable, re-run parser. Never silently show stale KPIs after a dump refresh.

## Worktree parallelization

| Step | Modules | Depends on |
|------|---------|------------|
| Task 0 Prime install | `external/prime-agent`, `scripts/` | — |
| Task 1 hours | `apps/server-pilot/src/ops`, tests | — |
| Task 2 dashboard | ops + docs | Task 1 types |
| Task 3 view | ops | Task 2 types |
| Task 4 sitecustomize | `scripts/nava-sitecustomize-path` | — |
| Task 5 TUI+launcher | `scripts/` | 0, 3, 4 |
| Task 6 settings | `.prime/agent` | — |
| Task 7 gitignore/Orca | `.gitignore` | 5 |

Lane A: Task 1 → 2 → 3. Lane B: Task 4. Lane C: Task 6. Then Task 0 if not done. Then Task 5 (needs 0+3+4). Then 7–8.

Conflict: `scripts/package.json` (Task 0 and 5). Sequential on that file.

## Implementation Tasks (eng-review)

- [ ] **T1 (P1, human: ~1h / CC: ~20min)** — Prime — npm install submodule + file: `@earendil-works/pi-tui`
  - Surfaced by: Architecture — missing `node_modules/.bin/tsx`; package name not `prime-agent-tui`
  - Files: `external/prime-agent`, `scripts/package.json`
  - Verify: `test -x external/prime-agent/node_modules/.bin/tsx`
- [ ] **T2 (P1, human: ~20min / CC: ~10min)** — Launcher — `TUI.stop()` without preserveAltScreen then exec
  - Surfaced by: Architecture — `pendingAltScreenHandoff` is process-local
  - Files: `scripts/nava-dashboard-tui.ts`, `scripts/nava`
  - Verify: quit returns to cooked TTY before Prime chrome
- [ ] **T3 (P1, human: ~20min / CC: ~10min)** — Orca — probe custom-TUI; block if missing
  - Surfaced by: Architecture — `agentDefaultArgs` is a closed codec list
  - Files: handoff report only
  - Verify: start control label is Nava or blocker recorded
- [ ] **T4 (P2, human: ~30min / CC: ~15min)** — View — pure render function so TUI tests do not need a TTY
  - Surfaced by: Code quality — DRY TUI vs markdown
  - Files: `nava-fte-dashboard-view.ts`
  - Verify: vitest asserts Nava header + caveat
- [ ] **T5 (P1, human: ~45min / CC: ~20min)** — sitecustomize — prove with `python -m`, kernel venv if present
  - Surfaced by: Design reviewer concern 2
  - Files: `sitecustomize.py`, tests
  - Verify: PermissionError on dump basename

_No new tasks from Performance beyond line-by-line parse (in Task 1)._

## Review auto-decisions log

Founder: skip remaining AUQ; take recommended.

- Scope: full overlay (1A)
- TUI wiring: file: dep (2A)
- Orca: probe/block (3A)
- Exec: stop then exec (4A)
- Code quality: pure view model; private-output reader; no duplicate dump grammar in TUI
- Tests: all parser/dashboard/sitecustomize gaps in plan
- Performance: line-by-line parse; JSON-only TUI
- TODOs.md: none (file absent; host-bash residual stays out of scope)

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | skipped | office-hours design already approved |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | pending | outside voice after plan write |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 4 arch issues folded (1A/2A/3A/4A); tests diagram in plan |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | skipped | TUI chrome specified in design amendment |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | skipped | local `scripts/nava` only |

- **CODEX:** skipped (`codex_reviews` enabled but CLI not authenticated). Claude subagent outside voice ran.
- **CROSS-MODEL:** Outside voice agreed TUI/exec/Orca issues; added Prime `dist` build, Node-fs dump hole, stale hours.json, TUI import wiring, home kernel venv path. Did **not** accept “skip TUI / print markdown” (founder 1A).
- **VERDICT:** ENG CLEARED — recommended options plus outside-voice correctness patches folded. Name-gate remains a runtime probe.
NO UNRESOLVED DECISIONS
