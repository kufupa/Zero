---
title: "Centurion PMS Read Tools — Autonomous Completion Plan"
type: feat
date: 2026-09-15
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: legacy-read-tools-audit
execution: code
---

# Centurion PMS Read Tools — Autonomous Completion Plan

**Execution posture:** Luna 5.6 `max` owns implementation, testing, live read checks, fixes, deployment, and handoff. The reservationist agent is not being built yet.

**Objective:** Finish reusable deterministic read tools that a future agent can call with guest/thread context, documented configuration, previous tool results, or explicitly assisted test inputs. Prove returned business facts through the real execution path.

## Product Contract

### Included capabilities

- Reservation/finance: `hms_find_reservation`, `hms_read_reservation`, `hms_read_folio`, `hms_quote_stay`.
- Related records: `hms_group_block_read`, `hms_company_account_read`, `hms_event_read`, `hms_read_notes_traces`.
- Documents/communications: `hms_list_documents`, `hms_sent_email_audit`.
- Channel parsing: `mail_parse_channel_payload`.

### Permanent exclusions

- Never build or test `property_read_knowledge` or `mail_read_artifact`.
- Do not substitute mailbox attachments or property-knowledge files for genuine HMS document reads.
- `documents_list_existing` and `documents_read_existing` are mailbox-attachment adapters in this
  revision, so they are outside the completion target. Keep their legacy code only for compatibility;
  do not expose, promote, or count it as PMS document retrieval unless a genuine HMS-backed provider
  is wired and separately proved.
- Do not build a reservationist LLM, response generator, queue, new test database, generic evaluation platform, OCR pipeline, or comprehensive audit-video retention system.

### Requirements

- R1. Every included capability is callable through its real reusable implementation and normal authorization boundary.
- R2. Healthy authenticated PMS sessions are reused; each operation still gets fresh scope, authorization, and record binding.
- R3. Results contain correct record-bound business facts, not merely successful requests, open screens, populated keys, status flags, or hashes.
- R4. Historical emails provide representative test cases; email count is a coverage pool, not a completion quota.
- R5. Reads remain read-only, privacy-safe, database-safe, and fail-closed at authorization boundaries.
- R6. Delivered code, actual invocation path, and evidence agree. Registry flags alone never establish completion.

## Global Constraints

- No PMS create, amend, cancel, save, submit, trace-complete, assign, post, refund, finalize, generate, print, email, resend, or permission-bypass operation.
- Reuse existing EC2 access, credential mechanism, and HMS operation lock. One live PMS owner; serialize live calls by default.
- Never run Vitest or another test runner against pilot or production RDS. Before every test command unset `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS`; never source `.env.production`.
- No destructive Git, force-push, hook bypass, migrations, seeding, unrelated restarts, or overwriting shared dirty work.
- Keep credentials, secrets, and guest evidence private. Authorized corpus may be read locally, but never send raw PII to web search, Git, CI, SSM, or external MCP.
- Existing document reads stay included only where provider is proven to retrieve genuine HMS/PMS documents or bytes. Mailbox-only sources are not relabelled as PMS.
- `property_read_knowledge` and `mail_read_artifact` remain excluded without discussion.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** Continue until objective and Definition of Done are evidenced or a true blocker is reached. No routine user checkpoints.

### Decision authority and communication

- Choose safe reversible details autonomously; preserve scope and acceptance gates. Use `$caveman` and codegraph-first navigation; stale/unindexed graph coverage falls back to targeted source reads.
- Luna is default executor. No routine subagents or routine Astra reviews. Dispatch one bounded specialist only for approved escalation; otherwise work inline.
- Better route to same DoD may be taken and recorded in private handoff.

### Astra escalation

Escalate to `gpt-6-astra` `xhigh`, fresh context, for one bounded issue after two distinct failed fixes of that defect or 20 minutes investigating without new evidence. Escalate immediately for unresolved authorization/session safety or contradictory evidence. Normal test/deploy duration is not a stall.

