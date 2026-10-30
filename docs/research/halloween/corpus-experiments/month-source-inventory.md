# Saved Centurion source coverage: 28 Sep–23 Oct 2026

**Finding:** the saved mailbox contains records for every day in the requested 26-day window: 5,229 logical messages/source rows across 3,364 distinct threads. The separately selected confirmation-PDF inventory contributes 473 records in-window. Older data is present: the saved mailbox and selected-PDF inventory both reach back to 27 July 2026. These are saved-source coverage counts, not proof of complete mail capture, attachment completeness, delivery, or contemporaneous HMS state.

## Scope and method

- Read the owner-only saved snapshot's `source-manifest.json`, `manifest.json`, `corpus.jsonl`, and `attachments.jsonl`; reused the earlier [five-day decision](decision.md) and its source-selection methodology. No live systems, external services, or email contents were used in this inventory.
- Mail selection: messages whose own stored timestamp date prefix falls from `2026-09-28` through `2026-10-23` inclusive, with `active_transport` membership and the Centurion transport. Counted logical messages, associated source rows, stored direction, and distinct thread membership by day. All 5,229 selected messages had one selected source row; no mixed-scope message was found. Daily thread counts overlap when one thread has messages on multiple dates.
- Reproducible inbound-sample input is the repo-root-relative `.private/halloween-centurion-data-*/corpus.jsonl`; identify the intended snapshot using its owner-only manifest and recorded fingerprint rather than assuming the wildcard is unique. Select records with `recordType == "thread"`; inspect each `messages[]` entry and filter on `messages[].timestamp` (not `threadFirstTimestamp`); keep its `messages[].sourceRows[]` only when `scopeMembership` contains `active_transport`, `privateMessage.sourceMetadata.transportId` is the Centurion transport, and `privateMessage.direction == "inbound"`. Retain `threadId` and `sourceRowId` in the private sample for traceability. For a reproducible draw, order eligible rows by SHA-256 of a fixed recorded seed concatenated with `sourceRowId`, break any tie by timestamp then `sourceRowId`, and take the specified sample size; keep the seed, filters, date window, and count with the owner-only output. This note publishes no row identifiers or message content.
- The corresponding repo-root-relative `.private/halloween-centurion-data-*/attachments.jsonl` is the separately selected outbound-PDF inventory, not inbound attachment evidence. Its useful join/description fields are `parentMessage.messageDbId`, `parentMessage.sentAt`, `attachment.filename`, `attachment.attachmentId`, `file.status`, `file.sha256`, and `file.path`. The parent-row join is `parentMessage.messageDbId` to `messages[].sourceRows[].sourceRowId`; a missing match cannot establish that an inbound message had no attachment.
- The saved snapshot manifest declares no lower-bound start (`startInclusive: null`) and an exclusive upper cutoff of `2026-10-29T17:27:24.399Z`. The saved timestamp's historical timezone basis is unverified; counts use stored date prefixes, not a timezone-normalized reconstruction.
- PDF selection: the snapshot's separate inventory was selected on Centurion transport, outbound direction, and the case-sensitive filename pattern `^HRCEN_Confirmation_Letter_.*[.]pdf$`. The sender-header prefix was retained as evidence, not used as an inclusion condition. The 1,880 candidate records comprise 1,866 unique parent messages; the manifest marks all candidate files available. For this window, PDF rows were joined to selected mailbox source rows by the saved parent-row relationship. Each of the 473 in-window rows has matching parent stored-sent-date and mailbox-message-date prefixes.

## Date-wise coverage

| Stored date | Messages / source rows | Distinct threads | Inbound | Outbound | Selected PDF records |
|---|---:|---:|---:|---:|---:|
| 2026-09-28 | 188 | 151 | 144 | 44 | 16 |
| 2026-09-29 | 237 | 169 | 150 | 87 | 29 |
| 2026-09-30 | 263 | 182 | 172 | 91 | 37 |
| 2026-10-01 | 249 | 177 | 184 | 65 | 15 |
| 2026-10-02 | 202 | 146 | 137 | 65 | 25 |
| 2026-10-03 | 46 | 42 | 42 | 4 | 3 |
| 2026-10-04 | 52 | 40 | 50 | 2 | 0 |
| 2026-10-05 | 226 | 158 | 158 | 68 | 16 |
| 2026-10-06 | 272 | 201 | 190 | 82 | 26 |
| 2026-10-07 | 181 | 138 | 161 | 20 | 18 |
| 2026-10-08 | 203 | 142 | 126 | 77 | 28 |
| 2026-10-09 | 209 | 168 | 156 | 53 | 23 |
| 2026-10-10 | 44 | 36 | 40 | 4 | 3 |
| 2026-10-11 | 54 | 40 | 53 | 1 | 1 |
| 2026-10-12 | 231 | 178 | 173 | 58 | 18 |
| 2026-10-13 | 281 | 233 | 223 | 58 | 16 |
| 2026-10-14 | 274 | 229 | 224 | 50 | 11 |
| 2026-10-15 | 237 | 174 | 173 | 64 | 23 |
| 2026-10-16 | 340 | 262 | 234 | 106 | 58 |
| 2026-10-17 | 93 | 87 | 77 | 16 | 15 |
| 2026-10-18 | 59 | 49 | 59 | 0 | 0 |
| 2026-10-19 | 239 | 171 | 173 | 66 | 20 |
| 2026-10-20 | 300 | 187 | 199 | 101 | 27 |
| 2026-10-21 | 285 | 178 | 191 | 94 | 20 |
| 2026-10-22 | 268 | 198 | 222 | 46 | 11 |
| 2026-10-23 | 196 | 138 | 132 | 64 | 14 |
| **Window total** | **5,229** | **3,364 distinct across window** | — | — | **473** |

