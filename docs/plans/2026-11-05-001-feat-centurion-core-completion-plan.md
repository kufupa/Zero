---
title: Finish Centurion core workflows — complete supported paths, fast staff ROI
date: 2026-11-05
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: owner-overnight-direction-and-verified-code
execution: code
scope: centurion-supported-core-completion
execution_status: supported-core-checkpoint-financial-handoff
---

# Finish Centurion core workflows

**Decision:** three builders plus one driving engineer, in isolated worktrees. First milestone is an editable, source-correct existing-profile Create that stages real email details and produces a verified Labtest reservation on deployed main. Voucher-prefill, selected-rate pricing and shared edit correctness are part of that milestone. Release ready workflows independently. Reuse deployed Filing; add only its demonstrated native-Prepare delta. Preserve Quote, Amend and Cancel; make costly unsupported exceptions explicit staff handoffs.

**Execution posture:** autonomous overnight, owner unavailable until approximately 06:30 UTC. Latest owner explicitly permits substantial effort savings for broad workflow coverage; this is permission for honest supported-path scope, not permission to claim an unmeasured 80% or 95% coverage figure. No more routine approval questions.

**Schedule:** the implementation budgets below are a conditional engineering forecast, not calibrated percentiles. Prior run started 22:12:09 UTC and paused around 00:35 (143 minutes); Filing readback finished at 00:37:11 (145 minutes). That time remains part of the total history. Remaining work has its own clock and includes voucher repair, verification and rework; neither paused time nor overlapping work is counted as active coding. Owner's 06:30 return is a delivery checkpoint, not proof that every native extension fits it.

## Goal capsule

Centurion staff select a real email, see the current stay and readable voucher facts, correct incomplete information, choose existing HMS identities and native rates, Prepare without Save, then approve Go and see a confirmed, partial or uncertain result. Both classic Outlook and webmail use the same pane. HMS is the system of record. Completing one ask must not silently discard another.

Example: “Please book our client; voucher attached.” The readable PDF, scanned PDF, PNG or JPEG supplies guest/dates/room/rate/agency. Guest and booker remain separate. Missing facts stay editable. Staff select the live guest profile and agency; HMS checks the chosen rate, then Go saves the supported stay once and fresh readback displays its confirmation. A second filing ask remains visible. An unreadable attachment, missing profile, ambiguous agency or unsupported financial action produces a specific staff correction/handoff, not an empty pane or invented success.

## Product contract

| ID | Required supported behavior | Explicit economical boundary |
|---|---|---|
| C1 | Correct current selection; staff can choose the workflow and per-stay action. | General current-message rules; no new classifier framework or domain-only exclusion. |
| C2 | An editable Create/Quote form opens when extraction is missing or incomplete. | Prepare/Go still require valid business fields. Do not fabricate dates, identities or child ages to mount a component. |
| C3 | Email and admitted voucher facts reach prefill with source identity and role; staff edits win. | Reuse existing PDF text and bounded vision; no new OCR service. Visual facts are model observations requiring staff review, not text-verified excerpts. |
| C4 | Existing guest profile, booker, agency and organization are separate; native IDs come from current lookup selections. | Missing profile: create in HMS and resume. A unique name/cache match is a suggestion; revalidate native identity, never remove the ID guard. |
| C5 | Rate typed code + searchable dropdown + code/meaning; initial selected-code read and explicit recheck; native price before Go. | Price the selected code; do not promise full native totals for every catalogue option. Native labels override mock/unverified meanings. Typed valid codes remain usable outside the static list. |
| C6 | Create exposes actual supported native business fields: dates, room, adults/ages, guest, agency/company, source, Track, guarantee, note, Booker and CMS. | Unsupported native clears/fields show a reason and handoff. Do not call Track/Booker/CMS unsupported merely from an obsolete tool version. |
| C7 | Quote produces the supported chosen offer, cover draft, PDF and Excel; no automatic sending. | Single chosen offer first; fully booked gives decline, alternatives only after staff choose. No new pooling engine. |
| C8 | Sequential 1–8-room Create reuses existing batch/receipt machinery; completed rooms cannot be recreated. | Prove one room first. Partial/unknown results remain visible; resume only confirmed unfinished work. Native groups/imports deferred. |
| C9 | Selected voucher/POP PDF + staff-selected existing stay → native Documents Prepare → Go → readback. | Reuse #1013. PNG/JPEG are readable Create evidence; native image filing/conversion is outside this release. No unconditional Filing rewrite or deletion. |
| C10 | Amend shows current/proposed supported fields, preserved edits and native repricing before Go. | Typed numeric rate overrides and unproved Retain branches are explicit handoffs; reuse native tools. |
| C11 | Cancel shows target/reason, then actual native status. Penalty warning/charge is visible and never silently accepted. | No new cashiering/refund implementation. Existing charge approval remains conditional on its real contract; unproved charge execution uses staff HMS handoff. A warning may appear after cancellation: reconcile status rather than claim nothing happened. No evidence supports “95% free.” |
| C12 | Undo/reset/redo and late native/model responses preserve current staff work. | Existing transient queue + WorkItem authority; no rewrite of the entire QuoteSession reducer. |
| C13 | Source/request/target/revision binding, one accepted dispatch, fresh readback, explicit partial/unknown recovery. | Never retry an uncertain Save blindly. No whole-native-form key/count pinning. |
| C14 | Genuine second asks survive first-action completion; eligible travel-agent mail remains in scope. | Keep visible pending work even if its optional automation is deferred. Existing pre-stay separateAsk already has an “Also needs attention”/Needs You handoff; retain it rather than enabling its original stay draft. Do not mark the entire email finished as a shortcut. |

