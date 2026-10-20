---
title: Stay-request build v2 (all features, one Grok-orchestrated run) - Plan
type: feat
date: 2026-10-20
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: owner asks 157-165 + ARCHITECTURE.md
execution: code
---

# Stay-request build v2 (all features, one Grok-orchestrated run) - Plan

Readiness: `implementation-ready` (2026-10-20 ~18:05Z) after ponytail cut → ce-doc-review (5 personas) → Grok 4.7 xhigh adversarial → plan-eng-review (collision check, version rollover). Owner holds H1–H4 answered.

## Goal Capsule

- **Objective:** in one run, ship every stay-request feature the owner listed (asks 164–165): multi-ask, CHECK screen, unpaid amend in place, BAR grid before room pick, party ranking with no forced pick, Contact label, Labtest probe, two end buttons, contract/government overlay. Paid amend/cancel stay later.
- **Authority:** PRODUCT.md hard rules > owner asks (OWNER-ASKS 157–170, DECISIONS D9–D19) > this plan > lane judgement. Two owner overrides apply to this run only: (a) D18 replaces PRODUCT.md "Luna max for implementation; Opus for merges, deploys, live HMS" with Grok 4.6 high code / Grok 4.7 xhigh review / Grok orchestrator merge, deploy and deterministic live HMS; all other hard rules stay. (b) Asks 164–165 ("every feature in one run") override PRODUCT.md WIP=1 for this run; workflows still ship behind their own gates and the quote bar is reported separately.
- **Executor:** one Grok CLI orchestrator chat, started by the owner in Orca. It spawns one child Orca worktree per unit. No Opus after planning (owner Q1). Grok has no Claude memory/hooks/imports and truncates AGENTS.md at 10k chars, so the binding operating manual is `docs/plans/2026-10-20-008-grok-run-handbook.md` (owner ask 171).
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
- R1 One inbound mail → one card per **date set** (= one HMS booking by default), listing its guests/rooms and its own action and conf#. Staff can split a card into separate bookings with one click. Different date sets are always separate cards. Each guest on a card keeps its own conf# when the mail gives one, so a split never loses the guest↔conf# link.
- R2 Quote pane shows BAR for every room type × rate × board with nightly price and rooms left, before any room pick; missing data reads "not checked". The grid is read-only information; rate choice and pinning stay on the room cards.
- R3 Party suggestions rank email-named > sender history > domain. Domain never binds. Staff can price BAR with no party picked.
- R4 A new-booking pane labels the person "Contact", not "Quote contact".
- R5 Labtest probe records where guarantee type, deposit, A/R account, agency and company live, whether Save emails the confirmation letter, and why create stops at the guarantee combo. One Save + one amend on "Proof Labtest", arrival ≥ 2027-01-01 (owner Q4).
- R6 When a mail refers to an **existing** booking (amend/cancel/voucher read) and its HMS link is missing, ambiguous or suspect, the pane shows CHECK: candidates, staff pick, exact conf# re-read. No preview or write before that. New-booking and quote asks keep the quote panel route.
- R7 Unpaid provisional amend saves in place on the same conf#. "Unpaid" needs affirmative HMS evidence (provisional status + deposit received = 0 + no guarantee type that implies payment). Paid, guaranteed, direct-bill, conflicting or missing evidence = `unknown` → CHECK / "handle in HMS" (fail closed). Proven on Labtest only.
- R8 Two end buttons: **Make quote** (PDF/Excel/reply, default) and **Create provisional booking** (approved write; Labtest-gated).
- R9 Contract/government overlay: when a party is confirmed, or the ask is DBB, the grid tags contract / Government rows next to BAR.

### Scope boundaries
- Deferred: paid amend/cancel, memory A/B, queue TTL fix, four-field party split (U2b).
- Da Vinci (ask 170, 2026-10-20 17:45Z verdict): the quote path takes its property from the mailbox resolver (not a global HRCEN→HRDAV swap); gaps G1–G5 are listed in the 17:45Z chat reply and the DV ledger row `dv-hrdav-lane-proposal-20261020`. Recommended: DV mailbox ingest + quarantine promotion as a parallel lane now (no file overlap; the prod transport-row write is an owner hold); DV quote path next run. Not in this run's units unless the owner picks option A.
- Not this run: `RESERVATIONIST_PANE_SAVE=on`, real-guest writes, sending mail, GitHub Actions.

