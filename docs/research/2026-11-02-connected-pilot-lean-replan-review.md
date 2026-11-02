# Connected pilot — lean re-plan review (2026-11-02)

Read-only adversarial review of `.claude/worktrees/three-connected-workflows/docs/plans/2026-11-02-003-feat-connected-cloud-pilot-replan-plan.md` (609-line version: 1,250 min six owners / 1,510 five; raw 1,130 / 1,360). Five Sonnet 5.5 max reviewers, one per lane, plus coordinator checks. No edits, tests, live HMS, deploys or git in worktrees.

## Goal

Owner wants the full requested pilot (triage, quote, create, filing, amend, multi-room, both hosts) in the least wall-clock time **without dropping safety**. Method: every lane as byte-size tasks (≤~150 product LOC or one live probe), each with files, product/test LOC, exact tests, exact HMS check, deps and active minutes. Then parallelize, retire risks with t=0 probes and cut ceremony.

## Owner direction (2026-11-02, this session)

PRODUCT.md, PRODUCT-DETAIL.md, ACTIVE.md, AGENTS.md and START-HERE.md predate the HMS Cloud rewrite and are stale. Question every non-safety rule. Kept safety: no real-guest write without direct owner authority; fake writes only on Proof Labtest 2027+ stays; Nava never sends; HMS CMS confirmation is off in tests; no penalty dialogs; no blind retry of uncertain writes; never use pilot RDS; no secrets out; no local tsc.

| Stale rule | Why stale | Effect on the plan |
|---|---|---|
| PRODUCT.md:9 "deterministic Infor HMS tools via Playwright" | HRCEN moved to Infor Cloud 10-27. Legacy tools are reference only (owner 11-01). | — |
| PRODUCT.md workflow ROI order | Removed 11-01/11-02 | No lane waits for another by policy |
| PRODUCT-DETAIL "Done = golden set passes on prod after last fix" | From the 10-14 overnight-gate era. Bars were "proposed", never confirmed for Cloud. | Cut the 210-min post-release proof track and the post-deploy eval tail. Run eval offline on the final head before release. |
| "Both hosts per feature before review" | Pane code is shared | One host per feature walkthrough. Check both hosts once at release. |
| ×1.11 / ×0.96 calibration on top of explicit review slots | Double-counts review time | Use raw bottom-up minutes plus a named contingency |
| ACTIVE.md (461 lines) / START-HERE | Pomerado/HRDAV/or2 runs; nothing on Cloud | Archive; replace with a short Cloud status |

## Measured throughput (gh, last 40 merged PRs, 11-01 07:33Z → 11-02 10:14Z)

- Median 93 product lines per PR. First commit → merge: median 17 min, p75 46 min.
- #866 500 product lines in 18 min; #864 434 in 19 min; #881 384 in 60 min; #855 297 in 53 min.
- 12 PRs merged in one hour.
- Known fake save + readback: 90.3 s. Remote typecheck: 41 s.
- **Code authoring is not the bottleneck.** Discovery, live proof and serial gates are.

## Lane-by-lane (bottom-up, raw active minutes)

| Lane | Plan | Lean | Main lever (evidence) |
|---|---:|---:|---|
| Single create to first fake save + readback | 290 | ~220 | `reviewedStay` stored at prep and rechecked before grant and Save (integrator `pane-create-approval.ts:331-393,491-495,580-584`). C1–C9 are mostly audit and tests: ~5–50 product / 40–90 test LOC, 1 PR. Remove the hold at `quote-workflow.ts:201-206,471-472,576-577` only; keep the HRCEN/Labtest/2027+/no-send fences. |
| General create (guest/party/guarantee/CMS) | 340 after fake | ~190, discovery at t=0 | G1–G5 are read-only/unsaved probes and need not wait for the fake proof. Code only for verified capabilities. |
| Multi-room | 330 after fake + 60 sync | ~250 post-U1 (U6a/b ~100 pre-fake) + 30 sync | N serial calls through the inline `createReservation` route, not shared-worker batch admission (`hms-batch-events.ts:120-167` needs a worker lease). Make the child claim child-scoped. The UI must not use "Room 1/2" labels (PRODUCT-DETAIL:15). |
| Quote | 520 | 135 (+60 if one gap) | Keep the installed staff path: it already re-verifies parties (`staff-quote-run.ts:674-680`) and maps native IDs (`staff-quote-workflow.ts:225-230,389-431`), with PDF (`workstation.ts:1713-1748`) and unsent reply (`drafts.ts:2058-2189`). 0 LOC expected. Work = one party/no-party HMS comparison + an existing-test run. |
| Triage | 400 (queued after quote in the five-owner case) | ~300, from t=0 | No HMS or quote dependency. Voucher fix 10–25 product LOC (action beats kind: `workflow-folders.ts:270-288`). Pre-stay keeps non-create asks: 65–140 product LOC. Labels come from staff outbound evidence, not an owner wait. 2 PRs. |
| Filing | 510 | ~450 (two owners) | Server-side bytes for both hosts. Registering the worker adapter is ~5–12 product LOC. Readback = complete fresh-read filename/count delta, no HMS marker. Outcome "metadata-visible, bytes unverified". 3 PRs. |
| Amend | 560 | ~420 (discovery parallel) | Five t=0 probes: preimage; date-stage (no save); amount controls (no save); Yes on stay A; No on stay B. Inline approval path like create, not the amend-refusing worker. 3 PRs. |
| Host integration (integrator) | 380 | ~280 | 5 of 6 workflows already mounted. The real fix is webmail exact-message propagation: 40–100 product / 35–80 test LOC. |
| Tail after last lane | 20 + 90 + 330 = 440 | ~60–90 | Continuous merge. Lane Labtest proofs reused. Release = last PR + deploy (7 min median) + both bundles + read-only canary. Eval offline on final head, overlapping release. |

