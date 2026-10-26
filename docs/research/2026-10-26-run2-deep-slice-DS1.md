TL;DR: HRDAV’s one install setting cannot currently serve five mailbox transports; skip reasons can use `ai_workflow_run.metrics`, and cap overflow can use existing `nextRunAt`. [staff-quote-installation.ts:401-409; staff-quote-workflow.ts:445-450; mail.ts:577-643]

Read-only: no tests, typechecks, or live HMS reads run. No `-o` path was supplied, and this workspace is read-only, so result is inline only. Prior L2–L5 lanes reused and source claims rechecked below.

### S0 — Split prepared-quote cap seam

| Field | Value |
|---|---|
| Missing | `hms-jobs.ts` is 4,561 lines; quote cap logic shares it with evaluation/fanout. [dev-speed-analysis.md:24; hms-jobs.ts:1867-1925,2607-2681] |
| Needs | Mechanical split before feature edits; one behavior unchanged. [AGENTS.md:45-46; L4.md:51-59] |
| Exact steps | Move `enqueuePreparedQuoteWithinCap` to `prepared-quote-queue.ts`; preserve lock, idempotency, count, enqueue semantics. [hms-jobs.ts:1867-1925] |
| Depends / waits | None; P1, P2, P3b wait for S0. |
| Files owned; LOC | `src/ai/hms-jobs.ts`; new `src/ai/prepared-quote-queue.ts`; new `tests/prepared-quote-queue.test.ts`; ~125–180 changed product LOC [U]. |
| Test · live canary | Test cap/idempotency behavior in new test; HRDAV read-only after final wiring, no product delta from S0; not run. [hms-jobs.test.ts:1329-1353; AGENTS.md:76] |
| Risk + fallback | If adapter extraction changes reuse/count behavior, retain old helper and pause downstream slices. |
| Architecture pushback | Keep later cap changes out of the 4.5K-line module; do not add property branches. [dev-speed-analysis.md:24,45-46] |
| Coder | luna |

### P0 — Generic install and HRDAV manifests

| Field | Value |
|---|---|
| Missing | 10/26 plan records HRDAV install missing; readiness refuses without config. Current rate policy binds one `ownerRef`, while HRDAV has five transports. [run2-shape.md:14-15; hms-read-target.ts:68-78; property-registry.mjs:62-79; staff-quote-workflow.ts:445-450] |
| Needs | Generic owner-ref lookup; explicit property corpus path. Empty `documents:[]` passes schema, but yields no policy documents; omitted `corpusPaths` loads Centurion-only paths. [staff-quote-installation.ts:344-352,401-409,422-423] |
| Exact steps | Add safe `{ownerRef}` path resolution; one current-schema policy file per transport. Set `RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV`, `HMS_DAVINCI_MAKE_QUOTE=on`, `HMS_JOB_QUEUE=on`, `HMS_QUOTE_PREPARE=on`, `HMS_QUOTE_PREPARE_PER_HOUR=6`. Add install-path allowlist for remote HTTP; inspect `/proc` for `http`, `worker`, `ai-worker`, `remote-http` before enqueue. [hms-read-target.ts:28-35; env.ts:275-280; hms-jobs.ts:155-169; write-ec2-remote-env.sh:20-56,82-95; AGENTS.md:46; workstation.ts:820-861; worker.ts:5737-5765] |
| Depends / waits | Code can start T0; live enable waits for actual secret-file and HRDAV corpus paths [U]. HRCEN manifest contents/path [U] before removing its existing defaults. |
| Files owned; LOC | `staff-quote-installation.ts`, `hms-read-target.ts`, `deploy/write-ec2-remote-env.sh`, `tests/staff-quote-installation.test.ts`; private `hrdav-installation.json` plus five `hrdav-rate-policy-transport-{davinci,faith,ayanda,epick,kmgidi}.json`; ~110–190 changed product LOC [U]. [property-registry.mjs:64-79] |
| Test · live canary | Test path selects matching transport and never falls back to Centurion; HRDAV read-only, pass exact config/tenant/slot readiness on target SHA; not run. [staff-quote-installation.test.ts; MISTAKES.md:15] |
| Risk + fallback | Missing path or inaccessible credential file: keep quote prepare off; do not put secret value in env/config. `secretPath` needs an absolute file path, not the registry secret ID. [staff-quote-installation.ts:141-145,706-710; property-registry.mjs:75] |
| Architecture pushback | No third property branch. Current slot union is HRCEN/HRDAV-only; current code also defaults Centurion dinner/corpus data. Move HRCEN values to explicit config only after inventory. [hms-read-target.ts:18-35; staff-quote-installation.ts:70-75,146-150,406-409] |
| Coder | grok |

Target JSON shape (paths marked `[U]`; template needs P0 resolver):

