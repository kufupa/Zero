# Centurion Private Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn one verified private V2 snapshot into bounded local analyst packets, reconciled PII-free structured decisions, and a thresholded aggregate evidence report without any mailbox, database, cloud, model, or UI mutation.

**Architecture:** A pure analysis core derives deterministic opaque item IDs and validates closed-enum decisions against a validated V2 snapshot. A second pure evidence layer reconciles the sole logical-union denominator and produces aggregate-only report data with threshold/complement suppression. A Windows-only local CLI uses injected protected-file, Git-ignore, and ACL ports to create an isolated private workspace, read a locally supplied decision file, and emit fixed safe status JSON. Cursor orchestration, not application code, dispatches exactly one local analyst after packet creation.

**Tech Stack:** TypeScript, Zod, Node crypto/fs/path, existing `centurion-thread-corpus-v2` validator, Vitest, Prettier, oxlint.

## Global Constraints

- Treat `manifest.counts.logicalMessages + manifest.counts.scopedQuarantine` as the only decision denominator. Do not sum `messagesByScope`; dual-scope messages overlap. Do not add unresolved duplicate candidates, which are already a logical-message subset.
- Reconstruct a `PrivateThreadCorpusSnapshot` and call `validatePrivateThreadCorpusSnapshot` before deriving an item, packet, decision, or report. Reuse the relay's byte-to-snapshot reconstruction pattern, but never copy V2 comparators.
- `analysisItemId` = SHA-256 of canonical UTF-8 JSON containing only analysis schema version, snapshot ID, unit type (`logical_message` or `quarantine`), and a normalized, non-empty, duplicate-free sorted source-row-ID set. It must not contain a thread ID, message ID, header, address, subject, body, artifact path, or artifact hash.
- Private packet content may contain raw corpus content only under a new ignored, ACL-protected `.private/centurion-thread-analysis/` root. Decisions, public reports, stdout, stderr, errors, Git, CI, remote APIs, web/Exa/MCP, SSM, and dashboard DTOs may not contain raw PII, local paths, record IDs, artifact IDs, hashes that identify an item, or free text.
- The core imports no filesystem, child process, environment, database, network, AWS, Bedrock, Mastra, worker, category, mailbox, navigation, UI, or console module. No application code dispatches an LLM or Cursor subagent.
- Cursor dispatches exactly one standard local analyst at a time only after a verified private workspace exists. Dispatch prompt carries only the local workspace path plus fixed contract. The analyst writes a private closed-schema decision JSON; no raw mail text is copied into a prompt.
- `smtp_accepted` means only transport acceptance; it is never causal reply, service response, booking, conversion, revenue, or outcome evidence.
- Use a minimum public display count of five. A released categorical partition uses an ordered list of emitted cells, never a full enum record: every emitted count must be at least five, zero is never serialized, and an omitted label has no released zero/suppression meaning. Otherwise release the partition's single `suppressed` state and no cells. Never co-release a partition total or cross-tab that permits subtraction. If the logical-union denominator is below five, report `insufficient_sample` without numeric breakdowns.
- Before every Vitest command run `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`. Never set `VITEST_ALLOW_PILOT_RDS=1`, source `.env.production`, or run live corpus/EC2/S3/PowerShell operations during tests.
- No deployment, database migration, IAM/KMS/lifecycle edit, folder/category/backfill write, or RPA work belongs here.

## File Structure

- `apps/server-pilot/src/ops/centurion-thread-corpus-analysis.ts`: pure V2 reconstruction, deterministic item/packet derivation, closed decision schema, and complete decision reconciliation.
- `apps/server-pilot/src/ops/centurion-thread-corpus-evidence.ts`: pure aggregate report schema, denominator reconciliation, response/artifact/unknown availability states, and threshold/complement suppression.
- `apps/server-pilot/src/ops/centurion-thread-corpus-analysis-workspace.ts`: narrow Windows-only protected workspace adapter and injected ports; no analysis semantics.
- `apps/server-pilot/scripts/analyze-centurion-thread-corpus.ts`: strict `prepare`/`reconcile` command composition with fixed safe output only.
- `apps/server-pilot/tests/centurion-thread-corpus-analysis.test.ts`: synthetic V2 contract, IDs, packets, closed decisions, privacy, and source-boundary tests.
- `apps/server-pilot/tests/centurion-thread-corpus-evidence.test.ts`: denominator, availability, suppression, and report privacy tests.
- `apps/server-pilot/tests/analyze-centurion-thread-corpus.test.ts`: fake-only workspace/CLI ordering, ACL/Git-ignore, fixed-output, and no-live-adapter tests.
- `apps/server-pilot/tsconfig.centurion-analysis.json`: narrow typecheck project covering new source, script, and tests.
- `.gitignore`: add only `.private/centurion-thread-analysis/`.

