# Centurion corpus audit — what the counts mean

**Prepared:** 2 November 2026; capability snapshot updated 3 November 2026  
**Purpose:** internal evidence note for the B2B dashboard / Nava opportunity deck.  
**Unit:** one deduplicated email record unless stated otherwise. Not people, stays, threads, bookings, or staff hours.

## The short answer

The “about 4,000” figure came from a **30-day date slice: 30 Sep 2026 17:00 through 30 Oct 2026 17:00 SAST**, end exclusive. It contains **4,006 deduplicated inbound email records**, originating from **4,209 source rows**.

The headline Centurion analysis used a longer window: **26 Sep 2026 00:00 through 30 Oct 2026 17:00 SAST**, end exclusive. It contains **4,516 deduplicated inbound records**, from **4,719 source rows**. That is 34 days and 17 hours, not one month.

**Neither number is “what remains after filtering automated email.”** The count frame included inbound mail regardless of automation, sender domain, OTA branding, or subject. We then used Luna to classify the deduplicated inbound messages. We did not first run deterministic rules that removed no-reply, automated, OTA, or channel messages to save model calls.

## Nava today versus planned capabilities

**Today’s assistable-email count is not measured.** Do not substitute zero or the future estimates below. As of the read-only check on **3 Nov 2026 around 00:35 UTC**, all four app processes were online with AI enabled. Code for triage, read-only lookups and quote preparation exists; this check did not prove a complete staff-ready workflow or measure which corpus emails the running product could assist.

| Workflow | Evidence for today | Once the planned pilot works |
|---|---|---|
| Triage / read-only help | AI enabled in process environment; complete staff flow not verified | Classify requests, extract details, prepare next step |
| Quote | Quote preparation enabled in worker, disabled in both HTTP processes; staff flow unverified | Prepare accommodation rates and quote for staff review |
| AI reply drafts | Visible AI-draft switch `AI_DRAFTS_ENABLED=false`; other quote-draft paths unverified | Prepare an unsent draft for staff review |
| Create | Create flag `lab` in all four processes | Staff-approved individual creates, including multiple individual rooms; large groups remain backlog |
| Amend | Paid and unpaid amend flags `lab` in all four processes | Staff-approved supported changes, including dates, occupancy and rate plan |
| File voucher / proof | Attachment-write flag unset; legacy save flag `lab` on `http`, unset on `remote-http` | File supplied voucher or proof into the stay after staff approval |
| Cancellation | Cancel flags `lab` in all four processes | Lab only under the present pilot scope; later real-guest cancellation needs separate authority/readiness |
| Billing / invoices; groups >10 rooms | Not established as staff-ready; current product lists billing and groups as backlog | Later roadmap, beyond the current connected pilot |

Flags are configuration evidence, not proof a feature works. The EC2 checkout reported `00d814ca3`, process build markers reported `30b84b445`, and the last-good deploy marker reported `ccb3d48ea` at 26 Oct 02:39 UTC. Those disagree; the deployed feature version needs reconciliation. The owner last recorded that staff were not yet using Nava on 29 Oct; do not infer current adoption from that dated statement. Nava does not send emails; writes require staff approval.

### Prospective corpus estimates — different scopes

| Centurion scope | Five pilot task categories, if completed | Earlier broader non-group scenario | Broader future scenario including groups |
|---|---:|---:|---:|
| 26 Sep–30 Oct: all 1,361 actionable inbounds | **815 / 1,361 (59.9%)** | **1,007 / 1,361 (74.0%)** | Not calculated |
| 30-day slice: all 1,204 actionable inbounds | **727 / 1,204 (60.4%)** | **893 / 1,204 (74.2%)** | Not calculated |
| Same 30 days: 629 staff-linked inbounds | **384 / 629 (61.0%)** | **485 / 629 (77.1%)** | **517 / 629 (82.2%)** |

