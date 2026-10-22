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

Run handbook (binding for every Grok agent): `docs/plans/2026-10-20-008-grok-run-handbook.md`, **with the overrides in §8 of this plan**. Scoping evidence: `docs/research/2026-10-22-sr3-scope/S1..S6.md` (6 Luna max read-only lanes, 2026-10-22 ~02:00Z, worktree at `db4abaca4`).

## Goal Capsule

- **Outcome by 10:00 London (09:00Z):** every write workflow has its own switch with Labtest proof; provisional bookings can be cancelled safely (switch stays `lab`); Da Vinci Make quote is built, repriced on past DV asks, and **turned on** if it matches staff; Government/contract shown beside BAR; CHECK blocks cancel; multi-stay advanced as far as it safely goes. One deploy at the end (or earlier only if a live proof needs it).
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
- **Approach:** runner checks HRCEN property on every write (not only `--proof`); adults ≥1; duplicate check fails closed when ambiguous (missing departure, read error); pane commit always snapshots + reads back the saved record and compares supported fields (reuse the `--proof` reconcile path for `--pane-commit`); add `before.png`; outcome `committed` only when readback matches, else `committed_unverified` shown as "Saved — check in Infor"; booking card shows only the after-save screenshot. **No file rename** (S1 suggested `create-stay.mjs`; ponytail: rename churns 6 refs, defer).
- **Size:** +180–300 product (S1 PR2+PR3 combined, minus rename); tests +200–300. Split if >500. **~80 min**.
- **Tests:** wrong property refuses; adults 0 refuses; ambiguous duplicate refuses; readback mismatch never reports `committed`; screenshot names; card shows saved shot only.
- **Live proof (orchestrator, after deploy A):** 1 Labtest Save via the pane path (budget 3). Record R5 field values in `docs/infor-hms/labtest-booking-state-fields.md` (guarantee, deposit, company/agency, `send_on_save`: check the Centurion mailbox for an HMS email at Save time, read-only count).