Dispatch must include objective, unit, exact DoD, scope/safety constraints, worktree/revision/dirty state, architecture, reproduction, expected/actual behavior, evidence paths, attempted fixes, facts versus assumptions, session/lock ownership, and precise question. Tell Astra to use `$caveman` and codegraph, inspect linked context, preserve safety, and never weaken gates. Request root cause, smallest fix, verification, and remaining uncertainty. Luna verifies and resumes.

### RCA and verification

FAIL → minimal reproduction → mechanism/root cause → smallest correct fix → focused tests → broader checks/build → live/runtime gate → evidence inspection → fix red gates → resume. Symptom patches, skipped gates, synthetic success, and “user can finish later” are not completion.

### AWS/Pilot safety

| Resource | Value |
|---|---|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| Pilot RDS | `nava-zero-mail-pilot` (Postgres 16) |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| HMS lock | `/opt/nava/shared/hms-runtime/.hms-live-operation.v2.lock` |
| Deploy/restart | Existing `ops-deploy.sh` / `ops-restart.sh` only when required |

Allowed: existing ops wrappers, bundle sync, deployment, read-only SSM checks, PM2 logs, health checks, and tests against disposable non-production databases. Forbidden: real mail credentials, pilot-RDS test runners, `VITEST_ALLOW_PILOT_RDS=1`, `.env.production` in test processes, destructive Git, forced writes, and authorization bypass.

Before every Vitest command:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

Missing disposable DB is a safety blocker, not a reason to weaken gates.

### True blockers

Stop only for missing access that cannot safely be obtained, human-only interaction, destructive ambiguity, safety conflict, or external outage preventing required proof. Keep blocked capabilities disabled and continue independent work. Never label blocked or unverified capabilities complete.

## Assisted-Test Contract

Manual assistance is allowed for tool testing. Cases may use manually discovered IDs, gold-derived inputs or expected facts, explicitly chosen fallback records, and controlled normalization. Record each case in `.private/read-tool-test-inputs.md`: tool, inputs, source, assistance, actual record tested, output, verdict, and unresolved dependency.

Tool must still execute through real implementation and return observed output. Gold may define expectations or seed inputs; copied gold text never counts as retrieved PMS output. Fallback record proves tool works for supplied record, not that original email resolved to it. Assisted and email-derived cases labelled separately. No hidden browser/script rescue silently presented as normal tool behavior.

## Implementation Units

### U1. Freeze honest acceptance gates

Inspect private audit/handoff and source. Build matrix of required facts, sections, variants, evidence, and blockers. Replace status-only, response-size, empty-array, rotated-candidate, catalogue-hash, and fixture-only success rules. Use existing `hms-read-100-verify.mjs` and scoring tests as diagnostics, not authority. Add wrong identity/date/amount, empty quote, null folio money, and unbound-response counterexamples.

**DoD:** false positives fail; matrix distinguishes complete, partial, unavailable, ambiguous, and blocked.

### U2. Reused authenticated runtime

Audit `apps/server-pilot/src/hms/runtime.ts`, operation leasing, property lock, native context lifecycle, abort handling, and direct HTTP policy. Keep one healthy native context; fresh immutable operation scope/generation fence each call; discard unsafe context.

**DoD:** A → B → A returns correct records with one healthy login; expiry, abort, and delayed callbacks cannot cross-contaminate.

### U3. Real normal execution path

Trace `createAgentReadTools`, `executeReadToolRun`, `executeProductionReadTool`, registry/admission, and worker composition. Expose all included IDs through real typed dispatch. Fix discarded company/event results, unavailable quote authority, unsupported find fallback, missing metadata, and identity binding. No fourth executor or agent runtime.

**DoD:** every included tool is callable through normal composition with truthful typed result or explicit unavailable/blocked status.

### U4. Find, reservation, folio

Fix exact find, safe surname/date fallback, ambiguity, bounds, paging, reservation detail, booked policy/rates, operations, folio balances/deposits/transactions/currency, and scoped authorization facts. Unknown is not zero/paid.

**DoD:** assisted and email-derived cases return checked facts; wrong-record, empty, ambiguous, and paging behavior safe.

