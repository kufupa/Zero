# Centurion Private Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` task-by-task. Every task requires TDD, a focused correctness review, and a ponytail simplification review before the next task.

**Goal:** Transfer one sealed Centurion V2 corpus snapshot from EC2 to a Windows operator checkout through pre-existing, scoped SSE-KMS S3 capability without exposing PII or trusting a partially transferred artifact.

**Architecture:** A dedicated relay has three safe actions: Linux EC2 stage, Windows receive, and Linux EC2 finalize. A pure protocol module reconstructs and reuses the committed V2 validator; narrow injected S3/filesystem/ACL/journal ports make every safety boundary fake-testable. `relay-manifest.v1.json` is an S3 commit marker, while durable source and receiver records make every crash path resumable or blocked.

**Tech Stack:** Node 22 ESM TypeScript, Vitest, Node `crypto`/`fs`, AWS SDK v3 S3 only in thin runtime adapters, PowerShell only behind an injected Windows ACL adapter.

## Global Constraints

- Follow canonical plan `C:\Users\gamin\.cursor\plans\reservationist_delivery_82e63c34.plan.md`, Phase 0B, and reviewed design `.superpowers/sdd/centurion-phase-0b-relay-design.md`.
- Never modify `export-centurion-thread-corpus-live.ts`, generic `S3Storage`, IAM/KMS/lifecycle/bucket policy, deployment, mailbox state, or existing corpus exporter behavior.
- No real AWS/SSM/RDS/S3/KMS/EC2 invocation during implementation or tests. Before every Vitest command run `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`.
- Raw corpus bytes, bodies, addresses, headers, subjects, attachment names, local paths, configuration values, S3 keys/prefixes, credentials, and raw errors never reach stdout, stderr, Git, CI, or remote APIs.
- Relay commands emit only fixed schema-validated PII-free JSON. `transferId` and SHA-256 digests are allowed opaque fields; bucket/key/path/config values are not.
- Existing runtime capability must be proven read-only by Task 0A. A real relay run remains Phase 0D and blocks if pre-existing scoped SSE-KMS/lifecycle/local-ACL capability is absent.
- Source and receiver accept literal closed-path grammar only. No archive, presigned URL, wildcard, policy variable, arbitrary selector, generic storage-facade expansion, or user-controlled object key.

## Protocol Invariants

```text
source snapshot ──reconcile──> source members ──conditional SSE-KMS PUT──> relay objects
      ^                                                                    │
      │                                                 manifest last      │
      │                                                                    v
source finalize <── durable ack/journal <── local receipt <── reconcile ─ receiver partial
                                                               │
                                                               └── ACL + no-replace promotion
```

- Closed source member grammar: `corpus.jsonl`, `manifest.json`, `raw-mime/<64-hex>.eml`, `attachment-text/<64-hex>.txt`.
- `relay-manifest.v1.json` is upload-last and excluded from source-member inventory. `receiver-ack.v1.json` is receiver-only and excluded until finalization.
- `StageIntentV1` is atomically persisted and fsynced before source upload. It binds transfer UUID, literal root, source direct-child path plus stable identity, V2 snapshot ID, V2 manifest digest, and canonical source-member digest.
- `ReceiveReceiptV1` is atomically persisted and fsynced in the protected partial directory before promotion. It binds transfer UUID, V2 snapshot/manifest digest, relay-manifest digest, and canonical source-member digest.
- `FinalizeJournalV1` persists and fsyncs every transition: `ack_verified`, `relay_delete_started`, `relay_empty`, `source_delete_started`, `complete`. Retries only use matching stage/journal bindings.
- Every member uses conditional `PutObject` (`IfNoneMatch: '*'`), `aws:kms`, full configured KMS ARN, SHA-256 checksum, expected bucket owner, then `HeadObject` checksum/encryption/size validation. A `412` may resume only when metadata exactly matches.
- Before byte transfer, runtime adapters require exact bucket owner, public-access block all true, `BucketOwnerEnforced`, absent versioning status, exact default SSE-KMS full key ARN, and one enabled one-day literal-prefix lifecycle rule. Lifecycle is cleanup backstop only.

