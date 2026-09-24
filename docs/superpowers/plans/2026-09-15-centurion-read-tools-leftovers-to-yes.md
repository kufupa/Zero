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

**Execution posture:** Luna 5.6 `max` owns implementation, tests, live read checks and handoff. We are building deterministic tools for a future reservationist; no reservationist agent is built now.

**Objective:** finish reusable, read-only PMS tools that accept only connected email context and prior results, reuse one authenticated PMS context, and return verified business facts through the real tool implementation.

## Product contract

Included: `hms_find_reservation`, `hms_read_reservation`, `hms_quote_stay`, `hms_read_folio`, `hms_group_block_read`, `hms_company_account_read`, `hms_event_read`, `hms_read_notes_traces`, `hms_list_documents`, genuine stored-PMS-byte retrieval (`hms_read_document`), `hms_sent_email_audit`, and offline `mail_parse_channel_payload`.

Permanent exclusions: `property_read_knowledge`, `mail_read_artifact`, mailbox-attachment substitutes, reservationist LLM, response generation, queues, app UI/routes, database/migrations, new evaluation infrastructure, OCR and comprehensive video-retention systems.

Success means every included capability has a truthful state and real positive evidence. Correct `missing_input`, `ambiguous`, `unavailable` or external `blocked` results are supported outcomes; they never become a false complete claim.

## Global constraints

- No PMS create, reserve, amend, cancel, save, submit, post, refund, complete-trace, generate, print, send, resend or permission-bypass action. Hotel Availability Search/details are reads; Reserve is forbidden.
- Do not modify the mail app, DB schema, worker queue, `apps/server-pilot/src/ai/worker.ts`, production config or app deployment. Existing `apps/server-pilot/src/hms` modules, focused standalone scripts and DB-free tests may change. Normal worker composition is explicitly out of scope; do not add a migration, queue behavior, product feature or deployment.
- Reuse current EC2 access/credentials and one validated native authenticated login/storage state per healthy runtime; each call still gets a fresh guarded proof context. Serialize live PMS calls by default; one PMS owner uses `/opt/nava/shared/hms-runtime/.hms-live-operation.v2.lock` with OS `flock`. No login per call, arbitrary parallel tabs or fake SQL locks.
- Keep future code in a private EC2 staging directory, separate from `/home/ubuntu/repos/zero`; preserve unrelated dirty work. No destructive Git.
- Never run tests against pilot/production RDS. Before test commands unset `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS`; never source production env files.
- Keep guest data, credentials, videos and documents private. Never put raw PII in Git, web search, CI, SSM or external MCP.

## Autonomous Execution Mandate

**User granted full autonomy.** Continue through all units until the objective and DoD are evidenced or a genuine blocker remains. Do not pause for routine choices.

- Choose safe reversible details and record decisions privately. Use `$caveman` and codegraph first; use targeted source reads if graph is incomplete.
- Luna is default executor. Use bounded fresh-context subagents only when independently useful. Escalate one issue to Astra `xhigh` after two distinct failed fixes or 20 minutes without new evidence; escalate immediately for unresolved authorization/session safety or contradictory evidence.
- Astra dispatch must include complete relevant context, exact DoD, reproduction, evidence, attempts, facts versus assumptions and dirty state. Require `$caveman`, codegraph, smallest fix and verification. Luna rechecks all advice.
- Loop: reproduce → RCA → smallest fix → focused tests → real PMS proof → inspect evidence → fix red gates → continue. Failed scripts, test errors and deployment errors trigger RCA, not a status-only stop.
- True blockers are inaccessible credentials, human-only interaction, unsafe/destructive ambiguity, safety conflict or external outage preventing required proof. Keep affected capability blocked; continue independent work. Never call blocked work complete.

## Connected-input acceptance

Each acceptance case starts with the actual customer/internal message answered by the selected Centurion gold reply, paired by reply relationship/timestamp. The allowed packet is that body (including quoted history already in it), subject, sender/recipients, timestamp, fixed property/timezone/locale/auth configuration, and actual results from earlier calls in the same case.

IDs present in that message or returned by tools are allowed. Manually discovered PMS IDs, gold-derived IDs/facts/answer hints, unrelated thread context, external attachments, manual browser/DB lookup between calls and fallback records are forbidden for acceptance. Existing assisted cases remain in the private ledger as diagnostic-only history; do not erase them.

For reservation lookup, prefer exactly one confirmation/external reference
derived from the supplied message. If no exact reference exists, the existing
typed `surname_dates` path may use exactly one surname plus both arrival and
departure dates derived from that message; multiple candidates remain
ambiguous and must not be guessed between.

