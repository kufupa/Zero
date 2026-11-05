# Saved-mail MIME indexer

Private, read-only utility. It joins standardized packet cases to saved remote
mailbox snapshots by _source.row_ids, reads each selected raw MIME object
from S3 with GetObject, and writes attachment metadata only. It never writes
to a mailbox, database, or snapshot. It does not decode attachment contents.

## Run

~~~bash
python3 -B docs/research/halloween/corpus-analysis/mailbox-mime-index.py \
  --packets .private/path/to/packets.jsonl \
  --snapshots SNAPSHOT_A SNAPSHOT_B \
  --output .private/path/to/mime-index.jsonl \
  --sample-size 100 --seed 20261102 --estimate-full-cases 4516
~~~

For DaVinci or another packet source, pass its JSONL file and saved snapshot
names. If its cleaned text fields differ, set --current-text-path and
--quoted-text-path (dotted JSON paths). Set --remote-corpus-root or
--pm2-process only when the approved EC2 snapshot layout differs.

Omit --sample-size to process all cases. Do not run a full corpus until the
sample report is reviewed. Use --resume only with the same input/config;
OUTPUT.manifest.json checks the packet hash, snapshot order, sample seed,
size limit, and other options. The JSONL output is also the checkpoint: after
each SSM batch it is atomically replaced and still has at most one record per
case. read_error rows retry on resume; other statuses are treated as
terminal for the same saved snapshots.

Default safeguards:

- S3 object ceiling: 15,000,000 bytes. Larger objects are closed before reading
  the body. Unknown-size objects are read only up to the ceiling plus one byte.
- S3 GET concurrency: 4 workers maximum. SSM batches: 50 cases by default.
- All output, manifest, report, lock, and temporary files use mode 0600.
  Output/report paths must be under .private, with an owner-only parent dir.
- The script uses the existing read-only SSM wrapper and the configured PM2
  process only to obtain the approved S3 settings.

## JSONL index schema

One JSON object per selected input case:

~~~json
{"case":"I00001","status":"ok","attachments":[{"name":"hotel_voucher_redacted.pdf","content_type":"application/pdf"}],"body_status":"not_needed"}
~~~

status is one of:

- ok: MIME source read and parsed. Empty attachments confirms no attachments.
- locator_missing: no source row in the supplied snapshots had a usable locator.
- too_large: locators existed, but all candidate objects exceeded the ceiling.
- read_error: S3/MIME failure remained after trying available fallbacks.

Attachment entries contain only reduced name and normalized content_type.
Unknown filename tokens become redacted; only document-type words from a
small allowlist survive. This intentionally loses guest, account, long ID, and
other unknown filename fragments. Exact MIME parts are preserved in message
order; repeated row IDs and repeated S3 locators are deduplicated.

body_status is independent of attachment status:

- not_needed: packet already has current or quoted text.
- not_requested: input text was empty, but --no-recover-empty-body was set.
- ok: bounded recovered_body field is present (maximum 6,000 characters).
- empty: MIME parsed, but no current body text remained.
- locator_missing, too_large, read_error: body could not be recovered.
- withheld_sensitive: a remaining sensitive payment pattern caused omission.

Body recovery is attempted only when both configured current and quoted input
text are empty. It reads MIME text/plain or visible HTML body parts only:
attachments and attached message/rfc822 subtrees are excluded. HTML tags,
quoted blocks, common forwarded-message tails, signatures, links, email
addresses, credential fields, long numbers, greetings/signatures, and common
name fields are stripped or redacted before body text leaves EC2. If scrubbing
cannot establish safety, the text is withheld. Attachment contents are never
used as body text.

Inline CID images are skipped unless filename semantics suggest a real
document (for example, payment proof or voucher). Inline PDFs and other named
documents remain in the index. Attached images remain included.

## Source lookup and fallback

For each case, duplicate _source.row_ids are removed while preserving input
order. Each unique row ID is tried in input order; within that ID, supplied
snapshot names are tried in CLI order. A missing locator, oversized object, or
read/parse failure falls through to the next candidate. If a parsed message
has attachments, the first nonempty copy wins; if it has none, remaining
distinct locators are checked before confirming an empty list. Distinct
locators are fetched once per SSM batch; duplicate MIME parts inside the
chosen message are not collapsed. Index rows contain no row IDs, S3 locators,
raw MIME bytes, or per-case metrics.

The sibling OUTPUT.summary.json contains aggregate status/coverage counts,
fallback/dedup counts, S3 GET count and body bytes, oversize counts, skipped
inline CID images, elapsed time, and optional linear full-run estimate. It
contains no raw message text or source IDs.

If an early successfully parsed MIME copy has no attachments, the indexer
tries remaining distinct source locators before recording `ok` with an empty
attachment list. A failed/oversized/unscannable alternate after an empty copy
produces `read_error`, so the output does not claim confirmed absence. When a
nonempty copy is found, it is used immediately; later copies are not unioned.
The summary reports `unexamined_locator_candidates_after_attachment` for
this possible partial-coverage risk.
