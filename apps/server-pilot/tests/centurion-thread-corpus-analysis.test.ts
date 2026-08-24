import {
  CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
  createAnalysisItems,
  deriveAnalysisItemId,
  preparePrivateAnalysis,
  reconcileAnalystDecisionBundle,
  validateReconciledAnalystDecisions,
  type AnalystDecisionBundleV1,
  type PreparedPrivateAnalysisV1,
  type PrivateAnalysisPacketV1,
} from '../src/ops/centurion-thread-corpus-analysis.js';
import {
  buildPrivateThreadCorpusSnapshot,
  formatLogicalMessages,
  validatePrivateThreadCorpusSnapshot,
  type PrivateThreadCorpusSnapshot,
  type ThreadCorpusSourceRow,
} from '../scripts/export-thread-corpus.js';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const BODY_MARKER = 'SYNTHETIC_ANALYSIS_BODY_MARKER';
const ADDRESS_MARKER = 'analysis.sender@example.test';
const HEADER_MARKER = 'SYNTHETIC_ANALYSIS_HEADER_MARKER';
const PATH_MARKER = 'C:\\synthetic\\analysis-private-path';
const ARTIFACT_MARKER = 'SYNTHETIC_ANALYSIS_ARTIFACT_MARKER';
const SOURCE_ROW_ONE = 'synthetic-analysis-row-one';
const SOURCE_ROW_TWO = 'synthetic-analysis-row-two';
const SOURCE_ROW_UNKNOWN = 'synthetic-analysis-row-unknown';
const SOURCE_ROW_QUARANTINE_ONE = 'synthetic-analysis-quarantine-one';
const SOURCE_ROW_QUARANTINE_TWO = 'synthetic-analysis-quarantine-two';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function syntheticRow(input: {
  sourceRowId: string;
  receivedAt: string;
  messageId: string;
  deliveryStatus?: 'smtp_accepted' | 'not_claimed';
  rawMimeStatus?: 'available' | 'missing';
  quarantined?: boolean;
  withoutPrivateMessage?: boolean;
}): ThreadCorpusSourceRow {
  const {
    sourceRowId,
    receivedAt,
    messageId,
    deliveryStatus = 'not_claimed',
    rawMimeStatus = 'missing',
    quarantined = false,
    withoutPrivateMessage = false,
  } = input;
  return {
    sourceRowId,
    scopeMembership: quarantined
      ? ['designated_reservationist_mailbox']
      : ['centurion_transport', 'designated_reservationist_mailbox'],
    receivedAt,
    threadId: quarantined ? null : 'synthetic-analysis-thread',
    messageId,
    contentFingerprint: `content-${sourceRowId}`,
    provenanceFingerprint: `provenance-${sourceRowId}`,
    body: `${BODY_MARKER}:${sourceRowId}`,
    ...(quarantined ? { isQuarantined: true } : {}),
    ...(withoutPrivateMessage
      ? {}
      : {
          privateMessage: {
            subject: `${BODY_MARKER}:subject`,
            direction: 'inbound',
            addresses: {
              from: [ADDRESS_MARKER],
              to: [],
              cc: [],
              bcc: [],
            },
            originalAddresses: {
              from: [ADDRESS_MARKER],
              to: [],
              cc: [],
              bcc: [],
            },
            canonicalHeaders: {
              'x-synthetic-analysis-a': [HEADER_MARKER],
              'x-synthetic-analysis-b': [`${HEADER_MARKER}:secondary`],
            },
            sentAt: null,
            rawMime: {
              locator: rawMimeStatus === 'available' ? `${PATH_MARKER}\\${sourceRowId}.eml` : null,
              status: rawMimeStatus,
            },
            attachments: [],
            draftRevisionLinks: [],
            outboundDelivery: {
              queueState: 'unknown',
              deliveryStatus,
            },
            sourceMetadata: {
              transportId: 'synthetic-centurion-transport',
              ingestMailboxId: null,
              uidl: `uidl-${sourceRowId}`,
            },
          },
        }),
  };
}

