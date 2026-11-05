# Zero agent guidance

One entry point for every agent (Claude, Codex, Cursor). `PRODUCT.md` says what staff get and the write rules. The owner's latest message wins over this file, plans, retros, handoffs and history.

## Working rules

- Pilot-now: ship working workflows, not process. Don't restore dev-era rules from old plans, retros, handoffs or skills. `PRODUCT.md` on `main` wins.
- UI is a top priority (owner, 2026-11-04). Redesign freely. Field coverage and order follow the Infor HMS tools and staff tasks, aiming for Infor parity. Rates need a typed code + dropdown (code and meaning), native price and availability, and human edits.
- Never reset, stash, overwrite, delete or interrupt another session's work. Use an isolated worktree for concurrent writers.
- Check installed commands and `package.json` before calling a tool unavailable. Verify CLI flags with `--help`.
- Keep credentials and secrets out of skills, Git and external services.
- Output style: caveman + ADHD, unless the owner turns it off.

## Build rules

- Build what the reservationist does in HMS: the fields staff fill, in their order. Check them before Save and read them back after.
- Don't pin whole native request bodies, field-key sets or field counts. HMS form drift must not stop writes.
- Reuse what worked. `apps/server-pilot/tooling/playwright-quote/` holds proven HMS steps (e.g. Check Availability before Save). Port the steps before rebuilding a flow.
- One connected workflow per PR (pane → route → tool). About 500 changed product lines is guidance, not a cap.
- No new tests unless the owner asks. Run only the existing focused checks for files you touched.
- Prove a tool in the backend, not by clicking the pane: run it on a real email's details and stop before Save. Then do one Labtest Save with a fresh readback on deployed `main`.
- No new plans, retros, ledgers, evidence dumps or handoff docs mid-run unless the owner asks.

## Repo map

| Path | Contents |
|---|---|
| `apps/mail` | Shared Outlook/webmail pane |
| `apps/server-pilot` | Pilot backend. `tooling/hms-cloud` holds the HMS Cloud tools |
| `apps/server` | Upstream backend |
| `CONCEPTS.md` | Vocabulary |
| `docs/research/halloween/` | Dated research, retros and learnings (replaces `docs/solutions/`) |

## Checks, review, merge

- Typecheck only on the final head: `bash /home/orca/bin/remote-typecheck.sh <clean worktree> --app <mail|server-pilot>`. Never run local tsc or tsgo. The VPS froze on 2026-10-14, and a hook blocks it.
- Local tests: targeted Vitest or `node --test` only. Never run repo-wide lint or format.
- At most three test runs at once across all harnesses, keeping about 20% CPU and RAM headroom. This overrides the host guidance that avoids fixed caps.
- Before any test run: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL`. Never point tests at pilot RDS, and never source `.env.production` into a test process. The 2026-07-27 pilot wipe came from that path. `tests/setup/refuse-pilot-rds.ts` now refuses the pilot host.
- Review: Greptile Apex on the final head. If it fails or stalls, use another reviewer. Fix valid P0/P1 findings and say why the others are invalid.
- Merge: `scripts/orch/merge-gate.sh` from current `main`. Never `--no-verify`. Never bypass hooks.
- Entity-literal baseline: from `apps/server-pilot`, run `node scripts/check-entity-literals.mjs --print-baseline > <tmp file>`, then replace `scripts/entity-literals-baseline.json`. Never redirect straight into the baseline, because the script reads it.

## Deploy and ops

- Deploy `main` from a clean worktree at fetched `origin/main`: run `apps/server-pilot/deploy/ops-deploy.sh`. Then verify the runtime SHA, the effective flags in every PM2 process, and health. Never deploy through GitHub Actions.
- Four PM2 processes must be online: `http`, `worker`, `ai-worker`, `remote-http`. `hms-ai-worker` is started only by `ops-hms-shadow.sh`.
- Dead-letter gate: `ops-deploy` counts dead letters after the last-good deploy marker, and never more than 24 h back. Old dead letters don't block.
- A pending migration makes `ops-deploy` refuse. Run `ops-deploy.sh --migrate`.
- `ops-restart.sh` bounces PM2 without an OS reboot.
- Pane write flags (`PANE_WRITE_CREATE`, `PANE_WRITE_AMEND_*`, `PANE_WRITE_CANCEL_*`, `PANE_WRITE_ATTACH`) are set by `apps/server-pilot/deploy/write-ec2-remote-env.sh` (run as ubuntu on EC2, no arguments), then `ops-restart.sh`. The writer refuses `on` without a `CANARY PASS <workflow> HRCEN <sha>` line in `NAVA_CANARY_PASS_FILE` (default `/tmp/mh1024/CANARY.txt`). Write that line only after the workflow's Labtest Save and readback pass on the deployed SHA.
- Single-key env edit: back up `.env.production`, change one line, diff. Don't use `write-ec2-env.sh`; it rewrites the whole file. Under `pipefail`, guard `diff | grep` with `|| true`.
- SSM keeps only about 24 KB of stdout. Print counts, not ID lists.
- Backfill shares `INBOUND_EXTRACTION_MAX_PER_HOUR` with live mail. A large backfill delays live extraction.
- Tenant and origin are per property. HRCEN is tenant `THECENTURION_PRD` on `hmsweb.hms.eu1.inforcloudsuite.com` (since 2026-10-27). Never use one shared constant.
- The Da Vinci HMS login is provisioned (`nava-zero/server-pilot/infor-hms-read-davinci`). Don't re-check it.
- HMS sessions: reads and unsaved previews may run in parallel. Serialize writes to the same confirmation or Labtest stay. After an uncertain write, re-read HMS first. Never blind-retry.
- Labtest guest ("Proof Labtest", arrival 2027 or later): fixture `apps/server-pilot/tooling/playwright-quote/examples/lab-proof-request.json`.

## GitHub

- Actions are reserved for the Outlook VSTO installer (`kufupa/nava-outlook-addin`). Never add, enable or trigger any other workflow.