## Critical path

- **Plan:** 290 + 340 + 60 + 20 + 90 + 330 = 1,130 raw.
- **Lean, six workers:** create 220 + max(general 190, multi-room 250 post-U1) + sync 30 = **~500**. Amend single-owner 560 is the alternative critical lane, ~420 if discovery runs in parallel. Add the tail of 60–90 → **~600–650 raw**.
- **Code merged:** ~560 raw.
- **Staffing:** the quote owner frees at ~135–195 → reassign to amend discovery or filing readback. No seventh worker needed.
- **Contingency:** +25% for discovery surprises → ~800. Holds below stay unbounded.

## Real constraint the plan under-models

Live HMS saves share the HRCEN property advisory lock. The t=0 probe set is: quote comparison, G1–G5, amend 5 probes, filing tree read, multi-room unsaved census, then the create, filing, amend and two-child saves. Reads can overlap. **Saves serialize: ~8–12 saves × (setup + 90 s + readback) ≈ 60–120 min of serial lock time.** Assign one live-probe worker to own the queue, and schedule saves at each lane's readiness, not batched at the end.

## t=0 risk retirement (cheapest probe first)

| Risk | Probe | Minutes |
|---|---|---:|
| Party changes quote price | Hotel Availability party vs blank, same criteria | 20 |
| Retain-rate Yes/No semantics | Two saves on clean Labtest stays A/B + fresh readback | 40 |
| Filing readback distinguishes upload | Fresh-session full document tree read on a fake stay (read only) | 20 |
| Native-proof equality at Save fence | Unsaved prepare via the app route | 25 |
| Multi-room duplicate census | Unsaved two-room stage + before/after reads | 20 |
| New guest without shared-profile write | G2 trace + unsaved form | 20 |

## Owner asks at t=0 (block merges, not coding)

1. A permitted route for the worktree command guard (read-only git in assigned worktrees).
2. An approved disposable-DB Vitest route on Product EC2 with no-skip evidence.
3. Confirm the deploy tree: `.worktrees/recover-parse-failure` sits at `cfe1bd02d` (10-30) on `feat/centurion-stay360-ui`.
4. Confirm eval truth = staff outbound evidence, with no owner adjudication wait.

## Correction — arithmetic and staffing (after peer challenge)

- **Arithmetic.** I reported "~600–650" loosely; the components below are the source of truth.
  - Create chain: 220 + max(190, 250) + 30 = **500**. Plus tail 60–90 → **560–590**.
  - Amend single-owner: 560 + 60–90 → **620–650**. Amend with discovery in parallel: 420 + tail → **480–510**.
  - **Critical = max(create 500, amend 420–560) + tail 60–90 = 560–650 raw.** The upper end applies only if amend discovery is *not* parallelized.
  - "Code merged ~560" was wrong. It is max(500, 420–560) = **500–560**.
  - HRCEN save-lock serialization (60–120 min) can extend either chain. It is not inside these numbers; budget it as named contingency.
