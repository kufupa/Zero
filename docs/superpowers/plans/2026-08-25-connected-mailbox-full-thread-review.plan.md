# Connected-mailbox full-thread review — VPS execution

Supersedes laptop plans `corpus_analysis_nava_3d2f41c2` and `luna_full_thread_review_7490f5d3`
(files live on `C:\Users\gamin\.cursor\plans\`, not on this VPS). All settled decisions carried
forward; engine + delegation contract replaced below.

Worktree: `/home/ubuntu/projects/zero` on branch `feat/connected-mailbox-corpus`
(6 harness commits ahead of base `bab8b77a`). Private corpus root:
`.private/connected-mailbox-corpus/` (gitignored).

## Status already complete (do not redo)

- Harness sealed + committed: active-transport dump, private-output hardening, ACL gate.
- Live dump done: `asOf 2026-08-25T22:24:55.657Z`, 2 active mailboxes, 3,268 messages,
  2,403 threads → `connected-mailbox-inbox.md` (44,994,367 bytes raw).
- Deterministic regex census done → `census.json`.
- Residual judgment done (111 residual inbound triggers / 108 referenced threads).
- Analysis doc v1 done: `docs/infor-hms/connected-mailbox-corpus-analysis-2026-08-25.md`.

Remaining scope: **full-thread review of all 2,403 threads** (regex saw patterns; this pass
reads semantics), reconciliation vs regex census, tracked analysis-doc upgrade.

## Engine + delegation contract (CHANGED from laptop plan)

| Item | Laptop plan | This plan |
| --- | --- | --- |
| Judge model | `gpt-5.6-luna-max` | Azure `gpt-5.6-luna` (session default; max reasoning) |
| Subagent model selection | explicit model string | **inherit** — `delegate_task` children pin the parent model; per-call override is not supported |
| Dispatch runtime | Cursor background agents | Hermes `delegate_task` batch mode |
| Concurrency | ~4 parallel | **3 leaves per dispatch** (`max_concurrent_children=3`), sequential waves |
| Nesting | n/a | depth-1 leaves; children cannot spawn further agents |
| Context ceiling | 272k | 272k (unchanged → batch-size math unchanged) |
| Fast variants | forbidden | forbidden (and unavailable) |

Delegation rules:

1. One batch = one leaf task (`role: leaf`). Dispatch in waves of 3; start next wave only after
   the prior wave's consolidated result lands.
2. Dispatch prompt carries **local file paths + task purpose + output path ONLY**
   (pilot-RDS-safety subagent rule). Never inline message bodies, subjects, or addresses into
   the goal/context fields.
3. Each child:
   - reads `.private/connected-mailbox-corpus/batches/<batchId>.txt` +
     `.private/connected-mailbox-corpus/thread-review/protocol.md`;
   - writes `.private/connected-mailbox-corpus/thread-review/<batchId>.result.json`
     atomically (tmp file + rename);
   - replies with counts only: `{batchId, threadsInBatch, classified, unresolved, resultPath}`.
4. Failure handling: re-dispatch the same `batchId` (result write is idempotent). Two strikes on
   one batch → record blocker in ledger, continue remaining waves.
5. Audit trail: live transcripts under `cache/delegation/live/<delegation_id>/` — retain until
   verification completes, never commit.
6. Optional model pin (only if user explicitly requests a different child model later):
   `delegation.provider` / `delegation.model` in `~/.hermes/profiles/zero/config.yaml` applies to
   ALL children globally. Leave unset to inherit Azure `gpt-5.6-luna`. Never use stealth/ox-alpha
   or the unavailable `gpt-5.6-luna-2026-07-09` route.

## Measured corpus facts (verified on this VPS)

- Raw dump: 45.0 MB ≈ 11.25M rough tokens.
- Compact semantic projection (text body; stripped-HTML fallback): ~11.0 MB ≈ 2.74M rough tokens.
- Fixed 400-thread batches are impossible at 272k context (≈456k compact / 1.87M raw rough
  tokens per bin). Size-packed bins required — smarter model does not expand the window.
- Largest single compact thread ≈270k chars → must be allowed to solo a bin.

## Batching

- 18 adaptive bins were produced by byte packing, target ≤700k canonical chars/bin (~134 threads
  average; the exact count supersedes the earlier ~16 estimate; overflow bin beats truncation).
- Canonical content per message: text body preferred; stripped HTML only when text body empty;
  set `htmlSemanticDifference=true` when stripped HTML diverges materially — flagged threads get
  a focused raw-dump inspection pass, never silent dropping.
- Builder emits `batches/manifest.json`: `batchId → {threadIds[], bytes, sha256}`.

## Tasks

### T1 — Batch builder (TDD, DB-free)

- New node script under `apps/server-pilot/scripts/` (test alongside existing corpus-script test
  conventions): parse dump Markdown → threads → pack bins → write `batches/*`.
- Fake-fixture tests: packing order deterministic, byte cap respected, oversize thread soloed,
  manifest hash correct.
- RED → GREEN → REFACTOR; run with `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`.

### T2 — Judge protocol (private, gitignored)

- `thread-review/protocol.md`: fixed output schema per thread — intentClass, pmsFacts[],
  proposedTriageRoute (existing slugs only: `ops`/`spam`/`at-risk`/… or `unknown`),
  humanLock flag + reason, toolDemand rows (`gap_unlisted` | `improve_existing` |
  `extend_existing` | `retain_existing` | `split_or_replace` | `defer_no_build`, primary verb,
  HITL requirement if non-read), confidence, short verbatim anchor quote (allowed in PRIVATE
  json only — never copied to tracked docs).
- Deterministic census classifications are pre-attached per thread as input hints; the judge may
  confirm, refine, or overturn with reason. It may not silently drop fields.

### T3 — Dispatch waves (delegate_task)

- sequential waves of up to 3 leaves covering all 18 bins. Wave dispatch = single `delegate_task` call with
  `tasks[3]`, each item self-contained (paths + purpose + output contract above).
- Coordinator aggregates only after each wave returns; no polling mid-wave.

### T4 — Aggregate + reconcile (deterministic, scripted)

- Merge 18 result JSONs → `.private/connected-mailbox-corpus/thread-review/full-thread-census.json`.
- Coverage assert: union(result threadIds) == manifest threadIds, no duplicates, count 2,403.
- Result batch IDs must match the manifest exactly; no partial/diagnostic aggregate is accepted.
- Reconciliation report vs regex census: agreement rate, overturned buckets, missed classes,
  PMbobo/BCC-context findings. Scripted, fixture-tested.

### T5 — Analysis-doc upgrade (tracked, PII-free aggregates only)

- Update `docs/infor-hms/connected-mailbox-corpus-analysis-2026-08-25.md`:
  engine-attributed KPI table, safe-attention triage spec (volume by attention class, proposed
  shadow-eval `rule_id`s, must-stay-human lock list), PMS/Playwright tool-demand portfolio with
  dispositions + primary verbs + HITL/wave sequencing, next-plan seed (claim-safe Mastra draft +
  top HMS reads).
- Privacy gate before finishing: `rg '@'` and subject/body spot-grep over the tracked diff find
  no guest emails, names-in-context, or raw bodies.

### T6 — Verification before completion

- Fresh rerun: batch-builder tests, aggregator fixture tests, scoped typecheck.
- Coverage + privacy asserts pass; ledger updated
  (`.superpowers/sdd/connected-mailbox-corpus-progress.md`).
- No commits/pushes without explicit user authorization.

## Safety (binding, unchanged)

- Never point Vitest or any test runner at `nava-zero-mail-pilot` or production; never set
  `VITEST_ALLOW_PILOT_RDS=1`; `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before every Vitest run.
- Raw PII stays inside `.private/` and child-agent contexts. Never into dispatch prompts, tracked
  docs, stdout logs, git, web, remote MCP/API.
- No mail sends, no HMS/PMS writes, no schema migrations, no dashboard changes, no folder-flip /
  slug changes in product, no Mastra/Playwright implementation, no quarantine inclusion.
- Quarantine (`mail_ingest_quarantine`) remains excluded; named-source fallback stays dead.

## Definition of done

- All 2,403 threads judged exactly once; coverage proof from manifest ∩ results.
- `full-thread-census.json` + reconciliation report generated under private root.
- Tracked analysis doc upgraded with engine-backed numbers; tracked diff passes privacy greps.
- Required DB-free tests + scoped checks green with forbidden env vars unset.
- Ledger current; blockers explicit; zero unrelated files disturbed; nothing committed or pushed
  without explicit instruction.
