# HMS dispatch authority: working map

> Historical research snapshot from 2026-11-03. Statements about main, deployment, holds, flags and open work describe that date, not current status. Experiments were synthetic or read-only unless explicitly stated. Temporary paths may no longer exist.

Status: **live Save held**. Local design and synthetic PG tests only. No schema push, pilot RDS test, or real HMS write.

## Two independent protections

1. **Write hold:** one durable HRCEN/Proof Labtest hold shared by create, filing, amend and cancel; conflict across all fake profiles. Missing or ambiguous native guest identity refuses. Starts atomically with consumed Go. Crash or uncertain dispatch stays held until operation-specific, independent readback and evidence; no TTL or blind retry.
2. **Dispatch authority:** after preparation, validate exact source, staff/access and grant. Commit a durable source/access barrier before releasing the native continuation. Keep it through the one-shot continuation. If continuation or process state is uncertain, retain it. Unknown-write hold outlives it until readback.

Current U3 only has `cloudCreateDispatch` in its work-item state. U6/U7 do not consult it. The transaction holding source and actor row locks can die while the browser continuation still runs. Neither protection is shared or complete yet.

## Mutation coverage to prove

`pane-create-source-snapshot.ts` binds selected message headers, bodies, timestamps and keys; linked extraction and translations; attachment metadata; relevant correction events. `pane-cloud-preview.ts` also checks all messages in the thread for property origin and a row limit, most work-item state, cursor and status, active transport and exact actor access. Cover **old and new** identity on UPDATE; handle insert/delete, cascades and TRUNCATE. Workflows U6/U7 have additional attachment/form/preimage bindings.

| Resource | Known write paths | Required coverage / status |
| --- | --- | --- |
| Selected message and all messages in its thread | `mail/ingest/store.ts:529,688,782,880`; `mail/ingest/outlook-history.ts:56,102,153,218`; `mail/ingest/live-admission.ts:458`; `trpc/routes/mail.ts:724,1455,1613`; `mail/send/outbound-queue.ts:712,717,829,976` | **Uncovered.** Include same-thread INSERT, changed IDs/threads, UPDATE and DELETE. Confirm ingest retries after refusal; read/star-only writes need not be blocked if their bound values are unchanged. |
| Parent thread | `mail/ingest/outlook-history.ts:227`; `trpc/routes/mail.ts:1102,1120`; `trpc/routes/mail-helpers.ts:123` | **Uncovered.** Deletion cascades to messages; guard selected thread and identity changes. Avoid blocking unrelated threads. |
| Attachment metadata | `mail/ingest/store.ts:712,802,911`; `mail/ingest/outlook-history.ts:184` | **Uncovered.** Include INSERT, UPDATE, DELETE and both old/new `message_id`; `attachment` has no FK to message. |
| Actual attachment bytes | `mail/ingest/parse-message.ts:199`; `mail/ingest/store.ts:323,1487`; `mail/ingest/worker.ts:352` | **Outside PG.** Filing must pin bytes and hash the exact multipart payload at the native fence. S3 key/hash metadata alone is insufficient. Outlook sealed-original provenance still unproved. |
| Extraction versions and translations | `ai/extraction/inbound-run.ts:186,643`; `ai/worker.ts:4173`; `ai/work-items.ts:1008` | **Uncovered.** Protect bound fields and new/deleted versions; distinguish usage-only update. Check retry/queue semantics. |
| Work item status, state, source and cursor | `ai/work-items.ts:1008,1178,1238,1653,1694,2161,2221,2250,2373,2576`; `ai/work-item-revision.ts:180`; `ai/hms-approval.ts:293,330,426,520,702,1053`; `ai/quote-followup.ts`; `ai/pane-hms-write.ts:345`; `ai/pane-stay-preview-persist.ts:83,104`; `ai/reservationist-task-completion.ts:227`; `ai/reply-check.ts:216` | **Uncovered.** U3 hashes almost all `state`; exact item UPDATE/DELETE must respect barrier until continuation is no longer possible. Review each writer and deadlock ordering. |
| Correction and approval history | `ai/work-items.ts:2148,2562`; `ai/work-events.ts:133`; `trpc/routes/work-items.ts:226`; `ai/hms-approval.ts` | **Uncovered.** Relevant inserts can change source proof even though `work_event` is append-only. Guard correction/decision inserts for the bound item; don't confuse unrelated telemetry with authority changes. |
| Mailbox membership and transport | `trpc/routes/connections.ts:179`; `db/seed.ts:215`; `db/provision.ts:376,395`; FK cascades on user/transport deletion | **Uncovered.** Guard bound actor/access and transport, including deletes/cascades. External admin/SQL writers count. |
| Authentication sessions | `db/seed.ts:405,406`; `db/schema/auth.ts` (`session`, `remote_session`) | **Unproved.** U3 passes actor ID, not session ID, to dispatch; expiry can happen without any DB mutation. Define session/Go semantics and bind the executing session before claiming authority at dispatch. |
| Other write mechanisms | Standalone HMS CLI; legacy HRCEN writers; mixed PM2 versions; privileged SQL; triggers disabled; object store | **Uncovered.** Every enabled writer must participate in the same fake hold, or be operationally disabled/serialized. Triggers cannot defend against privileged deliberate bypass. |

