/**
 * Phase B operation store + terminal matrix contracts (no pilot RDS).
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PhaseBOperationStore,
  abortUnknownRequest,
  acquireControlOracle,
  assertNoPhaseBBlockedInSource,
  buildCanonicalCommandEnvelope,
  buildPhaseBOperatorResult,
  evaluatePreTransmissionEvidence,
  hmacSha256Hex,
  installRoleProofAtomic,
  mapPreflightBlockToTerminal,
  parsePhaseBArgv,
  phaseBTerminalMatrixFixtures,
  rejectArbitraryDiscoveryCliInput,
  rejectCrossDiscoveryOperationSwap,
  resolveClosedDiscoveryOperation,
  runPhaseBLocalOperator,
  shouldPurgeSensitiveMedia,
  shouldRetainProtectedMetadata,
  type CandidateSnapshotV1,
} from '../src/ops/phase-b-operation.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'phase-b-op-'));
  roots.push(root);
  return root;
}

const TOOL = 'hms_find_reservation' as const;
const WAVE = 'B1' as const;
const OP = '11111111-1111-4111-8111-111111111111';
const REL = '22222222-2222-4222-8222-222222222222';
const SUCC = '33333333-3333-4333-8333-333333333333';
const AFTER = 'phase-b-rev-abc123';

describe('phase-b-operation terminal matrix', () => {
  it('snapshots every canonical exit/owner/retry/nextCommand row', () => {
    const rows = phaseBTerminalMatrixFixtures({
      toolId: TOOL,
      waveId: WAVE,
      operationId: OP,
      releaseId: REL,
      successorOperationId: SUCC,
      afterSource: AFTER,
    });
    expect(
      rows.map((row) => ({
        label: row.label,
        exitCode: row.result.exitCode,
        blockingOwner: row.result.blockingOwner,
        retryMode: row.result.retryMode,
        operationId: row.result.operationId,
        nextCommand: row.result.nextCommand,
      })),
    ).toMatchSnapshot();
  });

  it('USAGE_ERROR forces operationId null and nextCommand null', () => {
    const result = buildPhaseBOperatorResult({
      code: 'USAGE_ERROR',
      action: 'read-discovery',
      toolId: TOOL,
      operationId: OP,
    });
    expect(result.operationId).toBeNull();
    expect(result.nextCommand).toBeNull();
    expect(result.exitCode).toBe(2);
    expect(result.blockingOwner).toBe('agent');
  });

  it('BLOCKED_NO_POSITIVE_CONTROL nextCommand is fresh read-proof without resume', () => {
    const result = buildPhaseBOperatorResult({
      code: 'BLOCKED_NO_POSITIVE_CONTROL',
      action: 'read-proof',
      toolId: TOOL,
      operationId: OP,
    });
    expect(result.nextCommand).toBe('read-proof hms_find_reservation --json');
    expect(result.nextCommand).not.toContain('--resume');
    expect(result.blockingOwner).toBe('external');
    expect(result.retryMode).toBe('after_external_recovery');
  });

  it('read-only commands never classify as TRANSPORT_UNCERTAIN nextCommand', () => {
    const result = buildPhaseBOperatorResult({
      code: 'TRANSPORT_UNCERTAIN',
      action: 'doctor',
      toolId: TOOL,
      operationId: OP,
    });
    expect(result.exitCode).toBe(70);
    expect(result.nextCommand).toBeNull();
  });
});

describe('phase-b-operation argv parser', () => {
  it('round-trips discovery/proof/wave/promote/rollback/rearm resume grammar', () => {
    const cases: Array<{ argv: string[]; action: string }> = [
      {
        argv: ['read-discovery', TOOL, '--resume', OP, '--json'],
        action: 'read-discovery',
      },
      {
        argv: ['read-proof', TOOL, '--resume', OP, '--json'],
        action: 'read-proof',
      },
      {
        argv: ['read-wave', WAVE, '--resume', OP, '--json'],
        action: 'read-wave',
      },
      {
        argv: ['read-promote', TOOL, '--release', REL, '--resume', OP, '--json'],
        action: 'read-promote',
      },
      {
        argv: ['read-rollback', TOOL, '--resume', OP, '--json'],
        action: 'read-rollback',
      },
      {
        argv: [
          'rearm',
          TOOL,
          '--operation',
          OP,
          '--after-source',
          AFTER,
          '--resume',
          SUCC,
          '--json',
        ],
        action: 'rearm',
      },
    ];
    for (const row of cases) {
      const parsed = parsePhaseBArgv(row.argv);
      expect(parsed.ok, row.action).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.command.action).toBe(row.action);
    }
  });

  it('rejects mail discovery, bare resume, arbitrary extras, unknown ids', () => {
    expect(parsePhaseBArgv(['read-discovery', 'mail_read_artifact']).ok).toBe(
      false,
    );
    expect(parsePhaseBArgv(['read-wave', WAVE, '--resume']).ok).toBe(false);
    expect(parsePhaseBArgv(['read-proof', TOOL, '--url', 'http://x']).ok).toBe(
      false,
    );
    expect(parsePhaseBArgv(['read-proof', 'not_a_tool']).ok).toBe(false);
    expect(parsePhaseBArgv(['read-promote', TOOL, '--json']).ok).toBe(false);
  });

  it('builds one canonical envelope binding account/region/instance/revision/op', () => {
    const parsed = parsePhaseBArgv(['read-discovery', TOOL, '--json']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const envelope = buildCanonicalCommandEnvelope({
      command: parsed.command,
      operationId: OP,
      sourceRevision: AFTER,
      awsAccountId: '845242190536',
      awsRegion: 'af-south-1',
      instanceId: 'i-008f737974a9ba9b3',
    });
    expect(envelope.kind).toBe('phase_b_operator');
    expect(envelope.inputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.operationId).toBe(OP);
  });
});

describe('phase-b-operation discovery + evidence gates', () => {
  it('DISCOVERY_READY path uses closed discovery-operation dispatch only', () => {
    const ok = resolveClosedDiscoveryOperation(TOOL, 'guest_stay_search');
    expect(ok).toEqual({
      ok: true,
      discoveryOperationId: 'guest_stay_search',
    });
    expect(
      resolveClosedDiscoveryOperation(TOOL, 'quote_availability_search').ok,
    ).toBe(false);
    expect(resolveClosedDiscoveryOperation(TOOL, 'not_real').ok).toBe(false);
  });

  it('rejects arbitrary URL/selector/method/body CLI discovery input', () => {
    expect(
      rejectArbitraryDiscoveryCliInput({ url: 'https://evil.example' }),
    ).toMatchObject({ code: 'USAGE_ERROR', exitCode: 2 });
    expect(rejectArbitraryDiscoveryCliInput({})).toBeNull();
  });

  it('aborts unknown requests and records only redacted structural signatures', () => {
    const aborted = abortUnknownRequest({
      method: 'POST',
      origin: 'https://hmsweb.hms.eu1.inforcloudsuite.com',
      path: '/unknown',
      resourceType: 'xhr',
      queryKeys: ['secret'],
      bodyKeys: ['password'],
      bodyBytes: 12,
    });
    expect(aborted.aborted).toBe(true);
    expect(aborted.capture.structuralSignatureSha256).toMatch(/^[a-f0-9]{64}$/);
    // Key names may appear; raw values must not.
    expect(JSON.stringify(aborted.capture)).not.toMatch(/hunter2|raw-secret-value/i);
    expect(aborted.capture.bodyKeys).toEqual(['password']);
  });

  it('refuses transmit without allowed pre-transmission evidence', () => {
    const sig = createHash('sha256').update('sig').digest('hex');
    expect(
      evaluatePreTransmissionEvidence({
        evidence: null,
        observedStructuralSignatureSha256: sig,
      }),
    ).toEqual({ ok: false, code: 'BLOCKED_REQUEST_SEMANTICS_UNPROVEN' });
    expect(
      evaluatePreTransmissionEvidence({
        evidence: {
          source: 'prior_same_fingerprint_no_write_proof',
          structuralSignatureSha256: sig,
        },
        observedStructuralSignatureSha256: sig,
      }),
    ).toEqual({ ok: true });
  });

  it('acquires independent control oracle without calling extractor under test', () => {
    const missing = acquireControlOracle({
      toolId: TOOL,
      branchId: 'guest_stay_search',
      sealedObservation: null,
      buildCommit: 'abc',
      credentialVersionHmacSha256: 'c'.repeat(64),
      runtimeFingerprintSha256: 'd'.repeat(64),
    });
    expect(missing).toEqual({
      ok: false,
      code: 'BLOCKED_NO_POSITIVE_CONTROL',
    });
    const ok = acquireControlOracle({
      toolId: TOOL,
      branchId: 'guest_stay_search',
      sealedObservation: {
        observedAt: new Date().toISOString(),
        provenanceMaterial: 'oracle-material',
      },
      buildCommit: 'abc',
      credentialVersionHmacSha256: 'c'.repeat(64),
      runtimeFingerprintSha256: 'd'.repeat(64),
    });
    expect(ok.ok).toBe(true);
  });
});

describe('phase-b-operation store', () => {
  it('fenced claim/reclaim/cache and closed stage transitions', () => {
    const store = new PhaseBOperationStore({ rootDir: tempRoot() });
    const op = store.create({
      operationId: OP,
      action: 'read-discovery',
      target: { toolId: TOOL },
      sourceRevision: AFTER,
      inputDigestMaterial: { action: 'read-discovery', toolId: TOOL },
    });
    const ownerA = 'owner-a';
    const attach = store.attachOrCachedTerminal({
      operationId: op.operationId,
      inputSha256: op.inputSha256,
      ownerToken: ownerA,
    });
    expect(attach.kind).toBe('attached');
    if (attach.kind !== 'attached') return;
    const busy = store.attachOrCachedTerminal({
      operationId: op.operationId,
      inputSha256: op.inputSha256,
      ownerToken: 'owner-b',
    });
    expect(busy.kind).toBe('busy');

    expect(
      store.transitionStage({
        operationId: OP,
        ownerToken: ownerA,
        expectedEpoch: attach.lease.leaseEpoch,
        nextStage: 'browser',
      }).ok,
    ).toBe(false);

    expect(
      store.transitionStage({
        operationId: OP,
        ownerToken: ownerA,
        expectedEpoch: attach.lease.leaseEpoch,
        nextStage: 'preflight',
      }).ok,
    ).toBe(true);

    const done = buildPhaseBOperatorResult({
      code: 'COMPLETE',
      action: 'read-discovery',
      toolId: TOOL,
      operationId: OP,
      sourceRevision: AFTER,
    });
    expect(
      store.completeTerminal({
        operationId: OP,
        ownerToken: ownerA,
        expectedEpoch: attach.lease.leaseEpoch,
        result: done,
      }).ok,
    ).toBe(true);
    const cached = store.attachOrCachedTerminal({
      operationId: OP,
      inputSha256: op.inputSha256,
      ownerToken: 'owner-c',
    });
    expect(cached.kind).toBe('cached');
  });

  it('stale lease reclaims with bumped epoch', () => {
    let now = new Date('2026-08-06T12:00:00.000Z');
    const store = new PhaseBOperationStore({
      rootDir: tempRoot(),
      now: () => now,
      leaseTtlMs: 1000,
    });
    const op = store.create({
      action: 'read-proof',
      target: { toolId: TOOL },
      sourceRevision: AFTER,
      inputDigestMaterial: { x: 1 },
    });
    const first = store.attachOrCachedTerminal({
      operationId: op.operationId,
      inputSha256: op.inputSha256,
      ownerToken: 'a',
    });
    expect(first.kind).toBe('attached');
    if (first.kind !== 'attached') return;
    now = new Date('2026-08-06T12:00:05.000Z');
    const reclaim = store.attachOrCachedTerminal({
      operationId: op.operationId,
      inputSha256: op.inputSha256,
      ownerToken: 'b',
    });
    expect(reclaim.kind).toBe('attached');
    if (reclaim.kind !== 'attached') return;
    expect(reclaim.lease.leaseEpoch).toBeGreaterThan(first.lease.leaseEpoch);
  });

  it('writes candidate snapshot sidecar 0444 and rejects source-accounting gaps', () => {
    const store = new PhaseBOperationStore({ rootDir: tempRoot() });
    const op = store.create({
      action: 'read-discovery',
      target: { toolId: TOOL },
      sourceRevision: AFTER,
      inputDigestMaterial: { y: 2 },
    });
    const attach = store.attachOrCachedTerminal({
      operationId: op.operationId,
      inputSha256: op.inputSha256,
      ownerToken: 'owner',
    });
    expect(attach.kind).toBe('attached');
    if (attach.kind !== 'attached') return;
    store.transitionStage({
      operationId: op.operationId,
      ownerToken: 'owner',
      expectedEpoch: attach.lease.leaseEpoch,
      nextStage: 'preflight',
    });
    const gap = store.writeCandidateSnapshot({
      operationId: op.operationId,
      ownerToken: 'owner',
      expectedEpoch: attach.lease.leaseEpoch,
      snapshot: {
        authorizedSourceSnapshotSha256: 'a'.repeat(64),
        extractorVersion: '1',
        privateDigestKeyVersion: 'v1',
        credentialVersionHmacSha256: 'b'.repeat(64),
        runtimeFingerprintSha256: 'c'.repeat(64),
        sources: [
          {
            privateSourceRefId: 'src-1',
            ordinal: 1,
            status: 'one',
            candidateIds: [randomUUID()],
          },
        ],
        candidates: [],
      },
    });
    expect(gap.ok).toBe(false);

    const candId = randomUUID();
    const ok = store.writeCandidateSnapshot({
      operationId: op.operationId,
      ownerToken: 'owner',
      expectedEpoch: attach.lease.leaseEpoch,
      snapshot: {
        authorizedSourceSnapshotSha256: 'a'.repeat(64),
        extractorVersion: '1',
        privateDigestKeyVersion: 'v1',
        credentialVersionHmacSha256: 'b'.repeat(64),
        runtimeFingerprintSha256: 'c'.repeat(64),
        sources: [
          {
            privateSourceRefId: 'src-1',
            ordinal: 0,
            status: 'one',
            candidateIds: [candId],
          },
        ],
        candidates: [
          {
            candidateId: candId,
            sourceOrdinal: 0,
            kind: 'exact',
            canonicalValueHmacSha256: hmacSha256Hex('key', 'CONF-1'),
          },
        ],
      },
    });
    expect(ok.ok).toBe(true);
    const storedSnap = store.getSnapshot(op.operationId);
    expect(storedSnap?.candidates[0]?.candidateId).toBe(candId);
  });

  it('resume reconstructs UUID/HMAC mapping and rejects credential/key/runtime drift', () => {
    const root = tempRoot();
    const store = new PhaseBOperationStore({ rootDir: root });
    const op = store.create({
      action: 'read-proof',
      target: { toolId: TOOL },
      sourceRevision: AFTER,
      inputDigestMaterial: { z: 3 },
    });
    const attach = store.attachOrCachedTerminal({
      operationId: op.operationId,
      inputSha256: op.inputSha256,
      ownerToken: 'owner',
    });
    if (attach.kind !== 'attached') throw new Error('attach');
    store.transitionStage({
      operationId: op.operationId,
      ownerToken: 'owner',
      expectedEpoch: attach.lease.leaseEpoch,
      nextStage: 'preflight',
    });
    const candId = randomUUID();
    const key = 'hmac-key';
    store.writeCandidateSnapshot({
      operationId: op.operationId,
      ownerToken: 'owner',
      expectedEpoch: attach.lease.leaseEpoch,
      snapshot: {
        authorizedSourceSnapshotSha256: 'a'.repeat(64),
        extractorVersion: 'ext-1',
        privateDigestKeyVersion: 'k1',
        credentialVersionHmacSha256: 'b'.repeat(64),
        runtimeFingerprintSha256: 'c'.repeat(64),
        sources: [
          {
            privateSourceRefId: 'src-1',
            ordinal: 0,
            status: 'one',
            candidateIds: [candId],
          },
        ],
        candidates: [
          {
            candidateId: candId,
            sourceOrdinal: 0,
            kind: 'exact',
            canonicalValueHmacSha256: hmacSha256Hex(key, 'CONF-9'),
          },
        ],
      },
    });

    expect(
      store.resumeFromSnapshot({
        operationId: op.operationId,
        authorizedSourceSnapshotSha256: 'a'.repeat(64),
        extractorVersion: 'ext-1',
        privateDigestKeyVersion: 'k1',
        credentialVersionHmacSha256: 'ZZ'.repeat(32),
        runtimeFingerprintSha256: 'c'.repeat(64),
        reauthorize: () => 'ok',
        canonicalValueFor: () => 'CONF-9',
        hmacKey: key,
      }).ok,
    ).toBe(false);

    const resumed = store.resumeFromSnapshot({
      operationId: op.operationId,
      authorizedSourceSnapshotSha256: 'a'.repeat(64),
      extractorVersion: 'ext-1',
      privateDigestKeyVersion: 'k1',
      credentialVersionHmacSha256: 'b'.repeat(64),
      runtimeFingerprintSha256: 'c'.repeat(64),
      reauthorize: (id) => (id === 'src-1' ? 'reauthed' : null),
      canonicalValueFor: (id) => (id === candId ? 'CONF-9' : null),
      hmacKey: key,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.mapping.get('src-1')).toBe('reauthed');
  });

  it('source-bound resume rejects snapshot drift; rearm cannot waive policy', () => {
    const store = new PhaseBOperationStore({ rootDir: tempRoot() });
    const op = store.create({
      operationId: OP,
      action: 'read-discovery',
      target: { toolId: TOOL },
      sourceRevision: 'rev-old',
      inputDigestMaterial: { a: 1 },
    });
    store.markPolicyUnresolved(OP, true);
    const blocked = store.rearmAfterSource({
      supersededOperationId: OP,
      toolId: TOOL,
      newSourceRevision: 'rev-new',
      inputDigestMaterial: { a: 2 },
    });
    expect(blocked).toEqual({ ok: false, code: 'POLICY_UNRESOLVED' });

    store.markPolicyUnresolved(OP, false);
    const same = store.rearmAfterSource({
      supersededOperationId: OP,
      toolId: TOOL,
      newSourceRevision: 'rev-old',
      inputDigestMaterial: { a: 2 },
    });
    expect(same).toEqual({ ok: false, code: 'SOURCE_UNCHANGED' });

    const ok = store.rearmAfterSource({
      supersededOperationId: OP,
      toolId: TOOL,
      newSourceRevision: 'rev-new',
      newOperationId: SUCC,
      inputDigestMaterial: { a: 3 },
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.successor.supersedesOperationId).toBe(OP);
    expect(ok.successor.operationId).toBe(SUCC);
    expect(ok.successor.sourceRevision).toBe('rev-new');
    expect(store.get(OP)?.lastCode).toBe('SUPERSEDED');
    void op;
  });
});

describe('phase-b-operation proof install + receipts + GC', () => {
  it('installs 0444 proof only after zero unsafe counters', () => {
    const root = tempRoot();
    const path = join(root, 'role-proof.v2.json');
    expect(
      installRoleProofAtomic({
        path,
        body: { schemaVersion: 2 },
        counters: {
          unknownRequests: 1,
          mutationRequests: 0,
          popupCount: 0,
          downloadCount: 0,
          webSocketCount: 0,
        },
      }).ok,
    ).toBe(false);
    expect(
      installRoleProofAtomic({
        path,
        body: { schemaVersion: 2 },
        counters: {
          unknownRequests: 0,
          mutationRequests: 0,
          popupCount: 0,
          downloadCount: 0,
          webSocketCount: 0,
        },
      }).ok,
    ).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o444);
  });

  it('rejects same-tool cross-discovery-operation swap', () => {
    const hit = rejectCrossDiscoveryOperationSwap({
      toolId: TOOL,
      receiptDiscoveryOperationId: 'guest_stay_search',
      sessionDiscoveryOperationId: 'quote_availability_search',
    });
    expect(hit?.code).toBe('POLICY_OR_EVIDENCE_REJECTED');
    expect(
      rejectCrossDiscoveryOperationSwap({
        toolId: TOOL,
        receiptDiscoveryOperationId: 'guest_stay_search',
        sessionDiscoveryOperationId: 'guest_stay_search',
      }),
    ).toBeNull();
  });

  it('GC retains active/predecessor metadata and 90-day retirement window', () => {
    const now = new Date('2026-08-06T00:00:00.000Z');
    expect(
      shouldRetainProtectedMetadata({
        referencedByActiveOrPredecessor: true,
        retiredAt: '2020-01-01T00:00:00.000Z',
        now,
      }),
    ).toBe(true);
    expect(
      shouldRetainProtectedMetadata({
        referencedByActiveOrPredecessor: false,
        retiredAt: '2026-07-01T00:00:00.000Z',
        now,
      }),
    ).toBe(true);
    expect(
      shouldRetainProtectedMetadata({
        referencedByActiveOrPredecessor: false,
        retiredAt: '2026-01-01T00:00:00.000Z',
        now,
      }),
    ).toBe(false);
    expect(
      shouldPurgeSensitiveMedia({
        sensitiveMediaExpiresAt: '2026-08-05T00:00:00.000Z',
        now,
      }),
    ).toBe(true);
  });

  it('executable phase-b-operation source has no PHASE_B_BLOCKED', () => {
    const source = readFileSync(
      join(__dirname, '../src/ops/phase-b-operation.ts'),
      'utf8',
    );
    expect(assertNoPhaseBBlockedInSource(source)).toBe(true);
  });

  it('local-operator honors resume id and store-backed rearm', () => {
    const root = tempRoot();
    const store = new PhaseBOperationStore({ rootDir: root });
    store.create({
      operationId: OP,
      action: 'read-discovery',
      target: { toolId: TOOL },
      sourceRevision: 'rev-old',
      inputDigestMaterial: { seed: 1 },
    });

    const rearmParsed = parsePhaseBArgv([
      'rearm',
      TOOL,
      '--operation',
      OP,
      '--after-source',
      AFTER,
      '--resume',
      SUCC,
      '--json',
    ]);
    expect(rearmParsed.ok).toBe(true);
    if (!rearmParsed.ok) return;

    const rearmResult = runPhaseBLocalOperator({
      command: rearmParsed.command,
      operationId: SUCC,
      sourceRevision: AFTER,
      store,
    });
    expect(rearmResult.code).toBe('COMPLETE');
    expect(rearmResult.operationId).toBe(SUCC);
    expect(rearmResult.sourceRevision).toBe(AFTER);
    expect(store.get(OP)?.lastCode).toBe('SUPERSEDED');
    expect(store.get(SUCC)?.supersedesOperationId).toBe(OP);

    // Resume attaches same operationId (does not mint a new one).
    const freshId = '55555555-5555-4555-8555-555555555555';
    const resumeArgv = [
      'read-discovery',
      TOOL,
      '--resume',
      freshId,
      '--json',
    ] as const;
    const resumeCmd = parsePhaseBArgv([...resumeArgv]);
    expect(resumeCmd.ok).toBe(true);
    if (!resumeCmd.ok) return;
    store.create({
      operationId: freshId,
      action: 'read-discovery',
      target: { toolId: TOOL },
      sourceRevision: AFTER,
      inputDigestMaterial: resumeCmd.command,
    });
    const resumed = runPhaseBLocalOperator({
      command: resumeCmd.command,
      operationId: randomUUID(),
      sourceRevision: AFTER,
      store,
    });
    expect(resumed.operationId).toBe(freshId);
    expect(resumed.code).not.toBe('PHASE_B_BLOCKED');
  });

  it('local-operator CLI --resume + store-backed rearm (integration)', () => {
    const root = tempRoot();
    const store = new PhaseBOperationStore({ rootDir: root });
    store.create({
      operationId: OP,
      action: 'read-proof',
      target: { toolId: TOOL },
      sourceRevision: 'rev-old',
      inputDigestMaterial: { seed: 'cli-rearm' },
    });

    const opTs = join(__dirname, '../src/ops/phase-b-operation.ts');
    const env = {
      ...process.env,
      HMS_PHASE_B_OPERATION_ROOT: root,
      NAVA_SOURCE_REVISION: AFTER,
    };
    delete env.DATABASE_URL;
    delete env.VITEST_ALLOW_PILOT_RDS;

    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        opTs,
        'local-operator',
        '--json',
        'rearm',
        TOOL,
        '--operation',
        OP,
        '--after-source',
        AFTER,
        '--resume',
        SUCC,
      ],
      { env, encoding: 'utf8', cwd: join(__dirname, '..') },
    );
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout.trim()) as {
      operationId: string;
      code: string;
      sourceRevision: string;
    };
    expect(body.code).toBe('COMPLETE');
    expect(body.operationId).toBe(SUCC);
    expect(body.sourceRevision).toBe(AFTER);
    expect(store.get(SUCC)?.supersedesOperationId).toBe(OP);

    // Resume discovery preserves operationId through CLI.
    const discId = '66666666-6666-4666-8666-666666666666';
    const discCmd = parsePhaseBArgv([
      'read-discovery',
      TOOL,
      '--resume',
      discId,
      '--json',
    ]);
    expect(discCmd.ok).toBe(true);
    if (!discCmd.ok) return;
    store.create({
      operationId: discId,
      action: 'read-discovery',
      target: { toolId: TOOL },
      sourceRevision: AFTER,
      inputDigestMaterial: discCmd.command,
    });
    const resumeCli = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        opTs,
        'local-operator',
        '--json',
        'read-discovery',
        TOOL,
        '--resume',
        discId,
      ],
      { env, encoding: 'utf8', cwd: join(__dirname, '..') },
    );
    const resumeBody = JSON.parse(resumeCli.stdout.trim()) as {
      operationId: string | null;
      code: string;
    };
    expect(resumeBody.operationId).toBe(discId);
    expect(resumeBody.code).not.toBe('PHASE_B_BLOCKED');
  });

  it('TRANSPORT_UNCERTAIN rearm never emits pending placeholder', () => {
    const withAfter = buildPhaseBOperatorResult({
      code: 'TRANSPORT_UNCERTAIN',
      action: 'rearm',
      toolId: TOOL,
      operationId: OP,
      afterSource: AFTER,
    });
    expect(withAfter.nextCommand).toBe(
      `rearm ${TOOL} --operation ${OP} --after-source ${AFTER} --resume ${OP} --json`,
    );
    expect(withAfter.nextCommand).not.toContain('pending');

    const missing = buildPhaseBOperatorResult({
      code: 'TRANSPORT_UNCERTAIN',
      action: 'rearm',
      toolId: TOOL,
      operationId: OP,
    });
    expect(missing.nextCommand).toBeNull();
  });

  it('preflight blockers map to terminal matrix codes not always AGENT_REPAIR', () => {
    expect(mapPreflightBlockToTerminal('BLOCKED_NO_REVIEWED_REQUEST_MANIFEST')).toBe(
      'MANIFEST_SOURCE_CHANGE_REQUIRED',
    );
    expect(mapPreflightBlockToTerminal('BLOCKED_NO_DRIVER_OR_CONTROLS')).toBe(
      'BLOCKED_NO_POSITIVE_CONTROL',
    );
    expect(mapPreflightBlockToTerminal('BLOCKED_ROLE_PROOF_V2_INSECURE')).toBe(
      'POLICY_OR_EVIDENCE_REJECTED',
    );
    expect(mapPreflightBlockToTerminal('BLOCKED_NO_ROLE_PROOF_V2')).toBe(
      'BLOCKED_EXTERNAL',
    );
  });
});

// silence unused type import in some TS configs
void (null as unknown as CandidateSnapshotV1);
