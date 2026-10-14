# Settled facts and evidence

**Snapshot date:** 2026-10-14. This is a navigation aid to prior evidence, not live permission, not a substitute for the current product spec, and not a claim that historical metrics still hold. Percentages below retain each source's denominator, window, unit, label source, and limitations. `Owner decision` means a current owner-backed rule; `measured` means a count in a dated snapshot/sample; `estimate` means a weighted or analyst estimate; `disputed` means sources or definitions conflict.

## 1. Case mix: do not choose a winner across unlike estimates

### Best documented population estimate

The 2026-10-13 R3 study covers **7,827 non-channel inbound messages** from **2026-07-30 18:30:59Z through 2026-10-13 17:54:13Z** (5,206 external and 2,621 internal). It labels a stratified sample of **400 messages**, not threads, and estimates population shares using stratum weights. The report says one analyst and no second-rater adjudication; later owner-context notes say the analyst was an LLM. The exact label-source attribution therefore remains a provenance caveat; neither version establishes human gold labels. Source: [`docs/research/2026-10-13/r3-workflow-truth.md`](../research/2026-10-13/r3-workflow-truth.md), especially lines 10–14 and 29–43; attribution correction: `/home/orca/.claude/projects/-home-ubuntu-projects-zero/memory/feedback-reuse-research-no-redo.md` lines 8, 14 (local owner memory, not in this repository).

| R3 action label | Labeled sample | Estimated share (approx. 95% CI) | Estimated messages |
|---|---:|---:|---:|
| No action | 227/400 | 63.47% (58.46–68.47%) | 4,968 |
| Quote/availability | 16/400 | 3.13% (1.31–4.96%) | 245 |
| New booking | 39/400 | 10.05% (6.88–13.23%) | 787 |
| Amend | 16/400 | 2.69% (1.01–4.37%) | 211 |
| Cancel | 16/400 | 0.72% (0.02–1.43%) | 57 |
| Payment proof | 16/400 | 4.44% (2.24–6.64%) | 347 |
| Billing | 33/400 | 7.54% (4.86–10.21%) | 590 |
| Group/event | 22/400 | 3.78% (1.82–5.74%) | 296 |
| Other actionable | 15/400 | 4.18% (1.98–6.38%) | 327 |
| **Any action** | **173/400** | **36.53%** | **2,859; ~38.13/day (32.91–43.35/day CI)** |

The total is a useful planning estimate, not a live accuracy claim. Confidence is lower for small classes. Reported intervals cover sampling error, **not** labeler uncertainty. The frame includes unlisted automated/system mail, manually labeled no-action when informational; it is not the share of work the current product already handles. Source: R3 lines 11–14, 29–43.

### Important comparisons and unresolved mix claims

R3's binary flags overlap; they are not a mutually exclusive action mix and not a count of unique stays. In the same 400-message sample, weighted estimates were agent notice **14.02%**, booking request **11.60%**, payment-proof evidence **5.99%**, and agent-supplied voucher **7.86%**. Of 35 sampled agent vouchers, **24 also requested a booking**, **11 were neither a booking request nor POP**, and **0 had actual payment-proof evidence**. Zero of 35 is a sample observation, not proof that vouchers never carry POP. R3 found no same-thread confirmation-letter PDF for those 35 vouchers; that does not prove no HMS entry because mail may split across threads. Source: R3 lines 47–60.

