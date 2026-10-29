# Pomerado controlled-work estimate critique

2026-10-27, ask 332. Source and retro review only. No test, browser, HMS, implementation or model trial. Zero worktree `92be0e5d2`, `origin/main` `3a5b3f315`; Pomerado `7349a1c2`.

## Verdict

Withdraw the prior 36-minute controlled-work and ~90-minute total forecasts: the underlying inputs were judgments, not timings of this work. The 0.85 coding median covers other tasks and cannot turn an unsupported 42-minute input into a demonstrated duration. A tenfold reduction is a useful target but is neither demonstrated nor ruled out. No successful hybrid login, publish and replay has been measured, so no new successful completion ETA is claimed.

## Evidence and faster design

| Item | Evidence | Faster opportunity and remaining unknown |
|---|---|---|
| Login | `apps/server-pilot/tooling/playwright-quote/session-reuse.mjs:89-102,162-183` already logs in and checks hotel identity. `typescript/src/execution/playwright-worker.ts:223-267` runs host-provided code on Pomerado's page. | Reuse the existing helper. The separate worker and private secret-delivery handoff remain untested on EC2. |
| First mint | Pomerado `typescript/src/standalone/mint-host.ts:234-238` enters a page before `runMint`. `typescript/src/execution/playwright-execute.ts:408-415` already serializes dispatches. | Try a tiny isolated host change plus a scoped stop, not a new login or protocol by default. A stop must cover every actual live route and queued dispatch; a timing claim or prompt alone does not establish this. |
| Separate fresh replay | Pomerado `typescript/src/standalone/run-operation.ts:61-73,89-95` starts the page before the actual artifact runs. | Prepare the same login hook and its check while mint runs in a frozen, separate build. The actual fresh run still requires an artifact, source review and the real lock. |
| Stop vs publish | Pomerado `typescript/src/standalone/mcp-jobs.ts:430-438` interrupts the mint; `typescript/src/standalone/mcp-package.ts:68-74` removes an unpublished integration. `typescript/src/standalone/mint-host.ts:183-188` exposes separate execution, live-test and publication paths. | Stopping browser work is not necessarily cancelling the mint. The smallest effective latch and completed publication remain unverified. A hard cancel or manual after-the-fact monitor is not proof of both stop and replay. |
| Tests | The previous plan named three new test files and extensive scenario coverage. | One focused seam file or existing tests can cover the actual auth, stop and fresh-run contract. Run mint-critical checks before mint and replay checks while the mint runs. Do not drop security-sensitive behavior or claim mocked tests are live proof. |

Pomerado also calls `context.observe` after live script execution and before creating its receipt (`typescript/src/standalone/mint-execution.ts:632-668`). The final screen capture and the stop must account for that extra browser read; do not claim an immediate stop if an additional observation happens after the accepted complete read.

Before dispatch, review proposed actions against read-only and the requested screen-only scope. A stop after a result cannot undo an action bundled inside that result or asynchronous work; fail closed if the scope cannot be established. Maintain Guardian, approved private data handling, actual HRCEN lock and cleanup. Do not add an OS sandbox proof gate that the owner previously removed.

## What prior attempts actually show

- The owner reported manual HRCEN login under 10 seconds. The prior native Pomerado login-first run reached an incomplete result in 20m29s and verified cleanup in 24m44s from authorization; it is not a successful-mint benchmark. See `docs/context/ledger/2026-10-27-pomerado-login-first-retro.md`.
- Prior coordination errors included running on the wrong machine, cancelling a valid mint too early, and inventing extra pre-mint proof gates. These were our mistakes, not reasons to add another framework. See `docs/context/ledger/2026-10-27-pomerado-trial-retro.md`.
- A small unrelated product PR merged in 10 minutes, while its live proof took longer (`docs/context/MISTAKES.md`). This supports the possibility of rapid small changes but does not measure the Pomerado patch.

## Missing evidence

The actual patch size, worker compatibility, coverage of the smallest stop, secret handling, native publication and cold replay are unknown. The narrowest path is a hypothesis to test on the authorized run, not a proven guaranteed duration. Original selected-screenshot and three-case proof remains outstanding.