---

### Task 1: Pure relay protocol and bounded V2 reconciler

**Files:**

- Create: `apps/server-pilot/src/ops/centurion-thread-corpus-relay.ts`
- Create: `apps/server-pilot/tests/centurion-thread-corpus-relay.test.ts`
- Read only: `apps/server-pilot/scripts/export-thread-corpus.ts`

**Interfaces:**

```ts
export const CENTURION_THREAD_CORPUS_RELAY_VERSION = 'centurion-thread-corpus-relay-v1';

export type CenturionRelayMember = {
  path: string;
  bytes: number;
  sha256: string;
  content: Uint8Array;
};

export type CenturionRelayManifestV1 = {
  schemaVersion: typeof CENTURION_THREAD_CORPUS_RELAY_VERSION;
  transferId: string;
  snapshotId: string;
  sourceManifestSha256: string;
  memberSetSha256: string;
  members: Array<Omit<CenturionRelayMember, 'content'>>;
};

export type CenturionRelayVerification =
  | {
      outcome: 'verified';
      snapshotId: string;
      sourceManifestSha256: string;
      memberSetSha256: string;
    }
  | { outcome: 'blocked' };

export type ReceiveReceiptV1 = {
  schemaVersion: 'centurion-thread-corpus-relay-receipt-v1';
  transferId: string;
  snapshotId: string;
  sourceManifestSha256: string;
  relayManifestSha256: string;
  memberSetSha256: string;
};

export type ReceiverAcknowledgementV1 = {
  schemaVersion: 'centurion-thread-corpus-relay-ack-v1';
  transferId: string;
  snapshotId: string;
  sourceManifestSha256: string;
  relayManifestSha256: string;
  memberSetSha256: string;
  receiveReceiptSha256: string;
};

export function buildCenturionRelayManifest(
  transferId: string,
  members: readonly CenturionRelayMember[],
  maxTotalBytes: number,
): { manifest: CenturionRelayManifestV1; manifestJson: string };

export function relayObjectKey(
  literalRelayRoot: string,
  transferId: string,
  memberPath: string,
): string;
export function relayManifestKey(literalRelayRoot: string, transferId: string): string;
export function receiverAcknowledgementKey(literalRelayRoot: string, transferId: string): string;
export function buildReceiveReceipt(input: Omit<ReceiveReceiptV1, 'schemaVersion'>): string;
export function buildReceiverAcknowledgement(
  input: Omit<ReceiverAcknowledgementV1, 'schemaVersion'>,
): string;

export function verifyCenturionRelaySnapshot(
  relayManifest: unknown,
  members: readonly CenturionRelayMember[],
  maxTotalBytes: number,
): CenturionRelayVerification;
```

**Implementation rules:**

- Validate all input before constructing a result. Reject duplicate paths, noncanonical ordering, path traversal, backslashes, hidden/temp names, invalid UUID/digest/byte count, oversized totals, `relay-manifest.v1.json`, acknowledgement names, and unknown members.
- Derive artifact kind/id from closed member paths, reconstruct `PrivateThreadCorpusSnapshot` from `corpus.jsonl`, `manifest.json`, and artifact bytes, then call exported `validatePrivateThreadCorpusSnapshot`. Do not copy/reimplement the private V2 record comparators.
- Parse manifest from exact pretty-printed V2 bytes. Derive source manifest SHA-256 and member-set SHA-256 deterministically from sorted path/size/hash rows. Return only `blocked` for every invalid/mismatched condition; no exception text or content escapes.
- Relay manifest, receipt, and acknowledgement JSON must be canonical pretty JSON with trailing newline and exact keys. All S3 relative keys come only from Task 1 literal-root key helpers; no adapter or script may concatenate root/transfer/member strings. `relay-manifest.v1.json` and `receiver-ack.v1.json` never appear in source `members`. Finalizer accepts acknowledgement only when all receipt/ack/stage bindings and digests match exactly.

