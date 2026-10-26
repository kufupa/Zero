---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
origin: docs/plans/2026-10-26-001-overnight-run2-shape.md
asks: [223, 224, 225, 226, 227, 228]
title: Overnight Run 2 - Implementation Plan
date: 2026-10-26
type: implementation-plan
product_contract_source: docs/plans/2026-10-26-001-overnight-run2-shape.md
execution: code
---

# Overnight Run 2 - Implementation Plan

## Goal Capsule

Deliver one staff-controlled quote workflow that resolves each request against its property, shops every configured rate/room option, keeps the selected Stay and Book inputs coherent, and preserves PDF/quote work across mail or pane switches. Improve the throughput and auditability of background quote preparation without sending mail or making a real-guest HMS write.

This is one product workflow (Quote; product WIP remains 1) executed as independent, file-owned PR slices. T1 is the required tonight scope; T2 is only after every T1 slice has merged; T3 is explicitly held. No hard stop at 09:00/10:00 UK: keep processing startable units until the list is empty or an external authority/evidence hold stops a unit.

Planning evidence was read at worktree HEAD 9afe32e8d against origin/main 230f5f7e4; the implementation orchestrator must refresh origin/main and repeat the required read list before acting. Inputs used: PRODUCT.md; docs/context/ACTIVE.md; docs/context/OWNER-ASKS.md rows 223–229; docs/research/README.md; AGENT.md; AGENTS.md limits; docs/context/FACTS.md; docs/research/CATALOG.md; docs/context/MISTAKES.md top 20; docs/context/RUN-CONTRACT.md; docs/plans/2026-10-26-001-overnight-run2-shape.md; docs/context/ledger/2026-10-26-run2-decisions.md; DS1–DS4; and docs/research/2026-10-26-dev-speed-analysis.md.

Required product bars from PRODUCT.md: quote recall ≥85% on ≥100 independent outbound-grounded quote rows; every plannable real quote in a proof set of at least 10 has the staff-sent rate plan and exact per-night price; compare the same versioned golden-set rows and re-score the old build when the set changes. Any pane release also needs a green viewer run and the staff bundle seen in nginx after the final deploy. A green test or a successful background staff_quote is necessary evidence, not the product Done state.

Scope counts: T0 4 (three pure moves plus R-CORPUS); T1 31 (DS1 5, DS2 5, DS3 9, DS4 F/G/B/K/Lease 11, and R-SEED 1); T2 8; T3 2 held slices. XLSX parsing is deferred but not a slice in this plan because its acceptance and file boundary are not settled.

## Ask Coverage

| Owner ask | Plan response |
|---|---|
| 223 | T0/T1 splits cover current-SHA, per-property quotes; admitted all-room rates in Stay; persistent PDF; Contact/Agency/Guest; custom rate; readable status and exact-message Needs-you controls. |
| 224 | P0 repairs HRDAV background quote readiness; DS1 P3b and R-SEED use mailbox/party history while still shopping every configured rate; R-CORPUS provides current 30-day and guest/booker counts. |
| 225 | Labtest-only Book proof, no mail sends, no live screenshots/snapshot tests, custom rate remains typeable, Argon stays review-only, and Needs-you itself remains present. |
| 226 | Evidence-based split/ETA and 6–8 lanes; all nine strategies remain; travel-agent/contact-versus-guest question is measured in R-CORPUS; XLSX and real commit are held. |
| 227 | Speed mode with reviews/fixes intact, ~200 LOC as a soft target, Grok/Luna routing, no hard stop, and deterministic script gates. |
| 228 | Coordinator state/digest, explicit kickoff read list, hook/resume-prompt reinjection after compaction, idle-gap checks, and a tested merge/deploy gate. |

## Product Contract

- Preserve the staff-reviewed, draft-first workflow: Prepare → Queue → Act → Review. Nava never sends email. T1 Book-field work may be proven only with Labtest; no real-guest create/amend/cancel is in tonight's scope.
- Keep Outlook pane and webmail behavior equivalent. A work item, source message and property stay bound to the same request; the Outlook EntryID and webmail sourceMessageId remain different identifiers.
- Shop every profile-configured rate strategy for each Stay and rank likely choices first. Never prune the nine HRDAV strategies, treat stale availability as quote authority, or lose Other/custom rate and Authorised by.
- Keep Contact, Company, Agency and Guest distinct. The agreed People layout exposes Contact / Agency / Guest; Company remains a separate canonical value and must not be relabelled as Agency or deleted.
- Keep Stay data canonical. Extras/actions belong inside each Stay; keep unavailable-rate alternatives under their row, never drop an option, and retain Documents as step 5. Book must not duplicate Stay/room/board/rate/contact fields. Persisted provenance and undo/redo use append-only work_event history; reuse the existing event/run ledgers before adding a table or queue. See docs/solutions/ui-bugs/2026-10-25-extras-in-stay-cards.md and docs/solutions/ui-bugs/2026-10-25-stay-contact-canonical.md. The canonical source is docs/solutions/ui-bugs/2026-10-25-extras-in-stay-cards.md and docs/solutions/ui-bugs/2026-10-25-stay-contact-canonical.md.
- HRCEN and HRDAV are the currently evidenced properties, not shared-code defaults. Resolve every target through the active registry/profile and transport. No unknown-property fallback and no new hotel-name conditional. HRDAV's required Reservation Note and guestoptin4/Market Segment are configuration-driven fields. No third property's unique case is evidenced; if a third-property requirement cannot be represented by the generic profile, stop that slice and record the schema gap rather than adding a special branch.
- Preserve truthful live proof: bind by rate code plus per-night price/inventory; check expected rate code, nightly price, availability/rooms-left and property identity, not only job/package success. HRCEN historical traces do not count as current HRDAV proof. See docs/solutions/logic-errors/hms-contextual-quote-partial-and-slow-trace.md.

## Planning Contract

1. **T0 extraction boundary.** S0-PANE, S0-PANEL and S0-JOBS are pure moves: zero behavior changes, preserve existing tests unchanged, and mark pure_move=1 so only the >500-line size gate is exempted. S0-PANE and S0-PANEL cannot overlap because DS4-Q3 also touches nava-pane.tsx; S0-PANE merges first. R-CORPUS is a separate T0 read-only research lane. The DS reports' suggestions to start DS2-S1, DS3-A/C/R or DS4-F1 in T0 are superseded by coordinator D3.
2. **Tier barrier.** T1 is mandatory. Split DS4 F into F1 server / F2 Stay bind and G into G1 session shape / G2a grid / G2b integration so each owner is small and exclusive. R-SEED is included as the decision-record row 14 final T1 slice (ask 229 source); it is not added to the user-mandated frontmatter asks list. T2 cannot start until all T1 slices merge and pass. T3 M1/M2 remain outside tonight; XLSX parsing is not dispatched.
3. **Size and ownership.** Target ~200 changed product lines per behavior, judged by difficulty; normal PRs over 500 product lines are refused. The 3 S0 rows alone carry pure_move=1. Every slice has one worktree/branch and exclusive edited-file ownership; dependencies below are real queue locks, including test files. Do not stack on an unmerged PR over 500 lines. Before first review, merge current origin/main into the branch and freeze the diff.
4. **Coder and review routing.** Grok means Cursor CLI model cursor-grok-4.6-high for HMS, Playwright, queue, write, migration and ops-env work; never use a fast variant. Luna means Codex gpt-6-luna at max for the remaining work. Gemini 4 Argon High is adversarial review only, not a coder. Reviews still run in speed mode; one verifier per PR, Greptile/Apex gates run in the lane's background job, and P1 fixes stay on the same PR. Maximum two Greptile rounds; a fresh adjacent P1 in round 3 triggers split/strip/redesign. Coordinator reads every product diff before merge.
5. **P0 live-enable sequence.** DS1-P0 owns the install/policy/env/canary sequence on EC2 via SSM. Verify the private secret-file path from /etc/nava/hms-slot-hrdav.env or hms-slot-hrdav-install.sh without printing its contents. Write the HRDAV installation descriptor and five per-transport policies. Set only the approved quote/queue/prepare variables on http, worker and ai-worker, plus remote-http only if it reads them; source the correct env files, restart the relevant pm2 processes, and verify each /proc/<pid>/environ before enqueue. Re-queue only today's eligible Da Vinci-origin quote mails after that check; the canary is the first succeeded background staff_quote on HRDAV. No mail send or HMS Save. Any flag/env/requeue operation needs authority in the executing session itself; never relay approval from this planning session.
6. **Research scope.** R-CORPUS is read-only production SQL only, aggregate counts only. Reuse DS1's 30-day davinci@ outbound split but correct the message column to message.message_id_header and verify the actual attachment table/columns before joining. Also count confirmation-letter threads where booker/contact differs from guest. Do not print/export names, addresses, email, phone, bodies, attachment text, or row IDs; unknown join/schema means stop or leave the bucket unclassified.
7. **Generic rates and corpus seed.** All property policy comes from profile/registry. R-SEED uses existing outbound evidence for mailbox × sender/agency × rate priors, reports a held-out top-1/top-3 test with at least 100 independent rows, and still shops all nine strategies. Baseline is run twice on the same holdout before evaluating; no tuning on held-out rows. If fewer than 100 valid rows or a trustworthy join is unavailable, retain the profile-order fallback and do not ship the seed.
8. **Run control for ask 228.** The coordinator owns /tmp/or2/state.md and /tmp/or2/rules.sha256. State records unit, worktree/branch/head, lane/terminal, owner, start/end, merge SHA, gate statuses, canary evidence and next dependency. Before kickoff and every compaction/handoff, the orchestrator re-reads the full current AGENTS.md, PRODUCT.md, RUN-CONTRACT.md, this plan and state file; recomputes/verifies the rules digest; then injects the same read-list/rules block through the available hook or explicit resume prompt. Resolve installed paths and --help for merge-gate.sh, dispatch.sh --idle-check and deploy-train at kickoff and record versions/paths in state. A gate missing or not understood blocks merge/deploy; do not invent flags or bypass it. Dispatch script checks for startable units about every 10 minutes; coordinator does a judgement check hourly. No lane edits /home/orca/bin.
9. **Supervision and time.** Launch 6–8 isolated lanes; every S0 is its own lane. Keep the next eligible unit moving while review runs, but only on a branch/worktree the orchestrator assigned and only if file ownership is disjoint. Do not leave work in flight without a watcher/notification. If any step exceeds 2× its estimate, stop and rethink that step; this is not a hard run deadline. T2 is the next list only after T1 is complete.
10. **Safety.** Never use local tsc/tsgo/typecheck or any Vitest/test runner on this coding VPS. Never test against pilot RDS. Never print secrets, postgres://, guest names, email, phone, mail body or attachment text. Production SQL is BEGIN READ ONLY … ROLLBACK via the approved SSM path, counts only. Never send email, test a real-guest write, accept cancellation penalty, use --no-verify, use bare git stash, force-push/main, relay approval, edit /home/orca/bin, or kill/monitor with pkill -f / pgrep -f. Every HMS live batch gets one DOM-verified read-only probe first and one property browser lock.

