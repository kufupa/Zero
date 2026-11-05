# B2B dashboard: Centurion opportunity analysis

**Purpose:** Estimate how often planned Nava workflows could help with real Centurion reservation email. This is a retrospective opportunity estimate, not measured Nava usage, a production triage score, or a count of completed PMS writes.

**Current view:** [Inbound-led report](2026-11-02-inbound-led-report.md) focuses on reservation requests and uses linked staff/PMS replies as evidence. It reuses the saved classifications without a new model run.

**Owner direction after this run:** Use real emails for future edge-case tests. For Centurion, treat a matching staff acknowledgement of receiving a supplied proof of payment as evidence that staff filed it, based on the owner's knowledge of the process. Preserve the literal acknowledgement separately from the inferred filing; neither means payment settled. The saved action labels below predate this direction and have not been recalculated.

## Results

Times are South African time; the end of each window is exclusive. The earlier window is the available archive, not proof that older mail does not exist. An email is the unit; counts are not guests, bookings, threads or staff hours.

| Window | Raw → deduplicated inbound | Raw → deduplicated outbound | Actionable reservation emails | Potential Nava help | >10-room group emails |
|---|---:|---:|---:|---:|---:|
| 26 Sep 00:00–30 Oct 17:00, 2026 | 4,719 → 4,516 | 2,099 → 2,067 | 1,361 | 1,007 / 1,361 = 74.0% | 82 |
| 27 Jul 00:00–26 Sep 00:00, 2026 | 6,637 → 6,635 | 2,809 → 2,497 | 2,109 | 1,420 / 2,109 = 67.3% | 178 |

Actionable reservation emails include some internal instructions; they are not all customer-sent or verified to have replies. OTA/channel work is excluded. The denominator retains unsupported reservation tasks and large-group work. Groups are a shared request for **more than 10 rooms**. Group-only work is excluded from potential help, but a separate non-group task can count. Partial help and human approval count. Quotes, creates, amendments, cancellations, reservation invoices and filing supplied vouchers/payment proofs are assumed to work in this opportunity model; this does not establish current implementation.

| Overlapping helpable workflow tags | Main window | Earlier archive |
|---|---:|---:|
| Supplied voucher filing | 371 | 424 |
| Reservation invoice | 230 | 324 |
| Booking/create | 188 | 281 |
| Quote | 139 | 271 |
| Amendment | 96 | 134 |
| Supplied payment-proof filing | 88 | 115 |
| Cancellation | 41 | 71 |

These tags can overlap on one email. A request to collect or make a payment is separate from a supplied proof and is not helpable by itself: it appears in 112 main and 185 earlier actionable emails; 42 and 63 respectively also have another supported opportunity. Of 250 main invoice emails, 15 linked to a staff-sent invoice, 49 to a PMS confirmation candidate and 186 had no linked invoice reply. Earlier counts: 63, 14 and 286 of 363.

[Breakdown of the 327 emails tagged other](2026-11-02-other-breakdown.md): guest logistics 101, payment/banking 85, booking confirmation/status 45, and smaller categories. This later real-email review is descriptive and does not change the original opportunity counts.

### All inbound workflow labels

Counts below cover **all 1,361 actionable emails** in the main window, not only the 1,007 judged helpable. Labels overlap.

| Label | Actionable emails | Meaning |
|---|---:|---|
| `quote` | 175 | Stay rates or availability |
| `booking` | 204 | Create a reservation |
| `amendment` | 118 | Change an existing stay |
| `cancellation` | 46 | Cancel a stay |
| `payment_proof` | 90 | Supplied proof for filing |
| `voucher` | 372 | Supplied booking voucher for filing |
| `invoice` | 250 | Request a hotel-issued stay invoice |
| `payment_request` | 112 | Ask for or process payment; not a supported task by itself |
| `group` | 82 | Marker for a shared block of more than 10 rooms |
| `other` | 327 | Other reservation work, such as a status check |

For the 372 main-window `voucher` emails, the model received Poppler-extracted PDF snippets for 181. The other 191 had no extracted document content in the final packet: 187 were not selected for extraction and four yielded no usable excerpt. Those labels use the email, attachment metadata and sometimes replies; 372 is not a count of independently verified vouchers. The separate action-detail pass recorded `file_voucher` for 367 of the 372; the other five need review. See the [dataset](../../../../.private/centurion-opportunity-october-20261101/bulk-v22-effective/dataset-final-v32.jsonl) and [extraction outcomes](../../../../.private/centurion-opportunity-october-20261101/bulk-v22-effective/attachment-enriched-manifest.json).

