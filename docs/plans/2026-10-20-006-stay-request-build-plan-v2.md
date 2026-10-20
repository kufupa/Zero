---
title: Stay-request build v2 (all features, one Grok-orchestrated run) - Plan
type: feat
date: 2026-10-20
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: owner asks 157-165 + ARCHITECTURE.md
execution: code
---

# Stay-request build v2 (all features, one Grok-orchestrated run) - Plan

Readiness stays `requirements-only` until the review chain (ponytail cut → ce-doc-review → Grok 4.7 xhigh → plan-eng-review) passes and owner holds H1–H4 are answered.

## Goal Capsule

- **Objective:** in one run, ship every stay-request feature the owner listed (asks 164–165): multi-ask, CHECK screen, unpaid amend in place, BAR grid before room pick, party ranking with no forced pick, Contact label, Labtest probe, two end buttons, contract/government overlay. Paid amend/cancel stay later.
- **Authority:** PRODUCT.md hard rules > owner asks (OWNER-ASKS 157–165, DECISIONS D9–D17) > this plan > lane judgement.
- **Executor:** one Grok CLI orchestrator chat, started by the owner in Orca. It spawns one child Orca worktree per unit. No Opus after planning (owner Q1).
- **Stop conditions:** a P0/P1 still open after round 3 of one design → split, strip or redesign (AGENTS.md:67-68), never a 4th round; a live HMS DOM timeout → screenshot and DOM capture before any retry (MISTAKES 2026-10-20); any real-guest write path reached → stop.
- **Deploy:** once, at the end, from `.worktrees/recover-parse-failure` via `apps/server-pilot/deploy/ops-deploy.sh` (owner Q3).

## Product Contract

### Summary
Extend the agent; do not rewrite it (R1 trace, ARCHITECTURE.md:5-10). The extractor learns per-guest asks, the pane shows one card per ask, prices come as an all-room grid before any room pick, party suggestions rank without forcing a pick, and amend gets a CHECK step plus an unpaid in-place save proved on Labtest.

### Value gate (prod, read-only SQL, inbound received 2026-10-13..20, latest succeeded extraction per message, n=1,590)

| Kind | Mails | Share | >1 stay (date sets) | ≥1 conf# |
|---|---:|---:|---:|---:|
| other | 862 | 54.2% | 7 | 144 |
| booking | 203 | 12.8% | 17 | 40 |
| voucher_pop | 184 | 11.6% | 8 | 80 |
| spam | 130 | 8.2% | 0 | 0 |
| amendment | 123 | 7.7% | 6 | 29 |
| quote | 63 | 4.0% | 3 | 2 |
| cancellation | 25 | 1.6% | 4 | 7 |

- Quote + booking + amendment = 389/1,590 (24.5%) of inbound mail; every unit here serves those three.
- Multi-ask: 26/389 of those mails have >1 date set (6.7%). This undercounts: two guests on the same dates collapse into one stay today (extract.ts:54). Corpus: 17/164 core threads (10%) carry 2+ quote/booking asks; 9/9 letter cases got separate conf# (l1:191-194).
- Usage, `actor_kind='user'`, same 7 days (includes owner/testing): pane.opened 2,618 events / 615 items; hms.lookup.started 1,005 / 151; quote.prepared 71 / 36; field.edit 57 / 23; pdf.created 4 / 3. Pane is opened a lot; documents are rarely produced.
- Users tomorrow: yes, 2026-10-21 is a weekday. Pane changes reach Outlook + webmail after deploy and bundle reload. Writes stay Labtest-only (`RESERVATIONIST_PANE_SAVE=lab`).
- Anti-over-index: cancellation is 1.6%, so paid amend/cancel stay deferred; contract/government overlay is limited to data already read (see U10).

### Requirements
- R1 One inbound mail → one card per guest × date set, each with its own action (quote / booking / amend / cancel) and its own conf#.
- R2 Quote pane shows BAR for every room type × rate × board with nightly price and rooms left, before any room pick; missing data reads "not checked".
- R3 Party suggestions rank email-named > sender history > domain. Domain never binds. Staff can price BAR with no party picked.
- R4 A new-booking pane labels the person "Contact", not "Quote contact".
- R5 Labtest probe records where guarantee type, deposit, A/R account, agency and company live, whether Save emails the confirmation letter, and why create stops at the guarantee combo. One Save + one amend on "Proof Labtest", arrival ≥ 2027-01-01 (owner Q4).
- R6 When a mail's booking link is missing, ambiguous or suspect, the pane shows CHECK: candidates, staff pick, exact conf# re-read. No preview or write before that.
- R7 Unpaid provisional amend saves in place on the same conf#. Paid or unknown state routes to CHECK / "handle in HMS". Proven on Labtest only.
- R8 Two end buttons: **Make quote** (PDF/Excel/reply, default) and **Create provisional booking** (approved write; Labtest-gated).
- R9 Contract/government overlay: when a party is confirmed, or the ask is DBB, the grid tags contract / Government rows next to BAR.

