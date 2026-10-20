# P2 scope — multi-ask, CHECK, unpaid amend, plus wave-1

**Owner now-items (a)(b)(c) join wave-1. Combined-PDF multi-stay is the gap. Paid amend/cancel stay later.**

Read: PRODUCT.md Done; AGENTS.md gates; 2026-10-20-004 plan; ARCHITECTURE.md; p1; grok-4.6-p1-review; MISTAKES.md; 2026-10-19-evening-retro. SHA user-stated `3e1acb694`. No git/network/tests/HMS. SSM case-mix skipped. Hindsight pages empty.

Corrections: `quote-ready.ts:49` is **booking-kind only** (`quotePrepareKindReason`); quote kind still admits many stays (`:227` maps all). `work-items.ts:319` loops every stay; `:353` is booked/requested overlay on `stays[0]` only. `mixed_request` copy never emitted. `docs/context/DECISIONS-2026-10-20.md` missing (plan cites D9–D17); live file is `docs/DECISIONS-2026-10-20.md` D1–D8.

Scope trade (PRODUCT.md:85): CHECK + multi-ask + unpaid-amend displace U1b contract overlay and U2b four-field split on the critical path. Memory A/B, TTL, paid amend/cancel stay later.

Case-mix (l1:191–194): **17/164** threads 2+ quote/booking asks (10%); **10/164** 2+ dates; **9/164** 2+ letter guest/date cases, **9/9 separate conf IDs**. Users tomorrow: wave-1 pane on Outlook+webmail after bundle load; writes stay Labtest (`RESERVATIONIST_PANE_SAVE=lab`).

---

## 1. (a) MULTI-ASK — one mail → N cards, N quotes, N bookings

| | |
|---|---|
| **Exists** | Extractor `stays[]` cap 8: `extraction/schema.ts:60,176,224`. Prompt one stay **per date set** (not per guest): `extract.ts:54`. Quote-ready maps all stays for **quote** kind (`quote-ready.ts:227`); **booking** kind refuses `stays.length !== 1` (`:39–49`; test `:304`). `work-items.ts:314` flags `multi_date`; groups all stays `:319`; booked/requested/conf overlay `stays[0]` / `confirmationNumbers[0]` `:353–355`. Pane `isMultiStay` = >1 date key (`session.ts:431`); **combined** PDF (`document-review.tsx:136,155`; `not-supported-list.tsx:10–11`; panel `:1583`). Booking draft **one per date key** already (`quote-workflow-panel.tsx:2035–2048`) but unquoted create refuses multi-stay (`booking-draft.test.ts:615`). `guestNames: []` always (`work-items.ts:349`). `mixed_request` typed (`types.ts:142`) never set. |
| **Gap** | Staff letters: one conf per guest/date (9/9). Pane **one combined proposal**. Extractor collapses two guests on same dates. Auto-prepare skips multi-stay **bookings**. Overlay/conf from stay 0 only. |
| **Files** | `extraction/{schema,extract}.ts`; `quote-ready.ts`; `work-items.ts`; `session.ts`; `document-review.tsx`; `not-supported-list.tsx`; `quote-workflow-panel.tsx`; `multi-option-draft.ts`; `quote-workbook-download.ts`; `booking-draft.ts`; `quote-proposal/quote-workbook.ts`. Split **two PRs** (backend then pane) — panel shared with U1/U3a/U4. |
| **Product** | ARCHITECTURE.md:31,57 “one card per guest/date”. l1:209. PRODUCT.md pane “Stay by date range”. WIP=1 except disjoint files. |

**E2E tests**

| Kind | Files |
|---|---|
| Unit | `quote-ready.test.ts:304`; `work-items.test.ts:958`; `quote-workflow-llm.test.ts:1167`; `quote-workflow-router.test.ts:578`; `booking-draft.test.ts:615`; `booking-draft-multistay.test.ts`; `quote-proposal-multistay.test.ts`; `extraction-date-anchoring.test.ts` |
| Component | `quote-workflow-multi-stay.test.ts:206`; `quote-workflow-session.test.ts:2399`; `quote-workflow-panel.test.tsx`; `document-review.test.tsx` |

Replay (prod path `readQuoteAttachments` + `selectionToAgentPrompt`; AGENTS.md:68,74): **all 17/164** 2-ask threads from l1 S1 on corpus 2026-10-13. Subset **10/164** 2+ dates; **9/164** with HRCEN letters. Truth = staff HRCEN letters (guest+arrival+conf) and staff quote PDFs/replies — **no owner labels**. Pass: N cards = N letter guest/date pairs; each card own quote **or** own booking; 9/9 confs stay distinct. **No accuracy rate** (n=17 < 100). Quote price bar still ≥10 independent threads (PRODUCT.md:68), not this 17.