The LLM also records whether the email is actionable, whether Nava could help, matched replies, response type and invoice handling. Outbound type labels are `staff_written`, `pms_confirmation_template`, `other_automated`, `other` and `unknown`. Actual OTA/channel notices were excluded here but do not have their own structured inbound tag in these saved labels. The action-detail schema separately distinguishes filing a supplied voucher from issuing a new voucher.

| Outbound or reply estimate | Main window | Earlier archive |
|---|---:|---:|
| Staff-written outbounds, all audiences | 1,074 | 1,663 |
| PMS confirmation template candidates, all audiences | 886 | 613 |
| Actionable inbound with at least one linked reply | 753 | 630 |
| Distinct external staff replies linked to reservation inbound | 648 | 447 |
| Those linked to potentially helpable inbound | 511 (78.9%) | 314 (70.2%) |

Reply links and template types are model estimates, not proof of delivery or unattended sending. An outbound may link to multiple inbounds. A reply linked to a helpable inbound does not prove Nava could send that particular reply. The earlier reply search/audit is less complete than the main run. External means an external To/Cc was observed; missing recipient fields and Bcc limit that count.

Main-window actionable sender domains: `legacyhotels.co.za` 138, `gmail.com` 124, `nexustravel.co.za` 110, `travelit.co.za` 102, `atlantiscorporate.co.za` 59. Domains alone do not establish a workflow.

## What we did

1. **Used real mail.** Read saved Centurion snapshots `centurion-nine-day-bfcd9949-591f-4c9a-b061-3679ec793b51` and `centurion-nine-day-8774dd09-e874-46f8-bed7-a24e4c282711`, selected the two windows and deduplicated transport copies by direction, normalized Message-ID, sender and subject. Preserved source IDs and mappings. This yielded 11,151 inbound and 4,564 outbound emails.
2. **Made model packets.** Removed repeated quoted history, HTML/images, links and credentials; retained bounded current and relevant earlier text. Inventoried available original MIME, filenames and attachments; extracted bounded text from selected PDFs/spreadsheets when material. Missing data is not recorded as a missing attachment.
3. **Searched for replies.** Direct reply headers take priority. Otherwise, candidates can share a thread within 7 days or have the same sender/recipient within 72 hours; direct-header matches have no such time cap. The main run also searched backwards from outbound messages and re-reviewed missed links. Candidates are hints, not matches: Luna checks the same request and stay. The 72-hour rule is not a special Monday rule and can miss replies after long weekends.
4. **Classified with GPT-6 Luna.** The bulk pass used `gpt-6-luna` at medium effort. It labelled each inbound as actionable reservation work or not; identified one or more workflows, >10-room group scope, prospective help and matching replies. A separate pass classified outbound staff-written and PMS-template candidates. Calls were `store:false`; the owner confirmed the configured Azure route. Provider and sensitive-data holds stayed in the frame.
5. **Recorded proposed actions.** A second Luna pass described each actionable email's requested tasks, hypothetical Nava steps and what linked staff/PMS replies actually say. The owner later supplied the Centurion filing rule above; the stored rows still retain the original observations. A reply does not establish payment settlement. Later completion does not erase the original hypothetical opportunity.
6. **Reviewed and corrected patterns.** Rechecked group-only help, document evidence, cross-thread replies and classification disagreements. For group context, a subject-based search surfaces related messages; an LLM and source inspection check the same stay and room block before any correction. Original results and source-hashed corrections are kept. The main and earlier group searches were within each window; future runs should search the property's full history before slicing periods.
7. **Counted and verified.** Aggregated the versioned labels and distinct reply links. Both final datasets reproduced byte-for-byte; final metrics, labels and action inputs replayed from saved layers. The main bulk finished within two hours, so the owner-authorized earlier archive was also processed.

### Real example

Main case `I00020`, original subject **“Proof of payment 2”**: the sender wrote “Please find the attached proof of payment” and supplied one PDF. The classifier treated the proof as a document to file; the action pass proposed reviewing and filing it. Staff replied “Thank you for the POP well received.” The saved row records acknowledgement only; the owner says this acknowledgement means it was filed. The meaning of “2” is not established by the email. See the [main dataset](../../../../.private/centurion-opportunity-october-20261101/bulk-v22-effective/dataset-final-v32.jsonl).

## Confidence and limitations

**Assessment:** Moderate confidence that the main run reveals a substantial opportunity; low confidence in the exact percentage, individual workflow counts and reply links. Confidence is lower for the earlier archive because attachment access was poor. These are research judgments, not measured accuracy scores.

