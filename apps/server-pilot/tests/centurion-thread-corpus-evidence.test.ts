import {
  CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
  preparePrivateAnalysis,
  reconcileAnalystDecisionBundle,
  type AnalysisRisk,
  type AnalysisWorkflow,
  type AnalystDecisionBundleV1,
  type PreparedPrivateAnalysisV1,
  type ReconciledAnalystDecisionsV1,
} from '../src/ops/centurion-thread-corpus-analysis.js';
import {
  CENTURION_CORPUS_EVIDENCE_VERSION,
  buildCenturionCorpusEvidenceReport,
  type CenturionCorpusEvidenceReportV1,
  type EvidenceCategory,
  type EvidencePartition,
} from '../src/ops/centurion-thread-corpus-evidence.js';
import {
  buildPrivateThreadCorpusSnapshot,
  formatLogicalMessages,
  type PrivateThreadCorpusSnapshot,
  type ThreadCorpusSourceRow,
} from '../scripts/export-thread-corpus.js';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const BODY_MARKER = 'SYNTHETIC_EVIDENCE_BODY_MARKER';
const ADDRESS_MARKER = 'evidence.sender@example.test';
const HEADER_MARKER = 'SYNTHETIC_EVIDENCE_HEADER_MARKER';
const PATH_MARKER = 'C:\\synthetic\\evidence-private-path';
const ARTIFACT_MARKER = 'SYNTHETIC_EVIDENCE_ARTIFACT_MARKER';
const textEncoder = new TextEncoder();

type SyntheticRow = {
  artifactState?: 'available' | 'missing';
  responseState?: 'smtp_accepted' | 'not_claimed';
  withoutPrivateMessage?: boolean;
};

type SyntheticItem = {
  unitType?: 'logical_message' | 'quarantine';
  rows?: readonly SyntheticRow[];
};