```json
{"tenantId":"HMS_DAVINCI","owner":{"cdpUrl":"http://127.0.0.1:19225","browserOwnership":"borrowed","propertyCode":"HRDAV","secretPath":"/<U:absolute-file-path-for-infor-hms-read-davinci>"},"outputDir":"/home/ubuntu/repos/zero/apps/server-pilot/.private/playwright-quote/hrdav","ratePolicyConfigurationPath":"/home/ubuntu/repos/zero/apps/server-pilot/.private/quote-pilot-release-20261006/hrdav-rate-policy-{ownerRef}.json"}
```

```json
{"version":"source-native-invoice-rate-policy-v1","ownerRef":"transport-davinci","propertyCode":"HRDAV","documents":[],"corpusPaths":["/<U:absolute-HRDAV-only-messages.jsonl>"]}
```

### P1 — Persist prepare decisions

| Field | Value |
|---|---|
| Missing | Evaluator returns reasons, but early returns and caught errors do not persist a decision; after-party callback lacks the admission gate. [L2.md:20-30; hms-jobs.ts:2513-2605,2615-2654,2661-2681] |
| Needs | Append typed `quotePrepareDecisions[]` to source extraction run metrics under row lock; no new table for v1. `work_event` needs a work item, so it cannot cover every refusal. [mail.ts:577-643; work.ts:168-180] |
| Exact steps | Record disabled, no-live-admission, evaluator reason, target refusal, empty plan, and safe error class before returning; reload admission for after-party calls; no mail text/guest PII. |
| Depends / waits | S0; P2 uses the recorder API. |
| Files owned; LOC | `src/ai/hms-jobs.ts`, new `src/ai/quote-prepare-ledger.ts`, new `tests/quote-prepare-ledger.test.ts`; ~80–150 changed product LOC [U]. |
| Test · live canary | Test all refusal classes append without lost concurrent updates; HRDAV read-only, pass every refusal leaves a ledger entry and backfill queues none; not run. [pane-prefetch-and-ui-evidence.md:11-17; hms-jobs.ts:2661-2681] |
| Risk + fallback | JSON metrics is mutable, not a normalized audit table; fail closed if append fails, keep feature off. Add a table only if strict reporting/retention requires it. [mail.ts:622-643] |
| Architecture pushback | Do not fake a `read_tool` run for a decision; do not misuse work-item events. [mail.ts:577-605; work.ts:174-180] |
| Coder | grok |

### P2 — Reserve cap slots; defer, never drop

| Field | Value |
|---|---|
| Missing | Quote cap returns false; find and availability loops break; guest cap returns false. Existing caps: quote 6, prefetch 30, guest 12, availability default 6/hour. [L4.md:17,51-59; hms-jobs.ts:164-190,1912-1918,1944,2101,2210-2216; env.ts:470-473] |
| Needs | After live admission, reserve a per-transport/kind slot and persist overflow with `nextRunAt`; zero cap is a recorded disable, not an infinite queue. [hms-jobs.ts:1985-2009; mail.ts:616-639] |
| Exact steps | Add atomic capacity helper counting active plus scheduled reservations; wire quote, find, guest, party, availability callers; copy admission identity and ledger `deferred` cause. Existing job insert and claim honor `nextRunAt`. [hms-jobs.ts:641-669; run-ledger.ts:673-682] |
| Depends / waits | S0 + P1; P3b waits because both edit `hms-jobs.ts`. |
| Files owned; LOC | `src/ai/hms-jobs.ts`, `src/ai/prepared-quote-queue.ts`, new `src/ai/prefetch-capacity.ts`, new `tests/prefetch-capacity.test.ts`; ~120–195 changed product LOC [U]. |
| Test · live canary | Test cap=1 leaves second job queued with future `nextRunAt`; HRDAV read-only, pass nine strategies eventually queued without exceeding cap; not run. [profile HRDAV:39-50; AGENTS.md:76] |
| Risk + fallback | Recheck source/idempotency when deferred job wakes; if backlog grows, disable prepare and inspect ledger, do not delete rows. |
| Architecture pushback | Reuse `ai_workflow_run`; its due-time indexes/claim logic exist. No new deferral table. [mail.ts:616-639; run-ledger.ts:679-682] |
| Coder | grok |

### P3a — Make strategy catalogue data-driven