| Source and figure | Unit, window, label source | How to use it |
|---|---|---|
| R3 new-booking action **10.05%** vs older `booking` **4%** | R3: 75-day, 7,827-message frame, weighted 400-message sample, analyst-assigned action. Older figure: 1,788 mail rows, Sep 26–Oct 11; message/thread unit and label source unclear, likely extraction-kind. | Different meanings and denominators; no winner. Older source: `/home/orca/.claude/projects/-home-ubuntu-projects-zero/memory/project-nava-adoption-gap.md` lines 8–15. |
| R3 quote action **3.13%** vs R1 quote detector **6.0%** | R3 weighted manual/LLM-assigned action over 7,827 non-channel inbound messages. R1 detected 313/5,204 eligible external inbounds using a heuristic. | A detected ask is not the same label as a weighted quote action; R1's external frame differs from R3 by two messages. R1: `docs/research/2026-10-13/r1-quote-gold.md` lines 15–19, 27–55. |
| Older `voucher_pop` **22%** / voucher-POP **28%** vs R3 voucher **7.86%** and payment-proof **5.99%** | Older `voucher_pop` in a 1,788-row mail mix (window Sep 26–Oct 11); older 304/1,069 voucher/POP count; R3 separates overlapping voucher and actual-payment-proof flags in its weighted sample. | Do not compare extraction kinds, broad voucher mentions, agent vouchers, and verified payment proof as one class. Older sources: adoption-gap memory above; `/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/docs/plans/2026-10-08-007-feat-overnight-v8-nava-pane-plan.md` lines 4–10, 34, 41. |
| Party named **70–80%** vs **2.5%** in confirmation PDFs | Older quote/booking mail and selected quote-PDF notes do not establish comparable denominators; R2 examined 1,179 confirmation PDFs, where 30 had company/agency candidates. | Different documents and units, not a contradiction that can be resolved by selecting one. Older sources: `docs/plans/2026-10-13-003-quote-corpus-notes.md` lines 16–21 and Oct 8 plan above; R2 below. |
| Multi-stay quote shares **2.2%**, **4.8%**, **7–14%**, and **10%** | Respectively: R1 paired quote asks; older quote labels; planning forecast; selected quote-PDF anatomy. Cohorts/units differ. | Preserve as separate historical claims; do not create a trend line. Sources: R1 lines 27–55; quote corpus notes lines 16–21; `docs/plans/2026-10-07-003-conference-quote-sizing.md` lines 5–15. |
| Gold-set workflow mix | PRODUCT.md proposes a balanced ~30-row target (12 quote, 6 amend, 4 cancel, 3 create, 5 channel/system skip); currently 26 rows in ACTIVE.md. | Curated acceptance set, **not** population case mix. `PRODUCT.md` lines 55–61; `docs/context/ACTIVE.md` line 43. |

The older 1,788-row memory mix says `other` 53%, `voucher_pop` 22%, `spam` 11%, `amendment`/`quote`/`booking` 4% each, and `cancellation` 2%. The owner disputed its thread/message counting and OTA placement. Treat it as a dated extraction-label summary, not human action truth or a current population estimate. Source: `/home/orca/.claude/projects/-home-ubuntu-projects-zero/memory/project-nava-adoption-gap.md` lines 8–15 and `feedback-generalize-no-overfit.md` lines 8–10, 22–25.

R1's 313/5,204 quote-ask detector count (6.0%) paired 93 same-thread staff-output candidates and left 220 without such outbound in the bounded window. Pairing is a thread/time-window heuristic, not `In-Reply-To` proof; 18/93 had parseable nightly rates. R1 did not run a backtest or live quote call. It is a request/pairing research set, not a measured rate-accuracy score. Source: `docs/research/2026-10-13/r1-quote-gold.md` lines 15–19, 25–36, 157–163.

**Rule:** retain each estimate with its denominator, window, unit, exclusions, and label source. Do not elevate the older `under ~2% of mail` cutoff into owner policy; details are in §2.

## 2. Owner semantics and dated decisions

### Reservation and quote behavior