## Implementation Units

`/tmp/or2/units.tsv` is the runner manifest with exact header `id<TAB>area<TAB>depends<TAB>files<TAB>coder<TAB>brief_path<TAB>status`; `depends` and `files` are comma-separated and every row starts with `status=todo`. There is one `/tmp/or2/briefs/<id>.txt` per slice, no more than 40 lines, containing its goal, owned files, exact DS steps, test, gates, AGENTS NEVER list, and the required Greptile-P1/assigned-stacked-branch instruction. The TSV/brief dispatch manifest covers every named slice; rows whose area starts `T3-HOLD` are explicitly excluded from dispatch tonight. One test seam per slice is listed below. Normal tests/typechecks run on approved remote/Product EC2; reviews run against the isolated PR head. EC2-private entries are non-versioned remote config artifacts: resolve their exact directory from the installed helper at execution and never commit them.

| ID | Tier / area | Depends | Files owned (including changed tests) | LOC | pure_move | Coder | Test file; behavior | Live canary (property/mode; pass) | Risk → fallback |
|---|---|---|---|---:|:---:|---|---|---|---|
| S0-PANE | T0 / pure-move/pane | — | apps/mail/components/nava-pane/nava-pane.tsx<br>apps/mail/components/nava-pane/use-staff-quote-autostart.ts<br>apps/mail/components/nava-pane/use-quote-pdf-job.ts | 415–610 [U] | 1 | luna:gpt-6-luna-max | apps/mail/tests/nava-pane-render.test.tsx — valid auto-start remains once; run unchanged PDF tests listed in this brief. | N/A — pure move; no HMS canary. Pass: unchanged tests/render behavior. | Effect/closure or job-identity drift → revert extraction; keep behavior unchanged. |
| S0-PANEL | T0 / pure-move/panel | S0-PANE | apps/mail/components/quote-workflow/quote-workflow-panel.tsx<br>apps/mail/components/nava-pane/nava-pane.tsx<br>apps/mail/components/quote-workflow/quote-people-step.tsx<br>apps/mail/components/quote-workflow/stay-extras-fields.tsx<br>apps/mail/components/quote-workflow/quote-stay-step.tsx<br>apps/mail/components/quote-workflow/quote-documents-step.tsx<br>apps/mail/components/quote-workflow/rate-plan-select.tsx<br>apps/mail/components/quote-workflow/rates-bar-grid.tsx<br>apps/mail/components/quote-workflow/quote-booking-host.tsx | >500 aggregate [U] | 1 | luna:gpt-6-luna-max | apps/mail/tests/quote-workflow-panel.test.tsx — unchanged render, ordering and per-stay patch behavior; run all UI regression files in this brief. | N/A — pure move; no HMS canary. Pass: unchanged behavior across Outlook and webmail test surfaces. | Missed prop/order or accessibility regression → revert the mechanical extraction; no redesign in S0. |
| S0-JOBS | T0 / pure-move/jobs | — | apps/server-pilot/src/ai/hms-jobs.ts<br>apps/server-pilot/src/ai/prepared-quote-queue.ts<br>apps/server-pilot/tests/prepared-quote-queue.test.ts | 125–180 [U] | 1 | grok:cursor-grok-4.6-high | apps/server-pilot/tests/prepared-quote-queue.test.ts — moved helper retains cap/idempotency; existing hms-jobs.test.ts remains unchanged and green. | N/A — pure move; no live canary. Pass: existing behavior tests green. | Lock/count/idempotency drift → restore helper in hms-jobs.ts and block downstream queue slices. |
| R-CORPUS | T0 / read-only-research/corpus | — | /tmp/or2/r-corpus.sql<br>docs/research/2026-10-26-run2-corpus-profile.md<br>docs/research/README.md<br>docs/research/CATALOG.md | 0 product LOC | 0 | luna:gpt-6-luna-max | docs/research/2026-10-26-run2-corpus-profile.md — aggregate buckets/counts reconcile to denominators; unmatched/unknown stay separate; only counts and no PII/row IDs. | HRDAV / read-only SQL; pass: both requested count tables complete, query rolled back, no data mutation or PII output. | Unknown attachment schema or ambiguous joins → inspect schema read-only and stop/leave unclassified; never guess or export rows. |
| DS1-P0 | T1 / quote-gate/install | — | apps/server-pilot/src/ai/staff-quote-installation.ts<br>apps/server-pilot/src/hms/hms-read-target.ts<br>apps/server-pilot/deploy/write-ec2-remote-env.sh<br>apps/server-pilot/tests/staff-quote-installation.test.ts<br>EC2-private/hrdav-installation.json<br>EC2-private/hrdav-rate-policy-transport-davinci.json<br>EC2-private/hrdav-rate-policy-transport-faith.json<br>EC2-private/hrdav-rate-policy-transport-ayanda.json<br>EC2-private/hrdav-rate-policy-transport-epick.json<br>EC2-private/hrdav-rate-policy-transport-kmgidi.json | 110–190 [U] | 0 | grok:cursor-grok-4.6-high | apps/server-pilot/tests/staff-quote-installation.test.ts — transport selects its matching policy and never falls back to Centurion. | HRDAV / background staff_quote, read-only quote; pass: after per-process /proc checks, first re-queued background staff_quote succeeds with HRDAV installation/policy. | Secret/config absent, wrong process env or refusal → keep preparation off, do not enqueue; report safe counts/error only; no HRCEN fallback. |
| DS1-P1 | T1 / quote-queue/decision-ledger | S0-JOBS | apps/server-pilot/src/ai/hms-jobs.ts<br>apps/server-pilot/src/ai/quote-prepare-ledger.ts<br>apps/server-pilot/tests/hms-jobs.test.ts | 80–150 [U] | 0 | grok:cursor-grok-4.6-high | apps/server-pilot/tests/hms-jobs.test.ts — an early skip/refusal is durably recorded under lock with no PII. | HRDAV / read-only background quote; pass: prepare outcome/skip reason is visible in metrics and no HMS write occurs. | Metrics lost/overwritten or PII added → rollback the ledger adapter; preserve existing metrics and omit sensitive fields. |
| DS1-P2 | T1 / quote-queue/backpressure | DS1-P1 | apps/server-pilot/src/ai/hms-jobs.ts<br>apps/server-pilot/src/ai/prepared-quote-queue.ts<br>apps/server-pilot/src/ai/prefetch-capacity.ts<br>apps/server-pilot/tests/hms-jobs.test.ts | 120–195 [U] | 0 | grok:cursor-grok-4.6-high | apps/server-pilot/tests/hms-jobs.test.ts — overflow is deferred with nextRunAt and later runs once without duplicate enqueue. | HRDAV / read-only quote queue; pass: cap overflow remains pending and is not lost or double-enqueued. | Backlog growth or duplicate wake-up → disable preparation safely and inspect aggregate ledger; do not delete rows. |
| DS1-P3a | T1 / rate-strategies/profile | — | apps/server-pilot/src/hms/rate-catalogue.ts<br>apps/server-pilot/tooling/playwright-quote/property-profile.mjs<br>apps/server-pilot/tooling/playwright-quote/property-profiles/HRCEN.json<br>apps/server-pilot/tests/rate-catalogue-strategies.test.ts | 80–160 [U] | 0 | grok:cursor-grok-4.6-high | apps/server-pilot/tests/rate-catalogue-strategies.test.ts — each registered profile supplies its exact strategies; unknown profile fails closed. | HRCEN and HRDAV / read-only; pass: configured strategies resolve exactly, including all nine HRDAV strategies. | Missing/invalid profile or regression in HRCEN ordering → fail closed and restore explicit profile values; never guess. |
| DS1-P3b | T1 / rate-strategies/pick-history | DS1-P0, DS1-P1, DS1-P2, DS1-P3a, DS4-F1 | apps/server-pilot/src/ai/quote-ready.ts<br>apps/server-pilot/src/ai/hms-jobs.ts<br>apps/server-pilot/src/ai/quote-outcomes.ts<br>apps/server-pilot/src/ai/staff-quote-run.ts<br>apps/server-pilot/src/ai/staff-rate-pick-history.ts<br>apps/server-pilot/tests/quote-ready-rate-order.test.ts | 120–195 [U] | 0 | grok:cursor-grok-4.6-high | apps/server-pilot/tests/quote-ready-rate-order.test.ts — property × strategy × stay matrix ranks nine configured choices and retains all of them. | HRDAV / read-only; pass: one request emits all nine in ranked order, with no unregistered strategy or HMS write. | Sparse or mislabeled history biases order → use only logged staff picks and fall back to profile order; keep all nine. |
| DS2-S1 | T1 / party-prefetch/readback | S0-JOBS, DS1-P1, DS1-P2 | apps/server-pilot/src/ai/hms-jobs.ts<br>apps/server-pilot/tests/hms-jobs.test.ts | 90–190 [U] | 0 | grok:cursor-grok-4.6-high | apps/server-pilot/tests/hms-jobs.test.ts — eligible admitted mail persists a timestamped party readback; missing snapshot skips. | Each active property / read-only Labtest; pass: admitted test mail gets correct property readback with no write. | Missing candidate or admission → explicit skip, no guessed party and no historic-result deletion. |
| DS2-S2 | T1 / party-picker/recommendation | DS2-S1 | apps/mail/components/quote-workflow/party-picker.tsx<br>apps/mail/tests/party-picker-results.test.tsx | 45–135 [U] | 0 | grok:cursor-grok-4.6-high | apps/mail/tests/party-picker-results.test.tsx — stale/missing results stay unbound; confirmed property-matched choice binds. | HRCEN and HRDAV / read-only; pass: correct property result shown and no automatic wrong bind. | Stale or ambiguous profile → retain unbound state and ask staff; no nearest-name fallback. |
| DS2-S3 | T1 / stored-read/live-read | DS3-P1, S0-PANEL | apps/mail/lib/quote-workflow/use-work-item.ts<br>apps/mail/components/nava-pane/nava-pane.tsx<br>apps/mail/components/quote-workflow/quote-workflow-panel.tsx<br>apps/mail/tests/nava-stored-read.test.tsx | 40–130 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/nava-stored-read.test.tsx — late stored result renders and live read count remains unchanged. | HRCEN and HRDAV / read-only; pass: one stored result, zero duplicate HMS reads. | Result provenance or timeout state becomes ambiguous → leave current read state and show safe retry. |
| DS2-S4 | T1 / work-items/Outlook-locator | — | apps/server-pilot/src/ai/work-items.ts<br>apps/mail/lib/quote-workflow/backend-bind.ts<br>apps/server-pilot/tests/work-items.test.ts | 20–55 [U] | 0 | luna:gpt-6-luna-max | apps/server-pilot/tests/work-items.test.ts — synced Outlook row returns its exact locator; missing locator returns null. | Outlook + webmail / read-only; pass: locator resolves only the matching row; no HMS access. | Missing/stale EntryID → manual-search fallback; never guess by subject/sender. |
| DS2-S5 | T1 / Needs-you/exact-message-open | DS2-S4 | apps/mail/components/nava-pane/screens/needs-you.tsx<br>apps/mail/components/mail/mail.tsx<br>apps/mail/components/mail/thread-display.tsx<br>apps/mail/tests/needs-you.test.tsx | 60–150 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/needs-you.test.tsx — flag hides controls; enabled Outlook/webmail open the exact message ID. | Outlook + webmail / read-only; pass: correct message opens on each surface without HMS. | Office API/locator missing → show manual-search hint; no subject/sender guess. |
| DS3-A | T1 / auto-start/date-debounce | S0-PANE | apps/mail/components/nava-pane/use-staff-quote-autostart.ts<br>apps/mail/tests/nava-pane-render.test.tsx | 60–130 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/nava-pane-render.test.tsx — check-in alone queues zero lookups; complete pair queues exactly one. | HRCEN and HRDAV / read-only; pass: zero reads after check-in-only and one after full date pair. | Delay or effect churn → keep the existing date gate and disable only the debounce. |
| DS3-C | T1 / quote-status/accessibility | DS2-S2 | apps/mail/components/quote-workflow/hms-queue-status.tsx<br>apps/mail/components/quote-workflow/party-picker.tsx<br>apps/mail/tests/party-picker-status.test.tsx | 80–150 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/party-picker-status.test.tsx — overlapping lookup emits one role=status and retains retry/failure state. | HRCEN and HRDAV / read-only UI; pass: one readable line per job, errors and aggregate count preserved. | Failure state becomes hidden → retain explicit queue/retry labels and restore both messages if needed. |
| DS3-D | T1 / stay-card/extras | S0-PANEL | apps/mail/components/quote-workflow/quote-stay-step.tsx<br>apps/mail/components/quote-workflow/requirement-card.tsx<br>apps/mail/tests/quote-workflow-panel.test.tsx | 50–110 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/quote-workflow-panel.test.tsx — extras descend from the Stay article and action reads Duplicate stay. | HRCEN and HRDAV / read-only UI; pass: extras/actions visibly remain inside each Stay border. | Clipping or event regression → correct inner overflow or restore the prior wrapper; preserve duplicate event. |
| DS3-E1 | T1 / reservation-note/formatter | DS4-G1 | apps/mail/components/quote-workflow/rate-controls.tsx<br>apps/mail/lib/quote-workflow/reservation-note.ts<br>apps/mail/tests/reservation-note.test.ts | 80–160 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/reservation-note.test.ts — final room/rate/extras selection appears in the generated note. | HRDAV / Labtest preview only; pass: preview note includes final selected values and no save. | Stale/missing extras → keep manual note path; do not invent a value. |
| DS3-E2 | T1 / reservation-note/Book-field | DS3-E1, DS3-P2b, DS4-G2b, DS4-B1 | apps/mail/components/quote-workflow/booking-card.tsx<br>apps/mail/components/quote-workflow/quote-workflow-panel.tsx<br>apps/mail/lib/quote-workflow/reservation-note.ts<br>apps/mail/tests/booking-card.test.tsx | 100–190 [U] | 0 | grok:cursor-grok-4.6-high | apps/mail/tests/booking-card.test.tsx — generated note prefills Book field and remains editable without overwriting a dirty staff edit. | HRDAV / Labtest write-readback only; pass: saved reservationnote equals final values and staff edits survive. | Staff text overwritten or property requiredness drift → preserve dirty value and fall back to manual note. |
| DS3-P1 | T1 / people-card/contact-agency | S0-PANEL, S0-PANE | apps/mail/components/nava-pane/nava-pane.tsx<br>apps/mail/components/quote-workflow/quote-workflow-panel.tsx<br>apps/mail/components/quote-workflow/quote-people-step.tsx<br>apps/mail/tests/quote-people-step.test.tsx | 90–170 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/quote-people-step.test.tsx — editing Contact remains request-scoped and Agency remains a distinct HMS profile. | HRCEN and HRDAV / read-only; pass: no identity leakage, Contact and Agency remain distinct. | Contact/Company identity is merged or lost → restore separate canonical values/surfaces; never infer. |
| DS3-P2a | T1 / people-card/guest | DS3-P1 | apps/mail/components/quote-workflow/quote-people-step.tsx<br>apps/mail/tests/quote-people-step.test.tsx | 70–140 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/quote-people-step.test.tsx — an agent sender is not used as the guest when the parsed guest is missing. | HRCEN and HRDAV / read-only; pass: parsed guest or prompt, never agent sender. | Wrong guest classification → leave explicit prompt and editable fields; do not infer from sender alone. |
| DS3-P2b | T1 / Book/guest-prefill | DS3-P2a | apps/mail/components/quote-workflow/quote-people-step.tsx<br>apps/mail/components/quote-workflow/booking-card.tsx<br>apps/mail/tests/booking-card.test.tsx | 60–130 [U] | 0 | grok:cursor-grok-4.6-high | apps/mail/tests/booking-card.test.tsx — selected Guest prefills editable first/last fields distinct from Contact. | HRDAV / read-only preview; pass: correct staying guest is shown, distinct from Contact/booker. | Ambiguous name split → leave fields editable and ask; no sender fallback. |
| DS3-R | T1 / rate-choice/custom-code | — | apps/mail/components/quote-workflow/stay-rate-choice.tsx<br>apps/mail/tests/stay-rate-choice.test.tsx | 80–160 [U] | 0 | grok:cursor-grok-4.6-high | apps/mail/tests/stay-rate-choice.test.tsx — selecting Other then pencil-editing retains the custom code and authorization. | HRCEN and HRDAV / read-only HMS lookup; pass: typed rate remains selected and authorization remains. | Custom code loses selection or authorization → retain manual entry; never move it into filter/override control. |
| DS4-F1 | T1 / quote-queue/live-admission | DS1-P0, DS2-S1 | apps/server-pilot/src/ai/hms-jobs.ts<br>apps/server-pilot/src/ai/hms-availability.ts<br>apps/server-pilot/src/trpc/routes/rates.ts<br>apps/server-pilot/tests/hms-availability-probe.test.ts | 35–90 [U] | 0 | grok:cursor-grok-4.6-high | apps/server-pilot/tests/hms-availability-probe.test.ts — denied admission creates zero jobs. | HRDAV / read-only, one complete stay; pass: admitted request returns all-room snapshot, denied request queues none. | Flag-on mistaken for admission → keep fail-closed checks; no canary until P0 setup passes. |
| DS4-F2 | T1 / quote-workflow/Stay-bind | DS3-D, DS4-F1 | apps/mail/lib/quote-workflow/pane-stay-bind.ts<br>apps/mail/components/quote-workflow/quote-stay-step.tsx<br>apps/mail/tests/quote-workflow-panel.test.tsx | 40–90 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/quote-workflow-panel.test.tsx — admitted snapshot is scoped to the correct Stay; denied state has no selectable rows. | HRDAV / read-only; pass: correct Stay receives admitted snapshot and denied admission remains empty. | Snapshot binds to wrong stay or stale data → remove selectable result and keep staff on manual path. |
| DS4-G1 | T1 / rate-grid/session-shape | DS4-F2 | apps/mail/lib/quote-workflow/session.ts<br>apps/mail/lib/quote-workflow/types.ts<br>apps/mail/tests/quote-workflow-session.test.ts | 50–100 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/quote-workflow-session.test.ts — selected room/rate/board tuple survives session reload exactly. | HRDAV / read-only; pass: session selection matches the chosen tuple and no write occurs. | Session migration drops legacy state → preserve compatible defaults and fail closed on unknown tuple. |
| DS4-G2a | T1 / rate-grid/component | DS3-R, DS4-G1 | apps/mail/components/quote-workflow/stay-rate-grid.tsx<br>apps/mail/tests/stay-rate-grid.test.tsx | 70–120 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/stay-rate-grid.test.tsx — one cell click emits its exact room/rate/board tuple and displayed price. | HRDAV / read-only; pass: selected tuple equals the cell and no HMS mutation occurs. | Stale inventory, label-only match or rate edit clearing create-only Book fields → keep existing manual controls, verify code/price/inventory, preserve fields. |
| DS4-G2b | T1 / rate-grid/Stay-integration | DS4-G2a, DS3-D, DS3-P1, DS2-S3 | apps/mail/components/quote-workflow/quote-workflow-panel.tsx<br>apps/mail/components/quote-workflow/quote-stay-step.tsx<br>apps/mail/lib/quote-workflow/types.ts<br>apps/mail/tests/quote-workflow-panel.test.tsx | 60–100 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/quote-workflow-panel.test.tsx — a grid click updates exactly the selected Stay tuple. | HRDAV / read-only; pass: selected tuple matches Stay draft and no write occurs. | Integration drops custom rate/override or shares wrong Stay → restore prior controls; keep manual selection. |
| DS4-B1 | T1 / Book/client-fields | DS3-P2b, DS4-G2b | apps/mail/components/quote-workflow/booking-card.tsx<br>apps/mail/lib/quote-workflow/pane-stay-bind.ts<br>apps/mail/components/quote-workflow/quote-booking-host.tsx<br>apps/mail/tests/booking-card.test.tsx | 80–150 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/booking-card.test.tsx — fields and caller props render; guestoptin4 is unchecked unless staff opts in. | HRDAV / Labtest preview only; pass: fields preview without Save and consent is not preselected. | Consent default or duplicate fields wrong → keep opt-in false and remove duplicate field rather than guessing. |
| DS4-B2 | T1 / Book/server-contract | DS1-P3a, DS4-B1 | apps/server-pilot/src/trpc/routes/quote-workflow.ts<br>apps/server-pilot/src/ai/pane-stay-save.ts<br>apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs<br>apps/server-pilot/tooling/playwright-quote/create-request.mjs<br>apps/server-pilot/tooling/playwright-quote/create-tool.schema.json<br>apps/server-pilot/tooling/playwright-quote/property-profile.mjs<br>apps/server-pilot/tooling/playwright-quote/property-profiles/HRCEN.json<br>apps/server-pilot/tooling/playwright-quote/property-profiles/HRDAV.json<br>apps/server-pilot/tests/pane-stay-save.test.ts | 100–180 [U] | 0 | grok:cursor-grok-4.6-high | apps/server-pilot/tests/pane-stay-save.test.ts — missing required field refuses before spawn and valid fields survive serialization. | HRDAV / Labtest preview only; pass: fields survive serialization and no save is invoked. | Unknown property contract or schema mismatch → refuse before spawn; keep no-save fallback. |
| DS4-K1 | T1 / PDF/durable-job | — | apps/server-pilot/src/ai/quote-pdf-jobs.ts<br>apps/server-pilot/src/trpc/routes/workstation.ts<br>apps/server-pilot/src/ai/worker.ts<br>apps/server-pilot/tests/quote-pdf-jobs.test.ts | 120–190 [U] | 0 | grok:cursor-grok-4.6-high | apps/server-pilot/tests/quote-pdf-jobs.test.ts — duplicate key returns one persisted result across worker restart. | HRDAV / read-only quote; pass: same artifact is available after restart, with no send/attach. | Ledger cannot safely persist result → stop and design against the existing ledger; no ad-hoc queue. |
| DS4-K2 | T1 / PDF/client-rehydrate | DS4-K1, S0-PANE | apps/mail/components/nava-pane/use-quote-pdf-job.ts<br>apps/mail/components/nava-pane/reply-body.tsx<br>apps/mail/tests/outlook-pane-quote-pdf.test.tsx | 60–120 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/outlook-pane-quote-pdf.test.tsx — switching away and back rehydrates the same job/artifact. | HRDAV / read-only quote; pass: same job/artifact returns after switch and no mail is sent. | Stale revision/owner mismatch → refuse the old job and require staff to regenerate explicitly. |
| DS4-Lease-0 | T1 / HMS/session-lease-core | — | apps/server-pilot/tooling/playwright-quote/slot-owner.mjs<br>apps/server-pilot/tooling/playwright-quote/session-reuse.mjs<br>apps/server-pilot/src/hms/property-read-lock.ts<br>apps/server-pilot/tooling/playwright-quote/hms-slot-lease.mjs<br>apps/server-pilot/tests/hms-slot-session.test.ts | 120–195 [U] | 0 | grok:cursor-grok-4.6-high | apps/server-pilot/tests/hms-slot-session.test.ts — same authenticated page is reused; stale generation refuses. | HRCEN and HRDAV / read-only; pass: authenticated same-property lease under one lock. | Unknown property, stale lease or lock loss → fail closed and release only owned session state. |
| DS4-Lease-R | T1 / HMS/session-lease-read-callers | DS4-Lease-0, DS1-P3a, DS4-B2 | apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs<br>apps/server-pilot/tooling/playwright-quote/party-lookup.mjs<br>apps/server-pilot/tooling/playwright-quote/property-profile.mjs<br>apps/server-pilot/tooling/playwright-quote/find-batch.mjs<br>apps/server-pilot/tooling/playwright-quote/stay-lookup.mjs<br>apps/server-pilot/tooling/playwright-quote/read-reservation-codes.mjs<br>apps/server-pilot/tooling/playwright-quote/read-reservation-fields.mjs<br>apps/server-pilot/tooling/playwright-quote/create-preflight.mjs<br>apps/server-pilot/tooling/playwright-quote/hms-deeplink-probe.mjs<br>apps/server-pilot/tests/session-lease-read-tools.test.ts | 120–190 [U] | 0 | grok:cursor-grok-4.6-high | apps/server-pilot/tests/session-lease-read-tools.test.ts — omitted property refuses and read callers share the lease. | HRCEN and HRDAV / read-only; pass: correct property and one lease per tool. | Unknown property or missing registration → refuse before page creation; no HRCEN default. |
| R-SEED | T1 / rate-history/corpus-seed | T1_BASE_COMPLETE, R-CORPUS | apps/server-pilot/src/ai/quote-ready.ts<br>apps/server-pilot/src/ai/rate-history-seed.ts<br>apps/server-pilot/tests/rate-history-seed.test.ts<br>docs/research/2026-10-26-run2-rate-seed-eval.md<br>docs/research/README.md<br>docs/research/CATALOG.md | 100–180 [U] | 0 | luna:gpt-6-luna-max | apps/server-pilot/tests/rate-history-seed.test.ts — stable priors reorder all nine without pruning and unknown key falls back to profile order. | HRDAV / read-only plus offline held-out eval; pass: n≥100 independent rows reported, seeded order's top-1/top-3 counted, all nine remain. | Join/label leakage or n<100 → retain P3b profile order and do not ship the seed. |
| DS4-H1 | T2 / work-item/provenance-query | T1_COMPLETE | apps/server-pilot/src/ai/work-items.ts<br>apps/server-pilot/src/trpc/routes/work-items.ts<br>apps/server-pilot/tests/work-items.test.ts | 80–150 [U] | 0 | luna:gpt-6-luna-max | apps/server-pilot/tests/work-items.test.ts — latest event returns the correct source and value per field. | Synthetic work item / no HMS; pass: returned source labels match append-only events. | Unknown event source → return unknown and hide provenance; never infer AI from current value. |
| DS4-H2 | T2 / work-item/provenance-ui | T1_COMPLETE, DS4-H1 | apps/mail/components/nava-pane/screens/needs-you.tsx<br>apps/mail/components/nava-pane/screens/work-item-field-provenance.tsx<br>apps/mail/tests/needs-you.test.tsx | 70–120 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/needs-you.test.tsx — AI/edit/reset marker follows source state and survives reopen. | Synthetic work item / no HMS; pass: labels match stored events across reopen. | Marker claims unsupported source → hide marker unless H1 evidence exists. |
| DS4-I | T2 / work-item/reset-section | T1_COMPLETE, DS4-H2 | apps/server-pilot/src/ai/work-items.ts<br>apps/server-pilot/src/trpc/routes/work-items.ts<br>apps/server-pilot/src/db/schema/work.ts<br>apps/mail/components/nava-pane/screens/needs-you.tsx<br>apps/server-pilot/tests/work-items.test.ts | 100–180 [U] | 0 | luna:gpt-6-luna-max | apps/server-pilot/tests/work-items.test.ts — reset changes only selected section and appends events. | Synthetic work item / no HMS; pass: selected section restores while other fields remain unchanged. | Partial transaction or empty AI value → rollback the section and omit fields without an extraction value. |
| DS4-J1 | T2 / work-item/undo-redo-server | T1_COMPLETE, DS4-I | apps/server-pilot/src/ai/work-items.ts<br>apps/server-pilot/src/trpc/routes/work-items.ts<br>apps/server-pilot/src/db/schema/work.ts<br>apps/server-pilot/src/db/migrations/<next>_work-item-revision.sql<br>apps/server-pilot/tests/work-items.test.ts | 130–195 [U] | 0 | grok:cursor-grok-4.6-high | apps/server-pilot/tests/work-items.test.ts — undo then redo restores values and appends two events. | Synthetic work item / no HMS; pass: history is append-only and values restore at both cursor boundaries. | History mutation or cursor race → transactionally refuse stale revision and preserve prior events. |
| DS4-J2 | T2 / work-item/undo-redo-ui | T1_COMPLETE, DS4-J1 | apps/mail/components/nava-pane/screens/needs-you.tsx<br>apps/mail/lib/quote-workflow/use-work-item.ts<br>apps/mail/components/nava-pane/screens/work-item-history-controls.tsx<br>apps/mail/tests/needs-you.test.tsx | 50–110 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/needs-you.test.tsx — controls disable at server history boundaries. | Synthetic work item / no HMS; pass: values/history follow the server cursor. | Client-only cursor drift → hide controls until server state is refreshed. |
| DS4-L1 | T2 / Book/preview-persistence | T1_COMPLETE, DS4-J2, DS4-B2 | apps/server-pilot/src/ai/work-items.ts<br>apps/server-pilot/src/ai/pane-stay-save.ts<br>apps/server-pilot/src/trpc/routes/quote-workflow.ts<br>apps/server-pilot/tests/pane-stay-save.test.ts | 100–180 [U] | 0 | grok:cursor-grok-4.6-high | apps/server-pilot/tests/pane-stay-save.test.ts — preview survives service restart and digest change invalidates it. | HRDAV / Labtest preview, no save; pass: restored preview matches the same digest. | Stale or cross-work-item grant → invalidate and require fresh preview; no reusable credential. |
| DS4-L2 | T2 / Book/client-preview-rehydrate | T1_COMPLETE, DS4-L1, DS4-B1 | apps/mail/components/quote-workflow/booking-card.tsx<br>apps/mail/components/quote-workflow/use-pane-stay-preview.ts<br>apps/mail/tests/booking-card.test.tsx | 60–120 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/booking-card.test.tsx — preview restores after remount and clears on digest mismatch. | HRDAV / Labtest preview only; pass: preview persists across remount with no Save. | Preview reappears for changed input → clear on digest mismatch and require preview again. |
| DS4-Lease-W | T2 / HMS/session-lease-write-callers | T1_COMPLETE, DS4-Lease-0, DS4-B2 | apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs<br>apps/server-pilot/tooling/playwright-quote/amend-stay.mjs<br>apps/server-pilot/tooling/playwright-quote/cancel-stay.mjs<br>apps/server-pilot/tooling/playwright-quote/cancel-lab-stay.mjs<br>apps/server-pilot/tooling/playwright-quote/attach-document.mjs<br>apps/server-pilot/tests/session-lease-write-tools.test.ts | 110–190 [U] | 0 | grok:cursor-grok-4.6-high | apps/server-pilot/tests/session-lease-write-tools.test.ts — missing property refuses before page creation or write. | Registered property / Labtest only; pass: preapproved operation uses one lease and has readback. | Unknown property or lease loss → refuse before write; no HRCEN CLI fallback. |
| DS4-M1 | T3 / T3-HOLD/commit-job | DS4-B2, DS4-K1, DS4-L1, OWNER_APPROVAL | apps/server-pilot/src/ai/pane-stay-commit-job.ts<br>apps/server-pilot/src/ai/worker.ts<br>apps/server-pilot/src/trpc/routes/quote-workflow.ts<br>apps/server-pilot/src/ai/pane-stay-save.ts<br>apps/server-pilot/src/ai/work-items.ts<br>apps/server-pilot/tests/quote-workflow-router.test.ts | 140–195 [U] | 0 | grok:cursor-grok-4.6-high | apps/server-pilot/tests/quote-workflow-router.test.ts — future concurrent same-key requests cause one create. | HRDAV / Labtest only in a future authorized run; pass: one confirmation/readback for retries. Not run tonight. | No current real-guest authorization → no action; future ambiguous result stays needs-check, no retry. |
| DS4-M2 | T3 / T3-HOLD/commit-client | DS4-M1, DS4-L2, OWNER_APPROVAL | apps/mail/components/quote-workflow/booking-card.tsx<br>apps/mail/components/quote-workflow/use-pane-stay-job.ts<br>apps/mail/tests/booking-card.test.tsx | 60–130 [U] | 0 | luna:gpt-6-luna-max | apps/mail/tests/booking-card.test.tsx — future repeat click while pending invokes one job. | HRDAV / Labtest only in a future authorized run; pass: one confirmation/readback. Not run tonight. | Duplicate click/retry could double-book → keep commit disabled and hold the unit. |