**TDD steps:**

1. Write fixture helpers using existing synthetic V2 snapshot builder, then a failing test that a valid source snapshot produces a sorted manifest and verifies after a round trip.
2. Run focused test with both DB safety variables unset; observe missing module/API failure.
3. Implement closed member grammar, deterministic digest helpers, schema validators, and valid-path manifest builder.
4. Add failing tests for each safety family: duplicate/extra/missing member, malformed UUID/hash, traversal/backslash/reserved name, altered bytes/size/hash, invalid relay manifest, total-size bound, altered V2 manifest, altered JSONL order, and artifact reference/inventory mismatch.
5. Implement bounded reconstruction and call `validatePrivateThreadCorpusSnapshot`, catching all errors into fixed `blocked`.
6. Run focused tests, targeted typecheck, Prettier, and `git diff --check`. Commit `feat(corpus): add private relay protocol`.

**Acceptance:**

- A valid synthetic V2 snapshot verifies both through V2 validator and relay manifest checks.
- Every invalid fixture returns PII-free blocked state; tests use synthetic marker bodies/addresses/paths and assert none reach serialized safe output.
- No filesystem, child process, environment, cloud client, or production exporter mutation exists in this task.

---

### Task 2: EC2 producer and durable finalizer

**Files:**

- Create: `apps/server-pilot/src/ops/centurion-thread-corpus-relay-producer.ts`
- Create: `apps/server-pilot/src/ops/centurion-thread-corpus-relay-finalizer.ts`
- Create: `apps/server-pilot/scripts/stage-centurion-thread-corpus-relay.ts`
- Create: `apps/server-pilot/scripts/finalize-centurion-thread-corpus-relay.ts`
- Create: `apps/server-pilot/tests/centurion-thread-corpus-relay-producer.test.ts`
- Create: `apps/server-pilot/tests/centurion-thread-corpus-relay-finalizer.test.ts`

**Interfaces:**