### U5. Current quotes

Use verified current room/rate authority and consistent issuance-to-execution snapshot. Honor dates, occupancy, quantities, negotiated rates, and supported segments; never invent codes or downgrade rates. Validate nightly coverage, currency, restrictions, totals, and `held=false`; no CRS create.

**DoD:** ordinary, multiroom, negotiated, unavailable, stale-authority, and missing-input cases return correct facts or truthful non-success.

### U6. Group/company/event/notes

Use existing source-specific drivers and server-minted scoped refs. Return group summary/blocks/pickup/delegates, reservation-linked company terms, event details, and notes/traces with length/state/paging/source-date semantics. No fabricated arithmetic or status-as-terms.

**DoD:** deep sections and wrong-parent/off-page/empty/long-note cases pass; access gaps explicit.

### U7. HMS documents and sent audit

Prove provider identity, property/parent scope, filters, paging, stale versions, and byte retrieval. Keep existing/finalized HMS documents distinct from mailbox attachments. No generate/print/resend. Sent rows are audit evidence, not delivery proof.

**DoD:** genuine HMS metadata/bytes work where accessible; excluded providers denied; mail-only evidence cannot pass as PMS delivery.

### U8. Luna-led historical verification

Use approximately 100 corpus threads as a coverage pool. Read latest Centurion response for expected facts, then preceding request/context. Luna chooses calls and analyses results; no second reservationist LLM. Manual IDs, gold inputs, and fallback records allowed when documented. Run actual tools; compare identity/date/amount/currency/status/content. Classify historical drift, staff error, ambiguity, missing source, tool defect, or external block. Do not spend hours on unhelpful threads; expand only for missing capability coverage.

**DoD:** normally two meaningful positive examples per tool plus required variants/relevant negatives; all selected results classified; no known internal failure affecting required behavior. No 100-thread score claim.

### U9. Delivery and handoff

Deploy through isolated existing release controls. Verify loaded revision, process path, registry, and one normal live read. Rerun affected cases and representative cross-tool smoke checks. Maintain one private handoff ledger with capability state, evidence, usage, and blockers.

**DoD:** delivered code passes matrix, focused tests/build/runtime gates, and rollback verification; abandoned execution experiments removed without touching unrelated user work.

## Verification Contract

- Focused existing tests cover contracts, runtime/session lifecycle, dispatch, parsers, folio/quote completeness, notes, documents, and channel fields. Live PMS proof uses purpose-built read-only scripts under lock, never Vitest.
- Every capability needs meaningful positive output, applicable negative/edge behavior, input provenance, observation time, and delivered-version evidence.
- No tool passes solely on `status: ok`, field presence, response bytes, screen visibility, shared digest, or synthetic handler.
- Maintain one private ledger; no raw PII in Git or external output.

### Permission-blocker proof

Recheck filters, loading, paging, alternate surfaces, and positive controls. If still blocked, record real browser video from login through normal navigation to exact screen/failure. No forced controls, stitched screenshots, idle tail, or cropped final seconds. Empty alone does not prove missing permission; classify denied, no data, alternate source, or unresolved. Store timestamps, steps, error, alternatives, and client-ready explanation privately; do not email automatically.

## Definition of Done

- [ ] U1–U9 applicable work complete; every included tool has truthful state.
- [ ] Included tools callable through real composition with reused authenticated runtime.
- [ ] No known internal defect affects required facts; red gates received RCA and verification.
- [ ] Assisted-input ledger and private evidence agree with observed output and delivered revision.
- [ ] Focused tests/build/runtime checks pass without pilot-RDS tests or forbidden writes.
- [ ] Required live positives and meaningful negatives verified; genuine role blockers have valid videos.
- [ ] Handoff separates working, partial, unavailable, and externally blocked capabilities.
- [ ] Exclusions preserved; no reservationist agent claimed built.
- [ ] No unresolved blocker affects a claimed-complete capability.

## Execution Mode

Autonomous. Resume at first incomplete unit. No routine checkpoint or user question. Stop only at verified DoD or true blocker.
