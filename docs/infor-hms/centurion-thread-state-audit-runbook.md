# Centurion thread-state audit runbook

> Purpose: produce a fresh, private, read-only thread-state result. This runbook publishes no live count by itself; operational status remains `not_available` until all required receipts validate.

## Scope and non-goals

Flow: **Task 1 canonical export → Task 3 local adjudication → Task 4 private reports**.

- Read from the authorized mail database only through the Task 1 canonical exporter.
- Write only owner-controlled private local artifacts. Do not mutate database rows, mail, PMS records, or external storage.
- Do not use a legacy Markdown dump, any raw-dump transfer route, or an S3 copy step.
- Never print or paste mail content, addresses, subjects, identifiers, or environment values into stdout, chat, Git, or a ticket. Exporter may reveal its local private output path only in the local operator's private terminal; never copy that path into a receipt, chat, Git, ticket, or other publication.

## Preconditions

1. Operator host is supported Linux. Windows may inspect help or run synthetic checks, but private corpus/report publication must fail closed off Linux.
2. Required code revision is synchronized onto operator host before environment setup. Record revision only in the private receipt.
3. Private root and parents are operator-owned, non-symlink directories with mode `0700`; private artifacts must be `0600`.
4. Production environment file is accessible only to operator. Source it **only inside the export operation subshell** below. Never source it into a shell that could run Vitest or any other test runner.
5. Required Task 1 cutoffs, Task 2 roster/coverage inputs, and Task 3 review inputs were approved before execution.
6. Operator can stop on any validation error. Do not retry by widening scope, changing cutoffs, bypassing ownership checks, or using a fallback data source.

### Refresh-skill status

`.cursor/skills/centurion-email-refresh/SKILL.md` remains retired/stale. This task does not edit or migrate it. Do not use it for this flow; a separately tested skill-migration task must replace it.

## Safe command preparation

From `apps/server-pilot`, inspect only the purpose-built CLIs before opening an operation subshell:

```bash
pnpm exec tsx scripts/export-centurion-thread-state-corpus.ts --help
pnpm exec tsx scripts/centurion-thread-adjudication.ts --help
```

Use the current `--help` output to replace every angle-bracket placeholder below. Do not infer undocumented flags or use generic SQL, mail dump, test, S3, or browser commands.

## 1. Task 1 — canonical read-only export

Run this once on Linux. The environment source and exporter stay inside one operation-only subshell; do not invoke Vitest, `pnpm test`, or another test runner in it.

```bash
(
  set -euo pipefail
  cd <synchronized-operator-host>/apps/server-pilot
  set -a
  . <operator-only-environment-file>
  set +a

  pnpm exec tsx scripts/export-centurion-thread-state-corpus.ts \
    --execute \
    <approved-exact-event-and-ingest-cutoffs> \
    <approved-private-output-argument>
)
```

Expected behavior:

- Exporter uses its read-only transaction contract and validates canonical source coverage, cutoff format, message/thread binding, and corpus integrity.
- Output remains inside approved private root or an approved external private location.
- Any receipt copied or published outside the private terminal excludes the output path and contains only schema/version, aggregate count, cutoff provenance, and digest fields.

Stop if the command reports unsupported platform, unsafe output permissions, existing/symlink target, invalid cutoff, coverage failure, integrity mismatch, database error, or any attempted mutation.

## 2. Task 3 — local adjudication

Do not re-source the production environment. Run against the validated private Task 1 artifact and approved local review inputs only.

```bash
(
  set -euo pipefail
  cd <synchronized-operator-host>/apps/server-pilot

  pnpm exec tsx scripts/centurion-thread-adjudication.ts \
    --apply \
    <validated-task-1-corpus-input> \
    <approved-roster-and-review-inputs> \
    <approved-private-output-argument>
)
```

Expected behavior:

- Closed annotations and quote coverage are applied against the full validated corpus.
- Missing, conflicting, weak, quote-only, unsupported, or incomplete evidence remains manual; it must not become resolved or zero work.
- Local safe receipt emits only aggregate counts and digests. Any review packet containing raw material remains private and is never copied elsewhere.

Stop on parser, cache/signature, provenance, review-binding, source-coverage, or private-writer failure. Do not hand-edit an artifact to continue.

## 3. Task 4 — private reconciled reports

Run only after Task 3 completes and its result binds to the same validated Task 1 corpus.

```bash
(
  set -euo pipefail
  cd <synchronized-operator-host>/apps/server-pilot

  pnpm exec tsx scripts/centurion-thread-adjudication.ts \
    --apply \
    --reports \
    <validated-task-1-corpus-and-task-3-inputs> \
    <approved-private-report-root>
)
```

Expected behavior:

- Report publication is Linux-only and owner-only, validates reconciliation, and fails closed before a final report directory appears.
- Private case/action material stays private. Safe index, metrics, definitions, provenance, and receipt fields use aggregate and opaque values only.
- Expected receipt confirms report reconciliation, output modes, artifact membership, and aggregate timing/state counts without raw mail data.

Stop on reconciliation mismatch, unsafe root/target, staging/publication failure, or report validation error. A partial report directory is not a result.

## Receipt gate and publication decision

Only assess operational status after the following private receipts agree on one run:

| Gate | Required safe evidence | Failure result |
| --- | --- | --- |
| Canonical corpus | schema/version, exact cutoffs, coverage/provenance, digest, aggregate count | `not_available` |
| Adjudication | closed-decision/review status, aggregate state counts, digest bindings | `not_available` |
| Reports | reconciliation status, aggregate metrics, safe artifact receipt | `not_available` |

If every gate passes, publish a new **aggregate-only** status update. Do not publish raw content, direct identifiers, stable message/thread references, or private report paths. If any gate fails or manual review remains incomplete, preserve status `not_available`.

## Retention and cleanup

- Keep private corpus, review packets, and reports only under approved owner-only storage and retention policy.
- Do not upload raw artifacts to S3, Git, chat, issue trackers, or general-purpose shared storage.
- Record completion outside the private terminal with safe receipts only: run timestamp, code revision, validation status, aggregate counts, schema/version, and digests; omit private output paths.
- Purge private artifacts using the approved operator retention process after required review is complete. Do not replace retention controls with ad hoc copies.

## Related records

- Operational status: `docs/infor-hms/centurion-thread-state-status-2026-08-10.md`
- Historical audit: `docs/infor-hms/centurion-mailbox-audit-2026-08-09.md`
- Historical method: `docs/infor-hms/centurion-mailbox-audit-method-2026-08-09.md`
- Durable learning: `docs/solutions/logic-errors/centurion-message-level-response-metric.md`
