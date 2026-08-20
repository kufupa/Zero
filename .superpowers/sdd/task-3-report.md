# Task 3 Report — PDF Inspector immutable corpus backtest runner

Date: 2026-08-08
Branch: `EC2-pilot`
Status: **DONE — fixture path verified; live EC2 adapter wired and fail-closed**

## What changed

- `apps/server-pilot/src/ops/pdf-inspector-backtest-runner.ts`
  - Strict CLI contracts and exit codes `0/2/20/30/40`.
  - Fixture manifest schema: inbound, non-inline `application/pdf`; size bounds; duplicate collapse; oldest-first order.
  - GetObject-only bounded reader contract; one fetch per attachment; size, MIME, `%PDF-`, source-hash, and source-identity checks.
  - Injected deterministic parser functions plus production adapters using `extractEmbeddedPdfText` and `inspectPdf`.
  - Append-only owner-only memory/file stores, fsync, JSONL manifest/results, resume, missing accounting, identity-drift terminal state, status/private helpers, expiry purge.
  - Aggregate-only report through `aggregatePdfInspectorBacktest`; fixture provenance remains `backtestOnly=true`, so recommendation stays blocked.
  - Concrete Linux/EC2 live factory: dedicated `postgres` read-only/repeatable-read snapshot, bounded statement timeout, projected attachment metadata, in-memory `buildThreadContext` runtime subset, mailbox grant proof, GetObject-only S3 reader, and native Poppler/Inspector gates. Non-Linux or missing env fails closed.
  - Identity drift persists bounded failure comparisons; terminal records bind run/source refs through Task 2 validation. Source key, expected identity, and fixture SHA-256 remain private immutable manifest fields.
  - Private file store rejects symlinks, uses no-follow opens, checks Linux ownership/write bits, preserves expiry, and rejects expired resumes.
- `apps/server-pilot/scripts/run-pdf-inspector-backtest.ts`
  - Thin CLI entrypoint.
- `apps/server-pilot/tests/pdf-inspector-backtest-runner.test.ts`
  - 31 focused tests; 30 pass on Windows, one portable symlink test skipped.
- `apps/server-pilot/package.json`
  - Added `backtest:pdf`.

## TDD evidence

### RED

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run tests/pdf-inspector-backtest-runner.test.ts
```

Result: failed at collection because `pdf-inspector-backtest-runner.js` did not exist.

### GREEN

Same focused command: **1 file, 30 passed, 1 skipped**.

## Verification

| Check | Result |
|-------|--------|
| Focused runner Vitest | PASS — 30/30 executable tests |
| PDF parser/backtest regression Vitest | PASS — 62/62 executable tests |
| Strict targeted TypeScript (`runner` + CLI) | PASS |
| Package CLI `backtest:pdf -- --help` | PASS |
| Linter diagnostics on changed code | PASS — none |
| Full server TypeScript project | Existing unrelated errors in `src/ai/draft-backtest-agent.ts`; no runner/CLI errors |

All test commands cleared `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS`. No AWS, RDS, or S3 access performed.

## Remaining EC2 proof

1. Run live script through SSM on Linux only after verifying owner-only root, toolchain, DB read-only state, and bounded S3 permissions.
2. Post-run verify manifest/result cardinality, identity-drift count, aggregate stdout privacy, and no parser promotion.
3. Never run this test suite against pilot RDS; live verification is a read-only non-test command.
