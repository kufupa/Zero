# Handoff: Centurion corpus research and gold-dataset opportunity

Prepared 2026-11-05. This is a handoff of the conversation and read-only local research, not an instruction to launch a new experiment.

## Owner's objective

The owner wants to use past Centurion corpus analyses to assemble real, source-linked examples for extraction prompt optimization. The intended shape is: **inbound email and actual attachments → relevant staff/outbound messages and confirmation → corresponding HMS booking fields**. The owner proposes using HMS as extraction reference data and the original email/voucher as input evidence. Establish field-level truth carefully: later HMS state may differ from the state at the time of the original request.

The immediate questions were: what existing analyses, datasets and scripts exist; what are their date ranges and limitations; what is actually useful; and how were the 10,549 cross-thread candidates and the B04/B06 examples found? The owner is especially interested in recovering actual vouchers and proof-of-payment (POP) attachments, and regards B04/B06 as promising. They suspect the older conversation-linking code may be poor; examine it critically rather than assuming that it was used for the recent research.

Another LLM was separately investigating the previous classification run's elapsed time and parallelism. The owner explicitly said not to worry about that work. Do not assume its results or interfere with it.

## Read this first

1. [Booking journey findings](../research/halloween/corpus-experiments/booking-journeys.md) and private case packets [B04](../../.private/corpus-experiments-20261030/B04-review-private.json), [B06](../../.private/corpus-experiments-20261030/B06-review-private.json).
2. [Confirmation-PDF candidate dataset](../research/halloween/centurion-confirmation-pdf-dataset.md), particularly its selection and caveats.
3. [November opportunity run](../research/halloween/corpus-analysis/2026-11-02-centurion-corpus-run.md) and [inbound-led report](../research/halloween/b2b-dashboard/2026-11-02-inbound-led-report.md).
4. [Five-day corpus](../research/halloween/2026-10-30-centurion-five-day-corpus.md) and [month source inventory](../research/halloween/corpus-experiments/month-source-inventory.md).

Private paths below are local to this machine and Git-ignored; they may not exist on another host or checkout. They contain guest data. This handoff intentionally includes no guest-level values. Preserve the privacy rules of the underlying research, and do not send raw emails, attachment content or credentials to external services without appropriate authorization. Follow `/usr/local/share/nava-codex/AGENTS.md` and this workspace's `AGENTS.md`; never test against pilot RDS without owner approval. Preserve unrelated sessions' work.

## Main finding: cross-thread booking reconstruction exists

The five-day study covered **19–23 October 2026**, with **1,288 saved messages, 92 selected outbound confirmation PDFs and 87 filename-derived confirmation tokens**. Researchers selected 10 PDF anchors for exploratory review, not a random sample. See [selection code](../research/halloween/corpus-experiments/select-booking-cases.py) and [review helper](../research/halloween/corpus-experiments/review-booking-case.py).

For each outbound PDF the selector took its filename confirmation token, then searched the five-day slice for prior same-thread messages, the same token in other threads, and earlier inbound messages from an address among the PDF's recipients. It scored the *PDF anchor* based on whether each signal existed: +4 cross-thread token, +3 prior same-thread inbound, +2 prior same-thread outbound, +1 prior same-recipient inbound. It selected one strong anchor and one harder one per date. Same-address and token hits were candidate signals, not established links.

The subsequent source review found:

- **B04:** An inbound request links to a staff reply by `Message-ID`/`In-Reply-To`; the staff reply gives the exact confirmation number on a PDF in another thread. The PDF recipient, request sender, guest and dates agree. The same sender also requested another guest, demonstrating why address alone can mislink. The original request did not itself contain the confirmation number.
- **B06:** The prior-day inbound request links by reply header to a staff reply that gives the PDF's confirmation number and asks for a voucher. A later inbound and exchange mention that number. The original request did not itself contain the number. The later inbound's November MIME inventory records one **voucher-named `application/pdf` attachment**; its saved classifier packet contains metadata but no extracted PDF text. The filename is not proof of the document's contents.

The private packets retain source-row IDs, message bodies, headers, PDF fields and a **later** HMS snapshot. Source timestamps' underlying timezone semantics are unverified. The PDF send time need not equal booking creation time; HMS may batch outgoing confirmations. These cases support the relationships described; they do not prove every historical booking state or staff action.

