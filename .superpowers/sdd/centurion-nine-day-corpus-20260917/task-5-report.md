# U5 implementation report

Status: implemented; offline verification complete. The live comparator was not run.

## Changed

- Added the post-freeze `compareCenturionHumanGold` runtime and CLI.
- Added sealed U1/U2, U3 classification, and U4 target/prediction hash and leakage checks.
- Added injected, bounded, retryable gold-comparator transport support. The default transport is fail-closed and records an unavailable runtime blocker.
- Added semantic operation/required-field comparison with separate `claimed_action` and `verified_pms_action`; PMS verification defaults to `not_observed` without an authoritative receipt/read.
- Added distinct-task tool-demand aggregation and sanitized Stagehand handoff generation.
- Added owner-only, create-only private artifact writes with mode checks and symlink/path validation.
- Added focused offline tests covering semantic mismatch, multi-operation predictions, duplicate-task aggregation, unanswered/late/error strata, freeze tampering, privacy, permissions, and immutability.

## Verification

Run with `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS` unset:

- `pnpm exec vitest run tests/centurion-human-gold-comparison.test.ts --config vitest.config.ts` — 4 tests passed.
- Targeted strict TypeScript check for the comparator — passed.
- Full `pnpm exec tsc --noEmit -p tsconfig.json` — passed.
- Prettier check for both U5 source files — passed.

## Concerns

- A fresh approved comparator/model transport must be injected for the live run; no production, RDS, S3, mail, PMS, deployment, or Stagehand mutation was performed.
- The current implementation records PMS actions as `not_observed` unless callers supply authoritative PMS receipt/read evidence.
- The live run must use the canonical U4 frozen input and write a new snapshot directory; existing private outputs are rejected.

Implementation commit: `9e213d70`.

## Live execution addendum (2026-09-17)

The approved fresh Luna-Max comparator ran in five private shards (110, 110,
109, 109 and 109 targets) after the U4 freeze. A schema repair was required for
one shard whose operation entries were initially encoded as strings; the shard
was rewritten and revalidated before comparison. The canonical U5 output is:

`.private/centurion-corpus/centurion-gold-final4-20260917-live/`

- 547/547 target gold claims observed; 1,829 total comparison records after
  1,282 explicit supplemental unanswered/automated records;
- 224 prediction errors remain the explicit U4 target-payload-leakage stratum;
  the comparator itself had zero runtime blockers;
- semantic grades: 3 partial, 224 prediction-error, 1,602 not-scored (status,
  unavailable or supplemental strata); no prose-similarity score was used;
- claimed human actions: 547 observed; authoritative PMS actions: **0
  observed**, 1,829 `not_observed` by design because no PMS receipt/read was
  supplied;
- private audit records matching U1/U2 ordered/manifest hashes, U3 input
  hashes and U4 target/prediction hashes; the handoff contains aggregate
  frequencies and opaque evidence IDs only.

The U5 implementation was tightened after the first live attempt to accept the
explicit U3 core+spillover partition (not older context/out-of-window rows)
and to null unknown candidate endpoint names. Focused tests and TypeScript were
rerun with production database variables unset.
