# Centurion Confirmation-PDF Candidate Dataset

**Result:** Built private, Centurion-only source dataset with 1,880 PDF records, local native-text extraction, and evidence-tiered message/thread links. This is a candidate corpus, **not gold labels**. Corrected parsing found labeled confirmation numbers in **1,782/1,880** PDFs and labeled average daily rates in **1,869/1,880**. Exact-ID matching produced **10,549 cross-thread Tier 2 candidate links**, all requiring manual review—not verified reservation links. A read-only retry confirmed all **369/369** initially missing raw-MIME objects remain missing; 31 more records have no stored locator. The initial exporter reported no strict `From` prefix matches, but its 1,480 `no_match` results are **unverified**: it could misclassify a missing or unparseable `From`. The exporter is corrected for future runs; the old headers were not re-read.

## 1. Scope and provenance

- **Mailbox:** `transport-centurion` only.
- **Candidate rule:** outbound attachment filename matches case-sensitive `^HRCEN_Confirmation_Letter_.*[.]pdf$`; no date filter.
- **Source snapshot:** `live-18e5c82a-236b-44e2-a154-f74484e364d4`, ending `2026-10-29T17:27:24.399Z` UTC; 16,041 source rows in 11,163 thread records.
- **PDF selection is intentionally broader than the sender rule.** The sender rule is evaluated as evidence, not used to drop unknown or nonmatching candidates.
- **Sender criterion:** first decoded original `From` display name starts with literal `Centurion at`. The live exporter reads only a bounded raw-MIME header range from object storage. It does not substitute `message.from_address` for the original header.
- The previous aggregate query at `2026-10-29T14:58:46Z` found 1,879 outbound attachment rows. The targeted export used a later snapshot and found 1,880; counts are snapshot-specific, not contradictory.
- The RDS database name was `zero`; endpoint was not independently validated. These stored rows do not prove BCC delivery completeness.

The scoped aggregate SQL is [`centurion-confirmation-pdf-selection.sql`](centurion-confirmation-pdf-selection.sql). It is **not executed by this build**. Its `stored_from_address_prefix_diagnostic` is only a diagnostic; SQL cannot apply the original-header display-name test.

## 2. Results

| Measure | Result |
|---|---:|
| PDF attachment records | **1,880** |
| Unique parent messages | 1,866 |
| PDF objects downloaded and integrity-checked | 1,880 / 1,880 |
| Preserved PDF bytes | 412,342,156 |
| Parent messages missing from source corpus | **0** |
| Source message rows / thread records | 16,041 / 11,163 |
| Native-text pages / extracted characters | 3,778 / 8,631,532 |
| PDF Inspector classification | 1,880 TextBased |
| Pages flagged as needing OCR | **0** |
| Parser failures | **0** |
| Exact-content duplicate groups / records in groups | 352 / 731 |
| Unique PDF-to-message link pairs | **13,245**: 2,696 tier 1; 10,549 tier 2 |
| Cross-thread confirmation-number candidate links | **10,549**; all require review |
| Tier 2 candidates unmarked for review | **0** |

Structured field coverage counts how many PDF records contain at least one extracted value:

| Structured field | Records with value |
|---|---:|
| Guest name | 1,878 / 1,880 |
| Confirmation number | 1,782 / 1,880 |
| Arrival date | 1,880 / 1,880 |
| Departure date | 1,880 / 1,880 |
| Accommodation type | 1,880 / 1,880 |
| Occupancy | 1,866 / 1,880 |
| Average daily rate | 1,869 / 1,880 |
| Rate includes | 1,863 / 1,880 |
| Total accommodation | 1,799 / 1,880 |

Coverage means nonempty raw text was captured under that labeled field; values are not normalized or independently validated. The parser reads label and value on the same line, so wrapped values can be incomplete or missed; do not treat coverage as field accuracy.

`links.jsonl` relation counts overlap because one PDF/message pair can have multiple independent proofs: 1,880 attachment-parent relations, 2,602 same-thread relations, 663 `References`/`In-Reply-To` inbound relations, 20 outbound header-reference relations, and confirmation-number matches. The **13,245** unique PDF/message pairs are not the sum of relation tallies.

**Correction:** the first build's confirmation-label parser missed values because PDF markdown wraps labels in `**`/`__`; its zero-candidate result was wrong and is superseded. The corrected parser strips those markers, captures labeled fields, and extracts exact numeric identifier tokens from confirmation-number values. It found 1,782 records with confirmation numbers and 1,791 candidate values. The resulting cross-thread exact-ID links are Tier 2 review candidates only; no filename-only or domain/time-only link is asserted.

