import {
  buildCenturionThreadCorpusReadinessAttestation,
  evaluateCenturionThreadCorpusReadiness,
  type CenturionThreadCorpusReadinessReport,
  type ReadinessAttestationBindingInputV1,
} from '../src/ops/centurion-thread-corpus-readiness.js';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const CHECK_NAMES = [
  'exactEc2RevisionWorktree',
  'imdsV2Identity',
  'protectedConfig',
  'designatedMailboxScope',
  'regionBucketPrefixAllowlist',
  'readOnlyDbS3KmsCapabilities',
  'sourceDiskHeadroom',
  'privateDestinationIgnored',
  'windowsLocalAclTarget',
  'v2Semantics',
] as const;

const SENSITIVE_MARKERS = [
  'SYNTHETIC_ADDRESS_MARKER',
  'SYNTHETIC_PATH_MARKER',
  'SYNTHETIC_ERROR_MARKER',
  'SYNTHETIC_BODY_MARKER',
] as const;

function validConfig(): Record<string, unknown> {
  return {
    version: 'centurion-thread-corpus-readiness-config-v1',
    expectedEc2: {
      instanceId: 'i-synthetic-instance',
      revision: 'synthetic-revision',
      worktree: 'synthetic-worktree',
    },
    designatedSourceScope: {
      centurionTransportId: 'synthetic-centurion-transport-id',
      designatedTransportId: 'synthetic-designated-transport-id',
      mailboxIds: ['synthetic-mailbox-id'],
      addresses: ['synthetic@example.invalid'],
    },
    approvedExportTarget: {
      region: 'synthetic-region',
      bucket: 'synthetic-bucket',
      prefix: 'synthetic-prefix',
    },
    minimumSourceDiskHeadroomBytes: 4096,
    corpusContractId: 'centurion-thread-corpus-v2',
    privateDestination: {
      localTarget: 'C:\\synthetic-private-target',
    },
    readOnlyCapabilityProbe: {
      policySourceArn: 'arn:aws:iam::123456789012:role/synthetic-readonly-role',
      kmsKeyId: 'synthetic-kms-key',
      dbInstanceArn: 'arn:aws:rds:synthetic-region-1:123456789012:db:synthetic-source-db',
    },
  };
}

function allPassingObservations(): Record<string, boolean> {
  return {
    exactEc2RevisionWorktree: true,
    imdsV2Identity: true,
    protectedConfig: true,
    designatedMailboxScope: true,
    regionBucketPrefixAllowlist: true,
    readOnlyDbS3KmsCapabilities: true,
    sourceDiskHeadroom: true,
    privateDestinationIgnored: true,
    windowsLocalAclTarget: true,
    v2Semantics: true,
  };
}

function attestationBinding(
  overrides: Partial<ReadinessAttestationBindingInputV1> = {},
): ReadinessAttestationBindingInputV1 {
  return {
    corpusContractId: 'centurion-thread-corpus-v2',
    expectedInstanceId: 'i-synthetic-instance',
    expectedRevision: 'synthetic-revision',
    expectedWorktree: 'synthetic-worktree',
    designatedSourceScope: {
      centurionTransportId: 'synthetic-centurion-transport-id',
      designatedTransportId: 'synthetic-designated-transport-id',
      mailboxIds: ['synthetic-mailbox-b', 'synthetic-mailbox-a'],
      addresses: [' SECOND@EXAMPLE.INVALID ', 'First@example.invalid'],
    },
    ...overrides,
  };
}

function fixedChecks(value: boolean): Record<(typeof CHECK_NAMES)[number], boolean> {
  return Object.fromEntries(CHECK_NAMES.map((check) => [check, value])) as Record<
    (typeof CHECK_NAMES)[number],
    boolean
  >;
}

function expectFixedShape(report: CenturionThreadCorpusReadinessReport): void {
  expect(Object.keys(report).sort()).toEqual([
    'checks',
    'code',
    'outcome',
    'ready',
    'schemaVersion',
  ]);
  expect(Object.keys(report.checks).sort()).toEqual([...CHECK_NAMES].sort());
  expect(Object.values(report.checks).every((value) => typeof value === 'boolean')).toBe(true);
}

function expectBlocked(report: CenturionThreadCorpusReadinessReport): void {
  expect(report).toEqual({
    schemaVersion: 'centurion-thread-corpus-readiness-report-v1',
    outcome: 'blocked',
    code: 'CENTURION_THREAD_CORPUS_BLOCKED',
    ready: false,
    checks: fixedChecks(false),
  });
}

