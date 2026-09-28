# Centurion read-tools 2h close — soft-open payload burns

Date: 2026-09-15  
Branch: `feat/centurion-dashboard-tools`  
Parent: Wave A catalogue + DoD contracts (HITL video **out of scope** for this sprint)  
Design: `~/.gstack/projects/zero-centurion-dashboard-tools/ubuntu-feat-centurion-dashboard-tools-design-20260915-1009.md`  
Wall: **~2 hours** autonomous; human returns to review digests.

## Goal

Advance AI-reservationist **live PMS reads** (plus channel_parse) toward payload usefulness using soft-open, not find-only theater and not a batch parallel scheduler product.

## Global Constraints

- Pilot-RDS safety: never Vitest with pilot `DATABASE_URL`; `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before tests.
- Live HMS: flock `/opt/nava/shared/hms-runtime/.hms-live-operation.v2.lock`; read-only; digests = tails/counts only.
- Skip `property_read_knowledge`.
- **CUT:** building production “parallel scheduler” for P=32 tool waves (real agent = sequential tools per email).
- **CUT:** packaging webm Wave A HITL as done gate this sprint.
- Soft-open defaults: find via `context.request`; detail via `page.evaluate` + bind; reloginEvery only inside burn scripts.

## Overnight Autonomous Execution Mandate

**User granted autonomous execution for this plan (~2h wall).** Continue until done criteria verified or true blocker. No routine checkpoints. Batch decisions; fix yourself or move on.

### Decision authority

- Choose best safe reversible option without asking.
- Better route to accepted goal may be taken; log what changed and why.
- Preserve requirements. Do not silently cut Goal done criteria.
- Standard non-fast subagents only; else inline.
- Respond `/caveman full` in progress notes; code/commits normal prose.

### RCA loop

FAIL → minimal reproduce → RCA → smallest fix → retest → resume.

### Safety

- Follow `.cursor/rules/pilot-rds-safety.mdc` and Zero overlay.
- Never force-push, `--no-verify`, destroy git, expose secrets/DB URLs.
- Never Vitest against pilot RDS / `VITEST_ALLOW_PILOT_RDS=1`.
- Live HMS read-only under flock.

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Live runner | `apps/server-pilot/deploy/ssm-run-command.sh` |
| Stage | S3 `s3://nava-zero-bootstrap-845242190536/git-bundles/proof-source/v1/` |

### Verification loop

Implement → focused tests (unset DATABASE_URL) → live burn under flock when needed → write digests → next task.

### Done criteria

- [x] Quote soft-open live digest under `.private/hms-read-close-2h-20260915/` with field score or honest gap — **6/6 ok**
- [x] A1 HDR soft-open live digest with bind/core-stay score or honest gap — **core stay 8/8; bind/rate honest gap**
- [x] channel_parse: tests green and/or live mail sample digest; agent-call note written — **10/10**
- [x] Docs split SUMMARY: % of document-demand emails mail-solvable vs HMS-needed (offline OK) — **100% role-blocked → mail candidate**
- [x] Plan progress ledger updated; CUT list (parallel scheduler, knowledge, HITL video) recorded
- [x] No unresolved agent-fixable blocker left parked as “needs human” — rate deepen = next sprint, logged

### True blockers

Missing HMS credentials, flock held >15m by foreign process after wait, external outage, safety conflict.

## Execution Mode

Autonomous 2h. Resume first incomplete task. Prefer existing scripts (`hms-find-real-wave.mjs`, gold-fact soft-open patterns, channel fixtures). Extend scripts over new frameworks.

## Reminder TL;DR (for later)

- Skip knowledge (125).
- Do channel_parse (138).
- Priority: quote → A1 → docs honesty → group/event thin → company → harden folio/notes → find unlocker only → writes separate.

---

## Tasks

### Task 0 — Scaffold + inventory (≤10 min)

- Create `.private/hms-read-close-2h-20260915/`
- Write `PROGRESS.md` with minute budget + checkboxes
- Inventory: last quote/A1 compare paths; required inputs (dates/room vs conf)

### Task 1 — Quote soft-open burn (≤35 min)

> **Historical A5 note (superseded 2026-09-17):** This task's OSRRAV soft-open was diagnostic only and never current quote proof. Current client-approved quote proof uses Front Desk → Availability → **Hotel Availability**, applied occupancy, and read-only Availability Details.

- Extract candidates from tool recipes / census with arrival+departure (+ roomType if present)
- Historical diagnostic soft-open only; do not use OSRRAV as current quote proof or fallback
- Digest: `quote-softopen-digest.json` (tails, bytes, field hits, stub813)

### Task 2 — A1 HDR soft-open (≤30 min)

- Reuse find hits (conf+stayId) from prior digests or short find wave
- Soft-open OSRESV.HDR (+ rate probe if unlocked); bind check
- Digest: `a1-hdr-softopen-digest.json`

### Task 3 — channel_parse (≤20 min)

- Ensure `mail_parse_channel_payload` fixtures/tests green (`unset DATABASE_URL…`)
- If live eml sample available on host: one parse digest; else fixture proof + call-path note
- Digest: `channel-parse-status.json`

### Task 4 — Docs split offline (≤15 min)

- From recipes/census: classify document-demand emails as mail-attachment / sent-email-HMS / finalized-Documents / unknown
- SUMMARY counts only — no PII
- Digest: `docs-split-SUMMARY.json`

### Task 5 — Optional if time

- Surname_dates find body wiring stub + one live probe
- Else: note folio/notes already soft-open green; production harden = later

### Task 6 — Close ledger

- Update PROGRESS.md + this plan checkboxes with evidence paths
- One-page `HANDOFF.md` for human return

## Metaprompt (self)

You are closing Centurion **read** tools in 2h. Do not rebuild find concurrency. Do not build a parallel tool scheduler. Soft-open quote and A1 matter most. channel_parse is in-scope mail. Docs = honesty split. Digests over videos. If blocked, write honest gap and move to next task. Human checks digests, not chat.

## File map

| Path | Role |
|------|------|
| `.private/hms-read-close-2h-20260915/` | All digests + PROGRESS + HANDOFF |
| `apps/server-pilot/scripts/hms-find-real-wave.mjs` | Soft-open patterns to extend/reuse |
| `apps/server-pilot/scripts/gold-fact-backtest-29-live.mjs` | Quote/folio/notes probe shapes |
| channel parse tests/fixtures under `apps/server-pilot/tests/` | Task 3 |