### U01. S0-PANE — Pure-move auto-start and PDF branches out of NavaPane

**Source:** DS3 S0-Auto1/Auto2 and DS4 S0-N1/N2. **Tier:** T0. **Owner:** luna:gpt-6-luna-max. **LOC:** 415–610 [U]. **pure_move:** 1.

**Exact implementation steps**

1. Move the auto-start body unchanged into use-staff-quote-autostart.ts, then move its trigger effect/dependencies into the same hook.
2. Move combined-PDF and single-stay-PDF branches unchanged into use-quote-pdf-job.ts; leave root callback seams intact.
3. Preserve effects, callback order, work-item identity and rendered output; add no debounce, persistence, behavior or new flags in this PR.

**Gate:** Remote mail typecheck and targeted tests on the same head; all listed unchanged UI tests green; pure_move=1.

### U02. S0-PANEL — Pure-move every inline panel card/step in one PR

**Source:** DS3 S0-P1/P2/S1–S5/Docs plus DS4 S0-Q1/Q2/Q3. **Tier:** T0. **Owner:** luna:gpt-6-luna-max. **LOC:** >500 aggregate [U]. **pure_move:** 1.

**Exact implementation steps**

1. In one pure-move PR, extract the Agency/company renderer and Step 1 wrapper to quote-people-step.tsx; extra helpers/conditional controls to stay-extras-fields.tsx; the Stay map/card to quote-stay-step.tsx; Documents to quote-documents-step.tsx.
2. Extract RatePlanSelect to rate-plan-select.tsx, RatesBarGrid to rates-bar-grid.tsx with typed but inert plan/cell callback seams, and BookingCards caller to quote-booking-host.tsx.
3. Update only imports/props needed to preserve the exact DOM, order, labels, callbacks, data flow and render; Q3's nava-pane.tsx touch is why S0-PANE must merge first.
4. Do not implement rate-grid behavior, persisted props, Reservation Note changes or other feature work here; modify no existing tests or snapshots.