---

### Task 1: Pure V2 analysis items and decision reconciliation

**Files:**
- Create: `apps/server-pilot/src/ops/centurion-thread-corpus-analysis.ts`
- Create: `apps/server-pilot/tests/centurion-thread-corpus-analysis.test.ts`
- Read only: `apps/server-pilot/scripts/export-thread-corpus.ts`
- Read only: `apps/server-pilot/src/ops/centurion-thread-corpus-relay.ts`

**Interfaces:**

```ts
export const CENTURION_THREAD_CORPUS_ANALYSIS_VERSION =
  'centurion-thread-corpus-analysis-v1';

export type AnalysisUnitType = 'logical_message' | 'quarantine';
export type AnalysisWorkflow =
  | 'reservation_new'
  | 'reservation_change'
  | 'reservation_cancel'
  | 'group_or_event'
  | 'guest_service'
  | 'operations'
  | 'payment'
  | 'document'
  | 'security'
  | 'system_routine'
  | 'system_failure'
  | 'feedback'
  | 'unknown';
export type AnalysisRisk =
  | 'none'
  | 'human_review'
  | 'failure'
  | 'payment'
  | 'policy'
  | 'cancellation_fee'
  | 'complaint'
  | 'security'
  | 'document'
  | 'vip_or_privacy';
export type AnalysisConfidence = 'low' | 'medium' | 'high';
export type ResponseEvidenceState =
  | 'smtp_accepted'
  | 'not_claimed'
  | 'not_applicable'
  | 'unknown';

export type AnalysisItemV1 = {
  schemaVersion: typeof CENTURION_THREAD_CORPUS_ANALYSIS_VERSION;
  analysisItemId: string;
  unitType: AnalysisUnitType;
  sourceMembership: Array<'centurion_transport' | 'designated_reservationist_mailbox'>;
  artifactState: 'complete' | 'partial' | 'unavailable' | 'not_applicable' | 'unknown';
  responseEvidenceState: ResponseEvidenceState;
};

export type PrivateAnalysisPacketV1 =
  | (AnalysisItemV1 & {
      packetState: 'complete';
      packetBytes: number;
      packetSha256: string;
      privatePacketBytes: Uint8Array;
    })
  | (AnalysisItemV1 & {
      packetState: 'truncated' | 'unavailable';
      packetBytes: 0;
      packetSha256: null;
      omissionReason: 'per_packet_limit' | 'aggregate_packet_limit' | 'unavailable_evidence';
    });

export type PreparedAnalysisManifestV1 = {
  schemaVersion: typeof CENTURION_THREAD_CORPUS_ANALYSIS_VERSION;
  snapshotId: string;
  snapshotDigest: string;
  maxPacketBytes: number;
  maxTotalPacketBytes: number;
  packets: Array<{
    analysisItemId: string;
    unitType: AnalysisUnitType;
    packetState: 'complete' | 'truncated' | 'unavailable';
    packetSha256: string | null;
  }>;
};

export type PreparedPrivateAnalysisV1 = {
  manifest: PreparedAnalysisManifestV1;
  manifestSha256: string;
  packets: PrivateAnalysisPacketV1[];
};

export type AnalystDecisionV1 = {
  schemaVersion: typeof CENTURION_THREAD_CORPUS_ANALYSIS_VERSION;
  analysisItemId: string;
  workflow: AnalysisWorkflow;
  risk: AnalysisRisk;
  confidence: AnalysisConfidence;
  attention: 'human_review' | 'routine' | 'unknown';
};

export type AnalystDecisionBundleV1 = {
  schemaVersion: typeof CENTURION_THREAD_CORPUS_ANALYSIS_VERSION;
  preparedManifestSha256: string;
  decisions: AnalystDecisionV1[];
};

export type ReconciledAnalystDecisionsV1 = {
  snapshotId: string;
  snapshotDigest: string;
  preparedManifestSha256: string;
  preparedManifest: PreparedAnalysisManifestV1;
  items: AnalysisItemV1[];
  decisions: AnalystDecisionV1[];
};

export function deriveAnalysisItemId(
  snapshotId: string,
  unitType: AnalysisUnitType,
  sourceRowIds: readonly string[],
): string;
export function createAnalysisItems(snapshot: PrivateThreadCorpusSnapshot): AnalysisItemV1[];
export function preparePrivateAnalysis(
  snapshot: PrivateThreadCorpusSnapshot,
  limits: { maxPacketBytes: number; maxTotalPacketBytes: number },
): PreparedPrivateAnalysisV1 | null;
export function reconcileAnalystDecisionBundle(
  snapshot: PrivateThreadCorpusSnapshot,
  preparedManifest: PreparedAnalysisManifestV1,
  decisionBundle: unknown,
): ReconciledAnalystDecisionsV1 | null;
export function validateReconciledAnalystDecisions(
  snapshot: PrivateThreadCorpusSnapshot,
  reconciled: unknown,
): ReconciledAnalystDecisionsV1 | null;
```