The five-category estimate is a **new, rough filter of saved model labels**, not a deployed-product measurement: quote, create, amend, supplied voucher filing, or supplied proof filing. It selects emails already marked actionable and `can_help=true`, with at least one action-detail row marked `nava_supported=true`, scope `non_group`, and state `requested`, `supplied_for_action`, or `completed_or_confirmed`. Count each email once. The underlying model used broader historical assumptions, so a category match does not prove the planned tool handles every detail; originally rejected or unclear emails were not added. Some action states use later replies. Dataset SHA-256: `7c95be34030929e6bf1ceae35ad209cdffefcc47db65d7bbf16ed7f572540a7d`.

The older 1,007 / 485 scenarios additionally assume reservation invoices and cancellations; they do **not** describe only the current pilot plan. The 517 scenario also adds 28 large-group candidates and four reviewed uncertain-scope cases. Group support, invoice handling and non-lab cancellation are future assumptions here. All percentages include partial help and staff approval; none measures unattended automation or actual Nava usage. A staff-linked inbound is an email with a model-linked staff reply, not a distinct reply.

## Corpus frame and arithmetic

| Direction | Source rows in window | Deduplicated email records | Source rows collapsed by dedupe |
|---|---:|---:|---:|
| Inbound | 4,719 | **4,516** | 203 |
| Outbound | 2,099 | **2,067** | 32 |
| Total | 6,818 | **6,583** | 235 |

“Collapsed” is precise: these are rows with the same dedupe key, not proof that every pair was a redundant delivery. The key was **direction + normalized Message-ID + normalized sender + normalized subject**. We kept a private mapping from each retained record to its source rows. Direction is kept separate, so an inbound and outbound can never collapse into one record.

The separate 30-day slice is a query over the saved Centurion inbound frame, not a second independent mailbox export:

| 30-day measure | Count |
|---|---:|
| Inbound source rows | 4,209 |
| Deduplicated inbound records | **4,006** |

Do not combine the 4,006 and 4,516 counts. The first is nested in the second and uses a later start date.

## What “inbound” means here

It means a message present in the Centurion property/mailbox source snapshots, addressed into the mailbox and assigned inbound direction by the source/frame process, with its timestamp inside the stated SAST window. The report counts the message once after the dedupe key above. It does **not** mean:

- one conversation or thread (a thread can contain several emails);
- one unique guest, agency, stay, or reservation;
- only external/customer-written emails (some internal instructions and copied messages remain in the frame);
- only emails that staff answered; or
- only mail Nava can help with.

The frame rules were property/source, time range, direction, usable source record, and deduplication. Domain, “no-reply,” automated-template appearance, OTA/channel identity, and reservation relevance were **not frame filters**. The sender domain therefore cannot be treated as intent or eligibility evidence.

## How the inbound was filtered/classified

There were two different operations. Keeping them separate is essential to explaining the denominator.

### 1. Frame selection: cheap, structural inclusion

1. Use Centurion source snapshots and the stated time window.
2. Split inbound and outbound by direction.
3. Normalize the dedupe fields and collapse records with the same direction/Message-ID/sender/subject key; retain source mapping.
4. Keep all records in the denominator, including automated-looking mail, OTA/channel notices, acknowledgements, spam, internal copies, and messages with no readable body.

**No automated-mail exclusion rule was applied here.** In particular, we did not use a regex, sender-domain allow/block list, `no-reply` rule, or subject rule to keep email away from the LLM.

### 2. Interpretation: clean evidence, then semantic LLM classification

For classification, the pipeline prepared a bounded evidence packet: cleaned HTML and hidden markup, omitted inline brand images/irrelevant link clutter, separated current text from repeated quoted history where possible, bounded the current body at about 4,000 characters and earlier quoted context at about 2,000 characters, and attached available sender/recipient metadata. Some wrapped quote headers were not split correctly. This changes the model input, **not** the inbound-email count.

