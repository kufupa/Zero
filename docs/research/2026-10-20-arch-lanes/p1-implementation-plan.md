---
title: P1 stay-request implementation plan
status: proposed-not-authorized
snapshot: User-stated origin/main 3e1acb694; git intentionally not run per lane restriction.
scope: Read-only planning; no source edits, tests, typecheck, installs, network, Git, or HMS.
---

# Answer

- Basis read: PRODUCT.md; AGENTS.md; AGENT.md; docs/context/ACTIVE.md, OWNER-ASKS.md, FACTS.md; docs/research/README.md, CATALOG.md; target ARCHITECTURE.md, README.md, grok-4.7-review.md, l4-infor-order-dropped.md; prior quote plan. Snapshot SHA is user-supplied; no Git check because lane forbids it.
- Build small slices. Keep Mastra + Postgres; no router, memory, or stay-case rewrite. Keep one behaviour per PR and under 500 changed product lines; WIP=1 within quote/stay workflow (AGENTS.md:33–44,65–76; docs/research/2026-10-20-arch-lanes/ARCHITECTURE.md:3–10).
- U1 reuses the existing all-room availability worker; pane needs its own queued action, party-aware coverage, board and a safe stock display. One lock per stay; variant searches still increase lock occupancy (apps/server-pilot/src/ai/hms-availability.ts:102–117,171–198,494–517; apps/server-pilot/src/trpc/routes/pane-stay-lookup.ts:230–305).
- U2 rank email-named > sender history > domain. Suggestions stay unverified; no forced company for public BAR. Do not silently bind a domain or conflate guest, quote contact, bill-to company and booking agency (apps/server-pilot/src/ai/party-aliases.ts:81–92,132–151; apps/mail/components/quote-workflow/quote-workflow-panel.tsx:405–476,920–924; docs/research/2026-10-20-arch-lanes/ARCHITECTURE.md:39–42).
- U3 has two tiny independent fixes: remove the generic “Complete stay details” jump; show plain “Contact” on new-booking flow. Amend copy stays U6 (apps/mail/components/quote-workflow/quote-workflow-panel.tsx:1517–1527,1557–1572; apps/mail/components/nava-pane/nava-pane.tsx:2205–2215; docs/context/OWNER-ASKS.md:299).
- Preserve prior quote-plan behavior: one primary Prepare PDF + reply action; Excel stays separate; explicit Save/Insert makes an unsent draft. U1 does not close the prior plan’s separate rate-selector relocation. Add no implicit send or draft side effect (docs/plans/2026-10-20-001-fix-centurion-quote-ready-plan.md:38–44,58–64,154–160).
- U4’s booking path remains gated. Existing Preview → Book is guarded; “provisional” and Save auto-mail are not proved. The reported guarantee-combo failure is not in current ACTIVE.md; treat it as a run-specific unchecked report (apps/mail/components/quote-workflow/booking-card.tsx:328–452; apps/server-pilot/src/ai/pane-stay-save.ts:134–177; docs/context/ACTIVE.md:56–71; apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs:343–347).
- U5 can locate HMS state with a deterministic read-only Labtest probe. It cannot prove whether Save sends mail; that needs a separate authorized Labtest save + mailbox observation. U6 is size-only/later; U7 TTL claim needs exact object/expiry clarification (apps/server-pilot/tooling/playwright-quote/read-reservation-fields.mjs:10–19; apps/server-pilot/tooling/playwright-quote/stay-lookup-dom.mjs:5–8; docs/context/OWNER-ASKS.md:297–299).
- Suggested routing: Luna max writes isolated slices; one verifier per PR; Greptile + Grok review; Opus reads every diff and handles merge/deploy/live HMS only with same-session owner authorization (AGENTS.md:65–76). No live or test work in this planning pass.

# Units

## U1. Price grid before room pick

**Current.** Existing helper already searches every room type: input roomType is only a display label, and quoteRequestFor omits room/rate codes (apps/server-pilot/src/ai/hms-availability.ts:36–56,102–117,171–176). Snapshot holds room/rate labels, eligibility and nightly prices, but not board; availableCount is per night, not one stay-level “rooms left” number (apps/server-pilot/src/ai/hms-availability.ts:120–169,236–240,311–324,384–427). The quote tool sees board and per-night inventory in its visible/native match, then the helper projection drops board (apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs:530–548; apps/server-pilot/src/ai/hms-availability.ts:398–427).

Party/company/agency and sales strategy are absent from AvailabilityRequest and its snapshot (apps/server-pilot/src/ai/hms-availability.ts:36–56,171–198). The existing quote tool accepts organizationID/travelAgencyID and resolves a strategy, but each search uses one strategy; default is BAR without context, Preset with context (apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs:191–195,358–379; apps/server-pilot/tooling/playwright-quote/quote-contract.mjs:260–309). Existing price cards already display board, room, rate, restrictions and rooms-left where present; reuse their rendering, not the selected-room gate (apps/mail/components/quote-workflow/rate-cards.tsx:9–12,37–45,80–98; apps/mail/tests/rate-cards.test.tsx:214–273).

The backend availability kind and status read exist, but the pane client request union has no availability queue method and its kinds omit availability (apps/server-pilot/src/ai/hms-jobs.ts:1797–1821,3259–3265; apps/server-pilot/src/trpc/routes/pane-stay-lookup.ts:230–305,357–367; apps/mail/lib/quote-workflow/amend-find.ts:162–168,204–227). Prefetch defaults off (apps/server-pilot/src/ai/hms-jobs.ts:161–164). Current probe wraps one tool spawn in one property lock and has a five-minute timeout (apps/server-pilot/src/ai/hms-availability.ts:28–29,454–484,494–517).

