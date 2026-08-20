# PDF Inspector Backtest Handoff

Status: `DONE_WITH_CONCERNS`  
Run: `bda9cfd2-e8b2-44ea-b894-3e825a98de9d`  
Date: 2026-08-08

## Verdict

Retain Poppler. Do not promote Firecrawl Inspector.

Full corpus and current-runtime subset completed with terminal accounting:

- Full corpus: `302 / 302`
- Current-runtime subset: `179 / 179`
- Missing terminal results: `0`
- Identity drift: `0`
- Adjudications: `302 / 302`

## Opaque scorecard

Adjudication labels:

- Equivalent: `170`
- Inspector better: `65`
- Poppler better: `13`
- Both insufficient: `2`
- Needs OCR: `51`
- Unreadable: `1`

Initial discrepancy routing:

- Status mismatch: `174`
- Extraction-failure mismatch: `68`
- Inspector-better candidate: `7`
- Poppler-better candidate: `2`
- Needs OCR: `51`
- Equivalent: `0`
- Manual unreadable: `0`

Parser reason counts:

- Poppler: text `191`, no embedded text `45`, encrypted `65`, malformed `1`
- Inspector: text `247`, no embedded text `48`, encrypted `1`, parser failure `6`

Timing percentiles:

- Poppler: p50 `29 ms`, p95 `42 ms`
- Inspector: p50 `53 ms`, p95 `98 ms`

## Gate evidence

- Inspector sandbox, resource, protocol, provenance, and no-network gate: `PASS`
- Inspector package: `1.12.0`
- Native `lopdf`: `0.41.0`
- Inspector provenance: backtest-only
- Production patched-native requirement (`lopdf >= 0.42.0`): `FAIL`
- Quality gate: `FAIL`; Poppler remains better on `13` usable documents
- Production code cutover: not attempted

The published Inspector binary is suitable for this isolated comparison only. Its advisory-exposed native dependency and the Poppler-better bin independently block promotion.

## Adjudication method

All `302` terminal comparisons received an opaque, source-bound adjudication record in the owner-only private run directory. Local deterministic checks handled readability, extraction failures, OCR signals, page counts, normalized token overlap, and known structured-output failure patterns. Representative private side-by-side records were reviewed locally to validate the routing rules. No LLM or external extraction service participated.

One first-pass false positive treated Poppler's PDF page-separator form-feed (`\f`) as corruption. The adjudication pass was regenerated with ordinary line/page separators excluded from the control-character check. Current artifact contains `302` unique source-bound records and no raw text fields.

## Verification

- Focused PDF tests: `93 passed`, `6 skipped`
- Linter diagnostics for changed PDF files: none
- EC2 native Inspector gate: pass
- TypeScript build: blocked by pre-existing unrelated errors in `src/ai/draft-backtest-agent.ts:102-104`; no PDF backtest error reported
- Private artifact directory: owner-only; adjudications file mode `600`; directory mode `700`

## Deferred work

Repeat the full read-only backtest only after Firecrawl publishes a native build proven with `lopdf >= 0.42.0`. Promotion also requires zero Poppler-better critical regressions and a fresh safety/provenance gate. OCR and LLM enrichment remain out of scope.

No raw corpus output, source identifiers, hashes, filenames, addresses, S3 keys, or parser stderr are stored in this handoff or Git.

## Patched-upstream candidate follow-up — 2026-08-10

Firecrawl main was built in a detached, owner-only EC2 candidate stage at source
revision `f4b8c9e8546703e3817d9c47498d822cb2db81e3`. Its N-API lock resolved
`lopdf 0.42.0`. The staged native gate passed with the same no-network,
Bubblewrap, resource-limit, provenance, ABI, and read-only-tree checks.

The patched candidate replayed the original frozen manifest without changing
canonical dependencies:

- Full corpus: `302 / 302`; current-runtime subset: `179 / 179`
- Missing terminals: `0`; identity drift: `0`
- Candidate adjudications: `302 / 302`
- Adjudication labels: equivalent `168`, Inspector better `68`, Poppler better
  `11`, both insufficient `5`, needs OCR `49`, unreadable `1`
- Poppler timing: p50 `31 ms`, p95 `48 ms`
- Patched Inspector timing: p50 `66 ms`, p95 `130 ms`

The candidate improved structured output on a small manually reviewed changed
set, but still has ten bounded parser failures and eleven Poppler-better
adjudications. Retain Poppler in production. The candidate remains an
evaluation-only staged build: Firecrawl's published `1.12.0` package has not
yet supplied the fixed native distribution, and no content-addressed internal
distribution was approved.

The first immutable replay exposed legacy source manifests created before
terminal source identities were persisted: they contained the exact
empty-byte SHA-256 placeholder and no expected S3 identity. Replay now accepts
only that narrowly identified legacy representation, then binds the candidate
run to the source terminal's recorded identity and SHA-256. Modern non-empty
fingerprint or identity mismatches still fail closed.

No upstream PR was opened. Firecrawl main already carries the `lopdf` remedy;
opening a duplicate dependency-change PR would add no value.

## Hardened candidate replay — 2026-08-10

Independent candidate-stage findings were remediated before a second immutable
replay. The candidate now binds normalized non-`.git` source-tree bytes, verifies
clean HTTPS `main` provenance at execution, rejects prerelease `lopdf` values
below `0.42.0`, starts its native gate from an allowlisted environment, and
required a narrow trust-boundary follow-up before any future candidate execution.

The hardened staged candidate completed its paired replay:

- Full corpus: `302 / 302`; current-runtime subset: `179 / 179`
- Missing terminals: `0`; identity drift: `0`; adjudications: `302 / 302`
- Candidate outcome changes versus the prior staged replay: `8`
- Adjudication labels: equivalent `166`, Inspector better `68`, Poppler better
  `13`, both insufficient `3`, needs OCR `51`, unreadable `1`
- Focused PDF fixture tests: `128 passed`, `8 skipped`; candidate gate shell
  syntax: `PASS`

Verdict remains unchanged: retain Poppler in production. The `13`
Poppler-better adjudications fail the fixed promotion rule requiring Inspector
to win or tie every document where both parsers are usable. No production
dependency, parser cutover, or upstream PR was created.

## Trusted-bootstrap remediation — 2026-08-10

Review found that descriptor-controlled stage code could previously supply
host-side runner, gate, child, or probe paths. Candidate execution now uses
canonical trusted bootstrap code for all of those controls; the stage supplies
only read-only source/package material mounted into the existing sandbox.
Checkout validation also disables repository Git helpers, and normal gate
execution begins from a clean `env -i` shebang.

Focused fixture tests passed (`92 passed`, `8 skipped`), TypeScript build and
gate shell syntax passed, and EC2 directly executed the clean-launch gate with
inherited-shell-hook and Node-option negative controls. It passed with the
patched `lopdf 0.42.0` candidate. This hardening does not change the immutable
replay result or the production decision: retain Poppler; Firecrawl remains
evaluation-only and promotion-blocked.