| Field | Value |
|---|---|
| Missing | Catalogue has HRCEN/HRDAV branches; HRDAV has nine profile strategies, HRCEN strategies remain static TS. [rate-catalogue.ts:55-73,159-197; HRDAV.json:39-50] |
| Needs | Load each property’s strategy list from its registered profile; no third hotel code branch. [property-registry.mjs:46-79] |
| Exact steps | Move current HRCEN strategy data to its profile; validate profile strategies generically; HRDAV stays nine; missing profile data fails closed. [rate-catalogue.ts:65-73; HRCEN.json:1-55] |
| Depends / waits | None; P3b waits for P3a. |
| Files owned; LOC | `src/hms/rate-catalogue.ts`, `tooling/playwright-quote/property-profile.mjs`, `property-profiles/HRCEN.json`, new `tests/rate-catalogue-strategies.test.ts`; ~80–160 changed product LOC [U]. |
| Test · live canary | Test registry profile supplies exact strategy values; HRDAV read-only, pass all nine configured strategies resolve; not run. [HRDAV.json:39-50; MISTAKES.md:9] |
| Risk + fallback | Unknown/invalid profile means no background quote preparation; do not invent strategies. |
| Architecture pushback | Don’t hard-code HRDAV or a third hotel in `rate-catalogue.ts`; profile owns strategy data. |
| Coder | grok |

### P3b — Log staff picks; order all strategies

| Field | Value |
|---|---|
| Missing | Current shop puts primary input before BAR; no mailbox/agency history. DBB plan defaults Government across properties. [L3.md:47-59; quote-ready.ts:25-48,268-271] |
| Needs | Persist successful human pick with strategy, party ref, mailbox transport, user, mail kind; use only this evidence for ranking. Existing quote event lacks strategy. [quote-outcomes.ts:172-205; staff-quote-run.ts:1017-1024] |
| Exact steps | Add `ratePick` to `quote.prepared` evidence/hash; rank BAR (if configured), mailbox history, bound agency/company history, then profile order. Emit every profile strategy per stay; no history falls back to profile order. |
| Depends / waits | P0 + P1 + P2 + P3a; waits on P2 for exclusive `hms-jobs.ts`. |
| Files owned; LOC | `src/ai/quote-ready.ts`, `src/ai/hms-jobs.ts`, `src/ai/quote-outcomes.ts`, `src/ai/staff-quote-run.ts`, new `src/ai/staff-rate-pick-history.ts`, new `tests/quote-ready-rate-order.test.ts`; ~120–195 changed product LOC [U]. |
| Test · live canary | Test property × strategy × stay matrix; HRDAV read-only, pass nine in ranked order and no unregistered values; not run. [MISTAKES.md:9; HRDAV.json:39-50] |
| Risk + fallback | Sparse history can bias order; use actual logged picks only, retain every strategy, fall back to profile order. S5 regex labels are not truth; confirmation PDFs inflated BAR. [S5-rate-patterns.md:24,64,72-74] |
| Architecture pushback | Remove DBB→Government assumption from background ranking; no S5 labels, no hotel-specific predictor, no strategy pruning. [quote-ready.ts:268-271; L3.md:47-57] |
| Coder | grok |

Read-only SQL text only; not run. Buckets are filename/body candidates, not exact HMS-vs-human truth: current export has attachment metadata, while S5 parsed PDFs; HRDAV letter signatures are [U]. [S5/export.sql:9-13; S5/scan.py:51-59,93-94,150-157; S5-rate-patterns.md:24]

```sql
BEGIN READ ONLY;
WITH att AS (SELECT message_id, bool_or(filename ~* 'provisional') AS provisional_file, bool_or(filename ~* 'confirmation') AS confirmation_file, bool_or(filename ~* '(quote|quotation|proposal|rate)') AS quote_file FROM attachment GROUP BY message_id),
mails AS (SELECT m.id, lower(concat_ws(' ',m.subject,COALESCE(NULLIF(m.text_body,''),regexp_replace(COALESCE(m.html_body,''),'<[^>]+>',' ','g')))) AS content, coalesce(a.provisional_file,false) AS provisional_file, coalesce(a.confirmation_file,false) AS confirmation_file, coalesce(a.quote_file,false) AS quote_file FROM message m LEFT JOIN att a ON a.message_id=m.id
WHERE m.transport_id='transport-davinci' AND m.direction::text='outbound'
AND COALESCE(m.sent_at,m.received_at,m.created_at)>=now()-interval '30 days'),
buckets AS (SELECT id, CASE
WHEN provisional_file OR content ~* 'provisional.{0,40}(letter|reservation)' THEN 'hms_provisional_candidate'
WHEN confirmation_file OR content ~* 'confirmation.{0,40}(letter|reservation)' THEN 'hms_confirmation_candidate'
WHEN quote_file OR content ~* '(quote|quotation|proposal|rate per room per night)' THEN 'human_quote_candidate'
ELSE 'other_unclassified' END AS bucket FROM mails)
SELECT bucket,count(DISTINCT id) AS messages FROM buckets GROUP BY bucket ORDER BY bucket;
ROLLBACK;
```

DAG: `S0 → P1 → P2 → P3b`; `P0 → P3b`; `P3a → P3b`. T0: `S0, P0, P3a`. Longest chain: `S0 → P1 → P2 → P3b` (4 slices).