**Smallest design.** Add a pane queue/read binding to the existing availability job. Let staff request the grid before selecting a room type. Pass only staff-confirmed HMS company/agency IDs as context. Keep BAR, confirmed contract context and government search results tagged by source/strategy. Do not claim a contract rate “qualifies” unless HMS returns it with verified party context and complete coverage. For government, use the recorded NGOVDB rate-plan fact; DBB dinner is a separately configured allowance, not a generic government DBB rate (docs/context/FACTS.md:145–149). Preserve exact board. Show nightly stock or a clearly defined conservative stay minimum; do not turn nightly stock into full-stay bookability (docs/context/ACTIVE.md:60–61). Run BAR + contextual searches serially inside one outer property lock, not separate jobs/locks. Number of scenario searches and latency remain unproved.

**Files to change.** apps/server-pilot/src/ai/hms-availability.ts; apps/server-pilot/src/ai/hms-jobs.ts; apps/server-pilot/src/trpc/routes/pane-stay-lookup.ts; apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs; apps/server-pilot/tooling/playwright-quote/quote-contract.mjs only if the request contract needs multiple scenarios; apps/mail/lib/quote-workflow/amend-find.ts; apps/mail/components/quote-workflow/quote-workflow-panel.tsx; apps/mail/components/quote-workflow/rate-cards.tsx only for reusable grid presentation. No duplicate rate catalogue.

**Tests.** Update all direct current coverage: apps/server-pilot/tests/hms-availability-probe.test.ts:300–428,551–674; apps/server-pilot/tests/hms-availability-bookability.test.ts:26–79; apps/server-pilot/tests/hms-jobs.test.ts:2478–2508; apps/server-pilot/tests/pane-stay-lookup.test.ts:511–623,800; apps/server-pilot/tooling/playwright-quote/fetch-quote.test.mjs:242–265,352–399,530–590; apps/server-pilot/tooling/playwright-quote/quote-contract.test.mjs:325–413; apps/mail/tests/quote-workflow-panel.test.tsx:609–634,861–930; apps/mail/tests/rate-cards.test.tsx:191–273. Add queue→snapshot→grid binding coverage; no existing pane availability client test exists.

**Size / raw coding.** 320–450 changed product lines; 240–360 raw coding minutes. Tests/fixtures excluded from product-line count. One PR; split contract and UI only if coordinator measures >500 product lines.

**Depends.** Existing confirmed party fields only; U2 ranking is not required. Queue/file order after any approved prior quote-panel PR because quote-workflow-panel.tsx is shared. Same property lock serializes the actual HMS scenario batch.

**Risks.** Exact “party qualifies” coverage may require multiple searches. More queries mean more lock time. Current helper times out at five minutes; dated FACTS records 80–1,025s queue wait and 12–413s read duration, not current SLA (apps/server-pilot/src/ai/hms-availability.ts:28–29; docs/context/FACTS.md:145). A missing/partial scenario must show “not checked,” never zero rates. A rate with one open night is not a full-stay promise.

**Staff acceptance.** Before room pick, staff sees every returned room × eligible rate, exact board, nightly price, rooms-left definition and as-of time. BAR always has its own truth; contract appears only for the chosen, HMS-confirmed party; Gov appears only with the government request/context. No quiet room/rate pick. Missing/partial HMS results say so. Staff can pick a row to continue the existing quote flow.

## U2. Party suggestions and distinct people/party fields

**Current.** Party alias suggestions are unverified, but emitted sender/domain first and body mentions second (apps/server-pilot/src/ai/party-aliases.ts:1–15,81–92,100–151). PartyPicker searches the first suggestion when the field is empty (apps/mail/components/quote-workflow/party-picker.tsx:698–711). V3 can use a unique same-kind sender-history match; explicit same-kind email name defeats conflicting name-only history (apps/server-pilot/src/ai/party-match-v3.ts:268–308,342–371). Desired order therefore needs an explicit ranked UI suggestion contract; do not change V3 binding unless a failing row proves it.

Quote header has separate Agency and Company fields; its global party-complete check accepts either party ID, not both (apps/mail/components/quote-workflow/quote-workflow-panel.tsx:405–476,920–924). A separate extracted company question can still be missing, though plain company text satisfies that field; the Nexus “forced company” report needs its exact thread path checked before removing any per-field requirement (apps/mail/components/quote-workflow/quote-workflow-panel.tsx:923–924; docs/context/OWNER-ASKS.md:299). ContactBlock’s quote contact is a separate PDF contact (apps/mail/components/nava-pane/blocks/contact-block.tsx:20–44); booking card separately stores guest first/last, booking agency, organization and booker contact (apps/mail/components/quote-workflow/booking-card.tsx:508–536,755–786,864–876). PaneStay carries organization but no arAccount field (apps/mail/lib/quote-workflow/pane-stay-bind.ts:72–100; apps/server-pilot/src/ai/pane-stay-save.ts:50–65). Create CLI has an optional arAccount field; its organization→company mapping is explicitly LIVE-UNVERIFIED (apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs:339–341; apps/server-pilot/tooling/playwright-quote/create-request.mjs:168–172). Do not rename Organization to “bill-to company” until U5 proves Infor field identity.