| Check | Observed result | Meaning |
|---|---|---|
| Fresh random blind review of frozen main v28 | Luna medium-derived labels and Luna max agreed on help for 138/150; exact workflow sets 123/150. | **Model agreement**, not accuracy; same model family, different review prompt. Final v30 had later corrections. |
| Random cases either run called helpable | Both agreed on 30/40. | Ten potentially important positive cases disagreed; overall agreement is inflated by easy negatives. |
| Separate targeted review | Help decisions agreed on 91/99; one of 100 calls timed out. | Useful for finding boundary failures; not a random population estimate. |
| Synthetic fixtures | 75/75 expected labels matched. | These are made-up test emails for known edge cases, not evidence of real-world accuracy. |
| Reply audit | Recovered edges: 35 clear, 7 wrong, 4 ambiguous out of 46. Baseline sample: 38 clear, 1 wrong, 1 ambiguous out of 40. | Diagnostic model/agent review; samples do not establish population precision. |

There is no independent human-labelled gold set and no defensible overall accuracy percentage or ±2% error margin from these checks. The headline percentages are directional estimates suitable for discussion, not guaranteed live performance. Classification and action passes could see later replies; a live, arrival-only triage test is still needed.

Action-detail calls returned successfully for 1,361/1,361 main and 2,109/2,109 earlier actionable emails, but 21 main and 50 earlier helpable emails have no proposed Nava steps. Action/group disagreements and 7/27 related-group candidates are flagged. There are 111 main and 143 earlier action states that may reflect later reply evidence. One main inbound was provider-filtered; one earlier was withheld locally and another failed at the provider. They remain unclassified.

Original MIME was inventoried for 4,514/4,516 main inbound emails, including 1,411 with attachments. Only 214/6,635 earlier originals were retrievable. Among selected email cases, 354/452 main and 44/67 earlier yielded useful bounded document text. Earlier attachment-dependent and group-size estimates are less certain. No verified dollar-cost total was recorded.

**Recommended next check:** re-review positive disagreements with arrival-only inputs, then apply the same frame, attachment and reply method to DaVinci. Do not reuse Centurion-specific sources, categories or numbers without checking the new property.

## Artifacts, prompts and repeatability

- [Complete Centurion run record and copyable replay commands](../corpus-analysis/2026-11-02-centurion-corpus-run.md); [reusable method](../corpus-analysis/METHOD.md); [case evidence index](../corpus-analysis/2026-11-02-case-evidence-index.md); [earlier pilot record](../corpus-analysis/2026-11-02-centurion-early-run.md).
- Final per-email candidate datasets: [main](../../../../.private/centurion-opportunity-october-20261101/bulk-v22-effective/dataset-final-v32.jsonl) and [earlier](../../../../.private/centurion-opportunity-october-20261101/pre-sep26-v24/dataset-final-v5.jsonl). Rows include the source, classification, requested actions, proposed Nava steps, observed replies, provenance and quality flags.
- Saved result files: [main metrics](../../../../.private/centurion-opportunity-october-20261101/bulk-v22-effective/metrics-final-v30.json), [main outbound audience](../../../../.private/centurion-opportunity-october-20261101/bulk-v22-effective/outbound-audience-final-v30.json), [earlier metrics](../../../../.private/centurion-opportunity-october-20261101/pre-sep26-v24/metrics-final-v4.json), [earlier outbound audience](../../../../.private/centurion-opportunity-october-20261101/pre-sep26-v24/outbound-audience-final-v4.json), [blind comparison](../../../../.private/centurion-opportunity-october-20261101/bulk-v22-effective/blind-holdout-second/comparison.json), [main corrections](../../../../.private/centurion-opportunity-october-20261101/bulk-v22-effective/audit-corrections-v30.json), [earlier corrections](../../../../.private/centurion-opportunity-october-20261101/pre-sep26-v24/audit-corrections-v4.json).
- Main inbound prompts: [v17](../corpus-analysis/2026-11-02-centurion-opportunity-prompt-v17.md), [v18](../corpus-analysis/2026-11-02-centurion-opportunity-prompt-v18.md), [v18 reply](../corpus-analysis/2026-11-02-centurion-opportunity-prompt-v18-reply-review.md), [v18 conference](../corpus-analysis/2026-11-02-centurion-opportunity-prompt-v18-conference-review.md), [v18 group](../corpus-analysis/2026-11-02-centurion-group-review-v18.md), [v22](../corpus-analysis/2026-11-02-centurion-opportunity-prompt-v22-combined-review.md), [v23 envelope](../corpus-analysis/2026-11-02-centurion-opportunity-prompt-v23-envelope-review.md), [v24 semantic/reply](../corpus-analysis/2026-11-02-centurion-opportunity-prompt-v24-quote-review.md). Earlier archive: [v24](../corpus-analysis/2026-11-02-centurion-opportunity-prompt-v24-quote-review.md) and [v26 document review](../corpus-analysis/2026-11-02-centurion-opportunity-prompt-v26-general.md).
- [Outbound](../corpus-analysis/2026-11-01-luna-outbound-prompt.md), [group-context review](../corpus-analysis/2026-11-02-centurion-group-context-review-prompt-v27.md), [blind review](../corpus-analysis/2026-11-02-centurion-blind-review-prompt-v5.md), and action-detail prompts [v4](../corpus-analysis/2026-11-02-luna-action-details-prompt-v4.md), [v6](../corpus-analysis/2026-11-02-luna-action-details-prompt-v6.md), [v7](../corpus-analysis/2026-11-02-luna-action-details-prompt-v7.md). Saved layers bind prompts, inputs and model settings with hashes.
- Recreate final datasets with [dataset wrapper](../corpus-analysis/centurion-20261102-datasets.sh); recreate metrics with [main aggregate replay](../corpus-analysis/centurion-20261102-final-replay.sh) and [earlier aggregate replay](../corpus-analysis/centurion-20261102-historical-replay.sh). Use the exact correction-file arguments and fresh output paths in the run record. Main wrapper defaults to historic v29; final main metrics require explicit v30.