function syntheticSourceRow(input: {
  itemIndex: number;
  rowIndex: number;
  unitType: SyntheticItem['unitType'];
  row: SyntheticRow;
}): ThreadCorpusSourceRow {
  const { itemIndex, rowIndex, unitType = 'logical_message', row } = input;
  const rawMimeStatus = row.artifactState ?? 'missing';
  const sourceRowId = `synthetic-evidence-item-${itemIndex}-row-${rowIndex}`;
  const messageId = `<synthetic-evidence-${itemIndex}@example.test>`;
  const quarantined = unitType === 'quarantine';
  const withoutPrivateMessage = row.withoutPrivateMessage === true;
  return {
    sourceRowId,
    scopeMembership: quarantined
      ? ['designated_reservationist_mailbox']
      : ['centurion_transport', 'designated_reservationist_mailbox'],
    receivedAt: `2026-08-23T10:${String(itemIndex).padStart(2, '0')}:00.000Z`,
    threadId: quarantined ? null : 'synthetic-evidence-thread',
    messageId,
    contentFingerprint: `content-evidence-item-${itemIndex}`,
    provenanceFingerprint: `provenance-evidence-item-${itemIndex}`,
    body: `${BODY_MARKER}:${itemIndex}:${rowIndex}`,
    ...(quarantined ? { isQuarantined: true } : {}),
    ...(withoutPrivateMessage
      ? {}
      : {
          privateMessage: {
            subject: `${BODY_MARKER}:subject:${itemIndex}`,
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
              'x-synthetic-evidence': [HEADER_MARKER],
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
              deliveryStatus: row.responseState ?? 'not_claimed',
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

function syntheticSnapshot(
  specs: readonly SyntheticItem[],
  unscopedQuarantineExcluded = 0,
): PrivateThreadCorpusSnapshot {
  const rows: ThreadCorpusSourceRow[] = [];
  const payloads: Array<{
    kind: 'raw_mime';
    sourceRowId: string;
    status: 'available';
    content: Uint8Array;
  }> = [];
  for (const [itemIndex, spec] of specs.entries()) {
    const itemRows = spec.rows ?? [{}];
    for (const [rowIndex, row] of itemRows.entries()) {
      const sourceRow = syntheticSourceRow({
        itemIndex,
        rowIndex,
        unitType: spec.unitType,
        row,
      });
      rows.push(sourceRow);
      if (row.withoutPrivateMessage !== true && (row.artifactState ?? 'missing') === 'available') {
        payloads.push({
          kind: 'raw_mime',
          sourceRowId: sourceRow.sourceRowId,
          status: 'available',
          content: textEncoder.encode(`${ARTIFACT_MARKER}:${sourceRow.sourceRowId}`),
        });
      }
    }
  }

  return buildPrivateThreadCorpusSnapshot({
    context: {
      snapshotId: 'synthetic-evidence-snapshot-001',
      scope: {
        scopeKeys: ['centurion_transport', 'designated_reservationist_mailbox'],
        transportIds: ['synthetic-centurion-transport', 'synthetic-designated-transport'],
        participantAddressRef: 'private_designated_reservationist_address',
        messagePredicate: 'selected_transports_or_private_designated_address_before_as_of',
        quarantinePredicate: 'selected_ingest_mailbox_or_owner_header_before_as_of',
      },
      asOf: '2026-08-23T12:00:00.000Z',
      exporterVersion: 'synthetic-evidence-test-v1',
      unscopedQuarantineExcluded,
    },
    formatted: formatLogicalMessages(rows),
    hydration: {
      attachmentLocators: [],
      payloads,
    },
  });
}

function repeatedSpecs(
  count: number,
  item: SyntheticItem = { rows: [{ artifactState: 'available', responseState: 'smtp_accepted' }] },
): SyntheticItem[] {
  return Array.from({ length: count }, () => item);
}

function requirePrepared(snapshot: PrivateThreadCorpusSnapshot): PreparedPrivateAnalysisV1 {
  const prepared = preparePrivateAnalysis(snapshot, {
    maxPacketBytes: 1_000_000,
    maxTotalPacketBytes: 1_000_000,
  });
  if (!prepared) throw new Error('Expected synthetic prepared analysis');
  return prepared;
}

function decisionBundle(
  prepared: PreparedPrivateAnalysisV1,
  input: {
    workflows?: readonly AnalysisWorkflow[];
    risks?: readonly AnalysisRisk[];
  } = {},
): AnalystDecisionBundleV1 {
  return {
    schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
    preparedManifestSha256: prepared.manifestSha256,
    decisions: prepared.packets.map((packet, index) => {
      if (packet.packetState !== 'complete') {
        return {
          schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
          analysisItemId: packet.analysisItemId,
          workflow: 'unknown',
          risk: 'human_review',
          confidence: 'low',
          attention: 'human_review',
        };
      }
      return {
        schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
        analysisItemId: packet.analysisItemId,
        workflow: input.workflows?.[index] ?? 'reservation_new',
        risk: input.risks?.[index] ?? 'none',
        confidence: 'high',
        attention: 'routine',
      };
    }),
  };
}

function requireReconciled(
  snapshot: PrivateThreadCorpusSnapshot,
  input: {
    workflows?: readonly AnalysisWorkflow[];
    risks?: readonly AnalysisRisk[];
  } = {},
): {
  prepared: PreparedPrivateAnalysisV1;
  bundle: AnalystDecisionBundleV1;
  reconciled: ReconciledAnalystDecisionsV1;
} {
  const prepared = requirePrepared(snapshot);
  const bundle = decisionBundle(prepared, input);
  const reconciled = reconcileAnalystDecisionBundle(snapshot, prepared.manifest, bundle);
  if (!reconciled) throw new Error('Expected reconciled synthetic decisions');
  return { prepared, bundle, reconciled };
}

function requireReport(
  snapshot: PrivateThreadCorpusSnapshot,
  reconciled: ReconciledAnalystDecisionsV1,
): CenturionCorpusEvidenceReportV1 {
  const report = buildCenturionCorpusEvidenceReport(snapshot, reconciled);
  if (!report) throw new Error('Expected aggregate evidence report');
  return report;
}

function noCells<T extends EvidenceCategory>(
  partition: EvidencePartition<T>,
): asserts partition is Exclude<EvidencePartition<T>, { state: 'observed' }> {
  expect(partition).not.toHaveProperty('cells');
  expect(partition).not.toHaveProperty('total');
  expect(partition).toHaveProperty('minimumDisplayCount', 5);
}

function expectNoFixtureLeaks(value: unknown): void {
  const output = JSON.stringify(value);
  for (const marker of [
    BODY_MARKER,
    ADDRESS_MARKER,
    HEADER_MARKER,
    PATH_MARKER,
    ARTIFACT_MARKER,
    'synthetic-evidence-item-',
    'uidl-synthetic-evidence',
    'synthetic-evidence-thread',
  ]) {
    expect(output).not.toContain(marker);
  }
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

const ALLOWED_EVIDENCE_IMPORTS = new Set([
  './centurion-thread-corpus-analysis.js',
  '../../scripts/export-thread-corpus.js',
]);

const FORBIDDEN_EVIDENCE_GLOBALS = new Set([
  'AWS',
  'Bedrock',
  'Function',
  'Mastra',
  'WebSocket',
  'XMLHttpRequest',
  'aws',
  'bedrock',
  'console',
  'env',
  'eval',
  'fetch',
  'fs',
  'http',
  'https',
  'mastra',
  'net',
  'pg',
  'process',
  'require',
  'tls',
  'undici',
]);

const FORBIDDEN_EVIDENCE_COMPUTED_CAPABILITIES = new Set([
  ...FORBIDDEN_EVIDENCE_GLOBALS,
  'constructor',
  'import',
]);

const FORBIDDEN_EVIDENCE_ROOTS = new Set(['globalThis', 'global', 'Reflect']);

function literalText(node: ts.Expression): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function sourceBoundaryViolations(source: ts.SourceFile): string[] {
  const violations = collectNodes(source, ts.isImportDeclaration).flatMap((node) =>
    ts.isStringLiteral(node.moduleSpecifier) &&
    !ALLOWED_EVIDENCE_IMPORTS.has(node.moduleSpecifier.text)
      ? [`import:${node.moduleSpecifier.text}`]
      : [],
  );
  for (const identifier of collectNodes(source, ts.isIdentifier)) {
    if (FORBIDDEN_EVIDENCE_ROOTS.has(identifier.text)) {
      violations.push(`root:${identifier.text}`);
    } else if (FORBIDDEN_EVIDENCE_GLOBALS.has(identifier.text)) {
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
      access.argumentExpression === undefined ? null : literalText(access.argumentExpression);
    if (propertyName && FORBIDDEN_EVIDENCE_COMPUTED_CAPABILITIES.has(propertyName)) {
      violations.push(`computed:${propertyName}`);
    }
  }
  return [...new Set(violations)].sort();
}

describe('Centurion aggregate thread corpus evidence', () => {
  it('releases only safe aggregate evidence from five reconciled logical items', () => {
    const snapshot = syntheticSnapshot(repeatedSpecs(5));
    const { reconciled } = requireReconciled(snapshot);
    const report = requireReport(snapshot, reconciled);

    expect(report).toMatchObject({
      schemaVersion: CENTURION_CORPUS_EVIDENCE_VERSION,
      snapshotDigest: reconciled.snapshotDigest,
      asOf: snapshot.context.asOf,
      decisionDenominator: { state: 'observed', count: 5 },
      artifactAvailability: {
        state: 'observed',
        cells: [{ category: 'complete', count: 5 }],
      },
      responseEvidence: {
        itemStates: {
          state: 'observed',
          cells: [{ category: 'smtp_accepted', count: 5 }],
        },
        notMeasured: {
          state: 'not_measured',
          requires: 'causal_reply_or_authoritative_outcome_required',
        },
      },
      workflowMix: {
        state: 'observed',
        cells: [{ category: 'reservation_new', count: 5 }],
      },
      riskCoverage: {
        state: 'observed',
        cells: [{ category: 'none', count: 5 }],
      },
      exclusions: {
        unscopedQuarantineExcluded: {
          state: 'suppressed',
          minimumDisplayCount: 5,
        },
      },
      limitations: [
        'source_integrity_content_hash_only',
        'smtp_accepted_not_causal_response',
        'offline_analysis_not_live_triage_impact',
      ],
    });
    expect(report.responseEvidence).not.toHaveProperty('outcome');
    expect(report.responseEvidence).not.toHaveProperty('causalResponse');
    expectNoFixtureLeaks(report);
  });

  it('uses item-level artifact states rather than source-row manifest availability', () => {
    const snapshot = syntheticSnapshot(
      repeatedSpecs(5, {
        rows: [
          { artifactState: 'available', responseState: 'not_claimed' },
          { artifactState: 'missing', responseState: 'not_claimed' },
        ],
      }),
    );
    const { reconciled } = requireReconciled(snapshot);
    const report = requireReport(snapshot, reconciled);

    expect(snapshot.manifest.counts.rawMimeAvailable).toBe(5);
    expect(snapshot.manifest.counts.rawMimeUnavailable).toBe(5);
    expect(report.artifactAvailability).toEqual({
      state: 'observed',
      cells: [{ category: 'partial', count: 5 }],
    });
  });

  it('keeps four response evidence states mutually exclusive and stable-sorted', () => {
    const specs: SyntheticItem[] = [
      ...repeatedSpecs(5, {
        rows: [{ artifactState: 'available', responseState: 'smtp_accepted' }],
      }),
      ...repeatedSpecs(5, {
        rows: [{ artifactState: 'available', responseState: 'not_claimed' }],
      }),
      ...repeatedSpecs(5, {
        rows: [{ withoutPrivateMessage: true }],
      }),
      ...repeatedSpecs(5, {
        unitType: 'quarantine',
        rows: [{ artifactState: 'missing', responseState: 'not_claimed' }],
      }),
    ];
    const snapshot = syntheticSnapshot(specs);
    const { reconciled } = requireReconciled(snapshot);
    const report = requireReport(snapshot, reconciled);

    expect(report.decisionDenominator).toEqual({ state: 'observed', count: 20 });
    expect(report.responseEvidence.itemStates).toEqual({
      state: 'observed',
      cells: [
        { category: 'not_applicable', count: 5 },
        { category: 'not_claimed', count: 5 },
        { category: 'smtp_accepted', count: 5 },
        { category: 'unknown', count: 5 },
      ],
    });
    expect(report.responseEvidence.notMeasured).toEqual({
      state: 'not_measured',
      requires: 'causal_reply_or_authoritative_outcome_required',
    });
  });

  it('rejects V2 and reconciled inputs that no longer bind one complete logical union', () => {
    const snapshot = syntheticSnapshot(repeatedSpecs(5));
    const { bundle, prepared, reconciled } = requireReconciled(snapshot);
    const firstItem = reconciled.items[0]!;
    const firstDecision = reconciled.decisions[0]!;
    const stalePrepared = preparePrivateAnalysis(snapshot, {
      maxPacketBytes: 0,
      maxTotalPacketBytes: 1_000_000,
    });
    if (!stalePrepared) throw new Error('Expected stale synthetic preparation');
    expect(stalePrepared.manifestSha256).not.toBe(prepared.manifestSha256);

    expect(
      buildCenturionCorpusEvidenceReport(snapshot, {
        ...reconciled,
        items: reconciled.items.slice(1),
      }),
    ).toBeNull();
    expect(
      buildCenturionCorpusEvidenceReport(snapshot, {
        ...reconciled,
        items: [...reconciled.items.slice(0, -1), firstItem],
        decisions: [...reconciled.decisions.slice(0, -1), firstDecision],
      }),
    ).toBeNull();
    expect(
      buildCenturionCorpusEvidenceReport(snapshot, {
        ...reconciled,
        decisions: reconciled.decisions.slice(1),
      }),
    ).toBeNull();
    expect(
      buildCenturionCorpusEvidenceReport(snapshot, {
        ...reconciled,
        preparedManifestSha256: '0'.repeat(64),
      }),
    ).toBeNull();
    expect(
      buildCenturionCorpusEvidenceReport(snapshot, {
        ...reconciled,
        preparedManifestSha256: stalePrepared.manifestSha256,
      }),
    ).toBeNull();
    expect(
      reconcileAnalystDecisionBundle(snapshot, prepared.manifest, {
        ...bundle,
        preparedManifestSha256: '0'.repeat(64),
      }),
    ).toBeNull();
  });

  it('suppresses every partition when a category could expose a 1-4 complement', () => {
    const snapshot = syntheticSnapshot(repeatedSpecs(5));
    const { reconciled } = requireReconciled(snapshot, {
      workflows: [
        'reservation_new',
        'reservation_new',
        'reservation_new',
        'reservation_new',
        'payment',
      ],
      risks: ['none', 'none', 'none', 'none', 'payment'],
    });
    const report = requireReport(snapshot, reconciled);

    expect(report.decisionDenominator).toEqual({ state: 'observed', count: 5 });
    expect(report.workflowMix).toEqual({ state: 'suppressed', minimumDisplayCount: 5 });
    expect(report.riskCoverage).toEqual({ state: 'suppressed', minimumDisplayCount: 5 });
    noCells(report.workflowMix);
    noCells(report.riskCoverage);
  });

  it('uses insufficient-sample states below five without serializing numeric cells', () => {
    for (let count = 0; count < 5; count += 1) {
      const snapshot = syntheticSnapshot(repeatedSpecs(count), 5);
      const { reconciled } = requireReconciled(snapshot);
      const report = requireReport(snapshot, reconciled);

      expect(report.decisionDenominator).toEqual({
        state: 'insufficient_sample',
        minimumDisplayCount: 5,
      });
      expect(report.artifactAvailability).toEqual({
        state: 'insufficient_sample',
        minimumDisplayCount: 5,
      });
      expect(report.responseEvidence.itemStates).toEqual({
        state: 'insufficient_sample',
        minimumDisplayCount: 5,
      });
      expect(report.workflowMix).toEqual({
        state: 'insufficient_sample',
        minimumDisplayCount: 5,
      });
      expect(report.riskCoverage).toEqual({
        state: 'insufficient_sample',
        minimumDisplayCount: 5,
      });
      expect(report.exclusions.unscopedQuarantineExcluded).toEqual({
        state: 'insufficient_sample',
        minimumDisplayCount: 5,
      });
      noCells(report.artifactAvailability);
      noCells(report.responseEvidence.itemStates);
      noCells(report.workflowMix);
      noCells(report.riskCoverage);
      expect(JSON.stringify(report)).not.toMatch(/"count":(?:0|[1-4])(?:[},])/);
    }
  });

  it('enforces threshold and complement suppression for every small categorical split', () => {
    for (let denominator = 0; denominator <= 10; denominator += 1) {
      for (let firstCategory = 0; firstCategory <= denominator; firstCategory += 1) {
        const workflows: AnalysisWorkflow[] = [
          ...Array.from({ length: firstCategory }, () => 'reservation_new' as const),
          ...Array.from(
            { length: denominator - firstCategory },
            () => 'reservation_change' as const,
          ),
        ];
        const snapshot = syntheticSnapshot(repeatedSpecs(denominator));
        const { reconciled } = requireReconciled(snapshot, { workflows });
        const report = requireReport(snapshot, reconciled);
        const partition = report.workflowMix;

        if (denominator < 5) {
          expect(partition).toEqual({
            state: 'insufficient_sample',
            minimumDisplayCount: 5,
          });
          noCells(partition);
          continue;
        }

        const secondCategory = denominator - firstCategory;
        const hasUnsafePositiveCell =
          (firstCategory > 0 && firstCategory < 5) || (secondCategory > 0 && secondCategory < 5);
        if (hasUnsafePositiveCell) {
          expect(partition).toEqual({
            state: 'suppressed',
            minimumDisplayCount: 5,
          });
          noCells(partition);
          continue;
        }

        expect(partition.state).toBe('observed');
        if (partition.state !== 'observed') throw new Error('Expected observed partition');
        expect(partition.cells).toEqual(
          [
            firstCategory > 0 ? { category: 'reservation_new', count: firstCategory } : null,
            secondCategory > 0 ? { category: 'reservation_change', count: secondCategory } : null,
          ]
            .filter(
              (
                value,
              ): value is {
                category: 'reservation_new' | 'reservation_change';
                count: number;
              } => value !== null,
            )
            .sort((left, right) =>
              left.category === right.category ? 0 : left.category < right.category ? -1 : 1,
            ),
        );
        expect(partition.cells.every((cell) => cell.count >= 5)).toBe(true);
        expect(partition.cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(denominator);
      }
    }
  });

  it('does not serialize zero counts, private identifiers, raw hashes, or fixture content', () => {
    const snapshot = syntheticSnapshot(repeatedSpecs(5), 5);
    const { reconciled } = requireReconciled(snapshot);
    const report = requireReport(snapshot, reconciled);
    const output = JSON.stringify(report);

    expect(report.exclusions.unscopedQuarantineExcluded).toEqual({
      state: 'observed',
      count: 5,
    });
    expect(output).not.toContain('"analysisItemId"');
    expect(output).not.toContain('"sourceRowId"');
    expect(output).not.toContain('"preparedManifestSha256"');
    expect(output).not.toContain('"packetSha256"');
    expect(output).not.toContain('"count":0');
    expect(output.match(/[a-f0-9]{64}/g)).toEqual([report.snapshotDigest]);
    expectNoFixtureLeaks(report);
  });

  it('keeps evidence source free of runtime and dynamic-execution capabilities', () => {
    const sourcePath = fileURLToPath(
      new URL('../src/ops/centurion-thread-corpus-evidence.ts', import.meta.url),
    );
    const source = parseTypeScript(sourcePath);
    const imports = collectNodes(source, ts.isImportDeclaration).flatMap((node) =>
      ts.isStringLiteral(node.moduleSpecifier) ? [node.moduleSpecifier.text] : [],
    );
    expect(imports).toEqual([
      './centurion-thread-corpus-analysis.js',
      '../../scripts/export-thread-corpus.js',
    ]);

    const forbiddenFixture = ts.createSourceFile(
      'synthetic-forbidden-evidence.ts',
      [
        "import { readFileSync } from 'node:fs';",
        "import { request } from 'node:https';",
        "import { Client } from 'pg';",
        'void process.env;',
        'void fetch;',
        'void WebSocket;',
        'void XMLHttpRequest;',
        'void eval;',
        'void Function;',
        'void console;',
        'void globalThis;',
        "void globalThis['fetch'];",
        "void globalThis['process']['env'];",
        "void ({})['constructor'];",
        'void ({}).constructor;',
        'void import("synthetic-module");',
        'void aws;',
        'void AWS;',
        'void Bedrock;',
        'void Mastra;',
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(sourceBoundaryViolations(forbiddenFixture)).toEqual(
      expect.arrayContaining([
        'constructor',
        'dynamic-import',
        'global:AWS',
        'global:Bedrock',
        'global:Function',
        'global:Mastra',
        'global:WebSocket',
        'global:XMLHttpRequest',
        'global:aws',
        'global:console',
        'global:eval',
        'global:fetch',
        'global:process',
        'import:node:fs',
        'import:node:https',
        'import:pg',
        'computed:constructor',
        'computed:env',
        'computed:fetch',
        'computed:process',
        'root:globalThis',
      ]),
    );
    expect(sourceBoundaryViolations(source)).toEqual([]);
  });
});