Live: HMS **read** on prod for each card’s dates; **writes Labtest-only**. Staff see **one card per guest/date** on Outlook pane **and** webmail (`nava-pane-render.test.tsx:2666` both surfaces). Bundle load in nginx. One HMS lock (`PRODUCT.md:49`).

---

## 2. (b) CHECK — unknown/unclear booking link

| | |
|---|---|
| **Exists** | Backend `found/not_found/ambiguous` (`pane-stay-lookup.ts:75,215`). Copy “Check HMS directly” (`amend-find.ts:19`). Guest-name search + pick list (`amend-lookup-panel.tsx:188–207,538–635,647`). Bare number never `-1` (`amend-find.ts:50–57`). Second-pick test **skipped** (`amend-find-panel.test.tsx:1547`). |
| **Gap** | Ambiguous → walk away, not CHECK. No staff-chosen conf **re-read** before write. No UNKNOWN payment state screen (125/223 amend unknown, l2:9). Search closes after first pick (skip test). |
| **Files** | `amend-lookup-panel.tsx`; `amend-find.ts`; `pane-stay-lookup.ts` only if status fields missing. No `pane-stay-cancel.ts`. Queue vs U1 if U1 owns `amend-find.ts:162`. |
| **Product** | ARCHITECTURE.md:35,57. PRODUCT.md amend-find bar. Wrong guest = fail. |

**E2E tests**

| Kind | Files |
|---|---|
| Unit | `pane-stay-lookup.test.ts:204–338`; `stay-lookup-dom.test.mjs:345–382` |
| Component | `amend-find-panel.test.tsx:758–829,1073–1215,1282–1345` **unskip :1547** |

Replay: golden amend/cancel rows (PRODUCT mix amend 6 / cancel 4) **plus** every corpus amend with no dash-conf or HMS `ambiguous`. Input = prod attachments. Truth = HRCEN letter conf + arrival (l2: 69/223 exact conf; 74 usable links). Pass: staff must pick; no write from candidates; re-read exact conf. **Do not claim 95%** unless n≥100 independent rows (AGENTS.md:74). PRODUCT.md:70 95% is the golden-set bar, n small today.

Live: prod **read** find+search; no write. Outlook+webmail: “Check this booking”, candidates, **no** Preview/Approve until pick+reread.

---

## 3. (c) Unpaid provisional amend in place (same conf)

| | |
|---|---|
| **Exists** | Labtest runner `amend-stay.mjs` (line 2; fields arrival/departure/adults/children/roomType `:23–25`). Spawn `pane-hms-write.ts:87–90` mode **exactly `lab`** (`on` → off); Labtest surname `:153`; arrival ≥2027 `:125–126`; spawn `:424`. tRPC `pane-stay-amend.ts:15`. Pane Preview/Approve `amend-lookup-panel.tsx:268–286`; copy `amend-cancel.ts:192–204`. `canPreviewAmendFromCapabilities` lab only (`amend-cancel.ts:185–189`). |
| **Gap** | No paid/unpaid/provisional gate (U5 fields unproven; send-on-save unknown). Paid/unknown must not take this path (owner). Same-conf is letter evidence 14/74 (l2:67), not live write proof. Existing-record writability `TODO-LIVE-PROBE` (`amend-stay.mjs:22,30`). |
| **Files** | After U5+CHECK: `pane-hms-write.ts`; `amend-stay.mjs` / `amend-stay-rules.mjs`; `amend-lookup-panel.tsx`; `amend-cancel.ts`. No `RESERVATIONIST_PANE_SAVE=on`. |
| **Product** | D5 unpaid first. PRODUCT.md Amend workflow. Human-in-loop every write. Cancel lab-only. |

**E2E tests**

| Kind | Files |
|---|---|
| Unit | `pane-hms-write.test.ts:335`; `pane-stay-amend.test.ts:69–103`; `amend-stay-rules.test.mjs`; `aop-amend-cancel-payload.test.ts:41` |
| Component | `amend-cancel-copy.test.ts`; `amend-find-panel.test.tsx` (Preview/Approve hidden unless unpaid+exact conf) |

Replay: 54/223 unpaid-evidence amends (l2:79) that have a prior letter. Truth = same-number HRCEN follow-up (14/74) vs none (60/74). Input parity as above. Pass: proposed fields match mail; **no write in replay**. n=54 < 100 → no rate claim.