Search includes Drizzle `.insert/.update/.delete` in `apps/server-pilot/src`; not a proof of all deployed jobs, scripts, direct SQL, external integrations, or S3 writers.

## Private PG evidence

`/tmp/nava-u3-private-pg-F0lplhNh/probe-db-triggers.ts`: synthetic tables, private Unix socket, no TCP. BEFORE STATEMENT shared advisory gate plus durable barrier and BEFORE ROW guards passed:

- Pre-existing SQL mutator commits first; installer waits and rejects stale reviewed data.
- Mutation begun while installer holds exclusive gate sees barrier after commit and refuses.
- Ordinary direct SQL selected-source changes, matching-thread INSERT, membership DELETE and TRUNCATE refuse; unrelated thread update succeeds.
- A killed dispatcher DB backend releases its transient lock while synthetic continuation still runs; persisted barrier still blocks source/access changes.
- Prototype refuses non-READ-COMMITTED mutators: older transaction snapshots could miss a newly committed barrier. Existing in-repo repeatable-read cases found so far are read-only, but full deployment inventory remains open.

Owned PG PID 1805290 stopped. DB-backed product suites skipped; no HMS browser/request in this test.

Draft `drizzle/0055_hms_pilot_write_hold.sql` was also applied only to a reduced private schema via `/tmp/nava-u3-private-pg-F0lplhNh/probe-prod-migration.ts`. All 24 guard triggers installed. It passed representative message/thread, attachment, extraction, item/event, membership, transport, user/session, conflicting-hold and DB-backend-loss probes. A writer that had already taken a row lock deadlocked with the global gate; PG aborted one side. Retry/liveness is unproved. A fixture FK prevented the first TRUNCATE test; the corrected attachment test passed. Owned PG PID 1822505 stopped. This migration is **experimental, not journaled, not deployable**: it blocks revocation, and an authorized SQL writer can manufacture a close/resolution without proving quiescence or readback.

## Existing schema versus triggers

The existing append-only `work_event` can store both durable markers. App-only code can preserve the barrier if **every** mutator first acquires the same gate, rechecks the barrier, and retains the gate until commit. A synthetic test passed for participating code and demonstrated that an unmodified/direct SQL writer bypasses it. Source/access write sites above, old PM2 versions, external SQL, standalone tools, and ingest retry are not fully covered. No schema push is necessary for that design, but a complete writer change, coordinated rollout, and explicit boundary excluding nonparticipants are prerequisites; none is proved.

Database triggers would cover ordinary direct SQL and mixed old application versions for the protected tables, but require a schema push and still cannot protect S3 bytes, time-based session expiry, standalone HMS writers, deliberate privileged trigger/hold bypass, or unproved recovery. Both designs remain disabled.

## Revocation-first design to resolve