- **Staffing.** Six feature owners + one integrator = **7 sessions**: create, multi-room, quote, triage, filing, amend + integrator.
  - The live-probe queue owner is **the quote owner**: quote's 135 min is itself mostly live reads (U2-B/C). From t=0 it runs the quote probes, then holds the HRCEN save-queue schedule for the other lanes' saves.
  - Each lane owner still prepares its own probe inputs. No eighth session is assumed.
  - If the quote owner frees, they take amend U5.1 probes 4–5 and filing readback design.

## Appendix A — per-lane task tables (reviewer output, verbatim substance)

LOC = estimated additions + deletions, judgment unless marked. Minutes are active minutes (judgment). Live wall time and the shared EC2 check queue are separate.

### A1. Create (U1) — integrator tree `/home/orca/orca/workspaces/zero/connected-pilot-integrator-20261102`

| ID | Task / files | Prod / test LOC | Exact tests; exact HMS check | Deps | Min |
|---|---|---:|---|---|---:|
| C1–C4 | Verify field provenance, PaneStay review, native map. `pane-create-{scope,approval,cloud-input}.ts`, `booking-card.tsx` (1424-1455, 735-743) | 0–15 / 0–10 | Existing `hms-approval.test.ts`: acknowledged revision; reviewed stay/native mismatch. `pane-create-cloud-input.test.ts`: changed rate, note, party, no-send. HMS: none | — | 30 |
| C5–C6 | Remove static hold only (`quote-workflow.ts:201-206,471-472,576-577`). Admission stays fake-only. | 5–20 / 15–30 | `quote-workflow-router.test.ts`: Labtest capability advertised only after gate; wrong guest, revision, mail, stay or proof refuses. `hms-approval.test.ts`: one-use; changed reviewed stay; uncertain outcome. HMS: none | C1–C4 | 30 |
| C7–C10 | Fill route-test gaps; head checks/review | 0–15 / 25–50 | Add approved-route success; no auto-retry after uncertain dispatch | C5–C6 | 55 |
| C11–C12 | App-route prepare probe, **no Save** | 0 / 0 | HRCEN; Proof Labtest 2027-03-10→12, 2 adults, selected native room/rate via `quoteWorkflow.previewStay`. Compare staged native values + screenshot | checks + auth | 25 |
| C13–C15 | One save, fresh readback, private evidence | 0 / 0 | Same reviewed stay; one approval/Save; CMS off. Fresh-session Record View by conf#: compare conf#, dates, room type, rate code, adults. Adult-only avoids exact-child-age reader gap. Route proof ≠ host click | C12 | 45 |
| Gates | One focused PR | — | exact head | C5–C10 | 45 |

Total ~220. Code: 5–50 prod / 40–90 test, 1 PR.

**G1–G8 (general create), t=0.**
- G1–G5: source + read-only/unsaved Labtest checks, 90 min. G6–G8: admission, child identity, test design, 60 min.
- Code only for verified capabilities: guest/actor/property 80–220 / 80–180; party/guarantee 40–140 / 40–120; authorized CMS path 40–140 / 40–120. These ranges overlap and are conditional.
- Evidence: `pane-create-cloud-input.ts:34-109`, `pane-create-scope.ts:7-24`, `quote-workflow.ts:302-325`.

### A2. Multi-room (U6) — sibling `.claude/worktrees/agent-a649800c980aff834`

| ID | Task / files | Prod / test LOC | Exact tests; HMS | Deps | Min |
|---|---|---:|---|---|---:|
| U6a | Editable/selectable allocations, stable IDs; zero / one / >8 behavior. `batch-booking-review.tsx`, `pane-batch-booking.ts`, booking card. No "Room 1/2" labels (PRODUCT-DETAIL:15) | 80–130 / 80–130 | `batch-booking-review.test.tsx`: edits invalidate review; explicit selection; zero disabled; one → single create; >8 honest block; amount vs rate-plan. HMS none | contract | 55 (pre-fake) |
| U6b | Child scope + manifest binding; roomIndex>1; aggregate occupancy. `hms-batch-manifest.ts`, `pane-create-scope.ts` | 40–80 / 50–90 | `hms-batch.test.ts`: ordered IDs; changed/omitted child; no-send; + roomIndex>1, single selected child, aggregate occupancy | U6a | 45 (pre-fake) |
| U6c | Inline child claims/grants, preimage, serial calls/results. `quote-workflow.ts`, `pane-create-approval.ts`, batch events. **No worker admission** | 100–180 / 100–160 | Child replay/mismatch; first confirmed → second uncertain stops; no retry; stale preimage refuses | U1 boundary | 80 |
| U6d | Two-room proof | 0 / 0 | Prepare 2 stable allocations, HRCEN Labtest 2027+; compare each staged room/rate. Close unsaved drafts + census before/after. Then one authorized serial Save, CMS off. Fresh Record View per conf#: dates, room/rate, adults. Stop on uncertainty | U6c, U1 fake | 90 |
| U6e | Both-host result mount + review | 0–20 / 0–20 | Outlook + webmail show each child result, no second write | U6c | 40 |

