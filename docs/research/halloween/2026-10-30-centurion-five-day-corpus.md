# Centurion five-day corpus: 19–23 October 2026

**Status: saved-source slice and selected confirmation-PDF extraction complete.** The owner chose this replacement sample after the 26–28 October confirmation PDFs contained substantial repetition. See the separate [three-day reread](2026-10-29-centurion-three-day-reread.md). No live collection, HMS access, external service or email send was part of this work.

The result is a source-linked research corpus, not a complete mailbox export, a labeled golden set, a count of delivered mail or current HMS truth.

## Source and date boundaries

- Source: [owner-only saved snapshot](../../../.private/halloween-centurion-data-d5ce222c-f68e-435b-84ad-f95dccab0945/), with an exclusive cutoff of `2026-10-29T17:27:24.399Z`.
- All-mail source: `corpus.jsonl`, `source-manifest.json` and `manifest.json`. Thread records contain logical messages and source rows. Select messages by their own stored `timestamp`, not thread start; retain source rows in `active_transport` for `transport-centurion`.
- The logical-message timestamp uses the saved source-row received timestamp. The reader populates that value using a received/sent/created fallback. The historical timezone basis remains unverified even where serialized timestamps end in `Z`.
- The saved all-mail snapshot has zero raw-MIME objects and zero attachment descriptors. This is an export limitation, not evidence that the messages lacked attachments. It does not establish capture completeness or delivery.
- Separate PDF source: `attachments.jsonl` and `pdfs/`. The selection was stored outbound direction, Centurion transport and case-sensitive filename regex `^HRCEN_Confirmation_Letter_.*[.]pdf$`. The export did not enforce a sender-header prefix. Parse stored sender values as email addresses because some include display names.
- Selected PDFs join to mailbox rows by `parentMessage.messageDbId = sourceRowId`. All selected PDF parent sent-date prefixes match their selected logical-message date prefixes. All selected stored sender addresses have local part `centurion` after address parsing. This is not independent raw-MIME verification.

## Saved mailbox inventory

| Stored date | Logical message records | Distinct threads on date | Inbound | Outbound | Selected confirmation PDF records |
|---|---:|---:|---:|---:|---:|
| 19 Oct | 239 | 171 | 173 | 66 | 20 |
| 20 Oct | 300 | 187 | 199 | 101 | 27 |
| 21 Oct | 285 | 178 | 191 | 94 | 20 |
| 22 Oct | 268 | 198 | 222 | 46 | 11 |
| 23 Oct | 196 | 138 | 132 | 64 | 14 |
| **Total** | **1,288** | **759 distinct** | **917** | **371** | **92** |

Daily thread counts overlap and must not be summed as distinct threads. Each selected logical message has one unique source row in this slice. The selected PDF subset is not the mailbox's total attachments.

There are 68 pairs of saved rows with the same trimmed, case-folded raw message ID: 136 rows in total. The pairs share provenance fingerprints but differ in content fingerprints. Twenty-five pairs are in the same thread and 43 cross threads. All 68 pairs share stored sender/recipient arrays, direction and sent timestamp; none has exactly identical saved bodies, although four pairs match after whitespace normalization. A repeated raw message ID is a candidate link, not enough proof to merge records or count delivered mail.

## Confirmation PDFs and repeats

- There are 92 saved PDF records and 87 distinct filename-token candidates. Five filename tokens occur twice; 82 occur once.
- The exact filename token is present in all 92 native PDF texts and all 92 spatial confirmation-number candidates. It also appears with strict boundaries in 91 parent subjects. The remaining subject is a forward without the number. Filename and PDF text agree, but the owner's filename-plus-subject rule does not corroborate that row.
- Of the five repeated-token pairs, one has byte-identical PDFs. Its second parent message is a forward in another context. The other four have different native PDF text. Three pairs were visually checked on original page-one renders: one adds previously missing prices, one extends the stay by a night, and one shortens it by a night. The fourth changed an organization/header line and was visually examined in the [earlier reread](2026-10-29-centurion-three-day-reread.md). These are saved document versions, not evidence of actual sending or delivery.
- The owner explained on 2026-10-30 that HMS queues and batches confirmation emails after staff enter bookings; staff may say a booking is made and its confirmation is on the way. A PDF email timestamp therefore need not be the booking time. This owner explanation does not establish the cause or timing of any particular document in this sample.
- All 92 PDFs have numeric candidates for both average daily rate and total accommodation except one. Its original page was visually checked and shows only currency markers, not numeric values. Do not infer a zero price.
- Classification from matched image headings and native fields yields 91 confirmation/pro-forma hybrids and one compact confirmation letter. Both are historical document categories, not proof of payment.
- The saved PDFs have 184 nonempty native-text pages. Native text, original hashes, bounding-box words, candidate fields, table rows, image evidence, URL annotations and source links are retained privately. PDF link targets were not followed.
- The spatial parser initially missed occupancy in two documents because the label wraps across lines. A separate source-linked supplement recovers both from bounded native word geometry; both values were checked against original page-one renders. The base records remain unchanged and consumers must join the supplement by attachment ID.
- Treat spatial extraction as candidates. In particular the base VAT field may contain only a label separator, and table columns require source review. The prior three-day visual gold sample does not establish five-day field accuracy. The separate supplement does not imply all other fields were independently validated.

## Saved HMS join and timing