- Immediately persist a revocation intent that every auth and worker entry checks, so the staff member cannot start new work while an in-flight operation is stopped. The old access row may remain only while cleanup is pending; all four processes and alternate auth paths must honor the intent before claiming access disabled.
- Run each native write under a separately supervised, owned dispatcher and browser process group. Record host/boot ID, PID/start time and browser group. Kill the correct groups and verify all processes/continuations are quiescent before removing the source/access barrier. Keep the independent write hold UNKNOWN until fresh operation-specific readback. Current Playwright launches Chromium in a **detached** process group; killing the Node dispatcher alone is insufficient.
- A request already sent may still commit after revocation. Reconcile; never blind-retry. A host/network partition or unkillable process leaves recovery pending, with new actions denied; do not claim the write was stopped.
- The boundary between revocation intent and actual revocation needs an explicit linearization rule. A paused callback can resume after intent is written but before kill completes; a fresh DB check alone cannot close that gap. An independent OS/network gate shared by dispatch and revocation may solve ordering only if every writer uses it and supervisor/browser death is proved. Session expiry without a DB mutation is a separate open question.

`/tmp/nava-u3-private-pg-F0lplhNh/probe-chromium-revocation.mjs` used only a localhost server and owned processes. It showed intent alone did not stop a paused callback; SIGSTOP of the dedicated worker plus SIGKILL and quiescence check of its detached Chromium process group prevented that local POST; kill after the server received the POST could not undo it. Chromium cleared its launch environment, so ownership required a dedicated worker's unique new direct child plus PID/start-time/parent/PGID checks. Initial identity probes failed and were corrected. All owned processes exited. This does not prove production supervision, parent-death handling, multihost behavior or HMS safety.

`/tmp/nava-u3-private-pg-F0lplhNh/probe-revocation-pg-browser.mjs` combined private PG with localhost Chromium. Killing the dispatcher's PG backend left the synthetic source barrier active; synthetic revocation intent denied new actions; final access deletion refused until the stopped dispatcher and detached browser groups were quiescent. No POST occurred. UNKNOWN stayed durable and blocked reuse. A separate counterexample let a session expire by time alone; its paused continuation still sent a localhost POST. Owned PG PID 1857610 and child processes stopped. This proves a model's ordering only, not real auth/ingest coverage, supervisor crash recovery, multihost behavior or HMS.

### Authentication coverage

- `trpc/trpc.ts` drops Better Auth's session ID and expiry. U3 currently binds actor ID and mailbox membership, not the executing session. Legacy processes use `session`; remote HTTP can use `remote_session` (`lib/auth-profile.ts`).
- `outlook-sync/authorization.ts:requireStaffSession` models an ID-bound, DB-clock expiry check but only for legacy, verified-email Outlook sessions. It is not a drop-in for the existing Create contract.
- Better Auth is mounted directly at `/api/auth/*`; EML/inline-attachment HTTP, Outlook security/sync, and some jobs have separate session/access checks. A synthetic pending-revocation marker checked only by tRPC does **not** revoke access across the application.
- `PRODUCT.md` requires staff Go and a native guard. Plan 001 additionally invalidates a Go on changed source, form or actor and requires a dispatch recheck. Neither specifies whether a session expiring **after** a one-use dispatch authorization cancels the already-authorized action. Do not silently choose this policy or claim strict live-session validity until the ordering is resolved.

## No-schema fake-write hold candidate

`tooling/hms-cloud/labtest-write-hold.mjs` drafts a **separate** HRCEN/Proof Labtest shared hold using an existing S3 bucket and one fixed key. The installed AWS SDK exposes conditional PutObject `IfMatch`. A pre-provisioned `clear` object is replaced with an `unknown` object by conditional PUT; every operation uses a fresh UUID generation and hold ID. All fake profiles and create/filing/amend/cancel conflict. Missing/malformed state, lost responses, unknown ETag or permissions refuse. If a response is lost after S3 commits, the caller does not dispatch and the marker remains unknown. No bootstrap or clear/recovery exists in the prototype.

Four localhost fake-S3 tests passed: independent process/action/profile contention; lost response after commit; missing/malformed/invalid input; stale ETag after a synthetic new generation. The first concurrency harness had an unhandled SDK query string and hung; owned test PIDs were stopped, the fixture fixed, and the suite passed. No production S3 request was made. Conditional-store guarantees, IAM permissions, bucket policy/versioning and same bucket/key across hosts still need production-equivalent proof. Unique generations prevent normal ABA across intended transitions; a privileged restoration of an old object can still bypass it, so conditional-write-only policy and an operational boundary are required.