- Post-U1 ~250; sync ~30.
- Evidence: `hms-batch-events.ts:39-69,120-167`, `hms-batch-executor.ts:36-46`, `hms-batch-manifest.ts:21-63`.

### A3. Quote (U2) — main checkout

| ID | Task | Prod / test LOC | Exact tests | Exact live HMS check | Min |
|---|---|---:|---|---|---:|
| U2-A | Trace installed route + effective quote setting (`workstation.ts:902-944`); choose installed | 0 / 0 | — | — | 15 |
| U2-B | Party vs no-party Hotel Availability | 0 / 0 | `hms-cloud-availability-reader.test.ts`: "labels nightly observations as estimates and leaves totals and entitlements unknown"; "keeps unknown stock unknown and withholds unverified criteria"; "does not label conditional HMS stock available". `quote-view-cli.test.mjs`: "row pagination and restrictions survive the offline projection"; "optional arithmetic is not an official price or joint availability" | Same property/dates/adults/child ages/qty/room-rate scope; one search with verified party ID, one blank. Compare applied party IDs, changed strategy/restricted-sell, every room/rate/promo/night, stock vs qty, restriction reasons, price/currency, pagination completeness | 20 |
| U2-C | One installed staff quote vs HMS evidence | 0 / 0 | `party-contract-rates.test.ts`: company ID; both IDs; incomplete-search fallback; switch-off; sold-out room. `staff-quote-route.test.ts`: "uses staff corrections through the real route and qualifies accommodation despite a secondary ask" | Same request + party: submitted party, room/rate/board, contextual vs public basis, nightly amount/currency, stock/restrictions, total/tax basis. Unknown basis → not qualified | 20 |
| U2-D | PDF + unsent reply, both hosts | 0 / 0 | `quote-proposal.test.ts` "keeps dinner pricing in the attachment, not the cover reply"; `nava-pane-render.test.tsx` "keeps a refused quote reply to one decline line while room alternatives stay staff-side"; `outlook-pane-quote-pdf.test.tsx` "uses the registry property identity for the reviewed reply and attaches its PDF"; `save-reply.test.tsx` "saves the reviewed reply and PDF as the thread draft, not as an Outlook insert", "refuses to save while the reply has no reviewed PDF" | Reply body excludes company; PDF company field, totals, rate; both unsent | 40 |
| U2-E | Focused regression run | 0 / 0 | above + `staff-quote-party-pick.test.tsx` (sends picked kind/nativeId/name; no party key without pick), `quote-workbook.test.ts` (workbook total = PDF total) | — | 40 (parallel) |

- 135 raw (95 if tests run in parallel); +60 reserve for one gap fix (~80/50 LOC, 1 PR).
- Product-done bar (≥10 threads match staff evidence) is separate and unmeasured.
- Evidence: `staff-quote-run.ts:674-680`, `staff-quote-workflow.ts:225-230,389-431`, `staff-quote-installation.ts:535-692`, `hotel-availability.md:39-118`, `availability-view.md:21-72`, `quote-view.md:35-43`.

### A4. Triage (U3) — main checkout