## Planning Contract

### Key technical decisions
- **KTD1 Extend, not rewrite.** Keep the Mastra workflow, door and Postgres; change the extraction schema, consumers and pane (R1 §5).
- **KTD2 Multi-ask lives in extraction; the card is the date set.** Owner heuristic (ask 168): separate dates = separate HMS bookings; same dates + several rooms = one booking. Evidence: in threads where staff sent several letters, same-date guests got separate conf# (core 17/17, broad 110/110; R2). That cohort is biased toward splits, and m1 found 7 N-conf vs 2 one-conf among 9 linked same-date asks, all agency. n=9 is too small for an auto-split rule. Add per-stay `guests: {name, confirmationNumber|null}[]` and `action`; group by date set, as today. One list keeps each guest tied to its conf#, so a split cannot mis-assign them (adversarial review). Staff split manually. `EXTRACTION_VERSION` hashes the prompt and schema, so no manual version bump is needed (inbound-run.ts:78). New fields are optional so legacy payloads still parse.
- **KTD3 The grid reuses the existing HMS read.** `fetch-quote.mjs` already reads every room × rate plan with board and nightly prices; the server drops `board` (hms-availability.ts:418) and caps at 50 options per group (quote-contract.mjs:474). No new DOM path (n3).
- **KTD4 No extra HMS read for the overlay.** `fetch-quote.mjs:519` already tags each rate `rateScope` public/contextual. A read takes 12–413 s and the queue waits 80–1,025 s (FACTS.md:145), so U10 tags rows from the existing read (ponytail −40 min).
- **KTD5 Paid state comes from HMS fields, not mail.** Letters carry boilerplate guarantee text (1,174/1,174). The reader has `guaranteetype`/`depositreceived` (read-reservation-fields.mjs:10-18); the prod lookup lacks `depositReceived` (n4). U4 confirms the DOM; U8 adds the field.
- **KTD6 PR salvage.** #335 `pickStayFromFindRows`/`stayPickCaption` → U7. Close #301, #308, #334 (owner hold H3). #336 is not needed by any unit here → park (R3, n2).
- **KTD7 Grok runs deterministic scripts only.** The orchestrator may start the Labtest probe script over SSM. No LLM clicks in HMS (PRODUCT.md hard rules). This replaces AGENTS.md "live HMS: Opus" per owner Q1 — recorded as D18.

### Waves (disjoint files; a shared file = queued)

A unit starts when every unit in its **After** column has merged, not when its wave letter opens. U10→U6→U9 share `quote-workflow-panel.tsx` and run strictly in that order; U7→U8 share `amend-lookup-panel.tsx`. Cited test **lines** show where similar assertions live; each unit adds new assertions for its new behaviour (Grok 4.7 P2).

| Wave | Unit | Owns | After |
|---|---|---|---|
| A | U1 Contact label | `nava-pane.tsx`, `contact-block.tsx` | — |
| A | U2 BAR grid | `hms-availability.ts`, `quote-contract.mjs`, `staff-quote-bind.ts`, `quote-workflow-panel.tsx`, `rate-cards.tsx`, `lib/quote-workflow/types.ts` | — |
| A | U3 Party rank | `party-aliases.ts`, `party-sender-map.ts`, `party-picker.tsx` | — |
| A | U4 Labtest probe | `read-reservation-fields.mjs` (extend); `create-lab-stay.mjs` only for the guarantee combo fix | — |
| A | U5a Extractor asks | `extraction/extract.ts`, `extraction/schema.ts` | — |
| A | U7 CHECK | `apps/mail/components/quote-workflow/amend-lookup-panel.tsx`, `apps/mail/lib/quote-workflow/amend-find.ts` | — |
| B | U5b Consumers | `quote-ready.ts`, `work-items.ts`, `hms-jobs.ts` (prefetch per stay) | U5a |
| B | U8 Unpaid amend | `pane-hms-write.ts`, `amend-stay*.mjs`, `stay-lookup.mjs`, `commercial-fields.mjs`, `pane-stay-lookup.ts`, `apps/mail/lib/quote-workflow/amend-cancel.ts`, `apps/mail/components/quote-workflow/amend-lookup-panel.tsx` | U4, U7 |
| B | U10 Overlay (tags only) | `hms-availability.ts`, `quote-workflow-panel.tsx` rates section | U2, U3 |
| C | U6 Multi-ask pane | `session.ts`, `document-review.tsx`, `quote-workflow-panel.tsx`, `booking-draft.ts` | U2, U5b, U10 |
| C | U9 Two end buttons | `quote-workflow-panel.tsx`, `booking-card.tsx`, `document-review.tsx` | U6, U4 |
| A | U11a Outbound-gold harness (build) | `scripts/outbound-gold-backtest.ts`, `src/ai/outbound-gold-features.ts` | — |
| D | U11b Replay runs | — | U5b, U6, U11a |
| D | U12 Deploy + live e2e | — | all |