Cutover: set create/amend/cancel/attach **and legacy** `RESERVATIONIST_PANE_SAVE` off in durable env; verify all four effective PM2 envs; drain old in-flight writes and their detached browsers and reconcile known UNKNOWN operations. Deploy the same participating SHA to all four processes and use the same bucket/key for every standalone writer. Verify region, bucket, IAM, versioning and conditional writes; provision the marker only after inventory. Current deployed SHA is unverified and its HRCEN flags are `lab`; merged #963 is not deployed. Flags alone do not stop already-running jobs. The fake hold solves duplicate serialization only; source/actor authority and revocation stay held.

## Before enabling

- Implement a shared cross-workflow hold and a source/access barrier with atomic grant consumption and the same trigger/lock order. Test actual migrations and actual app code on private synthetic PG, including deadlocks, cascades, old process/transaction overlap, crash points and recovery.
- Prove every writer above is covered and retained/retried appropriately, and every deployment process sees the same schema and gate. No production schema push without owner authorization.
- Bind a proven active session/Go contract; an expired or revoked session must not silently pass an unproved dispatch check.
- Prove safe process quiescence before releasing a stranded authority barrier. Resolve the write hold only after the correct operation's fresh independent HMS readback and evidence. Never clear by age or note.
- Verify fake native guest ID and HRCEN across workflows, pin Filing bytes, and run authorized fake-only proof only after review. Real HRCEN writes remain disabled.

## 2026-11-03: final-dispatch boundary and shared hold WIP

- Owner chose: recheck actor/session/access, selected source, reviewed form, grant and exact native request; consume or one-shot-claim Go and commit UNKNOWN atomically. Continue only after confirmed commit. Later changes do not cancel the already-authorized immutable request. Commit ambiguity: do not continue; retain UNKNOWN.
- Experimental `src/ai/hms-labtest-dispatch.ts`: HRCEN-wide Proof Labtest claim, existing `work_event`, common advisory transaction lock, in-memory owner token, fenced one-use Amend continuations. No release. Old/CLI writers do not yet participate. No schema push.
- Private Unix-socket PostgreSQL test: cross-work-item Create/Filing contention admitted one; revoked session/callback failure rolled back; malformed event refused; Amend phases could not replay or change owner; simulated lost commit acknowledgement kept UNKNOWN without dispatch. Owned PID 1976534 stopped. Synthetic schema only; no pilot RDS or HMS.
- U3 WIP moved Go consumption and UNKNOWN to its intercepted native Save. Session ID/profile is required for the grant and rechecked under a session row lock; latest main supplies these via #966. Focused mocked route/preview tests 29/29 passed, DB variables unset; DB suites skipped. No real Save/readback proof; `authorityReady()` remains false.
- Browser wrapper currently swallows context/browser close failures. Parent is testing strict close + owned browser/process-group termination; U7 is adding native fence disarm/drain. Neither is production proof yet. Positive fresh readback must match the operation; immediate absence after an uncertain dispatched request is not proof of no write.
- Common hold currently blocks all later fake writes forever. Safe recovery must retain historical grant claims, atomically reconcile the per-stay marker, and accept only proven no-dispatch or operation-specific positive fresh readback after quiescence. No age-based or note-only clear.
- User's gate remains: complete U3 preview + commit together, ≤500 gross product lines, no guard-only or preview-only U3 PR. Current WIP is over the gate and based on older main; independently useful connected prerequisites and safe reuse still needed.

## Amend research preserved from the 2026-11-03 U7 handoff

- A read-only blank-form controller inspection found `rateplanlovchange` and `rateplanchange` full-form handlers; the former marks the sell option held. Check Availability sends or sets the form fields and marks a sell option held. Saved-stay side effects were not established: no handlers were invoked during this inspection, and vault POST was blocked. Treat rate selection and availability as potentially mutating until proven otherwise.
- A synthetic PostgreSQL connection-loss experiment used the prototype DB wrapper and a mock browser route. After backend termination, a changed source and revoked access, `route.continue()` could run before Node observed connection closure; a later callback was refused once closure was observed. The target hold remained unresolved. A test-only handler recorded an uncaught postgres.js 3.4.5 `socket.write` TypeError. This was a synthetic counterexample, not a production or HMS proof, and does not model every network failure.
- The contemporaneous handoff treated Hotel Availability nightly values as having unproved price, quantity, tax and final-total basis; it did not equate their sum with a native saved-stay rate. Later HMS work may have established more.