| ID | Task / files | Prod / test LOC | Exact cases | Deps | Min |
|---|---|---:|---|---|---:|
| U3.0 | Trace intake→task→pane (`extract.ts`, `work-items.ts`, `mail-triage.ts`, `nava-pane.tsx`) | 0 / 0 | action/kind consumers; all pre-stay suppression points | — | 40 (lean: 15, already traced) |
| U3.1 | Voucher prompt + folder precedence; flip contradictory test. `extract.ts`, `workflow-folders.ts:260-288`, `action-classifier-extraction.test.ts`, `workflow-folders.test.ts` | 10–25 / 20–35 | voucher-only existing stay → payment_proof/payments, not new_booking; explicit booking → new_booking; voucher_pop fallback → payments; action beats kind | U3.0 | 20 |
| U3.2 | Keep non-create pre-stay asks; consume `stays[].action` where supported. `mail-triage.ts:847-878`, `work-items.ts` suppression sites, `nava-pane.tsx`; schema unchanged | 65–140 / 60–100 | pure pre-stay → existing-stay info, no create/quote; + amend/payment ask → task visible + in Needs You; external sender same subject not suppressed; two stays distinct actions route separately. Non-stay second ask with no representation → stop + reforecast | U3.0 | 140 |
| U3.3 | Focused regression. `prestay-self-mail.test.ts`, `work-items-existing-stay-db.test.ts`, `work-items.test.ts` | 0 / 25–50 | payment request; travel agent; human mentions OTA; automated OTA; TMC cancel notice vs person cancel; ambiguous; no-action. DB case must actually run | U3.1–2 | 60 |
| U3.4 | Freeze arrival-only slice (non-coder, t=0) | 0 / 0 | thread-disjoint; voucher, payment request, booking, TA, pre-stay, mixed, ambiguous/no-action; no later replies | — | 20 |
| U3.5 | Adjudicate vs staff outbound evidence; per-class errors | 0 / 0 | provenance recorded | U3.4 | 40 |
| U3.6 | Action selection, one host (both at release) | 0 / 10–20 | pre-stay non-create ask visible, no create | U3.2 | 40 (lean: 20) |
| U3.7 | Two head gates | — | — | — | 40 |

400 reviewer total; lean ~300 (trace 15, one host 20, eval truth from staff outbound = no owner wait). 2 PRs. No HMS.

### A5. Filing (U4) — coordinator + sibling `agent-a622b74da134a5ced` + worker `agent-a90b160483c5888ce`

| Slice | Files | Prod / test LOC | Exact tests / Labtest check | Min |
|---|---|---:|---|---:|
| U4.1a Source + approval | `voucher-filing-source.ts`, attachment resolver (server-side S3: `s3.ts:82-96,142-193`; `mail.ts:1762-1805`), `voucher-filing-service.ts` | 70–110 / 60–90 | "reads the accepted version at prepare and execution, binding the private receipt into approval"; "refuses missing, null, altered or ambiguously attributed receipts without reading bytes"; "refuses changed version, bytes, approved identity and authority; never returns unapproved bytes"; "binds the selected source then approves exactly that form and HMS snapshot" | 140 |
| U4.1b Worker + native fence | `hms-cloud-executor.ts` (registry 43-65), `hms-approval.ts` (1038-1068, 1682-1732), upload tooling | 45–70 / 35–50 | existing "does not claim amend or batch even if an adapter and feature flag are supplied"; "filing refuses altered source, unsupported type and non-Labtest identity before dispatch"; add: adapter claims once; wrong stay/stale grant refuses | 80 |
| U4.1c Readback + review | `stay360-documents.mjs:44-72`, `voucher-filing.mjs:14-117`, review boundary | 50–80 / 45–70 | replace marker test: unique before/after filename delta succeeds only on a complete fresh read; incomplete/duplicate/pre-existing/changed tree → needs_check; existing "fresh readback refuses wrong stay and unsafe contexts before browsing" | 100 |
| Pane + checks | `voucher-find-card.tsx`, shared pane | 35–55 / 20–35 | selected file/stay + metadata-only/uncertain result shown; no send | 100 |
| Proof + tail | — | 0 / 0 | One synthetic PDF, HRCEN Proof Labtest 2027+; upload once; separate fresh session: same native stay, full refreshed doc list, unique filename + count delta. Bytes unverified | 90 |

- ~200–320 / 175–270 LOC, 3 PRs.
- ~450 with integrator help, 510 single-owner.
- Upload wall time is unmeasured.

### A6. Amend (U5) — sibling `agent-a58d477dbd18020f4`

**U5.1 discovery (t=0, 100 min, five probes):**
1. Read-only preimage + pick clean HRCEN Labtest 2027+ stays.
2. Date-only stage, price/tax before/after, **no save**.
3. Amount controls/basis/tax, **no save**.
4. Stay A occupancy delta, Save, **Yes**, fresh readback.
5. Stay B same, **No**, fresh readback.

Stop before probe 5 if probe 4 is uncertain. Never reuse prior uncertain targets.