**Gate:** Remote mail typecheck plus all named unchanged tests on the same head; no snapshot updates; pure_move=1; merge-gate exemption only for size.

### U03. S0-JOBS — Pure-move prepared-quote cap seam

**Source:** DS1 S0. **Tier:** T0. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 125–180 [U]. **pure_move:** 1.

**Exact implementation steps**

1. Move enqueuePreparedQuoteWithinCap from hms-jobs.ts into prepared-quote-queue.ts.
2. Preserve the existing lock, idempotency key, count, cap and enqueue semantics exactly; keep a compatibility export so existing imports/tests need no edits.
3. No queue tuning or behavior changes in this PR.

**Gate:** Remote server-pilot typecheck and unchanged targeted test on the same head; pure_move=1.

### U04. R-CORPUS — Count Da Vinci auto-letters, human quotes and guest/booker mismatches

**Source:** DS1 read-only SQL plus coordinator D7. **Tier:** T0. **Owner:** luna:gpt-6-luna-max. **LOC:** 0 product LOC. **pure_move:** 0.

**Exact implementation steps**

1. Use the DS1 outbound SQL shape for a 30-day davinci@ outbound split of HMS auto-letter candidates versus human-quote candidates; first verify the actual attachment table and columns and use message.message_id_header, leaving ambiguous rows unclassified.
2. Add a second aggregate for HMS confirmation letters and their unambiguously linked inbound requests; compare normalized booker/contact versus guest inside the read-only query and return equal/mismatch/unmatched/unknown counts only, never the compared values.
3. Use message.message_id_header and verify the actual attachment table/columns before joining; run only via apps/server-pilot/deploy/ssm-run-command.sh inside BEGIN READ ONLY … ROLLBACK, then save aggregate counts, denominator, date window, schema checked and query in the research artifact.

