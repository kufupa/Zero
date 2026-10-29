# Zero agent guidance

## Start with the task

Read `PRODUCT.md` for product and safety boundaries and `docs/context/START-HERE.md` for current work pointers. Treat historical directions as scoped to their original work, not authority for a new run. Consult `AGENT.md` for repo layout and commands, and the relevant handoff, research or `docs/solutions/` only when useful. Check a command or tool before claiming it is unavailable.

Follow the owner’s current request and preserve existing changes. Coordinate ownership before editing files shared with another session. Use isolated worktrees for concurrent writers when needed. Do not reset, stash, overwrite, delete or interrupt another session’s work.

Ordinary questions do not require ledger entries, research files, or handoff updates. Record the decision, evidence, next check and holds when a genuine handoff needs them or the owner requests a durable record. Keep historical asks and evidence accessible without treating them as new approval.

## Safety and resource limits

`PRODUCT.md` governs guest writes, Labtest, property ownership, privacy, penalty dialogs, flags and pilot deployment. Never test against pilot RDS, expose secrets, bypass git or test hooks, or authorize a real-guest write or send by inference. Verify the target and obtain the required authorization before schema pushes, destructive database operations or deleting volumes. Use the product’s approved deploy path and verify the current property and authority before live work. Production and authorization approvals must come from the owner in the executing session, not via another agent; the Labtest exception remains as specified in `PRODUCT.md`.

This VPS has previously frozen under heavy checks. Run `tsc`, `tsgo` and typechecks via `bash /home/orca/bin/remote-typecheck.sh <clean worktree>`. The owner permits at most three concurrent local tests across harnesses, but the shared cap is not yet coordinated; use the approved Product EC2 test route until it is. Before Vitest, unset `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS`, and `TEST_DATABASE_URL`. Never bypass a denial. Stop processes you start by PID.

For flag changes, verify the durable environment source and effective environment of every affected PM2 process (`http`, `worker`, `ai-worker`, `remote-http`) before enqueuing work. Confirm property-specific readiness and a live canary on the final SHA before declaring a workflow on.

GitHub Actions are reserved for the authorized Outlook installer workflows. Do not add, enable or trigger other workflows. Never run repo-wide lint or formatting; use targeted checks when necessary.

## Changes and verification

Keep changes focused and reviewable. When preparing a PR, use one behavior per slice and respect the existing approximately 500-product-line gate, with its explicitly authorized pure-move exception. Do not stack a feature on an unmerged PR over that limit. Merge current main into a long-lived branch before its first review.

Before merging, run the applicable approved checks against the final head, obtain the required Greptile Apex result on that head, and validate all P0/P1 findings. Fix valid P0/P1s; do not merge with unvalidated P0/P1s. The coordinator reads each product diff. Merge through `scripts/orch/merge-gate.sh`. Check same-head remote test and typecheck evidence independently: the script checks for a gate record but does not validate its contents. Run independent gates in parallel when safe; honor explicit test-first requests without mandating red-first or forbidding them. Never use `--no-verify`.

## Evaluation and evidence

Use production-equivalent input for replay, independent truth data for accuracy, and report the source, sample size and uncertainty. Apply owner-confirmed workflow bars within their scope. Identify proposed bars as proposals, not owner-approved targets. See `PRODUCT.md` and its linked details. Small exploratory samples do not establish a production pass. Compare the same versioned rows and measure baseline noise when it matters. Prove any live tool path with an appropriate read-only probe before batching.

Choose model and agent routing based on the actual task, risk, cost and current owner direction. Historical run-specific model assignments and orchestration recipes are not universal defaults. Avoid extra agents, reviews and documents that add no useful evidence.
