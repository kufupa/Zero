# Connected mailbox attachment-inclusive corpus export

This workflow is intentionally split into two trust boundaries:

1. An approved Zero operational host runs the existing read-only live exporter.
2. A local workstation analyzes the sealed private snapshot.

The production-side command must not be run from a laptop, in Vitest, or during
this implementation session. It requires the existing Linux/IMDS approved-host
attestation, canonical ignored `.private/connected-mailbox-corpus` destination,
real S3 storage, and a non-empty repeatable-read Postgres scope.

## Approved-host export

Use the existing exporter with the attachment mode:

```bash
unset NODE_ENV VITEST_ALLOW_PILOT_RDS
cd /home/ubuntu/repos/zero
node --import tsx apps/server-pilot/scripts/export-centurion-thread-corpus-live.ts --mode attachment-inclusive
```

`--attachment-inclusive` is an equivalent shorthand. The default no-argument
mode remains metadata/PDF-text compatible and does not retain original bytes.
The mode retains bounded PDF/image bytes under `attachment-bytes/*.bin`; PDF
embedded text remains a separate `attachment-text/*.txt` artifact. Every
descriptor remains in the corpus even when a read is missing, oversized,
unsupported, encrypted, malformed, timed out, or failed. The exporter never
prints storage keys, addresses, bodies, attachment text, credentials, or raw
bytes.

The existing hydration limits remain authoritative: 20 MiB per attachment
input, 256 KiB extracted text, 256 MiB aggregate retained artifacts, and 15 s
per-object timeout (with the existing abort grace). A per-object or aggregate
limit produces an explicit status and preserves the metadata descriptor; it
does not silently drop the attachment.

The live command prints only a safe summary and publishes an allocated private
snapshot directory. Never overwrite an older snapshot or copy private payloads
to Git, S3, chat, CI logs, or another remote service.

## Local verification and analysis

On a workstation, use a copied sealed snapshot directory only. Before any
Vitest command, enforce the Zero database boundary:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
node --import tsx apps/server-pilot/scripts/verify-attachment-corpus-export.ts \
  --snapshot-dir .private/connected-mailbox-corpus/<published-directory>
python3 apps/server-pilot/scripts/analyze-attachment-corpus-2026-08-31.py \
  --snapshot-dir .private/connected-mailbox-corpus/<published-directory> \
  --out-json .private/connected-mailbox-corpus/follow-up/attachment-analysis-2026-08-31.json \
  --out-md .private/connected-mailbox-corpus/follow-up/attachment-analysis-2026-08-31.md
```

The verifier checks manifest hashes, ordered records, artifact linkage, byte
counts, SHA-256 values, deterministic artifact IDs, private `0600` artifact
permissions, path containment (including symlink rejection), and absence of
partial files. The analyzer performs local hash deduplication,
inline/decorative classification, PDF/image counts, PDF text-state accounting,
explicit `ocr_unavailable` image states, conservative field extraction, and
email-versus-attachment relationships (`email_only`, `attachment_only`,
`both`, `mismatch`, `neither`, or `unresolved_extraction`). It emits only safe
summary JSON/Markdown; attachment text and original payloads remain in the
private snapshot directory.

If real PDFs are needed, the approved-host handoff is the export command above.
Do not execute it from this development environment. The local handoff path
for generated private payloads is the published snapshot directory plus
`.private/connected-mailbox-corpus/follow-up/` for the two analysis artifacts.