## Global constraints

- Owner latest instructions, workspace AGENTS.md and PRODUCT.md govern. Model routing below overrides older skill defaults.
- No new tests. Run existing focused checks for touched seams; never local tsc/tsgo, repo-wide lint/format or ordinary GitHub Actions.
- Remote typecheck only via `/home/orca/bin/remote-typecheck.sh <clean-worktree> --app mail|server-pilot` on final head. Local Vitest/node tests unset DATABASE_URL, VITEST_ALLOW_PILOT_RDS and TEST_DATABASE_URL; at most three concurrent with resource headroom. Existing DB tests may be skipped and reported.
- Original dirty root, staged Create merge and all other sessions' work remain untouched. New worktrees own their files. No resets/stashes/force pushes/hook bypasses.
- One connected workflow per PR. Use fetched current-main merge-gate; the stale root gate has different requirements and must not be used.
- Native proof is backend real-email unsaved preparation, then one authorized deployed Labtest Save with fresh readback. No pane clicking campaign, numbered probe loop or live mail polling fixture.
- Real guests: no agent Save. Labtest: Proof Labtest, 2027+, CMS off. Current staff Go is required for real writes.

## Autonomous Execution Mandate

User authorized this final plan, implementation, appropriate review/PR/merge, clean-main bundle deploy, read-only real-email/native preparation, Labtest writes and existing HRCEN flag promotion after proof. Continue through errors without routine questions. Choose the smallest safe route to supported workflow completion; preserve scope and report explicit handoffs. REQUIRED SUB-SKILLS: overnight-autonomous-execution, overnight-autonomous-zero and nava-run, with owner/AGENTS overrides above.

Infrastructure: EC2 `i-008f737974a9ba9b3`, region `af-south-1`; repo `/home/ubuntu/repos/zero`; deploy via checkout's `apps/server-pilot/deploy/ops-deploy.sh`; restart `ops-restart.sh`; flags `write-ec2-remote-env.sh --m1-only`, then verify `http`, `worker`, `ai-worker`, `remote-http`. RDS is `nava-zero-mail-pilot` and never a test target. No destructive DB/volume operations, credential disclosure, external sends or cleanup.

RCA loop: reproduce minimally → identify mechanism/file → smallest correction → covering existing check → review/land → fresh deployed proof where behavior changed. Build/test/deploy failures do not finish a unit. Missing human-only access or an external outage genuinely preventing required proof is a blocker; keep independent work moving. Do not invent new login/credentials or weaken source/duplicate/approval guards.

Only write CANARY PASS <workflow> HRCEN <deployed-sha> after that workflow's real unsaved preparation and Labtest Save/readback pass. Reuse recorded proof only when the deployed implementation/contract is unchanged; do not carry old-head checks across product changes. No new process documents, ledgers or handoff files mid-run: one `/tmp/nava-core-20261105.state` checkpoint and git artifacts suffice. Final report includes deployed SHA, exact usable paths, proof, limits, outstanding work and actual elapsed time. API billing is not exposed here; do not invent dollar spend.

## Planning contract: what the adversarial review got right and wrong