function syntheticSnapshot(): PrivateThreadCorpusSnapshot {
  const formatted = formatLogicalMessages([
    syntheticRow({
      sourceRowId: SOURCE_ROW_ONE,
      receivedAt: '2026-08-23T10:00:00.000Z',
      messageId: '<synthetic-analysis-one@example.test>',
      deliveryStatus: 'smtp_accepted',
      rawMimeStatus: 'available',
    }),
    syntheticRow({
      sourceRowId: SOURCE_ROW_TWO,
      receivedAt: '2026-08-23T10:01:00.000Z',
      messageId: '<synthetic-analysis-two@example.test>',
    }),
    syntheticRow({
      sourceRowId: SOURCE_ROW_UNKNOWN,
      receivedAt: '2026-08-23T10:02:00.000Z',
      messageId: '<synthetic-analysis-unknown@example.test>',
      withoutPrivateMessage: true,
    }),
    syntheticRow({
      sourceRowId: SOURCE_ROW_QUARANTINE_ONE,
      receivedAt: '2026-08-23T10:03:00.000Z',
      messageId: '<synthetic-analysis-quarantine-one@example.test>',
      quarantined: true,
    }),
    syntheticRow({
      sourceRowId: SOURCE_ROW_QUARANTINE_TWO,
      receivedAt: '2026-08-23T10:04:00.000Z',
      messageId: '<synthetic-analysis-quarantine-two@example.test>',
      quarantined: true,
    }),
  ]);

  return buildPrivateThreadCorpusSnapshot({
    context: {
      snapshotId: 'synthetic-analysis-snapshot-001',
      scope: {
        scopeKeys: ['centurion_transport', 'designated_reservationist_mailbox'],
        transportIds: ['synthetic-centurion-transport', 'synthetic-designated-transport'],
        participantAddressRef: 'private_designated_reservationist_address',
        messagePredicate: 'selected_transports_or_private_designated_address_before_as_of',
        quarantinePredicate: 'selected_ingest_mailbox_or_owner_header_before_as_of',
      },
      asOf: '2026-08-23T12:00:00.000Z',
      exporterVersion: 'synthetic-analysis-test-v1',
      unscopedQuarantineExcluded: 0,
    },
    formatted,
    hydration: {
      attachmentLocators: [],
      payloads: [
        {
          kind: 'raw_mime',
          sourceRowId: SOURCE_ROW_ONE,
          status: 'available',
          content: textEncoder.encode(ARTIFACT_MARKER),
        },
      ],
    },
  });
}

function headerPermutedSnapshot(
  snapshot: PrivateThreadCorpusSnapshot,
): PrivateThreadCorpusSnapshot {
  const corpusLines = snapshot.corpusJsonl.slice(0, -1).split('\n');
  const metadata = JSON.parse(corpusLines[0]!) as Record<string, unknown>;
  const records = corpusLines.slice(1).map((line) => JSON.parse(line)) as Array<{
    recordType: string;
    messages?: Array<{
      sourceRows: Array<{
        privateMessage?: {
          canonicalHeaders: Record<string, string[]>;
        };
      }>;
    }>;
  }>;
  const firstPrivateMessage = records
    .find((record) => record.recordType === 'thread')
    ?.messages?.flatMap((message) => message.sourceRows)
    .find((sourceRow) => sourceRow.privateMessage)?.privateMessage;
  if (!firstPrivateMessage) throw new Error('Expected synthetic private message');
  firstPrivateMessage.canonicalHeaders = Object.fromEntries(
    Object.entries(firstPrivateMessage.canonicalHeaders).reverse(),
  );

  const orderedRecordJsonl = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const nextMetadata = {
    ...metadata,
    orderedRecordSha256: sha256(orderedRecordJsonl),
  };
  const corpusJsonl = `${JSON.stringify(nextMetadata)}\n${orderedRecordJsonl}`;
  const manifest = {
    ...snapshot.manifest,
    orderedRecordSha256: sha256(orderedRecordJsonl),
    localObjectSha256: sha256(corpusJsonl),
  };
  return {
    ...snapshot,
    corpusJsonl,
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
    manifest,
  };
}

function requirePrepared(
  snapshot: PrivateThreadCorpusSnapshot,
  limits = { maxPacketBytes: 1_000_000, maxTotalPacketBytes: 1_000_000 },
): PreparedPrivateAnalysisV1 {
  const prepared = preparePrivateAnalysis(snapshot, limits);
  if (!prepared) throw new Error('Expected synthetic analysis preparation');
  return prepared;
}