Use fresh Luna context with no gold summary or expected answer until calls/results/outcome are frozen. Maintain `.private/read-tool-test-inputs.md` with provenance, call chain, actual output reference, comparison, verdict and blocker. Synthetic/manual cases remain valid for offline regression only.

## Implementation units

### U1 — Honest acceptance gates

Create a per-tool fact/section/variant matrix. Reject status-only, response-size, empty-array, hash, screen-visibility and fixture-only success. Add wrong identity/date/amount, empty quote and null-folio-money counterexamples.

**DoD:** matrix distinguishes complete, partial, unavailable, ambiguous and blocked; false positives fail.

### U2 — Reused authenticated runtime

Audit runtime context lifecycle, operation leases, lock ownership, aborts, generation fences and direct HTTPS policy. Reset case-specific refs while retaining the validated native login/storage state; do not reuse a case page or proof context.

**DoD:** A → B → A returns correct records with one login; expiry, abort and delayed callbacks cannot cross-contaminate.

### U3 — Standalone real execution

Provide a small private runner and reusable typed library using actual drivers. It must work without app worker, DB or registry. No stub handler, arbitrary URL/selector or dummy production authorization.

For the connected EC2 runner, the validated native-login path starts each guarded
call in the HMS `COMMON` shell and issues the exact reviewed OSRESS search/detail
requests through the authenticated page context. It deliberately skips fragile
menu navigation in this lane; the exact request manifest remains the allowlist and
the runner still serializes calls under the live-operation lock. The runner sets
these scoped defaults itself (`HMS_SINGLE_CONTEXT_LOGIN=1` and
`HMS_SKIP_GUEST_STAY_NAV=1`); they are not undocumented operator prerequisites.
This is a standalone read-runner change only—no app worker, schema, migration or
deployment change.

**DoD:** every included ID invokes real code and returns truthful typed output or explicit unavailable/blocked state. The private `hms-standalone-connected-read.ts` runner supports `HMS_CONNECTED_ALL_TOOLS=1` to dispatch the complete included set from one paired body; missing producer input/provider returns typed `manual_required`/`INPUT_MISSING`, never an invented ref.

### U4 — Reservation and finance

Finish exact/fallback reservation find, ambiguity/paging/negative handling, reservation details/policies/rates/operations, and folio balances/deposits/transactions with signed amounts/currency. Unknown money is not zero or paid.

**DoD:** connected positives plus wrong-record, empty, ambiguous, malformed and paging cases pass.

### U5 — Replace quote with Hotel Availability

`hms_quote_stay` keeps its public ID but standalone execution uses **Hotel Availability** only. Existing Room Type and Rate Availability (`OSRRAV`) remains legacy/diagnostic code and is never a fallback or completion source.

The standalone read-only runner must not invoke the legacy OSRRAV driver. Until
a tenant-discovered Hotel Availability provider/manifest is installed, the
standalone lane returns typed `manual_required` with an explicit provider
unavailable field; this is not quote completion. The normal worker lane is out
of scope and is not modified or used as evidence.

Discover and verify the tenant’s actual Hotel Availability UI/request/response path before automating; do not guess a function or call it REST merely because it is HTTPS. Follow Front Desk → Availability → Hotel Availability. Search and read-only availability details are allowed; Reserve and CRS Check Availability are forbidden because they create a reservation.

The discovered surface manifest must carry `surface: hotel_availability`; quote promotion rejects the superseded `room_type_rate_availability`/`OSRRAV` manifest at both assembly and CLI promotion boundaries.

Submit and preserve exact arrival/departure, nights, room groups/quantities, adults per room, children and supplied child ages, currency and valid negotiated/group context. Fix the current flattened/first-room mapping. If tenant pricing requires a missing age or room allocation, return `missing_input`; never invent age, surcharge or rate. Override the documented 14-night default and verify dates actually applied.

Keep restrictions and legitimate sales strategy. Shop by Day is forbidden for a stay quote because it ignores restrictions; do not bypass exclusive/negotiated-rate context. Serialise separate occupancy searches and do not double-count shared inventory. Return source/time, matched criteria, nightly coverage, rates, currency, restrictions, tax/total basis, unresolved fields and `held:false`. Claim occupancy-priced only when the correlated PMS result supports exact criteria; a zero child surcharge can be correct.