Review provenance: `agy --conversation=040e71cd-3d46-43e2-9919-a57a28594283`, local transcript under `/home/orca/.gemini/antigravity-cli/brain/040e71cd-3d46-43e2-9919-a57a28594283/.system_generated/logs/`. Its edited three-lane plan is superseded in this same file. Review claims are evidence leads, not authority.

| Review claim | Verified decision / strongest counter-evidence |
|---|---|
| Filing is finished, cut every remaining change. | #1013/6e6c14e is deployed and passed one upload + Documents metadata readback, 00:37:11. That proves useful filing, not stored-byte equivalence or native unsaved Prepare. Branch0e21a710 adds a specific native Prepare contract. Reuse it only after C9 delta review; don't spend an unconditional45m, don't silently remove required Prepare. |
| Create is hidden by admission gate. | Correct: workstation unquoted bootstrap requires arrival/room/adults/ages before draft; pane/host cannot mount partial draft. Fix early. It is part of connected field/state work, not merely CSS. |
| Agency is a fatal blocker, put it early. | Correct for the observed real Prepare: guest matched, agency0/0 → agency_unverified. Existing picker lacks useful Create search binding. Add current live pick and explicit unresolved state early, in parallel with form work. Do not auto-trust names or bypass native IDs. |
| Batch61 rates freezes HMS; one check always3–5s. | Specific runtime count/latency unverified. Reader pages50/caps1000 and already filters typed codes. Some options intentionally lack native totals. Use existing single-selected-code seam and native Create/Amend Prepare for final prices. No universal latency promise; show progress/unknowns. |
| Add NGOVDB/BOTAB with fixed government/OTA meanings. | Fetched-main catalogue is `src/hms/rate-catalogue.ts`; stale-root source also has an older `src/ai/rate-catalogue.ts`. It documents mock/unverified labels. Preserve observed codes, fetch native meaning/eligibility. A code description is not contract entitlement. |
| Native tool rejects Track/Booker/CMS; only NGI. | False on origin/main2e408c37: conditional validation allows supported Track and real-authorized CMS; native staging fills Booker/Track/CMS. CREATE_GUARANTEES has10 codes. Pane mapper supplies those fields. Source capability still needs connected deployed proof; Labtest CMS remains off. |
| 462 Filing emails are the largest ROI. | 372voucher+90proof are overlapping tags:3 co-tagged →459unique/1361=33.7%, not462 unique. Four booking+document co-tags are visible but classifier labels do not measure lifecycle reuse. Booking204/1361=15.0% is a coverage signal. Frequency is not saved clicks/minutes; Create takes priority from owner needs and incomplete native workflow. |
| “95% cancellations free”, defer penalties. | No fee-incidence denominator. Older4/4fake cancellations saw possible-penalty warnings; warnings don't prove charges. Defer new cashiering for effort, preserve warning/status reconciliation and visible handoff. Never claim95% or stop as if Cancel cannot already have happened. |
| 1654 ledger rows calibrate new3.5–4.5h. | Ledger audit:1663 rows/883 IDs; only104 raw rows have numeric actual+start/end across all kinds. Deduplicated comparable categories have150 numeric tasks,79 exact-boundary tasks. Scope varies enormously; global medians are context, not calibrated ETA. |
| New ETA hides previous2h23. | Prior state gives22:12:09 start and143m pause, so previous elapsed is real. A clearly labelled remaining estimate is legitimate; show both rather than erase history. Review's own narrowed forecasts vary3.5–4.5 vs4–6.5 vs3h45 and omit voucher/second asks/Prepare. |
|14shared files means everyone must wait for coordinator. | Avoidable ownership bottleneck, not a necessary dependency. A owns Create hooks/router/Nava/projection; R owns extraction+release. B and C start disjoint work immediately. Shared requested changes have a named owner; no global schema-PR barrier. |
|20tests fail only because Paraglide. | Failure count and cause require exact logs/head. Missing generated modules do not prove20 product failures or that all are solved by compile. Remote checker already compiles Paraglide. Generate locally only for focused mail checks and fix actual remaining regressions. |
| pane-create-source-loader.ts does not exist. | False: pane-create-source-loader.ts exists on fetched main and candidate (4667bytes), and preview/Cancel import it. Reuse it; no loader-creation task. Likewise guessed labtest-create/cancel-dispatch scripts are absent; use installed business services. |
| Defer all multi-ask completion. | Retain current pre-stay separateAsk handoff and safe existing-stay exclusion. Reject silent loss for other genuine asks; verify current completion by request/action. Do not restore the whole original pre-stay draft or invent a generalized autonomous planner. |

### Evidence pinned at start