## The 10,549 cross-thread candidates

The [PDF linker](../../apps/server-pilot/scripts/centurion-confirmation-pdf-links.ts) indexed each saved message's subject and body, including quoted history, and searched for the PDF's **labelled extracted confirmation number** in messages on a different thread. It emitted one PDF-attachment/message-source-row pair and marked tier-2 matches for review. It did not require the same guest, sender, date, or a voucher. The match field says `message_subject_or_body`; it does not distinguish current text, subject, and quoted history.

Sources:

- Mail snapshot: `.private/halloween-centurion-data-d5ce222c-f68e-435b-84ad-f95dccab0945/corpus.jsonl` — 16,041 source rows in 11,163 thread records.
- PDF metadata and extracted fields: `.private/centurion-confirmation-pdf-legacy-unverified-2860448/records.jsonl`.
- Pair links: `.private/centurion-confirmation-pdf-legacy-unverified-2860448/links.jsonl`.
- Successful/failed later HMS captures: `/home/orca/.local/share/zero/research/halloween/raw-data/stay360-1a-1b-1c-20261029-run01.json`.

**Local in-memory join performed in this conversation; no joined artifact was saved:**

| Measure | Count | Meaning |
|---|---:|---|
| Tier-2 candidate PDF–message links | 10,549 | Not unique emails or bookings; all require review. |
| Outbound target links | 9,250 | Potential bridge messages, subject to review. |
| Inbound target links | 1,299 | Links resolve to 616 distinct saved inbound source rows. |
| Distinct inbound-message/confirmation pairs | 721 | Across 292 confirmation numbers. |
| Pairs with at least one linked PDF listed in a successful saved HMS read's source evidence | 721/721 | A candidate chain exists; this does **not** verify the message-to-booking relation or any field label. |
| Distinct November-classifier cases mapping to those 616 rows | 596 | Deduplication maps multiple source rows to some cases. |
| Of those 596, classifier-tagged voucher or POP | 49 | 23 voucher, 28 POP; two have both. 26 are in the main window and 23 in the earlier window. Model tags, not verified documents. |
| Those 49 with an extracted PDF excerpt in the classifier packet | 12 | All 12 in the main window; the excerpt can be from some PDF, not necessarily the voucher/POP. It is bounded, not a full attachment. |

Join keys for reproduction: `links.messageDbId` → `corpus.jsonl` nested `messages[].sourceRows[].sourceRowId`; `links.pdfAttachmentId` → PDF record/attachment ID; confirmation number is in the link evidence. Map source rows to classifier cases through `_source.row_ids`. For HMS, require both the confirmation value and a PDF attachment ID in a successful result's `sourcePdfEvidence.pdfAttachmentIds`. The original datasets and raw packets are the evidence, not the unsaved join itself. The [inbound-led summary script](../research/halloween/b2b-dashboard/inbound-led-summary.py) defines the PDF-excerpt presence check.

There are 13,245 total PDF/message pairs: 2,696 tier 1 and 10,549 tier 2. Another **92 cross-thread exact-ID matches** were merged into tier 1 when the same pair had stronger header evidence; 76 of those links target inbound and represent 66 source rows, 35 of which are not in the tier-2 inbound set. Do not drop them merely because their `tier` is 1.

Crucial recall issue: B04/B06's **original booking requests are not direct exact-ID links**, because those requests predate and lack the number. Expand candidate journeys through staff replies and `Message-ID`/`In-Reply-To`/`References`, then compare guest, dates and participants. Do not assume every outbound match is a correct bridge or use address/time alone as gold.

## Corpus inventory, dates and usefulness

Dates below describe the relevant source window unless otherwise stated. Preserve distinctions between message date, stay date, export date and HMS read date.