## 3. Sender evidence

Counts are **per PDF attachment record**, not unique parent message:

| Original raw-MIME `From` evidence | Records | Interpretation |
|---|---:|---|
| Previously classified `no_match` by the initial exporter | 1,480 | Unverified: missing/unparseable `From` could be classified as a nonmatch |
| Initial raw-MIME object missing; retried, still missing | 369 | Unknown after retry |
| Raw-MIME locator not stored | 31 | Unknown; no retry possible |
| Verified prefix matches | **0** | None observed |

The initial exporter reported zero matches, but its 1,480 `no_match` results cannot all be treated as verified negatives: missing or unparseable `From` headers were also recorded as `no_match`. The source snapshot and earlier derived records preserve those historical labels; do not use their `fromHeaderPrefix: false` as proof. Rebuild this legacy snapshot with `--legacy-no-match-unverified` to retain the original status while marking these 1,480 records unverified and their prefix qualification unknown. The other 400 records are unknown: 369 raw-MIME objects remained missing after retry, and 31 records had no stored locator. No headers were re-read to resolve this. The 369 retry targets are 369 unique parent messages; their stored `sentAt` dates span **2026-07-27 through 2026-09-01** (July 66, August 268, September 35). These database timestamps have no intrinsic timezone. A separate stored-address diagnostic also found zero `from_address` values beginning with `Centurion at`; that column is not authoritative for the original `From` header.

## 4. Extraction and linkage method