**Smallest design.** Rank explicit email/body-named party > sender-history suggestion > domain. Keep domain suggestions unverified and never bind from domain. Preserve the shipped V3 unique same-kind history binder unless the Nexus trace disproves its safety; show its source/confirmation path (apps/server-pilot/src/ai/party-match-v3.ts:268–308,342–371; docs/context/ACTIVE.md:8–11). “No forced company” means public BAR can proceed without both company and agency; current global party gate already accepts either, while a separately extracted company answer may still need text (apps/mail/components/quote-workflow/quote-workflow-panel.tsx:920–924). Keep quote contact (PDF), guest, booker contact, A/R/bill-to company, organization, and booking agency as separately named fields and payloads. Reuse existing guest/contact/company/agency data; add an A/R field only after U5 proves the Infor mapping.

**Files to change.** Ranking PR: apps/server-pilot/src/ai/party-aliases.ts; apps/server-pilot/src/ai/party-sender-map.ts; apps/server-pilot/src/ai/pane-party-lookup.ts; apps/mail/lib/quote-workflow/party-lookup.ts; apps/mail/components/quote-workflow/party-picker.tsx. Touch apps/server-pilot/src/ai/party-match-v3.ts only if ranking audit proves a current incorrect bind. Role-field PR, after U5: apps/mail/components/quote-workflow/booking-card.tsx; apps/mail/lib/quote-workflow/pane-stay-bind.ts; apps/server-pilot/src/ai/pane-stay-save.ts; apps/server-pilot/tooling/playwright-quote/create-tool.schema.json; apps/server-pilot/tooling/playwright-quote/create-request.mjs; apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs. Keep U3’s label fix in its own PR.

**Tests.** Ranking/binding: apps/server-pilot/tests/party-aliases.test.ts:9–97,99–150; apps/server-pilot/tests/party-match-v3.test.ts:180–285; apps/server-pilot/tests/party-sender-map.test.ts:37–81; apps/server-pilot/tests/pane-party-lookup.test.ts:207–241,410–460; apps/mail/tests/party-contract-picks.test.tsx:97–139,206–267; apps/mail/tests/party-picker-results.test.tsx:262–638,1248–1261; apps/mail/tests/party-auto-lookup.test.tsx:103–154; apps/mail/tests/party-index-typeahead.test.tsx:146–173; apps/mail/tests/quote-workflow-panel.test.tsx:1887–1925; apps/mail/tests/staff-quote-job-bind.test.ts:465–551,576–622. Role mapping: apps/mail/tests/booking-card.test.tsx:443–472,950–976; apps/server-pilot/tests/pane-stay-save.test.ts:103–143; apps/server-pilot/tooling/playwright-quote/create-lab-stay.test.mjs:40–106. Shared contact/label coverage is in U3b: apps/mail/tests/contact-block.test.tsx:58–77,116–149 and apps/mail/tests/nava-pane-render.test.tsx:2670–2714,2880–2919. Add tests for body > history > domain order, domain-only no bind, public BAR with neither party, and every distinct payload field.

**Size / raw coding.** Rank/no-forced-party PR: 100–180 product lines, 90–150 raw minutes. Role/payload separation: 160–260 product lines, 120–210 raw minutes; total 260–440 / 210–360. Tests excluded.

**Depends.** Keep ARCH order after U1 because the live pane files overlap (docs/research/2026-10-20-arch-lanes/ARCHITECTURE.md:53–55). Role/A/R mapping waits for U5. No silent use of stale memory as a verified company ID.

**Risks.** Sender domain can map multiple profiles; history can be ambiguous. Keep ranking deterministic and inspectable. Party score is only 20/22 on a circularly small set in ACTIVE; it still needs ≥100 non-circular truth rows (docs/context/ACTIVE.md:8–11). A/R and Organization may be distinct Infor controls.

**Staff acceptance.** A named company/agency in the email appears first; history second; domain third. A domain never binds. Staff can quote BAR without choosing both company and agency; an explicit company named in the ask remains editable as text. A contract requires confirmed party context. Staff sees and edits guest, quote/PDF contact, bill-to, organization and booking agency without one overwriting another.

## U3. Owner UI complaints (OWNER-ASKS 155–160)

**Current.** “Complete stay details” is chosen when the first missing field has priority 2; its button only scrolls to quote-stay. The direct UI test asserts this label (apps/mail/components/quote-workflow/quote-workflow-panel.tsx:1517–1527,1557–1572; apps/mail/tests/quote-workflow-panel.test.tsx:609–634). New booking is passed quote=true, so ContactBlock renders “Quote contact — printed on the PDF” (apps/mail/components/nava-pane/nava-pane.tsx:2205–2215; apps/mail/components/nava-pane/blocks/contact-block.tsx:40–44). The date/text mismatch complaint belongs to amend display (U6), not quote-step code.

**Ask map.** 155 architecture/ROI answer, no code yet (docs/context/OWNER-ASKS.md:296). 156 automatic letter/pro forma vs booking, U4/U5 evidence (docs/context/OWNER-ASKS.md:297). 157 availability before room choice, U1; payment effect, U5/U6 (docs/context/OWNER-ASKS.md:298). 158 generic stay jump and new-booking contact label, this unit; company/agency selection, U2; amend date copy, U6 (docs/context/OWNER-ASKS.md:299). 159 domain/profile ranking, U2 (docs/context/OWNER-ASKS.md:300). 160 worktree/model/parallel routing, this plan only; no product code (docs/context/OWNER-ASKS.md:301). 161–162 are memory-product research/owner questions, outside P1 U1–U7 (docs/context/OWNER-ASKS.md:302–303).

**Smallest fixes / files.** U3a: remove only the generic scroll CTA for “Complete stay details”; keep the missing-answer text and focused actions like Add stay dates. apps/mail/components/quote-workflow/quote-workflow-panel.tsx. U3b: pass quote=true only for quote flows; new_booking uses plain Contact. apps/mail/components/nava-pane/nava-pane.tsx; contact-block.tsx only if its API needs a narrower intent enum. Do not fix amend copy here.