MIME was inventoried for **4,514/4,516** inbound records; **1,411** had attachments. Selected relevant PDFs/spreadsheets received bounded text extraction. This was not a full read of every attachment: in the final packet, **181/372 voucher-tagged** emails had extracted PDF snippets, while **191** had no extracted PDF content addendum. A label could therefore be based on body, quoted context, filename/type metadata, linked replies, or extracted text; it does not prove the attachment's contents or authenticity.

Luna then judged whether the current email contained an active reservation task. The semantic rules treated the following as not actionable for this use case: actual OTA/channel-originated work without a separate in-scope agency-document task; completed acknowledgements; stale requests only in quoted history; hotel-authored outgoing copies with no new staff assignment; pure notifications/status mail with no current action; spam; internal reports; post-stay feedback; unrelated hotel services; and unsupported generic requests. It retained active forwards and genuine internal instructions when they assigned reservation work.

Important nuance: **automation alone did not make an email out of scope.** A travel agency/TMC sending a voucher for a hotel stay could remain in scope even if it was automated, said “do not reply,” or mentioned Amadeus/GDS. The task and source workflow mattered; sender/domain alone did not decide it.

The current `PRODUCT.md` says to skip OTA/channel/automated/spam at the front door, while preserving travel-agent mail. The corpus frame did not implement that as a pre-LLM removal gate. Therefore these counts are a **classification study over all inbound**, not a measured count of messages remaining after a future front-door filter. Also, the saved inbound output has no dedicated reliable `automated_ota` count. We cannot state from the current structured labels exactly how many of the 3,152 excluded messages were OTA automation versus another excluded class.

## Historical hard-coded front-door domains

The older executable source registry in [`mail-source-rules.js`](../../../../apps/server-pilot/config/mail-source-rules.js) routed known source mail to the automated/channel path. Domains registered there:

| Rule family | Domains |
|---|---|
| OTA / channel | `synxis.com`; `expediapartnercentral.com`; `m.expediapartnercentral.com`; `expedia.com`; `webbeds.com`; `hotelbeds.com`; `booking.com`; `get-e.com`; `hotels.com`; `agoda.com`; `trip.com`; `traveloka.com`; `airbnb.com`; `tiket.com`; `profitroom.com` |
| Review / system | `reviewpro.com`; `trustyou.com`; `revinate.com`; `medallia.com`; `tripadvisor.com`; `hospitality.cloud` |

This registry was not a blanket sender-domain denylist: it could classify a known service in a forwarded message by its embedded sender/subject; human Profitroom contact-form enquiries remained direct mail; H-Pay was skipped only for secure-payment-link notices, while finance mail stayed in triage.

The owner's historical exclusion note separately names **Profitroom, Tiket.com, RateTiger, and H-Pay (`hospitality.cloud`)**, with **Travelit and TBO explicitly in scope** ([product detail](../../../../docs/context/PRODUCT-DETAIL.md), [original ask](../../../../PRODUCT-ASKS-HISTORY.md)). RateTiger appears in that owner note, but I found no RateTiger domain entry in the executable registry; the exact host is not recorded there. The source code's `never-spam` list is the opposite of a blocklist: `legacyhotels.co.za` and `mail.legacyhotels.com` were protected from spam classification ([`never-spam.ts`](../../../../apps/server-pilot/src/ai/never-spam.ts)).

## Main-window results

| Stage / measure | Count | Denominator / meaning |
|---|---:|---|
| Deduplicated inbound | **4,516** | All inbound in 26 Sep–30 Oct window |
| Actionable reservation email | **1,361** | 30.1% of all inbound |
| Not actionable / outside the reservation scope | **3,152** | 69.8% of all inbound |
| Reservation relevance unclear | **2** | Insufficient evidence; do not silently force into yes/no |
| Provider-blocked | **1** | Azure content filter; remains unclassified |
| Potentially assistable by planned Nava workflow | **1,007** | 74.0% of 1,361 actionable; 22.3% of all inbound |
| Actionable but classifier said Nava cannot help | **344** | 25.3% of actionable |
| Helpability undecided | **10** | 0.7% of actionable |
| Large group (>10 rooms) marker | **82** | Overlapping marker; group-only work excluded from 1,007 |