```ts
type RelayObjectMetadata = {
  key: string;
  bytes: number;
  sha256: string;
  serverSideEncryption: 'aws:kms';
  sseKmsKeyId: string;
};

type RelayBucketConfig = {
  region: string;
  bucket: string;
  expectedBucketOwner: string;
  literalRelayRoot: string;
  kmsKeyArn: string;
  lifecycleRuleId: string;
  lifecycleExpirationDays: 1;
  maxSnapshotBytes: number;
};

type RelayPutInput = {
  key: string;
  content: Uint8Array;
  bytes: number;
  sha256: string;
  expectedBucketOwner: string;
  kmsKeyArn: string;
};

type RelayObjectStore = {
  assertRelayBucket(config: RelayBucketConfig): Promise<boolean>;
  putIfAbsent(input: RelayPutInput): Promise<'created' | 'already_exists' | 'conflict'>;
  head(key: string): Promise<RelayObjectMetadata | null>;
  listAll(prefix: string): Promise<readonly RelayObjectMetadata[] | null>;
  getBounded(key: string, maxBytes: number): Promise<Uint8Array | null>;
  deleteExact(keys: readonly string[]): Promise<boolean>;
};

type StageIntentV1 = {
  schemaVersion: 'centurion-thread-corpus-relay-stage-intent-v1';
  transferId: string;
  literalRelayRoot: string;
  sourceSnapshot: {
    directChildName: string;
    canonicalPath: string;
    stableIdentity: string;
  };
  snapshotId: string;
  sourceManifestSha256: string;
  memberSetSha256: string;
  members: Array<{ path: string; sha256: string; bytes: number }>;
  createdKeys: string[];
  state: 'staging' | 'staged';
};

type FinalizeJournalV1 = {
  schemaVersion: 'centurion-thread-corpus-relay-finalize-journal-v1';
  stageIntent: StageIntentV1;
  receiveReceiptSha256: string;
  acknowledgementSha256: string;
  state:
    | 'ack_verified'
    | 'relay_delete_started'
    | 'relay_empty'
    | 'source_delete_started'
    | 'complete';
};

type RelaySourceRuntimeConfig = {
  version: 'centurion-thread-corpus-relay-source-config-v1';
  expectedEc2: { instanceId: string; revision: string; worktree: string };
  relay: RelayBucketConfig;
  sourceSnapshot: { directChildName: string };
};

type RelaySourceRuntimePort = {
  platform(): string;
  attestImdsV2(instanceId: string): Promise<boolean>;
  readProtectedConfig(): Promise<string>;
  inspectGit(check: 'revision' | 'worktree' | 'status'): string | null;
  inspectTrustedSnapshot(input: { name: string; maxTotalBytes: number }): Promise<{
    canonicalPath: string;
    stableIdentity: string;
    totalBytes: number;
    members: readonly { path: string; bytes: number; stableIdentity: string }[];
  } | null>;
  readBoundedTrustedSnapshot(input: {
    canonicalPath: string;
    stableIdentity: string;
    members: readonly { path: string; bytes: number; stableIdentity: string }[];
    maxTotalBytes: number;
  }): Promise<readonly CenturionRelayMember[] | null>;
  writeStageIntent(intent: StageIntentV1): Promise<boolean>;
  readStageIntent(transferId: string): Promise<StageIntentV1 | null>;
  writeFinalizeJournal(journal: FinalizeJournalV1): Promise<boolean>;
  readFinalizeJournal(transferId: string): Promise<FinalizeJournalV1 | null>;
  removeTrustedSnapshot(snapshot: StageIntentV1['sourceSnapshot']): Promise<boolean>;
};
```

**Implementation rules:**

- Keep AWS SDK v3 commands in the thin runtime store only. Never add relay writes to `S3Storage` or pass a mutable store to the live exporter.
- `assertRelayBucket` supplies expected owner on every S3 operation and validates bucket owner/control/block/version/encryption/lifecycle facts exactly. It never configures or mutates any of them.
- Use `ChecksumAlgorithm: 'SHA256'`, decoded `ChecksumSHA256`, explicit `ServerSideEncryption: 'aws:kms'`, configured full `SSEKMSKeyId`, and `IfNoneMatch: '*'`. On a collision or lost response, `head()` must match every expected metadata field before resuming.
- Fully paginate `ListObjectsV2`; producer source inventory must be equal to known staged keys plus commit marker after staging. Receiver acknowledgement may be read only by finalizer after stage binding.
- Write `StageIntentV1` using create-new temporary file, fsync file, rename, fsync parent. Update `createdKeys` atomically after each verified creation. Validate source snapshot is a trusted direct child before any byte read. Rollback deletes only keys recorded as created by matching stage intent; preserve state for retry when rollback cannot prove empty prefix.
- Finalizer reads a matching encrypted acknowledgement, writes/fsyncs `FinalizeJournalV1` before each transition, deletes only known journaled keys, proves complete empty prefix using paginated list, then removes exact stable-identity source snapshot. It never deletes source first.
- Source runtime adapter implements exact Linux/IMDSv2/config/revision/worktree/clean-state gates before it reads source bytes. Protected config must use canonical paths, trusted non-symlink parents/leaf, `O_NOFOLLOW`, ownership/mode checks, and pre/post open identity checks. Tests cover each deny path.
- Source inspection stats and validates exact closed member paths, leaf stable identities, restrictive modes, and total bytes against `RelayBucketConfig.maxSnapshotBytes` before `readBoundedTrustedSnapshot` can materialize any content. The read port revalidates trusted parent/directory identity; opens every leaf with no-follow semantics; verifies leaf identity, mode, and size before and after read; and rejects symlink/swap/permissive-mode changes. An oversized source test proves no body-read call occurs.
- Scripts accept no raw source selectors. Stage emits only fixed offer JSON. Finalize accepts one validated UUID `--transfer-id` and emits only fixed cleanup receipt JSON. Source-boundary AST checks ban AWS/S3 mutation calls outside the narrow relay object-store adapter; they explicitly allow injected source-tree and journal filesystem writes/removals.