## Complete script inventory

All `.py` and `.sh` files in `corpus-analysis/` at documentation time are indexed below. The list includes earlier pilots and optional helpers; it does **not** imply that every script ran in both final windows. See the method and replay wrappers for each stage and the exact final layers.

### Centurion-specific replay and helpers

- [centurion-20261102-datasets.sh](../corpus-analysis/centurion-20261102-datasets.sh)
- [centurion-20261102-final-replay.sh](../corpus-analysis/centurion-20261102-final-replay.sh)
- [centurion-20261102-historical-replay.sh](../corpus-analysis/centurion-20261102-historical-replay.sh)
- [centurion-20261102-replay.sh](../corpus-analysis/centurion-20261102-replay.sh)
- [centurion-aggregate-opportunity.py](../corpus-analysis/centurion-aggregate-opportunity.py)
- [centurion-attachment-evidence.py](../corpus-analysis/centurion-attachment-evidence.py)
- [centurion-attachment-review-helper.py](../corpus-analysis/centurion-attachment-review-helper.py)
- [centurion-followup-copy-review-selector.py](../corpus-analysis/centurion-followup-copy-review-selector.py)
- [centurion-range-prepare.py](../corpus-analysis/centurion-range-prepare.py)
- [centurion-recent-tail.py](../corpus-analysis/centurion-recent-tail.py)
- [centurion-recover-empty-mime.py](../corpus-analysis/centurion-recover-empty-mime.py)
- [centurion-run-group-review.py](../corpus-analysis/centurion-run-group-review.py)
- [centurion-xls-evidence.py](../corpus-analysis/centurion-xls-evidence.py)

### Reusable mailbox utilities

