Plan review first. I'll read the ponytail rules and `plan.md`, then only the cited prod files if a cut needs proof.Plan claims reuse points. I'll check those files in the prod snapshot before cutting anything.Hindsight empty. Next I check the cited reuse points so cuts sit on real code.`board` is already on the fetch path. I'll check where the snapshot drops it and whether a second HMS read is already avoidable.Critical path is U5a→U5b→U6→U9 plus U11/U12. Cuts that don't sit on that chain don't count. Checking a few load-bearing claims so I don't cut the wrong thing.**Cut ~140 min on U5a→U6 chain. Overlay is tag, not second HMS read.**

U1: shrink Contact label. Flip `quote` prop at `nava-pane.tsx:2213` so `new_booking` stays false. Title already `'Contact'` at `contact-block.tsx:42`. One assertion. Skip snapshot `:1091`. saves ~15 min

U2: shrink BAR grid. Drop new `QuoteSession` grid DTO (`types.ts:247,662`). Render `buildRateOptions` (`rate-options.ts:58`) from snapshot once `board` carried through `hms-availability.ts:418`. Drop room-code gate only (`quote-workflow-panel.tsx:960,1360`). Keep dates + occupancy. "not checked" = existing unknown/missing row. saves ~20 min

U2: yagni 200-option cap. `MAX_OPTIONS` already 200 (`quote-contract.mjs:7`). Pass `maxOptionsPerGroup: 200` + truncation flag. No contract change. saves ~8 min

U3: shrink party rank. Reorder `suggestPartiesFor` (`party-aliases.ts:144`): body mention, then `lookupLearnedSenderHistory` (`party-sender-map.ts:108`), then domain. Domain stays suggestion. Do not touch `party-match-v3`. Drop `party-picker` / `party-auto-lookup` sweep if rank fn covered. saves ~15 min

U3: merge party gate into U2. Same file `quote-workflow-panel.tsx:920-924`. `partyLookupWaitReason` (`session.ts:195`) is in-flight Find, not "must pick". Allow BAR with no party in U2 edit. saves ~10 min

U4: shrink Labtest probe. Extend `read-reservation-fields.mjs:10-18` (`guaranteetype`, `depositreceived`, `araccountname`, `ta1`, `company` already allowlisted). One fixture test. New `labtest-booking-state-probe.mjs` only if combo DOM missing. One Save + one date amend. Drop letter-watch wait; staff confirm send_on_save from one inbox glance. saves ~20 min

U5a: shrink extractor. Add optional per-stay `guestName`, `action`, `confirmationNumber`. Group key `(guest, dates)` in prompt (`extract.ts:54`). Stay id `stableId('s', messageId, guest, dates)` — `schema.ts:205` already hashes, today on index. Date anchor already uses `stays.length===1` (`schema.ts:233`). Top-level kind/action stay summary. saves ~15 min

U5a: shrink eval. One frozen triage pass (431). Second run only if first sits on noise edge. Background, off critical path. saves ~20 min

U5b: shrink consumers. Booking admit >1 stay (`quote-ready.ts:49`). `multi_date` = distinct date sets (`work-items.ts:314`). Fill `guestNames` (`:349`, today `[]`). Conf per stay, not `[0]` (`:355`, `:1302`). Prefetch first conf + note others — `selectHmsBatchRequest` (`hms-jobs.ts:505`) is one find. No work-item identity change. saves ~15 min

U6: shrink pane. One card per stay id. Quote/booking reuse quote panel. Amend/cancel pass that card's conf# into existing `AmendLookupPanel`. Combined proposal already at `document-review.tsx:136`. No new card framework. saves ~25 min

U7: reuse CHECK. Port #335 `pickStayFromFindRows` / `stayPickCaption` (no extra HMS call). Reopen candidate list when link missing/ambiguous/suspect (`amend-lookup-panel.tsx:192` hides search once resolved). Exact conf# re-read = existing `findStay` before `previewAmend` (`:268`). Unskip `:1547` only if that assert matches. saves ~15 min

U8: shrink unpaid amend. Map `depositReceived` from reader field already in `FIELDS`. Unpaid = zero/empty; else unknown → CHECK / "handle in HMS". Preview/Approve only unpaid + exact conf# + CHECK. Gate stays `lab` (`pane-hms-write.ts:87`). Do not add `on` arm. Live amend = U4's one amend. saves ~15 min

U9: shrink two buttons. Relabel `Prepare PDF + reply` (`quote-workflow-panel.tsx:1583`) to **Make quote**. Surface existing Preview→Book as **Create provisional booking**. `primaryAction={false}` (`:1994`) stays. Real guest: disabled + "Booking writes are off — create in HMS". No new action machine. saves ~15 min

U10: shrink overlay. No second HMS read. `fetch-quote.mjs:519` already sets `rateScope` public/contextual. Carry that flag + Government strategy (`quote-ready.ts:223`) into grid tags. Reuse `RatePlanCategory` (`quote-workflow-panel.tsx:298`). Confirmed party with no contract row = "not checked", not a 12–413 s read. Drop `party-contract-rates` live path. saves ~40 min

U11: shrink replay. Multi-ask: 17 core threads only, truth = HRCEN letter pairs, pass = N cards = N pairs. Drop R2 cohort. Quote nights: 8 already in pool, label "measured improvement" if n<10. CHECK: golden rows + corpus amend with no conf# / ambiguous. No rate. saves ~25 min

U12: shrink live e2e. One deploy. Health + flags + one bundle load. One prod grid read. Labtest writes already spent in U4. Outlook + webmail smoke on R1 card, R2 grid, R4 label, R8 buttons. Skip per-requirement HMS tour. saves ~20 min

**Keep — do not cut**
- U5a triage eval ×1. v5 died on macro-F1. Prompt change without one frozen pass ships a bad extractor.
- U4 one Save + one date amend. R5/R7 proof. Reader fields do not show Save-stops-at-combo or in-place amend.
- CHECK before any preview/write (R6). Suspect link must not reach amend.
- Unpaid vs unknown split (R7). Letters are boilerplate (1,174/1,174). Unknown stays "handle in HMS".
- Work item stays one per message (A2). Per-message identity change blows blast radius for 6.7% multi-ask.

net: -140 min on critical path
Verdict: ship all R1–R9 thinner. Overlay tags the read you already do. Do not add a second HMS read or a new card/action framework.
