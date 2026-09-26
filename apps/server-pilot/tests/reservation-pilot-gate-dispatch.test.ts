import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPilot = path.join(here, '..');
const repoRoot = path.join(serverPilot, '..', '..');
const gatePath = path.join(serverPilot, 'scripts', 'reservation-pilot-gate.sh');
const gateLibPath = path.join(serverPilot, 'scripts', 'reservation-pilot-gate-lib.mjs');

function runGate(mode: string, slice: string) {
  return spawnSync('bash', [gatePath, mode, slice], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      NAVA_TEST_DATABASE_PROFILE: 'pg16',
      NAVA_TEST_DATABASE_URL: undefined,
      CONFIRM_DISPOSABLE_TEST_DB: undefined,
      DATABASE_URL: undefined,
    },
    encoding: 'utf8',
  });
}

function emptyPrivateV2Manifest(gate: any) {
  const manifest = {
    schemaVersion: 'u11-private-qualification.v2',
    fixtureKind: 'private',
    publicFixture: false,
    source: {
      name: 'test',
      version: 'test',
      contentHash: '',
      mappingHash: '',
      inputDigestSetHash: `sha256:${'c'.repeat(64)}`,
      canonicalMap: {
        path: 'private/map.json',
        bytes: 0,
        sha256: `sha256:${'a'.repeat(64)}`,
      },
      pointerDigests: Array.from({ length: 14 }, (_, index) => ({
        name: `pointer-${index}`,
        path: `private/pointer-${index}.json`,
        bytes: 0,
        sha256: `sha256:${'b'.repeat(64)}`,
      })),
    },
    counts: {
      mapRecords: 0,
      original420: 0,
      originalExternalMixedCandidates: 0,
      originalOutboundExternalMixedCandidates: 0,
      runnable: 0,
      notRunnable: 0,
      unscorable: 0,
    },
    privacy: {
      rawCorpusIncluded: false,
      targetReplyInToolInput: false,
      targetReplyInFixture: false,
      privatePaths: [],
    },
    phase2B: {
      membershipFrozenBeforeResults: true,
      caseIdentifiersFrozenBeforeResults: true,
      evaluationModeFrozenBeforeResults: true,
      selectionReasonsFrozenBeforeResults: true,
      conversationSplitFrozen: true,
      splitUnit: 'conversation',
      goldTargetExposure: 'evaluator-only',
      modeSpecificAggregation: true,
      allowedOutcomes: [
        'match',
        'mismatch',
        'changed_state',
        'ambiguous',
        'unscorable',
        'denied',
        'missing_capability',
      ],
      blockedPassOutcomes: [
        'changed_state',
        'unscorable',
        'ambiguous',
        'denied',
        'missing_capability',
      ],
      mappingHash: '',
      selectionHash: '',
    },
    laterInboundFirstHoldout: {
      targetEpisodes: 200,
      independentOfReplyExistence: true,
      excludesTargetAndFutureContext: true,
      includesNoReplyEpisode: true,
    },
    partitionSummary: gate.derivePrivateQualificationPartitions([]),
    cases: [],
  };
  const digests = gate.computeManifestDigests(manifest);
  manifest.source.contentHash = digests.contentHash;
  manifest.source.mappingHash = digests.mappingHash;
  manifest.phase2B.mappingHash = digests.mappingHash;
  manifest.phase2B.selectionHash = digests.selectionHash;
  return manifest;
}