**Tests.** U3a: apps/mail/tests/quote-workflow-panel.test.tsx:609–634; update assertion and prove targeted Add stay dates still works (apps/mail/tests/quote-workflow-panel.test.tsx:430–460). U3b: apps/mail/tests/contact-block.test.tsx:58–77,116–149; apps/mail/tests/nava-pane-render.test.tsx:2670–2714,2880–2919; add new_booking label assertion. If broader pane classification changes, include the other readAs cases in that same nava-pane-render file.

**Size / raw coding.** U3a 5–12 product lines, 10–20 raw minutes. U3b 4–8 lines, 5–15 minutes. Separate PRs: one button behavior each.

**Depends.** Queue U3a behind U1/U2 panel edits. Queue U3b behind U2 or any nava-pane owner. No backend or HMS dependency.

**Risks.** Removing one confusing jump must not hide the missing question or remove useful targeted navigation. “Breaks panel” is owner report; code confirms the generic scroll, not the break mechanism.

**Staff acceptance.** Missing dates still say Add stay dates. Generic incomplete-stay state no longer scroll-jumps to a confusing target. New booking says Contact; quote says Quote contact — printed on the PDF.

## U4. Separate quote documents from booking create

**Current.** DocumentReview already has Prepare PDF, Download Excel, editable reply; prepared reply/PDF then explicit Save/Insert creates an unsent mailbox draft. Nava does not send (apps/mail/components/quote-workflow/document-review.tsx:104–175; apps/mail/components/nava-pane/nava-pane.tsx:1860–1909; apps/mail/components/nava-pane/reply-body.tsx:115–138,217–225; docs/plans/2026-10-20-001-fix-centurion-quote-ready-plan.md:38–44,58–64). Booking card already has Preview in HMS → explicit Book; “Nothing is saved” before click (apps/mail/components/quote-workflow/booking-card.tsx:328–452,649–655). RESERVATIONIST_PANE_SAVE accepts exactly lab/on at the outer pane guard; lab requires surname Labtest and arrival >=2027, and commit is preview-digest/once-only guarded (apps/server-pilot/src/ai/pane-stay-save.ts:134–177,333–398). Separate write runner only accepts exactly lab (apps/server-pilot/src/ai/pane-hms-write.ts:87–90). Create CLI requires guaranteeType and selects the exact combo label; current tests prove schema/stop-before, not live combo/save/mail (apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs:15–26,71–78,343–347,388–420; apps/server-pilot/tooling/playwright-quote/create-lab-stay.test.mjs:83–140).

The lane prompt says Labtest create fails at guarantee-type combo “per ACTIVE.md”; current ACTIVE.md says create is guarded/not production-proven and shows only a dated 2026-10-14 flag observation, not that combo failure (docs/context/ACTIVE.md:56–71). The combo failure is therefore an unchecked report; docs/research/2026-10-20-arch-lanes/l4-infor-order-dropped.md:99 records a guarantee block, but does not resolve which current run/fixture. OWNER-ASKS reports Confirmation Letter mail evidence but does not prove this Save emits that letter (docs/context/OWNER-ASKS.md:297).

**Smallest design.** Preserve prior quote plan as Q0: one primary Prepare PDF + reply action; Excel remains its own download. Add or rename a visibly separate Create provisional booking end only after “provisional” is proved to be Infor’s resulting state. Keep Preview → explicit Book. No Save-on-open, no auto-send assumption, no one-click draft. Unknown result after Save must say “check HMS before retry”; existing backend treats unconfirmed save as possibly saved (apps/server-pilot/src/ai/pane-stay-save.ts:409–425; apps/mail/tests/booking-card.test.tsx:860–917).

**Files to change.** Q0 prior plan, separate behavior PR: apps/mail/components/quote-workflow/quote-workflow-panel.tsx; apps/mail/components/quote-workflow/document-review.tsx; apps/mail/components/nava-pane/nava-pane.tsx; apps/mail/components/nava-pane/use-insert-ai-draft.ts; apps/mail/components/nava-pane/reply-body.tsx. Booking end path, later: apps/mail/components/quote-workflow/booking-card.tsx; apps/mail/lib/quote-workflow/pane-stay-bind.ts; apps/server-pilot/src/ai/pane-stay-save.ts; apps/server-pilot/src/ai/pane-hms-write.ts; apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs only for a reproduced defect. Do not broaden write mode to on in this slice.

**Tests.** UI and unsent draft: apps/mail/tests/booking-card.test.tsx:670–719,770–917; apps/mail/tests/nava-pane-render.test.tsx:1392–1410,1644–1703; apps/mail/tests/quote-workflow-panel.test.tsx:1557–1600,1937–2007; apps/mail/tests/document-review.test.tsx:53–98; apps/mail/tests/outlook-pane-quote-pdf.test.tsx:446–520; apps/mail/tests/save-reply.test.tsx:110–146,222–297; apps/mail/tests/outlook-pane-multi-draft.test.tsx:284–335. Guards: apps/server-pilot/tests/pane-stay-save.test.ts:103–143,256–425; apps/server-pilot/tests/quote-workflow-router.test.ts:496–578; apps/server-pilot/tooling/playwright-quote/create-lab-stay.test.mjs:83–140. Add an explicit separation test: no quote click triggers create, no create click triggers quote/draft/mail.