**Gate:** Independent query review; verify BEGIN READ ONLY/ROLLBACK and aggregate-only output; update research index/catalog.

### U05. DS1-P0 — Complete generic HRDAV installation and quote policies

**Source:** DS1 P0 plus coordinator D6. **Tier:** T1. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 110–190 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Implement safe ownerRef/property resolution and fail closed on missing or mismatched HRDAV installation; inventory HRCEN defaults before changing any fallback.
2. Create the HRDAV install descriptor and one current-schema policy per transport: davinci, faith, ayanda, epick and kmgidi; never commit credentials or secret values.
3. On EC2 via SSM, verify the secret file path from /etc/nava/hms-slot-hrdav.env or hms-slot-hrdav-install.sh without printing contents; install policies and allowlisted env.
4. Set HMS_DAVINCI_MAKE_QUOTE=on, HMS_JOB_QUEUE=on, HMS_QUOTE_PREPARE=on, HMS_QUOTE_PREPARE_PER_HOUR=6 and HRDAV configuration on http/worker/ai-worker plus remote-http only if it reads them; restart with correct env sources and verify each /proc/<pid>/environ before enqueue.
5. Only then re-queue today's eligible Da Vinci quote mails and require the first succeeded background staff_quote on HRDAV; do not send mail, Save, book or amend.

**Gate:** Code gates first. Live env/requeue requires same-execution-session owner authority; no approval may be relayed. Preflight all pm2 processes before first enqueue.

### U06. DS1-P1 — Persist prepare decisions and skip reasons

**Source:** DS1 P1. **Tier:** T1. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 80–150 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Persist quotePrepareDecisions[] to ai_workflow_run.metrics under the existing lock.
2. Record every early return/refusal reason and caught error without PII; keep the original queue decision/return semantics.
3. Use the extracted pure queue seam and leave hms-jobs.ts changes owned only by this lane until merge.

**Gate:** Remote server-pilot gates; serialize hms-jobs.ts with P2, S1, F1 and P3b.