Checks: 3,152 + 1,361 + 2 + 1 = 4,516. Within the 1,361 actionable: 1,007 + 344 + 10 = 1,361.

The 1,007 is a **what-could-Nava-assist-with estimate**, not emails actually handled by Nava. At the time of this analysis the workflows were not all deployed for staff. The estimate assumes the named planned capabilities work. Staff approval counts as assistance; this is not an unattended-automation percentage. Group-only work is excluded; a distinct supported task on the same email can still count. The action tags overlap, so workflow rows must not be added to produce a total.

## Reservation workflow breakdown

The first numeric column below counts action tags on the 1,361 actionable inbound emails. The second is the later, separate action-detail pass's count of rows with a supported action of that type. Counts can overlap within one email, and the passes need not agree exactly.

| Workflow tag | Tagged actionable inbound | Supported action in detail pass |
|---|---:|---:|
| Supplied voucher / file voucher | 372 | 367 |
| Stay invoice | 250 | 226 |
| Booking/create | 204 | 178 |
| Quote | 175 | 138 |
| Amendment | 118 | 95 |
| Payment request / collection | 112 | 42 |
| Supplied proof of payment / file proof | 90 | 84 |
| Cancellation | 46 | 41 |
| Other reservation task | 327 | 85 |
| Group marker (>10 rooms) | 82 | Not itself a supported action |

`Other` and `payment_request` do not by themselves establish helpability. Collecting/requesting payment is distinct from filing a supplied proof. Invoice counts include invoice requests; an automatically generated HMS confirmation may satisfy part of an invoice-request workflow, but its presence does not prove Nava sent anything. A supplied proof/voucher is a filing workflow; a text/filename inference is not document-content verification.

The 1,007 headline count comes from the opportunity classifier's `can_help` decision, not by summing the detail column. The detail pass identified **21 helpable emails with no proposed action step**. Preserve that limitation when using action counts downstream.

## Sender-domain context

Top all-inbound sender domains:

| Domain | Email records |
|---|---:|
| legacyhotels.co.za | 1,135 |
| synxis.com | 478 |
| gmail.com | 207 |
| grfeedback-b.com | 202 |
| booking.com | 172 |

Top domains among actionable reservation inbounds:

| Domain | Email records |
|---|---:|
| legacyhotels.co.za | 138 |
| gmail.com | 124 |
| nexustravel.co.za | 110 |
| travelit.co.za | 102 |
| atlantiscorporate.co.za | 59 |

These are sender domains, not customers, unique organizations, or classifications. Internal, auto-generated, and unrelated messages can share a domain. A domain is not a safe auto-filter by itself.

## Outbound mail and reply context

Outbound was **not** counted as inbound. It was classified separately and used as context for candidate reply/action analysis.

| Outbound type (exclusive classifier labels) | Count |
|---|---:|
| Staff-written candidate | 1,074 |
| PMS confirmation-template candidate | 886 |
| Other | 93 |
| Other automated | 4 |
| Unknown | 10 |
| **Total outbound records** | **2,067** |

A separate automation estimate marks **890 yes**, **1,143 no**, and **34 unknown**. The 886 PMS-template label is a heuristic, not proof of unattended delivery; the two classifications are related but not identical.

Reply-link analysis estimated 753 actionable inbounds with at least one linked reply. The inbound-response table gives 619 staff-only and 104 staff-plus-PMS cases, i.e. **723 staff-linked inbounds**. The separately saved reply-link metric says **722**; reconcile this one-record mismatch before using an exact staff-linked count in a deck. Another run summary reports **648 distinct external staff replies**; that is outbound messages, not inbound requests. These candidate links are imperfect: one reply can link to several inbounds, an inbound can have several replies, a missing link does not prove no reply, and later replies informed some retrospective labels.