**Size / raw coding.** Q0 is inherited from prior plan: 80–150 changed product lines, 55 raw code minutes as prior estimate (docs/plans/2026-10-20-001-fix-centurion-quote-ready-plan.md:81–91). New booking end affordance/copy: 120–240 product lines, 120–180 raw minutes. Tests excluded. No implementation until gates below.

**Depends.** Q0 remains proposed-not-authorized per prior plan; owner approval still needed. Create affordance waits on U5 field/state evidence, U2 role fields, current exact guard review, and separately authorized Save/mail observation. U1/U2 inputs should remain the same case, but the quote and create end states stay separate (docs/research/2026-10-20-arch-lanes/ARCHITECTURE.md:7–10; docs/research/2026-10-20-arch-lanes/grok-4.7-review.md:30–35).

**Risks.** “Provisional” may not be the saved status. Save may generate an automatic guest Confirmation Letter. Guarantee combo failure is not reproducible from current static tests. Timeout may mean HMS saved. No feature flag or write execution is authorized by this plan.

**Staff acceptance.** One quote route: review and make PDF/reply; Excel separately; explicit unsent draft save; staff sends. One separate booking route: Preview, inspect exact Infor fields, then explicit Book. Staff sees the verified post-save state and whether HMS mailed. Until proved, booking action remains copy-only or hidden.

## U5. Read-only Labtest booking-state / DOM probe (spec only)

**Current.** Existing read-reservation-fields tool is read-only and allowlists OSRESS.search and OSRESV.HDR. Its fields include guaranteeType, company, araccountname, ta1, settlementtype and depositreceived; that reader does not include balance (apps/server-pilot/tooling/playwright-quote/read-reservation-fields.mjs:1–19). Existing DOM snapshots capture visible labels/inputs for the opened stay (apps/server-pilot/tooling/playwright-quote/stay-lookup-dom.mjs:1–8). A separate server stay projection carries balance and guaranteeType but drops depositreceived/settlementtype; pane wire type likewise lacks those two fields (apps/server-pilot/src/ai/pane-stay-lookup.ts:228–248; apps/mail/lib/quote-workflow/amend-find.ts:65–86). These field names are candidate evidence, not yet verified payment semantics.

**Probe spec.** Add deterministic Playwright-only script. Open one existing Guest Stay whose exact surname is Labtest; no other guest. Reuse the read-only login/context and read helpers. Capture visible label, input name, visible value, disabled/read-only state, and record region for guarantee, deposit received, settlement, balance, A/R/company, booking agency and status. Compare only fields exposed by both DOM and allowlisted reader; record DOM-only/API-only fields as such, never coerce missing to zero. Preserve source and “not shown/unknown,” never infer paid from email or zero balance. Mask names/confirmation in output. Assert read-only endpoints only; block Save/cancel/create/write requests and fail closed on any unexpected route. Never import/call create-lab-stay.mjs.

This probe can show where fields live, not whether Save auto-mails. Report send_on_save=unknown. Separate proof needs owner-authorized Labtest Save plus mailbox/outbound-letter observation; do not do that now (docs/research/2026-10-20-arch-lanes/ARCHITECTURE.md:62–70; docs/context/OWNER-ASKS.md:297; docs/research/2026-10-20-arch-lanes/grok-4.7-review.md:43–45).

**Files to change.** New apps/server-pilot/tooling/playwright-quote/labtest-booking-state-probe.mjs; new apps/server-pilot/tooling/playwright-quote/labtest-booking-state-probe.test.mjs; redacted fixture under apps/server-pilot/tooling/playwright-quote/fixtures/labtest/ only if captured data is sanitized. Keep existing reader/DOM files unchanged unless a deterministic offline test proves a reusable parser gap.

**Tests.** Add the new offline Playwright/DOM test; existing apps/server-pilot/tooling/playwright-quote/read-reservation-fields.test.mjs:1–22,319–330; apps/server-pilot/tooling/playwright-quote/stay-lookup-dom.test.mjs:410–466. If verified fields are later projected into pane output, also apps/server-pilot/tests/pane-stay-lookup.test.ts:204–338 and apps/mail/tests/amend-find-panel.test.tsx:1—but that is a separate behavior PR, not this probe.

**Size / raw coding.** 80–140 product/tool lines; 75–120 raw coding minutes. Does not include live session time or authorized Save/mail proof.

**Depends.** A valid Labtest read record and session authorization for the future operator; this planning run has neither live check nor authorization. Serialize under the hotel property lock.

**Risks.** DOM label may differ from raw field name; field presence does not prove business meaning. A read-only probe cannot answer send-on-save. Keep PII out of fixture/output. One guest only.

**Staff acceptance.** Staff can point to the exact visible Infor control for deposit, guarantee, settlement and billing party; output records DOM/API agreement or a named mismatch. No write request occurs. Mail behavior remains explicitly unknown until separate proof.

## U6. Unknown/ambiguous booking-link CHECK screen (size only; lower priority)

**Current.** Backend returns found/not_found/ambiguous and read-only reservation facts (apps/server-pilot/src/ai/pane-stay-lookup.ts:215–248). UI distinguishes non-exact, ambiguous, no-number and manual surname+arrival search; a bare number is not promoted to confirmation (apps/mail/lib/quote-workflow/amend-find.ts:11–62; apps/mail/components/quote-workflow/amend-lookup-panel.tsx:187–212,538–635). Ambiguous confirmation currently says check HMS directly. Candidate search exists, but a test for switching to a second selected booking is skipped (apps/mail/tests/amend-find-panel.test.tsx:1547–1580).