- Dirty root main6bb282ae is stale; fetched origin/main2e408c37e1e2f225409c283d8ed1d39fde6b44f2.
- Last inspected deployed6e6c14e441548bf58c6f8f15375c9e0cb7cd5890: Amend/rates/Filing proved; merged Cancel2e408c37 not yet deployed/proved. Do not infer effective flags until fresh runtime check.
- Create PR#1014 head751064cc4ad1af83e6fb9e0334920bdd630b95bb, original staged merge with38files, no unresolved paths. Its actual delta vs fetched main is32files/2457added451deleted, much already-built behavior. That is inherited work, not an estimate of new coding.
- New Create copy excludes extraction/schema and ContextualRateCheck (separate owners);29candidate paths preserved. Root voucher branch carries candidate's additive proposal schema; B carries candidate rate component. Original worktrees untouched.
- Filing Prepare branch0e21a710510b65fe6efb305423eaaf459f2506c5, based on2e408c37,18files. Review exact product delta before reuse; tests already on that branch are existing work, not permission for new tests.
- Corpus `docs/research/halloween/corpus-analysis/2026-11-02-centurion-corpus-run.md:5–47`, saved metrics-final-v30.json/labeled-final-v30.jsonl and aggregation script. Tags overlap; retrospective later-reply context means it is not a leak-free current triage evaluation.
- Native `tooling/hms-cloud/create-reservation.mjs:26–117,446–576`, cloud-create-policy.mjs:3; Create mapper pane-create-cloud-input.ts:44–165. Quote/native rates hms-cloud-availability-reader.ts:413–435, rate-options.ts:227–272; context/source contract hms-availability.ts.
- Voucher defect extraction/extract.ts:682 passes body-only currentMessageText while prompt includes attachment text and images; schema.ts:425–456 only grounds proposal excerpts against that body. Existing vision already admits PNG/JPEG and first3PDF pages. The new repair belongs in scope.

## Implementation architecture

### Reuse and authority

Keep existing V1 components/visual primitives, fields, steppers, party widgets, native tools, approval grants, dispatch claims and receipts. Recompose explicit workflow forms around WorkItem effective projection and the existing transient edit queue. QuoteSession remains presentation/output compatibility, not a competing execution draft. Do not rewrite its2619line reducer, add a new universal store/executor, or build pricing rules.

```text
select current email
  load WorkItem + current extraction + attachment read/provenance
  project each actual stay/request
  mount workflow form immediately (unknown fields visible)
  value = explicit staff own-property edit
       ?? source-attributed current proposal
       ?? exact native baseline (saved-stay workflows)
       ?? supported default
       ?? missing
  // Own-property lookup preserves false,0,null,[]; “??” above is conceptual.
  on edit: keep display text, enqueue valid business value, bump generation
  Prepare: flush queue, validate required fields + native identities
           call existing workflow route/native unsaved Prepare
           display native business fields/price or actionable refusal
  Go: current source/request/target/revision/intent only
      dispatch existing Save once, fresh readback
      receipt = confirmed | partial | unknown | refused
```

Late extraction, rate, lookup, preview or Quote responses must carry the source/request/context and generation that started them. Reject stale results. Price-changing dates/room/occupancy/rate/agency changes invalidate native prices; unrelated edits still invalidate approval. Fresh native Prepare is final authority.

### Voucher repair algorithm (W13)

```text
sources = current message body + current subject
for selected attachment:
  admit only text actually included by prompt budget
  or pages actually sent as model images
  record attachment ID + deterministic content/page digest
  keep unread/truncated/admission reason
prompt proposal field = value + role + source pointer + excerpt
sanitize field:
  message source: exact excerpt in current text
  attachment text: pointer resolves admitted current file; exact excerpt
  attachment vision: pointer resolves admitted file/page;
                     bounded clean value; mark model-observed/review-required
  discard unknown pointers, historical-only or mixed/contradictory evidence
  never invent native profile/party ID or verified visual transcription
project accepted value + source/role/review cue into existing draft
staff edit remains authoritative
```

No concatenating all history into currentMessageText to bypass grounding. No model-generated hash is trusted. Text-limited/vision-skipped sources remain visible for manual correction. Maintain model-schema compatibility for existing body-only proposals; adding optional source metadata must not break older saved WorkItems.

### Parallel owners and true dependencies