function historicalModeManifest(gate: any) {
  const manifest = emptyPrivateV2Manifest(gate);
  const record = { id: 'historical-case', cohort: 'later_snapshot_extension' };
  const caseId = gate.hashOpaqueIdentifier(record.id);
  manifest.runId = 'u11-mode-test';
  manifest.source.sourceVintage = 'historical-corpus-2026-09-07';
  manifest.source.modeContract = 'historical-replay-only';
  manifest.partitionSummary = gate.derivePrivateQualificationPartitions([record]);
  manifest.counts = {
    mapRecords: 1,
    original420: 0,
    originalExternalMixedCandidates: 0,
    originalOutboundExternalMixedCandidates: 0,
    runnable: 0,
    notRunnable: 1,
    unscorable: 0,
  };
  manifest.cases = [
    {
      id: caseId,
      conversationId: caseId,
      evaluationMode: 'current-state',
      split: null,
      conversationBasis: 'unresolved',
      partitionLabels: ['all-581'],
      selectionStatus: 'not-runnable',
      skipReason: 'mode test unresolved case',
      toolInput: {
        requestContextDigest: caseId,
        evaluationMode: 'current-state',
      },
      sourceQualification: {
        sameRequestIdentity: 'missing',
        legitimateInboundBeforeTarget: 'missing',
        sourceBinding: 'not-proven',
        permission: 'missing',
        reference: 'not-proven',
        preReplyTime: 'missing',
        preReplyReference: 'missing',
        sourceDirection: 'unknown',
        preReplyReason: 'missing-context',
      },
      fieldOutcomes: { qualification: 'unscorable' },
      exposure: {
        target: 'evaluator-only',
        sealedBeforeOutcome: true,
        outcomeMayInformTuning: false,
        outcomeMayInformRepair: false,
        outcomeMayChooseFixtures: false,
        outcomeMayTriggerRetry: false,
        state: 'unassigned',
      },
    },
  ];
  const digests = gate.computeManifestDigests(manifest);
  manifest.source.contentHash = digests.contentHash;
  manifest.source.mappingHash = digests.mappingHash;
  manifest.phase2B.mappingHash = digests.mappingHash;
  manifest.phase2B.selectionHash = digests.selectionHash;
  return manifest;
}

function semanticSealPayload(gate: any, manifest: any, runId: string) {
  const version = manifest.schemaVersion.endsWith('.v3') ? 'v3' : 'v2';
  const outputContract = ['manifest.json', 'aggregate.json', 'receipt.json', 'seal.json'];
  const manifestDigest = gate.privateQualificationManifestDigest(manifest);
  const counts = { ...manifest.counts };
  return {
    aggregate: {
      schemaVersion: `u11-private-qualification.aggregate.${version}`,
      runId,
      manifestDigest,
      inputDigestSetHash: manifest.source.inputDigestSetHash,
      counts,
      outputContract,
      targetOutcomeProcessing: false,
      liveCapabilityClaim: false,
    },
    receipt: {
      schemaVersion: `u11-private-qualification.receipt.${version}`,
      runId,
      manifestDigest,
      inputDigestSetHash: manifest.source.inputDigestSetHash,
      inputByteHashes: {
        canonicalMap: manifest.source.canonicalMap,
        pointers: manifest.source.pointerDigests,
      },
      counts,
      outputContract,
      verifyCommand: `node verify ${runId}`,
      liveCapabilityClaim: false,
      targetOutcomeProcessing: false,
    },
  };
}

