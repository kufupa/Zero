# Needs You scope fix

Status: implemented 2026-10-12; PR open for review, not merged, not deployed. Branch `fix/needs-you-scope` cut from `origin/main` d0c2aa08e.
No hard cutoff; ASAP.

## Problem

Staff open Needs You and find work that is not theirs to do. It shows:

- Automated OTA and channel booking confirmations. They need no action.
- "Other" mail, including bulk or dating mail that should be spam.
- Requests the hotel has already answered.

The point of the pane is to save staff time. If they must check items that need no action, the pane has failed.

## Product rules (contract)

These are the source of truth. Do not weaken them without the user's decision.

- **R-A.** Needs You shows only human-written items (stored origin `person`, or missing) of kind `quote`, `booking`, `amendment`, `cancellation` or `voucher_pop`. A missing origin remains human-written (U-2). Status must be `needs_you` or `review`. The thread must not be spam or trashed.
- **R-B.** Automated notices (stored origin `system_notice`), `other` and `spam` stay out of Needs You; they remain classified and in Outlook.
- **R-C.** A hotel-side answer, which is our outbound or an own-sent copy, closes a needs-you item even after staff have edited it, unless its latest `hms_write` run (ordered by `created_at`, then `id`) is still awaiting its own `review.ok` event. A new guest message reopens it.
- **R-D.** An `other` read never removes a spam mark. Spam is recognised by a generic definition (unsolicited bulk, dating, promotional, lead generation), not by sender lists.
- **R-E.** No vendor-named rules. The origin field carries the channel-notice distinction, so WebBeds and Profitroom need no names in code.

## Evidence (origin/main d0c2aa08e, repo-relative)

- `apps/server-pilot/src/ai/work-items.ts` `listWorkItems` (about line 1442): lists every `needs_you`/`review` item except spam kinds, spam threads and trashed threads. It is a denylist.
- `apps/server-pilot/src/ai/work-items.ts` `ensureWorkItemForMessage` (about line 600): creates an item for every succeeded read except `spam`, so `other` and `voucher_pop` items are created as needs-you.
- `apps/server-pilot/src/db/schema/work.ts` lines 24-32: `MAIL_KINDS` has no channel kind. Channel notices become `booking`, `amendment` or `cancellation`.
- `apps/server-pilot/src/ai/work-items.ts` `refreshThreadWork` (about lines 946-1010): a person-touched item is never closed by a reply. `personTouchSql` (about line 836) counts every user event except telemetry as a touch, so a staff edit blocks auto-close.
- `apps/server-pilot/src/ai/extraction/inbound-run.ts` `writeSpamDecision` (about line 353): any non-spam read clears the spam mark, including `other`.
- `apps/server-pilot/src/env.ts` lines 219-225: the old classifier is on unless `INBOUND_TRIAGE_CLASSIFIER=off` and `INBOUND_EXTRACTION=on`. The prod values are not in the repo. Until someone reads them, assume the classifier still writes folders and spam, including the hard-coded profitroom rule in `apps/server-pilot/src/ai/triage.ts` (about lines 618-669).
- `apps/server-pilot/tests/work-items.test.ts` about line 1979 asserts that a guest `other` mail still gets a needs-you item. About line 2388 asserts that a field edit blocks closure by a hotel reply. Both encode the old rules and must change with R-A and R-C.
- `docs/plans/2026-10-11-001-feat-monday-build-finish-plan.md` R2 sends channel notices to `booking`; U-1 excludes automated notices by origin regardless of kind. The earlier plan has no acceptance check on what the list contains.

## Slices

**S1. List, reply close, spam lift (branch, in progress).**
- Allowlist in `listWorkItems` (R-A). The origin comes from `mail_extraction.payload->>'origin'` via `workItem.extractionId`.
- Close a touched `needs_you` item on a hotel-side answer only when R-C's latest-HMS-review gate is clear. Touched `review` items and dismissed items are unchanged.
- `other` does not lift a spam mark (R-D).
- Update the tests that encode the old rules. Add tests for each rule.
- Verify with `vitest` on the work-item, retire, inbound-extraction, follow-up and worker suites, the server-pilot typecheck, and `oxlint` on the changed files.

**S2. Spam recognition (R-D).**
- Add a generic spam definition to the extraction prompt, and no sender lists.
- Back-test against the labelled gold set found in the prior-art sweep (see the sweep notes in the session). Targets: spam precision at least 0.98; report recall.
- Cost: Luna or Haiku back-test runs, a few dollars.

**S3. Origin on open items and the prod proof.**
- Run the existing re-extraction for open items (Monday plan R3), rate-capped, so every open item has an origin.
- Prove on prod: count Needs You items by kind before and after, and capture a screenshot of the pane list.

**S4. Folders and batch.**
- Folder tabs on both surfaces: Needs you, Changes, Vouchers and POPs, System notices, Other, Spam. Folders are virtual, driven by kind and origin.
- Batch run for Needs You items uses the batch HITL backend already on main (PR #183).

**S5. Colleague replies.**
- A colleague's reply from our own domain does not count today (the exact-address rule is a deliberate forged-From guard). Add colleagues' addresses to the staff sender list. The user supplies the list.

**Deferred.**
- Physical Outlook folder moves. These are mailbox writes behind `AI_WRITE_GATE_ENABLED` and need an explicit go.
- HMS write actions for amendments and cancellations remain deferred; those items still appear in Needs You per R-A, with only read-only Find booking + Copy for HMS available.

## Gates

- Local `vitest`, typecheck and `oxlint` must pass before merge. No GitHub Actions and no workflow files.
- Haiku max reviews the diff. Greptile runs on the PR, and every P1 is triaged before merge.
- Deploy only through `apps/server-pilot/deploy/ops-deploy.sh`, and only after the user's go.
- Stop and ask before: a prod flag change, an HMS write, an email send, a DB migration, or a deploy.

## Test database

`TEST_DATABASE_URL` points at the disposable database `v5n_needsyou` on `127.0.0.1:55601`. The env file is `/tmp/triage-digest/test-env.sh` (mode 600). It is outside the repo and is never printed.