| Lane | Files/seams exclusively owned | Initial order | Dependency before final proof |
|---|---|---|---|
| A — Create/Quote | booking-card, quote-booking-host, party-picker/people/output components; nava-pane, workstation; use-work-item/use-request-work-item/use-amend-work-item; work-item-effective/fields/items; shared quote-workflow route; pane-create-cloud-input/preview/source services | Preserve candidate → own-cursor/Quote freshness → form admission + live party binding → one-room Prepare/Create → Quote → batch continuation | B selected-rate component/API contract; R additive extraction/provenance; final combined checks. UI starts immediately. |
| B — Rates | contextual-rate-check, rate catalogue/options/native availability reader and rate hooks | Selected-code request, native labels, background read, stale-key handling; support Create/Quote/Amend | Shared route change requested from A; no concurrent router edit. |
| C — Saved workflows/Filing | amend-lookup-panel, saved stay editors, amend/cancel clients/native services; voucher/POP components/source/Prepare/native uploader seams | Amend/Cancel edit/result correctness; current Filing acceptance delta; prepare real inputs | A applies small shared action/projection correction when requested; deploy/native write window serialized by R. |
| R — Driving engineer | extraction/schema/extract, triage.ts and attachment admission/provenance; integration/review/release/runtime flags | Voucher repair early; audit findings → same-file final plan; ready PR releases and proof coordination | Voucher-based Create final proof waits W13, not all other coding. |

Worktrees: `/home/ubuntu/projects/zero/.worktrees/core-{create,rates,saved-workflows,voucher-prefill}-20261105`. Each builder keeps workflow accountability through review/proof, not just component output. No two writers on the same file. After B/C finish, explicitly transfer a disjoint critical-path task or use them for independent review/native readback; no fifth simultaneous worker. All deploys have one owner; independent reads/unsaved sessions can overlap when property/browser locks permit. Same-confirmation/Labtest writes serialize. Coding does not wait for all predecessors' PRs to merge; only actual incompatible consumer proof waits. Batch ready compatible changes to reduce repeat deployments, without holding first useful workflow for optional extensions.

### Model routing

User-selected ladder, not inherited Gemini/skill defaults:

- Reading/research/first independent review: GPT-6 Luna xhigh.
- Bounded mechanical/well-scoped corrections: GPT-6.1 Terra medium.
- Main Create/UI/state work and driving workers: GPT-6.1 Terra xhigh.
- Hard native/binding/concurrency feature: GPT-6.1 Sol high.
- Escalation after an explained failed approach: GPT-6.1 Sol xhigh.
- Current primary remains the user's selected Sol6.1xhigh session; cannot change its model by merely saying so. Research workers explicitly use Luna xhigh; implementation worker model is explicit, never “inherit.” Native product model/triage routing is unchanged unless a demonstrated product defect requires it.

## Work units (deep execution packets)

Times are remaining active-lane budgets including focused local checks; W11/W12 are additional combined/release gates. Product-line ranges are changed lines, not LOC/min estimates; inherited candidate lines are separate. No new test lines. Completeness below means packet acceptance, not universal HMS parity.

| Unit | Owner / model | Remaining budget | New product delta | Outcome / dependencies |
|---|---|---:|---:|---|
| W1 candidate integration | A / Terra xhigh |20–35m|0–60| Candidate preserved/copied; actual build/import issues fixed; no blind commit of another session's38 staged files. |
| W2 undo/reset | A / Terra medium within lane |10–20m|10–35| Adopt mutation's returned own cursor before refresh; distinguish other actor/revision; flush/invalidate previews. |
| W3 Quote freshness | A / Terra xhigh |10–25m|15–50| Verify actual Quote search/readback freshness at its producer/apply seam; fix only an observed missing source/request/revision/generation guard. Do not mislabel it as cached-rate handling in use-request-work-item. |
| W4 Filing acceptance delta | C / Sol high if native gap |0–20m audit;25–45m only needed delta|0–190| Retain deployed upload; reuse0e21 native Prepare if C9 requires it. No rewrite. |
| W5 selected native rates | B / Terra xhigh |25–55m|70–180| Single selected code + native meaning/price; automatic bounded read; explicit recheck; source/context stale guards. |
| W6 editable Create form | A / Terra xhigh |40–70m|90–220| Partial draft mounts; per-room valid input; actual supported fields; live guest/party selections; Prepare validation remains. |
| W7 Quote output connection | A / Terra xhigh |15–30m|20–70| Chosen native offer into cover/PDF/Excel, unsent draft; no company in body; no implicit alternative. |
| W8 batch continuation | A / Terra xhigh |10–25m|20–70| Reuse sequential1–8rooms; one-room proof first; per-room durable receipts; don't recreate confirmed rooms. |
| W9 Amend/Cancel closure | C / Terra xhigh, Sol high native |25–50m|45–140| Staff fields override late native reads; native repricing; cancel reason/status/penalty visible; unproved financial handoff honest. |
| W10 native party binding | A / Terra xhigh |15–30m|30–100| Current live agency/company search and numeric ID selection; no/ambiguous results show actionable picker; real Prepare before cosmetic polishing. |
| W11 combined final-head checks/review | R + spare reviewer / Luna xhigh → Sol high |15–30m|0| Required remote typechecks/apps + focused existing checks + Apex/fallback on exact final head; validP0/P1 fixed. |
| W12 release/native proof/promotion | R + workflow owner |55–105m|0–25config| Clean fetched-main deploy(s), real unsaved stage, one Labtest write per changed workflow + fresh readback, flags and both-pane loaded path. |
| W13 voucher → prefill | R / Sol6.1xhigh; bounded help Terra medium |35–70m|90–180| Admitted text/visual source pointers + deterministic digest; sanitizer/current-fact projection; four supported reading formats; staff precedence. Additional scope omitted by review. |
| W14 frontdoor/remaining asks | A shared state; R extraction; C receipt seams |15–35m|20–85| Generic travel-agent/automated distinction, pre-stay existing confirmation, retain independent current asks; first completion does not clear them. |