1. [`export-centurion-confirmation-pdf-dataset-live.ts`](../../../apps/server-pilot/scripts/export-centurion-confirmation-pdf-dataset-live.ts) ran read-only on the approved EC2 instance. It selected only the stated transport, outbound direction, and exact filename pattern; copied the Centurion message corpus; fetched matching PDF objects; and hashed readable original `From` headers without writing their contents to the report.
2. [`build-centurion-confirmation-pdf-dataset.ts`](../../../apps/server-pilot/scripts/build-centurion-confirmation-pdf-dataset.ts) used pinned `@firecrawl/pdf-inspector` **1.25.2** locally via `detectPdf` and `extractPagesMarkdownAsync`. Its corrected parser strips Markdown emphasis around field labels, captures labeled field values, and extracts exact numeric identifier tokens from confirmation-number fields. The [official npm package page](https://www.npmjs.com/package/@firecrawl/pdf-inspector) lists 1.25.2, published 2026-09-28; the [GitHub 1.25.2 release](https://github.com/firecrawl/pdf-inspector/releases/tag/v1.25.2) is the corresponding source release. No OCR function, hosted Firecrawl endpoint, or external LLM/service was called.
3. Each attachment remains a separate record. SHA-256 groups expose byte-identical duplicates without dropping them. Records retain PDF hash, byte count, source attachment/message/thread IDs, recipients, sender-evidence tier, document metadata, structured fields, page markdown, and per-page quality/OCR flags.
4. Link tiers are deterministic:
   - **Tier 1:** exact attachment-to-parent DB message ID, exact DB thread ID, or a `Message-ID` / `In-Reply-To` / `References` token match after removing brackets and folding case. This follows the corpus's message-ID normalization; it is not raw byte-for-byte header equality.
   - **Tier 2:** exact confirmation-number candidate in a PDF and exact identifier occurrence in another message's subject/body, with cross-thread targets marked `reviewRequired`. All 10,549 Tier 2 pairs are review candidates, not verified reservation links.
   - No domain/time-only links are asserted.
5. [`retry-centurion-from-header-evidence-live.ts`](../../../apps/server-pilot/scripts/retry-centurion-from-header-evidence-live.ts) retried only the 369 initially missing raw-MIME messages on approved EC2. Its SQL transaction was read-only with a 30-second statement timeout; it requested only the first 64 KiB of each raw-MIME object via S3 range reads and re-applied the decoded original `From` display-name rule. All 369 range requests returned missing. The 31 records with no locator were not queried.
6. [`collect-centurion-from-header-retry-live.ts`](../../../apps/server-pilot/scripts/collect-centurion-from-header-retry-live.ts) retrieved statuses and header hashes through 100-row SSM ranges without returning message IDs or header contents. It checked the local and EC2 attachment-source hashes matched before mapping those results into the private override JSONL.
7. Existing [`hms-auto-pdfs.md`](hms-auto-pdfs.md) remains the historical all-direction aggregate note; its original query and caveats are preserved.

## 5. Private files and validation

Raw PDFs, extracted text, addresses, and link evidence are private data. They remain under ignored `.private/` paths, not in Git:

- Source snapshot: `.private/halloween-centurion-data-d5ce222c-f68e-435b-84ad-f95dccab0945/`
- Retry evidence: `.private/halloween-centurion-data-d5ce222c-f68e-435b-84ad-f95dccab0945/sender-evidence-retry-20261029.jsonl`
- Corrected derived records: `.private/centurion-confirmation-pdf-legacy-unverified-2860448/` (1,480 legacy `no_match` labels conservatively marked unverified; links copied byte-for-byte).
- Earlier derived records: `.private/centurion-confirmation-pdf-exact-check-20261029-2846596/` (historical `no_match` qualifications are not verified; see sender caveat below).
- Derived files: `records.jsonl`, `links.jsonl`, `manifest.json`; source PDFs remain in the source snapshot's `pdfs/` directory.

The corrected build confirmed one record per attachment ID (1,880 unique IDs), all source parent IDs resolved, all 1,880 PDFs available and hash/size/PDF-magic checked, all 1,880 native extractions completed, and zero OCR-needed pages. A 2026-10-29 local audit rechecked all 1,880 PDF hashes, byte counts and PDF magic (zero failures), plus all 13,245 link pairs (zero duplicates; all 10,549 Tier 2 pairs marked for review). The earlier link audit also found zero same-thread Tier 2 targets or missing record indexes. Retry evidence matched the 369-message source ID set exactly; all remained missing and no override rows were unmatched. Per-PDF Tier 2 candidates had median 3, 95th percentile 29, maximum 30.

After review found the legacy sender-classification defect, a separate offline metadata-only correction reclassified 1,480 old `no_match` labels as `unverified`, preserved the original label, and set sender qualification to unknown. All 1,880 corrected records were compared against the earlier records: no other fields changed, no sender qualification remained non-null, and links were copied byte-for-byte. No PDF was re-extracted and no live header was re-read for this correction.

On 2026-10-29, focused local Vitest ran the synthetic parser, record, link, header, retry, collector and PostgreSQL-reader tests: **25/25 passed** with one worker and the database test environment unset. After tightening identifier boundaries, a full private rebuild extracted all **1,880 PDFs** and reproduced the field and link counts above; its `records.jsonl` and `links.jsonl` were byte-identical to the prior corrected build. The latest link audit found zero duplicate pairs and zero Tier 2 pairs without review flags. Final-head remote tests, remote typecheck and Greptile review are separate merge requirements; no full suite was run.

The temporary encrypted S3 transfer object used to bring the bundle local has **not** been deleted. The dataset work did not deploy software, write to HMS, or send mail.

## 6. Reproduction and adaptation playbook

This section records the repeatable Centurion pipeline and what must change before another mailbox. It describes the current scripts; it does **not** make their Centurion constants configurable.

### 6.1 Safety and prerequisites

- Run live database/S3 work only on approved EC2 instance `i-008f737974a9ba9b3`, through the approved SSM path. Scripts attest the instance; do not bypass that check.
- Use the approved runtime environment for `DATABASE_URL`, `AWS_REGION`, and `S3_BUCKET`. Never put credentials in command arguments or logs.
- Keep source snapshots, retry evidence, PDFs, extracted text, and reports with guest data under ignored `.private/`. Preserve the scripts' `0700` directories and `0600` files. Do not send PDF bytes or extracted text to an external service or LLM.
- Candidate scope is **not** sender-qualified: include every matching Centurion outbound PDF, then record decoded original raw-MIME `From` evidence. Missing/unreadable evidence stays unknown; never replace it with `message.from_address`.
- The PDF-selection SQL file in this folder is a scoped aggregate query. The live PDF exporter has its own inline parameterized query; it does not execute that SQL file.
- Use a new output directory for every build. The builder refuses to create an already-existing output directory.

### 6.2 Centurion run sequence

Commands below are argument shapes, not a request to run live work. Remote commands run through `apps/server-pilot/deploy/ssm-run-command.sh` from the local repository. Its remote command payload runs as `ubuntu`. This repo currently has no reusable one-command wrapper for the complete flow.

1. **Create a source thread-corpus snapshot** when the previous snapshot is too old or missing. Run `export-centurion-thread-corpus-live.ts` in its default metadata mode; do not use `--attachment-inclusive` for this task.

   Remote payload:
   ```bash
   cd /home/ubuntu/repos/zero && set -a && . apps/server-pilot/.env.production && set +a && pnpm --dir apps/server-pilot exec tsx scripts/export-centurion-thread-corpus-live.ts
   ```

   The exporter creates `.private/connected-mailbox-corpus/live-<uuid>/` with `corpus.jsonl` and `manifest.json`; it prints safe counts, not the directory path. Record the actual directory and verify its manifest `snapshotId` before the next step. Do not choose “newest” blindly if another export may be running.

2. **Export the selected PDFs and evidence** using that snapshot. Run `export-centurion-confirmation-pdf-dataset-live.ts` on the approved instance with the same environment:

   ```bash
   pnpm --dir apps/server-pilot exec tsx scripts/export-centurion-confirmation-pdf-dataset-live.ts \\
     --source-snapshot=/home/ubuntu/repos/zero/.private/connected-mailbox-corpus/live-<uuid>
   ```

   Submit that payload through the SSM wrapper. It creates a unique `halloween-confirmation-pdfs-<uuid>/` directory under remote `.private/connected-mailbox-corpus/`, containing `corpus.jsonl`, `source-manifest.json`, `attachments.jsonl`, and `pdfs/`. Record its returned `outputDir`. Selection is `transport-centurion`, outbound, case-sensitive `^HRCEN_Confirmation_Letter_.*[.]pdf$`, no date filter. The `Centurion at` prefix is tested against the first decoded original raw-MIME `From` display name and is evidence only.

3. **Retry missing raw-MIME evidence only**, when needed. The retry script derives targets from `attachments.jsonl` rows whose initial evidence status is `missing`, deduplicates/sorts message IDs, runs its SQL in a read-only transaction with a 30-second statement timeout, and requests only the first 64 KiB of each stored object.

   ```bash
   pnpm --dir apps/server-pilot exec tsx scripts/retry-centurion-from-header-evidence-live.ts \\
     --source-attachments=/home/ubuntu/repos/zero/.private/connected-mailbox-corpus/halloween-confirmation-pdfs-<uuid>/attachments.jsonl \\
     --output-file=/home/ubuntu/repos/zero/.private/connected-mailbox-corpus/halloween-confirmation-pdfs-<uuid>/sender-evidence-retry-YYYYMMDD.jsonl
   ```

   Run remotely through the wrapper, with the approved environment loaded. The output parent directory must already exist and resolve inside remote `.private/`. Capture the returned evidence-file path and aggregate status counts. `not_stored` rows are not retried; missing rows remain unknown.

4. **Transfer the private bundle to the local build environment** using the approved encrypted transfer process. Include the four exporter outputs above and, if run, the retry JSONL. Verify source-file hashes after transfer. The exact transfer command/object lifecycle was not preserved in this note; the current run's encrypted S3 transfer object is still present. Do not improvise a less-protected transfer.

5. **Collect retry status locally**, if Step 3 ran. Point the collector at the local `attachments.jsonl`, supply that file's SHA-256, the remote retry-evidence path, and a new local output path under this repository's `.private/`:

   ```bash
   sha256sum /absolute/local/bundle/attachments.jsonl
   pnpm --dir apps/server-pilot exec tsx scripts/collect-centurion-from-header-retry-live.ts \\
     --source-attachments=/absolute/local/bundle/attachments.jsonl \\
     --expected-source-sha256=<sha256-from-previous-command> \\
     --remote-evidence-file=/home/ubuntu/repos/zero/.private/connected-mailbox-corpus/halloween-confirmation-pdfs-<uuid>/sender-evidence-retry-YYYYMMDD.jsonl \\
     --output-file=/absolute/repo/.private/sender-evidence-retry-YYYYMMDD.jsonl
   ```

   The collector uses the checked-in SSM wrapper by default, transfers statuses and header hashes only, and verifies the ordered message-ID digest without returning IDs through SSM. The local override file contains IDs and must stay private.

6. **Build locally**, passing the optional override only if collected. The input directory must contain `attachments.jsonl`, `corpus.jsonl`, `source-manifest.json`, and `pdfs/`.

   ```bash
   pnpm --dir apps/server-pilot exec tsx scripts/build-centurion-confirmation-pdf-dataset.ts \\
     --input-dir=/absolute/local/bundle \\
     --output-dir=/absolute/repo/.private/centurion-confirmation-pdf-dataset-YYYY-MM-DD \\
     --sender-evidence-override=/absolute/repo/.private/sender-evidence-retry-YYYYMMDD.jsonl
   ```

   Omit the last argument when there is no retry override. For this specific legacy snapshot, also pass `--legacy-no-match-unverified`: the original exporter could mistake a missing/unparseable `From` for a nonmatch. This preserves the historical status while making sender qualification unknown. Do not apply that flag automatically to snapshots produced by the corrected exporter. The builder uses pinned `@firecrawl/pdf-inspector` locally; it does not OCR or call a hosted parser.

7. **Audit before reporting.** Compare source and derived manifests; verify each attachment ID, parent message, PDF byte count/hash/magic, field counts, extraction statuses, and output permissions. Check link records: Tier 1 proofs are deterministic; every Tier 2 exact-ID cross-thread candidate must remain `reviewRequired`. Report unknown sender evidence as unknown. Record snapshot ID, input/override hashes, selection rule, counts, date semantics, and every unresolved limitation in this note.

### 6.3 Adaptation to another mailbox

This pipeline is Centurion-specific today. Do **not** copy the Centurion constants as if they were generic settings. Before another mailbox run, get an owner-approved scope and change/test all applicable selectors:

| Setting | Current Centurion value | Required for another mailbox |
|---|---|---|
| Thread snapshot transport | `CENTURION_TRANSPORT_ID` / `transport-centurion` | Confirm target transport and authorization; source exporter is Centurion-scoped. |
| PDF export transport | `transport-centurion` | Parameterize or change only after confirming the exact mailbox. |
| Filename rule | `^HRCEN_Confirmation_Letter_.*[.]pdf$` (case-sensitive) | Confirm the target's exact naming rule and file types; do not infer from a few live threads. |
| Sender proof | Decoded first original `From` display name starts with `Centurion at` | Define the target's original-header rule. Never substitute stored `from_address`. |
| Date window | None | Keep no date filter unless owner explicitly chooses and documents one. |
| Output root | Ignored `.private/` | Preserve private storage, permissions, and no-external-service boundary. |

The Centurion transport, filename regex, and `From` prefix are hard-coded in the live scripts and dataset schema/manifest. A second mailbox therefore needs a small, reviewed parameterization plus tests for selection, decoded raw-MIME matching, missing evidence, and review-required links before live extraction. Do not use this dataset's counts as expected counts for another mailbox.

### 6.4 Current repeatability gaps

- The run kit is being shipped in separate reviewed slices. Before relying on a clean or remote checkout, verify it contains the exporter, retry, collector, builder, supporting field/link modules, tests, SQL and this report at the intended merged revision.
- The encrypted transfer's exact upload/download invocation and cleanup confirmation are not recorded. Capture them next run without exposing guest data; delete the temporary transfer object only after local hashes verify and cleanup is authorized.
- The separate inventory SQL had ambiguous joined `message_id` references; those references were qualified after review. The corrected SQL has not been run against PostgreSQL.
- The ordered-ID digest guard was added after the live collection. A synthetic range-payload test passes, but the guard has not yet been exercised against EC2/SSM. The full private rebuild after the in-memory reduction and missing-helper fix reproduced the reported aggregate counts.
- This guide describes the tested Centurion path. Cross-mailbox parameterization remains future work; it is not a supported flag-only operation.

## 7. Open items and next steps

1. **Preserve the run kit.** Verify all reviewed scripts, regression tests, report and scoped SQL are present at the intended merged revision before the worktree is cleaned. Keep guest data under `.private/`; never commit it.
2. **Close transfer cleanup when authorized.** The local bundle hashes were checked. The temporary encrypted S3 transfer object remains present; delete it only through the approved cleanup path after authorization.
3. **Finish verification of final edits.** Exercise the ordered-ID check through the approved SSM collector path if needed; run final-head remote tests and typecheck by the approved route. The local synthetic tests and private full rebuild passed; they do not replace final-head checks.
4. **Stop further raw-MIME investigation for this dataset.** Owner accepts the 369 missing objects as unresolved; their stored `sentAt` dates span 2026-07-27–2026-09-01. The 31 records without locators have no verified date range. These 400 remain unknown. In addition, the legacy exporter's 1,480 `no_match` labels are unverified because missing or unparseable senders were not distinguished; do not claim strict sender-verified coverage. Current candidate volume is enough to start comparative experiments; it does not establish completeness or representativeness.
5. **Next research slice: compare suggestions.** In a later grilling-and-docs session, jointly lock the question, why, method, and evidence bar. Owner-proposed seed window is Monday–Wednesday, 2026-10-26–28; verify volume and quality before fixing the sample. Run quick comparative tests to measure which suggestions are better. Gold labels and independent HMS truth matching remain part of that work; neither was done here. The date window is a proposal, not approval to start the evaluation now.
6. **Scope the next mailbox.** Select one target mailbox and approve its transport, filename rule, original-header sender rule, and date scope; then parameterize and test before extraction.
7. **Retain the source-completeness caveat.** Stored BCC/corpus rows do not prove every outbound message was captured, and the database endpoint was not independently validated for this dataset run.