The cross-thread candidate search used direct reply headers (no time limit), same-thread candidates (up to seven days), and same sender/recipient candidates (up to 72 hours); reverse search from sent mail supplemented candidates, capped at three inbound candidates per outbound. Luna checked whether the candidate addressed the same stay and task. This is a reviewable estimate, not a complete deterministic linker.

## Models, evidence quality, confidence

- Main classifier: GPT-6 Luna medium prompt/review layers, followed by source-bound corrections. Separate Luna max group-context reviews. Action-detail calls completed for all 1,361 actionable records. Calls used `store:false`; model calls and correction sources are recorded in the private run artifacts.
- Coverage: 4,515/4,516 inbound got a model result; one provider content-filter block remained. Two additional records have unresolved reservation relevance. These are distinct conditions.
- Blind comparison: on a fresh sample against the frozen earlier classification, help decisions agreed on **138/150 random** records and exact workflow sets on **123/150**. On a targeted sample, help decisions agreed on **91/99** completed cases; one of 100 timed out. Both reviewers were from the Luna model family. These are agreement measures, **not measured accuracy** or human gold labels. Final source-bound corrections happened after the random v28 comparison.
- Attachment limits: 4,514 MIME inventories succeeded; 1,411 had attachments. Of 452 cases selected for document inspection, 354 yielded useful bounded text. For voucher-tagged messages, extracted PDF text was available in 181; 191 had no extracted-PDF addendum. Missing extraction is not proof the file was empty or irrelevant.
- No independent human-labelled corpus exists, so no defensible “98% accurate” or “2% error” claim can be made. Treat 1,007 and 74.0% as useful, fairly mature **heuristic estimates**, not guaranteed truth. Main risk areas: OTA/agency boundary, partial or quoted requests, group size/context, reply linkage, attachment inference, and temporal leakage from later replies.
- Historical synthetic edge cases are not evidence of real-mail accuracy. The bulk estimates came from real Centurion records; the later blind comparison also used real packets.

## Decisions made — and rationale

1. **Inbound-led denominator:** email arriving at the property is the unit Nava may triage. Outbound can help infer observed staff/PMS action but is not itself an inbound reservation request.
2. **Count first; classify after:** preserve total demand, then show actionable and helpable subsets. This avoids hiding an important category inside an undocumented filter.
3. **Opportunity, not adoption:** ask “what could Nava have assisted with?” rather than claiming Nava did handle it. The product was not fully live for staff.
4. **Separate actionable from assistable:** staff work can be real and important yet outside Nava's current/planned workflow (e.g. OTA-originated tasks or payment collection).
5. **Track groups but scope them out:** one shared block of >10 rooms gets a group marker and stays visible in reservation demand; group-only work does not inflate the non-group opportunity estimate.
6. **Allow overlapping workflow tags:** one email may ask for a booking and an invoice, or include a supplied document. Do not force multiple actions into one mutually exclusive primary label.
7. **Partial work/staff approval count as assisted:** these metrics are not a claim of fully automated handling.
8. **Use real follow-up context, cautiously:** replies/attachments help explain what happened or what the request meant, but make the result retrospective, not a clean “what the model knew at arrival” benchmark.

## Reproduction and artifact map

The source records and model packets are private and are **not embedded** in this shareable note. Repo paths below let an authorized project developer reproduce the aggregate locally.

