---
title: Nava pane, prefill and rate parity research
date: 2026-11-04
type: research
source_sha: 9d388ab7510eb86d613d316b42fb42479cdc85b9
---

# Nava pane, prefill and rate parity research

**The deterministic reservation tools exist. The remaining product work connects the right inbound request to a complete editable form, useful native rate choices, staff approval and a visible verified result.**

This report supports the [implementation plan](../plans/2026-11-04-002-feat-nava-pane-prefill-rate-parity-plan.md).
The owner requests faster delivery, Amend first, a Create/Quote UI overhaul, rate codes plus numeric price overrides, and a separate guest-profile tranche.
Infor HMS and Mastra are the intended names in the voice transcript.

## 1. Evidence and current baseline

| Evidence | What it establishes | Limit |
|---|---|---|
| Current source and remote main, SHA `9d388ab751` | Active code contracts and exact implementation seams; remote main was rechecked during this research | Source capability does not prove staff interaction |
| [4.5-hour retro](2026-11-04-big-fat-4-hour-chat-retro.md) | Recorded delivery, native failures, canaries, review timing and source-proof limits | Its final runtime observations are historical, not a fresh staff-host test |
| [Product contract](../../PRODUCT.md) and owner's latest request | Staff Go, real HMS Save and fresh readback; initial existing-profile scope | Latest request expands the earlier UI/rate scope |
| Halloween [field audit](halloween/2026-11-01-hms-field-scope-audit.md), [source cohort](halloween/memory-experiments/2026-10-30-source-cohort-and-cloud-tool-design.md), [corpus run](halloween/corpus-analysis/2026-11-02-centurion-corpus-run.md) | Observed business fields and frequency; useful prioritisation | Different cohorts and later snapshots are not live accuracy or negotiated-rate authority |