function decisionFor(
  packet: PrivateAnalysisPacketV1,
): AnalystDecisionBundleV1['decisions'][number] {
  if (packet.packetState === 'complete') {
    return {
      schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
      analysisItemId: packet.analysisItemId,
      workflow: 'reservation_new',
      risk: 'none',
      confidence: 'high',
      attention: 'routine',
    };
  }

  return {
    schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
    analysisItemId: packet.analysisItemId,
    workflow: 'unknown',
    risk: 'human_review',
    confidence: 'low',
    attention: 'human_review',
  };
}

function validDecisionBundle(prepared: PreparedPrivateAnalysisV1): AnalystDecisionBundleV1 {
  return {
    schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
    preparedManifestSha256: prepared.manifestSha256,
    decisions: prepared.packets.map(decisionFor),
  };
}

function publicPacket(packet: PrivateAnalysisPacketV1): Record<string, unknown> {
  if (packet.packetState === 'complete') {
    return {
      schemaVersion: packet.schemaVersion,
      analysisItemId: packet.analysisItemId,
      unitType: packet.unitType,
      sourceMembership: packet.sourceMembership,
      artifactState: packet.artifactState,
      responseEvidenceState: packet.responseEvidenceState,
      packetState: packet.packetState,
      packetBytes: packet.packetBytes,
      packetSha256: packet.packetSha256,
    };
  }

  return {
    schemaVersion: packet.schemaVersion,
    analysisItemId: packet.analysisItemId,
    unitType: packet.unitType,
    sourceMembership: packet.sourceMembership,
    artifactState: packet.artifactState,
    responseEvidenceState: packet.responseEvidenceState,
    packetState: packet.packetState,
    packetBytes: packet.packetBytes,
    packetSha256: packet.packetSha256,
    omissionReason: packet.omissionReason,
  };
}

function publicOutput(value: unknown): string {
  return JSON.stringify(value);
}

function expectNoFixtureLeaks(value: unknown): void {
  const output = publicOutput(value);
  for (const marker of [
    BODY_MARKER,
    ADDRESS_MARKER,
    HEADER_MARKER,
    PATH_MARKER,
    ARTIFACT_MARKER,
    SOURCE_ROW_ONE,
    SOURCE_ROW_TWO,
    SOURCE_ROW_UNKNOWN,
    SOURCE_ROW_QUARANTINE_ONE,
    SOURCE_ROW_QUARANTINE_TWO,
  ]) {
    expect(output).not.toContain(marker);
  }
}