Live: **Labtest Guest Stay only**. Preview screenshot → Approve → same confirmation in result. Prod real-guest writes off. Both surfaces: Preview/Approve only on unpaid exact match; paid/unknown → CHECK or “handle in HMS”.

---

## 4. Wave-1 still in (unchanged gaps)

### U1 BAR grid before room pick

Exists: all-room helper `hms-availability.ts:102–117`; board dropped `:418–427`; prefetch off `hms-jobs.ts:161–164`; pane still `roomRequirementReady` `quote-workflow-panel.tsx:884–886,960`. Gap: queue/read from pane; grid before room pick; board + nightly stock + as-of; missing = “not checked”. Files: `hms-availability.ts`, `hms-jobs.ts`, `pane-stay-lookup.ts`, `fetch-quote.mjs`, `quote-workflow-panel.tsx`, `rate-cards.tsx`; `amend-find.ts` only if availability kind added. Product: OWNER-ASKS 157–158; ARCHITECTURE.md:53.

Tests: `hms-availability-probe.test.ts`; `hms-availability-bookability.test.ts`; `hms-jobs.test.ts:2478`; `pane-stay-lookup.test.ts:511`; `fetch-quote.test.mjs`; `quote-workflow-panel.test.tsx:609,861`; `rate-cards.test.tsx:191`. Replay: ≥10 independent quote threads, staff PDF/letter vs prepared nights (PRODUCT.md:68). No ≥100. Live: one BAR read on prod; Outlook+webmail grid before room pick.

### U2a Party rank, no forced pick

Exists: suggestions sender then body (`party-aliases.ts:144–151`) — **wrong order**. V3 bind separate (`party-match-v3.ts`). Party gate accepts either ID (`quote-workflow-panel.tsx:920–924`). Gap: email-named > history > domain; domain never binds; BAR with no party. Files: `party-aliases.ts`, `party-sender-map.ts`, `pane-party-lookup.ts`, `party-lookup.ts`, `party-picker.tsx`. Do not touch `party-match-v3.ts` unless a failing row. Queue if panel touched.

Tests: `party-aliases.test.ts`; `party-sender-map.test.ts`; `pane-party-lookup.test.ts`; `party-picker-results.test.tsx`; `party-contract-picks.test.tsx`; `quote-workflow-panel.test.tsx:1887`. Replay: 42-mail party set is **circular n=22** (MISTAKES.md:1, AGENTS.md:74). Rank fixtures only unless ≥100 independent HMS-letter party rows. Bind-rule change → 42-mail replay **before merge**. Live: both surfaces; domain never auto-binds.

### U3b Contact label

Exists: `nava-pane.tsx:2213` `quote=true` for `new_booking`. Title `contact-block.tsx:40–42`. Gap: new_booking must say **Contact**. Files: `nava-pane.tsx`; `contact-block.tsx` only if enum needed.

Tests: `contact-block.test.tsx:58,116`; `nava-pane-render.test.tsx:2670` (add `new_booking`; `:2880` is existing-stay/voucher — grok-4.6-p1-review.md:5). No replay. Live: both surfaces, new booking header = Contact.

### U5 Labtest probe

Exists: `read-reservation-fields.mjs:10–19`; `stay-lookup-dom.mjs:1–8`. Gap: where guarantee/deposit/A-R/agency/company + confirmation-email control live; `send_on_save=unknown`. New files only: `labtest-booking-state-probe.mjs` + test. Tests: new offline DOM test; `read-reservation-fields.test.mjs`. No replay. Live: Labtest read, writes blocked, one property lock. Blocks (c) and U4 create.

### U4 Two end buttons (after U5)

Exists: Prepare PDF+reply `quote-workflow-panel.tsx:1583`; inner `primaryAction={false}` `:1994`. Booking Preview→Book `booking-card.tsx`. Gap: visible **Make quote** default vs **Create provisional** (copy-only until Save proof). Files: panel, `booking-card.tsx`, `document-review.tsx`. Tests: `quote-workflow-panel.test.tsx:1557,1937`; `booking-card.test.tsx:670,770`; `document-review.test.tsx:53`. No create click from quote. Live: both surfaces; create hidden/copy until Labtest Save proof.

U3a jump (`:1526` “Complete stay details”) after U1 (same panel). Tests: `quote-workflow-panel.test.tsx:430,609`.

---

## 5. Revised waves (disjoint files only)