**Smallest future design.** Explicit CHECK result for unknown/ambiguous link: show candidates and source facts, require staff to choose one exact confirmation, then re-read that confirmation before any amend/cancel preview. CHECK itself is read-only. Do not infer paid/provisional from mail and do not enable write actions from ambiguous candidates.

**Files if approved.** apps/mail/components/quote-workflow/amend-lookup-panel.tsx; apps/mail/lib/quote-workflow/amend-find.ts; apps/server-pilot/src/ai/pane-stay-lookup.ts only if the current result contract lacks verified fields. No pane-stay-cancel.ts or cancel CLI write change in a CHECK PR.

**Tests.** apps/mail/tests/amend-find-panel.test.tsx:758–829,1073–1215,1282–1345,1547–1580; apps/server-pilot/tests/pane-stay-lookup.test.ts:204–338; apps/server-pilot/tooling/playwright-quote/stay-lookup-dom.test.mjs:345–382. If the state screen gates cancellation, include apps/server-pilot/tests/pane-stay-cancel.test.ts:123–194 and apps/server-pilot/tooling/playwright-quote/cancel-stay-rules.test.mjs:73–95.

**Size / raw coding.** 80–160 product lines; 60–105 raw coding minutes. Conditional estimate only; no implementation scheduled.

**Depends.** Later than U5, so displayed status facts are real and named. Separate amend/cancel lane. Exact candidate selection and re-read must be specified before writing.

**Risks.** A wrong guest is severe. Current on-mode cancel can allow real guests (apps/server-pilot/src/ai/pane-stay-cancel.ts:243–247); do not change it. Existing skipped second-candidate test flags a concrete edge (apps/mail/tests/amend-find-panel.test.tsx:1547–1580).

**Staff acceptance.** If link is unknown or ambiguous, staff sees “Check this booking,” candidate identity facts and no change/cancel control. After explicit choice, staff sees an exact-confirmation reread; only then may the existing approved workflow continue.

## U7. Open quote carry-overs: TTL/retry and truth set

**Current.** The prompt’s “staff_quote 10-minute TTL drops burst tail” does not match current source. Current priced result reuse is 24h from HMS asOf; other result expiry is 6h (apps/server-pilot/src/ai/hms-jobs.ts:191–196,2752–2775; apps/server-pilot/tests/staff-quote-result-expiry.test.ts:8–45). Prepared property-lock busy yields without consuming an attempt for up to 15m, then dead-letters; a separate party-verification lock-busy path allows one attempt (apps/server-pilot/src/ai/hms-jobs.ts:2583–2588,3192–3219). System-prepared non-attach transient gets one attempt; attach failure gets two total attempts (one retry); ordinary jobs default to three (apps/server-pilot/src/ai/hms-jobs.ts:2591–2609,3221–3229; apps/server-pilot/tests/prepared-quote-attach-retry.test.ts:114–156,192–240). Ten minutes exists for pane-save preview grant, not staff_quote result TTL (apps/server-pilot/src/ai/pane-stay-save.ts:333–335; apps/server-pilot/tests/pane-stay-save.test.ts:387–416). Current ACTIVE says unresolved safe writes and no current product work; OWNER-ASKS row 151 names prepared-quote TTL/retry as open (docs/context/ACTIVE.md:56–71; docs/context/OWNER-ASKS.md:292).

**Smallest plan.** First define which object drops the burst tail: queued job, staff_quote row/result, source freshness, auto-start idempotency, or pane preview. Reproduce one burst with job IDs and timestamp boundaries; distinguish enqueue/claim/start/finish/readback. No TTL change until that evidence points to one value. If a real TTL defect is confirmed, change only that behavior in apps/server-pilot/src/ai/hms-jobs.ts or its specific owner, not all result freshness.

Quote proof: reuse prior quote plan’s minimum of ≥10 independent, plannable real asks; compare exact plan + each night’s price and explain HMS mismatches. Check false negatives separately; keep attachment input equal to production (docs/plans/2026-10-20-001-fix-centurion-quote-ready-plan.md:95–97; AGENTS.md:68; docs/context/MISTAKES.md:26). This is quote behavior proof, not broad accuracy. Broad party/classification accuracy still needs ≥100 truth rows by id not produced by the system under test (AGENTS.md:74; docs/context/ACTIVE.md:8–11).

**Files to change.** TTL/retry only if reproduced: apps/server-pilot/src/ai/hms-jobs.ts and matching focused tests. Truth proof: no product code; new dated evidence artifact/fixture only after inputs are available. No truth file created in this plan-only pass.

**Tests.** TTL/retry: apps/server-pilot/tests/prepared-quote-attach-retry.test.ts:114–240; apps/server-pilot/tests/staff-quote-result-expiry.test.ts:8–74; apps/server-pilot/tests/hms-jobs.test.ts:1045–1188,1382–1408,1522–1549. Quote evaluation: apps/server-pilot/tests/quote-ready.test.ts:62–101 and apps/server-pilot/tests/quote-ready-eval.test.ts:30; source artifacts/data locators still need validation. Add tests only for the reproduced TTL boundary and retry class.

**Size / raw coding.** TTL/retry defect if verified: 30–100 product lines, 45–90 raw coding minutes. TTL diagnosis first: 30–60 raw evidence minutes, unscoped. Ten-thread truth proof: 0 product lines / 0 code minutes; budget 135–180 raw evidence/curation minutes, using prior 29-thread proof that took ≥135m and remained incomplete (docs/plans/2026-10-20-001-fix-centurion-quote-ready-plan.md:97). Actual access/labeling time unchecked.