describe('evaluateCenturionThreadCorpusReadiness', () => {
  it('returns ready only for a valid V1 private config and all passing gates', () => {
    const report = evaluateCenturionThreadCorpusReadiness(validConfig(), allPassingObservations());

    expect(report).toEqual({
      schemaVersion: 'centurion-thread-corpus-readiness-report-v1',
      outcome: 'ready',
      code: 'CENTURION_THREAD_CORPUS_READY',
      ready: true,
      checks: fixedChecks(true),
    });
    expectFixedShape(report);
  });

  it('requires an exact source DB instance ARN', () => {
    const missing = validConfig();
    delete (missing.readOnlyCapabilityProbe as Record<string, unknown>).dbInstanceArn;
    expectBlocked(evaluateCenturionThreadCorpusReadiness(missing, allPassingObservations()));

    const wildcard = validConfig();
    (wildcard.readOnlyCapabilityProbe as Record<string, unknown>).dbInstanceArn =
      'arn:aws:rds:synthetic-region-1:123456789012:db:*';
    expectBlocked(evaluateCenturionThreadCorpusReadiness(wildcard, allPassingObservations()));

    const report = evaluateCenturionThreadCorpusReadiness(validConfig(), allPassingObservations());
    expect(report.outcome).toBe('ready');
  });

  it('builds a PII-free canonical attestation only from an all-green strict report', () => {
    const ready = evaluateCenturionThreadCorpusReadiness(validConfig(), allPassingObservations());
    const blocked = evaluateCenturionThreadCorpusReadiness(validConfig(), {
      ...allPassingObservations(),
      imdsV2Identity: false,
    });

    expect(
      buildCenturionThreadCorpusReadinessAttestation(blocked, attestationBinding()),
    ).toBeNull();

    const attestation = buildCenturionThreadCorpusReadinessAttestation(ready, attestationBinding());
    const reordered = buildCenturionThreadCorpusReadinessAttestation(
      ready,
      attestationBinding({
        designatedSourceScope: {
          centurionTransportId: 'synthetic-centurion-transport-id',
          designatedTransportId: 'synthetic-designated-transport-id',
          mailboxIds: ['synthetic-mailbox-a', 'synthetic-mailbox-b'],
          addresses: ['first@EXAMPLE.invalid', 'second@example.invalid'],
        },
      }),
    );

    expect(attestation).toEqual({
      schemaVersion: 'centurion-thread-corpus-readiness-attestation-v1',
      corpusContractId: 'centurion-thread-corpus-v2',
      readinessReportVersion: 'centurion-thread-corpus-readiness-report-v1',
      bindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(reordered).toEqual(attestation);

    const serialized = JSON.stringify(attestation);
    for (const marker of SENSITIVE_MARKERS) {
      expect(serialized).not.toContain(marker);
    }
    expect(serialized).not.toContain('synthetic-mailbox-a');
    expect(serialized).not.toContain('first@example.invalid');
  });

  it('blocks on one failed gate while preserving fixed report shape', () => {
    const observations = allPassingObservations();
    observations.sourceDiskHeadroom = false;

    const report = evaluateCenturionThreadCorpusReadiness(validConfig(), observations);

    expect(report).toEqual({
      schemaVersion: 'centurion-thread-corpus-readiness-report-v1',
      outcome: 'blocked',
      code: 'CENTURION_THREAD_CORPUS_BLOCKED',
      ready: false,
      checks: {
        ...fixedChecks(true),
        sourceDiskHeadroom: false,
      },
    });
    expectFixedShape(report);
  });

  it.each([
    {
      name: 'unknown top-level config field',
      config: {
        ...validConfig(),
        unexpected: SENSITIVE_MARKERS[2],
      },
    },
    {
      name: 'unknown nested config field',
      config: {
        ...validConfig(),
        expectedEc2: {
          revision: 'synthetic-revision',
          worktree: 'synthetic-worktree',
          unexpected: SENSITIVE_MARKERS[2],
        },
      },
    },
    {
      name: 'empty designated mailbox scope',
      config: {
        ...validConfig(),
        designatedSourceScope: {
          centurionTransportId: 'synthetic-centurion-transport-id',
          designatedTransportId: 'synthetic-designated-transport-id',
          mailboxIds: [],
          addresses: ['synthetic@example.invalid'],
        },
      },
    },
    {
      name: 'empty designated address scope',
      config: {
        ...validConfig(),
        designatedSourceScope: {
          centurionTransportId: 'synthetic-centurion-transport-id',
          designatedTransportId: 'synthetic-designated-transport-id',
          mailboxIds: ['synthetic-mailbox-id'],
          addresses: [],
        },
      },
    },
    {
      name: 'empty Centurion transport selector',
      config: {
        ...validConfig(),
        designatedSourceScope: {
          centurionTransportId: '',
          designatedTransportId: 'synthetic-designated-transport-id',
          mailboxIds: ['synthetic-mailbox-id'],
          addresses: ['synthetic@example.invalid'],
        },
      },
    },
    {
      name: 'empty designated transport selector',
      config: {
        ...validConfig(),
        designatedSourceScope: {
          centurionTransportId: 'synthetic-centurion-transport-id',
          designatedTransportId: '',
          mailboxIds: ['synthetic-mailbox-id'],
          addresses: ['synthetic@example.invalid'],
        },
      },
    },
  ])('fails closed for $name', ({ config }) => {
    const report = evaluateCenturionThreadCorpusReadiness(config, allPassingObservations());

    expectBlocked(report);
    expect(JSON.stringify(report)).not.toContain(SENSITIVE_MARKERS[2]);
  });

  it('fails closed for a wrong V2 contract identifier', () => {
    const report = evaluateCenturionThreadCorpusReadiness(
      {
        ...validConfig(),
        corpusContractId: 'centurion-thread-corpus-v1',
      },
      allPassingObservations(),
    );

    expectBlocked(report);
  });

  it.each([
    {
      name: 'missing required observation',
      observations: (() => {
        const value: Record<string, unknown> = allPassingObservations();
        delete value.imdsV2Identity;
        return value;
      })(),
    },
    {
      name: 'non-boolean observation',
      observations: {
        ...allPassingObservations(),
        protectedConfig: 'yes',
      },
    },
    {
      name: 'unknown observation',
      observations: {
        ...allPassingObservations(),
        unexpected: true,
      },
    },
  ])('fails closed for $name', ({ observations }) => {
    expectBlocked(evaluateCenturionThreadCorpusReadiness(validConfig(), observations));
  });

  it('never serializes synthetic config or raw-error markers', () => {
    const config = validConfig();
    config.expectedEc2 = {
      revision: SENSITIVE_MARKERS[3],
      worktree: SENSITIVE_MARKERS[1],
    };
    config.designatedSourceScope = {
      centurionTransportId: 'synthetic-centurion-transport-id',
      designatedTransportId: 'synthetic-designated-transport-id',
      mailboxIds: ['synthetic-mailbox-id'],
      addresses: [SENSITIVE_MARKERS[0]],
    };
    config.approvedExportTarget = {
      region: 'synthetic-region',
      bucket: SENSITIVE_MARKERS[2],
      prefix: 'synthetic-prefix',
    };

    const report = evaluateCenturionThreadCorpusReadiness(config, allPassingObservations());
    const serialized = JSON.stringify(report);

    for (const marker of SENSITIVE_MARKERS) {
      expect(serialized).not.toContain(marker);
    }
    expectFixedShape(report);
  });
});

function sourceBoundaryViolations(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(
    'centurion-thread-corpus-readiness.ts',
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const violations: string[] = [];
  const prohibitedIdentifiers = new Set([
    'Bun',
    'Deno',
    'console',
    'eval',
    'fetch',
    'Function',
    'global',
    'globalThis',
    'process',
    'require',
  ]);

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text !== 'zod' &&
      node.moduleSpecifier.text !== 'node:crypto'
    ) {
      violations.push(`Unexpected import: ${node.moduleSpecifier.text}`);
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'node:crypto' &&
      (!node.importClause?.namedBindings ||
        !ts.isNamedImports(node.importClause.namedBindings) ||
        node.importClause.namedBindings.elements.length !== 1 ||
        node.importClause.namedBindings.elements[0]?.name.text !== 'createHash')
    ) {
      violations.push('Unexpected crypto capability');
    }
    if (ts.isImportEqualsDeclaration(node)) {
      violations.push('Import equals is prohibited');
    }
    if (ts.isIdentifier(node) && prohibitedIdentifiers.has(node.text)) {
      violations.push(`Prohibited capability: ${node.text}`);
    }
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === 'constructor') ||
      (ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === 'constructor')
    ) {
      violations.push('Constructor-based execution is prohibited');
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      violations.push('Dynamic import is prohibited');
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

describe('centurion thread corpus readiness source boundary', () => {
  it('has no direct runtime, filesystem, network, cloud, database, mailbox, AI, UI, or logging capability', () => {
    const sourcePath = fileURLToPath(
      new URL('../src/ops/centurion-thread-corpus-readiness.ts', import.meta.url),
    );

    expect(sourceBoundaryViolations(readFileSync(sourcePath, 'utf8'))).toEqual([]);
  });

  it.each([
    "eval('process.env');",
    "Function('return globalThis')();",
    "new Function('return process')();",
    "({}).constructor.constructor('return globalThis')();",
  ])('rejects indirect runtime execution: %s', (fixture) => {
    expect(sourceBoundaryViolations(fixture)).not.toEqual([]);
  });
});