| Wave | Slice | Owns | Parallel |
|---|---|---|---|
| **A now** | U3b Contact | `nava-pane.tsx`, `contact-block.tsx` | A |
| **A** | U1 BAR grid | availability/jobs/lookup/fetch-quote/panel/rate-cards `(amend-find if kind)` | A |
| **A** | U5 probe | **new** probe files only | A |
| **A** | U2a rank | party-aliases/sender-map/pane-party-lookup/party-lookup/party-picker | A; **queue if panel** |
| **A** | U7 ≥10 quote truth | docs/eval only | A |
| **B after U1** | U3a jump | `quote-workflow-panel.tsx` | after A U1 |
| **B after U1+U5** | CHECK | `amend-lookup-panel.tsx`, `amend-find.ts` | after U1 frees amend-find |
| **B** | Multi-ask **backend** | schema/extract/quote-ready/work-items | ‖ CHECK (disjoint) |
| **C after B** | Multi-ask **pane** | session/document-review/panel/not-supported/booking-draft | after U3a (panel) |
| **C after CHECK+U5** | Unpaid amend | pane-hms-write, amend-stay*, amend-lookup-panel, amend-cancel | after CHECK (shared panel) |
| **C after U5** | U4 two ends | panel, booking-card, document-review | after pane multi-ask (panel) |
| later | U1b overlay, U2b four fields, paid amend/cancel, TTL, memory | — | after party IDs / U5 |

Shared file = queued. Own worktree from `origin/main`. PR ≤500 product lines, one behaviour (AGENTS.md:33). UI brief greps removed strings and lists every test (MISTAKES.md:9).

**Pipeline each slice:** Grok 4.6 high codes → Grok 4.7 high reviews → 4.6 fixes → `git fetch` then `greptile review --branch origin/main` (LLM judges each comment) → 4.6 iterates P0/P1 → Opus merge/deploy/live HMS. Remote typecheck ‖ remote tests ‖ Greptile. No Fast. No `/home/orca/bin` edits.

---

## 6. Raw coding minutes — evening retro only

Measured (incl. tests/snapshots): #412 +94 actual **13** (est 35, r 0.37); #415 +45 actual **22** (est 25, r 0.88); #414 +258 actual **50** (est 80, r 0.63); #416 +1384 mostly snapshot actual **41** (est 40, r 1.03); #413 +1026 actual **92** (est 70, r 1.31, stuck 20 / rework 35).

| Slice | Size band (p1/grok, tests out) | Comparable | Raw min |
|---|---|---|---:|
| U3b Contact | 4–8 | no lane <45; nearest **#415 +45 → 22** | **22** |
| U3a jump | 5–12 | **#415 → 22** | **22** |
| U5 probe | 80–140 | **#412 +94 → 13** | **13** |
| U1 BAR | 180–280 | **#414 +258 → 50** | **50** |
| U2a rank | 100–180 | #412–#414 | **13–50** |
| CHECK | 80–160 | #412–#414 | **13–50** |
| Multi-ask backend | ~schema+ready+work-items | **#414 → 50** | **50** |
| Multi-ask pane | uncombine existing U20 | **#416 stay-card UI → 41**; if pane fight like #413 → **92** | **41 (92 if #413-class)** |
| Unpaid amend | gate existing runner | **#414 → 50** | **50** |
| U4 two ends | 80–160 | #412–#414 | **13–50** |

Longest code chain A‖ then B then C pane: **50 (U1) + 22 (U3a) + 50 (backend) + 41 (pane) + 50 (unpaid, after CHECK 13–50)** = **~213–263 raw coding min** on the serial file chain (panel: U1→U3a→multi-ask pane→U4). Gates/review/deploy/live **not** in these numbers (AGENTS.md:44).

**Breaks the number:** HMS live (FACTS.md:145 queue 80–1,025 s, read 12–413 s) — coding min exclude live lock; U5/unpaid/CHECK live runs add wall clock. Flaky pane snapshots (#413 9 test type errors, SSM gzip `-u`). Greptile stale base (MISTAKES.md:10). Bind-rule replay before merge. `quote-workflow-panel.tsx` collisions. Labtest Save unknown → U4 create slips.

---

## 7. Holds / assumptions

- Unpaid vs paid needs U5 DOM/API table before (c) writes.
- Create-provisional button stays copy until authorized Labtest Save + mailbox watch (`send_on_save=unknown`).
- `RESERVATIONIST_PANE_SAVE` stays `lab`. No real-guest write.
- 17 thread IDs not listed in l1; locate via S1 on corpus 2026-10-13.
- SSM usage counts skipped (no network).