- [mailbox-action-changed-selection.py](../corpus-analysis/mailbox-action-changed-selection.py)
- [mailbox-action-rerun-selection.py](../corpus-analysis/mailbox-action-rerun-selection.py)
- [mailbox-attachment-batch.py](../corpus-analysis/mailbox-attachment-batch.py)
- [mailbox-attachment-evidence-merge-batch.py](../corpus-analysis/mailbox-attachment-evidence-merge-batch.py)
- [mailbox-augment-attachments.py](../corpus-analysis/mailbox-augment-attachments.py)
- [mailbox-augment-inbound-envelope.py](../corpus-analysis/mailbox-augment-inbound-envelope.py)
- [mailbox-augment-outbound-attachments.py](../corpus-analysis/mailbox-augment-outbound-attachments.py)
- [mailbox-available-attachment-selection.py](../corpus-analysis/mailbox-available-attachment-selection.py)
- [mailbox-clean-text.py](../corpus-analysis/mailbox-clean-text.py)
- [mailbox-compose-reviewed.py](../corpus-analysis/mailbox-compose-reviewed.py)
- [mailbox-dataset-join.py](../corpus-analysis/mailbox-dataset-join.py)
- [mailbox-frame-build.py](../corpus-analysis/mailbox-frame-build.py)
- [mailbox-freeze-comparison.py](../corpus-analysis/mailbox-freeze-comparison.py)
- [mailbox-group-context-review-select.py](../corpus-analysis/mailbox-group-context-review-select.py)
- [mailbox-group-scope-review-select.py](../corpus-analysis/mailbox-group-scope-review-select.py)
- [mailbox-merge-candidate-supplement.py](../corpus-analysis/mailbox-merge-candidate-supplement.py)
- [mailbox-mime-index.py](../corpus-analysis/mailbox-mime-index.py)
- [mailbox-mime-merge-shards.py](../corpus-analysis/mailbox-mime-merge-shards.py)
- [mailbox-outbound-audience-report.py](../corpus-analysis/mailbox-outbound-audience-report.py)
- [mailbox-quote-scope-review-select.py](../corpus-analysis/mailbox-quote-scope-review-select.py)
- [mailbox-reply-candidate-supplement.py](../corpus-analysis/mailbox-reply-candidate-supplement.py)
- [mailbox-reply-review-overlay.py](../corpus-analysis/mailbox-reply-review-overlay.py)
- [mailbox-response-review-select.py](../corpus-analysis/mailbox-response-review-select.py)
- [mailbox-sample-review.py](../corpus-analysis/mailbox-sample-review.py)
- [mailbox-semantic-review-select.py](../corpus-analysis/mailbox-semantic-review-select.py)
- [mailbox-snapshot-export.py](../corpus-analysis/mailbox-snapshot-export.py)
- [mailbox-unlinked-reply-review-select-v1.py](../corpus-analysis/mailbox-unlinked-reply-review-select-v1.py)
- [mailbox-unlinked-reply-review-select-v2.py](../corpus-analysis/mailbox-unlinked-reply-review-select-v2.py)

### 250-email pilot utilities

- [pilot-250-analysis.py](../corpus-analysis/pilot-250-analysis.py)
- [pilot-250-arbitrate.py](../corpus-analysis/pilot-250-arbitrate.py)
- [pilot-250-audit.py](../corpus-analysis/pilot-250-audit.py)
- [pilot-250-challenge.py](../corpus-analysis/pilot-250-challenge.py)
- [pilot-250-local-selftest.py](../corpus-analysis/pilot-250-local-selftest.py)
- [pilot-250-old-export-audit.py](../corpus-analysis/pilot-250-old-export-audit.py)
- [pilot-250-outcomes.py](../corpus-analysis/pilot-250-outcomes.py)
- [pilot-250-overlap-summary.py](../corpus-analysis/pilot-250-overlap-summary.py)
- [pilot-250-payment-document-audit.py](../corpus-analysis/pilot-250-payment-document-audit.py)
- [pilot-250-payment-document-summary.py](../corpus-analysis/pilot-250-payment-document-summary.py)
- [pilot-250-prepare.py](../corpus-analysis/pilot-250-prepare.py)
- [pilot-250-renormalize.py](../corpus-analysis/pilot-250-renormalize.py)
- [pilot-250-review.py](../corpus-analysis/pilot-250-review.py)
- [pilot-250-room-audit.py](../corpus-analysis/pilot-250-room-audit.py)
- [pilot-250-select.py](../corpus-analysis/pilot-250-select.py)
- [pilot-250-synthetic-eval.py](../corpus-analysis/pilot-250-synthetic-eval.py)
- [pilot-250-task-summary.py](../corpus-analysis/pilot-250-task-summary.py)

### October frame and opportunity experiments

- [october-frame-bridge.py](../corpus-analysis/october-frame-bridge.py)
- [october-fresh-extras.py](../corpus-analysis/october-fresh-extras.py)
- [october-opportunity-model.py](../corpus-analysis/october-opportunity-model.py)
- [october-opportunity-sample.py](../corpus-analysis/october-opportunity-sample.py)

### Luna, comparison and count utilities

- [compare-blind-review.py](../corpus-analysis/compare-blind-review.py)
- [luna-action-details.py](../corpus-analysis/luna-action-details.py)
- [luna-corpus-runner.py](../corpus-analysis/luna-corpus-runner.py)
- [luna-v14-synthetic-regression-check.py](../corpus-analysis/luna-v14-synthetic-regression-check.py)
- [rank-inbound-domains.py](../corpus-analysis/rank-inbound-domains.py)
- [rank-outbound-domains.py](../corpus-analysis/rank-outbound-domains.py)
- [recheck-centurion-census.py](../corpus-analysis/recheck-centurion-census.py)
- [source-origin-counts.py](../corpus-analysis/source-origin-counts.py)