**Depends.** TTL scope clarification and replayed job evidence. Shares apps/server-pilot/src/ai/hms-jobs.ts with U1; queue writer. Quote truth needs final quote input and staff/HMS truth locators. No tuning from one baseline; if tuning is later proposed, fresh rows and baseline ×2.

**Risks.** Do not shorten 24h priced evidence or change retry counts from an unverified summary. A noisy burst may be queue wait, not expiration. A ten-thread result cannot support a broad accuracy claim.

**Staff acceptance.** A burst-tail request either starts or returns a precise retry/refusal state; it does not vanish. Staff can reuse a still-fresh priced result or see why it expired. On ≥10 independent quote asks, report n/source/input parity and same-move-as-staff outcome; no accuracy claim from circular rows.

# PR slices

Product-line estimates exclude tests and fixtures. Every slice stays below the AGENTS limit; split before review if measured diff crosses it. One behavior per PR (AGENTS.md:33–44).

| Slice | One behavior | Changed product lines | Raw code minutes | Dependency / gate |
|---|---|---:|---:|---|
| Q0, prior plan | Promote single quote PDF + reply action; keep Excel separate and draft unsent | 80–150 | 55 inherited | Proposed-not-authorized; prior plan remains source of truth, do not duplicate/silently replace |
| P1.1 / U1 | Pre-room all-room rate snapshot with party/board/source and rooms-left display | 320–450 | 240–360 | Existing availability job; one lock; no U2 rank dependency |
| Q1, prior plan U6 | Move existing rate selection beside existing pre-read HMS prices; do not clone prices/cards | ≤200 | Raw code-only not separated from prior gate-inclusive estimate | Separate follow-up after U1 validates rate binding; prior plan explicitly retains it |
| P1.2a / U2 | Suggestion ranking and no forced party for public BAR | 100–180 | 90–150 | After U1/shared pane; domain never binds |
| P1.2b / U2 | Keep quote contact, guest, bill-to, organization, booking agency separate | 160–260 | 120–210 | After U5 proves A/R field mapping |
| P1.3a / U3 | Remove generic Complete stay details jump | 5–12 | 10–20 | After U1/U2 edits to quote-workflow-panel.tsx |
| P1.3b / U3 | New booking shows Contact, not PDF quote label | 4–8 | 5–15 | After U2 edits to nava-pane/contact fields |
| P1.4 / U5 | Read-only Labtest state/DOM probe | 80–140 | 75–120 | New files only; authorized read session for future live probe |
| P1.5 / U4 | Separate Create booking end from quote-document path | 120–240 | 120–180 | U2b + U5 + Q0 decision + explicit owner approval; no automatic send assumption |
| P1.6 / U7 | TTL/retry repair, only if the dropped object is reproduced | 30–100 | 45–90 | Clarify exact TTL and failure class; queue behind U1 on hms-jobs.ts |
| P1.7 / U6 | Read-only CHECK screen for unknown/ambiguous link | 80–160 | 60–105 | Later; after U5 field truth; separate amend/cancel worktree |
| Evidence / U7 | ≥10 independent quote threads, exact plan/night proof | 0 | 0 code; 135–180 evidence | New report/fixture only after locator and input parity check |

# Parallelism matrix

| Unit | File ownership | Parallel status | Reason / queue |
|---|---|---|---|
| U1 | hms-availability.ts, hms-jobs.ts, pane-stay-lookup route, fetch-quote/quote-contract, amend-find.ts, quote-workflow-panel.tsx, rate-cards.tsx | Quote workflow writer; serialize | U7 TTL shares hms-jobs.ts. U2/U3/Q0/Q1 share quote panel/client files. One WIP for this workflow. |
| U2a | party-aliases.ts, party-sender-map.ts, pane-party-lookup.ts, party-lookup.ts, party-picker.tsx | Queue after U1 in same workflow | U2 file changes may alter first-suggestion and party waits; one quote/stay WIP. |
| U2b | booking-card.tsx, pane-stay-bind.ts, pane-stay-save.ts, create schema/request/CLI | Queue after U5 and U2a | U5 establishes A/R control; U4 shares booking-card/save/CLI files. |
| U3a | quote-workflow-panel.tsx and its focused test | Queue with U1/U2/Q0 | Same component; do not let concurrent writers edit it. |
| U3b | nava-pane.tsx, contact-block.tsx and focused tests | Queue with U2b/U4 | Same pane role/contact data; one writer. |
| U4 | quote/document review, nava-pane, booking-card, pane save/write and create CLI | Queue last in quote workflow | Wait for U5 proof and U2b field model; split quote CTA Q0 from create behavior. |
| U5 | New labtest-booking-state-probe.mjs + its new test/fixture | Can code in parallel with U1/U2a | Disjoint new files only. Do not edit shared reader/DOM helpers without queueing. A live probe still serializes on the hotel property lock. |
| U6 | amend-lookup-panel.tsx and amend-find-panel.test.tsx | Can size/design in parallel; implementation after U5 | UI files disjoint if no amend-find.ts or shared server projection edits. Queue any such shared-file change with U1/U5. |
| U7 truth | New isolated dated evidence artifact/fixture | Parallel when truth locators exist | Docs/eval data only; identical production input required. No product writer overlap. |
| U7 TTL/retry | hms-jobs.ts and retry/expiry tests | Queue behind U1 | Same server owner file and same quote workflow. |

Parallel writers mean own worktree/branch from main and disjoint files; no shared-file concurrency. Actual HMS reads/writes remain serialized through the hotel property lock. One verifier per PR. No tests/typecheck/HMS run here; later gates must follow AGENTS.md:65–76.

# Critical path with raw minutes

