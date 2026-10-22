---
title: "feat: SR3 — per-workflow write switches, provisional cancel, Da Vinci Make quote, overlay, CHECK, multi-stay (Grok-orchestrated night)"
type: feat
date: 2026-10-22
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
---

# SR3 — writes made safe per workflow, Da Vinci Make quote, partly-built → fully built

Run handbook (binding for every Grok agent): `docs/plans/2026-10-20-008-grok-run-handbook.md`, **with the overrides in §8 of this plan**. Scoping evidence: `docs/research/2026-10-22-sr3-scope/S1..S6.md` (6 Luna max read-only lanes, 2026-10-22 ~02:00Z, worktree at `db4abaca4`). Critical review: `docs/research/2026-10-22-sr3-scope/grok-4.7-plan-review.md` (Grok 4.7 high, 4 P0 / 9 P1 / 4 P2) — resolutions in §13.

**Authority order tonight:** PRODUCT.md hard rules > this plan (§8 overrides the 2026-10-20 handbook on orchestrator, coder, reviewer, merger, deployer) > handbook > S-lane files.

## Goal Capsule

- **Outcome by 10:00 London (09:00Z):** every write workflow has its own switch with Labtest proof; provisional bookings can be cancelled safely (switch stays `lab`); Da Vinci Make quote is built and repriced on past DV asks; the flag goes **on only if the PRODUCT.md bar passes (n ≥ 10, every plannable row matches)** — otherwise it stays off and the score is reported; Government/contract shown beside BAR; CHECK blocks cancel; multi-stay advanced as far as it safely goes. One deploy at the end (or earlier only if a live proof needs it).
- **Owner sleeps.** Orchestrator = Grok 4.6 high in Orca. Planning chat (Claude Opus) wakes every ~55 min and steers only on real problems.
- **Never tonight:** real-guest write of any kind; create/amend/cancel switch set to `on`; Da Vinci writes; Nava sending mail.

---

## 1. Problem frame

Owner (2026-10-22 ~01:30Z, ask 179–181 below): "do I literally just need to flip [RESERVATIONIST_PANE_SAVE]…" — **No.** One env gates all writes today:

| Workflow | Gate today | `SAVE=on` would… |
|---|---|---|
| Create | `pane-stay-save.ts:134` `paneStaySaveMode` | allow real guests |
| Cancel | `pane-stay-cancel.ts:126` same gate; `on` passes `--allow-real-guest` | allow **any** real booking, not only provisional |
| Amend | `pane-hms-write.ts:89` + `amend-stay-rules.mjs:15` — `lab` only | nothing (stays Labtest) |

So: one switch per workflow, and amend/cancel split by money state (owner: "write amend which is just … an empty quote type confirmation … and then the real ones which they've already paid for … we would need more switches").

## 2. Value gate (prod read-only SQL, inbound 2026-10-15..21, latest succeeded extraction per message)

| kind | Centurion | Da Vinci (5 boxes) |
|---|---:|---:|
| booking | 155 | 134 |
| amendment | 66 | 83 |
| quote | 54 | 21 |
| cancellation | 15 | 17 |
| >1 stay (booking+amend+quote mails) | 17 | 25 |

- DV inbound since routing (2026-10-21 11:40Z, ~14 h): quote 8, booking 33, amendment 26, cancellation 4.
- Since deploy #7 (`b11e5ac52`, excl. Wed window): stay_lookup 3 ok / 3 failed; guest_search 3 ok; quote 1 ok / 2 refused. n too small to judge.
- Usage: pane not released to staff (memory 2026-10-22). Value is readiness for release, not current adoption.
- Anti-over-index: cancellation 15+17/wk is ~2% of inbound but a write the owner explicitly wants; multi-stay ~6% of action mail.

## 3. Requirements (owner words → R)