### Per-unit pipeline (owner model routing, 2026-10-20 17:02Z)
Grok 4.6 high codes → Grok 4.7 xhigh reviews → Grok 4.6 high fixes → `git fetch` + `greptile review --branch origin/main` (an LLM judges each comment; Greptile is sometimes wrong) → Grok 4.6 high iterates on agreed P0/P1 → merge.

Gates run in parallel, in the background: `bash /home/orca/bin/remote-typecheck.sh <wt>` ‖ `bash /home/orca/bin/remote-vitest.sh <wt> <app> <files>` ‖ Greptile. Nothing heavy runs on the VPS. Lanes never edit `/home/orca/bin`.

## Implementation Units

### U1. Contact label
- **Goal:** R4. **Files:** `apps/mail/components/nava-pane/nava-pane.tsx:2213` (`quote` prop true for `new_booking`); `contact-block.tsx:40-42`.
- **Tests:** `apps/mail/tests/contact-block.test.tsx:58,116`; `nava-pane-render.test.tsx:2711` (add a `new_booking` case; :2880 is existing-stay); update snapshot `__snapshots__/nava-pane-render.test.tsx.snap:1091`.
- **Ponytail:** the title is already 'Contact' at contact-block.tsx:42; flip the prop only. One assertion; skip the snapshot unless it breaks.
- **Raw min:** 10–22 (#415 +45 → 22).

### U2. BAR grid before room pick
- **Goal:** R2. Carry `board` through `QuoteOption`/`AvailabilitySnapshot` (hms-availability.ts:129,189,418). Request 200 options per group and flag truncation (:103; quote-contract.mjs:474). Search on dates + occupancy alone, dropping `roomRequirementReady` as a search gate (quote-workflow-panel.tsx:884,960,1360). Grid DTO per stay in `QuoteSession` (types.ts:247,662), rendered before room cards (:1658).
- **Tests:** `hms-availability-probe.test.ts`, `hms-availability-bookability.test.ts`, `fetch-quote.test.mjs:352-399,530-590`, `quote-contract.test.mjs:325-413`, `rate-cards.test.tsx:191-273`, `quote-workflow-panel.test.tsx:609,861,1660`, `quote-workflow-session.test.ts:3393`.
- **Replay:** ≥10 independent quote threads; staff PDF nights vs grid BAR (PRODUCT.md quote bar; pool today n=8, ACTIVE.md).
- **Ponytail:** no new `QuoteSession` grid DTO. Render a read-only grid projection keyed by room code × rate code × board that keeps unpriced/incomplete rows as "not checked"; `buildRateOptions` (rate-options.ts:58) stays for the priced room cards (adversarial review: it drops rows the grid must show). `MAX_OPTIONS` is already 200 (quote-contract.mjs:7); pass `maxOptionsPerGroup: 200` + truncation flag. (The "party-gate" step is dropped: BAR search already runs with no party, quote-workflow-panel.tsx:954-960 — Grok 4.7.) Dropping `roomRequirementReady` in the panel alone is not enough: the bind refuses an unknown room type before HMS (`staff-quote-bind.ts:451-461`), so U2 also owns that file and allows empty `roomCodes` when no room preference is set (garbage codes still refused).
- **Raw min:** 35–50 (#414 +258 → 50).

### U3. Party rank, no forced pick
- **Goal:** R3. `suggestPartiesFor` orders sender first today (party-aliases.ts:144-151). New order: body mention > `lookupLearnedSenderHistory` (party-sender-map.ts:108) > domain; domain is a suggestion only. The panel's no-party gate moves to U2 (same file).
- **Must not touch:** `party-match-v3.ts` bind rules. If they are touched, the 42-mail replay runs before merge (MISTAKES 2026-10-19).
- **Tests:** `party-aliases.test.ts`, `party-sender-map.test.ts`, `pane-party-lookup.test.ts:207-241,410-460`, `party-picker-results.test.tsx:262-638`, `party-auto-lookup.test.tsx:103-154`.
- **Raw min:** 13–50.

### U4. Labtest booking-state probe (live, one HMS lock)
- **Goal:** R5. First diagnose the create stop at the guarantee combo (create-lab-stay.mjs `chooseCombo`, 5 s; failure PNGs on EC2 `/tmp/pane-stay-*/failure.png`). Capture DOM and options before any retry. Then: one Save on Proof Labtest; read back guarantee / deposit / A-R / agency / company; watch centurion@ for an auto letter (send_on_save yes/no). U4 does **not** amend; the single amend belongs to U8.
- **Safety (Grok 4.7, P0):** the Save runs through the pane save path (`pane-stay-save.ts:365` takes `paneStayPropertyLock`) or, if run as a CLI over SSM, only with `--proof` (the Labtest/2027 guard runs only in proof mode, `create-lab-stay.mjs:246,273-279`) **and** inside the same property lock. Bare `create-lab-stay.mjs` without `--proof` is forbidden in this run.
- **Counting:** an attempt that stops before Save does not count against the one-Save budget (assumption A1).
- **Files:** extend `read-reservation-fields.mjs` (guaranteetype, depositreceived, araccountname, ta1, company are already allow-listed, :10-18) + one fixture test; `create-lab-stay.mjs` only for the combo fix. A new probe file only if the combo DOM is unreadable.
- **Output:** a field table in `docs/infor-hms/` + screenshots. **Raw min:** 13 code + live p50 8 / p75 38.

### U5a. Extractor asks
- **Goal:** R1 backend. Optional per-stay `guests: {name: string, confirmationNumber: string|null}[]` (conf# grounded with the same verbatim check as top-level, schema.ts:221-225) and `action` (same enum as top-level). Grouping stays one stay per date set (extract.ts:54). **Stay id stays positional** `stableId('s', messageId, String(stayIndex))` (schema.ts:225): saved staff corrections key on stay id (work-items.ts:58-79), so a new id formula would orphan them (feasibility review). Top-level `kind`/`action` stay as a summary.
- **Gate (critical, m3):** `ACTION_CLASSIFICATION_RULES` sit inside the extraction prompt (extract.ts:68,226), so the new fields can shift `action`. Rebuild prompts from the branch (`scripts/triage-dataset/build-prompts.ts`) on the saved exports, then run one Luna pass over the 431 frozen rows (`/home/orca/nava-research/triage-20261019/work/predict.py` → `score.py`). That is ~4–7 min, under $5. Investigate on >20/431 action flips vs v4 or >10/431 fewer correct. Quote recall must stay ≥85% (D19).
- **Grounding:** each `guests[].confirmationNumber` passes the same pattern + verbatim `includes()` check as top-level confs inside `sanitizeExtraction` (schema.ts:219-225), else null.
- **Version rollover (checked):** the schema change re-hashes `EXTRACTION_VERSION` (inbound-run.ts:78). At deploy, runs still queued under the old version are refused as `stale_version` and dead-lettered (:256,532-540); succeeded old extractions stay readable because `succeededRead` ignores version (work-items.ts:617-629). So open items keep old payloads with no `guests`/`action` → consumers must treat both as optional (legacy = today's behaviour). U12 checks the dead-letter count right after deploy and re-enqueues inbound mail whose extraction was superseded in that window (read-only count first; re-enqueue is an LLM cost, not an HMS write).
- **Tests:** `extraction-schema.test.ts:101`, `inbound-extraction.test.ts:96,276`, `extraction-date-anchoring.test.ts:29,141`.
- **Raw min:** 50 (+ eval 30–60, runs in the background).

### U5b. Multi-ask consumers
- **Goal:** R1. Booking kind: allow >1 stay (quote-ready.ts:39-52). `multi_date` = distinct date sets (work-items.ts:314). `guests[].name` from each stay (:349). Booked/requested/conf per stay from `guests[].confirmationNumber`, then top-level, not `[0]` (:353-380, :1302). Prefetch keeps the first conf#; the other confs show on their cards (`selectHmsBatchRequest` is one find, hms-jobs.ts:505). Work item stays one per message; cards are per stay (decision: no work-item identity change → smaller blast radius).
- **Tests:** `quote-ready.test.ts:6,304,446`, `work-items.test.ts:311,807,958`, `hms-jobs.test.ts:944`.
- **Raw min:** 35–50.

### U6. Multi-ask pane
- **Goal:** R1 UI. One card per stay (date set) with its guest list, action badge and a **Split into separate bookings** control (split = one card per guest, same dates, each keeping its own conf#; pane-only, no re-extract). Room allocation on split: enabled only when guests = total rooms; each child card gets one room of its source row's type and occupancy, and the children's room total must equal the source. Otherwise the control reads "Split in HMS" (design review). No new card framework. Quote/booking cards use the quote panel; amend/cancel cards open CHECK/amend with that card's conf#. Booking drafts are already one per date key (quote-workflow-panel.tsx:2035-2048); the combined proposal stays available for multi-date quotes to one client (document-review.tsx:136,155).
- **Tests:** `quote-workflow-multi-stay.test.ts:206-268`, `quote-workflow-session.test.ts:26,2399`, `quote-workflow-luna-render.test.tsx:347`, `document-review.test.tsx:53`, `nava-pane-render.test.tsx:952`, `booking-draft-multistay.test.ts`.
- **Raw min:** 25–41 (#416); 92 if it fights the pane like #413.

### U7. CHECK screen
- **Goal:** R6. Explicit CHECK state when the link is missing/ambiguous/suspect; staff can reopen the candidate pick after a suspect link resolves (today search shows only when nothing resolved, amend-lookup-panel.tsx:191-193,312-325); exact conf# re-read before Preview. Salvage #335 `pickStayFromFindRows`.
- **Tests:** `amend-find-panel.test.tsx:758-829,1073-1215,1282-1345`; **unskip :1547**; `pane-stay-lookup.test.ts:204-338`; `stay-lookup-dom.test.mjs:345-382`.
- **Raw min:** 13–50.

### U8. Unpaid amend in place
- **Goal:** R7. Add `depositReceived` + `guaranteeType` (classification unpaid / paid / guaranteed / unknown, fail closed per R7) to the live pane lookup: the reader `tooling/playwright-quote/stay-lookup.mjs` + `commercial-fields.mjs` (allow-list), the result parser (pane-stay-lookup.ts:43,245,251) and `amend-find.ts:83` (feasibility review: the plan missed the reader). Uses U4's field table. Preview/Approve only for unpaid + exact conf# + passed CHECK. **The writer enforces it, not just the UI (Grok 4.7, P0):** `saveAmend` (pane-hms-write.ts:546-557) re-reads the stay and refuses commit (`refused_payment_unknown`) unless the reader returns provisional + deposit received 0 + a non-paying guarantee type; a missing field = refuse. The amend gate stays `lab` only (pane-hms-write.ts:87-90); no `on` arm this run (H1, ponytail).
- **Tests:** writer refusal for paid / guaranteed / missing deposit / missing guarantee (new cases in `pane-hms-write.test.ts`); `pane-hms-write.test.ts:52,335`, `pane-stay-amend.test.ts:44,69-103`, `amend-stay-rules.test.mjs:78-209`, `aop-amend-cancel-payload.test.ts:6,41`, `amend-cancel-copy.test.ts`, `amend-find-panel.test.tsx`.
- **Live:** the run's one Labtest amend is reserved for U8, from the pane, after its writer merges (scope review); U4 records the result in its field table.
- **Raw min:** 35–50.

### U9. Two end buttons
- **Goal:** R8. Relabel the existing Prepare PDF + reply (quote-workflow-panel.tsx:1583) to **Make quote**; surface the existing Preview→Book (booking-card.tsx) as **Create provisional booking**. `primaryAction={false}` (:1994) stays. No new action machine. For real guests the create button shows "Booking writes are off — create in HMS" + copy, until owner H1.
- **Tests:** `quote-workflow-panel.test.tsx:107,1557-1600,1937-2007`, `booking-card.test.tsx:287,670-719,770-917`, `mail-reply-actions-contract.test.ts:55`, `outlook-pane-stale-pdf-admission.test.tsx:179`.
- **Raw min:** 13–50.

### U10. Contract / government overlay
- **Goal:** R9. Carry `rateScope` (fetch-quote.mjs:519) and the Government strategy (quote-ready.ts:223-226) into grid tags, reusing `RatePlanCategory` (quote-workflow-panel.tsx:298-371,713). A BAR-only read can only say public/unknown; `contextual` (contract) needs a party-context read (`isNegotiatedRate` under `rateContext`, staff-quote-workflow.ts:367,400-401) — Grok 4.7 P1. So: contract tags appear only when the existing staff_quote read for a confirmed party already ran; otherwise the grid header reads "Public rates — contract not checked". No new read added.
- **Tests:** `party-contract-rates.test.ts:298-515`, `rate-cards.test.tsx:267-320`, `rate-options.test.ts:81`.
- **Raw min:** 13–22.

### U11. Outbound-gold replay (behaviour checks; rates only where n allows)
- Multi-ask: the 17 core threads (l1 S1, corpus 2026-10-13) + R2 cohorts, run through prod input (`readQuoteAttachments` + `selectionToAgentPrompt`) on EC2. Truth = HRCEN letters (guest + arrival + conf#). Pass = every letter's guest + dates + conf# is covered by some card (several letters may sit on one date-set card); distinct date sets = distinct cards. m1: same-date asks got 2+ confs in 7/9 linked cases, so letters ≠ cards by design.
- Quote: ≥10 independent threads, staff PDF nights vs grid.
- CHECK: golden amend rows + every corpus amend with no conf# or an `ambiguous` result. Pass = no write before pick + re-read.
- Harness (m2): new `apps/server-pilot/scripts/outbound-gold-backtest.ts` + `src/ai/outbound-gold-features.ts` (~200–300 LOC). Same prod input (`readQuoteAttachments` → `selectionToAgentPrompt`) on EC2; L1 linker pairs each ask with its staff reply / HRCEN letter / quote PDF; fields parsed today: guest 1,127/1,180, conf# 1,174/1,180, arrival 1,179/1,180. Vision parity is a reported gap.
- Action truth = staff outbound + owner rules (session e49ceaf9: change after letter = amend; go-ahead after quote = new booking; send proforma after booking = billing). 12 owner labels in prod `mail_action_label`; the 40-row sheet has 0 owner cells.
- **Raw min:** 50 (#414-class, new harness) + runs.

### U12. Deploy + live e2e (end of run)
- `git -C .worktrees/recover-parse-failure fetch origin && git -C .worktrees/recover-parse-failure merge --ff-only origin/main`, then `ops-deploy.sh` (rc=1 from the 24 h dead-letter gate is known). Record the last-good SHA first.
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
- Quote bar: plan + price = staff on ≥10 plannable threads. If n < 10, report "measured improvement", not pass. Classifier: quote recall ≥85% (D19), no regression vs v4 on the 431 frozen rows.
- Zero real-guest writes; Labtest writes ≤ 1 Save + 1 amend (A1 aside).
- Dead-end code removed. ETA ledger closed. Retro line written per unit (`ce-compound mode:lane-close`).

## ETA (critical path, measured comparables, after ponytail −140 min)

| Chain step | Raw min | Source |
|---|---:|---|
| U5a code + Grok review/fix | 35 + 20 | #414 shrunk; Grok review 6 min (grok-p1 15:55→16:01) + fix |
| U5a classifier gate | 30 | m3: 431 rows ~4–7 min per run; prompt rebuild + ×2 noise-band runs + score (Grok 4.7: 10 was low) |
| U5b | 35 + 20 | #414 shrunk |
| U6 | 25–41 + 20 | #416 |
| U9 | 13 + 15 | #412 |
| U11b runs + U12 | 30–60 | deploy p50 7; live p50 8 / p75 38; U11a harness (50 raw) is built in Wave A, off the chain |
| **Total** | **~245–320 min (4.1–5.3 h)** | retro actuals include gates; no extra ratio |

- U2/U3/U7/U10 finish in parallel before U6/U9 need them.
- Off the chain but can extend the run: U4 live p75 38 + U8 Labtest amend p75 38 (serial HMS lock); a third Greptile round on any chain unit adds ~20–40.
- Unmeasured: Grok 4.6 coding speed and the Grok orchestrator (all comparables were Luna max lanes); the U4 combo fix.
- Cost: Grok prices are unverified here; report actual $ from `grok usage` after the run.

## Holds (owner)
- H1 ✅ owner 17:20Z: `RESERVATIONIST_PANE_SAVE` stays `lab`.
- H2 The deploy at the end is approved (Q3). The Labtest Save + amend is approved (Q4). Per AGENTS.md, both approvals must be restated in the Grok orchestrator's own chat; the kickoff prompt carries them because the owner pastes it.
- H3 ✅ owner 17:20Z: close PRs #301, #308, #334; park #336.
- H4 ✅ D18: Grok orchestrator merges, deploys and runs deterministic live HMS scripts.

## Assumptions
- A1 A Labtest attempt that stops before the Save click does not use the one-Save budget.
- A2 Work items stay one per message; per-ask identity lives in stay ids (U5b).
- A3 R2 (multi-ask truth) lands before U11; if not, U11 uses the l1 cohorts.

## Review log (ce-doc-review, 5 Luna xhigh personas, 2026-10-20 17:48Z)

| Finding | Reviewer | Resolution |
|---|---|---|
| R6 CHECK collides with new-booking route | coherence | applied: CHECK = existing booking only |
| U11 card count ≠ letter count | coherence | applied: coverage check |
| Authority order contradicts Grok execution | coherence | applied: D18 + asks 164–165 named as run overrides |
| U8 misses the live lookup reader | feasibility | applied: `stay-lookup.mjs` + `commercial-fields.mjs` |
| Guaranteed stays have no safe amend state | feasibility + adversarial | applied: fail-closed classes incl. `guaranteed` |
| Deploy merges stale ref | feasibility | applied: fetch first |
| Date-based stay ids orphan saved edits | feasibility | applied: stay id stays positional |
| Split loses guest↔conf# | adversarial | applied: `guests[{name, conf#}]` |
| Grid via `buildRateOptions` drops rows | adversarial | applied: grid projection keeps "not checked" |
| Split room allocation undefined | design | applied: guests = rooms or "Split in HMS" |
| Grid selection unspecified | design | applied: read-only, picks on cards |
| U4 can eat U8's only amend | scope | applied: amend reserved for U8 |
| ETA omits U11 harness | scope | applied: U11a in Wave A, off chain |
| Wave A breaks WIP=1 | feasibility + scope | **rejected**: owner asks 164–165 "all features one run"; recorded as run override |
| Model routing breaks PRODUCT.md Opus rule | feasibility | **rejected**: owner D18 (17:20Z) |
| U4 Save lock-free / guard only with `--proof` | Grok 4.7 xhigh | applied: pane path or `--proof` + lock; bare CLI forbidden |
| U8 unpaid gate UI-only | Grok 4.7 xhigh | applied: `saveAmend` refuses without payment proof |
| U5a version bump strands open items | Grok 4.7 xhigh | P0→P1: old payloads stay readable; consumers optional; U12 re-enqueues superseded |
| U10 contract tag needs party read | Grok 4.7 xhigh | applied: contract tag only from existing party read, else "contract not checked" |
| U2 bind refuses empty room type; party-gate anchor dead | Grok 4.7 xhigh | applied: own `staff-quote-bind.ts`; anchor removed |
| Bare paths, schema anchor, per-guest grounding, Wave C order, ETA low | Grok 4.7 xhigh | applied |

## Sources
- Research: `docs/research/2026-10-20-arch-lanes/` (ARCHITECTURE, l1, l2, p1, p2-scope-grok46, grok-4.6-p1-review); `r1-agent-trace`, `r2-multi-ask-truth`, `r3-stale-prs`, `r4-test-plan`, `n1..n5-*`, `m2-outbound-gold-harness`, `m3-classifier-gate`, `ponytail-plan-cut` (same folder).
- Retro: `docs/context/ledger/2026-10-19-evening-retro.md`. Rules: AGENTS.md, MISTAKES.md, PRODUCT.md.