### Packet acceptance and cheapest failure checks

**W1–W3, C2/C12/C13.** Inputs: candidate's current WorkItem source/request IDs and own mutation replies. Patterns: existing WorkItem queue/history mutation, not new reducer/store. Read own-cursor mutation response and update refs synchronously; verify late refresh cannot label own success as “changed elsewhere.” Quote request captures identity/revision/generation before await and checks after; field edits/source switch invalidate its approval. Existing focused suites: work-item-events, booking-card, nava-pane-render; generate Paraglide only if import failure actually demands it. Foreign actor/source change must still reject. Final-head mail/server typecheck after producer/consumer pieces combined.

**W6/W10, C2/C4/C6.** Native party ID requirement remains. Reuse current party search/evidence/selection machinery. Do not infer guest from sender. No match shows query input and “choose/create in HMS then retry”; ambiguous results require selection. Required guest/profile/room/rate/dates/ages validated at Prepare, not mount. Preserve defaults only where native workflow supports them; CMS defaulton with message/recipient editable for real approved stays, forcedoff fake proofs. Test existing booking-card/pane-create-cloud-input/pane-cloud-preview suites; actual real-email stage is the decisive integration proof. First one-room proof unblocks first milestone; continue other UI while proof runs.

**W5, C5/C10.** Existing reader's typedRatePlan path is the starting point; static catalogue only seeds options. Never clamp away a valid typed native code. Bind response to selected source, stay/request, parties, dates/occupancy, revision and generation. Initial automatic lookup uses extracted selected code once facts/parties are adequate; no61-code prerequisite. Native availability listing may lack taxes/native totals: show that honestly and use workflow's native Prepare/Check Availability for authoritative total. No fabricated NGOVDB/BOTAB label or entitlement. Existing hms-availability,rate-options,rate candidates suites and native unsaved actual code/room test. Don't promise3–5s; show meaningful progress over30s.

**W13, C3/C12.** Existing extraction model and bounded image renderer stay. Text includes only the current admitted attachment excerpt, with unique ID even duplicate filename. Visual sources record actual included page indices and source/page digests; model source pointer must resolve to those inputs. Source text sanitization remains exact; visual proposals are explicitly observed and review-required. Reject missing/foreign attachment IDs, unsent pages, card-containing values and stale selection. Current staff edits and explicitfalse/null/[] survive reread. Existing extraction-schema,action-classifier-extraction,inbound-extraction checks. Proof input: body only “voucher attached” plus readable PDF, then admitted scan/PNG/JPEG examples through real extraction/projection; trace fields to final Create Prepare without a Save. If source is unread/truncated, form remains usable with manual entry. Do not manufacture exact text verification for image captions.

**W4, C9/C13.** Audit deployed behavior first: target editor/search, chosen attachment, downloaded byte digest, Prepare/Go/receipt. Compare native Prepare branch's exact business-field source/target checks and reuse smallest connected delta. No upload occurs during Prepare. After Go verify Documents listing/type/filename and source binding; if stored-byte download isn't supported, record that limit rather than claim equivalence. Existing pane-filing-preview,pane-filing-source-lock,voucher-filing-linked-source,voucher-find-card suites and native existing checks. New proof required if Prepare/commit contract changes; old upload/readback avoids a redundant proof only for unchanged installed path.