There are no zero-message days in the window. The newly added 28 Sep–18 Oct portion contains 3,941 saved messages and 381 selected PDF records; the previously studied 19–23 Oct portion contains 1,288 messages and 92 selected PDF records. These totals reconcile to the full-window counts above; selected PDF records are not unique-booking counts. The selected PDF inventory has zero records dated 4 Oct and 18 Oct; this is a gap in this selected subset only, not evidence that no attachments or confirmations existed on those dates. This note does not repeat the five-day journey review.

## Independent check of the added period's saved HMS reads

Using [the scoped anchor selector](month-hms-anchors.py) and the existing [saved-capture verifier](verify-hms-captures.py), an independent pass matched all 381 selected PDF records from 28 September–18 October to successful later saved HMS captures using both attachment ID and filename-derived confirmation token. They represent 294 distinct filename tokens, not necessarily 294 distinct bookings. The saved 1a and 1b headers matched the corresponding token for all 381 records, and 1c returned a nonempty field array for all 381. A nonempty array is not proof its values were populated, that the guest row was selected, or that hidden/grid-page content was captured. This is a check of later saved reads against selected document metadata, not a historical HMS snapshot, current deployment proof, file-content validation or quote-price proof. Owner-only verification anchors are retained under Git-ignored `.private`.

A separate [rendered-versus-populated check](month-reader-capabilities.md#populated-values-versus-rendered-controls) found guest-name controls empty but visible guest-grid name cells populated in the 294 first matched captures per filename token. This distinction is not evidence of a complete guest list or a selected guest row.

## Wider saved-source availability and limits

- The full saved mailbox snapshot contains 16,041 logical messages/source rows and 11,163 threads. Of these, 9,524 messages predate 28 Sep, 5,229 fall in the requested window, and 1,288 follow it through the snapshot cutoff. The earliest observed saved message date is **27 Jul 2026** and the latest is **29 Oct 2026**. Thus older dates really are present in this snapshot, but no claim is made about coverage before the earliest observed date or about messages omitted from the export.
- The selected-PDF inventory contains 1,880 records overall: 941 have parent stored-sent dates before 28 Sep, 473 in the requested window, and 466 after 23 Oct through 29 Oct. Its earliest observed parent stored-sent date is **27 Jul 2026**. The manifest's sender-header evidence counts are 1,480 no-match, 369 missing, and 31 not stored; those records remain in the selection because that evidence was not a filter.
- The all-mail snapshot has zero raw-MIME objects and zero attachment descriptors; raw MIME is unavailable for all 16,041 saved source rows. Its attachment-text count is zero. The separate PDF inventory is filename-filtered, not an exhaustive inventory of every attachment. Do not interpret its counts as total attachments or as a sample of all attachment types. In particular, the inbound-sampling corpus cannot support per-message attachment-presence labels; an absent row in the separate outbound-PDF inventory does not mean the inbound message lacked an attachment.
- Useful saved mailbox fields include stored timestamps, direction, scope membership, thread/source-row relationships, sender/recipient fields, subject/body fields, and content/provenance fingerprints. Useful separate PDF-inventory fields include stored parent metadata, filename, file status/hash, and parent linkage. Extracted native page text, geometry, labeled-field/table candidates, and image evidence exist in the source-linked five-day output for its 92 selected PDFs only; that extraction does not extend automatically to the other in-window PDFs.
- The mailbox manifest records 1,171 unresolved duplicate candidates snapshot-wide; this is not a window-specific duplicate rate. Preserve each sampled source row. Do not collapse using `messages[].sourceRows[].messageId`, `contentFingerprint`, or `provenanceFingerprint` alone; those fields support candidate linkage, not proof of duplicate delivery or safe merging. The date counts retain the saved logical-message rows as exported. Stored timestamps and PDF parent dates are not independently timezone-verified.
- Existing five-day verification rechecked its 92 source PDFs and 184 pages. This bounded inventory pass counted saved message and attachment metadata for the wider date range; it did not perform a new PDF-content extraction or verify every PDF byte/hash in the 1,880-record inventory.

## Next actions

1. Use the date table as the saved-mail coverage baseline for 28 Sep–23 Oct; keep the five-day journey review confined to its existing scope.
2. Before claiming attachment or confirmation-document coverage, obtain or verify a complete attachment/MIME source. Until then, label the 473 records strictly as the selected confirmation-PDF subset.
3. If older PDF content is needed, run a separately scoped, source-linked local extraction for the relevant dates, retaining owner-only/Git-ignored outputs; do not infer field accuracy from the 92-PDF five-day extraction.
4. For delivery-level chronology or deduplication claims, first resolve the timestamp/timezone and duplicate-candidate limitations against an appropriate source.