function capturedError(work: () => unknown): { message: string } {
  try {
    work();
    return { message: 'no-error' };
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
}

function parseCompletePacket(packet: PrivateAnalysisPacketV1): {
  unit: { unitType: string; sourceRowIds: string[] };
  record: { recordType: string; messages?: unknown[] };
  artifactFiles: Array<{ id: string; content: number[] }>;
} {
  if (packet.packetState !== 'complete') throw new Error('Expected complete synthetic packet');
  return JSON.parse(textDecoder.decode(packet.privatePacketBytes)) as {
    unit: { unitType: string; sourceRowIds: string[] };
    record: { recordType: string; messages?: unknown[] };
    artifactFiles: Array<{ id: string; content: number[] }>;
  };
}

function parseTypeScript(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function collectNodes<T extends ts.Node>(
  source: ts.SourceFile,
  predicate: (node: ts.Node) => node is T,
): T[];
function collectNodes(source: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node[];
function collectNodes(source: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return nodes;
}

const ALLOWED_CORE_IMPORTS = new Set([
  '../../scripts/export-thread-corpus.js',
  'node:crypto',
  'zod',
]);

const FORBIDDEN_CORE_GLOBALS = new Set([
  'Function',
  'AWS',
  'WebSocket',
  'XMLHttpRequest',
  'aws',
  'Bedrock',
  'bedrock',
  'console',
  'env',
  'eval',
  'fetch',
  'http',
  'https',
  'Mastra',
  'mastra',
  'net',
  'pg',
  'process',
  'require',
  'tls',
  'undici',
]);

const FORBIDDEN_COMPUTED_CAPABILITIES = new Set([
  ...FORBIDDEN_CORE_GLOBALS,
  'constructor',
  'import',
]);

const FORBIDDEN_CORE_ROOTS = new Set(['globalThis', 'global', 'Reflect']);

const DANGEROUS_OBJECT_REFLECTION_METHODS = new Set([
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  'getPrototypeOf',
  'defineProperty',
  'defineProperties',
]);

const CORE_REQUIRED_OBJECT_UTILITIES = new Set(['getOwnPropertyDescriptor', 'getPrototypeOf']);

function stringLiteralText(node: ts.Expression): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function objectReflectionMethodName(
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | null {
  if (!ts.isIdentifier(access.expression) || access.expression.text !== 'Object') {
    return null;
  }
  return ts.isPropertyAccessExpression(access)
    ? access.name.text
    : access.argumentExpression === undefined
      ? null
      : stringLiteralText(access.argumentExpression);
}

function sourceBoundaryViolations(
  source: ts.SourceFile,
  allowedObjectReflectionMethods: ReadonlySet<string> = new Set(),
): string[] {
  const violations = collectNodes(source, ts.isImportDeclaration).flatMap((node) =>
    ts.isStringLiteral(node.moduleSpecifier) && !ALLOWED_CORE_IMPORTS.has(node.moduleSpecifier.text)
      ? [`import:${node.moduleSpecifier.text}`]
      : [],
  );
  for (const identifier of collectNodes(source, ts.isIdentifier)) {
    if (FORBIDDEN_CORE_ROOTS.has(identifier.text)) {
      violations.push(`root:${identifier.text}`);
    } else if (FORBIDDEN_CORE_GLOBALS.has(identifier.text)) {
      violations.push(`global:${identifier.text}`);
    }
  }
  if (
    collectNodes(
      source,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword,
    ).length > 0
  ) {
    violations.push('dynamic-import');
  }
  if (
    collectNodes(
      source,
      (node): node is ts.PropertyAccessExpression =>
        ts.isPropertyAccessExpression(node) && node.name.text === 'constructor',
    ).length > 0
  ) {
    violations.push('constructor');
  }
  for (const access of collectNodes(source, ts.isElementAccessExpression)) {
    const propertyName =
      access.argumentExpression === undefined ? null : stringLiteralText(access.argumentExpression);
    if (propertyName && FORBIDDEN_COMPUTED_CAPABILITIES.has(propertyName)) {
      violations.push(`computed:${propertyName}`);
    }
    const objectMethod = objectReflectionMethodName(access);
    if (
      objectMethod &&
      DANGEROUS_OBJECT_REFLECTION_METHODS.has(objectMethod) &&
      !allowedObjectReflectionMethods.has(objectMethod)
    ) {
      violations.push(`object-reflection:${objectMethod}`);
    }
  }
  for (const access of collectNodes(source, ts.isPropertyAccessExpression)) {
    const objectMethod = objectReflectionMethodName(access);
    if (
      objectMethod &&
      DANGEROUS_OBJECT_REFLECTION_METHODS.has(objectMethod) &&
      !allowedObjectReflectionMethods.has(objectMethod)
    ) {
      violations.push(`object-reflection:${objectMethod}`);
    }
  }
  return [...new Set(violations)].sort();
}

describe('Centurion private thread corpus analysis', () => {
  it('derives stable opaque IDs from each normalized unique source-row set', () => {
    const expected = sha256(
      JSON.stringify({
        schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
        snapshotId: 'synthetic-analysis-snapshot-001',
        unitType: 'logical_message',
        sourceRowIds: [SOURCE_ROW_ONE, SOURCE_ROW_TWO],
      }),
    );

    expect(
      deriveAnalysisItemId('synthetic-analysis-snapshot-001', 'logical_message', [
        SOURCE_ROW_TWO,
        SOURCE_ROW_ONE,
      ]),
    ).toBe(expected);
    expect(
      deriveAnalysisItemId('synthetic-analysis-snapshot-001', 'logical_message', [
        SOURCE_ROW_ONE,
        SOURCE_ROW_TWO,
      ]),
    ).toBe(expected);

    const duplicate = capturedError(() =>
      deriveAnalysisItemId('synthetic-analysis-snapshot-001', 'logical_message', [
        SOURCE_ROW_ONE,
        SOURCE_ROW_ONE,
      ]),
    );
    const empty = capturedError(() =>
      deriveAnalysisItemId('synthetic-analysis-snapshot-001', 'logical_message', ['']),
    );
    expect(duplicate.message).not.toBe('no-error');
    expect(empty.message).not.toBe('no-error');
    expectNoFixtureLeaks({ duplicate, empty });
  });

  it('creates one item for every nested message and every quarantine record', () => {
    const snapshot = syntheticSnapshot();
    const items = createAnalysisItems(snapshot);

    expect(snapshot.manifest.counts.threads).toBe(1);
    expect(snapshot.manifest.counts.logicalMessages).toBe(3);
    expect(snapshot.manifest.counts.scopedQuarantine).toBe(2);
    expect(items).toHaveLength(
      snapshot.manifest.counts.logicalMessages + snapshot.manifest.counts.scopedQuarantine,
    );
    expect(items.map((item) => item.analysisItemId)).toHaveLength(
      new Set(items.map((item) => item.analysisItemId)).size,
    );
    expect(items.map((item) => item.unitType)).toEqual([
      'logical_message',
      'logical_message',
      'logical_message',
      'quarantine',
      'quarantine',
    ]);
    expect(items.map((item) => item.responseEvidenceState)).toEqual([
      'smtp_accepted',
      'not_claimed',
      'unknown',
      'not_applicable',
      'not_applicable',
    ]);
    expect(items.map((item) => item.artifactState)).toEqual([
      'complete',
      'unavailable',
      'unknown',
      'not_applicable',
      'not_applicable',
    ]);
    expect(items[0]?.sourceMembership).toEqual([
      'centurion_transport',
      'designated_reservationist_mailbox',
    ]);
    expectNoFixtureLeaks(items);
  });

  it('makes canonical bounded private packets with parent-thread context and exact selected source rows', () => {
    const prepared = requirePrepared(syntheticSnapshot());
    const complete = prepared.packets.find(
      (packet) => packet.packetState === 'complete' && packet.unitType === 'logical_message',
    );
    if (!complete || complete.packetState !== 'complete') {
      throw new Error('Expected complete logical-message packet');
    }

    const packetText = textDecoder.decode(complete.privatePacketBytes);
    const packet = parseCompletePacket(complete);
    expect(packetText).toBe(JSON.stringify(JSON.parse(packetText)));
    expect(complete.packetBytes).toBe(complete.privatePacketBytes.byteLength);
    expect(complete.packetSha256).toBe(sha256(complete.privatePacketBytes));
    expect(packet.unit).toEqual({
      unitType: 'logical_message',
      sourceRowIds: [SOURCE_ROW_ONE],
    });
    expect(packet.record.recordType).toBe('thread');
    expect(packet.record.messages).toHaveLength(3);
    expect(packetText).toContain(SOURCE_ROW_ONE);
    expect(packetText).toContain(SOURCE_ROW_TWO);
    expect(packetText).toContain(SOURCE_ROW_UNKNOWN);
    expect(packet.artifactFiles).toHaveLength(1);
    expect(textDecoder.decode(new Uint8Array(packet.artifactFiles[0]!.content))).toBe(
      ARTIFACT_MARKER,
    );

    const unavailable = prepared.packets.find((packet) => packet.packetState === 'unavailable');
    if (!unavailable || unavailable.packetState !== 'unavailable') {
      throw new Error('Expected unavailable evidence packet');
    }
    expect(unavailable.omissionReason).toBe('unavailable_evidence');
    expect(Object.keys(unavailable)).not.toContain('privatePacketBytes');
    expectNoFixtureLeaks({
      manifest: prepared.manifest,
      unavailable,
      publicPackets: prepared.packets.map(publicPacket),
    });
  });

  it('canonicalizes complete packets and prepared manifests across valid header key permutations', () => {
    const snapshot = syntheticSnapshot();
    const permuted = headerPermutedSnapshot(snapshot);
    expect(permuted.corpusJsonl).not.toBe(snapshot.corpusJsonl);
    expect(() => validatePrivateThreadCorpusSnapshot(permuted)).not.toThrow();

    const prepared = requirePrepared(snapshot);
    const preparedPermuted = requirePrepared(permuted);
    expect(preparedPermuted.manifestSha256).toBe(prepared.manifestSha256);
    for (const packet of prepared.packets) {
      if (packet.packetState !== 'complete') continue;
      const matching = preparedPermuted.packets.find(
        (candidate) => candidate.analysisItemId === packet.analysisItemId,
      );
      expect(matching).toMatchObject({
        packetState: 'complete',
        packetSha256: packet.packetSha256,
        packetBytes: packet.packetBytes,
      });
      if (!matching || matching.packetState !== 'complete') {
        throw new Error('Expected matching complete canonical packet');
      }
      expect(matching.privatePacketBytes).toEqual(packet.privatePacketBytes);
    }
  });

  it('truncates packets against per-packet and aggregate safe-integer budgets', () => {
    const snapshot = syntheticSnapshot();
    const full = requirePrepared(snapshot);
    const perPacket = requirePrepared(snapshot, {
      maxPacketBytes: 0,
      maxTotalPacketBytes: 1_000_000,
    });
    expect(perPacket.packets.every((packet) => packet.packetState === 'truncated')).toBe(true);
    expect(
      perPacket.packets.every(
        (packet) =>
          packet.packetState === 'truncated' && packet.omissionReason === 'per_packet_limit',
      ),
    ).toBe(true);

    const firstComplete = full.packets.find(
      (packet): packet is Extract<PrivateAnalysisPacketV1, { packetState: 'complete' }> =>
        packet.packetState === 'complete',
    );
    if (!firstComplete) throw new Error('Expected complete packet for aggregate test');
    const aggregate = requirePrepared(snapshot, {
      maxPacketBytes: 1_000_000,
      maxTotalPacketBytes: firstComplete.packetBytes,
    });
    expect(
      aggregate.packets.some(
        (packet) =>
          packet.packetState === 'truncated' && packet.omissionReason === 'aggregate_packet_limit',
      ),
    ).toBe(true);
    expect(
      preparePrivateAnalysis(snapshot, {
        maxPacketBytes: Number.MAX_SAFE_INTEGER + 1,
        maxTotalPacketBytes: 1_000_000,
      }),
    ).toBeNull();
    expectNoFixtureLeaks(aggregate.packets.map(publicPacket));
  });

  it('rejects tampered V2 bytes without surfacing source content', () => {
    const snapshot = syntheticSnapshot();
    const tampered = {
      ...snapshot,
      corpusJsonl: snapshot.corpusJsonl.replace(BODY_MARKER, `${BODY_MARKER}-tampered`),
    };

    expect(
      preparePrivateAnalysis(tampered, {
        maxPacketBytes: 1_000_000,
        maxTotalPacketBytes: 1_000_000,
      }),
    ).toBeNull();
    const error = capturedError(() => createAnalysisItems(tampered));
    expect(error.message).not.toBe('no-error');
    expectNoFixtureLeaks(error);
  });

  it('binds strict closed analyst decisions to an exact prepared manifest', () => {
    const snapshot = syntheticSnapshot();
    const prepared = requirePrepared(snapshot);
    const decisionBundle = validDecisionBundle(prepared);
    const reconciled = reconcileAnalystDecisionBundle(snapshot, prepared.manifest, decisionBundle);
    const expected =
      snapshot.manifest.counts.logicalMessages + snapshot.manifest.counts.scopedQuarantine;

    expect(reconciled?.decisions).toHaveLength(expected);
    expect(reconciled?.items).toHaveLength(expected);
    expect(reconciled?.preparedManifestSha256).toBe(prepared.manifestSha256);
    expectNoFixtureLeaks({
      items: createAnalysisItems(snapshot),
      manifest: prepared.manifest,
      packets: prepared.packets.map(publicPacket),
      decisions: decisionBundle.decisions,
      reconciled,
    });

    expect(
      reconcileAnalystDecisionBundle(snapshot, prepared.manifest, {
        ...decisionBundle,
        preparedManifestSha256: '0'.repeat(64),
      }),
    ).toBeNull();
    expect(
      reconcileAnalystDecisionBundle(
        snapshot,
        {
          ...prepared.manifest,
          snapshotDigest: '0'.repeat(64),
        },
        decisionBundle,
      ),
    ).toBeNull();

    const decisions = decisionBundle.decisions;
    expect(
      reconcileAnalystDecisionBundle(snapshot, prepared.manifest, {
        ...decisionBundle,
        decisions: [decisions[0]!, decisions[0]!, ...decisions.slice(2)],
      }),
    ).toBeNull();
    expect(
      reconcileAnalystDecisionBundle(snapshot, prepared.manifest, {
        ...decisionBundle,
        decisions: decisions.slice(1),
      }),
    ).toBeNull();
    expect(
      reconcileAnalystDecisionBundle(snapshot, prepared.manifest, {
        ...decisionBundle,
        decisions: [
          ...decisions,
          {
            ...decisions[0]!,
            analysisItemId: 'f'.repeat(64),
          },
        ],
      }),
    ).toBeNull();
    expect(
      reconcileAnalystDecisionBundle(snapshot, prepared.manifest, {
        ...decisionBundle,
        decisions: [
          {
            ...decisions[0]!,
            workflow: 'not-a-workflow',
          },
          ...decisions.slice(1),
        ],
      }),
    ).toBeNull();
    expect(
      reconcileAnalystDecisionBundle(snapshot, prepared.manifest, {
        ...decisionBundle,
        decisions: [
          {
            ...decisions[0]!,
            rationale: BODY_MARKER,
          },
          ...decisions.slice(1),
        ],
      }),
    ).toBeNull();
  });

  it('requires human-review-only decisions for truncated or unavailable evidence', () => {
    const snapshot = syntheticSnapshot();
    const prepared = requirePrepared(snapshot, {
      maxPacketBytes: 0,
      maxTotalPacketBytes: 1_000_000,
    });
    const valid = validDecisionBundle(prepared);
    const first = valid.decisions[0]!;

    expect(
      reconcileAnalystDecisionBundle(snapshot, prepared.manifest, valid)?.decisions,
    ).toHaveLength(
      snapshot.manifest.counts.logicalMessages + snapshot.manifest.counts.scopedQuarantine,
    );
    expect(
      reconcileAnalystDecisionBundle(snapshot, prepared.manifest, {
        ...valid,
        decisions: [
          {
            ...first,
            workflow: 'reservation_new',
            risk: 'none',
            confidence: 'high',
            attention: 'routine',
          },
          ...valid.decisions.slice(1),
        ],
      }),
    ).toBeNull();

    const unavailablePrepared = requirePrepared(snapshot);
    const unavailableValid = validDecisionBundle(unavailablePrepared);
    const unavailableDecisionIndex = unavailablePrepared.packets.findIndex(
      (packet) => packet.packetState === 'unavailable',
    );
    expect(unavailableDecisionIndex).toBeGreaterThanOrEqual(0);
    const unavailableDecision = unavailableValid.decisions[unavailableDecisionIndex]!;
    expect(
      reconcileAnalystDecisionBundle(snapshot, unavailablePrepared.manifest, {
        ...unavailableValid,
        decisions: unavailableValid.decisions.map((decision, index) =>
          index === unavailableDecisionIndex ? { ...unavailableDecision, risk: 'none' } : decision,
        ),
      }),
    ).toBeNull();
  });

  it('revalidates reconciled decisions against complete deterministic provenance', () => {
    const snapshot = syntheticSnapshot();
    const prepared = requirePrepared(snapshot);
    const reconciled = reconcileAnalystDecisionBundle(
      snapshot,
      prepared.manifest,
      validDecisionBundle(prepared),
    );
    if (!reconciled) throw new Error('Expected reconciled synthetic decisions');

    expect(reconciled.preparedManifest).toEqual(prepared.manifest);
    expect(validateReconciledAnalystDecisions(snapshot, reconciled)).toEqual(reconciled);

    const stalePrepared = requirePrepared(snapshot, {
      maxPacketBytes: 0,
      maxTotalPacketBytes: 1_000_000,
    });
    expect(stalePrepared.manifestSha256).not.toBe(prepared.manifestSha256);
    expect(
      validateReconciledAnalystDecisions(snapshot, {
        ...reconciled,
        preparedManifestSha256: stalePrepared.manifestSha256,
      }),
    ).toBeNull();
    expect(
      validateReconciledAnalystDecisions(snapshot, {
        ...reconciled,
        preparedManifest: stalePrepared.manifest,
      }),
    ).toBeNull();
    expect(
      validateReconciledAnalystDecisions(snapshot, {
        ...reconciled,
        unexpected: BODY_MARKER,
      }),
    ).toBeNull();

    const constrainedReconciled = reconcileAnalystDecisionBundle(
      snapshot,
      stalePrepared.manifest,
      validDecisionBundle(stalePrepared),
    );
    if (!constrainedReconciled) throw new Error('Expected constrained reconciliation');
    expect(
      validateReconciledAnalystDecisions(snapshot, {
        ...constrainedReconciled,
        decisions: constrainedReconciled.decisions.map((decision, index) =>
          index === 0
            ? {
                ...decision,
                workflow: 'reservation_new',
                risk: 'none',
                confidence: 'high',
                attention: 'routine',
              }
            : decision,
        ),
      }),
    ).toBeNull();
    expectNoFixtureLeaks({ reconciled, constrainedReconciled });
  });

  it('keeps core source free of runtime and dynamic-execution capabilities', () => {
    const sourcePath = fileURLToPath(
      new URL('../src/ops/centurion-thread-corpus-analysis.ts', import.meta.url),
    );
    const source = parseTypeScript(sourcePath);
    const imports = collectNodes(source, ts.isImportDeclaration).flatMap((node) =>
      ts.isStringLiteral(node.moduleSpecifier) ? [node.moduleSpecifier.text] : [],
    );
    expect(imports.every((moduleName) => ALLOWED_CORE_IMPORTS.has(moduleName))).toBe(true);

    const forbiddenFixture = ts.createSourceFile(
      'synthetic-forbidden-analysis.ts',
      [
        "import { request } from 'node:https';",
        "import { Client } from 'pg';",
        "import { fetch as undiciFetch } from 'undici';",
        'void process.env;',
        'void fetch;',
        'void WebSocket;',
        'void XMLHttpRequest;',
        'void eval;',
        'void Function;',
        'void env;',
        'void http;',
        'void https;',
        'void net;',
        'void tls;',
        'void aws;',
        'void AWS;',
        'void Bedrock;',
        'void bedrock;',
        'void Mastra;',
        'void mastra;',
        'void pg;',
        'void undici;',
        'void import("synthetic-module");',
        'void ({}).constructor;',
        "void globalThis['fetch'];",
        "void globalThis['process']['env'];",
        "void ({})['constructor'];",
        "void Reflect.get(globalThis, 'fetch');",
        "void globalThis['Function'];",
        "void globalThis['eval'];",
        "void globalThis['require'];",
        "void globalThis['import'];",
        'void globalThis;',
        'void global;',
        'void Reflect;',
        "void Object.getOwnPropertyDescriptor(globalThis, 'fetch')!.value;",
        'void Object.getOwnPropertyDescriptors(globalThis);',
        'void Object.getPrototypeOf(globalThis);',
        "void Object.defineProperty({}, 'synthetic', {});",
        'void Object.defineProperties({}, {});',
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(sourceBoundaryViolations(forbiddenFixture)).toEqual(
      expect.arrayContaining([
        'constructor',
        'dynamic-import',
        'global:Function',
        'global:WebSocket',
        'global:XMLHttpRequest',
        'global:AWS',
        'global:aws',
        'global:Bedrock',
        'global:bedrock',
        'global:env',
        'global:eval',
        'global:fetch',
        'global:http',
        'global:https',
        'global:Mastra',
        'global:mastra',
        'global:net',
        'global:pg',
        'global:process',
        'global:tls',
        'global:undici',
        'import:node:https',
        'import:pg',
        'import:undici',
        'computed:Function',
        'computed:constructor',
        'computed:env',
        'computed:eval',
        'computed:fetch',
        'computed:import',
        'computed:process',
        'computed:require',
        'root:globalThis',
        'root:global',
        'root:Reflect',
        'object-reflection:defineProperties',
        'object-reflection:defineProperty',
        'object-reflection:getOwnPropertyDescriptor',
        'object-reflection:getOwnPropertyDescriptors',
        'object-reflection:getPrototypeOf',
      ]),
    );
    expect(sourceBoundaryViolations(source, CORE_REQUIRED_OBJECT_UTILITIES)).toEqual([]);
  });
});