| Source | Dates and size | Best use and limitations |
|---|---|---|
| [November opportunity study](../research/halloween/corpus-analysis/2026-11-02-centurion-corpus-run.md) | Main: **26 Sep 00:00–30 Oct 17:00 2026 SAST, end exclusive**, 4,516 deduplicated inbound; earlier: **27 Jul–26 Sep**, 6,635. | Best workflow index and source-row mappings. Main had 1,361 actionable, 1,007 potentially helpable; workflow counts overlap. Main MIME inventory 4,514/4,516; earlier only 214/6,635 retrievable. Classifications are model outputs, may see later replies, and are not independent gold labels. [Main dataset](../../.private/centurion-opportunity-october-20261101/bulk-v22-effective/dataset-final-v32.jsonl); [earlier dataset](../../.private/centurion-opportunity-october-20261101/pre-sep26-v24/dataset-final-v5.jsonl). |
| [PDF candidate dataset](../research/halloween/centurion-confirmation-pdf-dataset.md) | **1,880 outbound PDF records**, parent sent timestamps 27 Jul–29 Oct; source snapshot cutoff 29 Oct 17:27 UTC. | Real confirmation PDF bytes, extracted fields, links. **1,782** have labelled confirmation numbers. These are hotel confirmation PDFs, not a voucher set; filename-selected sender qualification remains unverified. See count derivation below. |
| [Saved HMS captures](../research/halloween/2026-11-01-hms-field-scope-audit.md) | Captured 29–30 Oct; **894 candidate tokens, 892 successful reads, 2 not found**. Record View reservation dates span 27 Jan–29 Oct; arrival 28 Jul 2026–16 Jul 2027. | Later HMS field references. Do not automatically treat later values as historical input-time truth. `udfchar10` labelled “Wi-Fi Voucher” is blank in 892/892 reads; this does not prove other voucher data is absent. |
| [Five-day corpus](../research/halloween/2026-10-30-centurion-five-day-corpus.md) | **19–23 Oct**; 1,288 messages, 92 PDFs and 87 later HMS reads. Derived 30 Oct from the 29 Oct snapshot. | Strong small set for source-linked booking journeys and counterexamples; no raw inbound MIME or attachment descriptors in this old export. Later MIME inventory adds evidence for B06 separately. |
| [Month expansion](../research/halloween/corpus-experiments/month-expansion-20261030-run.md) | **28 Sep–23 Oct**; 5,229 messages / 3,364 threads. Run 30 Oct. | Wider request-first and stay/amend examples, plus a stratified 60-message sample. The added period's 381 selected PDFs match 294 later HMS captures. Older export lacks inbound attachment inventory; selected examples are not representative gold. |
| [Three-day PDF reread](../research/halloween/2026-10-29-centurion-three-day-reread.md) | **26–28 Oct**; 432 PDFs, 49 exact confirmation strings; derived 30 Oct. | Confirmation/pro-forma field and parser testing. Includes a [10-PDF visual gold sample](../../.private/centurion-confirmation-gold-20261029-kz7oAO/gold.jsonl); 93/93 sampled reservation/deposit fields matched in its final comparison. Not a voucher benchmark or population accuracy estimate. |
| [Oct 13 research snapshot](../research/2026-10-13/README.md) | Mail **30 Jul–13 Oct**; 12,433 messages, attachment metadata, 3,697 extraction rows, 178 HMS reads, 2,162 staff PDFs/texts. Extraction timestamps cover 10–13 Oct, not the full mail window. | Historical workflows and quote fields. [R3](../research/2026-10-13/r3-workflow-truth.md) manually labeled 400 messages including 35 voucher cases; it is workflow routing evidence, not voucher-content gold. [R1](../research/2026-10-13/r1-quote-gold.md) has 93 heuristic ask→staff-output pairs. [Party answer key](/home/orca/nava-research/testsets/party-truth.jsonl) has 194 reservation-keyed attempts: 167 found, 26 not found, 1 failure; limited HMS search window. Attachment export includes metadata/S3 keys, not inbound file bytes. |
| [Aug 25 mailbox analysis](../infor-hms/connected-mailbox-corpus-analysis-2026-08-25.md) and [Sep 7 PMS catalogue](../infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md) | Aug snapshot 3,268 messages, retained mail from Jul 22; Sep catalogue based on Sep 2 snapshot, 4,536 messages and 581 selected records. | Older taxonomy and tool-demand context; useful background, not current extraction accuracy or gold truth. |

### Why 1,880 PDF records became 892 HMS successes

The [HMS candidate preparer](../../apps/server-pilot/tooling/hms-cloud/diagnostics/prepare-centurion-confirmation-corpus.py) groups by exact filename confirmation token and corroborates against PDF text; for unlabeled PDF confirmation fields it also requires matching subject evidence. The 1,880 PDF records reduce to **894 distinct candidate tokens**: 462 have one PDF and 432 have multiple PDFs. The saved HMS run has **892 successes and two `CONFIRMATION_NOT_FOUND` failures**. The 98 PDFs lacking a labelled field were recovered for this separate HMS preparation using filename/subject/PDF corroboration; the original tier-2 link build uses the labelled extracted PDF confirmation candidates. See also the [merge script](../../apps/server-pilot/tooling/hms-cloud/diagnostics/merge-centurion-confirmation-corpus.py).