| R | Requirement | Source |
|---|---|---|
| R1 | Separate switch per workflow: create, amend, cancel; amend and cancel each split **unpaid-provisional** vs **paid/other**. Values `off\|lab\|on`. | asks 179, 181 |
| R2 | Create provisional booking safe for real guests: HRCEN enforced in runner, adults ≥1, duplicate guard fail-closed, before + after screenshots, after-save readback compare; **show only the after-save screenshot** to staff. Switch stays `lab` tonight. | ask 179, Q1 answer |
| R3 | Cancel a provisional, unpaid booking found by lookup: rule enforced server + CLI at commit time from a fresh HMS read; never accept a penalty dialog; explicit staff reason. Switch stays `lab`. | ask 179 |
| R4 | Da Vinci Make quote: all 5 DV mailboxes → HRDAV, behind `HMS_DAVINCI_MAKE_QUOTE` (default off); HRDAV rates/rooms/board from a read-only probe; party per property; DV-branded output. Turn on if reprice on past DV asks matches staff. | asks 179, Q3 answer |
| R5 | Overlay: BAR + Government (+ contract when a party is bound) side by side; fix "Government B&B" not detected and contract missed. | ask 180 ("partly built → fully built") |
| R6 | CHECK: cancel hidden/inert under CHECK; one shared pick → exact re-read for amend/cancel/voucher. | ask 180 |
| R7 | Amend unpaid provisional proven once on Labtest (post-#458 rule). | ask 180, D1 |
| R8 | Multi-stay: stable stay identity, per-stay action, exact per-stay confirmation; guest↔room assignment and per-guest split next; multi-room single booking **held**. | ask 180 ("properly plan that"), Q4: partial OK |
| R9 | Leftovers from SR2 tonight: Wed maintenance pause (#462 redo, 5 P1s), U11b extraction replay, price reprice ≥10 threads. | asks 176, 178 |

## 4. Scope boundaries

- **In:** R1–R9 to Labtest/read-only proof. DV Make quote may go `on` (reads only) if the §7 bar passes.
- **Out tonight:** any real-guest write; switches set to `on`; DV create/amend/cancel; multi-room-in-one-booking writer (no HMS contract proven); A/R billing on create; real-guest amend (owner said "later"); background DV auto-prepare (`HMS_QUOTE_PREPARE` unchanged).
- **Deferred:** durable retry/idempotency store for create (design first; today a one-use in-memory preview grant + one property lock + duplicate check), Folio money read.

---

## 5. Key technical decisions

- **KTD1 Flag shape.** Five envs, each `off|lab|on`: `PANE_WRITE_CREATE`, `PANE_WRITE_AMEND_UNPAID`, `PANE_WRITE_AMEND_PAID`, `PANE_WRITE_CANCEL_UNPAID`, `PANE_WRITE_CANCEL_PAID`. Legacy `RESERVATIONIST_PANE_SAVE` is the fallback **only when all five are unset**; once any new one is set, an unset/invalid sibling = `off`. `*_PAID` accept only `off|lab` in code tonight (`on` → treated as `off` + logged) — paid writes need the Folio read first. Tonight's prod env: all five set to `lab` explicitly on http, worker, ai-worker; remote-http gets the same five (it serves webmail) — the flag-flip rule in AGENTS.md applies, `/proc/<pid>/environ` checked. *Rationale:* owner asked for per-workflow and per-money-state switches; capping `PAID` in code means no env mistake can enable paid writes.
- **KTD2 "Unpaid" = `classifyAmendPayment(stay) === 'unpaid'`** after #458 (provisional/reserved + deposit 0 or confirmed-blank + non-paying guarantee). Everything else (paid, guaranteed, unknown) routes to the `*_PAID` switch. One classifier, shared by amend and cancel, evaluated **server-side on a fresh read inside the property lock** and again by the CLI right before the final click.
- **KTD3 Screenshots.** Runner captures `before.png` (record as opened), `filled.png` (after typing, before Save — already exists for create) and `saved.png` (after Save). Pane shows only the after-save one; others are kept in the run dir for review (owner: "the only one we should show really is the after save"). Amend already has before/after; cancel gets the same.
- **KTD4 DV quote = resolver, not a fork.** A quote-only `mailbox → property` resolver (`hms-quote-target.ts`, new) feeds the existing quote path; Centurion guard stays for writes. HRDAV codes come only from a probe factsheet committed as `property-profiles/HRDAV.json`; unknown codes stay unknown (never Centurion fallback). Party index keyed by property.
- **KTD5 Overlay = serial extra reads only on staff Search**, one strategy per read (S5: `fetch-quote.mjs` is single-strategy; do not widen it). Rows carry strategy provenance; secondary failure shows "not checked", never blocks the primary.
- **KTD6 Multi-stay identity first.** Stable stay id survives re-extraction (S4 change 1) before any per-stay action/UI. No positional guest↔room inference.
- **KTD7 PR size.** Hard rule ≤ 500 product lines (tests excluded); over 700 total changed lines → Greptile `--apex`. If a lane goes over 500 mid-build, split at the next behaviour boundary rather than push one big PR.
- **KTD8 Deploy once at the end**, unless a Labtest/DV proof needs the code live earlier (create/cancel/amend proofs go through the pane path → need the deploy). So: **deploy A** at ~05:30Z (writes + switches + CHECK + whatever is merged) → Labtest proofs + DV probe-based reprice; **deploy B** final at ~08:45–09:15Z. Owner allowed deploys until 10:30 London.

## 6. Implementation units

Lane = one Grok 4.6 high coder in its own Orca child worktree (`sr3-<unit>`), branch `sr3-<unit>`. Estimates: product LOC from S-lanes reading the code; minutes = nearest measured SR2 lane by LOC, × code-server ledger median 0.85 not applied (SR2 coding ran 1.44× its estimates; retro §2) — numbers below already include that.

### W1. Per-workflow write switches (R1)
- **Files:** `apps/server-pilot/src/ai/{pane-stay-save.ts,pane-stay-cancel.ts,pane-hms-write.ts,pane-stay-spawn-env.ts,pane-stay-amend.ts}`, `src/trpc/routes/brain.ts`, `src/lib/driver/types.ts`, `tooling/playwright-quote/{amend-stay-rules.mjs,cancel-stay-rules.mjs}`, `apps/mail/lib/pilot/capabilities.ts`, `apps/mail/lib/quote-workflow/{pane-stay-bind.ts,amend-cancel.ts}`, `apps/mail/components/quote-workflow/{booking-card.tsx,amend-lookup-panel.tsx}`, `apps/mail/components/nava-pane/{nava-pane.tsx,blocks/booking-voucher-card.tsx}`, `apps/server-pilot/deploy/{pm2.config.cjs,write-ec2-env.sh,write-ec2-remote-env.sh}`.
- **Approach:** one `paneWriteMode(workflow, moneyState, env)` in `pane-stay-save.ts` (KTD1); every write entry calls it; capability object grows `paneWrite: {create, amendUnpaid, amendPaid, cancelUnpaid, cancelPaid}`; keep `paneSave`/`paneSaveMode` as aliases = create mode. `--allow-real-guest` passed only when the resolved mode for that workflow+money state is `on`. Attach stays on its own existing gate (Labtest-only); create mode never enables attach/amend/cancel.
- **Size:** +220–300 / −60–90 product; tests +160–240. **~75 min** (UDV-3 36 min for ~200 LOC; U5b 175 min had 4 P1s in shared shapes → budget one fix round).
- **Tests:** `pane-stay-save.test.ts` (legacy fallback; new flags win; invalid sibling = off; `*_PAID=on` → off), `pane-stay-cancel.test.ts` (`CANCEL_UNPAID=lab` never passes allow-real-guest; paid stay with `CANCEL_PAID=off` refuses), `pane-hms-write.test.ts` + `pane-stay-amend.test.ts` (create=on does not enable amend), `pane-stay-spawn-env.test.ts` (all five forwarded to HRCEN CLI, stripped for HRDAV), `deploy-config.test.ts` (all four pm2 procs), `pilot-capabilities.test.ts`, `booking-card.test.tsx`, `amend-find-panel.test.tsx`.
- **Review:** Grok 4.7 high + Greptile **apex** (auth/write gate, regardless of size).

### W2. Create safety (R2) — after W1
- **Files:** `pane-stay-save.ts`, `pane-stay-lookup.ts` (duplicate check), `tooling/playwright-quote/{create-lab-stay.mjs,create-request.mjs,create-proof-rules.mjs}`, `read-reservation-fields.mjs`, `apps/mail/components/quote-workflow/booking-card.tsx`, `apps/mail/lib/quote-workflow/pane-stay-bind.ts`.
- **Approach:** runner checks HRCEN property on every write (not only `--proof`); adults ≥1; duplicate check fails closed when ambiguous (missing departure, read error); wire `--pane-commit` to the existing `--proof` snapshot + reconcile (`create-lab-stay.mjs:611-671`) so every pane save reads back the saved record and compares supported fields; the HRCEN property check moves out of proof-only (`create-lab-stay.mjs:524`) into every write; adults ≥1 enforced in `create-tool.schema.json` (minimum is 0 today) and the server; add `before.png`; outcome `committed` only when readback matches, else `committed_unverified` shown as "Saved — check in Infor"; booking card shows only the after-save screenshot. **No file rename** (S1 suggested `create-stay.mjs`; ponytail: rename churns 6 refs, defer).
- **Size:** +180–300 product (S1 PR2+PR3 combined, minus rename); tests +200–300. Split if >500. **~80 min + one fix round (40)** (SR2 Labtest create took 5 rounds).
- **Tests:** wrong property refuses; adults 0 refuses; ambiguous duplicate refuses; readback mismatch never reports `committed`; screenshot names; card shows saved shot only.
- **Live proof (orchestrator, after deploy A):** 1 Labtest Save via the pane path (budget 3). Record R5 field values in `docs/infor-hms/labtest-booking-state-fields.md` (guarantee, deposit, company/agency, `send_on_save`: check the Centurion mailbox for an HMS email at Save time, read-only count).

### W3. Provisional cancel (R3) — after W1 (shares `amend-lookup-panel.tsx` with W4 → W4 first)
- **Files:** `pane-stay-cancel.ts`, `tooling/playwright-quote/{cancel-stay.mjs,cancel-stay-rules.mjs}`, `apps/mail/components/quote-workflow/amend-lookup-panel.tsx`, `apps/mail/lib/quote-workflow/amend-cancel.ts`, `apps/server-pilot/src/mail/workflow-folders.ts`.
- **Approach (core = review P0-1):** at commit, inside the property lock, a **fresh HMS read** must classify `classifyAmendPayment === 'unpaid'` or the server refuses before any CLI click; digest and `expectStay` include status, guarantee and `depositReceived` (add it to `CANCEL_EXPECT_STAY_KEYS`); `runPaneStayCancel` always passes `expectStay`. Server preview stores the lookup snapshot; CLI re-reads right before OK, refuses on drift/unknown/penalty; money state picks `CANCEL_UNPAID` vs `CANCEL_PAID`; real commit requires explicit staff-picked HMS reason (no default text). Pane: preview/commit shown only when found, CHECK-clear, and the resolved switch ≠ off; distinct copy for paid/guaranteed/unknown ("Handle in Infor"). Folder fallback: `system_notice + cancel` → not-for-Nava (owner policy "TMC cancellation notification = no action"); person-authored stays.
- **Size:** +150–220 product; tests +220–330. **~70 min**.
- **Tests:** server test: paid stay + `CANCEL_UNPAID=lab` → refused, spawn never called with commit; `cancel-stay-rules.test.mjs` (status/payment matrix incl. #458 blank-deposit, drift refuses, real commit needs reason, penalty = zero OK clicks), `pane-stay-cancel.test.ts` (ineligible snapshot refuses; commit passes expectStay; stale refuses before click), `amend-find-panel.test.tsx`, `amend-cancel-copy.test.ts`, `workflow-folders.test.ts`.
- **Review:** Grok 4.7 high + Greptile apex (write path).
- **Live proof:** 1 Labtest cancel via pane (budget 2) on a Labtest stay created by W2's proof (provisional, unpaid). Never a stay you did not create tonight.

### W4. CHECK blocks cancel (R6) — first on `amend-lookup-panel.tsx`
- **Files:** `amend-lookup-panel.tsx` only.
- **Approach:** gate cancel render/preview/commit on `!checkReason` (review P2-16: shared picker is a second behaviour → deferred).
- **Size:** +3–10 product; tests +25–35. **~20 min**.
- **Tests:** `amend-find-panel.test.tsx` (cancel under CHECK hidden; preview/commit calls inert).

### W5. Amend Labtest proof (R7) — no code expected
- Orchestrator runs it after deploy A. **First a read-only field dump** of `25526053-1` (`read-reservation-fields.mjs`): proceed only if Labtest, arrival ≥ 2027, and `classifyAmendPayment === 'unpaid'`. Else amend tonight's new W2 Labtest stay instead (created provisional/unpaid), or skip and report. Change: departure +1 night. Abort on any penalty/charge dialog; if a rate dialog appears, screenshot + stop (no blind accept); no retry on unknown outcome. Budget 2.

### D0. HRDAV read-only probe (R4) — starts at kickoff, orchestrator-run, deterministic scripts only
- **Browser:** HRDAV has its own slot and secret (`hms-read-target.ts:25` `DAVINCI_HMS_READ_TARGET`: secret `nava-zero/server-pilot/infor-hms-read-davinci`, slot `davinci`). Run the scripts with the Da Vinci CDP URL env the pane HRDAV reads use (find it in `pane-stay-spawn-env.ts` / prod env; never the Centurion CDP) — first command checks the opened property is HRDAV and stops otherwise. The single HMS queue (§9) still serialises it with every other HMS job tonight. No Save. Use existing read tools: `fetch-quote.mjs` (rate shop for 2 future dates, 1 and 2 adults), `read-reservation-codes.mjs`, `party-lookup.mjs` (one known agency name from DV mail). Output: `docs/research/2026-10-22-hrdav-probe.md` — rate plan codes + labels, board codes, room codes/labels/max occupancy, sales strategies, DOM differences vs HRCEN, screenshots path. **No Labtest writes on HRDAV.**
- Brand assets: search `/home/orca/nava-research/davinci/` (`templates.md`, keyframes) and DV outbound mail attachments (read-only SQL: attachment filenames on DV outbound, counts) for the DV quote letterhead/terms. If none found → DV PDF uses property name + address from HRDAV only, no logo; log as owner follow-up.
- **~30 min** (U4 probe class: 7–38 min).

### D1. DV quote gate + resolver (R4) — after D0 starts (code can start immediately; needs no probe data)
- **Files:** `apps/server-pilot/src/env.ts`, new `src/hms/hms-quote-target.ts`, `src/trpc/routes/{workstation.ts,quote-workflow.ts}`, `src/ai/{hms-jobs.ts,reservationist-draft-source.ts}`, `apps/mail/lib/quote-workflow/party-lookup.ts`, `quote-workflow-panel.tsx` (capability only).
- **Approach:** KTD4; `HMS_DAVINCI_MAKE_QUOTE` exact `on`; route, queue, worker all re-check; capability from server.
- **Size:** +120–180 product; tests +150–220. **~55 min**.
- **Tests:** `staff-quote-route.test.ts`, new `hms-quote-target.test.ts` (5 DV transports → HRDAV only when on; off blocks manual/queue/worker; HRCEN unchanged; no write route gains access), `reservationist-draft-source.test.ts`.

### D2. DV rates/rooms/board (R4) — after D0 factsheet + D1 merged
- **Files:** `src/hms/rate-catalogue.ts`, `src/ai/staff-quote-installation.ts`, `src/quote-proposal/description.ts`, `tooling/playwright-quote/{property-registry.mjs,property-profile.mjs,property-profiles/HRDAV.json,fetch-quote.mjs}`, `apps/mail/config/room-types.ts`, `apps/mail/lib/quote-workflow/{staff-quote-bind.ts,types.ts}`.
- **Size:** +150–250 product. **~70 min**. **Stop rule:** if D0 returns no rate/room/board codes, D2 and D4 do not merge mappings; DV quote stays off.

### D3. DV party per property (R4) — after D1 (see §9a)
- **Files:** `src/ai/{pane-party-lookup.ts,party-index.ts,party-index-sweep.ts}`, `src/trpc/routes/pane-party-lookup.ts`, `tooling/playwright-quote/party-lookup.mjs`, `apps/mail/lib/quote-workflow/party-lookup.ts`.
- **Size:** +100–170 product. **~55 min**. Party index is a JSON file (`party-index.ts:20`): key it by property with **one index file per property** (HRCEN keeps its current file). No migration.

### D4. DV branded output (R4) — after D2 (see §9a)
- **Files:** `src/ai/reservationist-agent.ts`, `src/quote-proposal/{proposal-pdf.ts,quote-workbook.ts,description.ts,filename.ts}`, `apps/mail/lib/quote-proposal/copy.ts`, HRDAV `.xlsx` template only if found.
- **Size:** +120–220 product. **~55 min**. Rejects mixed-property output. 66 h expiry draft (#461) made property-aware here if #461 merged (else skipped).

### O1. Government intent (R5a)
- **Files:** `src/ai/extraction/{schema.ts,extract.ts}`, `quote-ready.ts`, `reservationist-decision.ts`, `quote-workflow-llm.ts`, `apps/mail/lib/quote-workflow/{types.ts,session.ts}`, `quote-workflow-panel.tsx`.
- **Size:** +35–65 product. **~40 min** + classifier gate (extract.ts prompt change → frozen 431 ×1, **no regression >1 pt** vs v4; quote recall ≥85%) **~25 min** on EC2/Luna.

### O2. Side-by-side strategies (R5b) — after O1 and D2 (see §9a)
- **Files:** `src/ai/{reservationist-business-services.ts,hms-availability.ts,rate-options.ts}`, `apps/mail/lib/quote-workflow/{types.ts,staff-quote-bind.ts}`, `apps/mail/components/quote-workflow/{rate-cards.tsx,quote-workflow-panel.tsx}`.
- **Size:** +140–240 product. **~75 min**.

### M1. Multi-stay stable identity (R8) → M2 per-stay action (M3 per-stay confirmation: cut tonight)
- M1 `extraction/schema.ts`, `extraction/extract.ts` (only if the id needs a prompt change), `ai/work-items.ts` (+40–80) ~40 min; M2 `work-items.ts`, `session.ts`, `quote-workflow-panel.tsx` (+40–80) ~40 min; M3 + `amend-lookup-panel.tsx` (+50–100) ~45 min. M4 guest↔room assignment, M5 per-guest split: only if time. Multi-room single-booking writer: **held**.
- Tests per S4 §5 (`extraction-schema.test.ts`, `work-items.test.ts`, `quote-workflow-session.test.ts`, `quote-workflow-panel.test.tsx`, `amend-find-panel.test.tsx`).

### L1. SR2 leftovers
- **L1a** Wed maintenance pause (#462 redo): **cut tonight** (review P2-14; next Wed 2026-10-28). Daytime slice.
- **L1b** Extraction replay with `apps/server-pilot/scripts/outbound-gold-replay.ts` (the prod-input runner from #451; `outbound-gold-backtest.ts` is fixture-only), read-only on EC2 after deploy A, 20–30 threads, ~21 s p50 each → **~15 min**. Scores extraction coverage only; it does not prove multi-stay identity or prices. No rate claim.
- **L1c** Price reprice (funnel first, ≥10 truth threads, serial, priority 0, ≤3 queued) **after** Labtest proofs on the HMS lock: ~12 × 138–247 s → **~45 min**.

## 7. Verification contract (tests on current data)

| Area | Unit tests | Live / replay proof (n + source) | Pass |
|---|---|---|---|
| Switches | listed in W1 | after deploy A: `/proc/<pid>/environ` on 4 procs shows five `PANE_WRITE_*=lab`; `brain.capabilities` returns them | all match |
| Create | W2 | 1 Labtest Save via pane: readback compare `committed`, 3 screenshots on disk, card shows saved one; `send_on_save` counted | committed + fields match |
| Cancel | W3 | 1 Labtest cancel via pane on tonight's Labtest stay; penalty never accepted; status Cancelled on readback | cancelled, 0 penalty clicks |
| Amend | — | 1 Labtest amend `25526053-1` +1 night; readback departure +1, other fields unchanged | amended |
| CHECK | W4 | pane render test only | tests green |
| DV quote | D1–D4 | **Reprice bar (PRODUCT.md:68):** every distinct DV quote thread (inbound ask + staff outbound PDF/priced reply on a DV box), arrival still in the future, deduped by Message-ID; run Make quote read-only on HRDAV; compare rate plan + nightly price to staff. **`HMS_DAVINCI_MAKE_QUOTE=on` only if n ≥ 10 and every row matches exactly.** Any diff = no flip (the orchestrator never judges an "HMS-side reason" itself; log it for the owner). n < 10 → stays off, report n, class, board, room, exact price. | owner Q3 "on if reprice matches"; bar per review P0-2 |
| Overlay | O1, O2 | reprice pool `docs/research/2026-10-20-quote-backtest-pool.md` filtered to arrivals still in the future first; Government/contract rows counted after the filter. O2's extra live reads run only after the Labtest proofs (HMS queue) | report only (n<10); no pass claim |
| Classifier (O1) | — | frozen 431 rows, prod prompt parity | no regression >1 pt; quote recall ≥85% |
| Multi-stay | M1–M2 | unit tests only (stable id across reorder, per-stay action); no replay claim tonight | tests green |
| Quote price | — | L1c ≥10 truth threads | report class+board+room+exact vs 2026-10-20 (5/8, 2/8) |

DV `n` is unknown until the funnel runs (8 live asks in 14 h; promoted history may add more). Likely outcome tonight: built, scored, flag off. That is acceptable (owner Q3 conditional).

## 8. Run contract (overrides the 2026-10-20 handbook)

| Item | Tonight |
|---|---|
| Orchestrator | **Grok 4.6 high** (owner 2026-10-22 ~02:20Z), Orca terminal `sr3-orch` in a new child worktree of the repo; `--no-subagents` not set (it may use headless `grok -p` reviews) |
| Coders | Grok 4.6 high, one Orca child worktree + terminal each (`sr3-<unit>`) |
| Reviewer per PR | **Grok 4.7 high** (owner: "regular high", not xhigh): `grok -m grok-4.7 --effort high -p "<review brief>"` in the unit worktree, output to `/tmp/sr3/reviews/<unit>.grok.md` |
| Greptile | every PR after `git fetch`: `greptile review --branch origin/main --json`; **`--apex` when total changed lines > 700, or for W1/W3 (write/auth gates)** |
| Diff reading | orchestrator reads every product diff before merge (AGENTS.md); planning chat does not |
| Max review rounds | 2 Greptile rounds; a 3rd fresh P1 on the same design = split/strip (AGENTS.md) |
| Parallelism | all units whose files are disjoint start at once (§9). Shared file = queued. |
| Deploys | A ≈ 05:30Z (after W1–W4 merged) for Labtest + DV; B final 08:45–09:15Z. Owner allowed until 09:30Z (10:30 London). Record last-good SHA first (`b11e5ac52` or whatever is live). **Warn**: staff start 05:00Z — staff are not on the pane (released: no), so deploys are OK per owner. |
| Labtest budget | **3 Saves, 2 amends, 2 cancels** (owner Q2). HRCEN only. Proof Labtest, arrival ≥ 2027-01-01. |
| Flags | set the five `PANE_WRITE_*=lab` at deploy A via the env writer W1 changes (prod `.env.production` for http/worker/ai-worker + the remote-http env file; `pm2.config.cjs` only passes NODE_ENV/PORT). **Refuse deploy A** if any of the five is missing from `/proc/<pid>/environ` on any of the 4 procs. `HMS_DAVINCI_MAKE_QUOTE=on` only if §7 DV bar passes. Nothing else. |
| Supervision | orchestrator: background watcher per lane (PR head / gate result / terminal idle) — never end a turn with lanes running and nothing armed (retro §4 #1). Planning chat: wakes every ~55 min, reads `/tmp/sr3/state.md` + orchestrator screen, steers only on real problems |
| State file | `/tmp/sr3/state.md` (append-only). Handoff at ~150k context into it, then `/clear` per AGENTS.md |
| Decisions | §10 forks have defaults; take them, log, never wait for the owner |
| Stop | new merges stop 09:00Z; final deploy + live checks by 09:30Z; report in state.md + `docs/context/ACTIVE.md` PR |

## 9. Waves, file ownership, HMS queue, critical path

### 9a. One owner per shared file (review P0-3)

| Shared file | Order (each waits for the previous PR to merge) |
|---|---|
| `apps/mail/components/quote-workflow/booking-card.tsx`, `apps/mail/lib/quote-workflow/pane-stay-bind.ts`, `pane-stay-save.ts` | W1 → W2 |
| `apps/mail/components/quote-workflow/amend-lookup-panel.tsx`, `amend-cancel.ts`, `pane-stay-cancel.ts` | W1 → W4 → W3 |
| `apps/mail/components/quote-workflow/quote-workflow-panel.tsx` | D1 → O1 → O2 → M2 |
| `apps/server-pilot/src/trpc/routes/workstation.ts` | D1 → D4 |
| `apps/mail/lib/quote-workflow/party-lookup.ts` | D1 → D3 |
| `src/quote-proposal/description.ts`, `src/ai/staff-quote-installation.ts` | D2 → D4 (D3 does not touch them) |
| `src/ai/extraction/{schema.ts,extract.ts}`, `apps/mail/lib/quote-workflow/session.ts` | O1 → M1 → M2 |
| `apps/mail/lib/quote-workflow/types.ts`, `staff-quote-bind.ts` | D2 → O2 |
| `apps/server-pilot/src/ai/hms-jobs.ts` | D1 only tonight |

A lane that finds it must edit a file not in its list stops and asks the orchestrator, which queues it by this table.

### 9b. Start order

| Start | Lanes |
|---|---|
| T0 | **W1**, **D1**, **O1** coder lanes; **D0** probe (orchestrator, HMS queue slot 1) |
| W1 merged | **W2** and **W4** (disjoint) |
| W4 merged | **W3** |
| D1 merged (+ D0 factsheet) | **D2**, **D3** |
| D1 + O1 merged | — (O2 waits for D2 because of `types.ts`/`staff-quote-bind.ts`) |
| D2 merged | **D4**, **O2** |
| O1 merged | **M1** |
| O2 + M1 merged | **M2** (M3 cut tonight) |

### 9c. One HMS queue (review P0-4)

Only one HMS job runs at a time, across both properties, all night. Order:
1. D0 HRDAV probe (T0, read-only).
2. After deploy A: Labtest Save (W2 proof) → Labtest cancel (W3 proof, on that new stay) → amend field dump + Labtest amend (W5).
3. L1c Centurion price reprice (≤3 queued, serial).
4. DV reprice (needs D1–D2 deployed).
5. O2 live overlay reads.
L1b extraction replay needs no HMS and runs any time after deploy A.

### 9d. Critical path (review P1-5, with reviews and the HMS queue counted)

| Chain | Parts (min) | Total |
|---|---|---|
| Writes | W1 code 75 + review/Greptile apex 40 → W4 20 + 20 → W3 70 + 40 (W2 80 + 40 runs in parallel after W1) → deploy A 10 → Save 35 → cancel 35 → amend 35 | **~380** |
| Da Vinci | D0 30 ∥ D1 55 + 25 → D2 70 + 25 → D4 55 + 25 → deploy B 10 → DV reprice 30 (after HMS slots 2–3) | **~300** (+ wait for queue) |
| Overlay + multi-stay | O1 40 + classifier gate 25 + 20 → (wait D2) O2 75 + 25 → M1 40 + 20 → M2 40 + 20 | **~330** |

Sources: SR2 retro §2 (coding ran 1.44× estimate; already folded into the minutes above), apex rounds ~14 min apart, deploy 5–7 min, Labtest live 34 min (U8b), U5b 175 min for a shared-shape unit → W1 budget includes one fix round.

T0 ≈ 03:00Z. Writes chain lands ≈ **09:20Z**, past the 09:00Z merge stop **if every round runs long**. Therefore, **cut list decided now (in order, taken by the orchestrator without asking):** M2 → O2 → D4 → W5 amend proof → L1c reprice. Never cut W1, W3's money guard, or W2's readback. Deploy A moves to "as soon as W1+W2+W3 are merged"; if that's later than 07:30Z, run deploy A anyway with whatever is merged and do the Labtest proofs that are possible.

## 10. Forks decided now (defaults — take them, log in state, don't wait)

1. Legacy `SAVE` when new flags set → ignored (KTD1).
2. `Reserved` counts as provisional → yes (#458 classifier).
3. Voucher singleton needs a staff click → yes.
4. All automated `system_notice + cancel` route away, person-authored stay → yes.
5. Multi-room in one HMS booking → held; pane says "Book each room in Infor" when rooms >1 on one date set.
6. Combined multi-stay quote PDF → keep current one combined PDF.
7. DV brand assets not found → name + address only, no logo; owner follow-up.
8. DV quote manual only (no background prepare).
9. A/R on create → not tonight; manual in Infor.
10. Party index per property → one JSON index file per property; no migration.
11. A unit over 500 product lines → split at behaviour boundary; never one big PR.
12. Any commit path that can click OK/Save on a non-Labtest stay, or cancel/amend a stay not classified `unpaid` from a fresh read, under tonight's `lab` flags → stop that unit, write `/tmp/sr3/HOLD.txt`, continue others. A UI-only gate never counts as the guard.

## 11. Holds (owner only)

- Any switch to `on` (real guest). Paid amend/cancel. DV writes. Sending mail. GitHub Actions. Deleting branches/worktrees not created tonight. These do **not** happen tonight.

## 12. Definition of done

- Every merged unit: remote typecheck at baseline (mail 62 / server-pilot 0), remote vitest on its files green, Grok 4.7 high review triaged, Greptile P1s triaged/fixed.
- Final deploy health 200/200, 4 pm2 procs, `/proc` flags as §8, bundle 200.
- §7 live proofs recorded with n in `/tmp/sr3/state.md` and `docs/research/2026-10-22-sr3-proofs.md`.
- ACTIVE.md updated (docs PR), ETA rows closed, retro line per unit.

## 13. Critical review resolutions (Grok 4.7 high, 2026-10-22 02:24Z)

| # | Sev | Resolution |
|---|---|---|
| 1 | P0 | **Accepted as W3's core**, severity corrected: under `lab` the CLI `identityCheck` runs `labGuard` (last name Labtest + 2027) when `--allow-real-guest` is absent (`cancel-stay-rules.mjs:228`), so a real paid stay can't be cancelled tonight. But no money check exists at commit, so `on` would be unsafe. W3 adds the fresh-read `unpaid` refusal + deposit in digest/expectStay + server test |
| 2 | P0 | Accepted: DV bar = PRODUCT ≥10, exact match, no self-judged reasons |
| 3 | P0 | Accepted: §9a one owner per shared file |
| 4 | P0 | Accepted: §9c single HMS queue; D0 uses the HRDAV slot/secret |
| 5 | P1 | Accepted: §9d requoted with reviews; cut list fixed before T0 |
| 6 | P1 | Accepted: flags via env writer; deploy A refused if any missing in `/proc` |
| 7 | P1 | Accepted: W5 reads first, falls back to tonight's new Labtest stay |
| 8 | P1 | Accepted: L1b names `outbound-gold-replay.ts`; no multi-stay replay claim |
| 9 | P1 | Accepted: future-arrival filter; overlay report only; O2 reads after proofs |
| 10 | P1 | Accepted: fork 12 rewritten with a concrete rule |
| 11 | P1 | Accepted: W2 wires `--pane-commit` to the proof reconcile; adults test on `create-tool.schema.json`; budget includes a second round |
| 12 | P1 | Accepted: D2 stop rule on empty factsheet |
| 13 | P1 | Accepted: party index file per property, no migration |
| 14 | P2 | Accepted: L1a cut |
| 15 | P2 | Accepted: W1 = one `paneWriteMode` + call sites; attach unchanged; split UI out if near 500 |
| 16 | P2 | Accepted: W4 = CHECK guard only |
| 17 | P2 | Accepted: authority line at top; deploy command spelled out in the kickoff |

## Sources

- Scoping: `docs/research/2026-10-22-sr3-scope/S1-switches-create.md` … `S6-check-amend.md`.
- SR2 retro: `docs/context/ledger/2026-10-21-sr2-overnight-retro.md`; MISTAKES rows 2026-10-21/22.
- Previous plan + handbook: `docs/plans/2026-10-20-006-stay-request-build-plan-v2.md`, `docs/plans/2026-10-20-008-grok-run-handbook.md`.