**W9, C10/C11/C13.** Amend current/proposed source and native baseline remain distinct; Preserve stafffalse/clears, reprice exact supported changes; CMSoff Labtest. Cancel real confirmation/source/reason same target. If warning after native interaction, fresh status precedes claims/retry. Do not implement cashiering just for coverage aesthetics; preserve existing approval/handoff semantics and disable any unproved charge path with clear staff instructions if necessary. No invented “free95%.” Existing amend-find-panel,amend-cancel,pane-cloud-cancel,pane-stay-cancel and native cancellation tests. Labtest target re-read for eligibility immediately before action; don't blindly use1618525656-1 since other prior proofs altered that stay.

**W14, C1/C14.** R owns triage.ts; trace domain/body classifier and extraction/current source separately. Travel agents are not automatically human nor automatically OTA; distinguish notices from actual instructions generically. Pre-stay ownmail+confirmation never creates a new stay. Its separate current ask already survives as safe staff handoff; do not enable the original pre-stay write draft. Completion receipts clear only their request/action; any remaining filing/other action keeps mail pending. Existing owner-action-query,workflow-folders,action-classifier-extraction/existing-stay-information tests. No new classifier rewrite or bulk historical rerun.

**W11/W12.** Check only changed apps/seams. PR final-head Apex/fallback review and exact-head checks must be recorded; resolve validP0/P1. Merge through fetched current-main scripts/orch/merge-gate.sh, then new clean worktree at fetched origin/main. Bundle deploy wrappers and runtime read-only SHA/health/effectiveenv checks. No guessed scripts; use installed backend business services and native modules. For each changed write path: actual real email facts unsaved, then one ProofLabtest Save+freshindependent readback on deployed head, CMSoff. Don't seed by globally polling/ingestOnce, don't run tests against RDS. Native uncertainty reconciled before another action. Promote only proved HRCEN flags; HRDAV remains unchanged.

## ETA reconstruction and priority

Recent closest comparables from earlier research: bounded UI/source fix14m14s; FilingUI14.7m; Create connected candidate22m34s; guard fixes3.7–8.8m; broad multi-form candidate92.8m across22commits; PR open→merge12–34m includes fixes; bundle deploy6–9m. These aren't standalone universal rates and already-built candidate effort is not charged again. Readback/native loop comparables include35–45m rework cycles; multiple proofs/resource locks can dominate the tail. Global ledger medians are not appropriate substitutes for matching work boundaries.

A's serial budgets W1+W2+W3+W6+W7+W8+W10 =120–235m. B25–55m; C25–70m before conditional Filing delta; R voucher35–70m plus its share of frontdoor. Shared W14 can add15–35m to the owning lane. W11+W12 adds70–135m that hasn't already overlapped coding. Reserve35–90m for a demonstrated native/integration repair/redeploy, rather than pretend15m covers every workflow. Approximate longest-lane remaining envelope225–495m (~4–8h), with lower-end delivery requiring reuse and clean native results. This is a conditional planning envelope, not a statistically calibrated completion ETA. A missing native contract can still move completion outside it.

The first useful milestone omits optional quote expansion/batch continuation from its critical chain: editable/source-correct single Create + native price + deployed Save/readback + enabled flag. Focus the early release on this and independent ready Amend/Cancel/Filing. Full supported-scope closure follows as capacity allows; owner receives a significant verified checkpoint at06:30 even if a remaining native extension is blocked. No false claim that every parallel lane has “zero wall time”: shared route changes, review, deployment and write locks are real dependencies.

Historical ledger context: latest audit1663rows/883IDs,150deduplicated numeric tasks in UI/server/deploy/liveHMS,79exact-boundary. Numeric medians UI38m/server38.5m/deploy7.5m/live11.5m versus exact-boundary51.5/79/6/38.5; cohorts have massive outliers and mixed scopes. No P50/P80 claimed. Timing receipts for Nov4 start/pause/merge/proofs come from `/tmp/nava-pane-run-20261104.state` and the paused parent's final turn, not aggregate polling time.

## Verification contract and definition of done

A supported workflow is delivered only when:

1. Required fields are visible/editable on shared pane; invalid/missing values block Prepare with specific correction, not form visibility.
2. Current real-email/native unsaved preparation checks relevant business fields and price; no real guest Save.
3. Exact deployed-main Labtest action has one accepted Save and fresh result readback; unknown or partial is not success.
4. Its HRCEN flag ison in all4PM2 processes after matching canary; runtime SHA and health verified.
5. Staff can use the shared pane path and see result/handoff; browser unavailable is a stated verification gap, not assumed pass.
6. Current own edits/source/action and any remaining ask stay correct after completion/reread.

Quote has no HMS Save: chosen native offer, supported artifacts/cover draft and shared-pane use are its gates. Triage has no fake Save: current-rule/source/per-ask checks are its gates. Reading PNG/JPEG does not imply native image upload. New Profile, numeric rate override, refunds/cashiering, nativegroups/XLSXimports and newOCR are explicit deferred capabilities. No10/10 universal HMS completeness rating.

Final review asks: independently trace selected voucher→sanitizedproposal→effectivefield→editableCreate→nativeparty+chosenrate→Prepare→Go→freshreceipt at exact deployed head. Challenge stale state, missing fields, wrong role/ID, partial rooms and dropped second ask. Compare any proposed removed guard to its replacement; review scope and ETA separately. Report source/test/runtime/deployed evidence distinctly and do not request another confirmation for already authorized overnight work.

## Execution checkpoint — Nov 5, approximately 08:00 UTC

Owner now permits further downscope; stop feature expansion/research after this checkpoint. Current main/runtime `20e17dd0137e8791e76c06bd5fb16fdbd9cfbd20`.

| Acceptance | Actual result |
|---|---|
| Existing-profile one-room Create | PASS on deployed `7b4360cb`: one Save, confirmation `2096664849-1`, native stay `40505`, Proof Labtest guest `46924`, Jan 4–5/2027, STWN/BAR, R2,280. Independent native business-field readback and booked receipt matched. |
| Original-source PDF Filing | PASS on `7b4360cb`: original 1,503-byte voucher uploaded to same stay; exact native Documents listing and handled marker verified; booked receipt preserved. Native stored bytes unverified. |
| Amend/Reprice | PASS on `7b4360cb`: one Save to Jan 4–6, R4,560 total; independent readback preserved note/Booker/CMS off. |
| Cancel | FINANCIALLY PARTIAL on `20e17dd`: one Go actually cancelled this Labtest stay; fresh readback matched. Post-Save R4,560 penalty warning was NOT approved. `UNKNOWN/needsCheck`, expired/pending challenge and target hold retained; fee posting unproved. Not free-Cancel PASS. |
| Quote | Chosen native offer, PDF/Excel contents and unsent cover proved. Actual Outlook/webmail draft insertion remains unproved. |
| Shared UI/source/state | Field wiring, current source, own-revision undo/reset, stale results, party/rate controls, failed-read manual Create and per-room date guard deployed. Staff-PC acceptance still needed. |
| Extractor | Attachment provenance repair deployed; genuine failed-read retry works. One-line absent/null question-list normalization deployed; business facts/guards unchanged. Model role/accuracy issues remain. |
| Runtime | All four actual process SHAs/flags, published entries/TLS and VPN verified. Readiness recheck passed at 07:44:54 on original restart window with no waiver; this precedes later Cancel business-handoff dead letter. No post-Cancel readiness pass claimed. |

Intervening `7b4360cb`→`20e17dd` product change is extraction question-list normalization; two other files are existing test fixtures. Native write code unchanged. Do not relabel old proofs as fresh current-head actions.

The 4–8h forecast was conditional; W6 did not price failed-read source authority deeply enough. Actual failures exposed blank-form admission, room/header date mismatch and required model bookkeeping. Full supported scope also remains narrower than initial C2/C8/C14 contract: manual Quote/missing-read authority, fresh multi-room proof and general multi-ask completion are not universal passes.

Next product work: one representative staff walkthrough of deployed pane; correct only observed blockers. Keep source/native rate/party choices explicit, especially unmatched agencies and vouchers without rate codes. Financial review/partial Cancel outcomes are a separate boundary. Continue deferring new profiles, cashiering/refunds, native groups/imports, pooling, numeric overrides/Retain and image filing. No new autonomous native action or Save retry is queued; all sessions closed.

Owner-requested self-contained evidence handoff updated at `docs/research/2026-11-04-why-core-workflows-still-unfinished-handoff.md`; historical month audit and Nov 5 outcomes/ETA/limits embedded there.
