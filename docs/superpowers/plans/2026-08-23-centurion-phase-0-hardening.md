# Centurion Phase 0 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement each task with a fresh local subagent, correctness review, and ponytail review.

**Goal:** Close final branch-review safety and recovery gaps before Phase 0D can push code or touch a private live corpus.

**Architecture:** Strengthen the existing pure readiness contract and EC2 assessment with explicit negative IAM simulations and pinned process boundaries. Bind the resulting PII-free attestation to staged relay state. Make stage and receiver recovery deterministic after interruption, stream bounded analysis packet serialization, and compile every Phase 0 command/test boundary under one scoped TypeScript project.

**Tech Stack:** TypeScript, Node crypto/fs/path/child process with fixed absolute executables, AWS SDK v3 adapters, Zod, Vitest, existing V2 validator, Prettier, oxlint.

## Global Constraints

- No live EC2, S3, RDS, KMS, IAM, PowerShell, private config, raw corpus, mailbox, or browser action during this plan. Tests use injected fakes and synthetic V2 data only.
- Before every Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`. Never set `VITEST_ALLOW_PILOT_RDS=1`, source `.env.production`, or use pilot RDS for tests.
- No raw body, subject, address, header, attachment name/content, private path, bucket/key, config value, credential, raw error, journal detail, or command output reaches stdout/stderr, Git, CI, external APIs, web/MCP, or reports.
- Every Phase 0 process invocation has a fixed absolute executable, `shell: false`, exact closed argv, bounded environment with `PATH`, `PATHEXT`, `HOME`, Git/AWS config/profile/endpoint/proxy/pager overrides removed, and suppressed raw output. This covers EC2 readiness, live exporter, relay stage/finalize/source runtime, Windows receive/ACL, and analysis workspace. Missing executable, a symlink/non-root-owned/non-regular executable, or nonzero result blocks.
- Readiness succeeds only when required source reads are `allowed` and required source mutations are `implicitDeny` or `explicitDeny`. Unknown, malformed, missing, duplicated, or `allowed` mutation results block.
- Readiness proves source-export least privilege only. Relay bucket writes remain separately scoped and are verified by relay bucket checks; readiness must not require relay write denial.
- Stage and receiver retries may resume only exact durable state. Ambiguous, malformed, extra, tampered, incomplete, cross-volume, reparse-point, ACL-invalid, or binding-mismatched state blocks without cleanup that could erase private evidence.
- Existing V2 validators remain source of truth. Do not copy comparator logic or alter mailbox/category/inbox behavior.
- No Phase 0D operation starts until all tasks here pass review and the feature branch is pushed.

## File Structure

- `apps/server-pilot/src/ops/centurion-thread-corpus-readiness.ts`: explicit negative capability probes and PII-free attestation schema/builder.
- `apps/server-pilot/scripts/check-centurion-thread-corpus-readiness.ts`: constrained process runner and reusable assessment that returns report plus attestation.
- `apps/server-pilot/scripts/stage-centurion-thread-corpus-relay.ts`: readiness interlock and durable pending-transfer discovery.
- `apps/server-pilot/src/ops/centurion-thread-corpus-relay-producer.ts`: `StageIntentV2`, attestation binding, and trusted resumable-stage discovery.
- `apps/server-pilot/src/ops/centurion-thread-corpus-relay-receiver.ts`: verified partial-directory resume.
- `apps/server-pilot/src/ops/centurion-thread-corpus-analysis.ts`: streaming/bounded canonical packet sink.
- `apps/server-pilot/tsconfig.centurion-phase-0.json`: scoped compile coverage for all Phase 0 source, commands, and focused tests.
- `apps/server-pilot/package.json`: `typecheck:centurion-phase-0` command.
- Existing focused readiness/relay/analysis tests: synthetic failure/retry/egress coverage.

---

### Task 0: Phase 0 executable inventory and compile gate

**Files:**
- Modify: `apps/server-pilot/scripts/export-centurion-thread-corpus-live.ts`
- Modify: `apps/server-pilot/scripts/check-centurion-thread-corpus-readiness.ts`
- Modify: `apps/server-pilot/scripts/stage-centurion-thread-corpus-relay.ts`
- Modify: `apps/server-pilot/scripts/finalize-centurion-thread-corpus-relay.ts`
- Modify: `apps/server-pilot/scripts/receive-centurion-thread-corpus-relay.ts`
- Modify: `apps/server-pilot/scripts/analyze-centurion-thread-corpus.ts`
- Modify: `apps/server-pilot/src/ops/centurion-thread-corpus-relay-producer.ts`
- Modify: `apps/server-pilot/src/ops/centurion-thread-corpus-relay-receiver.ts`
- Modify: `apps/server-pilot/src/ops/centurion-thread-corpus-analysis-workspace.ts`
- Modify: `apps/server-pilot/src/mail/artifacts/read-artifact.ts`
- Create: `apps/server-pilot/tsconfig.centurion-phase-0.json`
- Modify: `apps/server-pilot/package.json`
- Modify: focused fake-only command tests as required

**Contract:**

```ts
type FixedProcessInvocation = {
  executable: string; // fixed absolute OS path, never config or PATH lookup
  args: readonly string[]; // one of an AST-tested finite set
  cwd: string;
  env: Readonly<Record<string, string>>;
  shell: false;
};

