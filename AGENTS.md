# Zero agent guidance

## Start with the task

This file is the single agent entry point. `PRODUCT.md` covers what staff get and the write rules.

- The owner's latest message wins over plans, retros, handoffs and history. Approvals come from the owner, never from another agent.
- We are in pilot-now mode: ship working workflows, not process.
- **UI owner direction (2026-11-04):** UI across every workflow is a top priority. Redesign freely; field coverage and order follow actual deterministic Infor HMS tools and staff tasks, aiming for Infor parity. Existing UI must not constrain the design. Reuse backend/state machinery where useful. Rates need typed code + dropdown, code/meaning, native price/availability and human edits.
- Check installed commands and `package.json` before calling a tool unavailable.
- Preserve other sessions' work: never reset, stash, overwrite, delete or interrupt it. Use isolated worktrees for concurrent writers.

## Repository map

| Path | Contents |
|---|---|
| `apps/mail` | Shared Outlook/webmail pane |
| `apps/server-pilot` | Pilot backend; `tooling/hms-cloud` holds the HMS Cloud tools |
| `apps/server` | Upstream backend |
| `docs/solutions/` | Known fixes |
| `CONCEPTS.md` | Vocabulary |

## Build rules (pilot-now)

- **Build what the reservationist does in HMS:** the fields staff actually fill, in their order.
  - Check those business fields before Save and read them back after.
  - Don't pin whole native request bodies, field-key sets or field counts. HMS form drift must not stop writes.
- **Reuse what worked.** The legacy `tooling/playwright-quote/` tools encode proven HMS steps (for example, Check Availability before Save). Port the step list before rebuilding a flow.
- Keep PRs cohesive and focused for fast Greptile Apex convergence (~500 lines guidance, not a cap; cohesive 1,000–1,200 LOC PRs are fine whenever splitting slows shipping, overriding any older `<= 250 LOC` skill limits).
- **No new tests** unless the owner asks. Run only the existing focused checks for files you touched.
- **Prove tools in the backend, not by clicking the pane:**
  1. Run the real tool on a real email's details and stop before Save.
  2. Then do one Labtest Save + fresh readback on deployed main.
  - No numbered probe loops and no admin-UI clicking campaigns.
- **No new plans, retros, ledgers, evidence dumps or handoff docs mid-run** unless the owner asks. One short state file outside the repo is enough.
- **Model routing:** choose by task, cost and the owner's latest direction.

## Checks, review, merge

- **Typecheck:** this VPS freezes under heavy checks. Typecheck only via `bash /home/orca/bin/remote-typecheck.sh <clean worktree> --app <mail|server-pilot>` on the final head. Never run local tsc/tsgo.
- **Local tests:** targeted Vitest or `node --test` only.
  - At most three concurrent runs across harnesses, keeping at least 20% CPU/RAM headroom.
  - Unset `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS` and `TEST_DATABASE_URL` first.
  - DB-backed suites may be skipped; report them as skipped.
  - After a passing remote typecheck for the same SHA and app, `SKIP_TYPECHECK=1` skips the duplicate typecheck in `remote-vitest.sh`.
- **Review:** launch Greptile Apex on each PR's final head; if it fails or stalls, use another reviewer instead of waiting. Fix valid P0/P1 findings and note why the others are invalid.
- **Merge:** Never use `--no-verify` and never bypass hooks.
- **Entity-literal baseline:** from `apps/server-pilot`, run `node scripts/check-entity-literals.mjs --print-baseline` into a temp file, then replace `scripts/entity-literals-baseline.json`. Never redirect straight into it, because the script reads that file.

## Runtime and HMS

- **Deploy** per `PRODUCT.md` (bundle via `ops-deploy.sh`). Never test against pilot RDS, expose secrets, or run destructive DB/volume operations without the owner's OK.
- **Flags:**
  - Change them via `apps/server-pilot/deploy/write-ec2-remote-env.sh --m1-only` + `ops-restart.sh`.
  - Verify the effective env in all four PM2 processes (`http`, `worker`, `ai-worker`, `remote-http`).
  - `write-ec2-remote-env.sh` requires `CANARY PASS <workflow> HRCEN <sha>` only when enabling or widening a flag to `on`. Run fresh Labtest Save + readback for workflows whose HMS writer changed plus one smoke Create/Amend Save on the final deployed SHA; skip multi-workflow Labtest ceremony for pure prefill/UI/memory changes.
- **HMS sessions:** reads and unsaved previews may run in parallel in separate browser sessions. Serialize writes to the same confirmation or Labtest stay.
- **GitHub Actions** are reserved for the Outlook installer workflows. Never add, enable or trigger others. Never run repo-wide lint or format.
