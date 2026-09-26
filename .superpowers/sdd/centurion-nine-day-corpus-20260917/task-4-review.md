# U4 blinded human-response analysis — remediation report

Date: 2026-09-17  \
Scope: `analyse-centurion-human-responses.ts` and its focused regression suite.  \
Baseline reviewed: `586ea2dd8`  \
Production access: not used; no payloads or PII were read or emitted.

## Findings repaired

- Quote/header/future leakage now fails closed. Plain-text quote markers terminate the quoted suffix, HTML quote containers and marker blocks are removed, target/post-target bodies and header material are normalized and audited, and a leaking target gets no worker call.
- A target is created only for a hash-verified U3 record whose status is `classified`, business direction is `outbound`, and origin is `human`. Missing or tampered classification cannot become a prediction target.
- RFC/thread-linked records without a trustworthy event time remain visible as candidates, are marked `context_incomplete`, and receive no prediction. Linked ambiguous-direction records are retained as ambiguous candidates rather than treated as absent.
- Worker responses use the canonical multi-operation array schema. Required fields, string lengths, operation count, unknown keys, and canonical/compatibility alias conflicts are rejected. The schema hash now covers request/response fields, aliases, vocabularies, and bounds.
- Predictor inputs are deep-cloned/frozen at the hash boundary. The worker receives a separate mutable copy; the persisted predictor input and pre-target hash cannot be changed by transport code.
- Output is restricted to the actual checkout’s ignored `.private/centurion-corpus/<snapshotId>` root. The existing `apps/server-pilot/.private` path and missing private-root ignore contract are rejected; output directories are mode `0700` and files mode `0600`.

## Regression coverage

`centurion-human-response-analysis.test.ts` covers quote/header leakage, missing/tampered classification, unknown-time linked evidence, identity-linked ambiguous direction, alias conflicts and bounds, deep worker mutation, and repository-private output rejection. Existing RFC matching, ambiguity, cutoff, attachment, unavailable transport, multi-operation, and permissions tests remain in the focused file.

## Verification contract

All commands were run from the worktree with `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS` unset. No production or disposable database was contacted.

- Focused U4 Vitest: **15 tests passed**.
- Server TypeScript (`tsc -p apps/server-pilot/tsconfig.json --noEmit`): **passed**.
- Targeted Prettier check: **passed**.
- Targeted `git diff --check`: **passed**.

The private output fixture uses a unique temporary snapshot basename under the real ignored root and cleans only that exact generated directory.

## Residual review rerun

The residual leakage and package-cwd findings are closed. When leakage is
detected, the tainted predictor input is discarded before both the target
manifest and prediction freeze are built; the freeze therefore retains only
hashes, status, and the explicit `target_payload_leakage` error. The regression
asserts that target header and body text are absent from the persisted freeze.
Fixture outputs now resolve from the test module to the actual checkout root,
so package invocation exercises the same strict production output guard.

Fresh verification from `apps/server-pilot`:

- Standard focused Vitest: **15 tests passed**.
- Root-workaround guard regression: **1 passed, 14 skipped**.
- Server TypeScript (`pnpm --filter @zero/server exec tsc --noEmit --pretty false`): **passed**.
- Targeted Prettier check: **passed**.
- Targeted `git diff --check`: **passed**.

No production database, private snapshot, external model, or message payload
was accessed.