The root checkout is behind main and contains other sessions' edits.
Product code was inspected in a clean current-main checkout; this report does not change existing work.
Open PR metadata was checked without an age cutoff, including drafts.
Relevant older open PRs are [#1000](https://github.com/kufupa/Zero/pull/1000) (Create pricing), [#987](https://github.com/kufupa/Zero/pull/987) (Amend) and [#968](https://github.com/kufupa/Zero/pull/968) (additional Create fields).
Their clean worktrees are on their PR heads, dated 3–4 November.
They overlap current work, but their presence does not make their contents shipped or justify merging an old branch wholesale.
Compare only the remaining delta against current main before reuse.

## 2. Built, observed and missing

| Workflow | Built now | Observed proof | Remaining gap |
|---|---|---|---|
| Quote | Deterministic Hotel Availability read, native party lookup, room/rate/board choices, Quote amount override and document preparation | Recent 3-Nov selected-email output returned usable rates; no overnight Quote-specific staff-host proof | Selection, prefill and rate UI coherence; current eligibility/price must remain separate from suggestions |
| Create | Existing-profile native Prepare, Check Availability, staff Go, Save and readback | Labtest CMS-off Save/readback on an earlier deployed SHA | Actual new-booking source journey and final-head integrated proof; incomplete form defaults and exposed unsupported fields |
| Amend | Source-bound current stay, dates/room/rate/occupancy/contact/CMS edits, native reprice, staff Go and readback | Final-head Labtest persistence was reconciled; real-source Prepare succeeded | Real example was already applied, rather than a fresh pending request; clearer requested-change UI; numeric nightly override absent |
| Cancel | Native reasons, one-shot cancellation, separate fee decision and readback | Labtest cancellation persisted; ZAR 5,660 fee prompt was left unaccepted | Pending real-cancel source journey and fee-acceptance branch untested; some evidence/review controls can be hidden |
| PDF Filing | Selected email/PDF binding, editable target lookup, native upload and Documents reconciliation | Labtest metadata readback; real voucher preview READY | No claim of PDF-byte readback or real upload; preserve selected-source and uncertain-result recovery |
| New guest profile | Existing profile search/select | Current read-only exact-ID search found the expected profile | Native master-profile Save and readback not built/proven; next tranche |

The active Quote dispatch still uses the proven [fetch-quote.mjs](../../apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs) through [reservationist-evaluation-composition.ts](../../apps/server-pilot/src/ai/reservationist-evaluation-composition.ts).
The folder name does not make it obsolete; its current code was updated recently.
October 15 queue delays do not describe today's Quote performance.

## 3. Why a visible email can leave the pane empty

[mail-list.tsx](../../apps/mail/components/mail/mail-list.tsx) opens a thread and clears `sourceMessageId`.
[thread-display.tsx](../../apps/mail/components/mail/thread-display.tsx) automatically selects a sole inbound; multiple inbound messages need an exact choice.
[web-pane-panel.tsx](../../apps/mail/components/nava-pane/web-pane-panel.tsx) waits for that selection before rendering the action pane.
Seeing the thread body does not establish that the pane has a selected canonical inbound.
This explains a possible mechanism for the reported empty pane, not the proven cause of that specific row.

The normal webmail route and `/nava-preview` share the same panel and `preview` prop.
The [preview page](../../apps/mail/app/%28routes%29/nava-preview/page.tsx) claims nothing is written to HMS.
The [web bridge](../../apps/mail/lib/workstation/web-pane-bridge.ts) rejects native Outlook commands, while HMS actions use separate authenticated backend clients.
Therefore the prop does not enforce an HMS read-only surface.
The fix needs distinct surface capabilities: normal staff webmail can perform authorised HMS actions; a genuine preview cannot initiate them.

[Workflow folders](../../apps/server-pilot/src/mail/workflow-folders.ts) currently represent a historical review cohort: 28 September–16 October and threads with staff outbound mail.
A new 4-Nov synthetic email can be absent from that view without intake failing.
Use normal Inbox with an exact canonical message ID for the fast Labtest journey; do not backdate a fake email or fabricate staff replies to satisfy the gold-review window.

## 4. Complete prefill has three sources

| Source | Fields it can establish | How to present uncertainty |
|---|---|---|
| Email and readable attachments | Requested dates, confirmation, guest names, occupancy/ages, room or board request, agency/company and booker contact | Preserve attribution and distinguish booked dates from requested dates; unread sources remain visible |
| Fresh HMS lookup | Exact stay/profile/party IDs, current booking values, valid native codes, current availability, price and CMS values | Ambiguous candidates need staff selection; unavailable and unpriced are different states |
| Memory and sensible defaults | Suggested rate code and established agency/company preferences; safe form defaults | Recommendation with evidence/reason, never proof of current price or contract validity |

Staff edits must take priority and survive late lookups, re-extraction, navigation and retry.
Use existing [MailExtraction](../../apps/server-pilot/src/ai/extraction/schema.ts), [WorkItem](../../apps/server-pilot/src/ai/work-items.ts), stable stay/row IDs and edit revisions.
Avoid a new general intent schema or a second form-state system.

The [folder prefill predicate](../../apps/server-pilot/src/mail/workflow-folders.ts) currently means any one usable field.
Replace the visible success implication with field-level completeness and concrete missing business fields.
Do not count “one date found” as a ready form.
An Amend form can be complete by preserving HMS values the email does not change; Create cannot fabricate missing guest facts.

| Business fields | Reliable source | Current form/write gap |
|---|---|---|
| Guest names and existing profile ID | Attributed email names plus exact HMS profile selection | Names can prefill; profile cannot be guessed or created yet; fuller durable edit paths needed |
| Confirmation and booked arrival | Confirmation/email hint plus fresh exact HMS stay | Keep separate from requested new dates; do not approve a different stay with a matching name |
| Requested arrival/departure/nights | Email requested dates; HMS preserves untouched endpoint | Existing date events; align nights and requested/current values |
| Rooms, room type, adults, children/ages | Explicit per-stay/row email facts plus native room mapping/current occupancy | Existing events; preserve total-vs-per-room distinctions and missing ages |
| Rate code and meal basis | Explicit email code or advisory history; current native candidate | Rate not extracted/recommended into full Create form today; meal basis follows native tuple |
| Nightly amount and total | Fresh native price; explicit staff Quote amount | Quote amount only; native amount Save needs U7 |
| Agency and organisation | Email hints/memory candidates; exact native party selection | Create supports both; Amend currently preserves them rather than changing them |
| Source, track and guarantee | Email channel, native selections/defaults and current HMS | Supported Create inputs need durable paths; current Amend preserves these |
| Booker name/contact and guest email | Role-attributed email or current HMS | Supported, but fuller durable form paths needed; Booker Contact is not necessarily an email address |
| Reservation note | Email special requests plus staff note/current HMS | Create supports note; current Amend preserves it rather than exposing a note mutation |
| CMS template, recipient and send | Current HMS/options plus explicit staff choice | Supported; Labtest send forced off; consent is separate |
| Market Segment and guest opt-in | Native derived market; consent from explicit staff/profile fact | Current Create mapper rejects supplied Market Segment and opt-in=true; show native context, avoid unsupported editable values |

“More fields” must expose only actual supported edits and read-only native context for the others.
It must not imply this release mutates every Infor field.

The current worker may add a coarse classifier after extraction, using the subject, filenames and only the first 600 body characters.
It can override the workflow chosen from full-source extraction.
Legacy inbound triage was off in the latest observed runtime, so multiple code paths do not mean every classifier is running.
Unify folder/pane routing around the same stored per-stay action and staff correction; do not discard extracted stays because a payment label won.
Mastra remains in the code: it hosts enabled triage/draft workflows, while background extraction is separate and optional `PANE_BRAIN=agent` performs synchronous pane analysis.
The pane agent currently has no HMS tools by default and no rate recommendation.
No Mastra Memory integration was found; Nava Postgres holds extracted facts/edits, and the separate Cloud booking-memory functions provide historical PMS hints.
Current staff-pick history ranks sales strategies, not rate codes.
Wiring historical code hints and an editable LLM suggestion into the pane is a build task, not an already-enabled feature.

## 5. Rate-code selection and price comparison

Current Create and Amend code inputs accept native rate codes, but their ordinary form controls are selects.
The [Quote plan select](../../apps/mail/components/quote-workflow/rate-plan-select.tsx) filters already-returned rate cards.
It does not itself look up a typed native code or validate availability.

The [stay grid](../../apps/mail/components/quote-workflow/stay-rate-grid.tsx) selects a room/rate/board tuple, with price and rooms left as reference observations.
It is useful for comparing different room types and meal bases.
For one selected room, a searchable rate picker can display the same information more compactly.
Use code on the left, native meaning on the right, and price/availability below; show full selected-rate totals and nightly detail outside the popup.
Retain a closed comparison view when multiple rooms/boards or varying nightly prices make one number insufficient.

Rate states must distinguish valid-but-not-priced, currently available and priced, unavailable for this request, and read failed.
Absence from a returned subset does not prove unavailable.
Party, dates, occupancy, room and board changes invalidate the associated price observation and prior review.
Fetch candidates in one existing native availability read where possible; do not open a browser per code to populate a dropdown.

For Amend, preserve the current rate unless the email or staff asks to change it.
Show current versus requested code and the retain/reprice choice when HMS needs it.
For Create/Quote, recommend a valid current candidate based on source, party and past usage; require review of actual HMS price before Go.

### Verified rate frequency and the cricket gap

The available confirmation capture contains 894 attempts and **892 successful distinct confirmation reads**, all with a Rate Plan value, spanning 20 codes.
It is a later snapshot cohort, not independently verified booking-time decisions or the only possible corpus behind the owner's recollection.
The method counted distinct non-empty native confirmation values and their Record View Rate Plan fields in the private `stay360-1a-1b-1c-20261029-run01.json` capture; that capture is indexed by the [field-scope audit](halloween/2026-11-01-hms-field-scope-audit.md).
The independently reused E-Mail distribution is documented under “Further E-Mail-source patterns” in [party memory and lookups](halloween/memory-experiments/2026-10-30-party-memory-and-lookups.md).
These locators retain the calculation basis without copying guest-level data into this report.

| Code | All 892 confirmation reads |
|---|---:|
| NGOVDB | 279 (31.3%) |
| BOTAB | 149 (16.7%) |
| NCOR1B | 131 (14.7%) |
| BAR | 91 (10.2%) |
| NGOVB | 77 (8.6%) |
| NCOR2B | 63 (7.1%) |
| Other codes | 102 (11.4%) |

| Code | 492 E-Mail reads |
|---|---:|
| NGOVDB | 204 (41.5%) |
| NCOR1B | 95 (19.3%) |
| NGOVB | 63 (12.8%) |
| NCOR2B | 52 (10.6%) |
| BAR | 45 (9.1%) |
| Other codes | 33 (6.7%) |

The E-Mail top five in frequency order are **NGOVDB, NCOR1B, NGOVB, NCOR2B, BAR: 459/492 (93.3%) combined**.
No single code approaches 90% in this capture.
For inbound E-Mail recommendations, use that source-conditioned ordering, while current verified choices supersede historical hints.
Do not carry the E-Mail denominator into multi-source memory counts.

[rate-catalogue.ts](../../apps/server-pilot/src/hms/rate-catalogue.ts) is a static UI catalogue with some mock/unverified labels and omits frequent NGOVDB/BOTAB.
Native quote cards already have HMS rate labels; propagate those instead of inventing code meanings.
GNC3B/GNC4B are present in the static catalogue and manual-override list, and live-returned options receive a cricket-event hint.
Neither appears in the 892 historical Rate Plan fields.
Current HMS availability for the owner's particular dates/party remains unresolved: no live rate read was performed because the assigned checkout lacked its declared Playwright install, and no new setup was undertaken.
This is a current UI/data propagation investigation, not evidence the event rates were removed or rebuilt incorrectly.

[hms-booking-memory.mjs](../../apps/server-pilot/tooling/hms-cloud/hms-booking-memory.mjs) builds private property-partitioned memory from PMS snapshots and linked message/PDF records.
[Its query](../../apps/server-pilot/tooling/hms-cloud/hms-booking-memory-query.mjs) already returns historical rate-plan values ranked by distinct confirmation count.
Default sources include E-Mail, Voice Call and Call Center; specify E-Mail for this pane's initial prior.
Use explicit address roles: historical outbound recipient is not proof of inbound sender identity.
The query returns historical hints independently of party combinations; it does not establish a contractual mapping between a party and a rate.
Staff rate-code choices need a small extension to existing event evidence, since current staff-pick history stores strategy only.

## 6. Numeric overrides are a separate capability

[rate-controls.tsx](../../apps/mail/components/quote-workflow/rate-controls.tsx) already supports a rate code, nightly rand amount and authorisation note for Quote output.
That state is not carried by the current [Cloud Create mapper](../../apps/server-pilot/src/ai/pane-create-cloud-input.ts) or [Cloud Amend change schema](../../apps/server-pilot/src/ai/pane-cloud-amend.ts).
Do not present a changed Quote amount as an HMS-saved price.
The current amount applies uniformly per room/night for that Quote row; a different amount for each night is not currently supported.

The UI should put “Change nightly price” beside the selected rate, show currency and nightly basis, and expose HMS total after native staging.
A native amount setter needs bounded screen research, business-field validation, one Labtest Save and fresh saved-nightly-rate readback before it is connected to Go.
Its implementation ETA remains unknown until the actual native setter and Save semantics are demonstrated.

The retro also identifies a possible price-change gap: Amend can reprice after review without comparing that amount to the earlier reviewed amount.
This was not an observed incorrect charge.
Show a material changed price and require renewed review before Save; compare business prices, not the entire native request body.

Create also exposes editable Market Segment and guest opt-in=true while its mapper refuses them.
Display native-derived Market Segment as read-only until supported; do not send an unsupported editable value.
Keep opt-in false/read-only initially, rather than inventing consent from mail.

## 7. Guest profiles: independent next tranche

Native **Guest Profile** opens `FSGSPF`; Guest Details and Record View are stay views.
Existing captured New form marks first name, last name, mobile and status required, with status defaulted Active.
The older claim that New is in the `LVGUESTS` picker conflicts with that capture.
[guest-profile.mjs](../../apps/server-pilot/tooling/hms-cloud/guest-profile.mjs) searches/selects profiles but does not create them.

In 892 later Record View snapshots, 639 had mobile populated; this is not profile-creation history.
In 30 paired stay forms, Created matched in 29 and Updated differed in 27; neither establishes who created the master profile.
Ten sampled 23-Oct confirmation PDFs had no profile creation metadata.
The latest exact-ID live read found one matching profile, but returned no mobile/audit fields.
Do not turn booker/agency contact into a guest mobile number.

Build later as profile Prepare → staff Go → fresh profile-ID readback → reservation Prepare → staff Go.
An independently saved profile survives a failed stay.
Lock profile creation by identity, rather than stay arrival, to prevent duplicate creation across rooms/dates.
Native Save, duplicate handling and master audit provenance remain unproven.

## 8. ROI and scope

| Priority | Work | Reason |
|---|---|---|
| First | Correct selected email, complete editable form, automatic native lookup, Amend change review and actual Go/readback | Removes the immediate “cannot use the pane” failure and delivers the staff task |
| Alongside | Rate code typing/search, valid choices, native meaning, current price/availability, memory suggestion | Matches staff's normal HMS operation and prevents invalid/stale selections |
| Same initial programme | Create/Quote UI overhaul and coherent verified/uncertain outcomes for existing workflows | Avoids fixing only the Amend demo while leaving the real booking product awkward |
| Subsequent release | Native numeric nightly override | Requested capability; current Quote control does not supply the HMS write |
| Next tranche | New guest-profile creation | Owner excludes unmatched-profile bookings from initial release; independent research now |
| Deferred | Hotel FAQ, generic draft replies, broad finance/billing/refunds, native group booking, OCR/XLSX expansion | Not necessary for initial reservation parity; retain the broader vision without expanding this critical path |

The Halloween corpus contains 4,516 deduplicated inbound messages and 1,361 model-labelled actionable messages in its 34-day cohort.
Its overlapping tags and retrospective model assistance are prioritisation evidence, not observed automation percentages.
The 892-record party snapshot has both agency and organisation in 326 records; the native tool already has a saved combined-party proof, but the final pane route still needs validation.
Existing supported multi-stay/room behaviour must survive the redesign; native group booking is a separate feature.

## 9. Delivery lessons and ETA basis

| Comparable | Recorded elapsed | How to use it |
|---|---:|---|
| Overnight execution to final runtime proof | 4h28; 4h30 to closing answer | Strong four-workflow rescue; wider than the 2h15–3h15 forecast |
| Four main workflow PRs merged | 2h54 from start | Coding/merge milestone, not final delivery |
| Remaining final proof/rollout after that | About 90m | Included more coding/fixes; not fixed release overhead |
| Source-selection worker | 14m first-to-last turn | A comparable narrow wiring change; not universal productivity |
| Initial Filing worker | 20m first-to-last turn | Existing seams can yield a fast candidate, but native proof took longer |
| Bounded researchers | About 6–12m turn bounds | Reuse captures and concrete entrypoints; stop open-ended rediscovery |
| Prior Nov-3 bundle deploy/restart/health segment | About 9m | One operational pass; excludes review, testing and canary |

The 29-minute coordinator gap had no recorded decisions; workers continued.
It should not be assumed fully recoverable time.
Assign release ownership at launch, keep workers on connected units, collect short decision-ready handoffs, and give a worker its next independent task promptly.
Nine final-head Greptile checks completed after merge; final review or an independent fallback must finish before merging new work.

[Revised plan](../plans/2026-11-04-002-feat-nava-pane-prefill-rate-parity-plan.md) + [readiness review](2026-11-04-nava-plan-readiness-review.md) replace the earlier blanket4–6h forecast.
+30m remains intake/source checkpoint; existing backend proof forecast25–45m.
Four file-owned writer lanes, early Amend plus final release waves: Amend114–203m; full187–346m (~3h10–5h50), conditional forecasts. New rate/durable-form scope has no matched completion-time comparator; checkpoint results revise the chain.
No universal lines-per-minute model or old Quote timeout is used.
Native numeric override and profile Save have no demonstrated comparable completion time; give them no fabricated total ETA.

## 10. Research boundary

Research used current source, prior transcripts/captures and one independent read-only existing-profile lookup.
No product code, RDS data, HMS records, flags or deployments were changed.
No staff-PC Outlook interaction was observed.
Current native prices, complete rate-code availability, negotiated-rate validity and profile creation provenance need the bounded checks specified in the plan.