**TDD steps:**

1. Write fake store/journal/source-tree harness and failing stage test: members are conditional SSE-KMS uploaded in sorted order and commit manifest is last.
2. Implement pure producer orchestration against ports; then add thin adapter tests without executing AWS commands.
3. Add stage failure tests: policy gate false, invalid source, source leaf symlink/swap/permissive-mode, oversize-before-read, member collision metadata mismatch, loss-after-create matching resume, failed member upload, extra remote key, paginated >1,000 keys, and rollback delete failure.
4. Write failing finalizer tests for no/invalid ack, every journal transition, deletion failure, prefix nonempty after delete, source-delete failure, and retry after each persisted state.
5. Implement finalizer state machine and protected config/IMDS/runtime composition. Test all output is fixed PII-free JSON and source AST forbids AWS/S3 mutation calls outside relay object-store adapter.
6. Run focused safe tests, typecheck, Prettier, diff check. Commit `feat(corpus): stage and finalize private relay`.

**Acceptance:**

- No source snapshot deletion occurs until a matching acknowledgement, remote deletion, and empty-prefix proof all pass.
- Restart from every stage/finalizer interruption is deterministic: exact verified retry or blocked.
- Runtime adapter cannot write bucket policy/lifecycle/IAM/KMS or invoke SSM/RDS/mailbox operations.

---

### Task 3: Windows receiver, ACL, atomic promotion, and acknowledgement

**Files:**

- Create: `apps/server-pilot/src/ops/centurion-thread-corpus-relay-receiver.ts`
- Create: `apps/server-pilot/scripts/receive-centurion-thread-corpus-relay.ts`
- Create: `apps/server-pilot/tests/centurion-thread-corpus-relay-receiver.test.ts`

**Interfaces:**

```ts
type WindowsPrivateAcl = {
  assertTrustedPath(path: string): Promise<{ stableIdentity: string; volumeId: string } | null>;
  lockDownDirectory(path: string): Promise<boolean>;
  lockDownFiles(paths: readonly string[]): Promise<boolean>;
  promoteNoReplace(partialPath: string, finalPath: string): Promise<boolean>;
  fsyncReceipt(path: string): Promise<boolean>;
};

type ReceiverFileSystem = {
  assertGitignoredPrivateRoot(): Promise<{
    root: string;
    stableIdentity: string;
    volumeId: string;
  } | null>;
  createPartialDirectory(transferId: string): Promise<string | null>;
  writeCreateNew(path: string, content: Uint8Array): Promise<boolean>;
  readFile(path: string, maxBytes: number): Promise<Uint8Array | null>;
  listRelativePaths(root: string): Promise<readonly string[] | null>;
  writeReceiveReceipt(receiptJson: string): Promise<{ path: string; sha256: string } | null>;
  removePartial(path: string): Promise<boolean>;
};

type RelayReceiverRuntimeConfig = {
  version: 'centurion-thread-corpus-relay-receiver-config-v1';
  relay: RelayBucketConfig;
  privateDestination: { checkoutRoot: string; destinationRoot: string };
};

type RelayReceiverRuntimePort = {
  platform(): string;
  readProtectedConfig(): Promise<string>;
  inspectCheckout(input: {
    checkoutRoot: string;
    destinationRoot: string;
  }): Promise<{ gitignored: boolean; stableIdentity: string; volumeId: string } | null>;
};

type ReceiverResult =
  | {
      outcome: 'received';
      transferId: string;
      sourceManifestSha256: string;
      memberSetSha256: string;
    }
  | { outcome: 'blocked' };
```