### Scope boundaries
- Deferred: paid amend/cancel, memory A/B, queue TTL fix, four-field party split (U2b).
- Not this run: `RESERVATIONIST_PANE_SAVE=on`, real-guest writes, sending mail, GitHub Actions.

## Planning Contract

### Key technical decisions
- **KTD1 Extend, not rewrite.** Keep the Mastra workflow, door and Postgres; change the extraction schema, consumers and pane (R1 §5).
- **KTD2 Multi-ask lives in extraction.** Add per-stay `guestName`, `action` and `confirmationNumber`; group by (guest, dates). The pane cannot split same-date guests after the fact (R1 §5, n1). `EXTRACTION_VERSION` hashes the prompt and schema, so no manual version bump is needed (inbound-run.ts:78). New fields are optional so legacy payloads still parse.
- **KTD3 The grid reuses the existing HMS read.** `fetch-quote.mjs` already reads every room × rate plan with board and nightly prices; the server drops `board` (hms-availability.ts:418) and caps at 50 options per group (quote-contract.mjs:474). No new DOM path (n3).
- **KTD4 One extra HMS read at most, for the overlay.** Each read takes 12–413 s and the queue waits 80–1,025 s (FACTS.md:145). The overlay runs only with a confirmed party or a DBB ask.
- **KTD5 Paid state comes from HMS fields, not mail.** Letters carry boilerplate guarantee text (1,174/1,174). The reader has `guaranteetype`/`depositreceived` (read-reservation-fields.mjs:10-18); the prod lookup lacks `depositReceived` (n4). U4 confirms the DOM; U8 adds the field.
- **KTD6 PR salvage.** #335 `pickStayFromFindRows`/`stayPickCaption` → U7. Close #301, #308, #334 (owner hold H3). #336 is not needed by any unit here → park (R3, n2).
- **KTD7 Grok runs deterministic scripts only.** The orchestrator may start the Labtest probe script over SSM. No LLM clicks in HMS (PRODUCT.md hard rules). This replaces AGENTS.md "live HMS: Opus" per owner Q1 — recorded as D18.

### Waves (disjoint files; a shared file = queued)

| Wave | Unit | Owns | After |
|---|---|---|---|
| A | U1 Contact label | `nava-pane.tsx`, `contact-block.tsx` | — |
| A | U2 BAR grid | `hms-availability.ts`, `quote-contract.mjs`, `quote-workflow-panel.tsx`, `rate-cards.tsx`, `lib/quote-workflow/types.ts` | — |
| A | U3 Party rank | `party-aliases.ts`, `party-sender-map.ts`, `party-picker.tsx` | — |
| A | U4 Labtest probe | new `labtest-booking-state-probe.mjs` + test; `create-lab-stay.mjs` only if guarantee combo fix | — |
| A | U5a Extractor asks | `extraction/extract.ts`, `extraction/schema.ts` | — |
| A | U7 CHECK | `amend-lookup-panel.tsx`, `amend-find.ts` | — |
| B | U5b Consumers | `quote-ready.ts`, `work-items.ts`, `hms-jobs.ts` (prefetch per stay) | U5a |
| B | U8 Unpaid amend | `pane-hms-write.ts`, `amend-stay*.mjs`, `pane-stay-lookup.ts`, `amend-cancel.ts`, `amend-lookup-panel.tsx` | U4, U7 |
| B | U10 Overlay | `hms-availability.ts`, `quote-workflow-panel.tsx` rates section | U2, U3 |
| C | U6 Multi-ask pane | `session.ts`, `document-review.tsx`, `quote-workflow-panel.tsx`, `booking-draft.ts` | U2, U5b, U10 |
| C | U9 Two end buttons | `quote-workflow-panel.tsx`, `booking-card.tsx`, `document-review.tsx` | U6, U4 |
| D | U11 Replay checks | scripts only | U5b, U6 |
| D | U12 Deploy + live e2e | — | all |

### Per-unit pipeline (owner model routing, 2026-10-20 17:02Z)
Grok 4.6 high codes → Grok 4.7 xhigh reviews → Grok 4.6 high fixes → `git fetch` + `greptile review --branch origin/main` (an LLM judges each comment; Greptile is sometimes wrong) → Grok 4.6 high iterates on agreed P0/P1 → merge.

