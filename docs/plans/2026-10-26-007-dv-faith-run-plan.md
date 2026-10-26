---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
title: Da Vinci full-product run for the Faith call (run plan 007)
date: 2026-10-26
asks: 273, 274
supersedes: 2026-10-26-006 (run sections); 006 stays as history
---

# Run plan 007 — Da Vinci first, both hotels by design

Owner asks: 273 + 274 (verbatim in [ask 274 file](../context/asks/2026-10-26-ask274-walkthrough-and-owner-voice.md)). Evidence: [DV readiness](../research/2026-10-26-dv-faith-readiness.md). Main at plan time: `d4b37acbc` (= prod).

**Goal.** By the Faith call (2026-10-27), as much as possible works end to end on HRDAV from the Outlook side pane: prefilled-on-arrival quote + PDF/Excel + reply draft, all qualifying rates incl. wholesale, provisional create with HMS screenshots on return, confirmation recipient chosen per user, amend/cancel of provisional stays, Jarat Tours shuttle draft. Same code path for HRCEN (profile-driven), Centurion live proof last.

**No time limit, but ship order = Faith value.** Staff are not using the pane until we say so (owner 10-26), so deploy per merge is fine.

## 0. Decisions taken (owner 274 + evidence)

| # | Decision | Basis |
|---|---|---|
| D1 | No hotel literals in new code. Every per-hotel fact lives in `property-profiles/<CODE>.json` (rates, rooms, boards, letters, email fields). Onboarding a hotel = new profile + install JSON + canary | owner 274.1; 20 src files still carry `'HRCEN'/'HRDAV'` literals (grep 10-26); new code must not add more, R0 removes the rate/letter ones |
| D2 | Never throw away HMS data. Read every row the page already loaded; keep unused fields in the evidence JSON and types with a `// read, unused in UI` comment | owner 274.21; MISTAKES "never discard HMS data" |
| D3 | Background reads start at **ingest** (BCC of inbound + outbound), not at pane open. Pane only reads prepared state | owner 274.17; code already does this (`prefetchQuoteReadyForExtraction`, hms-jobs.ts:2656, runs after extraction). Gap = cap 20/h, strategy fan-out, DV failures |
| D4 | Confirmation letter recipient: per-user default (self / client / custom) in `user_settings.settings` jsonb (no migration), editable per booking in the pane, written by the deterministic create tool into the HMS field that drives the letter | owner 274.3/15/26; Infor docs: CRS Confirm-to-Email takes typed addresses + checkboxes ([Infor 2026.09](https://docs.infor.com/hms/2026.09/en-us/hmsolh/s_t1424428583967.html)); Guest Stay form has `emailtypecode` + `emailaddress` (fixture `stay-lookup/record-form-live.html`); repo `docs/infor-hms/CONTEXT.md:96`. **Which path auto-mails on Save is unproven** → E0 |
| D5 | Paid amend/cancel = out of scope for Nava this run (not "refuse + review"). Show "Paid booking: handle in HMS" and stop | owner 274.19 |
| D6 | Cancellation penalty dialog → refuse and stop, never click Waive/OK | PRODUCT hard rule; `cancel-stay-rules.mjs:320` |
| D7 | NR = **Non-Rewardable** (loyalty), not non-refundable. Map `… NR` boards like `… R` | corpus: DV folios print "Package Bed n Breakfast Non-Rewardable" (threads-transport-faith/ayanda); boards map has `Bed & Breakfast R` = Rewardable; profile has `Bed & Breakfast NR`. Confirm with Faith on the call (one line) |
| D8 | "Terms document" = the hotel's own sent quote/letter PDF that proves "rates include VAT and 1% Tourism Levy". Nava needs it because the quote PDF states tax inclusion only with a source. DV has it installed: 5 owner refs × 1 `hotel_rate_terms` doc each (prod read 19:0xZ). Not a blocker; no owner action | `reservationist-rate-policy-source.ts:84-125`; prod `RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV` |
| D9 | Screenshots retained ≥30 days on EC2 disk (own dir, counted in disk budget); S3 offload = later todo | owner 274.14 |
| D10 | Real-guest create stays `on` (owner 274.30: nobody uses the pane), unpaid cancel → `lab` until F1 (penalty refuse) is deployed, then back to `on` | owner "real-guest create=on fine"; D6 risk |
| D11 | Pomerado = last lane, goal-driven, Azure OpenAI via provider injection (`minterProvider/guardianProvider/outcomeReviewerProvider`); attaches via Playwright WS, **not** our CDP slot → needs its own `launchServer` browser on the DV slot host or an adapter | Exa run `agent_run_0ae24da9…` ($0.50); pomerado `docs/how-it-works.md`, `docs/getting-started.md#server-options` |
| D12 | Suggestions: option B now (chip propertyCode + autoStart not a pick); rate suggestion parked with ≥100-row eval | §8 parked |
| D13 | Party lookup unchanged (v2 picker + history bind, 20/22, 0 wrong on 42 mails). Only backtest if code changed; it hasn't | ACTIVE 10-19 |
| D14 | Reviews: `greptile review --apex` on every PR via CLI + the PR check; adversarial plan/migration review = Grok 4.7 xhigh (`cursor-agent --model grok-4.7-xhigh --mode plan`) | owner 274.18/31 |

## 1. Architecture (current → target, pseudocode)

### A. Rates per hotel — profile-driven classification + read everything

```
today:  rateScope = code in [BAR,BARRO,WAL] ? public : negotiated ? contextual : unknown   # fetch-quote.mjs:544 (Centurion literals)
        GOV = Centurion label regex                                                         # :601
        detailCandidates = options.length<=5 ? options : []  -> WS(17 rows) -> partial      # :657
        boards: 'Bed & Breakfast NR' unmapped                                                # rate-policy-source.ts boards, rate-options.ts:3
        letterIdentity(): if HRCEN … if HRDAV …                                              # rate-policy-source.ts:22
target: profile.rates = { public:[codes], government:{codes|labelPattern}, strategies:{WS:{plans:[BWS1B..], scope:'agency'}} , boards:{label->board} }
        rateScope = profile.classifyRate(code, strategy, isNegotiatedRate)   # one function, both hotels, unknown -> 'unknown' (shown, never dropped)
        details: read ALL rows' details (batched, same page, bounded by a time budget not a row count);
                 if budget hit -> rest = 'not_read' (kept in evidence), outcome stays per-option, never whole-search 'partial'
        letterIdentity(code) = profile.letter.{hotel,confirmation} regex strings
        prepare at ingest: for strategies the party qualifies for (profile.salesStrategies ∩ party), cap per mail, not per hour
```
- Prefill link: ingest prefetch (`hms-jobs.ts:2656` → `quoteShopJobsForPlan`) uses `paneConfig.salesStrategies` = profile, so A fixes prepared quotes and pane quotes at once.
- Why read-all is cheap: the grid page is already loaded; details = 1 click + 1 tooltip per night per row. 17 rows × 3 nights ≈ 51 clicks ≈ 30–60 s (measure in R1b canary). Budget 90 s, rest `not_read`.

### B. Rooms per hotel
```
today:  hrdavKnownCode: exact code or exact lowercase label                     # staff-quote-bind.ts:~426
target: normaliseRoomLabel(s) = casefold, strip 'room(s)', collapse spaces, '&'->'and'
        match against profile.rooms[].{code,label,aliases[]}; 1 match -> bind, >1 -> ask, 0 -> "not in this hotel's room list"
        HRCEN path replaced by same function (profile aliases), no knownRoomCode special case
        capacities: profile.rooms[].maxOccupancy from one read-only HRDAV room-type read (R3)
```

### C. Prepared on arrival (ingest-time background reads)
```
on extraction(succeeded, actionable, live-admitted):          # exists
   party bind (v2 + history)                                    # exists, unchanged (D13)
   for strategy in profile.salesStrategies where party qualifies: enqueue staff_quote PREFILL   # exists
pane open -> GET prepared(workItem) -> render instantly; missing -> show "Preparing… (HMS)" with cause class
fixes: per-mail cap (≤ main 7 strategies) instead of 20/hour global; dev gate per property (run-ledger.ts:638-646)
```

### D. Create provisional + come back later + screenshots
```
today:  Book -> server save -> work item stores commit; screenshots in a 30-min in-process Map (pane-stay-save.ts:36,466-474); receipt in browser memory
target: create job writes before.png (filled form), saved.png (after Save + readback) to
        /var/lib/nava/hms-shots/<property>/<workItemId>/<runId>/*.png  (retain 30 d, purge timer, disk budget)
        work_item stay record keeps {runId, status, confNo, shots:[name,sha256,at]}  (existing jsonb, no migration if stays[] is jsonb — B1a verifies)
        pane renders from server: status chip, conf no, "View HMS screenshots" (before/after), Copy confirmation
        click off -> job continues server-side (exists) -> reopen mail shows same state
```

### E. Confirmation recipient per user
```
user_settings.settings.confirmation = { mode: 'self'|'client'|'custom', address?: string }   # jsonb, no migration
pane Book step: "Send HMS confirmation to: [Me (fkhumalo@…) ▾]"  prefilled from setting; editable per booking
create tool: write recipient into the field that drives the auto letter (E0 decides which), readback verifies
E0 (live, Labtest, HRDAV): inspect Guest Stay form + CRS Confirmation Page DOM read-only (dump ALL fields, keep them — D2),
    then 1 Labtest create with recipient = Nava test mailbox in the candidate field -> check which letter arrives where
fallback if Save does not auto-mail: deterministic "Email confirmation" action (Guest Stay print/email documents) as a separate approved click
```
- Owner said Faith forwards manually; Nava only routes the HMS letter, never sends mail itself.

### F. Amend / cancel (provisional only)
```
state = classify(status, guaranteetype, depositreceived)        # pane-stay-lookup.ts:205-352, exists
paid -> "Paid booking: handle in HMS (Nava doesn't change paid bookings yet)"   # D5, out of scope
provisional cancel: reason + OK; penalty dialog -> REFUSE + screenshot                 # D6
inside notice window -> warning only (profile.cancellation.noticeHours DV=48)
DV amend: fix spawn env strip (pane-stay-spawn-env.ts:81-91)
amend live: diagnose from failure screenshots first (occupancy combobox, date), max 2 Labtest loops then park
```

### G. Failure reasons visible + stored
```
every refusal/failure -> {causeClass: not_set_up|hms_down|busy|not_found|needs_staff, detail} stored on hitl_tool_run.result (exists) and work item
pane shows plain text line (not tooltip) per step
```

### H. Ops: disk never fills, never delete runtime deps
```
traces: on failure only; zips >3 d deleted; screenshots 30 d; refuse new trace write at ≥75% disk
web releases: keep live only
NEVER docker image prune -a; prod code never needs an untagged image (#614 removed the last one)
disk watchdog: systemd timer (existing purge timer) logs df; ≥75% -> purge old traces; ≥85% -> alert line in health
deploy: drop duplicate pnpm install; migrate step trusts rds CA (1 line)
```

### I. Shuttle (Jarat Tours)
```
corpus (read-only, prod DB + snapshot) over ALL 5 DV mailboxes (davinci@, adladla, fkhumalo, kmgidi, epick) -> outbound to jarattours.co.za / jaratbookings.co.za
  -> /home/ubuntu/projects/zero/.private/templates/jarat-outbound.md (shared absolute path for every worktree; gitignored; anonymised)
pane: "Draft shuttle request" -> Outlook draft to Jarat (staff edit + send) ; HMS: transfer details into reservation note
temporary HMS Add-On (as in owner images) = Pomerado lane (J), not here
```

### J. Pomerado add-ons (last, nice-to-have, goal-driven)
```
own browser via chromium.launchServer on EC2 next to the DV slot (Pomerado cannot attach to CDP) or adapter
read-only screen dump of Guest Stay → Add-Ons → mint previewAddOns/commitAddOns on Labtest → readback → pane rows
Azure OpenAI via ModelProvider injection (all three roles)
```

## 2. Units (PRs), owned files, LOC, tests, coder

LOC = product lines (tests/fixtures excluded), scoped from code reads above; lanes re-measure.

| ID | Lane | Behaviour | Owned files (main) | LOC | Test (relative to app) | Coder | needs |
|---|---|---|---|---:|---|---|---|
| P0 | Proof | DV priced quote end to end on current SHA (#614 proof); wholesale read with agency bound; DV/HRCEN slot health | none (canary scripts, `/tmp/dvrun`) | 0 | live | coordinator scripts | — |
| R0 | Rates | profile schema: `rates.public/government/strategies`, `boards`, `letter`, `rooms[].aliases`, `cancellation`; loader + validator; HRCEN/HRDAV filled | `property-profiles/*.json`, `property-registry.mjs` | 80–120 | `tests/property-profile.test.mjs` both hotels + unknown fails closed | Luna max | — |
| R1a | Rates | `classifyRate` from profile replaces `:544` + `:601`; unknown shown | `fetch-quote.mjs` | 40–80 | `tooling/playwright-quote/fetch-quote.test.mjs` DV WS → contextual/verified with agency; HRCEN unchanged fixtures | Grok 4.6 | R0 |
| R1b | Rates | read all details within time budget; `not_read` per option; NR/Non-Rewardable boards; letterIdentity from profile | `fetch-quote.mjs` (detail section), `rate-options.ts`, `reservationist-rate-policy-source.ts` | 60–100 | same + `tests/rate-options.test.ts` | Grok 4.6 | R1a |
| R2 | Rates | room label normaliser + aliases (both hotels) | `staff-quote-bind.ts` | 20–40 | `tests/staff-quote-bind.test.ts` 9 HRDAV labels + staff spellings | Luna max | R0 |
| R3 | Rates | DV room capacities from one read-only read → profile | `HRDAV.json` | 10 data | `tests/property-profile.test.mjs` | Luna + live read | R0 |
| R4 | Rates | grid click = pick + re-price | `stay-rate-grid.tsx` + mount in panel | 30–60 | `tests/stay-rate-grid.test.tsx` | Cursor auto | — |
| G1 | Rates | visible + stored failure reason (cause class) incl. "Retrying" copy | `quote-workflow-panel.tsx` (append), `hitl-tool-run.ts` | 40–60 | `tests/quote-failure-reason.test.tsx` | Cursor auto | — |
| C1 | Prep | per-mail strategy cap (main 7) + per-property dev gate | `hms-jobs.ts` (append), `run-ledger.ts:638-646` | 30–50 | `tests/prepared-quote-cap.test.ts` | Luna max | R0 |
| C2 | Prep | chip propertyCode + autoStart ≠ pick | `pane-party-lookup.ts:21,35`, `staff-quote-run.ts:1041` | ≤15 | existing party tests | coordinator | — |
| B1a | Booking | durable screenshots (before/saved) 30 d + work-item refs | `pane-stay-save.ts`, new `hms-shots-store.ts` | 80–130 | `tests/hms-shots-store.test.ts` | Grok 4.6 | — |
| B1b | Booking | pane renders Book state + screenshots + receipt from server after reload | `booking-card.tsx`, new `hms-shots-viewer.tsx` + mount | 60–120 | `tests/booking-card-reload.test.tsx` | Cursor auto | B1a |
| E0 | Booking | discover the field that drives the auto letter (DOM dump all fields, 1 Labtest create) | none (writes `docs/research/…-confirmation-field.md`) | 0 | live | canary + Grok for dump script | P0 |
| E1 | Booking | user setting `confirmation` (jsonb) + pane selector per booking (both surfaces) | `user-settings` route, new `confirmation-recipient.tsx` + mount | 80–120 | `tests/confirmation-recipient.test.tsx` | Cursor auto | — |
| E2 | Booking | create tool writes recipient into E0 field + readback | `create-request.mjs`, `create-lab-stay.mjs` | 40–80 | `tooling/.../create-request.test.mjs` + live Labtest | Grok 4.6 | E0, E1 |
| F1 | Amend/cancel | penalty → refuse; paid → "handle in HMS"; DV amend env fix; notice warning from profile | `cancel-stay-rules.mjs`, `pane-stay-spawn-env.ts`, `pane-stay-save.ts` (copy) | 50–80 | `tests/cancel-stay-rules.test.mjs`, `tests/pane-stay-spawn-env.test.ts` | Grok 4.6 | R0 (notice) |
| F2 | Amend/cancel | amend diagnosis from screenshots → fix; ≤2 Labtest loops | `amend-stay-*.mjs` | 30–80 | live Labtest | Grok 4.6 | F1 |
| F3 | Amend/cancel | cancel re-proof Labtest both hotels, current SHA | none | 0 | live | canary | F1 deployed |
| O1 | Ops | traces on failure, 30 d shots, 3 d zips, ≥75% refuse, keep live release only, df log | deploy scripts, purge timer, `ec2-disk-retention` port | 40–80 | `tests/deploy-retention.test.ts` | Luna max | — |
| O2 | Ops | deploy: drop duplicate install, migrate CA, step timings | `deploy-ec2.sh`, `ops-deploy.sh` | 20–40 | `scripts/orch/test-orch.sh` | Luna max | — |
| S0 | Shuttle | corpus lane all 5 DV mailboxes → `.private/templates/jarat-outbound.md` + summary research md | none | 0 | — | Luna max (research) | — |
| S1 | Shuttle | "Draft shuttle request" → saved Outlook draft to provider + HMS note text | new `shuttle-draft.tsx` + server template | 60–100 | `tests/shuttle-draft.test.tsx` | Cursor auto | S0 |
| J | Pomerado | goal lane: add-ons + Jarat temporary add-on on Labtest | new `apps/server-pilot/tooling/pomerado/` | open | live Labtest readback | Grok 4.6 + Exa/skills | B lane frees DV slot |

Total ≈ 19 PRs, ~1,000–1,600 product lines.

## 3. Lanes (all start at once; each = Orca worktree off main, stacked PRs inside a lane)

| Lane | Units in order | p50 / p75 min | Notes |
|---|---|---|---|
| Proof (coordinator scripts, owns DV + HRCEN slot queue) | P0 → canaries for every merged unit → E0 → F3 | throughout | live HMS serial per hotel |
| Rates | R0 → R2 → R1a → R1b → R3 → G1 | 200 / 360 | Faith-critical |
| Prep | C1 (+C2 by coordinator) | 45 / 75 | |
| UI | R4, B1b (after B1a), E1 | 130 / 250 | stacked |
| Booking | B1a → E2 (after E0) | 150 / 300 | |
| Amend/cancel | F1 → F2 | 120 / 250 | |
| Ops | O1 → O2 | 60 / 100 | |
| Shuttle | S0 → S1 | 90 / 150 | |
| Pomerado | J (starts after Booking frees DV slot) | open, ≥180 | goal-driven |

**ETA (ledger 10-26, actual minutes p50/p75: server PR 43/75, UI PR 41/85, review 20/27, deploy 7/14, live HMS 22/85).**
- Longest chain = Rates: 6 PRs × 43 + 2 Apex rounds ≈ 300 code + live 2×22 → **p50 ≈ 3.5 h, p75 ≈ 6 h**.
- Live tail on the DV slot (serial): ~10 live steps × 22 = 220 min p50 → runs inside the window, starts with P0 at minute 0.
- Faith-critical subset (P0 + R0 + R2 + R1a + R1b + G1 + B1a/B1b + E0/E1/E2): **p50 ≈ 4 h, p75 ≈ 7 h**.
- Everything except Pomerado: p50 ≈ 4–4.5 h, p75 ≈ 7–8 h. Pomerado +3–5 h.
- Why not faster: live HMS on one browser per hotel is serial; Apex rounds (~20 min each, history up to 3); per-unit p50 40 min.
- Why not slower: 9 parallel lanes, ≤250-line units, coordinator ≤20-line fixes, briefs with anchors.

## 4. Gates and review (learned from or2)

- Gates per head SHA, once: remote typecheck → remote targeted vitest (baseline list) → `greptile review --apex` (CLI) + PR Apex check. Pass if failures ⊆ baseline.
- Greptile loops: fix all P1s in one commit per round, diff fix vs each P1 file:line before re-review, never per-field fixes (11 of 24 or2 P1s were adjacent repeats). Round 3 with a fresh adjacent P1 = split/redesign. Contract-heavy units write the full contract + tests first.
- Grok 4.7 xhigh adversarial review: this plan (before launch) and any unit touching DB, write paths, auth.
- Coordinator reads every product diff before merge.

## 5. Live tests (property × SHA after last change)

| Workflow | HRDAV canary | HRCEN canary | Pass |
|---|---|---|---|
| Quote BAR | 1 fresh DV quote mail (Labtest-safe, read-only) | after login fixed | priced PDF + Excel + draft |
| Quote wholesale | agency-bound WS read | n/a | WS options verified, prices shown |
| Prepared on arrival | 1 newly ingested DV mail | — | prepared before pane open |
| Create | Labtest provisional | Labtest | conf no + before/after screenshots on reload |
| Confirmation | Labtest create, recipient = Nava test inbox | — | letter received at chosen address |
| Cancel provisional | Labtest | Labtest | cancelled, no penalty accepted |
| Amend provisional | Labtest ≤2 loops | — | change persisted + readback |
| Pane | viewer run + bundle load | — | nginx load after last deploy |

Backtests (cheap, old data): DV quote replay on stored S4 stays (truth = staff PDFs) for rates; party bind unchanged → no rerun (D13).

## 6. Holds (need owner in this chat)

- Real-guest paid writes (out of scope anyway), penalty accept (never), Nava sending mail (never).
- `PANE_WRITE_CANCEL_UNPAID` → `lab` now, `on` after F1 deploy: coordinator does both (owner 274 "go as recommended").
- DB migrations: none planned. Any lane that finds it needs one stops and gets Grok 4.7 xhigh review + owner OK.

## 7. Open questions for Faith on the call (not blockers)

1. NR on boards = Non-Rewardable? (we assume yes)
2. Confirmation letter: does HMS email it automatically on Save, and to which field (guest email / booker / typed)? E0 answers before the call if possible.
3. Jarat Tours: who pays, when is the temporary add-on removed, which note field.

## 8. Parked (todo later, not this run)

- S3 offload of HMS screenshots after 30 d.
- ⓘ info button per pane field: which HMS field it maps to, what it doesn't do, with a screenshot (owner 274.20).
- Rate suggestion per mailbox × agency (needs ≥100-row eval; DV only).
- Paid amend/cancel: ask staff how they handle money first.
- Centurion HMS login (`AUTHENTICATED_SHELL_TIMEOUT`): screenshot diagnosis.
- Multi-mailbox pairing (ask 179), voucher/POP, groups.
- Old open PRs: close #2 #48 #189 #196 #218 #223 #248 #307 #320 #335 #336 #337 (stale ≤10-15, superseded); #420 docs → close; #462 (Wednesday pause; maintenance no longer weekly) → close; #463 (sr3-O1, B&B on government asks) → rebase check, likely superseded by #422 → close; #488 (dialog logging) → fold into F2 if useful, else close.
- Worktrees to remove after their branches are archived: `fix-policy-pdf` (merged), `sr3-O1`, `mh-orch`, `.worktrees/dv-dialog-log`, `.worktrees/mh1024-retro`, `.worktrees/oct18-c1-classify` (2 doc commits already on main), `.worktrees/or2-base-main`; `ec2-disk-retention` after O1 ports its trace fix. Keep `recover-parse-failure` (deploy) and `speed-mode-scripts`.
