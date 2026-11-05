# ADV REVIEW TRACKER — plan 2026-11-04-001 (caveman ultra, LLM-only)
target: docs/plans/2026-11-04-001-feat-m1-recovery-plan.md (272L)
owner ask 11-04: adv review LATEST plan; cut ceremony; ETA; gaps; cancel dropped why; agent arch (brief); pane at nava-admin "fucked/lacking"
owner steer mid-turn: "overindexed on mastra, review the PLAN" → focus plan. arch = 1 section max.
main=1e2b2f7a0 (#999) deployed 00:05 11-04; flags CREATE=lab ATTACH=lab; #1000 open (create pricing, 112 bug)

## read so far
- 11-04 plan, 11-04 paused retro, plan003 (head), M1 prompt, deep retro REPORT
- mastra: reservationist-agent.ts (Agent id=reservationist, tools quote_stay/party_lookup/pdf/create_dry_run, Luna model) → runReservationistRuntime (plan→execute). last touched 10-22. not in pane write path.

## hard numbers (mine)
- main since 11-01: 131 commits. product +18122/-1602, tests +29070/-564 (tests 1.6x product)
- top commit verbs: Bind13 Guard11 fix11 Add10 Keep9 Stage5 Connect5 → guard-heavy
- open PRs ≥30, most stale 11-02 batch/amend/replay lanes
- 167 worktrees

## evening run 20:34→00:25 facts (mine)
- product lines merged 11 PRs: ~530 (#991 filing 292, #998 env writer 160, rest tiny). docs commit 23c8126a8 = +15K lines retro CSV/evidence (commands.csv 5478, operations.csv 4138, evidence md 4.3K)
- private run dir ~/.codex/m1-20261103-203425: 269 files, 51 .sh operator scripts, 46 "create-canary2-*" artifacts = numbered probe loop AGENTS.md forbids
- 1 real fake Create Go 23:33 → HMS "Rate is not available" (no CheckAvail). legacy create-lab-stay.mjs:1247 clicks CheckAvail before Save. Cloud rebuild (post 10-27 cloud move; owner 11-01 "old tools ref only") dropped step.
- prod writer fn literally named saveNewLabtestStay + searchLabtestPreimage (booking-lookup-session.mjs:35-36,377-488). guest-stay-save.md: "Owner authorization applies to fake Labtest writes only... does not authorize writes for real guests". → real-guest create path built on Labtest-named writer; preimage = "existing same-name/arrival refuse"
- PANE_BRAIN=agent + LunaMax deployed (STATE.md) → pane analysis = Luna agent (analyseSelectionWithAgent, tools off/writes off). Mastra reservationist agent (quote_stay/party_lookup/pdf/create_dry_run) exists, last edit 10-22, not in pane write path. writes = deterministic pane→route→tool. (1 section only)
- ETA ledger medians: code-server .85 code-ui .87 deploy .83 live-hms .67 review .87 plan .73

- saved-stay-save-route-chain.mjs:6,198,276 ALREADY admits AVAILABILITY_PATH in Save route chain (used by guest-stay-save/amend). → CheckAvail inside protected Save op = existing seam. PR#1000 prepare-time guard exemption + 1112 matcher = likely unnecessary. (lane-create to confirm)
- 10 plans written 11-01→11-04; 103 research md since 10-31; ~396K words docs. hms-cloud: 16.3K prod LOC + 6.6K test LOC, built 10-30→11-03.
- staff-quote-run.ts imports reservationist runtime → Quote path does use agent runtime (installed provider). fine.

## plan text stats
- 4997 words, 8 units, 35 tasks, 29 "checkpoint", 12 "Unknown", 72 "existing", 40 "do not"
- 35 tasks × ~10min checkpoint = ~330 min summed; plan refuses any ETA
- re-adds U7 Cancel (5 tasks) + U8 Amend (5 tasks) = 10/35 tasks; M1 prompt barred them

## plan claims → verdict (fill)
| # | plan claim | verdict | evidence |
|---|---|---|---|

## candidate attacks (to verify)
A1 scope re-expanded: U7 Cancel + U8 Amend re-added as parallel lanes while M1 0 writes working. M1 prompt said NO cancel/amend. plan contradicts own predecessor w/o owner ask? (check: owner asked cancel back?)
A2 no ETA anywhere ("Unknown" x5). 10-min checkpoints w/o completion est = the exact drift owner complains about.
A3 prepare-time Check Availability via read-only-guard exact-request seam = ceremony. alt: run CheckAvail inside Go/Save write op; show Quote price at prepare (R9 says no price freeze). verify Save route availability seam + session model.
A4 CMS confirm disabled in code vs owner 11-02 "CMS on real guests". plan says keep manual → contradicts owner.
A5 pane UX not in plan at all except price display. owner sees pane "lacking". what renders?
A6 R10 charged-cancel 2nd approval = new protocol; PRODUCT says never accept penalty dialog. conflict.
A7 U4 operator helper edits in ~/.codex private scripts = ceremony outside repo.
A8 "one fake op per workflow" OK; but promotion gate needs canary token w/ exact SHA → each redeploy re-canary?
A9 30+ stale open PRs, 167 worktrees = noise; plan ignores cleanup.
A10 doc bloat: plan 272L/37K for ~400 LOC of work.

## ETA reality (mine)
- ledger per-unit medians ~0.85 (units overestimated) BUT whole-milestone runs never close: 11-02 plan005 est 340–430 → superseded; box2 360 → partial; Option A 120–165 → 274+ no deploy; evening M1 120 → 231 paused, 0 writes. → unit ETAs fine, integration/native unknowns kill milestone. ratio milestone ≥2–3x, outcome never pass.
- wall clock since 11-02 16:47 plan005 kickoff → 11-04 00:25 = ~31.5h, 0 staff writes live.
- Save route-chain availability gate: requires availability.isArmed + matches(request,frame) — matcher seam exists in Save path (line 198-205). Create Save just never passes `availability` option.

- !!! pane-cloud-preview.ts:116-118 createAdmission: flag=lab + non-Labtest guest → refuse 'cloud_preview_labtest_only' EVEN FOR PREVIEW (unsaved). owner authorized real-guest unsaved staging. → every real email Create card in pane today = refusal. explains owner "pane fucked". fix = 1-line: allow preview for real guest when mode=lab, keep commit gated. NOT in plan as a task (plan only mentions it in U6.4 after promotion).
- legacy amend-stay.mjs:125 "HMS keeps changed date/occupancy only after Check Availability re-rated; Save before that discarded" → CheckAvail-before-Save was KNOWN domain fact since legacy; cloud rebuild lost it. knowledge-loss from "old tools ref only, don't edit" + no port checklist.
- Save writer saveNewLabtestStay (guest-stay-save.mjs:562-680): draft verify, schema proof, profile token, selection tokens, AR token, preimage consume, route-chain fence, full-body matcher. ~15 throw paths before Save. route chain already has availability phase (save-route-chain.mjs:49,198).

- staff copy (pane-stay-bind.ts:49): "HMS preview is currently available only for Proof Labtest test stays in 2027 or later. Book real guests in HMS." → every real booking email Create = this message. pane looks dead.

- 985/988/1109/1112 explained (plain): Save writer pins exact native form key-set = "schema allowlist" (guest-stay-save.md:91-104). Save POST must match 985 model keys + 3 controls exactly + every value, else refused pre-network. 1109 = raw model incl metadata. 1112 = different request (CheckAvail). → numbers = artifacts of hyper-strict full-body request matching. this matcher design = root of brittleness (any HMS field change → fail closed → re-review).
- doc says historical strict Proof Labtest create "dispatched successfully... fresh saved record matched" (md:125) WITHOUT CheckAvail? vs 11-03 23:33 "Rate is not available". open q: did earlier success use different rate/track, or did HMS behave diff? (lane-create)
- Filing real guest gate: hms-approval.ts:169 allowRealGuest = ATTACH==='on'; pane-hms-write.ts:155 Proof/Labtest/2027 check. → same lab=fake-only for Filing.

## agent lanes (fill)
| lane | model | q | status | out |
|---|---|---|---|---|
| pane | sonnet max | what staff see | DONE | lane-pane.md |
| create | sonnet max | create path, CheckAvail seam, #1000 | run | lane-create.md |
| cancel-amend | sonnet max | why cancel dropped, min paths | run | lane-cancel-amend.md |
| owner-asks | sonnet max | verbatim owner vs plan | run | lane-owner-asks.md |
| filing-release | sonnet max | filing gap, release gates | run | lane-filing-release.md |

## P0 VERIFIED BY ME: adults-only Create always refused from real pane
- pane-stay-bind.ts:400,431 `...(childAges.length ? {childAges} : {})` → empty omitted
- quote-workflow.ts:87 route schema childAges optional; :315-321 passes stay through
- pane-create-cloud-input.ts:88 `!Array.isArray(stay.childAges)` → refused child_ages_required
- operator script create-canary2-preview.sh:17 injected `childAges:[]` direct to route → bypassed pane builder → "installed" proof never exercised real pane request. plan U6 "installed operation" = same blind spot.
- fix: 1 line (always send childAges array, or mapper default []).

## lane-create digest
- Go = fresh browser session, replays approved request (digest), restage, Save, readback. not same draft. → plan U2.2 "same current draft" wording moot.
- save-route-chain availability phase exists, 0 prod callers. shared read-only guard blocks CheckAvail path regardless → need 1 narrow exception either way. Go-time: 40-70 LOC; prepare-time (#1000 fixed): 20-40 matcher + 20-35.
- keep price at Prepare (owner 00:57 "Approve rate plan; show HMS price and final result"). → #1000 approach OK in principle; fix matcher = replace 1112-enumeration w/ path+frame+one-shot+draft-bound check.
- 91 refusal grep hits in 4 create files. top blockers: lab flag, childAges P0, avg rate blank, profile id, source/guarantee, party native id, room codes, note required(!), dates, CMS.
- staff_note_required: reservationNote REQUIRED to create (pane-create-cloud-input.ts:91). pane only sends nonblank. → another silent refusal unless staff types note. check UI prefill.
- CMS: 35-60 LOC / 4 files to honor owner 11-02 "option B".
- multi-room 1-8 sequential wired.

## lane-owner-asks digest
- owner 01:04 S:4716: core = create, cancel, amend. "not enough prefill+reads". → plan U7/U8 inclusion IS owner-sourced. my A1 attack WRONG → retract. real issue = sequencing (Amend waits for Cancel handoff: no owner source).
- owner 19:38 "Show charge; require second staff approval in Nava" → R10 owner-sourced. A6 retract (but conflicts PRODUCT.md hard rule "never accept penalty dialog" → PRODUCT.md must be updated or R10 deferred).
- tests: owner "as little testing as possible", not zero. owner user-message to me says "don't even bother writing tests". plan "zero new tests" consistent.
- ETA asked 3x (S:847,1013,4330), plan = Unknown. FAIL.
- CMS: plan contradicts owner option B. FAIL.
- 1112 guard / filing search UI: no owner source, technical remedy.

## RISK (mine): Save allowlist after CheckAvail
- guest-stay-save.mjs:32-48 Save requires form keys == exactly 985 (sha256 pinned) or 985+2 confirm flags. create-reservation passes strict proof (:658).
- CheckAvail may add/set keys (e.g. confirmratenotallowedforrestemplate set after dialog per md:99-100). if CheckAvail changes key-set → Save refuses CREATE_FORM_FIELD_SCHEMA_CHANGED → next "1-hour mystery". NOT considered in plan U2. legacy create-lab-stay.mjs had no key-hash pin & worked.
- recommendation: drop sha256 key-set pin for Create (keep value checks on ~20 critical fields: guest id, dates, room, rate, adults, children, guarantee, party ids, note). this = the "985/1112" confusion source. ~-15 LOC.

## lane-filing-release digest
- filing gap real: UI needs extracted surname+arrival AND exactly 1 row. no edit, no picker. backend does NOT need extraction. fix 60-100 LOC voucher-find-card.tsx (reuse amend-find.ts searchRequestFor/findRequestFor).
- NO fake PDF upload + Documents readback EVER proven on current code (only 11-01 64-byte text upload HTTP200).
- promotion per workflow possible via write-ec2-remote-env.sh --m1-only + ops-restart. not circular. canary token: no in-repo producer → must be minted from real fake-op result. private helper joint Create+Attach = cut.
- deploy = ~5m20s step sum, consistent (3 receipts). release tail incl review ~11.5 min (#999).

## lane-pane digest
- quote: works (auto, rates, PDF, unsent reply insert). best asset.
- create: real guest → "Labtest only / book in HMS" copy. CMS checkbox visible+disabled (dead control). no >30s progress on preview/book.
- amend: lookup + local compare, "nothing saved". cancel: lookup/review only, no commit. → 2 of 5 workflows = read-only cards w/ no action = "lacking".
- filing: lab = fake only; extraction gate (surname+arrival+1 row).
- 15 raw strings (err.message verbatim, item.reason verbatim). diagnostics screen technical.
- verdict: pane is NOT broken; it's a read-only demo for real mail. every write says "do it in HMS". that's the "fucked" feel.

## findings (fill)

## proposed cut plan + ETA (fill)

## lane-cancel-amend digest
- cancel cut by agent (plan003 "optional launch scope cut"), PRODUCT adopted M1 excl; owner restored 11-04 01:04. 810e clean @64d1caf57 (0 dirty, 12 behind main) ~711 core LOC. no Cloud Save receipt. DoD5 fake cancel old SHA ok. cut 409 finance preflight.
- amend: adult-only native proof; dates unproven; ee01 73 dirty, ~1804 core LOC.

## DONE 01:5x → REVIEW.md written. ETA ledger row zero-advrev-m1-create-filing-20261104 (P50 95 / P80 150 from T0).

## v2 02:2x owner steer applied
- owner: cut old PRODUCT/AGENTS rules NOW; all write flags lab→on OK once working; penalty → staff 2nd Go; CMS = staff tickbox (D1 dumb q); no fallbacks, timeboxes ok, 1.5x ok; prove via real email stop-before-Save, no pane UI; cancel "5-min tool"; amend = few fields; watcher lane (said Sol; memory says never Sol → ask).
- DONE: main 7e871275c PRODUCT 1122→866w, AGENTS 1195→613w. memory: pilot-now-rules + 3 penalty fixes + cms clarify. skills nava-run/zero-plan (/home/ubuntu/.agents/skills) fixed. root PRODUCT/AGENTS/CLAUDE synced to main (bak /tmp/root-docs-bak-20261104). loop stopped.
- penalty rule leak: 33f614dd8 10-13 → a0c9f615c 11-02 → 23c8126a8 11-03 22:06 (agent rewrite kept it after owner 19:38 "cut").
- evening 20:34→00:25: 10 commits, product +565, tests +67, docs +15,257 (verified).
- NEW findings: (1) Cloud Create Save succeeded 11-02 w/o CheckAvail (#870, guest-stay-save.md:125; agency+org, 0 children, CMS 03) → CheckAvail = strong hypothesis (legacy+amend comment), only Labtest Save proves. (2) HRCEN cancel: status Cancelled BEFORE penalty dialog "may be added to account. OK" (dod5-hrcen) → 2nd Go = post charge or not. (3) 2nd Create blocker "startup completion" (Vault late request) — retro:47,88; #1000 lookup.mjs +8. REVIEW missed. (4) canary token = line in /tmp/mh1024/CANARY.txt, not hidden blocker. (5) main guest-stay-cancel.mjs pins Proof/Labtest/NGI/blank parties/full body (:41-171) → generalize. 
- corpus: top5 rate codes 459/492=93.3% email bookings (NGOVDB 41.5 NCOR1B 19.3 NGOVB 12.8 NCOR2B 10.6 BAR 9.1) party-memory-and-lookups.md:47; amend n=223 occupancy 30% extend 7.6% (l2-amend-payment.md:108-112), no room/rate/children split.
- ETA ledger zero-pilot-now-all4-20261104 P50 150 / P80 225 from T0.

## v3 owner: cut rules first, then plan
- main 70f42e7c8: 7 hms-cloud tool docs (labtest-only/never-accept/real-guest-out-of-scope wording) + .cursor/rules/nava-workflow.mdc → point to AGENTS/PRODUCT.
- memory 86→8 files (bak /tmp/memory-bak-20261104). Sol ban deleted. skill building-hms SKILL.md penalty line fixed.
- PUSHBACK: HRCEN refusal lines in pane-stay-cancel.ts:303, pane-hms-write.ts:870,988,1015 route to LEGACY on-site tools (amend-stay.mjs/cancel-stay.mjs) → wipe inside lanes C/D w/ Cloud rewire, not blind delete.
- 24 fields = legacy create-tool.schema.json $defs.request (10 required). VERIFIED from code. NOT a staff-behavior census.
- ETA honesty: past-week milestones 0 closed (plan005 340→338 superseded; OptionA 120-165→274+ no deploy; evening 120→231 paused). piece P50 = same method that failed. calibrated: Create+Filing ~3h, all4 ~5h P50 until first lane lands.
- deeper plan NOT written yet. next: plan + /goal prompt for Codex 6.1 Sol ultra.

## v4 2026-11-04
- HANDOFF-critical-review.md written. Correction: HRCEN refusals = #963 (9a74faca6, 11-03) concurrency/uncertain-write fence, NOT cloud-unreachable. Legacy cancel/amend reach Cloud via HRCEN secret (centurion-stay360.mjs:15-47); Cloud DOM steps unproven. Wipe needs replacement fence (R12 open). PR #1000 still OPEN.
