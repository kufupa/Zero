# Centurion conversation-link precision — handoff report

Date: 2026-09-02 UTC
Plan: `docs/superpowers/plans/2026-09-02-centurion-conversation-link-precision.md`
Branch: `feat/centurion-link-precision`
Deployed commit: `822b9b45` (`fix(centurion): make weak link caps deterministic`)

## Layer B KPI

Fresh offline EOD eval: **272 TP / 10 FN / 4 FP / 197 TN** against the authoritative
**483 actionable / 282 responded / 201 unanswered** ledger (uEPV R891,413).
Recall **96.5%** (272/282; floor 268); false-positive rate **2.0%** (4/201;
maximum 4). Skipped threads: **0**. KPI remains binary `responded`; no voucher/PoP
enums, LLM linker, `thread_id` rewrite, or UI polish were added.

## Layer C precision

Deterministic weak links now use canonical `(receivedAt,id,threadId)` ordering,
duplicate edges do not consume fanout budgets, and combined weak components are
bounded below the eight-thread mega-cluster gate. Quoted-body fanout is capped per
message/guest; human orphan chains are component-bounded. `navaai@` is treated as
system-only for subject overlap.

Offline baseline: **3,187 subject-cluster links / 4,039 total proposals**.

Pilot read-only backfill proof after `822b9b45`:

| Metric | Result |
|---|---:|
| Transport messages | 4,598 |
| Proposals (dry-run/apply) | 523 |
| Active links before | 722 |
| Unsafe active edges superseded | 201 |
| Active links after | 523 |
| Active header / conf / guest / quoted / subject | 15 / 10 / 19 / 113 / 366 |
| Historical superseded edges | 3,599 |
| Max active subject-only component | 6 |
| Max active full graph component | 7 |
| Bounce/handover/Nedbank/quotation/Zuko subject edges | 0 |
| Breakfast Pack subject links | 16 |

Apply completed idempotently through the serializable backfill transaction; stale
edges were superseded, not deleted. Grouper ignores `supersededAt`.

## Pilot proof

- Bundle sync, server build, mail build, remote Oxlint, PM2 restart, and health
  checks completed on EC2. Both local health endpoints returned `{"ok":true}`.
- Launch readiness reported `NOT_READY` only for the pre-existing workflow
  dead-letter backlog (**253 total / 124 recent**); all app, DB, transport,
  network, TLS, and lifecycle checks passed.
- Direct wrapper invocation returned mode 126 because the repository wrapper is
  not executable in this checkout; rerunning with `bash` succeeded.

## Verification / safety

- Every Vitest command began with `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`;
  no Vitest/test runner targeted pilot or production RDS.
- Focused deterministic suite: **119 passed / 5 skipped** across 8 files;
  conversation-link: **33 passed / 3 skipped**. Server TypeScript build and
  `git diff --check` passed. Offline EOD gate passed.
- Pilot mutation used explicit `--confirm-pilot-rds`; dry-run preceded apply.

## Compound engineering

- Durable learning captured in
  `docs/solutions/logic-errors/centurion-responded-detection-conversation-link-precision.md`.
- Related-doc search found no duplicate learning; adjacent Centurion, EPV, quoted-mail,
  and replied/read docs are distinct. Repository issues are disabled.
- Vocabulary scan added `Responded actionable thread` and `Conversation-link overlay`
  to `CONCEPTS.md`; `AGENT.md` already exposes both `docs/solutions/` and
  `CONCEPTS.md` discoverability.
- Post-compound fresh verification: 8 DB-safe Vitest files **158 passed / 26 skipped**;
  server build passed; EOD eval passed (**272 TP / 10 FN / 4 FP / 197 TN**, recall
  **96.5%**, FP **2.0%**, skipped **0**); frontmatter validator and `git diff --check`
  passed. The private corpus was supplied as an explicit local path; no corpus data
  was written to Git or emitted in logs.
