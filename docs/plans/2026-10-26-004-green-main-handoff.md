# Green main — handoff (2026-10-26, owner ask 234)

**Goal: main passes its own tests, so lanes never again need a "known failures" list.** The baseline file (`/tmp/or2/baseline-failures.md`) was a workaround. It cost ~60 min of critical path on or2 and blocked H1 today.

## 1. Failing on main (measured)
| Suite | App | Fails | Evidence |
|---|---|---:|---|
| outlook-pane-stale-pdf-admission, outlook-pane-step-runner + 3 other outlook-pane files | mail | 22 / 151 | baseline 02:2xZ |
| quote-workflow-luna-render, stay-room-builder, nava-pane-render, mail-nava-panel | mail | 23 / 152; nava-pane-render 10 / 92 | 04:32Z, 06:41Z |
| work-items.test.ts (DB) | server-pilot | 3 / 146 | 11:53Z on `2c5eb27fa`, `/tmp/or2/base-workitems-1150.log` |
| vite.config.ts(69,3) TS2769, intermittent | mail typecheck | 1 diag | 07:35Z; root `@types/node` 24.3.0 vs mail 22.13.8 → two vite type copies |

## 2. Why they stayed red
Each failure appeared after a deliberate product change (pane redesign, provenance `stampRoute`) whose PR updated the product but not every old assertion. Lanes were told "not yours, ignore" so nobody owned them.

## 3. Units (4 lanes, all parallel, no deps)
| Unit | Coder | Owns | Done when |
|---|---|---|---|
| GREEN-PANE-A | Grok 4.6 high (Cursor) | outlook-pane-* tests | 0 failed in those files on remote |
| GREEN-PANE-B | Grok 4.6 high (Cursor) | nava-pane-render, quote-workflow-luna-render, stay-room-builder, mail-nava-panel, quote-workflow-panel | 0 failed |
| GREEN-WORKITEMS | Luna max | work-items.test.ts | 0 failed with disposable DB |
| GREEN-VITE | Luna max | apps/mail/package.json, pnpm-lock.yaml | 2 remote mail typechecks on the same SHA, 0 TS2769 |
Rule for each failing test: deliberate change → update the test (cite the commit); regression → fix product; flaky → make deterministic; unsure → leave failing and report. Never skip/delete tests.
Briefs: `/tmp/or2/briefs/GREEN-*.txt` + `/tmp/or2/lane-protocol.md`.

## 4. Model choice
Gemini 4 Argon High via `agy` was requested. Probe at 12:08Z: `RESOURCE_EXHAUSTED 429, individual quota reached, resets in 146h`. Fallback: Grok 4.6 high via Cursor for the two pane lanes (largest, most judgement), Luna max for the two narrow ones.

## 5. After merge
Delete the baseline file's rows for fixed suites. Next: a nightly remote run of these suites on main that opens a GREEN unit when anything turns red (part of `gate.sh`).