| Rule or decision | Evidence and scope |
|---|---|
| **Pre-stay self-mail is an existing stay, never a new booking.** Own hotel mailbox sending to itself, with a `Pre Stay … Confirmation No <conf>` subject, carries pre-arrival information for an existing booking; do not offer create. | Owner hard rule in `PRODUCT.md` lines 29–31, 98; recorded in `docs/context/OWNER-ASKS.md` and `docs/context/ACTIVE.md`. Generalize by own-mailbox + pre-stay subject + confirmation number, not a Centurion string match. |
| **OTA/channel automation is out of scope; human travel-agent work remains in scope.** | Front door skips OTA/channel/automated mail, while travel-agent mail stays in scope: `PRODUCT.md` lines 27–31. Owner's dated host-specific exclusions: Profitroom, Tiket.com, RateTiger, H-Pay; Travelit and TBO stay in scope: `PRODUCT.md` line 92 and `docs/context/OWNER-ASKS.md` line 92. |
| **A quote is not always the same meal plan.** BAR B&B is a convention; dinner is a hotel-specific add-on and request type matters. Company/agency appears in the quote/PDF field, not in the reply body; quote contact is a separate field. | `PRODUCT.md` lines 21, 38. Owner feedback on Oct 13 said “they do BAR Bed and Breakfast only surely that varies on the type of request right” and approved dinner as an add-on: `/home/orca/nava-research/reports/retro-20261014/w1-evening.md` lines 939–940. Corpus is mixed: 48 selected PDFs were reported 53% B&B / 44% DBB (`docs/plans/2026-10-13-003-quote-corpus-notes.md` lines 16–21), while a separate 255-thread analysis said no DBB rate was quoted (`w1-evening.md` lines 771–776). Do not generalize either cohort into a universal rule. |
| **Fully booked default reply is a one-line decline.** Alternatives may be shown in the pane only; staff must select “Use this” before an alternative goes into a reply. | Owner decision recorded in `PRODUCT.md` line 94. Earlier sample had 0/11 sold-out replies offering alternatives (`w1-evening.md` lines 772–774); the current decision supersedes that sample as product behavior. |
| **GDS/SynXis "RESERVATION FAILED TO INTEGRATE" mail is real staff work, not noise.** The booking (here GDS Amadeus via SynXis/RedX, with a travel-agent IATA, name, rate code and comments) did not sync cleanly into Infor. Staff must check that Infor holds the company/agency and the other details, and add what is missing. | Owner, 2026-10-14 ~22:05Z, relaying the Da Vinci call; the Da Vinci transcript L99–L124 describes the same check for imported bookings ("It doesn't just download the company name. I have to do it manually"). Corpus (`/home/orca/nava-research/corpus/2026-10-13`, Jul 30–Oct 13): **84** such mails (81 MODIFICATION, 3 CANCELLATION) out of 678 SynXis mails and 8,892 inbound; **84/84** name a travel agent. Today triage routes them to automated-channel (`mail-triage.ts:186`, `triage.ts` failedToIntegrate). Candidate workflow: read-only compare of mail vs Infor booking → list missing fields → staff approve the fill. Not scoped yet. |
| **Vouchers and payment proof are not interchangeable labels; the owner's view evolved.** | Earliest located owner statement is Oct 13 17:12:53Z: challenged the 313 “pop slash vouchers” count against booking/quote requests and asked how to distinguish them (session JSONL record 8478). At 18:13:25Z, owner said: “Those are both proof of payments and booking requests. Like are they both? I'm pretty sure they're both now” (record 8665). At 23:32:50Z the run-specific decision was “vouchers parked find-first later” (records 11476/11490). Source for these: `/home/orca/.claude/projects/-home-ubuntu-projects-zero--worktrees-centurion-dashboard-tools/da411a9d-374b-4c40-a6ac-78ebd27fa776.jsonl`; summary copies: `/home/orca/nava-research/reports/retro-20261014/w1-evening.md` lines 10–12, 682, 940. On Oct 14 21:13:32Z, owner refined the view: “Voucher slash payment is actually a new booking request, which has already been paid. So if we clarify those separately, then fine. But usually it's just like, hey, we've booked this. Can you please log it in for? So maybe we're classifying those wrong.” Source: `/home/orca/.claude/projects/-home-ubuntu-projects-zero--worktrees-centurion-dashboard-tools/6d18957a-9ec5-4051-ba67-6c0f093b983f.jsonl`, records 2614 and 2760. R3's 24/35 booking-request and 0/35 explicit-POP sample is consistent with the later distinction, but does not establish that each voucher is paid or entered into HMS. |
| **Voucher automation was parked, not removed from the roadmap.** | Oct 13 instruction “vouchers parked find-first later” in the source above. Current roadmap places voucher/payment-proof/billing after quote, create, amend, cancel (`PRODUCT.md` lines 17–25; `docs/context/ACTIVE.md` lines 18–20). R3 is not evidence that voucher work is permanently out of scope. |
| **The `~2%` cutoff is not an approved owner rule.** | On Oct 11, owner objected to about 14.6 task-hours spent on a multi-room/multi-stay case estimated at 0.2% of mail (“can't be doing that again”): `/home/orca/.claude/projects/-home-ubuntu-projects-zero/memory/feedback-generalize-no-overfit.md` lines 8–10; estimate also in `/home/orca/nava-research/reports/retro-20261014/w0-before.md` line 2871. “Under ~2% of mail means it is out of scope unless trivial” appears in that memory at line 23 as an operational rule, not a verbatim owner decision. Owner later disputed the underlying mix; no global 2% product cutoff is established. Scope changes require an explicit trade and owner approval: `PRODUCT.md` lines 84–86. |
| **Keep the familiar Outlook/webmail pane and mail/folder experience.** | Current state: `docs/context/ACTIVE.md` lines 18–24; owner correction says triage feeds existing folder/mail behavior, not a new inbox redesign (`docs/research/2026-10-14-product-assessment.md` lines 86–88). Reads may prepare in parallel; writes follow Prepare → Queue → Act → Review with human approval and review (`PRODUCT.md` lines 17–20). |

### Voucher field evidence: staff voice is not owner policy

A **Da Vinci reservations staff** interview on 2026-10-14 describes operational voucher work: staff attach vouchers, check that each booking/company details are present, and follow up with agents for prepayment when a same-day arrival has no voucher; when a voucher is present, they attach it and check overnight-hold coverage. Staff say agents send vouchers directly. Short verbatim excerpts (no guest/agency identifiers): “and then vouchers and all of that, and I attach them” (transcript L93, 05:21–05:23); “Or if we have a voucher, if it's attached and stuff” (L108–109, 06:02–06:10); “we get them directly from the agents themselves” (L126–128, 06:56–07:13). Source: `/home/orca/nava-research/davinci/2026-10-14-interview/extracted/interview-2026-10-14-handoff/transcript.txt`, lines 84–132. This is Da Vinci staff evidence, **not** Centurion workflow and **not** an owner quote. The interview says agent credit-card details are kept in a restricted shared folder for POPI reasons, not attached to the booking (L128–132); do not turn that into a generic instruction to handle card data.

**Profitroom vs Infor (Da Vinci staff, 2026-10-14 interview; staff evidence, not owner policy):** Profitroom bookings sometimes arrive only as a notification and have not downloaded into Infor; staff "go to Profit Room and push it", then hand-enter company names, because the download omits them (transcript L99–L105). Staff check every GDS booking for company, notes and an attached voucher (L106–L124). Asked whether payment is tracked in Profitroom or Infor, staff answered that it is tracked in Infor, because that is where the deposit due date lives (L435–L445). **Owner, 2026-10-14 ~21:40Z:** "vouchers can actually mean a few different things"; at Centurion, a travel-agent voucher with a receipt is sometimes a booking request. That matches R3 (24/35 also requested a booking). Open: Profitroom is an excluded host in `PRODUCT.md` line 92, so a Profitroom computer-use agent would be a scope change that needs owner approval.

## 3. Party, company, and agency lookup

The strongest prior matching evaluation is **R2 party truth**, a local snapshot of 1,179 confirmation PDFs. Only 30 contained a named company/agency candidate; just one of those 30 joined to an eligible earlier inbound. There were **zero verified private-guest/`none` negatives**. Exact, normalized-name, first-token, trigram-fuzzy, and combined strategies each scored 1/1 on the single paired positive; domain matching scored 0/1. The positive name was in a sender footer/signature, not the booking request. Thus all 100% figures are **n=1**, false-positive rate is unmeasured, and comparative strategy lift is not established. Source: `docs/research/2026-10-13/r2-party-truth.md` lines 5–18, 40–70, 74–85. Do not claim safe automatic company/agency binding from this evaluation; the report explicitly recommends keeping auto-bind off absent verified negatives (line 98).

The labels themselves are weak: explicit Agency fields appeared on 26/1,179 PDFs, non-property Account Name on 4/1,179, and total named candidates were 30/1,179 (2.5%). The four-letter Agency value may be a code; only three unique candidate names appeared. A populated account field is not necessarily the customer party. Source: R2 lines 40–57, 103.

Prior signals are distinct from matcher accuracy: selected quote-PDF notes report a party name on 70% of 48 PDFs; an older plan estimated 70–80% of quote/booking mail; a four-name index spot check passed, but the full sweep and real-browser party chip were not done. None measures false-positive safety. Sources: `docs/plans/2026-10-13-003-quote-corpus-notes.md` lines 16–21; `/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/docs/plans/2026-10-09-001-feat-one-hour-party-autobind-plan.md` lines 54–72.

`hms_company_account_read` reads an account already linked to a booking; it is **not arbitrary company search**. A gold workflow archive records demand/use (8 candidate inbounds, 47 staff replies), not correctness. Do not conflate it with party-lookup search. Sources: `archive/lab-scratch/docs/infor-hms/centurion-eval-lab-counts.md` lines 36–40, 53–55; `archive/lab-scratch/docs/superpowers/plans/handoff-reports/2026-09-21-centurion-eval-demand-gold-oracle-handoff.md` lines 28–37, 195–206.

Staff describe a manual lookup workflow: read the email, check availability/dates and party details in Infor, then prepare a reply or quote. Imported GDS/SynXis bookings may omit the company name, so staff add/check it manually, then review booking notes and voucher/payment conditions. Sources: `/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/bongi UI call transcript.md` lines 189–201, 345–357; `davinci kickoff.md` lines 601–609, 689–701; Da Vinci interview transcript lines 84–132. Keep the product's read/prepare step separate from an HMS write.

## 4. Quote and booking error evidence

| Prior evidence | What it establishes | What it does not establish |
|---|---|---|
| Older quote-corpus backtest: 126 gold threads; 70.6% deterministic pass, 34.9% good/acceptable. | Aggregate historical gate result. Source: `docs/plans/2026-10-13-003-quote-corpus-notes.md` lines 3, 36–37. | No class-by-class major-error counts; not current quote-rate accuracy. The source says no measured “98%” exists. |
| Archived quote HITL retro: 252 live quote rows, 15 source-absent PDFs; five stored-flag counters were zero. | The fill pipeline explicitly handled date parsing (month-first/ranges/formats), currency/rate parsing, meal-board/dinner wording, occupancy/pax inference, dinner-cap vs stay-amount, and room-code vs product/bed-word distinctions. Source: `archive/lab-scratch/docs/solutions/workflow-issues/quote-hitl-loop-retro.md` lines 40–57, 66–72. | No class-by-class error counts. A clear gate or zero flag counters can miss incorrect fills and labeled fields left blank. |
| R1 quote-gold research: 93 paired asks/outputs; 220 unpaired asks; 18/93 parseable nightly rates; 8 headcount-only pairs had no quantified single/shared mix. | A bounded pool for human adjudication and abstention/scorability decisions. Source: `docs/research/2026-10-13/r1-quote-gold.md` lines 7–19, 25–36, 157–163. | No backtest or live quote call was run. Not a price-accuracy score. |
| Aug 7 draft backtest: eight-row gold run and 500-inbound comparison; earlier echoing run had 0.35 invention rate, no-echo rerun 0. | Prior failure modes included invented facts, missing brackets, weak gold coverage, and soft similarity. Source: `docs/superpowers/plans/handoff-reports/2026-08-07-mastra-draft-backtest.md` lines 25–48. | Drafting experiment, not quote-rate accuracy or production error prevalence. |
| Critical-error rubric. | Separates material-fact failures and action/recipient safety failures, such as wrong guest/property, invented completion, unauthorized disclosure, or unproven attachments; critical errors are not averaged away. Source: `docs/superpowers/plans/2026-09-06-reservation-revenue-triage-drafting-plan.md` lines 398–413. | Rubric only, no historical error counts. |

**Settled evidence gap:** prior public research docs do **not** publish class-by-class counts of major quote/booking errors (for example, wrong party *n*, wrong dates *n*, wrong rate *n*). Use the categories above as a taxonomy, not as measured prevalence. Existing aggregate pass rates and gate counts are not substitutes for that missing breakdown.

## 6. Leftover worktree harvest (2026-10-14 ~21:45Z)

Source: `/home/orca/nava-research/reports/leftover-worktrees-20261014.md` (ADE). Each uncommitted tree was snapshotted to a pushed `park/*` branch (not for merge; a tree is safe to delete once its snapshot is on origin). Blob check: dirty files whose content appears in **no** commit.

| Tree | Content | Unique vs any commit | Decision |
|---|---|---|---|
| `extract-v2` | Extraction v2 fields `guest`, `specialRequests`, `externalRefs`, `requestedChange`, `mealAndPayer` (+235/−2, 4 files). `externalRefs` and `mealAndPayer` are not on main. | 4/4 | **Parked** `park/extract-v2-20261014`. Feeds "every ask covered" and meal-basis evidence; revive as a small PR after the quote pilot. |
| `d1-prestay` | `ownMailboxPreStayConfirmation()` (own mailbox + "Pre stay … confirmation no. N"), triage edits, tests (+361/−26). Main already has `isSelfSentPreStayInformationMail` (`existing-stay-information.ts`) plus an HRCEN-specific `isPreStayNotification`. | 10/10 | **Parked** `park/d1-prestay-20261014`. Its generic subject regex beats the HRCEN string on main, which matters for multi-hotel; revive with Da Vinci. |
| `w4-S` | Mid-rebase (REBASE_HEAD f898294e5) on `w4/u24-needs-you` (PR #134 merged). 66 files, mostly −7,047 lines = stale rollback state. | 5 (nava-pane.tsx, backend-bind.ts, work-items.ts, snapshot, test), all deletions | **Parked** `park/w4-S-20261014`. No new feature; L6/#246 is not overwriting real work. |
| `w4-UI` | `w4/u22-save-reply` (PR #139 merged). 76 files, −9,580 lines; unique: reply-body.tsx ("Draft option X only"), nava-pane.tsx, use-insert-ai-draft.ts. `completedDateOptions` already on main. | 3 | **Parked** `park/w4-UI-20261014`. Only the per-option draft button might be worth reviving. |
| `quote-mvp-live` | Plans 13-001/002/003, an `HMS_JOB_QUEUE` allowlist line in `write-ec2-remote-env.sh`, HTML fixtures. | yes | **Parked** `park/quote-mvp-live-20261014`. Plans are ingested below. |
| `p2-gate`, `w4-ae4diag` | 2 pane HTML fixtures; a 204-line diagnostic test. | trivial | **Parked** (`park/p2-gate-20261014`, `park/w4-ae4diag-20261014`). |

### Quote facts from `quote-mvp-live` plans (2026-10-12; verified against main 2026-10-14)

- **Gold wrapper** (5 lines): "Good day {name}," / "Thank you for Choosing The Centurion Hotel." / "Please see attached quotation." / sign-and-return + "no rooms are currently being held" / "Kind regards,". Main has it in `apps/mail/lib/quote-proposal/copy.ts`, used by `nava-pane.tsx`; #245 aligns the wording.
- **SKNG/EXKNG room-label bug: fixed on main.** `apps/mail/config/room-types.js` maps SKNG = Standard King and EXKNG = Executive King.
- **30-night cap is still on main** (`apps/server-pilot/src/hms/quote-stay-candidate.ts:10`). 5/48 gold PDFs were 18+ nights. Keep the cap with a clear refusal.
- **48 gold PDFs:** 1 line 69%, 2 lines 19%; B&B 53% / DBB 44%; Single 65%, Deluxe 11%, Twin 8%; groups (5+ qty) 25%; party named 70%.
- **Baseline:** 126-thread old-pipeline backtest, 70.6% deterministic pass / 34.9% good-or-acceptable. No measured 98% exists. The 11 generalisation test shapes in `2026-10-13-003` are the self-test checklist; do not invent a new audit.
- **Staff UI feedback** (`2026-10-13-002`): 29 asks + 10 pane rules (contact first, room rows by type with a totals row, one Find hidden after it runs, 30 s "still working" flag, no "Coming soon", no raw errors). This is the L6 checklist.

### Open PRs and branches not from tonight's lanes (do not duplicate)

| PR / branch | What | State |
|---|---|---|
| #189 `feat/needs-you-run-hms` | Read-only "Run HMS" chip on Needs-you rows (same 2 commits as `extract-v2` HEAD) | Open, conflicting |
| #218 `feat/golden-set` | Golden set of real past mail: select by staff evidence, merge HMS answers, score per class | Open, mergeable. **Reuse for evals; #244 must not fork it.** |
| #223 `docs/overnight-20261014` | Overnight results + lessons | Open, conflicting |
| #48 `feat/luna-v5-b` | Agency/company picker for contract rates | Draft, conflicting; superseded by P1 party v3 |
| #196 `fix/mail-typecheck-baseline` | Runnable apps/mail typecheck baseline | Open; input to the remote typecheck runner |
| `feat/action-classifier` (p2-classify, 3 commits, pushed, no PR) | One Luna-max classifier (needs action + action) with vision; eval writes per-message predictions | **Reuse for voucher reclassification**; do not build another classifier |
| `feat/luna-v4-a` (5), `draft/ae1-multiroom-property-pool` (#168 closed, 3), `w4/greptile-*` (#152/#157/#158 merged), `park/w4-P-u5-local-20261014` | All pushed to origin | Kept on origin; local trees deletable |

## 5. Using these facts

1. Reuse an existing source and its exact denominator/window before proposing a new study.
2. Re-analyze only when naming the prior artifact and the specific insufficiency, contradiction, or changed input.
3. Treat owner rules as product semantics; treat staff interviews, corpus snapshots, plans, and model/extractor labels according to their provenance and sample limits.
4. Refresh runtime, adoption, and authorization before operational decisions. Nothing in this historical reference authorizes a live flag change, HMS write, email send, or deployment.