- [ ] **Step 1: Write failing pure-core tests**

Create a valid synthetic V2 snapshot using `buildPrivateThreadCorpusSnapshot`, then assert:

```ts
expect(createAnalysisItems(snapshot)).toHaveLength(
  snapshot.manifest.counts.logicalMessages + snapshot.manifest.counts.scopedQuarantine,
);
expect(
  reconcileAnalystDecisionBundle(snapshot, prepared.manifest, validDecisionBundle)?.decisions,
).toHaveLength(expected);
```

Add failing fixtures proving a multi-message thread yields one distinct item per nested `SnapshotMessage`, while each quarantine record yields one item. Cover reordered/duplicate source-row IDs, duplicate/missing/foreign decisions, stale or mismatched prepared-manifest hash, free-text extra key, malformed enum, tampered V2 bytes, oversized packet, packet-state/risk mismatch, and synthetic body/address/header/path marker leaks.

- [ ] **Step 2: Run the red test**

Run:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/centurion-thread-corpus-analysis.test.ts
```

Expected: module/API-not-found failure.

- [ ] **Step 3: Implement closed analysis contracts**

Rebuild records/artifacts from supplied V2 bytes using only the relay's validated closed member grammar, call `validatePrivateThreadCorpusSnapshot`, and derive one unit for each nested logical message plus one unit per quarantine record. A logical-message packet carries the complete parent thread for context plus an exact private selected-source-row set; reconciliation binds the decision to that selected unit, not to the thread as a whole. Normalize and reject duplicate/empty source-row IDs before hashing.

Construct each complete packet as canonical UTF-8 bytes before accepting it against the safe-integer per-packet and aggregate packet budgets. A complete packet stores only its exact bytes and SHA-256; truncated/unavailable variants store no raw record, source-row IDs, or artifact bytes. Create a canonical private prepared manifest after budget accounting. Its digest binds packet item IDs, packet states, packet digests, snapshot digest, and both byte limits. Model decision bundles as strict Zod objects whose keys are exactly the fields shown above; omit rationale, subject, header, identifier, and arbitrary metadata fields. `truncated` or `unavailable` packets may only reconcile to `workflow: 'unknown'`, `attention: 'human_review'`, and `confidence: 'low'`. Derive artifact and response evidence in core from the selected V2 source rows: quarantine is `not_applicable`; otherwise response is `smtp_accepted` if any selected row has that V2 delivery state, `not_claimed` only if every applicable selected row has it, and `unknown` otherwise. The analyst never supplies that field.

- [ ] **Step 4: Add core source/privacy guards**

Use TypeScript AST tests to reject imports/references to filesystem, child process, process/env, network, AWS, Bedrock, Mastra, database, UI, console, dynamic import, `eval`, `Function`, and constructor-based execution. Serialize every allowed public item/decision/reconciliation result and assert body/address/header/path/artifact marker absence.

- [ ] **Step 5: Run focused verification and commit**

Run:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/centurion-thread-corpus-analysis.test.ts
pnpm exec prettier --write src/ops/centurion-thread-corpus-analysis.ts tests/centurion-thread-corpus-analysis.test.ts
pnpm exec tsc --noEmit --rootDir . -p tsconfig.json
git diff --check
```

