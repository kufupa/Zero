# Centurion 250-email pilot: findings and method

**Finding:** the evidence supports separate origin, work and potential-help labels, but not a dependable overall Nava opportunity percentage yet. On the 50 randomly selected holdout rows, three assessments agreed that prospective Nava could help with at least one step in **5**; eligibility was unresolved in **36**, and potential help was unresolved for one more known-eligible row. These are model opinions on a small saved-source sample, not observed Nava usage or population accuracy. [Pilot goal and usage boundary](./2026-11-01-centurion-250-pilot-plan.md#L8-L16) [Product adoption context](../../../../PRODUCT.md#L9-L11)

## Scenario is broader prospective Box 2

The execution record defines the pilot against **prospective Box 2**, not the narrower Box 1 create tool. It lists existing-stay/profile lookup, availability/pricing, staff-approved create, supported amendment, finance context, generic approved-document attachment where supported, and quote composition as hypothetical capabilities. The record says Box 1 was not started at that point; Box 2 is not a deployed workflow or evidence of staff adoption. Writes still require staff approval and Nava does not send. [Frozen scenario](./2026-11-01-pilot-execution.md#L5-L14)

Box 2 proposes multi-room work as a loop of individual creates—not native linked reservations or group/XLSX support. OCR/POP intake and payment posting remain parked; real-guest cancellation commits are excluded. A request over 10 rooms in the same group/request episode is out of scope; exactly 10 is not excluded by that room-count rule, and an ambiguous total stays unknown. Separate group/event or spreadsheet work remains parked regardless of the count. Treat any help from the proposed create loop as conditional on independently specified room requests and evidence, not a general multi-room guarantee. [Box 2 scope](../../../plans/2026-11-01-002-hms-cloud-create-e2e-box-plan.md#L142-L152) [Pilot boundaries](./2026-11-01-pilot-execution.md#L11-L14)

## Saved Centurion source context

The saved snapshot covers stored dates **27 July–29 October 2026** and contains **11,211 inbound and 4,830 outbound source rows**. These are rows, not proven distinct delivered emails or requests. The census reports 1,171 unresolved duplicate candidates and an unverified timestamp timezone; the saved snapshot is not proof of complete delivery or mailbox capture. [Census scope](./centurion-origin-census.md#L5-L8)

The census ranks exact parsed `From` hosts separately; subdomains are not combined. The following 16 hosts each have at least 100 saved inbound rows, together accounting for 7,159 rows. Counts describe source rows only, not message intent, sender authenticity, automation, work or Nava assistance. [Ranked-host method and limits](./centurion-origin-census.md#L24-L27) [Full ranked table](./centurion-origin-census.md#L28-L47)

| Exact `From` host | Inbound source rows |
|---|---:|
| `legacyhotels.co.za` | 2,946 |
| `synxis.com` | 902 |
| `gmail.com` | 501 |
| `booking.com` | 348 |
| `grfeedback-b.com` | 313 |
| `nedbank.co.za` | 267 |
| `travelit.co.za` | 262 |
| `mailgun.tvlinc.com` | 235 |
| `profitroom.com` | 234 |
| `nexustravel.co.za` | 206 |
| `atlantiscorporate.co.za` | 193 |
| `fortimail-01.vox.co.za` | 173 |
| `guestrevuapp.com` | 171 |
| `fortimail-02.vox.co.za` | 161 |
| `renniesbcdtravel.com` | 138 |
| `thompsons.co.za` | 109 |

The most common outbound `To` hosts are `legacyhotels.co.za` (1,124 rows), `gmail.com` (446), `nexustravel.co.za` (198), `atlantiscorporate.co.za` (185), `guest.booking.com` (169), `tollink.co.za` (158), and `destinitravel.co.za` (102). Recipient-host counts can overlap: 250 outbound rows have multiple `To` hosts, and 516 have no parseable `To` host. CC/BCC are excluded. [Recipient-host census](./centurion-origin-census.md#most-frequent-outbound-recipient-hosts)

Across all hosts, 2,218 of 11,211 inbound rows have a no-reply sender clue. The three exact hosts `synxis.com`, `booking.com` and `profitroom.com` account for 1,484 inbound rows, including 1,441 with that clue. A scan found 118 `synxis.com` rows matching an integration-failure subject pattern, all with a no-reply sender clue. Earlier owner-confirmed examples required staff checks, but this subject count does not establish 118 distinct tasks, completed work, automated origin or possible assistance. Use it only as a review-candidate signal. The saved snapshot lacks raw MIME, so automation headers such as `Auto-Submitted` cannot be verified; a host or no-reply clue is not proof. [Subject-census finding](./centurion-origin-census.md#L3-L4) [Header and origin limits](./centurion-origin-census.md#L20-L22)

## Sample design and embargo

The frozen design selected **250 inbound source rows**, not 250 proven unique threads or request episodes:

| Cohort | Planned rows | Purpose |
|---|---:|---|
| Random development | 100 | Ordinary mail; develop cleanup and labels. |
| Random holdout | 50 | Evaluate only after the development method freezes. |
| Targeted development | 100 | Stress cases: 20 each for OTA/system, POP, voucher, group/rooming and mixed-action cues. |
| **Total** | **250** | Deliberately combines random and oversampled targeted rows. |

The 150-row random draw was split into 100 development rows and 50 sealed holdout rows; the 100 targeted rows were selected separately. Selection cues are candidate-finding aids, not classifications, and the plan says not to expose target strata/cues to assessing models. Keep random and targeted results separate; the combined sample is not an estimate of overall mail mix. [Predeclared design and cue rules](./2026-11-01-centurion-250-pilot-plan.md#L47-L64)

The execution record reports that **8 random-development rows** shared normalized subject and body with a holdout candidate and were embargoed. That left 92 unembargoed random-development rows plus 100 unembargoed targeted-development rows (**192 development rows available**). The 8 remain within the selected 250; they are not extra holdout cases. Similar normalized content is a candidate link, not proof of duplicate delivery. The 50 holdout rows remained sealed until the cleaner, prompts and capability mapping froze. [Draw, embargo and development counts](./2026-11-01-pilot-execution.md#L51-L57) [Holdout rules](./2026-11-01-centurion-250-pilot-plan.md#L59-L62)

## Interpret origin, work and help separately

- **Recommended triage shape.** Keep one primary work type for a simple email and `multiple work types` when it contains distinct actions. Also retain overlapping action flags, so a booking with a voucher or billing request is visible in each relevant workflow. Candidate types are quote, new booking, amendment, cancellation request or completed cancellation notice, billing, proof of payment, other payment work, voucher, service, group/event, marketing, no current work and unknown. These are research labels, not an implemented routing change.
- **Origin is not action.** Record OTA/channel/system/automated and no-reply clues on a separate source axis with uncertainty. A source host, subject cue or no-reply clue does not determine the request, prove automation or authenticate the sender. Travel-agent requests remain in scope under current product guidance. Preserve any unresolved routing-policy conflict rather than letting origin overwrite action. [Pilot label axes](./2026-11-01-centurion-250-pilot-plan.md#L18-L25) [Current policy conflicts](./README.md#L61-L65)
- **Group threshold is explicit.** Exclude a group request only when it asks for **more than 10 rooms in the same episode**; exactly 10 is not `>10`. Do not infer rooms from guest counts or add unrelated room requests together. Leave unclear totals unknown. The targeted group cue may include “at least 10” to find candidates; that cue is not the owner’s exclusion label. [Threshold and episode rule](./2026-11-01-centurion-250-pilot-plan.md#L22-L22) [Counting rule](./2026-11-01-centurion-250-pilot-plan.md#L39-L43)
- **Billing, payment, POP and voucher are distinct.** Billing covers invoice/folio/account or billing-instruction work. Payment claims, proof-of-payment evidence and independently verified cleared/posted funds are different states. A voucher is a separate document/workflow signal and is not proof that money cleared. Under the owner’s analysis rule, a supplied or explicitly claimed POP or voucher creates a filing task for the relevant stay, even without a literal “please file” request; file bytes, stay match and filing status can still be unknown. One file serving both POP and voucher purposes is counted once as a file. Generic approved-document attachment is prospective; OCR/intake and payment posting are parked. [Owner document-task clarification](./README.md#L42-L51) [Pilot capability boundary](./2026-11-01-pilot-execution.md#L11-L14)
- **Keep task and message roll-ups distinct.** Label each request × stay × action. Message-level `any_help` and `fully_preparable` are separate; `fully_preparable` requires every material task to be in scope and complete. A filing subtask does not erase another unresolved or excluded task. [Pilot unit and roll-ups](./2026-11-01-centurion-250-pilot-plan.md#L14-L25) [Roll-up definition](./2026-11-01-centurion-250-pilot-plan.md#L39-L45)

For a future dashboard, the leading prospective measure can be **in-scope emails with at least one potentially helpful Nava step / actionable in-scope emails**, alongside the same numerator over all inbound rows. Keep unknowns and excluded groups visible. This would describe estimated opportunity, not observed adoption or autonomous resolution. Staff approval remains necessary for planned writes, and staff must resolve ambiguous targets, commercial decisions and payment clearance.

## Snapshot, attachment and adoption limits

- The **1,171 duplicate candidates** and cross-thread/mailbox overlap mean source-row counts must not be described as distinct emails, tasks or guests. Message-ID, fingerprints, or normalized body equality alone do not prove duplicate delivery. [Census limits](./centurion-origin-census.md#L5-L8) [Pilot linkage cautions](./2026-11-01-centurion-250-pilot-plan.md#L58-L62)
- The main saved snapshot has **no inbound attachment inventory or bytes**. An empty attachment field is not proof that no file was supplied. A separate older saved export may contain attachment metadata or extracted text, but lacks PDF/image bytes and includes later thread context; linkage and decision-time availability must be verified before using it. Otherwise file presence/content stays unknown. [Saved-source limits](../corpus-experiments/month-source-inventory.md#L54-L68) [Older-export caveats](./2026-11-01-centurion-250-pilot-plan.md#L66-L72)
- The outcome is counterfactual potential assistance under prospective Box 2, **not observed staff adoption, usage, successful HMS writes, payment or guest communication**. Later staff replies and independent saved outcomes are separate evidence; they must not leak into decision-time request/help labels. The approved pilot plan and execution record both set this boundary. [Pilot goal](./2026-11-01-centurion-250-pilot-plan.md#L8-L16) [Execution scenario and outcome boundary](./2026-11-01-pilot-execution.md#L7-L14)

## Cleaning: what the pilot actually removed

On the 192 development rows, both comparison arms shared privacy guarding and HTML-to-visible-text conversion. The extra cleanup changed 27 bodies and reduced their combined guarded text across all 192 by **3,919 of 683,804 characters (0.57%)**: 98 decorative separator lines and one repeated disclaimer were removed. This does not measure the effect of the shared HTML conversion or prove that sensitive data was completely removed. The snapshot has no inbound file bytes, so images and PDFs were not sent to the models. More aggressive deduplication of quoted conversation remains untested; important earlier requests can appear in quotes. [Cleaning details and caveats](./2026-11-01-pilot-execution.md#final-development-freeze-before-holdout)

## What the 50-row holdout showed

Each row received three blinded first-pass assessments: two separate Luna Max calls and one Sol high call. All 150 returned structurally valid results. The table shows the primary label only when all three agreed; the last two rows preserve unresolved labels. These are **sample counts**, not validated corpus shares. Mixed messages keep their underlying action flags separately.

| Primary work label | Holdout rows |
|---|---:|
| Multiple work types | 7 |
| Quote | 2 |
| Billing | 1 |
| Other payment work | 2 |
| Cancellation request | 1 |
| Cancellation notice, no new work | 1 |
| Service | 1 |
| No current work | 3 |
| Marketing/spam | 2 |
| All three said unknown | 5 |
| Assessments disagreed | 25 |
| **Total** | **50** |

An action can occur inside a mixed message. For example, all three assessments assigned the action flags billing to 6 rows, POP to 3, vouchers to 2, and new-booking work to 1; these overlap and are **not** additional rows. A broader document-signal flag can also include a document kind without the matching action label: the voucher document signal below appears on 3 rows. Absence of a label is not evidence that the action was absent. Separate origin labels also disagreed on 23 of the 50 rows; raw MIME and automation headers were unavailable, so this does not establish an automation rate.

For potential help, all three agreed that **6/50** rows contained at least one eligible task under the stated scenario, and that **5 of those 6** could receive at least some help. Eligibility was unresolved for **36/50** rows; help was unresolved for the remaining known-eligible row. Thus **5/50 (10%) is only the sample's strict-agreement count**, not an estimated true share, lower bound on accuracy, or deployed capability. The apparent **5/6** resolved-only ratio omits almost all uncertain cases and is not a defensible headline. Unknown-sensitivity calculations range from 5/50 to 42/50 for all rows, without accounting for wrong model labels or source gaps; these are not confidence intervals. No holdout row was unanimously assessed as fully preparable.

For context, each assessment separately identified 9 of the 50 rows as potentially helped, though they did not choose exactly the same nine:

| Assessment | Potentially helped | Known eligible | Eligibility unknown | Help unknown within eligible |
|---|---:|---:|---:|---:|
| Luna Max call A | 9 | 12 | 26 | 3 |
| Luna Max call B | 9 | 10 | 27 | 1 |
| Sol high | 9 | 11 | 19 | 2 |
| All three agree | 5 | 6 | 36 | 1 |

The 9/50 (18%) individual counts are also descriptions of model output, not measured coverage. Helped rows are a subset of known-eligible rows; help can still be unknown for other eligible rows. Do not turn these figures into a population estimate.

The 92 unembargoed random-development rows separately yielded 13 known eligible, 11 with agreed potential help and 62 with unresolved eligibility; help was unresolved for 2 of the known-eligible rows. The 100 targeted development rows yielded 24, 20 and 63 respectively, with help unresolved for 4 known-eligible rows; they were deliberately enriched for candidate categories and cannot estimate the ordinary mailbox mix. The eight embargoed rows were assessed separately after freeze, not pooled into either holdout or development summaries.

## What Nava could prepare, and where staff remain involved

The proposed work labels are useful as a **dashboard reporting roll-up**, but should not be the only classification. The current checkout already uses 11 operational folders, including `money-billing`, `documents-delivery` and `automated-channel`; its rules distinguish existing-confirmation payment proof, a voucher with a new booking, and voucher-only delivery. Keep those operational needs visible while adding separate action and origin flags. This is a code observation, not proof of deployed behavior. [Current triage prompt](../../../../apps/server-pilot/src/ai/workflows/mail-triage.ts#L164) [Voucher/payment refinement](../../../../apps/server-pilot/src/ai/triage.ts#L1118)

The following distinctions use the prospective plan, not a claim that its capabilities or automation exist today. Existing payment-proof preparation is read-only; the current voucher attachment path includes gated scaffolding and does not establish an end-to-end Cloud upload. [Payment checklist](../../../../apps/server-pilot/src/ai/hms-todo-card.ts#L392) [Voucher attachment client](../../../../apps/mail/components/quote-workflow/voucher-find-card.tsx#L66)

| Triage signal | Potential help under the named plan | Human or scope boundary |
|---|---|---|
| Quote or new booking | Find relevant stay/profile and availability/rate context; prepare a quote or an individual create. | Staff decide uncertain details and approve any write; the proposed multi-room loop consists of individual creates. |
| Amendment | Find the existing stay and prepare a supported change. | Staff resolve ambiguous matches or requested changes and approve a write. |
| Cancellation request | Identify the request and relevant context. | A real-guest cancellation commit is parked; cancellation notices with no new request are a separate label. |
| Billing | Surface invoice, folio, account or billing-instruction context. | Staff handle disputes, unsupported billing actions and decisions. An invoice is not a payment. |
| Payment | Surface available finance context and distinguish a payment claim from a transaction. | Payment posting is parked; staff verify whether money was recorded or cleared. |
| POP or voucher supplied or explicitly claimed | Flag a separate document-filing task for the correct stay; a generic approved-document attachment is in the prospective scope where supported. | Staff confirm the stay, file and approval. Missing file bytes or an unverified claim remain unknown. OCR/intake and the end-to-end workflow are parked; a voucher does not prove cleared funds. |
| Group request over 10 rooms in the same episode | Label and route the group request as excluded. | Group handling is descoped. Exactly 10 rooms is not excluded by that threshold; ambiguous or unrelated room counts must not be silently combined. |
| OTA/system/no-reply clue | Add an origin flag and, where useful, a known-pattern review candidate. | Inspect the actual action and exceptions; a no-reply or OTA message can still require work. Do not make it an automatic no-action rule. |

Existing code contains conflicting group thresholds and rules, including a guest-count rule and a roughly 10-plus-room rule. They are not the owner's exact **more-than-10 requested rooms in one episode** boundary; reconcile them before using a production group classification. [Current conflicts](./README.md#current-scope-corrections-and-unresolved-conflicts)

## Checks and limitations that affect the findings

- **Document filing needs more work.** In the holdout, the main triad unanimously flagged POP and voucher signals on 3 rows each. A separate two-model document review produced no holdout rows where both models supported a POP- or voucher-specific filing signal; Sol alone supported one voucher case. These use different questions and validation rules, so the discrepancy is not a measured error rate and neither absence of a positive signal nor missing attachment metadata proves no document was supplied. On deliberately constructed examples, the main review missed inline supplied POP and voucher examples; the focused document check passed those examples but still left 5 of 28 synthetic model/case results unknown. Separately, a second model supported at least one document/payment critique on 54 of 183 selected development cases; those cases were mostly chosen for disagreement and are not verified errors. Improve the document evidence and validator before estimating this workflow's coverage.
- **A group result is disputed.** The main triad marked one holdout row as a current over-10-room request, but the focused room check split: one model said yes and the other no. Another explicit-count candidate had two no opinions. The candidate scan misses linked sums of smaller allocations. Treat these as review signals, not a verified group rate.
- **Missing source evidence is material.** All 50 holdout packets lacked an inbound attachment inventory and bytes. Three had their whole body withheld by the privacy guard; seven were truncated, and seven had contact-field regions partly withheld. These groups may overlap. The same guarding and HTML conversion applied to both cleaning arms. Without a verified earlier-message order, separate prior messages were not inserted; quoted context already in the email was retained.
- **The models vary on the same input.** For the preselected 20 holdout rows, each of three slots assessed the identical cleaned packet twice. The `any_help` label changed in 17 of 60 assessment pairs; 3 of those changes were between known yes and no, while the others involved unknown. Pairs reuse the same 20 messages. The label also differed in 50 of 209 available cleaned-versus-original assessment pairs, but that comparison includes repeated messages and one further pair timed out. These differently composed comparisons do not isolate a cleaning effect; both arms also share the privacy guard and HTML conversion.
- **Literal evidence is not ground truth.** All 1,492 checked citation instances from the 150 holdout first-pass assessments matched text in the corresponding guarded-original packet. This does not establish that the quote was interpreted correctly, that all needed context was present, or that the model's assessment was correct. Two Luna calls use the same model family; even agreement across models is not independent human truth.
- **Later replies are not an answer rate.** After input labels froze, 7 of the 50 holdout rows had a same-thread outbound `In-Reply-To` candidate in the saved source; only one had a strictly later stored calendar date. Same-day replies are not counted as later-date candidates, and timestamp semantics, delivery and completeness are uncertain. A matching link does not prove an answer, resolution or Nava use; a missing link does not prove no reply.

## Recommended next research

1. Improve document detection and source evidence first: distinguish a request for proof from an actual supplied-file claim, test validator misses against constructed and saved examples, and obtain attachment inventory/bytes and verified prior context where available. Preserve privacy guards and compare any cleaner change against the guarded original. Reserve a **fresh holdout** after changing the method.
2. Keep a simple primary work label for display, with overlapping actions and independent OTA/system/no-reply candidate flags. Preserve exceptions such as integration failures for staff review. Count excluded over-10-room groups explicitly.
3. For a future opportunity metric, report both potentially helped inbound rows and potentially helped **known-eligible** rows, with unknown, excluded and human-decision counts beside them. Keep preparation, staff approval, actual tool use and answered/resolved outcomes as separate measures.
4. Repeat on Da Vinci only after building a property-specific source frame, cross-mailbox linkage and capability mapping. Its mailbox aliases and HMS tenant differ; do not copy Centurion's rate or selector. [Da Vinci method](./README.md#5-centurion-first-da-vinci-requires-a-new-frame)