**Core code chain, conditional on Q0 staying in scope:** Q0 55 + U1 240–360 + U2a 90–150 + U3a/b 15–35 + U2b 120–210 + U4 120–180 = **640–990 raw coding minutes**. U5 script code is 75–120 minutes and can run beside U1/U2a; its read-only result must arrive before U2b/U4. Q1 is a separate follow-up; the prior plan’s 45-minute working allowance includes focused tests/review, not raw code-only, so do not add it as a coding estimate without re-scoping (docs/plans/2026-10-20-001-fix-centurion-quote-ready-plan.md:154–160). Current live-read duration and property-lock wait are unknown; dated prior read measurements are not a present ETA (docs/context/FACTS.md:145). If Q0 is already done or is not approved, subtract its inherited 55 minutes.

Then add U7 quote truth evidence: **135–180 raw evidence/curation minutes**, not coding. U6 is a later 60–105-minute branch. U7 TTL repair adds 45–90 coding minutes only if a current 10-minute defect is reproduced. Excludes focused tests, remote gates, reviews, approval wait, deploy, and final live proof; no wall-clock delivery ETA claimed. AGENTS requires the longest code+review+deploy+live-proof chain, but this read-only task cannot time those gates (AGENTS.md:44).

# Stale PR overlap

No GitHub/current PR check: user forbids Git/network. Table is local-document evidence only; all actions are recommendations, not performed.

| PR | Local overlap evidence | Recommendation |
|---|---|---|
| #301 | No PR record found in current required docs. The only local #301 mention located is a party/native entity result, not a PR (docs/research/2026-10-19-party-lookup-evidence.md:155). | Unknown. Do not rebase. Inspect its file/behavior diff later; if it is U2, supersede only after extracting unique verified work. |
| #307 | Local AGENTS says it merged within an hour once party work was split (AGENTS.md:66–67). | Treat as merged history; no duplicate. If remote still shows open, verify status before close. |
| #308 | Local retro calls it party slice 2, six adjacent-P1 rounds, blocked (AGENTS.md:66–67; docs/context/MISTAKES.md:32). Direct U2 overlap. | Close/supersede after diff review; do not rebase or stack. Carry forward only independently verified tests/decisions. |
| #320 | Handoff says dvread, likely superseded by #362/#381 (docs/plans/2026-10-19-coordinator-handoff.md:26–27). No core U1–U7 behavior. | Close if still open and no unique live code/test. Do not rebase into these slices. |
| #334–#337 | Handoff only says “10–15 runs”; no scoped PR descriptions (docs/plans/2026-10-19-coordinator-handoff.md:26–27). | Unknown overlap. Inspect diffs first. Close run-output-only PRs; supersede only if a run becomes U7 truth evidence. No blind rebase. |
| #248 | No current required-doc PR record found. | Unknown. No recommendation to rebase. Inspect changed files/behavior before assigning overlap. |
| #223 | FACTS labels docs/overnight-20261014 open/conflicting, dated 2026-10-15 (docs/context/FACTS.md:115–120). No product-code overlap. | If still open, close/conflict-resolve as docs-only; preserve any unique durable evidence in the correct research index. Do not rebase into a product slice. |

# Open questions / assumptions

- [UNCHECKED] origin/main SHA 3e1acb694 came from user. Git was explicitly forbidden, so this session did not verify it.
- [UNCHECKED] The reported Labtest guarantee combo failure is not stated in current ACTIVE.md:56–71 (docs/context/ACTIVE.md:56–71). Need exact failing option, date, test record, and error before calling it reproduced.
- [UNCHECKED] Does HMS Save auto-mail the Confirmation Letter for this create path? Mailbox evidence in docs/context/OWNER-ASKS.md:297 does not prove Save-to-mail causality.
- [UNCHECKED] What saved status is “provisional” in Infor? Current UI says Book in HMS; no source proves status semantics (apps/mail/components/quote-workflow/booking-card.tsx:226–227,649–655).
- [UNCHECKED] Is bill-to company the Infor company field, A/R account, or another control? The reader exposes company and araccountname; writer maps organization to company but comments LIVE-UNVERIFIED (apps/server-pilot/tooling/playwright-quote/read-reservation-fields.mjs:10–18; apps/server-pilot/tooling/playwright-quote/create-request.mjs:168–172).
- [UNCHECKED] Can one HMS session return BAR, exact-party contract and NGOVDB/DBB coverage in one lock-bounded batch? Existing quote search selects one strategy per query (apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs:358–379); no live coverage proof.
- [UNCHECKED] Owner says a 10-minute staff_quote TTL drops burst tail. Current code instead shows 24h priced-result reuse, 6h other result TTL, 15m prepared lock wait, and class-specific retry; identify the exact queue/result object before changing (apps/server-pilot/src/ai/hms-jobs.ts:191–196,2583–2609,2752–2775,3211–3229).
- [UNCHECKED] Current RESERVATIONIST_PANE_SAVE process flags and any live write authority. ACTIVE’s only env observation is dated 2026-10-14 and explicitly says not to infer permission (docs/context/ACTIVE.md:64–71).
- [UNCHECKED] Current remote state/diff of #301, #307, #308, #320, #334–#337, #248 and #223. Recommendations above use only dated local docs.
- [UNCHECKED] Prior quote plan remains proposed-not-authorized. Keep its single PDF+reply primary action, separate Excel, explicit unsent Save/Insert, and its existing-rate-selector follow-up explicit; U1 is a new pre-room all-room snapshot and does not silently replace prior U6 (docs/plans/2026-10-20-001-fix-centurion-quote-ready-plan.md:38–44,81–97,154–160).