### U07. DS1-P2 — Defer cap overflow with nextRunAt

**Source:** DS1 P2. **Tier:** T1. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 120–195 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Add a reusable prefetch-capacity helper around the existing hourly cap.
2. When capacity is full, retain the prepared quote work with nextRunAt instead of dropping it; keep the existing queue lock and idempotency.
3. Re-check source identity and readiness when the deferred job wakes; never delete queue/ledger rows to reduce backlog.

**Gate:** Remote server-pilot gates; follows DS1-P1 to keep hms-jobs/queue files exclusive.

### U08. DS1-P3a — Move strategy catalogue into property profiles

**Source:** DS1 P3a. **Tier:** T1. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 80–160 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Move current HRCEN strategy values out of rate-catalogue.ts into the registered HRCEN profile; HRDAV remains its configured nine strategies.
2. Validate a profile's strategies generically and fail closed for missing/invalid profile data.
3. Keep property selection registry-driven; do not add hotel-name branches or a third-property special case.

**Gate:** Remote server-pilot gates; DS4-B2 and Lease-R wait before touching shared profile files.

### U09. DS1-P3b — Log successful staff picks and rank all nine strategies

**Source:** DS1 P3b. **Tier:** T1. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 120–195 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Add the successful staff pick (strategy, property, transport/mailbox, opaque bound party/agency/company ref, staff actor ID and mail kind) to quote.prepared evidence/hash; never store user name/email or mail content.
2. Rank BAR when configured, then mailbox history, bound agency/company history, then profile order; emit every configured strategy for every stay.
3. With no trusted history, fall back to profile order; do not prune strategies, use sender regex labels as truth, or default Government.

**Gate:** Remote server-pilot gates; last hms-jobs.ts owner after DS4-F1; R-SEED later adds corpus priors.

### U10. DS2-S1 — Persist party prefetch and readback for eligible mail

**Source:** DS2 S1. **Tier:** T1. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 90–190 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Use NEEDS_YOU_KINDS as the kind baseline; broaden both quote-only gates while retaining inbound, spam/history, self-mail, cap and live-admission guards.
2. Persist property-scoped party readback without the 24-hour age filter; retain createdAt/asOf and surface explicit skip reasons.
3. Remove hard-coded cross-property refusal copy; missing admission snapshot remains a skip, never a backfill live HMS read.

**Gate:** Remote server-pilot gates; must own hms-jobs.ts after DS1-P2 and before DS4-F1.

### U11. DS2-S2 — Show age-aware party recommendation and require confirmation

**Source:** DS2 S2. **Tier:** T1. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 45–135 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Use DS2-S1's durable property-scoped result and asOf age in the party picker.
2. Show a recommendation with enough profile context to distinguish matches; staff must confirm before it binds.
3. Do not auto-bind a party, cross property, or substitute sender/contact for guest.

**Gate:** Remote mail tests; DS3-C waits because both own party-picker.tsx.

### U12. DS2-S3 — Keep late stored reads from triggering duplicate live reads

**Source:** DS2 S3. **Tier:** T1. **Owner:** luna:gpt-6-luna-max. **LOC:** 40–130 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Separate stored read results from live-read state in use-work-item.ts and the pane/panel host.
2. If a stored read arrives after a live timeout, render it without starting a second live HMS read.
3. Preserve the single property lock and existing admission/snapshot rules.

**Gate:** Remote mail tests; serialized after DS3-P1 on nava-pane.tsx and quote-workflow-panel.tsx.

### U13. DS2-S4 — Expose exact Outlook EntryID and canonical source message ID

**Source:** DS2 S4. **Tier:** T1. **Owner:** luna:gpt-6-luna-max. **LOC:** 20–55 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Project sourceProvenance.evidence.locator.entryId as nullable outlookEntryId and expose canonical sourceMessageId in listWorkItems.
2. Return null for legacy/non-Outlook rows; do not expose full provenance.
3. Keep Outlook EntryID and webmail source message ID distinct.

**Gate:** Remote server-pilot and mail contract tests; T2 work-items edits start only after T1 completes.

### U14. DS2-S5 — Gate Needs-you controls and open the exact source message

**Source:** DS2 S5. **Tier:** T1. **Owner:** luna:gpt-6-luna-max. **LOC:** 60–150 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Add one default-off feature constant to gate both NeedsYouEntry and NeedsYouWebControl; keep the existing Needs-you list itself.
2. In Outlook, call displayMessageForm with the exact outlookEntryId; in webmail, pass sourceMessageId with threadId and select/scroll to that exact message.
3. Keep dismiss separate and provide a manual-search hint when host APIs/IDs are missing.

**Gate:** Remote mail tests; list remains available and controls are feature-gated.

### U15. DS3-A — Debounce staff quote auto-start until a complete date pair

**Source:** DS3 A. **Tier:** T1. **Owner:** luna:gpt-6-luna-max. **LOC:** 60–130 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Add a short trailing debounce to the extracted auto-start hook; cancel on partial/changed dates.
2. Retain the existing incomplete-date guard and do not duplicate date clearing or add a second gate.
3. Leave all live-read/queue admission checks intact.

**Gate:** Remote mail typecheck/tests; no snapshots.

### U16. DS3-C — Deduplicate overlapping party lookup and queue status

**Source:** DS3 C. **Tier:** T1. **Owner:** luna:gpt-6-luna-max. **LOC:** 80–150 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Select one readable status line per active job when party lookup and quote-queue status overlap.
2. Keep failure/retry labels and the aggregate count chip; do not reduce all jobs to one status total.
3. Use one accessible role=status for the overlapping active job.

**Gate:** Remote mail tests; start after DS2-S2 releases party-picker.tsx.

### U17. DS3-D — Place extras inside each Stay and name duplication clearly

**Source:** DS3 D. **Tier:** T1. **Owner:** luna:gpt-6-luna-max. **LOC:** 50–110 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Render extras/actions inside the Stay article instead of as its sibling.
2. Rename the action to Duplicate stay while retaining the existing duplicate_stay event.
3. If content clips, fix inner overflow rather than moving extras back outside.

**Gate:** Remote mail tests; serialized before F2/G2 panel work.

### U18. DS3-E1 — Build Reservation Note from final stay, rate and extras

**Source:** DS3 E1. **Tier:** T1. **Owner:** luna:gpt-6-luna-max. **LOC:** 80–160 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Extend the shared formatter input from the final stay/rate/extras data shape produced by G1.
2. Format only selected final values; keep property-specific requirements out of hotel-name branches.
3. Keep the current manual note path when values are stale or missing.

**Gate:** Remote mail tests; no write or mail send.

### U19. DS3-E2 — Bind the generated note to editable Book Reservation Note

**Source:** DS3 E2. **Tier:** T1. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 100–190 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Bind E1's final formatted note into the editable Book Reservation Note field and remove the separate Step 2 note step.
2. Preserve dirty staff text; regenerate only by explicit staff action after source values change.
3. Keep requiredness property-config-driven; live proof is Labtest only and must include save/readback.

**Gate:** Remote mail tests; any Labtest save needs preflight and same-session authority; never real guest.

### U20. DS3-P1 — Put Contact and Agency into the People step

**Source:** DS3 P1. **Tier:** T1. **Owner:** luna:gpt-6-luna-max. **LOC:** 90–170 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Move Contact and Agency into the extracted People card and remove the duplicate pane Contact surface.
2. Keep Contact request-scoped/PDF-only and Agency bound to its HMS profile; do not conflate them.
3. Preserve Company as a distinct existing value; the agreed three-row layout does not authorize mapping Company into Agency or deleting it.

**Gate:** Remote mail tests; this owns pane/panel shell before DS2-S3 and G2b.

### U21. DS3-P2a — Show the staying Guest separately from the Contact

**Source:** DS3 P2a. **Tier:** T1. **Owner:** luna:gpt-6-luna-max. **LOC:** 70–140 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Add a Guest row: direct request defaults Guest to Contact; an agent/different guest uses a parsed guest name or asks for Guest name?.
2. Never substitute the sender/booker when the guest is missing; keep uncertain values editable and prompt staff.

**Gate:** Remote mail tests; sequential owner of the shared People component.

### U22. DS3-P2b — Prefill editable Book names from selected Guest

**Source:** DS3 P2b. **Tier:** T1. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 60–130 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Feed the selected Guest to Book first/last fields separately from Contact/booker.
2. Keep first/last editable; if name splitting is ambiguous, preserve editable fields and ask staff.
3. Do not perform a real HMS save in this slice.

**Gate:** Remote mail tests; serialize before DS4-B1 and DS3-E2 on booking-card.tsx.

### U23. DS3-R — Keep Other rate selectable and editable

**Source:** DS3 R. **Tier:** T1. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 80–160 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Add Other rate at the bottom of the actual room selector, not the Showing rates for filter.
2. Allow pencil-edit of the typed custom code while keeping the code selected; preserve Authorised by.
3. If no match is found, retain the manual code rather than dropping it.

**Gate:** Remote mail tests; G2a consumes this component after it merges.

### U24. DS4-F1 — Gate quote prefetch on live hotel-read admission

**Source:** DS4 F / DS3 ownership split F1. **Tier:** T1. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 35–90 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Add a live hotel-read admission check before enqueueing all-room quote prefetch; retain flag/run-kind checks.
2. Preserve the hourly cap and per-stay idempotency; never enqueue when admission is denied.
3. Keep server-only ownership of hms-jobs.ts, hms-availability.ts and routes/rates.ts.

**Gate:** Remote server-pilot gates; after DS2-S1 to serialize hms-jobs.ts.

### U25. DS4-F2 — Bind admitted availability snapshot to the Stay step

**Source:** DS3 DS4 ownership split F2. **Tier:** T1. **Owner:** luna:gpt-6-luna-max. **LOC:** 40–90 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Bind the live-admitted all-room availability result to the extracted Stay step using the existing stay identity.
2. Keep missing/denied admission explicit; do not make a live read from render or let a stale snapshot become quote authority.
3. Keep this Stay-bind file set separate from server-side F1.