| Slice | Files | Prod / test LOC | Exact tests / check | Min |
|---|---|---:|---|---:|
| U5.1a Preimage | `cloud-saved-stay-amend-prepare.ts` (119-136 refuses now), readers | 40–65 / 35–55 | "checks the real mailbox and current item, but never stores a form or snapshot without a validated saved preimage"; "refuses spoofed actor, mailbox, source, property, and client-supplied preimage"; "rechecks current source and form under the item lock; closed or changed work is not the old binding" | 80 (parallel) |
| U5.1b Inline grant + dispatch | amend approval/route, Save guard (pattern: integrator `quote-workflow.ts:562-675`) | 30–50 / 25–40 | stale source/form + mismatched delta refuse at locked Save fence; possible dispatch held, never retried | 40 |
| U5.1c Writer + result | `guest-stay-amend*.mjs` | 60–100 / 50–80 | existing "refuses unknown properties and amount overrides without touching a page"; "uses the actual child and date guards and never claims a saved outcome"; add exact request match, chosen rate behavior, fresh readback/screenshot | 100 |
| U5.1d UI + checks | `saved-stay-amend-editor.tsx`, `amend-lookup-panel.tsx` | 30–45 / 20–35 | current/requested + verified outcome; amount explicitly unsupported unless proven | 120 |
| Proof + tail | — | 0 / 0 | One combined date+occupancy stage, Save with reviewed choice, fresh readback + screenshot; compare every exercised field | 120 |

- ~160–280 / 150–260 LOC, 3 PRs.
- ~420 with discovery parallel, 560 single-owner. Amount writer unpriced until probe 3.

### A7. Hosts / integrator (U7)

| Slice | Prod / test LOC | Min | Cases |
|---|---:|---:|---|
| Exact message ID `mail.tsx`→`WebPanePanel`→`useWebPreview`→`selectPreviewMessage`; fail closed | 40–100 / 35–80 | 45–55 | pinned earlier msg wins over newer inbound; missing pin refuses, no fallback; no-pin → latest inbound |
| Same-thread stale context | 10–50 / 20–70 | 30 | A→B→A restores A; no stale quote/draft from B |
| Draft/attachment seam | 0–50 / 15–60 | 35–60 | draft unsent + bound to selected msg; attachment source correct |
| Host checks | 0–20 / 20–50 | 30–40 | both hosts keep selection |
| Mounts | quote/create/triage/amend/filing 0–10 each; multi-room 10–30 / 15–35 | — | already routed in NavaPane except multi-room (inside BookingCards) |

- Integrator ~280 (plan 380).
- Tests go in `apps/mail/tests/web-pane-bridge.test.ts` and `mail-nava-panel.test.tsx`; the panel mock currently pins `sourceMessageId` null.
- Tail after the last PR: review/merge 5–10, deploy ~7 (historical median), both bundles + canary 10–20 → **22–37**.
- Residual integration: 30–40 (keep 90 as contingency).
- Deploy readiness gate (dead-letter exit 1 gotcha) is not bypassed.

### A8. t=0 probe schedule (quote owner holds the HRCEN save queue)

| Order | Probe | Type | Est |
|---|---|---|---:|
| 1 | U2-B party vs blank availability | read | 20 |
| 2 | Filing doc-tree fresh read on a fake stay | read | 20 |
| 3 | G2 new-guest trace + unsaved form; G3/G4 party/guarantee unsaved | unsaved | 40 |
| 4 | Amend probes 1–3 (preimage, date stage, amount controls) | read/unsaved | 60 |
| 5 | U6 two-room unsaved stage + census | unsaved | 20 |
| 6 | Amend probes 4–5 (Yes on A, No on B) | **2 saves** | 40 |
| 7 | C11–C12 app-route prepare (needs C10) | unsaved | 25 |

- Reads and unsaved stages may overlap where sessions allow.
- Planned saves: amend ×2, create ×1, filing ×1, multi-room ×2, amend proof ×1, optional general-create ×1–3 → **~8–10 serialized**.

## Owner decisions on the t=0 asks (2026-11-02, given in the reviewing session)

1. **Read-only git in assigned worktrees: allowed.** The guard hold drops out of the plan as an owner-authority question. A harness hook that still refuses is a tooling fix, not a product hold. Do not edit hooks to evade it; ask the owner to adjust the harness setting if it persists.
2. **Disposable-DB test route: owner says skip it.** DB-backed suites are not a release gate for this pilot. Use DB-free focused tests and live Labtest proof. A skipped DB suite is reported as skipped, never as passed.
3. **Deploy = main.** At release, fast-forward the deploy tree (`.worktrees/recover-parse-failure`) to main, or have it check out main, then run the existing `ops-deploy.sh` git-bundle sync. No separate tree reconciliation step.
4. **Eval truth = staff outbound evidence.** No owner adjudication wait. Disagreements are reported as such, not escalated.