type TrustedExecutableInspector = {
  inspect(executable: string): Promise<
    | { path: string; stableIdentity: string; owner: 'root' | 'trusted-system'; writableByOthers: false }
    | null
  >;
};
```

- [ ] **Step 1: Write failing source-boundary and compile tests**

Inventory every `spawn`, `spawnSync`, `execFile`, `execFileSync`, or PowerShell/Git/AWS invocation in the full transitive runtime-import closure of Phase 0 sources/commands, including V2 hydrator's PDF artifact sandbox. Add AST tests proving only approved narrow adapters invoke child processes and each call uses the exact OS-specific constant:

```ts
const EC2_GIT = '/usr/bin/git';
const EC2_AWS = '/usr/local/bin/aws';
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const WINDOWS_GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
const EC2_BWRAP = '/usr/bin/bwrap';
const EC2_PRLIMIT = '/usr/bin/prlimit';
const EC2_PDFINFO = '/usr/bin/pdfinfo';
const EC2_PDFTOTEXT = '/usr/bin/pdftotext';
```

The command fails closed on an AMI without an expected executable; it never discovers a binary from PATH. Fake tests prove inherited `PATH`, `PATHEXT`, `HOME`, `GIT_*`, `AWS_*`, endpoint, proxy, and pager variables cannot alter invocation. Tests must not launch a real process.

Create `tsconfig.centurion-phase-0.json` with an exact `files` manifest: readiness core/CLI; relay protocol/producer/finalizer/receiver and three CLIs; analysis/evidence/workspace and CLI; exporter composition/live CLI dependencies; the focused readiness, relay, analysis/evidence, and workspace test files. Add `typecheck:centurion-phase-0`. Assert `tsc --listFiles` contains every manifest entry and no `scripts/**` claim is omitted.

- [ ] **Step 2: Run red checks**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/export-centurion-thread-corpus-live.test.ts tests/check-centurion-thread-corpus-readiness.test.ts tests/centurion-thread-corpus-relay-producer.test.ts tests/centurion-thread-corpus-relay-receiver.test.ts tests/analyze-centurion-thread-corpus.test.ts
pnpm run typecheck:centurion-phase-0
```

Expected: ambient executable/static-inventory and missing typecheck command failures.

- [ ] **Step 3: Pin every process boundary**

Use fixed constants and trusted executable identity checks inside narrow injected runners only. EC2 runners use the Linux constants; Windows runners use the Windows constants. The fixed executable, arguments, environment, working directory, and identity are all verified before use. Pin and inspect the PDF sandbox's bwrap/prlimit/Poppler binaries as a single fixed Linux toolchain, with a fixed parent cwd and scrubbed environment, before it reads a private hydrated artifact. Keep existing no-shell PowerShell encoded-command behavior; only its executable changes from an ambient name to the fixed path. Do not add a generic command execution abstraction outside these adapters.

Make the Phase 0 tsconfig exact and run it after every remaining task in this plan.

- [ ] **Step 4: Verify and commit**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/export-centurion-thread-corpus-live.test.ts tests/check-centurion-thread-corpus-readiness.test.ts tests/centurion-thread-corpus-relay-receiver.test.ts tests/analyze-centurion-thread-corpus.test.ts
pnpm run typecheck:centurion-phase-0
pnpm exec prettier --write scripts/export-centurion-thread-corpus-live.ts scripts/check-centurion-thread-corpus-readiness.ts scripts/stage-centurion-thread-corpus-relay.ts scripts/finalize-centurion-thread-corpus-relay.ts scripts/receive-centurion-thread-corpus-relay.ts scripts/analyze-centurion-thread-corpus.ts src/ops/centurion-thread-corpus-relay-producer.ts src/ops/centurion-thread-corpus-relay-receiver.ts src/ops/centurion-thread-corpus-analysis-workspace.ts src/mail/artifacts/read-artifact.ts tsconfig.centurion-phase-0.json package.json
git diff --check
```

```bash
git add apps/server-pilot/scripts/export-centurion-thread-corpus-live.ts apps/server-pilot/scripts/check-centurion-thread-corpus-readiness.ts apps/server-pilot/scripts/stage-centurion-thread-corpus-relay.ts apps/server-pilot/scripts/finalize-centurion-thread-corpus-relay.ts apps/server-pilot/scripts/receive-centurion-thread-corpus-relay.ts apps/server-pilot/scripts/analyze-centurion-thread-corpus.ts apps/server-pilot/src/ops/centurion-thread-corpus-relay-producer.ts apps/server-pilot/src/ops/centurion-thread-corpus-relay-receiver.ts apps/server-pilot/src/ops/centurion-thread-corpus-analysis-workspace.ts apps/server-pilot/src/mail/artifacts/read-artifact.ts apps/server-pilot/tsconfig.centurion-phase-0.json apps/server-pilot/package.json apps/server-pilot/tests/export-centurion-thread-corpus-live.test.ts apps/server-pilot/tests/check-centurion-thread-corpus-readiness.test.ts apps/server-pilot/tests/centurion-thread-corpus-relay-producer.test.ts apps/server-pilot/tests/centurion-thread-corpus-relay-receiver.test.ts apps/server-pilot/tests/analyze-centurion-thread-corpus.test.ts apps/server-pilot/tests/hms-artifact.test.ts
git commit -m "fix(corpus): pin phase zero process boundaries"
```

---

### Task 1: Readiness negative capabilities and bound staging attestation

**Files:**
- Modify: `apps/server-pilot/src/ops/centurion-thread-corpus-readiness.ts`
- Modify: `apps/server-pilot/scripts/check-centurion-thread-corpus-readiness.ts`
- Modify: `apps/server-pilot/src/ops/centurion-thread-corpus-relay-producer.ts`
- Modify: `apps/server-pilot/src/ops/centurion-thread-corpus-relay-finalizer.ts`
- Modify: `apps/server-pilot/scripts/stage-centurion-thread-corpus-relay.ts`
- Modify: `apps/server-pilot/scripts/finalize-centurion-thread-corpus-relay.ts`
- Modify: `apps/server-pilot/tests/centurion-thread-corpus-readiness.test.ts`
- Modify: `apps/server-pilot/tests/check-centurion-thread-corpus-readiness.test.ts`
- Modify: `apps/server-pilot/tests/centurion-thread-corpus-relay-producer.test.ts`
- Modify: `apps/server-pilot/tests/centurion-thread-corpus-relay-finalizer.test.ts`

**Interfaces:**

```ts
export type CapabilityExpectation =
  | { action: string; resource: string; requiredDecision: 'allowed' }
  | { action: string; resource: string; requiredDecision: 'not_allowed' };

export type CenturionThreadCorpusReadinessAttestationV1 = {
  schemaVersion: 'centurion-thread-corpus-readiness-attestation-v1';
  corpusContractId: 'centurion-thread-corpus-v2';
  readinessReportVersion: 'centurion-thread-corpus-readiness-v1';
  bindingSha256: string;
};

export function buildCenturionThreadCorpusReadinessAttestation(
  report: CenturionThreadCorpusReadinessReportV1,
  binding: ReadinessAttestationBindingInputV1,
): CenturionThreadCorpusReadinessAttestationV1 | null;

export type ReadinessAttestationBindingInputV1 = {
  corpusContractId: 'centurion-thread-corpus-v2';
  expectedInstanceId: string;
  expectedRevision: string;
  expectedWorktree: string;
  designatedSourceScope: {
    centurionTransportId: string;
    designatedTransportId: string;
    mailboxIds: readonly string[];
    addresses: readonly string[];
  };
};

export type StageIntentV2 = Omit<StageIntentV1, 'schemaVersion'> & {
  schemaVersion: 'centurion-thread-corpus-relay-stage-intent-v2';
  readinessAttestation: CenturionThreadCorpusReadinessAttestationV1;
};
```

- [ ] **Step 1: Write failing safety tests**

Add synthetic policy results proving:

```ts
expect(evaluateReadiness(config, observationsWithAllReadsAndMutationDenies).outcome).toBe('ready');
expect(evaluateReadiness(config, observationsWithAllowedS3Put).outcome).toBe('blocked');
expect(buildCenturionThreadCorpusReadinessAttestation(blockedReport, syntheticBinding)).toBeNull();
```

Probe exact source resources for `rds:ModifyDBInstance`, `s3:PutObject`, `s3:PutBucketPolicy`, and `kms:PutKeyPolicy`; require `dbInstanceArn` in protected config. Add fake process-runner tests for fixed absolute Git/AWS executables, exact argv, bounded environment, no PATH shadow, and every malformed/duplicate/unknown simulation result.

Add stage tests proving missing/malformed/blocked/mismatched attestation blocks before IMDS, Git, bucket, source, journal, or object-store calls. The stage producer receives a trusted expected binding input from strict relay config and recomputes its digest; valid attestation persists in V2 intent. Cross-config binding mismatch, duplicate protected config keys, V1 intent, and tampered persisted attestation block retry/finalizer before any source deletion.

- [ ] **Step 2: Run the red suites**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/centurion-thread-corpus-readiness.test.ts tests/check-centurion-thread-corpus-readiness.test.ts tests/centurion-thread-corpus-relay-producer.test.ts
```

Expected: new negative capability and attestation cases fail.

- [ ] **Step 3: Implement closed readiness and attestation**

Keep required reads unchanged. Add explicit negative expectations using exact source DB/bucket/KMS resource ARNs; `not_allowed` accepts only `implicitDeny` or `explicitDeny`. Parse protected config canonically with duplicate-key rejection.

Replace ambient `git`/`aws` calls with injected fixed-executable runner. EC2 deployment config must identify root-owned absolute image paths; runtime validates regular non-symlink, root ownership, and no group/world write before invocation. Do not fall back to PATH or inherited Git/AWS configuration.

Export a reusable in-process assessment returning `{ report, attestation }`; CLI retains fixed report-only JSON. The attestation builder canonicalizes the full private binding input—instance, revision, worktree, both transport IDs, sorted mailbox IDs, and normalized/sorted addresses—and returns only its SHA-256, never its values. Relay config contains exactly the same private binding input; producer recomputes the expected SHA-256 and compares it before platform, IMDS, Git, bucket, source, journal, or object-store work. Stage command requests assessment after strict arguments/config and before object-store construction. Upgrade producer, finalizer, finalize command, journal validation, and tests to `StageIntentV2`; V1 journal state is a safe blocked legacy state, not a best-effort migration.

- [ ] **Step 4: Add output/source guards**

AST-test readiness and stage command source: only narrow process adapter may invoke child process; no ambient executable string; no dynamic imports/eval/reflection bypass; no raw process output forwarding. Serialize reports, attestations, stage intents, and CLI output against body/address/path/config/error markers.

- [ ] **Step 5: Verify and commit**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/centurion-thread-corpus-readiness.test.ts tests/check-centurion-thread-corpus-readiness.test.ts tests/centurion-thread-corpus-relay-producer.test.ts tests/centurion-thread-corpus-relay-finalizer.test.ts
pnpm exec prettier --write src/ops/centurion-thread-corpus-readiness.ts scripts/check-centurion-thread-corpus-readiness.ts src/ops/centurion-thread-corpus-relay-producer.ts scripts/stage-centurion-thread-corpus-relay.ts tests/centurion-thread-corpus-readiness.test.ts tests/check-centurion-thread-corpus-readiness.test.ts tests/centurion-thread-corpus-relay-producer.test.ts
pnpm run typecheck:centurion-phase-0
git diff --check
```

```bash
git add apps/server-pilot/src/ops/centurion-thread-corpus-readiness.ts apps/server-pilot/scripts/check-centurion-thread-corpus-readiness.ts apps/server-pilot/src/ops/centurion-thread-corpus-relay-producer.ts apps/server-pilot/src/ops/centurion-thread-corpus-relay-finalizer.ts apps/server-pilot/scripts/stage-centurion-thread-corpus-relay.ts apps/server-pilot/scripts/finalize-centurion-thread-corpus-relay.ts apps/server-pilot/tests/centurion-thread-corpus-readiness.test.ts apps/server-pilot/tests/check-centurion-thread-corpus-readiness.test.ts apps/server-pilot/tests/centurion-thread-corpus-relay-producer.test.ts apps/server-pilot/tests/centurion-thread-corpus-relay-finalizer.test.ts
git commit -m "fix(corpus): bind staging to read-only readiness"
```

---

### Task 2: Deterministic stage and receiver interruption recovery

**Files:**
- Modify: `apps/server-pilot/src/ops/centurion-thread-corpus-relay-producer.ts`
- Modify: `apps/server-pilot/scripts/stage-centurion-thread-corpus-relay.ts`
- Modify: `apps/server-pilot/src/ops/centurion-thread-corpus-relay-receiver.ts`
- Modify: `apps/server-pilot/tests/centurion-thread-corpus-relay-producer.test.ts`
- Modify: `apps/server-pilot/tests/centurion-thread-corpus-relay-receiver.test.ts`

**Interfaces:**

```ts
export type ResumableStageDiscovery =
  | { outcome: 'none' }
  | { outcome: 'one'; transferId: string }
  | { outcome: 'blocked' };

export type RelaySourceRuntimePort = {
  // Existing members unchanged.
  findSingleResumableStage(): Promise<ResumableStageDiscovery>;
  acquireSourceStageLease(): Promise<{ leaseId: string } | null>;
  releaseSourceStageLease(input: { leaseId: string }): Promise<boolean>;
};

export type AcquiredPartialDirectory = {
  path: string;
  created: boolean;
  stableIdentity: string;
  volumeId: string;
};

export type ReceiverFileSystem = {
  // Replace createPartialDirectory.
  acquirePartialDirectory(transferId: string): Promise<AcquiredPartialDirectory | null>;
  acquirePartialLease(transferId: string): Promise<{ leaseId: string } | null>;
  releasePartialLease(input: { transferId: string; leaseId: string }): Promise<boolean>;
};
```

- [ ] **Step 1: Write failing restart tests**

Test a fresh fake source runtime after a crash immediately after durable `staging` intent: no-argument stage discovers the one pending transfer and returns the same offer. Test multiple/corrupt/finalizing journals block; completed finalization permits fresh UUID; explicit invalid/mismatched `--transfer-id` blocks before protected config. Test two concurrent no-argument fake runtimes: exactly one atomically acquires the global source-stage lease before discovery/UUID creation; unreleased stale lease blocks rather than being stolen.

Test receiver mid-download failure then fresh fake filesystem: acquire one partial lease, revalidate root/ACL/volume/inventory/member hashes, skip already verified member downloads, download only missing members, write/fsync receipt, promote, acknowledge, then release lease. Test concurrent receiver lease, extra/tampered member, incomplete/bad receipt, wrong ACL, wrong volume, stale lease, or untrusted partial blocks before remote acknowledgement. Test receipt-written/promotion-failed retry.

- [ ] **Step 2: Run red relay suites**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/centurion-thread-corpus-relay-producer.test.ts tests/centurion-thread-corpus-relay-receiver.test.ts
```

Expected: discovery/resume tests fail under create-only behavior.

- [ ] **Step 3: Implement exact resume state machines**

Stage CLI grammar is exactly `[] | ['--transfer-id', UUID]`; duplicate/unknown flags, extra arguments, or invalid UUID block before config I/O. Before discovery, UUID generation, or journal read it atomically acquires one create-new protected source-stage lease; it holds the lease through durable state transition and releases it only after a verified terminal return. On no arguments it calls `findSingleResumableStage`; it reuses exactly one trusted `staging`/`staged` intent, otherwise generates a UUID only when discovery returns `none`. Optional `--transfer-id` is valid only if it matches discovery or no competing intent exists. An unreleased stale lease blocks rather than being reclaimed. Ambiguous/corrupt/finalizing state emits fixed `blocked`.

Receiver acquires a fresh or existing partial only after remote manifest/head/inventory validation and an atomic create-new partial lease. Existing partial must be same-volume, ACL-locked, reparse-free, exact subset of expected members plus optional receipt, and byte/hash verified per member. It resumes only missing members. Receipt is valid only with all members and exact binding. Never auto-delete an invalid private partial or reclaim a stale lease; block it.

- [ ] **Step 4: Re-run source/output boundary guards**

Extend AST and safe-output tests to cover stage discovery, partial recovery, no accidental transfer-ID/path/journal output, and no receiver acknowledgement before exact recovered state.

- [ ] **Step 5: Verify and commit**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/centurion-thread-corpus-relay.test.ts tests/centurion-thread-corpus-relay-producer.test.ts tests/centurion-thread-corpus-relay-finalizer.test.ts tests/centurion-thread-corpus-relay-receiver.test.ts
pnpm exec prettier --write src/ops/centurion-thread-corpus-relay-producer.ts scripts/stage-centurion-thread-corpus-relay.ts src/ops/centurion-thread-corpus-relay-receiver.ts tests/centurion-thread-corpus-relay-producer.test.ts tests/centurion-thread-corpus-relay-receiver.test.ts
pnpm run typecheck:centurion-phase-0
git diff --check
```

```bash
git add apps/server-pilot/src/ops/centurion-thread-corpus-relay-producer.ts apps/server-pilot/scripts/stage-centurion-thread-corpus-relay.ts apps/server-pilot/src/ops/centurion-thread-corpus-relay-receiver.ts apps/server-pilot/tests/centurion-thread-corpus-relay-producer.test.ts apps/server-pilot/tests/centurion-thread-corpus-relay-receiver.test.ts
git commit -m "fix(corpus): recover interrupted private relay"
```

---

### Task 3: Bounded packet serialization and Phase 0 compile gate

**Files:**
- Modify: `apps/server-pilot/src/ops/centurion-thread-corpus-analysis.ts`
- Modify: `apps/server-pilot/tests/centurion-thread-corpus-analysis.test.ts`
- Modify: `apps/server-pilot/tsconfig.centurion-analysis.json`

**Interfaces:**

```ts
type CanonicalByteSink = {
  writeAscii(token: string): 'ok' | 'exceeded' | 'invalid';
  writeJsonString(value: string): 'ok' | 'exceeded' | 'invalid';
  writeByteValue(value: number): 'ok' | 'exceeded' | 'invalid';
  digestHex(): string;
  finishBytes(): Uint8Array | null;
};

function serializeCanonicalToSink(
  value: unknown,
  sink: CanonicalByteSink,
): 'ok' | 'exceeded' | 'invalid';
```

- [ ] **Step 1: Write failing bounded-memory/typecheck tests**

Add instrumentation proving an oversized body/artifact with tiny packet cap returns `truncated`, has no private bytes, and never constructs an assembled oversized JSON string or expanded numeric artifact array. Test JSON string escaping parity for Unicode, controls, quote, backslash, paired and unpaired surrogates. Assert normal fixture packet bytes/SHA stay identical, per-packet overflow wins before aggregate overflow, and peak emitted chunk is bounded independent of body size.

Run the compile command created by Task 0:

```bash
pnpm run typecheck:centurion-phase-0
```

It must cover the exact Phase 0 files manifest introduced by Task 0.

- [ ] **Step 2: Run red checks**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/centurion-thread-corpus-analysis.test.ts
pnpm run typecheck:centurion-phase-0
```

Expected: serialization instrumentation/typecheck command fails before implementation.

- [ ] **Step 3: Implement streaming serialization**

Replace whole-value canonical string construction in packet paths with a recursive writer that emits sorted object keys, preserves arrays, escapes JSON strings in bounded UTF-8 chunks, writes artifact bytes directly as JSON numeric values, and hashes incrementally. Never spread a `Uint8Array`, call `JSON.stringify` on a raw leaf, or materialize full private packet JSON before accepting its bound. Validate `maxPacketBytes` against a safe hard maximum and use remaining-capacity comparison rather than `maxPacketBytes + 1`, so a safe-integer edge cannot overflow. Use the V2 manifest tuple/known hashes for snapshot identity where possible; preserve current successful packet bytes/digests exactly.

Expand analysis scoped config to include its core/evidence tests or remove it in favor of the Phase 0 command; do not claim scripts are typed when excluded.

- [ ] **Step 4: Add source/behavior regressions**

Assert no packet success output changes for normal fixtures, no PII reaches public data, and the new sink has no filesystem/network/runtime imports. Run typecheck against exactly included paths.

- [ ] **Step 5: Verify and commit**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/centurion-thread-corpus-analysis.test.ts tests/centurion-thread-corpus-evidence.test.ts tests/analyze-centurion-thread-corpus.test.ts
pnpm run typecheck:centurion-phase-0
pnpm exec prettier --write src/ops/centurion-thread-corpus-analysis.ts tests/centurion-thread-corpus-analysis.test.ts tsconfig.centurion-analysis.json
git diff --check
```

```bash
git add apps/server-pilot/src/ops/centurion-thread-corpus-analysis.ts apps/server-pilot/tests/centurion-thread-corpus-analysis.test.ts apps/server-pilot/tsconfig.centurion-analysis.json
git commit -m "fix(corpus): bound analysis packets and compile phase zero"
```

---

## Verification Gate

1. Engineering-plan review: reject any missing process-inventory, attestation, mutation-deny, exclusive retry, packet-bound, or compile-scope requirement.
2. Ponytail review: retain only state/safety code required by bounded private relay.
3. Fresh local review after every task; fix/re-review P1/P2 findings.
4. Run all focused Phase 0 fake-only suites with DB safety vars unset, `pnpm run typecheck:centurion-phase-0` after every task, Prettier, oxlint, and `git diff --check`.
5. Commit focused boundaries. Push only after this plan is cleared. Phase 0D remains read-only and needs a separate runtime readiness result.
