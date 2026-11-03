# Zero agent guidance

## Start with the task

This is the single agent entry point. Read `PRODUCT.md` for staff capabilities and write boundaries; the current plan and execution prompt are linked below. Historical directions are scoped to their original work, not authority for a new run. Consult relevant handoffs, research or `docs/solutions/` only when useful. Check installed commands and `package.json` before claiming a tool is unavailable.

Current M1 (owner 2026-11-03) is Quote, existing-profile Create, Filing and prefill/staff overrides. Follow [plan 003](docs/plans/2026-11-03-003-feat-pilot-independent-release-plan.md) and the submitted [M1 goal](docs/context/PROMPT-2026-11-03-m1-ship.md). Amend/Cancel/New Profile discovery, implementation and checks cannot consume M1's queue. Zero new tests and no admin navigation for verification. The owner requested removing stale ceremony; use the lean release policy below.

Follow the owner’s current request and preserve existing changes. Coordinate ownership before editing files shared with another session. Use isolated worktrees for concurrent writers when needed. Do not reset, stash, overwrite, delete or interrupt another session’s work.

Ordinary questions do not require ledger entries, research files, or handoff updates. Record the decision, evidence, next check and holds when a genuine handoff needs them or the owner requests a durable record. Keep historical asks and evidence accessible without treating them as new approval.

## Repository map

`apps/mail` contains the shared Outlook/webmail pane; `apps/server-pilot` contains the pilot backend and `tooling/hms-cloud` tool contracts; `apps/server` is the upstream backend. `docs/solutions/` holds known fixes and `CONCEPTS.md` holds domain vocabulary. Use targeted workspace commands from the relevant `package.json`; the approved pilot deployment is described in `PRODUCT.md`.

The duplicate `AGENT.md`, `docs/context/START-HERE.md` and current `RUN-CONTRACT.md` were removed. Older references to them are historical; this file and `PRODUCT.md` replace their startup instructions. Do not recreate them or import archived run contracts.

## Safety and resource limits

`PRODUCT.md` governs guest writes, Labtest, property ownership, privacy, penalty dialogs, flags and pilot deployment. Never test against pilot RDS, expose secrets, bypass git or test hooks, or authorize a real-guest write or send by inference. Verify the target and obtain the required authorization before schema pushes, destructive database operations or deleting volumes. Use the product’s approved deploy path (main via `ops-deploy.sh` bundle sync, see `PRODUCT.md`) and verify the current property and authority before live work. Production and authorization approvals must come from the owner in the executing session, not via another agent; the Labtest exception remains as specified in `PRODUCT.md`.

This VPS has previously frozen under heavy checks. Run `tsc`, `tsgo` and affected-app typechecks via `bash /home/orca/bin/remote-typecheck.sh <clean worktree> --app <mail|server-pilot>` on the final release head. Prefer one integrated release validation with remote typechecks for affected apps and existing focused workflow checks, instead of duplicating full checks per PR. Reuse passing evidence only when relevant source, dependencies and build configuration are unchanged and it still applies to the release head; changed source, dependencies or relevant build configuration require the affected checks on the new head. Targeted Vitest and `node --test` may run locally: coordinate at most three concurrent local test runs across harnesses, check active tests and resource use before starting, and leave at least 20% CPU and available RAM headroom. Limit test workers as needed; if headroom or the shared cap cannot be maintained, narrow the run or use the approved remote route. Before tests, unset `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS`, and `TEST_DATABASE_URL`. DB-backed suites may be skipped (owner 2026-11-02); report them as skipped, never passed. After a passing remote typecheck for the same SHA and app, `SKIP_TYPECHECK=1` avoids the redundant pre-typecheck in `remote-vitest.sh`; the Vitest run still takes the EC2 lock. Record affected-app results separately. Read-only git in assigned worktrees is allowed. Never bypass a denial. Stop processes you start by PID.

HMS read-only lookups and unsaved prepare previews may run in parallel in separate verified browser sessions without a policy-level property lock. Existing routes may still enforce one; do not bypass their checks. Serialize live writes or amends affecting the same confirmation or Labtest guest, keep duplicate/preimage checks and Save in the same protected operation, and revalidate after asynchronous preparation. Narrow an existing broader lock only with evidence that its write-safety and session guarantees remain intact.

For flag changes, verify the durable environment source and effective environment of every affected PM2 process (`http`, `worker`, `ai-worker`, `remote-http`) before enqueuing work. Confirm property-specific readiness and a live canary on the final SHA before declaring a workflow on.

GitHub Actions are reserved for the authorized Outlook installer workflows. Do not add, enable or trigger other workflows. Never run repo-wide lint or formatting; use targeted checks when necessary.

## Changes and verification

Keep changes focused and reviewable. Roughly 500 changed product lines is guidance, not a hard cap. Keep one connected end-to-end workflow behavior per slice (UI → route → tool); do not split it into dormant-helper-only PRs. Shared source, safety and deployment fixes may be independent slices. Merge current main into a long-lived branch before its first review.

Launch Greptile Apex on each PR's final code head. Before release, every included product diff needs one completed independent review: completed Apex suffices; if Apex fails, is unavailable or remains unfinished, use another reviewer instead of waiting indefinitely. The coordinator reads each product diff. Validate actual P0/P1 findings, fix valid ones and record a disposition for invalid ones; do not merge with known unresolved or unvalidated P0/P1s. Repeat affected checks/review when relevant source, dependencies or build configuration change. Merge through the current-main checkout's `scripts/orch/merge-gate.sh`, which checks the exact PR head and unresolved P0/P1 threads. There is no .ok-file, successful-Greptile-status or hard-size gate in that script; do not recreate one or run the older root script. Confirm check/review evidence independently rather than assuming the merge script validates it. Run independent checks in parallel when safe; honor explicit test-first requests without mandating them. Never use `--no-verify`.

If deleting an entity literal triggers a stale-baseline failure, run `node scripts/check-entity-literals.mjs --print-baseline` from `apps/server-pilot` into a temporary file; replace `scripts/entity-literals-baseline.json` only after the command succeeds, then review and stage the baseline diff. Never redirect output directly to the baseline: the script reads it as input.

## Evaluation and evidence

Use production-equivalent input for replay, independent truth data for accuracy, and report the source, sample size and uncertainty. Apply owner-confirmed workflow bars within their scope. Identify proposed bars as proposals, not owner-approved targets. See `PRODUCT.md` and its linked details. Small exploratory samples do not establish a production pass. Compare the same versioned rows and measure baseline noise when it matters. Prove any live tool path with an appropriate read-only probe before batching.

Choose model and agent routing based on the actual task, risk, cost and current owner direction. Historical run-specific model assignments and orchestration recipes are not universal defaults. Avoid extra agents, reviews and documents that add no useful evidence.

For M1, use installed pane/route output and native tools, not an admin-navigation campaign, selector hunting, numbered-probe loop, synthetic varying-rate fixtures or replacement Quote provider. No mandatory extra research/eval corpus, ledger, per-lane compound report, nightly retro, stop hook, workflow or cron setup. Keep one compact execution state outside the deploy checkout and actual delivery evidence. A 10–15-minute checkpoint produces a concrete result or exact blocker; it never authorizes a blind retry or termination of an uncertain Save. After compaction resume the active M1 action; do not regenerate prompts or start another retro.