Commit only Task 1 paths:

```bash
git add apps/server-pilot/src/ops/centurion-thread-corpus-analysis.ts apps/server-pilot/tests/centurion-thread-corpus-analysis.test.ts
git commit -m "feat(corpus): add private analysis decisions"
```

---

### Task 2: Aggregate PII-free evidence and suppression policy

**Files:**
- Create: `apps/server-pilot/src/ops/centurion-thread-corpus-evidence.ts`
- Create: `apps/server-pilot/tests/centurion-thread-corpus-evidence.test.ts`
- Read only: `apps/server-pilot/src/ops/centurion-thread-corpus-analysis.ts`

**Interfaces:**

```ts
export const CENTURION_CORPUS_EVIDENCE_VERSION = 'centurion-corpus-evidence-v1';

export type EvidenceDisplayCell =
  | { state: 'observed'; count: number }
  | { state: 'suppressed'; minimumDisplayCount: 5 }
  | { state: 'insufficient_sample'; minimumDisplayCount: 5 };

export type NotMeasuredReason = 'causal_reply_or_authoritative_outcome_required';

export type EvidencePartition<T extends string> =
  | { state: 'observed'; cells: Array<{ category: T; count: number }> }
  | { state: 'suppressed'; minimumDisplayCount: 5 }
  | { state: 'insufficient_sample'; minimumDisplayCount: 5 };

export type CenturionCorpusEvidenceReportV1 = {
  schemaVersion: typeof CENTURION_CORPUS_EVIDENCE_VERSION;
  snapshotDigest: string;
  asOf: string;
  decisionDenominator: EvidenceDisplayCell;
  artifactAvailability: EvidencePartition<AnalysisItemV1['artifactState']>;
  responseEvidence: {
    itemStates: EvidencePartition<ResponseEvidenceState>;
    notMeasured: {
      state: 'not_measured';
      requires: 'causal_reply_or_authoritative_outcome_required';
    };
  };
  workflowMix: EvidencePartition<AnalysisWorkflow>;
  riskCoverage: EvidencePartition<AnalysisRisk>;
  exclusions: { unscopedQuarantineExcluded: EvidenceDisplayCell };
  limitations: readonly [
    'source_integrity_content_hash_only',
    'smtp_accepted_not_causal_response',
    'offline_analysis_not_live_triage_impact',
  ];
};

export function buildCenturionCorpusEvidenceReport(
  snapshot: PrivateThreadCorpusSnapshot,
  reconciled: ReconciledAnalystDecisionsV1,
): CenturionCorpusEvidenceReportV1 | null;
```

- [ ] **Step 1: Write failing evidence tests**

Use reconciled synthetic decisions to prove:

```ts
expect(report?.decisionDenominator).toEqual({ state: 'observed', count: 5 });
expect(report?.responseEvidence.notMeasured).toEqual({
  state: 'not_measured',
  requires: 'causal_reply_or_authoritative_outcome_required',
});
```

Cover denominator mismatch, stale prepared-manifest digest, duplicate/subset miscount, item-level artifact gap, `smtp_accepted` non-causality, mutually exclusive `smtp_accepted`/`not_claimed`/`not_applicable`/`unknown` states, threshold boundaries 4/5, whole-partition suppression, zero-count non-serialization, and a report below denominator threshold. Add exhaustive small-count/property tests proving no emitted cell is below five and released values cannot algebraically recover any suppressed categorical cell.

- [ ] **Step 2: Run the red test**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/centurion-thread-corpus-evidence.test.ts
```

Expected: module/API-not-found failure.

- [ ] **Step 3: Implement aggregate-only evidence**

Call `validateReconciledAnalystDecisions` to revalidate the snapshot, rebuild the deterministic prepared manifest using its bound limits, compare its canonical digest, and re-enforce packet-state decision rules before aggregating. Compute every statistic from the item-level logical-union list, never directly from source-row-grain manifest availability counts. Use fixed enums; never serialize item IDs, source-row IDs, paths, per-thread values, raw hashes, raw decision arrays, prepared manifest data, or free text. A released partition serializes only ordered positive category/count pairs with each count at least five, never a full enum record or zero count; a suppressed partition serializes no cells or total. Preserve only the allowed snapshot digest, as-of timestamp, fixed limitations, and aggregate states.

- [ ] **Step 4: Add leak and source-boundary tests**

Place body/address/subject/header/path/artifact marker values in private records and assert they are absent from JSON, errors, and all display cells. AST-test that evidence imports only analysis/V2 type modules and Node crypto; reject runtime, filesystem, network, database, remote-model, console, and dynamic execution capabilities.

- [ ] **Step 5: Verify and commit**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/centurion-thread-corpus-analysis.test.ts tests/centurion-thread-corpus-evidence.test.ts
pnpm exec prettier --write src/ops/centurion-thread-corpus-evidence.ts tests/centurion-thread-corpus-evidence.test.ts
pnpm exec tsc --noEmit --rootDir . -p tsconfig.json
git diff --check
```