### W3. Provisional cancel (R3) — after W1 (shares `amend-lookup-panel.tsx` with W4 → W4 first)
- **Files:** `pane-stay-cancel.ts`, `tooling/playwright-quote/{cancel-stay.mjs,cancel-stay-rules.mjs}`, `apps/mail/components/quote-workflow/amend-lookup-panel.tsx`, `apps/mail/lib/quote-workflow/amend-cancel.ts`, `apps/server-pilot/src/mail/workflow-folders.ts`.
- **Approach:** server preview stores the lookup snapshot (status, guarantee, deposit) and passes `expectStay` on commit; CLI re-reads right before OK, refuses on drift/unknown/penalty; money state picks `CANCEL_UNPAID` vs `CANCEL_PAID`; real commit requires explicit staff-picked HMS reason (no default text). Pane: preview/commit shown only when found, CHECK-clear, and the resolved switch ≠ off; distinct copy for paid/guaranteed/unknown ("Handle in Infor"). Folder fallback: `system_notice + cancel` → not-for-Nava (owner policy "TMC cancellation notification = no action"); person-authored stays.
- **Size:** +150–220 product; tests +220–330. **~70 min**.
- **Tests:** `cancel-stay-rules.test.mjs` (status/payment matrix incl. #458 blank-deposit, drift refuses, real commit needs reason, penalty = zero OK clicks), `pane-stay-cancel.test.ts` (ineligible snapshot refuses; commit passes expectStay; stale refuses before click), `amend-find-panel.test.tsx`, `amend-cancel-copy.test.ts`, `workflow-folders.test.ts`.
- **Review:** Grok 4.7 high + Greptile apex (write path).
- **Live proof:** 1 Labtest cancel via pane (budget 2) on a Labtest stay created by W2's proof (provisional, unpaid). Never a stay you did not create tonight.

### W4. CHECK blocks cancel + shared pick (R6) — first on `amend-lookup-panel.tsx`
- **Files:** `amend-lookup-panel.tsx`, `voucher-find-card.tsx`, new `apps/mail/components/quote-workflow/hms-candidate-picker.tsx`.
- **Approach:** gate cancel render/preview/commit on `!checkReason`; extract the candidate list + click → exact-find leaf into the new picker; voucher singleton also needs a click.
- **Size:** +50–90 product; tests +65–105. **~35 min** (U7 CHECK took ~30).
- **Tests:** `amend-find-panel.test.tsx` (cancel under CHECK hidden + inert), `voucher-find-card.test.tsx` (singleton needs pick; mismatch never matched).

### W5. Amend Labtest proof (R7) — no code expected
- Orchestrator runs it after deploy A: pane amend on `25526053-1` (Proof Labtest, 2027+), +1 night, budget 2. Steps per S6 §5. Abort on any penalty/charge/rate dialog; no retry on unknown outcome.

### D0. HRDAV read-only probe (R4) — starts at kickoff, orchestrator-run, deterministic scripts only
- One HMS lock, HRDAV slot, no Save. Use existing read tools: `fetch-quote.mjs` (rate shop for 2 future dates, 1 and 2 adults), `read-reservation-codes.mjs`, `party-lookup.mjs` (one known agency name from DV mail). Output: `docs/research/2026-10-22-hrdav-probe.md` — rate plan codes + labels, board codes, room codes/labels/max occupancy, sales strategies, DOM differences vs HRCEN, screenshots path. **No Labtest writes on HRDAV.**
- Brand assets: search `/home/orca/nava-research/davinci/` (`templates.md`, keyframes) and DV outbound mail attachments (read-only SQL: attachment filenames on DV outbound, counts) for the DV quote letterhead/terms. If none found → DV PDF uses property name + address from HRDAV only, no logo; log as owner follow-up.
- **~30 min** (U4 probe class: 7–38 min).

### D1. DV quote gate + resolver (R4) — after D0 starts (code can start immediately; needs no probe data)
- **Files:** `apps/server-pilot/src/env.ts`, new `src/hms/hms-quote-target.ts`, `src/trpc/routes/{workstation.ts,quote-workflow.ts}`, `src/ai/{hms-jobs.ts,reservationist-draft-source.ts}`, `apps/mail/lib/quote-workflow/party-lookup.ts`, `quote-workflow-panel.tsx` (capability only).
- **Approach:** KTD4; `HMS_DAVINCI_MAKE_QUOTE` exact `on`; route, queue, worker all re-check; capability from server.
- **Size:** +120–180 product; tests +150–220. **~55 min**.
- **Tests:** `staff-quote-route.test.ts`, new `hms-quote-target.test.ts` (5 DV transports → HRDAV only when on; off blocks manual/queue/worker; HRCEN unchanged; no write route gains access), `reservationist-draft-source.test.ts`.

### D2. DV rates/rooms/board (R4) — after D0 factsheet + D1 merged
- **Files:** `src/hms/rate-catalogue.ts`, `src/ai/staff-quote-installation.ts`, `src/quote-proposal/description.ts`, `tooling/playwright-quote/{property-registry.mjs,property-profile.mjs,property-profiles/HRDAV.json,fetch-quote.mjs}`, `apps/mail/config/room-types.ts`, `apps/mail/lib/quote-workflow/{staff-quote-bind.ts,types.ts}`.
- **Size:** +150–250 product. **~70 min**.

### D3. DV party per property (R4) — after D1; parallel with D2 (disjoint files except `staff-quote-installation.ts` → D2 owns it, D3 queues its edit to the end)
- **Files:** `src/ai/{pane-party-lookup.ts,party-index.ts,party-index-sweep.ts}`, `src/trpc/routes/pane-party-lookup.ts`, `tooling/playwright-quote/party-lookup.mjs`, `apps/mail/lib/quote-workflow/party-lookup.ts`.
- **Size:** +100–170 product. **~55 min**. Party index needs a property key: if this needs a migration, it is a **new nullable column + backfill HRCEN** (`ops-deploy.sh --migrate` at deploy).

### D4. DV branded output (R4) — after D1
- **Files:** `src/ai/reservationist-agent.ts`, `src/quote-proposal/{proposal-pdf.ts,quote-workbook.ts,description.ts,filename.ts}`, `apps/mail/lib/quote-proposal/copy.ts`, HRDAV `.xlsx` template only if found.
- **Size:** +120–220 product. **~55 min**. Rejects mixed-property output. 66 h expiry draft (#461) made property-aware here if #461 merged (else skipped).

### O1. Government intent (R5a)
- **Files:** `src/ai/extraction/{schema.ts,extract.ts}`, `quote-ready.ts`, `reservationist-decision.ts`, `quote-workflow-llm.ts`, `apps/mail/lib/quote-workflow/{types.ts,session.ts}`, `quote-workflow-panel.tsx`.
- **Size:** +35–65 product. **~40 min** + classifier gate (extract.ts prompt change → frozen 431 ×1, **no regression >1 pt** vs v4; quote recall ≥85%) **~25 min** on EC2/Luna.

### O2. Side-by-side strategies (R5b) — after O1 (shares panel/session)
- **Files:** `src/ai/{reservationist-business-services.ts,hms-availability.ts,rate-options.ts}`, `apps/mail/lib/quote-workflow/{types.ts,staff-quote-bind.ts}`, `apps/mail/components/quote-workflow/{rate-cards.tsx,quote-workflow-panel.tsx}`.
- **Size:** +140–240 product. **~75 min**.

### M1. Multi-stay stable identity (R8) → M2 per-stay action → M3 per-stay confirmation
- M1 `extraction/schema.ts`, `ai/work-items.ts` (+40–80) ~40 min; M2 `work-items.ts`, `session.ts`, `quote-workflow-panel.tsx` (+40–80) ~40 min; M3 + `amend-lookup-panel.tsx` (+50–100) ~45 min. M4 guest↔room assignment, M5 per-guest split: only if time. Multi-room single-booking writer: **held**.
- Tests per S4 §5 (`extraction-schema.test.ts`, `work-items.test.ts`, `quote-workflow-session.test.ts`, `quote-workflow-panel.test.tsx`, `amend-find-panel.test.tsx`).

### L1. SR2 leftovers
- **L1a** Wed maintenance pause: redo #462 against its 5 apex P1s (failureClass not cleared; paused counts settled; party 4-min deadline; TCP probe proves nothing). Fresh lane, same branch reused or new; **~60 min**. Not urgent (next Wed 2026-10-28) — lowest code priority.
- **L1b** U11b extraction replay, read-only, on EC2 after deploy A: 20–30 threads, ~21 s p50 each → **~15 min**.
- **L1c** Price reprice (funnel first, ≥10 truth threads, serial, priority 0, ≤3 queued) **after** Labtest proofs on the HMS lock: ~12 × 138–247 s → **~45 min**.

## 7. Verification contract (tests on current data)

| Area | Unit tests | Live / replay proof (n + source) | Pass |
|---|---|---|---|
| Switches | listed in W1 | after deploy A: `/proc/<pid>/environ` on 4 procs shows five `PANE_WRITE_*=lab`; `brain.capabilities` returns them | all match |
| Create | W2 | 1 Labtest Save via pane: readback compare `committed`, 3 screenshots on disk, card shows saved one; `send_on_save` counted | committed + fields match |
| Cancel | W3 | 1 Labtest cancel via pane on tonight's Labtest stay; penalty never accepted; status Cancelled on readback | cancelled, 0 penalty clicks |
| Amend | — | 1 Labtest amend `25526053-1` +1 night; readback departure +1, other fields unchanged | amended |
| CHECK | W4 | pane render test only | tests green |
| DV quote | D1–D4 | **Reprice bar:** every distinct DV quote thread since 2026-10-14 promote (history rows included as *truth only*: inbound ask + staff outbound PDF/reply on DV boxes) with a future arrival; run Make quote read-only on HRDAV; compare rate plan + nightly price to staff. **Turn on `HMS_DAVINCI_MAKE_QUOTE=on` only if n ≥ 5 and every plannable row matches (diffs with an HMS-side reason allowed, logged).** n < 5 → stays off, report n. | per Q3 answer (owner: "On if reprice matches") |
| Overlay | O1, O2 | reprice pool `docs/research/2026-10-20-quote-backtest-pool.md` (n=8 scored): Government 4 rows, contract 1 | gov ≥3/4, contract unchanged or better; n<10 = "improvement", not pass |
| Classifier (O1) | — | frozen 431 rows, prod prompt parity | no regression >1 pt; quote recall ≥85% |
| Multi-stay | M1–M3 | replay 9 core multi-case threads (R2 corpus, `docs/research/2026-10-20-arch-lanes/r2-multi-ask-truth.md`) through #451 runner | behaviour check, no rate |
| Quote price | — | L1c ≥10 truth threads | report class+board+room+exact vs 2026-10-20 (5/8, 2/8) |

DV `n`: the bar uses **≥5** (not PRODUCT.md's ≥10) because DV has 8 live asks in 14 h; owner Q3 said "on if reprice matches" — this is my threshold, labelled as inference; report n either way.

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
| Flags | set the five `PANE_WRITE_*=lab` (same behaviour as today's `SAVE=lab`) at deploy A. `HMS_DAVINCI_MAKE_QUOTE=on` only if §7 DV bar passes (owner Q3). Nothing else. |
| Supervision | orchestrator: background watcher per lane (PR head / gate result / terminal idle) — never end a turn with lanes running and nothing armed (retro §4 #1). Planning chat: wakes every ~55 min, reads `/tmp/sr3/state.md` + orchestrator screen, steers only on real problems |
| State file | `/tmp/sr3/state.md` (append-only). Handoff at ~150k context into it, then `/clear` per AGENTS.md |
| Decisions | §10 forks have defaults; take them, log, never wait for the owner |
| Stop | new merges stop 09:00Z; final deploy + live checks by 09:30Z; report in state.md + `docs/context/ACTIVE.md` PR |

## 9. Waves and critical path

| Start | Lane | Owns (summary) | After |
|---|---|---|---|
| T0 | W1 switches | write gates, capabilities, deploy env | — |
| T0 | W4 CHECK | amend-lookup-panel, voucher card, picker | — |
| T0 | D0 HRDAV probe (orchestrator, HMS lock) | — | — |
| T0 | D1 DV gate | hms-quote-target, workstation quote routes, hms-jobs quote block | — |
| T0 | O1 Gov intent | extraction schema/prompt, quote-ready, session | — |
| T0 | M1 stay identity | extraction schema **(collides O1)** → **queued after O1** | O1 |
| T0 | L1a Wed pause redo | hms-jobs pause block **(collides D1)** → queued | D1 |
| W1 merged | W2 create safety | pane-stay-save, create runner, booking-card | W1 |
| W1+W4 merged | W3 cancel | pane-stay-cancel, cancel runner, amend-lookup-panel | W1, W4 |
| D0+D1 | D2 rates/rooms | rate-catalogue, property profiles | D0, D1 |
| D1 | D3 party, D4 output | party index / proposal output | D1 |
| O1 | O2 side-by-side | business-services, rate-cards, panel | O1 |
| O2 + M1 | M2 → M3 | work-items, session, panel, amend panel | O2, M1, W3 |

```
T0 ─ W1 (75) ─ W2 (80) ─┐
  └─ W4 (35) ─┘─ W3 (70) ─┴─ deploy A (10) ─ Labtest Save→cancel→amend (3×~30) ─ L1c reprice (45)
T0 ─ D0 probe (30) ─┐
T0 ─ D1 (55) ───────┴─ D2 (70) ∥ D3 (55) ∥ D4 (55) ─ (deploy A or B) ─ DV reprice (~30) ─ flag on (10)
T0 ─ O1 (40+25 gate) ─ O2 (75) ─ M1 (40) ─ M2 (40) ─ M3 (45)
```

**ETA (critical path = write chain):** W1 75 → W3 70 (W4 done inside) → review/Greptile per PR ~20 ×2 → deploy A 10 → 3 Labtest proofs ~90 (U4/U8 live p75 38 each, minus probe) → L1c 45 → deploy B 10 = **~340 min from T0**. T0 ≈ 02:50Z → **~08:30Z**. DV chain ~55+70+20+10+30 ≈ 185 + deploy wait → ready for deploy A or B. Multi-stay chain 65+75+125 ≈ 265 → M3 maybe by ~07:30Z if reviews are clean; **cut order if late:** L1a, M3, O2, D4 branding polish, M2. Sources: SR2 retro §2 (coding 1.44× estimates, deploy 5–7 min, Labtest live 34 min, apex ~14 min apart).

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
10. Party-index property key needs migration → nullable column + HRCEN backfill, `--migrate` on deploy.
11. A unit over 500 product lines → split at behaviour boundary; never one big PR.
12. Any finding that implies a real-guest write path is reachable → stop that unit, log, continue others.

## 11. Holds (owner only)

- Any switch to `on` (real guest). Paid amend/cancel. DV writes. Sending mail. GitHub Actions. Deleting branches/worktrees not created tonight. These do **not** happen tonight.

## 12. Definition of done

- Every merged unit: remote typecheck at baseline (mail 62 / server-pilot 0), remote vitest on its files green, Grok 4.7 high review triaged, Greptile P1s triaged/fixed.
- Final deploy health 200/200, 4 pm2 procs, `/proc` flags as §8, bundle 200.
- §7 live proofs recorded with n in `/tmp/sr3/state.md` and `docs/research/2026-10-22-sr3-proofs.md`.
- ACTIVE.md updated (docs PR), ETA rows closed, retro line per unit.

## Sources

- Scoping: `docs/research/2026-10-22-sr3-scope/S1-switches-create.md` … `S6-check-amend.md`.
- SR2 retro: `docs/context/ledger/2026-10-21-sr2-overnight-retro.md`; MISTAKES rows 2026-10-21/22.
- Previous plan + handbook: `docs/plans/2026-10-20-006-stay-request-build-plan-v2.md`, `docs/plans/2026-10-20-008-grok-run-handbook.md`.
