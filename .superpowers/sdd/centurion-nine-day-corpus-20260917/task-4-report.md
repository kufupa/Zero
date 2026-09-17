# U4 blinded inbound-to-human-response analysis report

Status: DONE_WITH_RUNTIME_BLOCKER

## Scope implemented

- Added `analyse-centurion-human-responses.ts`, a local-path-only reader and
  held-out target pipeline for sealed U1 normal/U2 quarantine snapshots plus
  U3 classification JSONL. It validates the fixed Centurion transport/window,
  source schemas, ordered source hashes and classification input hashes before
  constructing targets.
- Matches each in-window human outbound using exact RFC `In-Reply-To`, RFC
  `References`, then strong thread identity within a bounded causal window.
  Direct/reference matches are never silently replaced by a weaker match;
  unrelated inbound mail is separated from related-but-ineligible evidence.
  Every emitted target has exactly one of `paired`, `ambiguous`,
  `no_eligible_inbound` or `outbound_only`.
- Builds a predictor input containing the triggering inbound and strictly
  earlier same-task context only. Target and post-target bodies, headers,
  attachments, IDs and timestamps are excluded from the worker request;
  quoted text/HTML is removed, and unavailable earlier attachments remain only
  as explicit metadata with `context_incomplete` evidence. Stage 1 labels are
  not included in predictor context.
- Writes an immutable owner-only `target-manifest.jsonl` before invoking any
  worker. Target body/header/attachment hashes, pre-target input/body hashes,
  cutoff flags, context flags and explicit errors are frozen before prediction
  output. `prediction-freeze.jsonl` contains no target plaintext.
- Added strict multi-operation response parsing for `read`, `create`, `amend`,
  `cancel`, `post_payment`, `refund`, `document`, `attachment`, `partner`,
  `channel`, `none` and `unknown`, with deterministic primary selection,
  required fields, candidate tool and required unknown reasons.
- Added injectable Luna worker transport with fresh opaque worker IDs,
  bounded retries and batches of at most five. The default transport fails
  closed with `luna_worker_transport_unavailable`; no synthetic prediction is
  produced. CLI output is sanitized and reports blocked status on worker or
  prediction errors.
- Enforced the root `.private/centurion-corpus/<snapshot>` owner-only output
  chain with symlink rejection, immutable create-only JSONL files and no use
  of `apps/server-pilot/.private`.
- Added focused offline tests covering operation/status vocabularies, RFC and
  thread matching, ambiguous and outbound-only strata, pre-window triggers,
  cutoff exclusion, unanswered inbound coverage, unavailable attachments,
  quoted/future leakage, hash freeze ordering, unavailable workers and
  multi-operation predictions.

## Verification

All test commands ran with `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS` unset.
No RDS, S3, mail, PMS, deployment or external model call was performed.

```text
pnpm exec vitest run tests/centurion-human-response-analysis.test.ts --config vitest.config.ts
8 tests passed

pnpm exec vitest run tests/centurion-human-response-analysis.test.ts tests/centurion-corpus-classification.test.ts tests/centurion-quarantine-export.test.ts tests/centurion-corpus-export.test.ts tests/centurion-thread-corpus-postgres-reader.test.ts tests/export-centurion-thread-corpus-live.test.ts tests/centurion-thread-corpus-exporter.test.ts --config vitest.config.ts
7 files, 63 tests passed

pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --esModuleInterop --types node scripts/analyse-centurion-human-responses.ts
passed

pnpm exec tsc --noEmit -p tsconfig.json
passed

pnpm exec prettier --check scripts/analyse-centurion-human-responses.ts tests/centurion-human-response-analysis.test.ts
passed

git diff --check -- scripts/analyse-centurion-human-responses.ts tests/centurion-human-response-analysis.test.ts
passed
```

## Concerns / evidence boundary

- An approved GPT-5.6-Luna-Max transport is unavailable in this runtime. The
  default path therefore records an explicit blocker and prediction errors;
  it does not claim model predictions or invent fallback labels. A live run
  with an injected approved transport is still required for prediction
  coverage.
- No live snapshot extraction or gold comparison was run. Input validation,
  matching, redaction, hash freezing, output guards and worker failure behavior
  are evidenced by synthetic offline fixtures; production corpus completeness
  and U5 semantic gold comparison remain outside this unit.
- Test fixtures and this report contain no mailbox bodies, addresses,
  attachment bytes or other production payload. Existing unrelated worktree
  changes, including `apps/server-pilot/.private/`, were left untouched.

## Report path

`.superpowers/sdd/centurion-nine-day-corpus-20260917/task-4-report.md`

Commit: recorded in the task handoff.

## Live execution addendum (2026-09-17)

The guarded U4 pipeline was run against the sealed U1/U2 snapshots and the
canonical U3 classification output. The first injected-worker attempts failed
closed because the transport boundary does not expose a target key; that
diagnostic output is retained privately. The corrected final runner keys the
three approved worker responses by the frozen `inputHash` and produced the
canonical output below.

- 547 in-window human outbound targets were emitted exactly once;
- statuses: paired 227, ambiguous 25, no-eligible-inbound 18, outbound-only
  277;
- 224 paired contexts were rejected as
  `target_payload_leakage` and persisted with a null predictor input;
- 3 safe paired contexts have `predictionStatus: frozen`, with no prediction
  errors; all other targets have explicit status/error records;
- pending-at-cutoff and late-response counts are zero; no target/post-target
  plaintext is present in the freeze.

Canonical live output:
`.private/centurion-corpus/centurion-human-final4-20260917-live/`.