**Gate:** Remote mail tests; after D and F1, before G1.

### U26. DS4-G1 — Persist a typed room/rate/board selection in quote session

**Source:** DS3/DS4 G1 ownership split. **Tier:** T1. **Owner:** luna:gpt-6-luna-max. **LOC:** 50–100 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Extend the session data shape to represent the exact room, rate and board tuple selected from a Stay grid.
2. Round-trip the tuple without changing existing saved session values or property-specific price/availability data.
3. Keep the tuple as staff selection, not as proof that a quote is valid.

**Gate:** Remote mail tests; source-shape owner before grid component.

### U27. DS4-G2a — Build the typed room/rate/board grid

**Source:** DS3/DS4 G2a ownership split. **Tier:** T1. **Owner:** luna:gpt-6-luna-max. **LOC:** 70–120 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Add stay-rate-grid.tsx with room/rate/board cells, nightly price and rooms-left from the admitted result; bind a rate row by code plus per-night price/inventory, not label alone.
2. On click, emit the exact room/rate/board tuple; preserve Other/custom rate choices and staff overrides.
3. Treat stale availability as display evidence only, never quote authority.
4. When the tuple changes, preserve Book create-only fields; do not let a rate edit clear unrelated fields.

**Gate:** Remote mail tests; new isolated component, after G1 and DS3-R.

### U28. DS4-G2b — Integrate room/rate/board grid into Stay

**Source:** DS3/DS4 G2b ownership split. **Tier:** T1. **Owner:** luna:gpt-6-luna-max. **LOC:** 60–100 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Replace the separate plan selector/read-only rates step with the G2a grid inside Stay.
2. A staff cell click sets the exact room/rate/board tuple in the draft; retain Other, custom rate and override controls.
3. Remove the standalone rate step only after grid render and Stay-state integration are green.

**Gate:** Remote mail tests; serialized after DS2-S3/DS3-P1/DS3-D and after G2a.

### U29. DS4-B1 — Expose Market Segment and explicit guest opt-in in Book

**Source:** DS4 B1. **Tier:** T1. **Owner:** luna:gpt-6-luna-max. **LOC:** 80–150 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Add generic Market Segment and guestoptin4 controls to the client contract and pass work-item/saved-Stay props through quote-booking-host.
2. Do not pre-check legal consent; guest opt-in remains false unless staff explicitly selects it.
3. Keep existing Track/SOB controls and avoid repeating canonical Stay/contact fields.

**Gate:** Remote mail tests; after G2b/P2b; serialize before E2 on booking-card.tsx.

### U30. DS4-B2 — Validate and map Book fields through the server contract

**Source:** DS4 B2. **Tier:** T1. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 100–180 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Validate and serialize Market Segment and guestoptin4 through the tRPC route, request schema, create tool and property profile.
2. Derive required fields/options from generic property profiles; fail before worker spawn when required data is absent.
3. Keep guest opt-in explicit and never introduce HRCEN/HRDAV branches in shared code.

**Gate:** Remote server-pilot typecheck/tests; profile ownership serial after P3a, before Lease-R/Lease-W.

### U31. DS4-K1 — Persist PDF generation job by work item and quote revision

**Source:** DS4 K1. **Tier:** T1. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 120–190 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Replace synchronous PDF mutation with a durable job keyed by work item and quote revision, queryable after client disconnect.
2. Prefer the existing durable run ledger if it supports payload/result; do not add a one-off queue or email side effect.
3. Keep PDF generation separate from sending/attaching mail.

**Gate:** Remote server-pilot gates; K2 waits for this durable result contract.

### U32. DS4-K2 — Rehydrate the same PDF job after switching mail or pane

**Source:** DS4 K2. **Tier:** T1. **Owner:** luna:gpt-6-luna-max. **LOC:** 60–120 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Make the extracted PDF hook poll/rehydrate K1 by work-item ID after mail/pane switch.
2. Preserve quote revision and owner checks; do not regenerate on remount.
3. Do not attach or send the PDF.

**Gate:** Remote mail tests; after S0-PANE and K1.

### U33. DS4-Lease-0 — Create an exclusive authenticated page lease

**Source:** DS4 Lease-0. **Tier:** T1. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 120–195 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Wrap the persistent slot in an exclusive page lease; verify shell/property, lock ownership and recovery generation, then release safely.
2. Reuse existing 0600 storageState; do not create another login/page when the lease can reuse the current authenticated page.
3. Refuse unknown property or stale generation before any HMS action.

**Gate:** Remote server-pilot tests; one browser lock per property.

### U34. DS4-Lease-R — Route every read CLI through the property-bound lease

**Source:** DS4 Lease-R. **Tier:** T1. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 120–190 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Migrate each listed read CLI to Lease-0 and require explicit registered property.
2. Remove HRCEN defaults and resolve target from property registry/profile; no hidden fallback.
3. Preserve read-only behavior and shared lock; fail closed on unknown/inactive property.

**Gate:** Remote server-pilot tests; waits for Lease-0, P3a and B2 profile ownership.

### U35. R-SEED — Seed likely-first rate ranking from held-out past staff quotes

**Source:** Run-2 decision record row 14 / ask 229; not added to plan frontmatter asks. **Tier:** T1. **Owner:** luna:gpt-6-luna-max. **LOC:** 100–180 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Backfill per mailbox × sender/agency × rate counts from past outbound staff PDFs/HMS letters joined to inbound; use verified rate codes, not S5 regex labels.
2. Apply counts only as an ordering prior before profile order; continue shopping all nine strategies and keep a profile-order fallback.
3. Split held-out threads by stable thread ID before analysis; run baseline ranking twice and report held-out top-1/top-3 with n/source. Do not tune on held-out rows.
4. Do not commit mail bodies, guest names, email addresses or raw corpus rows; if fewer than 100 independent held-out rows remain, leave code unchanged and report the gap.

**Gate:** Last T1 slice after every other T1 merge; remote gates and independent held-out evaluation.

### U36. DS4-H1 — Return latest per-field provenance from append-only work events

**Source:** DS4 H1. **Tier:** T2. **Owner:** luna:gpt-6-luna-max. **LOC:** 80–150 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Use existing work_event source/AI/staff values to query latest provenance per field, scoped to mailbox/work item.
2. Add no new table; return unknown provenance as unknown rather than inferring from current field value.
3. Expose only the minimum UI projection needed for field labels.

**Gate:** T2 only after T1_COMPLETE; remote server-pilot gates.

### U37. DS4-H2 — Show AI/source marker on supported editable fields

**Source:** DS4 H2. **Tier:** T2. **Owner:** luna:gpt-6-luna-max. **LOC:** 70–120 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Add a small field-provenance component driven only by the H1 response beside supported Needs-you fields.
2. Show source/value markers only when the server reports provenance; keep unknown fields unmarked.
3. Do not add a new pane-level status banner or infer origin.

**Gate:** T2 after H1 and all T1 UI ownership is released.

### U38. DS4-I — Reset one section atomically to extraction values

**Source:** DS4 I. **Tier:** T2. **Owner:** luna:gpt-6-luna-max. **LOC:** 100–180 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Add atomic section reset to extraction values, update current state and append reset events for changed fields.
2. Reuse the existing work_event table; skip fields with no AI value.
3. Do not trigger HMS reads or writes.

**Gate:** T2 after H2; serialize work-items and needs-you files.

### U39. DS4-J1 — Append undo/redo revisions without mutating work history

**Source:** DS4 J1. **Tier:** T2. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 130–195 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Add transactional per-work-item revision cursor and server undo/redo events.
2. Never update/delete prior work_event rows; use the existing event table and one migration for revision state.
3. Undo/redo affects pane data only and has no HMS side effect.

**Gate:** T2 after I; migration reviewed and remote DB-backed tests on approved EC2.

### U40. DS4-J2 — Expose server-backed Undo and Redo controls

**Source:** DS4 J2. **Tier:** T2. **Owner:** luna:gpt-6-luna-max. **LOC:** 50–110 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Add per-to-do Undo/Redo controls driven by J1 server revision cursor, not a React-only stack.
2. Keep controls inside the to-do component and disable them at history boundaries.
3. Do not roll back or mutate HMS.

**Gate:** T2 after J1 and H/I file owners.

### U41. DS4-L1 — Persist preview result by work item, Stay and digest

**Source:** DS4 L1. **Tier:** T2. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 100–180 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Persist preview result/grant by work item, Stay and digest; expire/invalidate when input changes.
2. Use durable status/digest, never a reusable secret token; stale digest requires a fresh preview.
3. Do not execute Save as part of preview persistence.

**Gate:** T2 after J2 and B2; remote server-pilot gates.

### U42. DS4-L2 — Rehydrate Book preview after card remount

**Source:** DS4 L2. **Tier:** T2. **Owner:** luna:gpt-6-luna-max. **LOC:** 60–120 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Rehydrate L1 preview using work-item/Stay identity and digest after BookingCard remount.
2. Clear preview on digest mismatch; keep preview separate from Save.

**Gate:** T2 after L1/B1; remote mail tests.

### U43. DS4-Lease-W — Route writer CLIs through the exclusive property lease

**Source:** DS4 Lease-W. **Tier:** T2. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 110–190 [U]. **pure_move:** 0.

**Exact implementation steps**

1. Migrate create/amend/cancel/attach callers to the Lease-0 wrapper and require explicit registered property.
2. Remove create defaults and refuse unknown property before page creation/write.
3. Keep all live writers Labtest-only unless a later same-session owner authorization explicitly allows otherwise.

**Gate:** T2 after Lease-0/B2; any write proof needs current-session approval and complete preflight.

### U44. DS4-M1 — HOLD — idempotent Book commit job; not tonight