**Implementation rules:**

- Windows-only command takes exactly one UUID `--transfer-id`; reads `RelayReceiverRuntimeConfig` through injected protected config/runtime ports, verifies target is under current checkout's gitignored `.private/centurion-thread-corpus`, binds every remote key through Task 1's literal-root helpers, and never prints config/key/path values.
- The ACL adapter rejects symlinks, junctions, and all reparse points for private root/partial/final paths; verifies opened-handle identity; uses same-volume partial/final paths; disables inheritance and permits only caller SID plus SYSTEM full control.
- Windows ACL process adapter uses a fixed `powershell.exe` executable and fixed `-NoProfile -NonInteractive -EncodedCommand` argument list with `shell: false`; its encoded script is static, receives paths only through a bounded environment map, emits no raw stdout/stderr, and never constructs a `-Command` string. Fake command-runner tests assert the exact executable/arguments/environment keys and reject interpolation.
- Download only after remote commit manifest, exact paginated inventory, expected owner/encryption/checksum head checks, trusted partial directory, and directory ACL pass. Each local file uses create-new partial name, post-download byte/hash verification, and restrictive file ACL before the next member. The exact allowed final inventory is source members plus `receive-receipt.v1.json`; hidden, temp, acknowledgement, and extra paths block.
- Reconstruct and verify V2 snapshot through Task 1 before creating `ReceiveReceiptV1`; use `ReceiverFileSystem.writeReceiveReceipt`, fsync receipt before no-replace directory promotion, then recheck final ACL and exact inventory after promotion.
- Create acknowledgement conditionally with SSE-KMS. If response is lost or key exists, `HeadObject` must exactly match expected acknowledgement metadata before success. Existing final path is allowed only after trusted path/ACL/receipt/V2 checks exactly match; then acknowledgement resumes.
- Preserve promoted local snapshot on remote acknowledgement or later source cleanup failure. Never delete verified local snapshot to hide a remote error.

**TDD steps:**

1. Write failing fake receiver test for valid relay inventory → ACL partial → verified V2 snapshot → fsynced receipt → no-replace promotion → conditional acknowledgement.
2. Implement pure receiver orchestration and fakes first; only then add Windows command/ACL adapter composition.
3. Add failing tests for all listed gates: non-Windows, unsafe/reparse path, unignored target, wrong volume, fixed PowerShell invocation/interpolation rejection, ACL failure, missing/extra/paginated remote key, wrong owner/KMS/checksum/hash, failed V2 reconcile, failed receipt fsync, final-path collision, `promote → ack` crash retry, ack response loss, receipt mismatch, and ack-head mismatch.
4. Implement minimum code to pass. Ensure a fake test proves no cloud/PowerShell process is used.
5. Run focused safe tests, typecheck, Prettier, diff check. Commit `feat(corpus): receive verified private relay`.

**Acceptance:**

- Analyst-visible directory appears only after exact V2 and relay checks plus Windows ACL verification.
- Any interruption leaves only ACL-protected partial state, or an exact retry-safe final state with receipt.
- Receiver output and receipts contain no raw PII, path, bucket, key, or config value.

---

## Phase 0B verification and live boundary

1. Run all three focused fake-only suites with `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS` unset.
2. Run targeted TypeScript checks and Prettier for all relay paths; run `git diff --check`.
3. Perform correctness review against this plan, then ponytail review; fix/re-review all Important findings.
4. Commit focused task boundaries and push feature branch.
5. Do not execute staging/receive/finalize against EC2 or S3 until Phase 0C and 0D gates. A future live run must use only already-pushed code, isolated EC2 checkout, fixed safe command output, and pre-existing scoped IAM/KMS/lifecycle/ACL capability.