The filename-derived token and attachment ID connect these successful reads to their evidence PDFs. The original PDF dataset has duplicates and revised documents, so PDF count is not reservation count. HMS `Created On` and arrival/departure dates describe different things from source mail timestamps.

## November classification: method and reusable tooling

The [method](../research/halloween/corpus-analysis/METHOD.md) frames and deduplicates emails, cleans current and quoted text, inventories MIME, recovers bounded selected attachment text, finds candidate replies, classifies, and rechecks selected cases. [Frame builder](../research/halloween/corpus-analysis/mailbox-frame-build.py) and [reverse reply supplement](../research/halloween/corpus-analysis/mailbox-reply-candidate-supplement.py) create candidates. [MIME index](../research/halloween/corpus-analysis/mailbox-mime-index.py), [attachment augmentation](../research/halloween/corpus-analysis/mailbox-augment-attachments.py), and [document evidence extraction](../research/halloween/corpus-analysis/centurion-attachment-evidence.py) address attachments.

The main run used `gpt-6-luna` medium with explicitly selected evolving prompt layers, not one prompt for every email; see the run report. [v22 prompt](../research/halloween/corpus-analysis/2026-11-02-centurion-opportunity-prompt-v22-combined-review.md), [classifier runner](../research/halloween/corpus-analysis/luna-corpus-runner.py), [action-detail prompt v7](../research/halloween/corpus-analysis/2026-11-02-luna-action-details-prompt-v7.md) and [detail runner](../research/halloween/corpus-analysis/luna-action-details.py) show the actual input and output shapes. Classification consumed one prepared inbound packet at a time, with cleaned body, available attachment context and candidate replies. Its fixed workflow taxonomy allows overlapping actions. It is retrospective: later replies can affect both classification and action state.

The [inbound-led report](../research/halloween/b2b-dashboard/2026-11-02-inbound-led-report.md) found **181 of 372 voucher-tagged main-window emails** had extracted PDF snippets in their final model packet; 191 did not. This wider number is separate from the **12 of 49** in the cross-thread/HMS-overlap subset. Snippets are not proof that full voucher files are saved or correct. The classification run's blind review was model-to-model agreement, not human-verified accuracy.

The older product [conversation-link code](../../apps/server-pilot/src/mail/conversation-link.ts) is **separate** from the PDF linker and B04/B06 selection. For example, a heuristic can link a human outbound to an inbound using the same external email within seven days with a nominal `0.9000` confidence. B04 demonstrates why that is insufficient as gold. No accuracy or current deployment check of the old linker was performed in this conversation.

## Suggested continuation

1. If the owner asks to build the dataset, start with the 49 cross-thread voucher/POP candidates and B04/B06-style paths, then check the wider 181 voucher-tagged main cases with excerpts. Follow the owner's scope and workspace rules for any live collection or model run.
2. Recover original MIME/attachment bytes where available; explicitly distinguish missing, inaccessible, no attachment, metadata-only, bounded text and full document. A voucher filename, extracted snippet or staff acknowledgement is not proof of full document content or payment settlement.
3. Construct a source-bound journey with separate events and evidence: original inbound and attachment, staff response, outbound confirmation PDF, subsequent voucher/POP, and later HMS snapshot. Follow reply headers across threads and check actual stay/guest/dates; preserve alternatives and missing evidence.
4. Adjudicate field-level correspondence and timing before calling values gold. Keep material received after a given decision out of that decision's model input. Multiple emails can concern one booking; one email can concern multiple bookings; a confirmation can be revised.
5. Keep splits by booking/journey, not just message, to avoid leakage from copies or later versions. Retain provenance, hashes, label status, uncertainty and source dates. Include negatives and cases without successful bookings if the intended evaluation needs them.

No prompt optimization, new model run, live mailbox fetch or HMS read was performed as part of the cross-thread join investigation. The 721/49/12 counts above have not been independently adjudicated; reproduce the join from the source artifacts before treating them as a production dataset.