**Source:** DS4 M1 plus coordinator D3. **Tier:** T3. **Owner:** grok:cursor-grok-4.6-high. **LOC:** 140–195 [U]. **pure_move:** 0.

**Exact implementation steps**

1. T3 HOLD: do not launch or change code tonight; real-guest commit is not approved and the Labtest-only commit already exists.
2. In a future approved run only, add persisted idempotent job keyed by property/work-item/Stay/digest; ambiguous result becomes readback/needs-check, never blind replay.
3. Keep the read queue separate and require Labtest create/readback, same-session authority and full write preflight.

**Gate:** Not dispatchable tonight; future scope requires explicit owner approval and T1/T2 completion.

**Disposition:** T3 hold; do not launch tonight.

### U45. DS4-M2 — HOLD — Book client submit/poll for commit job; not tonight

**Source:** DS4 M2 plus coordinator D3. **Tier:** T3. **Owner:** luna:gpt-6-luna-max. **LOC:** 60–130 [U]. **pure_move:** 0.

**Exact implementation steps**

1. T3 HOLD: do not launch or change code tonight; M1 is also held and no real-guest commit is approved.
2. In a future approved run only, submit/poll the M1 job and reuse the same job on repeat click.
3. Keep Book disabled outside Labtest mode and require a single confirmation/readback.

**Gate:** Not dispatchable tonight; wait for M1 and explicit owner approval.

**Disposition:** T3 hold; do not launch tonight.

## Dependency DAG, T0 Set and Longest Chain

T0 set: S0-PANE, S0-PANEL, S0-JOBS, R-CORPUS. S0-PANE → S0-PANEL because Q3 touches nava-pane.tsx; S0-JOBS and R-CORPUS are independent. No DS2/DS3/DS4 feature slice starts before the T0 move that owns its source files has merged.

Queue/file-owner chain: S0-JOBS → DS1-P1 → DS1-P2 → DS2-S1 → DS4-F1 → DS1-P3b. This serializes every hms-jobs.ts owner. P3b also waits for P0 and P3a.

Pane/panel chain: S0-PANE → S0-PANEL → DS3-P1 → DS2-S3 → DS4-G2b → DS4-B1 → DS3-E2. This explicitly resolves DS2-S3 versus DS3's nava-pane/panel ownership and the DS3-P2b / DS4-B1 / DS3-E2 booking-card collision. Also serialize DS2-S2 → DS3-C on party-picker.tsx; DS3-D → DS4-F2 → DS4-G1 → DS4-G2a → DS4-G2b; DS3-R → DS4-G2a; DS3-P1 → DS3-P2a → DS3-P2b; DS4-G1 → DS3-E1 → DS3-E2; DS4-B1 → DS4-B2; DS1-P3a → DS4-B2 → DS4-Lease-R. DS4 K1 → K2 and S0-PANE → K2. DS4 Lease-0 → Lease-R and Lease-W. T2 chain: T1_COMPLETE → H1 → H2 → I → J1 → J2 → L1 → L2. Lease-W also waits for T1_COMPLETE, Lease-0 and B2.

T1_BASE_COMPLETE is a barrier after all 30 T1 units other than R-SEED have merged and passed their gates. R-SEED depends on T1_BASE_COMPLETE and R-CORPUS, and is the last T1 slice. T1_COMPLETE is the post-R-SEED barrier; T2 starts only after R-SEED and all other T1 gates are green. T3 is never dispatched tonight. The R-CORPUS read-only lane runs in T0 and is a required run deliverable, but it does not block unrelated code lanes.

Longest mandatory chain through T1 (13 slices; unique critical path): S0-JOBS → DS1-P1 → DS1-P2 → DS2-S1 → DS4-F1 → DS4-F2 → DS4-G1 → DS4-G2a → DS4-G2b → DS4-B1 → DS4-B2 → DS4-Lease-R → R-SEED. The longest optional extension is DS4-H1 → DS4-H2 → DS4-I → DS4-J1 → DS4-J2 → DS4-L1 → DS4-L2, for 20 slices total. Using the speed-analysis basis of 30 minutes implementation plus ~5 minutes gates per slice: mandatory T1 is 13 × 35 = 455 minutes (~7h35); T1 plus all T2 is 20 × 35 = 700 minutes (~11h40) code+gates. The measured historical merge-to-live deploy averaged ~8.5 minutes over 11 deploys; add one ~8.5-minute deploy train after T1/T2 as selected. The P0 SSM secret/config check, requeue and first successful background staff_quote have no measured elapsed time, and P1 repairs previously consumed 348 minutes across the run; therefore full production ETA is conditional: ~7h44m plus the unpriced P0 live-proof tail for required T1, ~11h49m plus that tail if all T2 runs. No hard deadline is inferred.

## Lane Plan (6–8 isolated lanes)

Start seven work lanes and reserve one slot for the queued S0-PANEL lane; never overlap S0-PANE/S0-PANEL.

| Slot | First assignment | Coder | Start condition / file lock |
|---|---|---|---|
| L1 | S0-PANE | Luna | T0; owns nava-pane extraction |
| L2 | S0-PANEL | Luna | T0, queued until S0-PANE merges because Q3 touches nava-pane.tsx |
| L3 | S0-JOBS | Grok | T0; owns hms-jobs queue extraction |
| L4 | R-CORPUS | Luna | T0 read-only SQL; no product code |
| L5 | DS1-P0 | Grok | T1 code can start at kickoff; defer SSM env/requeue until code gate and same-session authority |
| L6 | DS1-P3a | Grok | T1; owns catalogue/profile strategy data |
| L7 | DS2-S4 | Luna | T1; owns locator projection |
| L8 | DS3-R | Grok | T1; owns new custom rate-choice component |

The effective initial parallelism is seven until L2's file lock clears, then eight. Every lane receives one owned unit, its listed test set, and one brief from /tmp/or2/briefs. Use one clean worktree/branch per unit. Independent lanes branch from refreshed origin/main; dependent lanes start only after predecessors merge. Start the next startable non-conflicting unit as soon as a lane is released; do not wait idle for review. A coder may work on the next slice while review runs only if the orchestrator explicitly assigned a separate stacked branch and its files are disjoint. Keep no more than eight active coding/research lanes under this plan.

## Verification Contract

- For each code PR, the lane chains remote typecheck, targeted remote tests, and Greptile/Apex review in its own background job. Documented commands are bash /home/orca/bin/remote-typecheck.sh <worktree> --app <mail|server-pilot|all> and bash /home/orca/bin/remote-vitest.sh <worktree> <server-pilot|mail> <test files...>; use SKIP_TYPECHECK=1 only after a green same-head typecheck. Before first run, check current installed CLI/help and record version/path; run checks on final head SHA. Never run typecheck, Vitest, or any test runner on this VPS. For DB-backed tests, use the approved disposable remote DB path and confirm the suite did not silently skip.
- Required merge gate: Apex SUCCESS on head SHA, remote typecheck at baseline/no new errors, targeted tests pass, zero unvalidated/open P1, product LOC ≤500 unless pure_move=1, and coordinator diff review. Refresh origin/main before first review, then freeze the branch. Never merge a slice just because code/tests are green.
- Review path: one independent verifier per PR; Gemini 4 Argon High in review-only mode plus the required Greptile/Apex gate. At most two Greptile rounds. A real P1 is fixed on the same PR; round-3 fresh adjacent P1 means split/strip/redesign. Fixing a P1 restarts the relevant head-SHA gates.
- For UI slices, list all existing tests that assert removed UI in the lane brief; do not change snapshots in S0 and do not add UI snapshot tests. Validate Outlook and webmail parity.
- For each live HMS canary, use deterministic tools only, one hotel browser lock and a DOM-verified read-only probe before any batch. Verify semantic fields (rate code, nightly price, availability/rooms-left, property identity), not only process/artifact packaging. First Labtest Save per property/write type needs an all-blocker read-only preflight; long HMS jobs use background systemd-run/poll, and readback is part of pass. Use Labtest only for any write proof and only after preflight and same-session authority. No cancellation writes and no email sends. See docs/solutions/workflow-issues/hms-live-write-preflight-and-long-jobs.md and docs/solutions/workflow-issues/hms-live-proof-packaging-vs-payload-completeness.md.
- R-CORPUS runs via the approved SSM read-only SQL path with BEGIN READ ONLY and ROLLBACK; it reports only aggregate counts and schema evidence. No production writes or row-level exports.
- R-SEED's evaluation must use ≥100 independent outbound-grounded rows not produced by the system under test; name n and corpus source for every rate. Run baseline twice on the same held-out set; do not tune on holdout. A single run cannot pass/fail a change.

## Definition of Done

T1 is complete only when every mandatory T1 slice merges after its gates, all listed tests pass on the approved remote host, property-specific canaries pass on the post-fix head/deployed SHA, and the PRODUCT quote bars pass on the versioned independent truth set. The P0 canary must be the first succeeded background staff_quote on HRDAV after process-level env verification. Any UI deploy also requires a green viewer run and staff bundle load seen in nginx.

R-CORPUS completes only with both aggregate reports (30-day davinci@ auto-letter/human-quote split and confirmation-vs-inbound booker/contact-versus-guest mismatch counts), corrected schema locators, and no PII/row-level output. R-SEED completes only with all nine strategies retained, profile-order fallback, and a reported held-out top-1/top-3 score on at least 100 independent rows; otherwise it remains an explicit hold and does not claim a corpus-seeded improvement.

T2 is optional and begins only after T1_COMPLETE. T3 M1/M2 and XLSX parsing remain unstarted; the Labtest-only commit already exists, and no real-guest commit is approved by this plan. Close the run by updating ACTIVE.md with verified state/next acceptance check/holds, closing each lane ledger row, running ce-compound lane-close for merged/abandoned lanes, and linking the evidence-backed retro. Never claim done from merge, tests, deploy, a single successful canary or three live threads alone.