| Artifact | What it is for |
|---|---|
| [`corpus-analysis/2026-11-02-centurion-corpus-run.md`](../corpus-analysis/2026-11-02-centurion-corpus-run.md) | Main result, run provenance, quality caveats, replay commands |
| [`b2b-dashboard/2026-11-02-inbound-led-report.md`](2026-11-02-inbound-led-report.md) | Inbound-led counts, workflow detail, replies and linker overview |
| [`corpus-analysis/METHOD.md`](../corpus-analysis/METHOD.md) | Repeatable end-to-end procedure and reusable scripts |
| `corpus-analysis/mailbox-snapshot-export.py` | Select/export date-bounded source snapshots |
| `corpus-analysis/mailbox-frame-build.py` | Build inbound/outbound/manifest frame; verify mappings and dedupe |
| `corpus-analysis/mailbox-mime-index.py`, `mailbox-augment-attachments.py` | Inventory MIME and join attachment evidence |
| `corpus-analysis/mailbox-attachment-batch.py`, `centurion-attachment-evidence.py` | Selectively extract bounded document evidence |
| `corpus-analysis/mailbox-reply-candidate-supplement.py`, `mailbox-merge-candidate-supplement.py` | Add reverse-search reply candidates and source mappings |
| `corpus-analysis/luna-corpus-runner.py` | Run one-email LLM calls with prompt/input/model provenance |
| `corpus-analysis/mailbox-compose-reviewed.py`, `mailbox-dataset-join.py` | Overlay reviewed layers, validate provenance, join per-email results |
| `corpus-analysis/centurion-aggregate-opportunity.py`, `luna-action-details.py` | Aggregate opportunity and derive proposed task/action detail |
| `b2b-dashboard/inbound-led-summary.py` | Reproduce inbound-led report from the saved final dataset |
| `b2b-dashboard/future-scope-summary.py` | Reproduce the distinct 30-day future-workflow split |

Private final main dataset: `.private/centurion-opportunity-october-20261101/bulk-v22-effective/dataset-final-v32.jsonl` (4,516 inbound rows with source mapping, classifications, candidate replies, action details and provenance). Private aggregate: `.private/centurion-opportunity-october-20261101/bulk-v22-effective/metrics-final-v30.json`. The inbound-led report records source SHA-256 `7c95be34030929e6bf1ceae35ad209cdffefcc47db65d7bbf16ed7f572540a7d`.

Main and 30-day reports can be recomputed from the saved results with no LLM calls:

```bash
python3 -B docs/research/halloween/b2b-dashboard/inbound-led-summary.py \
  --dataset .private/centurion-opportunity-october-20261101/bulk-v22-effective/dataset-final-v32.jsonl \
  --output .private/centurion-opportunity-october-20261101/inbound-led-summary-replay.json

python3 -B docs/research/halloween/b2b-dashboard/future-scope-summary.py \
  --dataset .private/centurion-opportunity-october-20261101/bulk-v22-effective/dataset-final-v32.jsonl \
  --start 2026-09-30T17:00:00+02:00 --end 2026-10-30T17:00:00+02:00 \
  --accept-uncertain I02189 I02190 I03342 I04009 \
  --output .private/centurion-opportunity-october-20261101/future-scope-replay.json
```

Choose new output paths; the scripts refuse to overwrite. Do not send private source rows or credentials into code/decks. For DaVinci or a new Centurion window, build a new property-verified frame and apply a versioned policy; do not transfer these rates or silently inherit the old classifier's OTA/automation treatment.

## Safe wording for a deck

> In 4,516 deduplicated inbound Centurion emails received from 26 September to 30 October 2026, the research classifier identified 1,361 reservation-work emails. It estimated 1,007 (74%) as potentially assistable by the planned Nava workflows, including work that would still require staff approval. This is a retrospective LLM estimate, not actual Nava usage or a human-validated accuracy result. Automated/OTA mail was not pre-filtered from the 4,516 denominator; it was judged during semantic classification, and exact automated-OTA volume is not yet separately measured.

If the slide is explicitly a “last 30 days” view, use the separate **4,006** denominator and rerun/restate all numerator metrics on that same window. Never put 4,006 beside a numerator from the 4,516-message window.