Gates run in parallel, in the background: `bash /home/orca/bin/remote-typecheck.sh <wt>` ‖ `bash /home/orca/bin/remote-vitest.sh <wt> <app> <files>` ‖ Greptile. Nothing heavy runs on the VPS. Lanes never edit `/home/orca/bin`.

## Implementation Units

### U1. Contact label
- **Goal:** R4. **Files:** `apps/mail/components/nava-pane/nava-pane.tsx:2213` (`quote` prop true for `new_booking`); `contact-block.tsx:40-42`.
- **Tests:** `apps/mail/tests/contact-block.test.tsx:58,116`; `nava-pane-render.test.tsx:2711` (add a `new_booking` case; :2880 is existing-stay); update snapshot `__snapshots__/nava-pane-render.test.tsx.snap:1091`.
- **Raw min:** 22 (#415 +45 → 22).

### U2. BAR grid before room pick
- **Goal:** R2. Carry `board` through `QuoteOption`/`AvailabilitySnapshot` (hms-availability.ts:129,189,418). Request 200 options per group and flag truncation (:103; quote-contract.mjs:474). Search on dates + occupancy alone, dropping `roomRequirementReady` as a search gate (quote-workflow-panel.tsx:884,960,1360). Grid DTO per stay in `QuoteSession` (types.ts:247,662), rendered before room cards (:1658).
- **Tests:** `hms-availability-probe.test.ts`, `hms-availability-bookability.test.ts`, `fetch-quote.test.mjs:352-399,530-590`, `quote-contract.test.mjs:325-413`, `rate-cards.test.tsx:191-273`, `quote-workflow-panel.test.tsx:609,861,1660`, `quote-workflow-session.test.ts:3393`.
- **Replay:** ≥10 independent quote threads; staff PDF nights vs grid BAR (PRODUCT.md quote bar; pool today n=8, ACTIVE.md).
- **Raw min:** 50 (#414 +258 → 50).

### U3. Party rank, no forced pick
- **Goal:** R3. `suggestPartiesFor` orders sender first today (party-aliases.ts:144-151). New order: email-named > history (`party-sender-map.ts:130`) > domain; domain is a suggestion only. The panel party gate (quote-workflow-panel.tsx:920-924) must allow BAR with no party — **queue that line behind U2** (same file).
- **Must not touch:** `party-match-v3.ts` bind rules. If they are touched, the 42-mail replay runs before merge (MISTAKES 2026-10-19).
- **Tests:** `party-aliases.test.ts`, `party-sender-map.test.ts`, `pane-party-lookup.test.ts:207-241,410-460`, `party-picker-results.test.tsx:262-638`, `party-auto-lookup.test.tsx:103-154`.
- **Raw min:** 13–50.

### U4. Labtest booking-state probe (live, one HMS lock)
- **Goal:** R5. First diagnose the create stop at the guarantee combo (create-lab-stay.mjs `chooseCombo`, 5 s; failure PNGs on EC2 `/tmp/pane-stay-*/failure.png`). Capture DOM and options before any retry. Then: one Save on Proof Labtest; read back guarantee / deposit / A-R / agency / company; watch centurion@ for an auto letter (send_on_save yes/no); one amend (dates) on the same conf#.
- **Counting:** an attempt that stops before Save does not count against the one-Save budget (assumption A1).
- **Files:** new `apps/server-pilot/tooling/playwright-quote/labtest-booking-state-probe.mjs` + `.test.mjs`; `create-lab-stay.mjs` only for the combo fix.
- **Output:** a field table in `docs/infor-hms/` + screenshots. **Raw min:** 13 code + live p50 8 / p75 38.

### U5a. Extractor asks
- **Goal:** R1 backend. Per-stay `guestName: string|null`, `action` (same enum as top-level), `confirmationNumber: string|null`. Grouping key (guest, dates) in the prompt (extract.ts:54-65). Stay id = hash(guest, dates), not position (schema.ts:224; work-items edits key on it). Date anchoring uses distinct date sets, not `stays.length===1` (schema.ts:108). Top-level `kind`/`action` stay as a summary.
- **Gate (critical):** re-run the frozen leak-free triage eval (431 rows; v4 = 90.3% acc / 88.6 macro-F1) at prod effort, run twice for a noise band. Any macro-F1 drop outside the noise band → stop (v5 was rejected for this, ACTIVE.md).
- **Check before coding:** what `stale_version` (inbound-run.ts:256) does to open items when the version changes (re-extract or keep).
- **Tests:** `extraction-schema.test.ts:101`, `inbound-extraction.test.ts:96,276`, `extraction-date-anchoring.test.ts:29,141`.
- **Raw min:** 50 (+ eval 30–60, runs in the background).

### U5b. Multi-ask consumers
- **Goal:** R1. Booking kind: allow >1 stay (quote-ready.ts:39-52). `multi_date` = distinct date sets (work-items.ts:314). `guestNames` from each stay (:349). Booked/requested/conf per stay, not `[0]` (:353-380, :1302). Prefetch lookup per stay conf# (hms-jobs.ts:487-513). Work item stays one per message; cards are per stay (decision: no work-item identity change → smaller blast radius).
- **Tests:** `quote-ready.test.ts:6,304,446`, `work-items.test.ts:311,807,958`, `hms-jobs.test.ts:944`.
- **Raw min:** 50.

### U6. Multi-ask pane
- **Goal:** R1 UI. One card per stay (guest × dates) with its own action badge. Quote/booking cards use the quote panel; amend/cancel cards open CHECK/amend with that card's conf#. Booking drafts are already one per date key (quote-workflow-panel.tsx:2035-2048); the combined proposal stays available for multi-date quotes to one client (document-review.tsx:136,155).
- **Tests:** `quote-workflow-multi-stay.test.ts:206-268`, `quote-workflow-session.test.ts:26,2399`, `quote-workflow-luna-render.test.tsx:347`, `document-review.test.tsx:53`, `nava-pane-render.test.tsx:952`, `booking-draft-multistay.test.ts`.
- **Raw min:** 41 (#416); 92 if it fights the pane like #413.

### U7. CHECK screen
- **Goal:** R6. Explicit CHECK state when the link is missing/ambiguous/suspect; staff can reopen the candidate pick after a suspect link resolves (today search shows only when nothing resolved, amend-lookup-panel.tsx:191-193,312-325); exact conf# re-read before Preview. Salvage #335 `pickStayFromFindRows`.
- **Tests:** `amend-find-panel.test.tsx:758-829,1073-1215,1282-1345`; **unskip :1547**; `pane-stay-lookup.test.ts:204-338`; `stay-lookup-dom.test.mjs:345-382`.
- **Raw min:** 13–50.

### U8. Unpaid amend in place
- **Goal:** R7. Add `depositReceived` (+ paid classification: unpaid / paid / unknown) to the lookup (pane-stay-lookup.ts:43,245; amend-find.ts:83), using U4's field table. Preview/Approve only for unpaid + exact conf# + passed CHECK. The amend gate accepts `lab` only (pane-hms-write.ts:87-90); add `on` symmetric with create, but the flag stays `lab` (hold H1).
- **Tests:** `pane-hms-write.test.ts:52,335`, `pane-stay-amend.test.ts:44,69-103`, `amend-stay-rules.test.mjs:78-209`, `aop-amend-cancel-payload.test.ts:6,41`, `amend-cancel-copy.test.ts`, `amend-find-panel.test.tsx`.
- **Live:** Labtest amend from the pane (counts as U4's one amend if U4 has not used it).
- **Raw min:** 50.

### U9. Two end buttons
- **Goal:** R8. A visible **Make quote** (the existing Prepare PDF + reply, quote-workflow-panel.tsx:1583) and **Create provisional booking** (booking-card.tsx Preview→Book). Inner `primaryAction={false}` (:1994) is resolved. For real guests the create button shows "Booking writes are off — create in HMS" + copy, until owner H1.
- **Tests:** `quote-workflow-panel.test.tsx:107,1557-1600,1937-2007`, `booking-card.test.tsx:287,670-719,770-917`, `mail-reply-actions-contract.test.ts:55`, `outlook-pane-stale-pdf-admission.test.tsx:179`.
- **Raw min:** 13–50.

### U10. Contract / government overlay
- **Goal:** R9. With a confirmed party id, read once more with its rate context (rate-options.ts:39 `partyRowMatches`); for a DBB ask, Government is already the strategy (quote-ready.ts:223-226). Tag rows public / contract / government in the grid, reusing the panel categories (quote-workflow-panel.tsx:298-371,713).
- **Tests:** `party-contract-rates.test.ts:298-515`, `rate-cards.test.tsx:267-320`, `rate-options.test.ts:81`.
- **Ponytail candidate:** this adds a 12–413 s read per quote. The cut decision is in review step 1.
- **Raw min:** 50 (#414-class).

### U11. Replay checks (behaviour checks, no rates; n < 100)
- Multi-ask: the 17 core threads (l1 S1, corpus 2026-10-13) + R2 cohorts, run through prod input (`readQuoteAttachments` + `selectionToAgentPrompt`) on EC2. Truth = HRCEN letters (guest + arrival + conf#). Pass = N cards = N letter pairs.
- Quote: ≥10 independent threads, staff PDF nights vs grid.
- CHECK: golden amend rows + every corpus amend with no conf# or an `ambiguous` result. Pass = no write before pick + re-read.
- **Raw min:** 30–60 (no measured comparable; labelled ballpark).

### U12. Deploy + live e2e (end of run)
- `git -C .worktrees/recover-parse-failure merge --ff-only origin/main`, then `ops-deploy.sh` (rc=1 from the 24 h dead-letter gate is known). Record the last-good SHA first.
- Health 200/200; 4 pm2 procs; `/proc` flags unchanged.
- Bundle load in nginx; Outlook pane + webmail check per R1–R9; one prod HMS read per grid; Labtest-only writes.
- **Raw min:** deploy p50 7; live p50 8 / p75 38 per check batch.

## Verification Contract
- Per PR: remote typecheck (baseline mail 62 errors, server-pilot 0) ‖ remote vitest on the listed files ‖ Greptile on its final head. Never local tsc/vitest. `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL` first.
- UI lanes: the brief lists every test asserting removed UI (n5 table). Snapshots update on EC2 with `-u`.
- U5a: frozen triage eval ×2, no regression.
- Accuracy rates only with ≥100 independent truth ids; otherwise "behaviour check, no rate" (AGENTS.md:74).

## Definition of Done
- Every unit merged, deployed once, and its live check passed on prod after the last fix (PRODUCT.md Done).
- Quote bar: plan + price = staff on ≥10 plannable threads. If n < 10, report "measured improvement", not pass.
- Zero real-guest writes; Labtest writes ≤ 1 Save + 1 amend (A1 aside).
- Dead-end code removed. ETA ledger closed. Retro line written per unit (`ce-compound mode:lane-close`).

## ETA (critical path, measured comparables)

| Chain step | Raw min | Source |
|---|---:|---|
| U5a code + review/fix | 50 + 20 | #414; Grok review 6 min (grok-p1 15:55→16:01) + fix |
| U5b | 50 + 20 | #414 |
| U6 | 41–92 + 20 | #416 / #413 |
| U9 | 13–50 + 20 | #412–#414 |
| U11 + U12 | 45–100 | deploy p50 7; live p50 8 / p75 38; replay ballpark |
| **Total** | **~310–420 min (5.2–7.0 h)** | retro actuals already include gates; no extra ratio scaling |

- Parallel waves A/B do not lengthen this chain; U2 (70) and U10 (70) finish before U6 needs them.
- Unknowns that can break it: the Grok orchestrator is untested here (no ledger row); Grok 4.6 coding speed has no ledger row (retro lanes were Luna max); U5a eval noise; the U4 combo fix.
- Cost: Grok prices are unverified in this repo (`costUsdTicks` scale unknown, quote-plan evidence). Report actual $ from `grok usage` after the run.

## Holds (owner)
- H1 `RESERVATIONIST_PANE_SAVE` stays `lab`; real-guest create/amend needs the owner to set `on` later.
- H2 The deploy at the end is approved (Q3). The Labtest Save + amend is approved (Q4). Per AGENTS.md, both approvals must be restated in the Grok orchestrator's own chat; the kickoff prompt carries them because the owner pastes it.
- H3 Close PRs #301, #308, #334; park #336.
- H4 AGENTS.md "merge/deploy/live HMS: Opus" → Grok orchestrator (owner Q1). Record as D18 before kickoff.

## Assumptions
- A1 A Labtest attempt that stops before the Save click does not use the one-Save budget.
- A2 Work items stay one per message; per-ask identity lives in stay ids (U5b).
- A3 R2 (multi-ask truth) lands before U11; if not, U11 uses the l1 cohorts.

## Sources
- Research: `docs/research/2026-10-20-arch-lanes/` (ARCHITECTURE, l1, l2, p1, p2-scope-grok46, grok-4.6-p1-review); `/tmp/opus-run-1020/research/{r1-agent-trace,r3-stale-prs,r4-test-plan}.md`, `n/n1..n5-out.md` (copied to the research folder at plan lock).
- Retro: `docs/context/ledger/2026-10-19-evening-retro.md`. Rules: AGENTS.md, MISTAKES.md, PRODUCT.md.