```bash
git add apps/server-pilot/src/ops/centurion-thread-corpus-evidence.ts apps/server-pilot/tests/centurion-thread-corpus-evidence.test.ts
git commit -m "feat(corpus): add aggregate evidence report"
```

---

### Task 3: Windows-only private analysis workspace and fixed CLI

**Files:**
- Create: `apps/server-pilot/src/ops/centurion-thread-corpus-analysis-workspace.ts`
- Create: `apps/server-pilot/scripts/analyze-centurion-thread-corpus.ts`
- Create: `apps/server-pilot/tests/analyze-centurion-thread-corpus.test.ts`
- Create: `apps/server-pilot/tsconfig.centurion-analysis.json`
- Modify: `.gitignore`
- Read only: `apps/server-pilot/src/ops/centurion-thread-corpus-relay-receiver.ts`

**Interfaces:**

```ts
export type AnalysisWorkspaceConfigV1 = {
  version: 'centurion-thread-corpus-analysis-workspace-config-v1';
  checkoutRoot: string;
  receivedCorpusRoot: string;
  analysisRoot: string;
  maxPacketBytes: number;
  maxTotalPacketBytes: number;
  maxDecisionBytes: number;
};

export type VerifiedReceivedAnalysisInput = {
  snapshot: PrivateThreadCorpusSnapshot;
  snapshotDigest: string;
  receiveReceiptSha256: string;
  canonicalPath: string;
  stableIdentity: string;
  volumeId: string;
};

export type AnalysisWorkspaceStateV1 = {
  schemaVersion: 'centurion-thread-corpus-analysis-workspace-state-v1';
  transferId: string;
  snapshotDigest: string;
  receiveReceiptSha256: string;
  preparedManifestSha256: string;
  state: 'prepared' | 'decision_written' | 'reconciled';
  decisionBundleSha256: string | null;
  reportSha256: string | null;
};

export type AnalysisWorkspacePort = {
  platform(): string;
  readProtectedConfig(): Promise<string>;
  inspectCheckout(input: {
    checkoutRoot: string;
    receivedCorpusRoot: string;
    analysisRoot: string;
  }): Promise<
    { gitignored: boolean; stableIdentity: string; volumeId: string } | null
  >;
  readVerifiedReceivedSnapshot(transferId: string): Promise<VerifiedReceivedAnalysisInput | null>;
  createProtectedWorkspace(input: {
    snapshotDigest: string;
    receiveReceiptSha256: string;
    expectedVolumeId: string;
  }): Promise<{ path: string; stableIdentity: string; volumeId: string } | null>;
  writeCreateNewProtected(path: string, content: Uint8Array): Promise<boolean>;
  readBoundedProtected(path: string, maxBytes: number): Promise<Uint8Array | null>;
  writeAtomicProtectedState(state: AnalysisWorkspaceStateV1): Promise<boolean>;
  readProtectedState(transferId: string): Promise<AnalysisWorkspaceStateV1 | null>;
  acl: WindowsPrivateAcl;
};

export type AnalysisCliResult =
  | { outcome: 'prepared' }
  | { outcome: 'reconciled' }
  | { outcome: 'blocked' };
```

- [ ] **Step 1: Write fake-only CLI/workspace tests**

Require exactly `prepare --transfer-id <uuid>` or `reconcile --transfer-id <uuid>` before protected config I/O. Validate platform and bounded safe-integer limits before config/ACL/snapshot calls. Test the valid state sequence:

```ts
verified_received(receipt + stable identity) -> prepared(private packets + prepared manifest + fsynced state)
-> decision_written(bound private bundle + fsynced state)
-> reconciled(private aggregate report + fsynced state) -> fixed {"outcome":"reconciled"}
```

Add failures for non-Windows platform with zero port calls, invalid argument, invalid/oversize bounds, unignored analysis root, received-root/analysis-root outside canonical checkout siblings, wrong checkout/volume, untrusted receive receipt, symlink/reparse/identity failure, packet/root/file ACL failure, stale/tampered snapshot, non-create-new packet, malformed/oversized/growing decision file, prepared-manifest mismatch, crash/retry after each state, decision reconciliation failure, and any private marker in stdout/stderr/report.

- [ ] **Step 2: Run the red test**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/analyze-centurion-thread-corpus.test.ts
```

Expected: module/API-not-found failure.

- [ ] **Step 3: Implement workspace adapter and CLI composition**

Add exactly:

```gitignore
.private/centurion-thread-analysis/
```

Reuse `createWindowsPrivateAcl` and its fixed `powershell.exe -NoProfile -NonInteractive -EncodedCommand` invocation rather than adding a second shell adapter. Derive both received and analysis roots from canonical checkout siblings; verify the received transfer's receipt, final inventory, stable identity, and volume before reading it. Create a sibling analysis workspace, never add files to sealed received snapshot directories. Lock/reassert root, workspace, packet files, decision file, private report, and state file; use no-follow/create-new, bounded descriptor reads, fsync, and atomic state replacement.

`prepare` writes `prepared` only after immutable packet/manifest writes and binds the verified receive receipt. `reconcile` accepts only the exact prepared-manifest hash, writes `decision_written` with the bundle digest before reconciliation, writes the private report create-new and locked, then writes `reconciled` with its digest. A retry re-reads and verifies every prior binding before continuing. Conflicting prepared manifest, receipt, snapshot, decision bundle, or report digest blocks. Packets, decisions, state, and aggregate report stay private. Phase 0D, not this command, publishes a separately privacy-scanned date-stamped `docs/infor-hms/` report. The CLI writes only canonical fixed JSON with no path, key, transfer ID, config, raw error, packet, decision, or digest contents.

The workspace is an ingress/egress boundary only: it does not invoke models. After `prepare`, Cursor may dispatch one local analyst with the workspace path and closed decision contract; after that analyst returns, `reconcile` is the only accepted continuation.

- [ ] **Step 4: Add AST and output-leak guard**

AST-test that the CLI/workspace does not import AWS, database, SSM, Bedrock, Mastra, browser/UI, mailbox/category APIs, or dynamic execution. Assert no fake cloud/client/process runner runs in test mode. Assert command output matches exact safe JSON and all synthetic raw markers are absent from stdout, stderr, private report, state, and errors.

- [ ] **Step 5: Verify and commit**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/centurion-thread-corpus-analysis.test.ts tests/centurion-thread-corpus-evidence.test.ts tests/analyze-centurion-thread-corpus.test.ts
pnpm exec prettier --write src/ops/centurion-thread-corpus-analysis-workspace.ts scripts/analyze-centurion-thread-corpus.ts tests/analyze-centurion-thread-corpus.test.ts
pnpm exec tsc --noEmit -p tsconfig.centurion-analysis.json
git diff --check
```

```bash
git add .gitignore apps/server-pilot/tsconfig.centurion-analysis.json apps/server-pilot/src/ops/centurion-thread-corpus-analysis-workspace.ts apps/server-pilot/scripts/analyze-centurion-thread-corpus.ts apps/server-pilot/tests/analyze-centurion-thread-corpus.test.ts
git commit -m "feat(corpus): add private analysis workspace"
```

---

## Review and execution gates

1. Review this plan for V2 denominator correctness, private packet boundaries, decision schema closure, suppression leakage, and Windows workspace ordering before coding.
2. Run a ponytail review. Keep the three-file core/workspace split unless a review identifies a smaller boundary that preserves independent testability.
3. Execute Tasks 1–3 with a fresh standard local subagent per task; correct and re-review every P1/P2 finding.
4. Run all focused tests with `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS` unset, plus scoped typecheck, Prettier, oxlint, and `git diff --check`.
5. Do not run a real relay, package a real analyst packet, dispatch the local analyst, or publish a date-stamped evidence report until Phase 0D live-readiness gates pass on already-pushed code.