The [separately captured HMS results](/home/orca/.local/share/zero/research/halloween/raw-data/stay360-1a-1b-1c-20261029-run01.json) contain guest data and remain private. Match the five-day PDFs by exact filename confirmation token to successful saved HMS results, then check that each PDF attachment ID appears in that result's `sourcePdfEvidence.pdfAttachmentIds`.

- All 92 PDF records match 87 successful distinct HMS results. All 87 have matching confirmation values in the Stay 360 and Record View headers, and populated Guest Details fields. These are later HMS captures, not historical snapshots at the email's decision time. The capture excludes other tabs, hidden content and unloaded grid pages.
- The Record View field `Source Of Business:` is exactly `E-MAIL` for 58 of the 87 results. `CMS Booker Email:` is populated for five. These fields are candidate signals, not proof that a related request exists in the saved mailbox, and blank or other values do not disprove email involvement.
- The HMS `Created On:` calendar date equals the earliest selected PDF's stored date for 65 results and is earlier for 22. Date and timestamp timezone bases are not independently verified. The owner's batching explanation above can account for a later confirmation, but no individual delay has been attributed to batching.
- Three of the five repeated-confirmation PDF pairs have stored timestamps more than 30 minutes apart. These are document-version pairs, not a measurement of whether related inbound requests lie within a 30-minute window.
- Seven of the 759 saved threads contain exact textual mentions of two or more selected confirmation tokens. Quoted history may explain some mentions; this is not a verified count of multi-booking conversations.

## Verification and outputs

The independent verifier re-read all selected mailbox rows from the original corpus and checked copied thread contents and parent IDs. It checked all 92 original PDF hashes and independently reran native-text extraction for all 184 pages. It verified the five repeated filename groups, all parent thread joins, date counts and private output modes. This checks source fidelity, not semantic field accuracy.

Nine original page-one renders were reviewed locally: both versions of three changed pairs, the compact-letter example and the two wrapped-occupancy cases. The earlier reread separately checked the fourth changed pair. Exact extracted-image hash matches reused prior visual heading transcriptions for all selected PDFs; there was no OCR. Unmapped image-only content and unreviewed pages remain limitations.

Private output directories and files are Git-ignored and owner-only. Their contents include guest information. Do not send them to external services or follow embedded PDF links.

- [Browsable PDF index](../../../.private/centurion-five-day-20261019-23-supplements-20261030-01/pdf-index.md): PDF and parent-email links, date and monetary candidates, and the wrapped-occupancy supplement.
- [Completed private corpus](../../../.private/centurion-five-day-20261019-23-data-20261030-02/): `mailbox-threads.jsonl`, `pdf-records.jsonl`, `page-text.jsonl`, `repeat-groups.jsonl`, `mailbox-duplicate-candidates.jsonl` and `manifest.json`.
- [Occupancy supplement](../../../.private/centurion-five-day-20261019-23-supplements-20261030-01/wrapped-occupancy.jsonl), [saved verification and hashes](../../../.private/centurion-five-day-20261019-23-supplements-20261030-01/verification.json), and [visual review folder](../../../.private/centurion-five-day-20261019-23-visual-20261030-01/).
- [Builder and QA scripts](../../../.private/centurion-five-day-20261019-23-20261030-01/): `build-five-day.py`, `verify-five-day.py`, `recover-wrapped-occupancy.py`, and `build-private-index.py`.
- The first build wrote [partial output](../../../.private/centurion-five-day-20261019-23-data-20261030-01/) but failed while producing repeat groups. It was not overwritten or used as the completed dataset. The corrected builder completed in the `-02` directory.
- [Previous PDF extractor](../../../.private/centurion-confirmation-pdf-deep-extract-20261029-01/fresh_extract.py) supplies reusable local Poppler parser functions. Its `main` is hardcoded to the older sample and must not be run unchanged on these dates. The new builder imports functions only.
- [Previous methodology](../../../.private/centurion-confirmation-pdf-deep-extract-20261029-01/methodology-coverage.md), [image transcription map](../../../.private/centurion-image-heading-transcription-20261029.json), [old QA scripts](../../../.private/centurion-gold-qa-code-fPqUN7/), [old extraction](../../../.private/centurion-confirmation-pdf-deep-extract-20261029-01/) and [old recurrence evidence](../../../.private/centurion-recurrence-evidence-20261029/) remain unchanged. Assertions hardcoded to 432 old records do not apply to the new sample.

The original commands below ran in the earlier worktree. The builder and verifier hardcode that worktree's private root, so their archived copies need their paths adapted before they can reproduce the extract from another checkout. They refuse to overwrite existing output and require Python isolated mode and local Poppler utilities:

```bash
mkdir -m 700 .private/NEW_OUTPUT_DIRECTORY
chmod 700 .private/NEW_OUTPUT_DIRECTORY
python3 -I -B .private/centurion-five-day-20261019-23-20261030-01/build-five-day.py .private/NEW_OUTPUT_DIRECTORY
python3 -I -B .private/centurion-five-day-20261019-23-20261030-01/verify-five-day.py .private/NEW_OUTPUT_DIRECTORY
```

The builder and verifier depend on the saved snapshot, previous extractor and prior image transcription map. The builder records those source fingerprints in its generated manifest. Script fingerprints and verification evidence are saved separately with the private supplements. The occupancy and private-index scripts accept the generated records and an exclusive new output path; their usage appears in each script.

**Continuity boundary:** the private scripts, source files and results are Git-ignored. Copies live in this checkout's `.private/` and in `/home/orca/.local/share/zero/research/halloween/corpus-research-20261030/`. This sanitized note was later integrated into the repository; the original investigation made no deployment or live collection.