Add tests for adult-only, children/ages, mixed rooms, missing ages, age boundaries observed in tenant, currency, negotiated context, restrictions, unavailable dates, stale results, session reset and no-write behavior. Acceptance requires connected email cases containing needed occupancy data. Record a replacement video: login → Hotel Availability → dates/adults/children/ages → Search → read-only details → matching rates, never Reserve. Old A5 video is superseded.

**DoD:** Hotel Availability child-aware result is verified through reusable tool; no OSRRAV fallback, invented input, restriction bypass or fabricated total.

### U6 — Group/company/event/notes

Use source-specific providers and scoped refs. Return group identity/dates/status/blocks/pickup/delegates, linked company account/terms, real event details, and notes/traces with parent, text, source/date/state and paging semantics. Notes do not prove traces; status does not prove terms.

**DoD:** deep positive, wrong-parent, off-page, empty and long-text cases pass; genuine access gaps remain explicit.

### U7 — PMS documents and sent audit

Prove actual HMS provider, parent/property scope, metadata, paging and retrieval of existing stored bytes. Keep mailbox-only adapters excluded; never generate documents. Sent rows prove recorded audit activity, not delivery.

**DoD:** metadata and bytes each have live positive evidence, wrong-parent/stale refs fail safely, and excluded providers cannot pass.

### U8 — Luna-led historical verification

Use roughly 100 threads as a coverage pool, not a score quota. Normally prove two meaningful connected positives per tool plus relevant variants/negatives. Luna chooses tools and analyses results; no second LLM. Compare frozen actual outputs to gold/current PMS and classify drift, staff error, missing input, absent source, defect or external block. Expand only to cover missing capability; do not shift dates or invent child ages.

**DoD:** all selected cases classified, fixes rerun fresh and no known internal failure affects required behavior. No 100-thread perfect-score claim.

### U9 — Isolated handoff

Run DB-free focused tests and final connected cross-tool batch from isolated EC2 staging. Record source hash, tested revision, invocation, login/context reuse, evidence and capability state. The deployed AI queue worker, its schema/heartbeat and normal queue dispatch are out of scope; they must not gate or trigger migrations for this standalone read-tool handoff. Do not deploy the mail app or touch unrelated work.

**DoD:** tested code equals handed-off code; another operator can reproduce calls without undocumented assistance.

## Verification and definition of done

Every capability needs a meaningful connected positive, applicable negative/edge behavior, input provenance, observation time and delivered-version evidence. Live proof uses read-only scripts under OS lock, never Vitest.

For permission concerns, recheck filters/loading/paging/alternate legitimate surfaces and positive controls. If still blocked, record continuous browser video from login through exact screen/failure with timestamps, steps, error and alternatives. Empty alone is not proof of missing permission; distinguish denied, no data, alternate source and unresolved.

Complete only when U1–U9 applicable work is evidenced, all included tools use real reusable code and safe context reuse, Hotel Availability A5 is proven, focused gates pass, exclusions remain intact, and no required capability is unresolved/blocked. A genuine external blocker keeps overall completion incomplete.

Sources: [Infor Hotel Availability](https://docs.infor.com/hms/2026.08/en-us/hmsolh/jxo1557688477063.html); [Infor CRS workflow](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428583967.html).

## Current execution state (2026-09-16 UTC)

- **Verified live:** the standalone EC2 runner reaches HMS through the authenticated `COMMON` shell, serializes calls, reuses one browser launch, and returns a connected positive for `hms_find_reservation` → `hms_read_reservation` (complete detail). The all-included run invokes every included ID and records typed outcomes; it does not promote `manual_required`, `not_found`, partial or provider-unavailable results.
- **Improved locally/live:** the runner now wires only actual Guest Stay detail projections for folio balance and notes; it does not synthesize money/notes when the dump is absent or masked. Focused DB-free gate: 85 tests pass; server TypeScript passes.
- **Still incomplete:** Hotel Availability is the only allowed quote surface. Authenticated OSMPAV discovery/video returned only the generic shell; no search/response manifest or child-aware positive exists. OSRRAV remains diagnostic-only and is never a fallback. Documents/bytes, company, group, event, full folio and traces remain typed source/policy blockers until their real provider/data is proven. The runner now also attempts the reviewed PSSNEL sent-email observer using only the incoming sender and the matched confirmation; the latest live attempt failed closed with `SOURCE_UNAVAILABLE` after `session_failed`.
- **Explicitly out of scope:** app worker, queue, heartbeat, schema/migration, database and deployment. Do not wait for or modify those systems to complete this standalone handoff.

## Execution mode

Autonomous. Resume the first incomplete unit and continue until verified DoD or true blocker.