describe('reservation-pilot gate dispatch', () => {
  it('dispatches the U11 integrated journey through one exact disposable-DB slice', async () => {
    const gate = await import('../scripts/reservation-pilot-gate-lib.mjs');

    expect(() => gate.getServerTestFiles('unit', 'integration')).toThrow(
      /unknown slice integration for mode unit/i,
    );
    expect(gate.getServerTestFiles('db', 'integration')).toEqual([
      'tests/reservation-tools-pilot-integration.test.ts',
    ]);
    expect(readFileSync(gatePath, 'utf8')).toContain(
      'run_db_slice "tests/reservation-tools-pilot-integration.test.ts"',
    );
  });

  it('hashes real qualification inputs and rejects equal-size byte tampering', async () => {
    const gate = await import('../scripts/reservation-pilot-gate-lib.mjs');
    const root = mkdtempSync(path.join(tmpdir(), 'u11-v2-inputs-'));
    try {
      mkdirSync(path.join(root, 'private'), { recursive: true });
      writeFileSync(path.join(root, 'private', 'map.json'), '{"map":true}\n');
      writeFileSync(path.join(root, 'private', 'source.json'), '{"source":true}\n');
      const mapBytes = readFileSync(path.join(root, 'private', 'map.json'));
      const sourceBytes = readFileSync(path.join(root, 'private', 'source.json'));
      const expected = gate.hashQualificationInputs({
        root,
        canonicalMap: {
          path: 'private/map.json',
          bytes: mapBytes.length,
          sha256: gate.sha256Bytes(mapBytes),
        },
        pointers: [
          {
            name: 'source',
            path: 'private/source.json',
            bytes: sourceBytes.length,
            sha256: gate.sha256Bytes(sourceBytes),
          },
        ],
      });
      expect(expected.pointers).toHaveLength(1);
      expect(expected.digestSetHash).toMatch(/^sha256:[a-f0-9]{64}$/);

      writeFileSync(path.join(root, 'private', 'source.json'), '{"source":false}\n');
      expect(() =>
        gate.hashQualificationInputs({
          root,
          canonicalMap: {
            path: 'private/map.json',
            bytes: mapBytes.length,
            sha256: expected.canonicalMap.sha256,
          },
          pointers: [
            {
              name: 'source',
              path: 'private/source.json',
              bytes: sourceBytes.length,
              sha256: expected.pointers[0].sha256,
            },
          ],
        }),
      ).toThrow(/byte count|sha-256|digest|tamper/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires an independent fingerprint/thread join before assigning a conversation split', async () => {
    const gate = await import('../scripts/reservation-pilot-gate-lib.mjs');
    const joined = gate.joinPrivateQualificationPointers({
      mapRecords: [
        { id: 'case-joined', cohort: 'original_420' },
        { id: 'case-message-only', cohort: 'original_420' },
      ],
      reviewRecords: [
        {
          review_id: 'case-joined',
          fp: 'fingerprint-joined',
          source_message_id: 'message-joined',
          source_thread_id: 'thread-joined',
        },
        {
          review_id: 'case-message-only',
          fp: 'fingerprint-message-only',
          source_message_id: 'message-message-only',
          source_thread_id: 'thread-message-only',
        },
      ],
      extraRecords: [],
      unionRecords: [
        {
          fp: 'fingerprint-joined',
          message_id: 'message-joined',
          thread_id: 'thread-joined',
        },
        {
          fp: 'fingerprint-message-only',
          message_id: 'message-message-only',
          thread_id: 'other-thread',
        },
      ],
      catchupRecords: [],
    });
    expect(joined).toEqual([
      expect.objectContaining({
        index: 0,
        conversationBasis: 'verified-thread',
        fingerprintJoin: 'verified',
        sourceThreadBinding: 'verified',
      }),
      expect.objectContaining({
        index: 1,
        conversationBasis: 'unresolved',
        fingerprintJoin: 'verified',
        sourceThreadBinding: 'not-proven',
      }),
    ]);
  });

  it('requires pinned prereply direction/time and reference-chain evidence per case', async () => {
    const gate = await import('../scripts/reservation-pilot-gate-lib.mjs');
    const joined = gate.joinPrivateQualificationPointers({
      mapRecords: [
        { id: 'case-inbound', source_evidence: { strict_earlier_nonidentical_context_count: 1 } },
        { id: 'case-outbound', source_evidence: { strict_earlier_nonidentical_context_count: 1 } },
      ],
      reviewRecords: [
        {
          review_id: 'case-inbound',
          fp: 'fingerprint-inbound',
          source_message_id: 'message-inbound',
          source_thread_id: 'thread-inbound',
          rfc_message_id: ['prior-message'],
          sent: '2026-09-01T10:00:00.000Z',
          pre_reply_local_context: [
            {
              message_id: 'prior-message',
              thread_id: 'thread-inbound',
              direction: 'inbound',
              sent: '2026-09-01T09:00:00.000Z',
            },
          ],
        },
        {
          review_id: 'case-outbound',
          fp: 'fingerprint-outbound',
          source_message_id: 'message-outbound',
          source_thread_id: 'thread-outbound',
          rfc_message_id: ['prior-outbound'],
          sent: '2026-09-01T10:00:00.000Z',
          pre_reply_local_context: [
            {
              message_id: 'prior-outbound',
              thread_id: 'thread-outbound',
              direction: 'inbound',
              sent: '2026-09-01T09:00:00.000Z',
            },
          ],
        },
      ],
      unionRecords: [
        {
          fp: 'fingerprint-inbound',
          message_id: 'message-inbound',
          thread_id: 'thread-inbound',
          direction: 'inbound',
          sent: '2026-09-01T10:00:00.000Z',
        },
        {
          fp: 'fingerprint-outbound',
          message_id: 'message-outbound',
          thread_id: 'thread-outbound',
          direction: 'outbound',
          sent: '2026-09-01T10:00:00.000Z',
        },
      ],
    });
    expect(joined[0]).toEqual(
      expect.objectContaining({
        sourceDirection: 'inbound',
        preReplyTimeBinding: 'verified',
        preReplyReferenceBinding: 'verified',
        preReplyReason: 'verified',
      }),
    );
    expect(joined[1]).toEqual(
      expect.objectContaining({
        sourceDirection: 'outbound',
        preReplyReason: 'wrong-direction',
      }),
    );
  });

  it('derives canonical partition membership and enforces exact nesting', async () => {
    const gate = await import('../scripts/reservation-pilot-gate-lib.mjs');
    const summary = gate.derivePrivateQualificationPartitions([
      {
        id: 'canonical-outbound',
        cohort: 'original_420',
        original_external_mixed_candidate: true,
        physical_direction: 'outbound',
      },
      {
        id: 'canonical-inbound',
        cohort: 'original_420',
        original_external_mixed_candidate: true,
        physical_direction: 'inbound',
      },
      { id: 'canonical-other', cohort: 'original_420' },
      { id: 'historical-only', cohort: 'later_snapshot_extension' },
    ]);
    expect(summary.partitions.canonical420.count).toBe(3);
    expect(summary.partitions.externalMixed253.count).toBe(2);
    expect(summary.partitions.strictOutbound251.count).toBe(1);
    expect(
      summary.partitions.strictOutbound251.memberSet.every((id) =>
        summary.partitions.externalMixed253.memberSet.includes(id),
      ),
    ).toBe(true);
    expect(
      summary.partitions.externalMixed253.memberSet.every((id) =>
        summary.partitions.canonical420.memberSet.includes(id),
      ),
    ).toBe(true);
    expect(() =>
      gate.assertPrivatePartitionSummary({
        ...summary,
        partitions: {
          ...summary.partitions,
          strictOutbound251: {
            ...summary.partitions.strictOutbound251,
            count: 2,
          },
        },
      }),
    ).toThrow(/partition|nest|count/i);
  });

  it('enforces the v2 pre-outcome holdout floor before accepting a manifest', async () => {
    const gate = await import('../scripts/reservation-pilot-gate-lib.mjs');
    const manifest = emptyPrivateV2Manifest(gate);
    expect(gate.assertPrivateQualificationV2Manifest(manifest)).toBe(true);
    const belowFloor = structuredClone(manifest);
    belowFloor.laterInboundFirstHoldout.targetEpisodes = 199;
    const digests = gate.computeManifestDigests(belowFloor);
    belowFloor.source.contentHash = digests.contentHash;
    belowFloor.source.mappingHash = digests.mappingHash;
    belowFloor.phase2B.mappingHash = digests.mappingHash;
    belowFloor.phase2B.selectionHash = digests.selectionHash;
    expect(() => gate.assertPrivateQualificationV2Manifest(belowFloor)).toThrow(
      /holdout floor|isolation/i,
    );
  });

  it('rejects current-state aggregation for a historical source-vintage manifest', async () => {
    const gate = await import('../scripts/reservation-pilot-gate-lib.mjs');
    const manifest = historicalModeManifest(gate);
    expect(() => gate.assertPrivateQualificationV2Manifest(manifest)).toThrow(/historical|mode/i);
  });

  it('keeps historical replay consumers separate from current and future-shadow modes', async () => {
    const gate = await import('../scripts/reservation-pilot-gate-lib.mjs');
    const manifest = historicalModeManifest(gate);
    manifest.schemaVersion = 'u11-private-qualification.v3';
    manifest.cases[0].evaluationMode = 'historical-replay';
    manifest.cases[0].toolInput.evaluationMode = 'historical-replay';
    const digests = gate.computeManifestDigests(manifest);
    manifest.source.contentHash = digests.contentHash;
    manifest.source.mappingHash = digests.mappingHash;
    manifest.phase2B.mappingHash = digests.mappingHash;
    manifest.phase2B.selectionHash = digests.selectionHash;
    expect(gate.assertPrivateQualificationV3Manifest(manifest)).toBe(true);
    const session = gate.createEvaluationSession(manifest, { contract: 'private-v3' });
    expect(session.aggregate('historical-replay')).toEqual(
      expect.objectContaining({ evaluationMode: 'historical-replay', eligibleCount: 0 }),
    );
    expect(() => session.aggregate('current-state')).toThrow(/historical|mode/i);
    expect(() => session.aggregate('future-shadow')).toThrow(/historical|mode/i);
  });

  it('rejects semantically incomplete aggregate and receipt sets before publication', async () => {
    const gate = await import('../scripts/reservation-pilot-gate-lib.mjs');
    const root = mkdtempSync(path.join(tmpdir(), 'u11-v3-semantic-red-'));
    try {
      const manifest = emptyPrivateV2Manifest(gate);
      manifest.runId = 'u11-semantic-red';
      const digests = gate.computeManifestDigests(manifest);
      manifest.source.contentHash = digests.contentHash;
      manifest.source.mappingHash = digests.mappingHash;
      manifest.phase2B.mappingHash = digests.mappingHash;
      manifest.phase2B.selectionHash = digests.selectionHash;
      expect(() =>
        gate.publishPrivateQualificationSeal({
          root,
          runId: manifest.runId,
          manifest,
          aggregate: { schemaVersion: 'u11-private-qualification.aggregate.v2', counts: {} },
          receipt: { inputDigestSetHash: manifest.source.inputDigestSetHash },
        }),
      ).toThrow(/aggregate|receipt|semantic|contract/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes a sealed run once, verifies bytes read-only, and rejects tamper/incomplete seals', async () => {
    const gate = await import('../scripts/reservation-pilot-gate-lib.mjs');
    const root = mkdtempSync(path.join(tmpdir(), 'u11-v2-seal-'));
    try {
      const manifest = {
        schemaVersion: 'u11-private-qualification.v2',
        fixtureKind: 'private',
        publicFixture: false,
        source: {
          name: 'test',
          version: 'test',
          contentHash: 'sha256:' + 'a'.repeat(64),
          mappingHash: 'sha256:' + 'b'.repeat(64),
          inputDigestSetHash: 'sha256:' + 'c'.repeat(64),
          canonicalMap: {
            path: 'private/map.json',
            bytes: 0,
            sha256: 'sha256:' + '1'.repeat(64),
          },
          pointerDigests: Array.from({ length: 14 }, (_, index) => ({
            name: `pointer-${index}`,
            path: `private/pointer-${index}.json`,
            bytes: 0,
            sha256: 'sha256:' + `${index + 2}`.repeat(64).slice(0, 64),
          })),
        },
        counts: {
          mapRecords: 0,
          original420: 0,
          originalExternalMixedCandidates: 0,
          originalOutboundExternalMixedCandidates: 0,
          runnable: 0,
          notRunnable: 0,
          unscorable: 0,
        },
        privacy: {
          rawCorpusIncluded: false,
          targetReplyInToolInput: false,
          targetReplyInFixture: false,
          privatePaths: [],
        },
        phase2B: {
          membershipFrozenBeforeResults: true,
          caseIdentifiersFrozenBeforeResults: true,
          evaluationModeFrozenBeforeResults: true,
          selectionReasonsFrozenBeforeResults: true,
          conversationSplitFrozen: true,
          splitUnit: 'conversation',
          goldTargetExposure: 'evaluator-only',
          modeSpecificAggregation: true,
          allowedOutcomes: [
            'match',
            'mismatch',
            'changed_state',
            'ambiguous',
            'unscorable',
            'denied',
            'missing_capability',
          ],
          blockedPassOutcomes: [
            'changed_state',
            'unscorable',
            'ambiguous',
            'denied',
            'missing_capability',
          ],
        },
        laterInboundFirstHoldout: {
          targetEpisodes: 200,
          independentOfReplyExistence: true,
          excludesTargetAndFutureContext: true,
          includesNoReplyEpisode: true,
        },
        partitionSummary: gate.derivePrivateQualificationPartitions([]),
        cases: [],
      };
      manifest.runId = 'u11-test-run';
      const digests = gate.computeManifestDigests(manifest);
      manifest.source.contentHash = digests.contentHash;
      manifest.source.mappingHash = digests.mappingHash;
      manifest.phase2B.mappingHash = digests.mappingHash;
      manifest.phase2B.selectionHash = digests.selectionHash;
      const payload = semanticSealPayload(gate, manifest, 'u11-test-run');
      const published = gate.publishPrivateQualificationSeal({
        root,
        runId: 'u11-test-run',
        manifest,
        ...payload,
      });
      expect(gate.verifyPrivateQualificationSeal({ root, runId: 'u11-test-run' })).toEqual(
        expect.objectContaining({ complete: true, runId: 'u11-test-run' }),
      );

      const foreignManifest = structuredClone(manifest);
      foreignManifest.runId = 'u11-foreign-run';
      const foreignDigests = gate.computeManifestDigests(foreignManifest);
      foreignManifest.source.contentHash = foreignDigests.contentHash;
      foreignManifest.source.mappingHash = foreignDigests.mappingHash;
      foreignManifest.phase2B.mappingHash = foreignDigests.mappingHash;
      foreignManifest.phase2B.selectionHash = foreignDigests.selectionHash;
      const foreignPayload = semanticSealPayload(gate, foreignManifest, 'u11-foreign-run');
      const foreignPublished = gate.publishPrivateQualificationSeal({
        root,
        runId: 'u11-foreign-run',
        manifest: foreignManifest,
        ...foreignPayload,
      });
      const foreignAggregate = {
        ...JSON.parse(readFileSync(path.join(foreignPublished.path, 'aggregate.json'), 'utf8')),
        runId: 'u11-foreign-other',
      };
      const foreignAggregateBytes = Buffer.from(`${gate.canonicalJson(foreignAggregate)}\n`);
      writeFileSync(path.join(foreignPublished.path, 'aggregate.json'), foreignAggregateBytes);
      const foreignSeal = JSON.parse(
        readFileSync(path.join(foreignPublished.path, 'seal.json'), 'utf8'),
      );
      foreignSeal.outputByteHashes['aggregate.json'] = {
        bytes: foreignAggregateBytes.length,
        sha256: gate.sha256Bytes(foreignAggregateBytes),
      };
      writeFileSync(
        path.join(foreignPublished.path, 'seal.json'),
        `${gate.canonicalJson(foreignSeal)}\n`,
      );
      expect(() => gate.verifyPrivateQualificationSeal({ root, runId: 'u11-foreign-run' })).toThrow(
        /run ID|semantic|aggregate/i,
      );

      expect(() =>
        gate.publishPrivateQualificationSeal({
          root,
          runId: 'u11-test-run',
          manifest,
          aggregate: {},
          receipt: {},
        }),
      ).toThrow(/exists|sealed/i);
      writeFileSync(path.join(published.path, 'aggregate.json'), '{"tampered":true}\n');
      expect(() => gate.verifyPrivateQualificationSeal({ root, runId: 'u11-test-run' })).toThrow(
        /hash|integrity|tamper/i,
      );
      mkdirSync(path.join(root, 'u11-incomplete-run'));
      writeFileSync(
        path.join(root, 'u11-incomplete-run', 'seal.json'),
        JSON.stringify({ schemaVersion: 'u11-private-seal.v2', complete: false }),
      );
      expect(() =>
        gate.verifyPrivateQualificationSeal({ root, runId: 'u11-incomplete-run' }),
      ).toThrow(/complete|seal/i);
      expect(existsSync(path.join(root, 'u11-test-run'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('freezes a private pre-outcome qualification manifest through the U1 session contract', async () => {
    const gate = await import('../scripts/reservation-pilot-gate-lib.mjs');
    const caseId = `sha256:${'a'.repeat(64)}`;
    const conversationId = `sha256:${'b'.repeat(64)}`;
    const requestContextDigest = `sha256:${'c'.repeat(64)}`;
    const manifest = {
      schemaVersion: 'u11-private-qualification.v1',
      fixtureKind: 'private',
      publicFixture: false,
      source: {
        name: 'u11-private-canonical-map',
        version: '2026-09-10',
        contentHash: '',
        mappingHash: '',
      },
      counts: {
        mapRecords: 1,
        original420: 1,
        originalExternalMixedCandidates: 1,
        originalOutboundExternalMixedCandidates: 1,
        runnable: 0,
        notRunnable: 1,
        unscorable: 0,
      },
      privacy: {
        rawCorpusIncluded: false,
        targetReplyInToolInput: false,
        targetReplyInFixture: false,
        privatePaths: [],
      },
      phase2B: {
        selectionHash: '',
        mappingHash: '',
        membershipFrozenBeforeResults: true,
        caseIdentifiersFrozenBeforeResults: true,
        evaluationModeFrozenBeforeResults: true,
        selectionReasonsFrozenBeforeResults: true,
        conversationSplitFrozen: true,
        splitUnit: 'conversation',
        goldTargetExposure: 'evaluator-only',
        modeSpecificAggregation: true,
        allowedOutcomes: [
          'match',
          'mismatch',
          'changed_state',
          'ambiguous',
          'unscorable',
          'denied',
          'missing_capability',
        ],
        blockedPassOutcomes: [
          'changed_state',
          'unscorable',
          'ambiguous',
          'denied',
          'missing_capability',
        ],
      },
      cases: [
        {
          id: caseId,
          conversationId,
          evaluationMode: 'current-state',
          split: 'development',
          selectionStatus: 'not-runnable',
          skipReason: 'missing verified same-request identity',
          toolInput: { requestContextDigest },
          sourceQualification: {
            sameRequestIdentity: 'missing',
            legitimateInboundBeforeTarget: 'missing',
            sourceBinding: 'missing',
            permission: 'missing',
          },
          fieldOutcomes: { qualification: 'unscorable' },
          exposure: {
            target: 'evaluator-only',
            sealedBeforeOutcome: true,
            outcomeMayInformTuning: false,
            outcomeMayInformRepair: false,
            outcomeMayChooseFixtures: false,
            outcomeMayTriggerRetry: false,
            state: 'development',
          },
        },
      ],
      laterInboundFirstHoldout: {
        targetEpisodes: 0,
        independentOfReplyExistence: true,
        excludesTargetAndFutureContext: true,
        includesNoReplyEpisode: true,
      },
    };
    const digests = gate.computeManifestDigests(manifest);
    manifest.source.contentHash = digests.contentHash;
    manifest.source.mappingHash = digests.mappingHash;
    manifest.phase2B.mappingHash = digests.mappingHash;
    manifest.phase2B.selectionHash = digests.selectionHash;

    expect(gate.assertPrivateEvaluationManifest(manifest)).toBe(true);
    const session = gate.createEvaluationSession(manifest, { contract: 'private' });
    expect(session.aggregate('current-state')).toEqual({
      evaluationMode: 'current-state',
      split: 'development',
      caseIds: [],
      eligibleCount: 0,
    });
    expect(() => session.recordOutcome(caseId, 'current-state', 'match')).toThrow(/not eligible/i);

    const leaked = structuredClone(manifest);
    leaked.cases[0].toolInput.targetReplyDigest = requestContextDigest;
    const leakedDigests = gate.computeManifestDigests(leaked);
    leaked.source.contentHash = leakedDigests.contentHash;
    leaked.source.mappingHash = leakedDigests.mappingHash;
    leaked.phase2B.mappingHash = leakedDigests.mappingHash;
    leaked.phase2B.selectionHash = leakedDigests.selectionHash;
    expect(() => gate.assertPrivateEvaluationManifest(leaked)).toThrow(
      /target leakage|unapproved field/i,
    );
  });

  it('dispatches the library-known named tests instead of reaching unconditional PASS', async () => {
    const gate = await import('../scripts/reservation-pilot-gate-lib.mjs');

    expect(gate.getServerTestFiles('db', 'candidate-drafting')).toEqual([
      'tests/ai-candidate-draft-contract.test.ts',
      'tests/ai-worker-contract.test.ts',
    ]);
    expect(readFileSync(gatePath, 'utf8')).toContain('run_db_planned_slice candidate-drafting');

    const result = runGate('db', 'candidate-drafting');
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/NAVA_TEST_DATABASE_URL|disposable database/i);
    expect(output).not.toContain('reservation-pilot-gate: PASS mode=db slice=candidate-drafting');
  });

  it('rejects empty, failed, skipped, and missing Vitest reports', async () => {
    const gate = await import('../scripts/reservation-pilot-gate-lib.mjs');

    expect(
      gate.validateVitestReport({
        numTotalTests: 2,
        numPassedTests: 2,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        numSkippedTests: 0,
        testResults: [],
      }),
    ).toEqual({ total: 2, passed: 2, failed: 0, skipped: 0 });
    expect(() => gate.validateVitestReport({})).toThrow(/zero tests/i);
    expect(() =>
      gate.validateVitestReport({
        numTotalTests: 1,
        numPassedTests: 1,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        numSkippedTests: 0,
        testResults: [{ assertionResults: [{ status: 'skipped' }] }],
      }),
    ).toThrow(/fully green|skipped/i);
    expect(() =>
      gate.validateVitestReport({
        numTotalTests: 1,
        numPassedTests: 0,
        numFailedTests: 1,
        numPendingTests: 0,
        numTodoTests: 0,
        numSkippedTests: 0,
        testResults: [],
      }),
    ).toThrow(/fully green|failed/i);

    const missing = spawnSync(
      process.execPath,
      [
        gateLibPath,
        'validate-vitest-report',
        path.join(serverPilot, 'tests', '__missing-vitest-report__.json'),
      ],
      {
        cwd: repoRoot,
        env: { PATH: process.env.PATH },
        encoding: 'utf8',
      },
    );
    expect(missing.status).not.toBe(0);
    expect(`${missing.stdout}${missing.stderr}`).toMatch(/missing|invalid/i);
  });

  it('serializes DB test files when cleanup uses relation-locking truncation', () => {
    const source = readFileSync(gatePath, 'utf8');
    const start = source.indexOf('run_db_slice()');
    const end = source.indexOf('run_db_planned_slice()');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain('--no-file-parallelism');
  });
});
