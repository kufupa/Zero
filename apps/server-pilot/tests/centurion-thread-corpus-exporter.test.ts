import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  createCenturionThreadCorpusExporter,
  type ClosableThreadCorpusReader,
  type ThreadCorpusExportDependencies,
  type ThreadCorpusExportRequest,
} from '../src/ops/centurion-thread-corpus-exporter.js';
import type {
  FormattedLogicalMessages,
  ThreadCorpusAttachmentLocator,
  ThreadCorpusHydrationInput,
  ThreadCorpusMessageRow,
  ThreadCorpusSnapshotLoadResult,
  ThreadCorpusSnapshotReadSession,
  ThreadCorpusSnapshotSafeSummary,
} from '../src/ops/centurion-thread-corpus-snapshot.js';

const AS_OF = '2026-08-22T12:00:00.000Z';
const PRIVATE_ADDRESS_MARKER = 'TASK9_PRIVATE_ADDRESS_MARKER';
const PRIVATE_BODY_MARKER = 'TASK9_PRIVATE_BODY_MARKER';
const PRIVATE_LOCATOR_MARKER = 'TASK9_PRIVATE_LOCATOR_MARKER';
const PRIVATE_RESULT_MARKER = 'TASK9_PRIVATE_RESULT_MARKER';

type HydrationArgument = Parameters<
  NonNullable<ThreadCorpusExportDependencies['hydrate']>
>[0];
type PublisherArgument = Parameters<
  NonNullable<ThreadCorpusExportDependencies['publish']>
>[0];

function makeRequest(input: {
  source?: Partial<ThreadCorpusExportRequest['source']>;
  hydration?: ThreadCorpusExportRequest['hydration'];
} = {}): ThreadCorpusExportRequest {
  const source: ThreadCorpusExportRequest['source'] = {
    centurionTransportId: 'transport-z',
    designatedTransportId: 'transport-a',
    designatedIngestMailboxIds: ['ingest-designated'],
    designatedAddresses: [PRIVATE_ADDRESS_MARKER],
    ...input.source,
  };

  return {
    repoRoot: '/synthetic/repo',
    outDir: '.private/corpus',
    snapshotId: 'task9-synthetic-snapshot',
    exporterVersion: 'task9-test',
    source,
    hydration:
      input.hydration ??
      ({
        storage: {},
      } as ThreadCorpusExportRequest['hydration']),
  };
}

function makeFormatted(): FormattedLogicalMessages {
  return {
    threads: [
      {
        kind: 'resolved',
        threadId: 'thread-synthetic',
        messages: [
          {
            normalizedMessageId: '<synthetic@example.test>',
            sourceRows: [
              {
                sourceRowId: 'source-synthetic',
                scopeMembership: ['centurion_transport'],
                receivedAt: '2026-08-22T11:00:00.000Z',
                threadId: 'thread-synthetic',
                body: PRIVATE_BODY_MARKER,
                privateMessage: {
                  subject: PRIVATE_BODY_MARKER,
                  addresses: {
                    from: [PRIVATE_ADDRESS_MARKER],
                    to: [],
                    cc: [],
                    bcc: [],
                  },
                  rawMime: {
                    locator: PRIVATE_LOCATOR_MARKER,
                    status: 'pending_hydration',
                  },
                },
              },
            ],
            scopeMembership: ['centurion_transport'],
            annotations: [],
            threadId: 'thread-synthetic',
            quarantined: false,
          },
        ],
      },
    ],
    quarantineRecords: [],
  } as unknown as FormattedLogicalMessages;
}

function makeUnscopedQuarantineRows(): ThreadCorpusMessageRow[] {
  return [
    {
      id: 'unscoped-synthetic',
      body: PRIVATE_BODY_MARKER,
      from: [PRIVATE_ADDRESS_MARKER],
      rawMime: {
        locator: PRIVATE_LOCATOR_MARKER,
        status: 'pending_hydration',
      },
    },
  ] as unknown as ThreadCorpusMessageRow[];
}

function makeLoadedResult(input: {
  asOf?: string;
  safeSummary?: Partial<ThreadCorpusSnapshotSafeSummary>;
  unscopedQuarantineRows?: ThreadCorpusMessageRow[];
} = {}): ThreadCorpusSnapshotLoadResult {
  const asOf = input.asOf ?? AS_OF;
  const unscopedQuarantineRows =
    input.unscopedQuarantineRows ?? makeUnscopedQuarantineRows();
  const attachmentLocators: ThreadCorpusAttachmentLocator[] = [
    {
      attachmentId: 'attachment-synthetic',
      messageId: 'source-synthetic',
      s3Key: PRIVATE_LOCATOR_MARKER,
      mimeType: 'text/plain',
      sizeBytes: 1,
    },
  ];

  return {
    asOf,
    formatted: makeFormatted(),
    attachmentLocators,
    unscopedQuarantineRows,
    safeSummary: {
      asOf,
      includedMessageCount: 1,
      sourceRowCount: 1,
      threadCount: 1,
      quarantineRecordCount: 0,
      unscopedQuarantineCount: unscopedQuarantineRows.length,
      ...input.safeSummary,
    },
  };
}

function makeHydration(): ThreadCorpusHydrationInput {
  return {
    attachmentLocators: [],
    payloads: [],
  };
}

function makeReader(close: () => Promise<void>): ClosableThreadCorpusReader {
  return {
    async withRepeatableReadOnly<T>(
      _load: (session: ThreadCorpusSnapshotReadSession) => Promise<T>,
    ): Promise<T> {
      throw new Error('Unexpected default loader call');
    },
    close,
  };
}

function makeDefaultLoaderReader(events: string[]): ClosableThreadCorpusReader {
  const session: ThreadCorpusSnapshotReadSession = {
    asOf: AS_OF,
    async discoverSourceScopes() {
      return [
        { kind: 'transport', id: 'transport-z', active: true },
        { kind: 'transport', id: 'transport-a', active: true },
        { kind: 'ingest_mailbox', id: 'ingest-designated', active: true },
      ];
    },
    async readMessages() {
      return [];
    },
    async readAttachmentDescriptors() {
      return [];
    },
    async readDraftRevisionLinks() {
      return [];
    },
    async readOutboundQueueDeliveryStates() {
      return [];
    },
    async readQuarantineRows() {
      return [];
    },
  };

  return {
    async withRepeatableReadOnly<T>(
      load: (value: ThreadCorpusSnapshotReadSession) => Promise<T>,
    ): Promise<T> {
      events.push('load');
      return await load(session);
    },
    async close() {
      events.push('close');
    },
  };
}

describe('createCenturionThreadCorpusExporter', () => {
  it('uses the default loader then closes before injected hydration and publication', async () => {
    const events: string[] = [];
    let hydrationInput: HydrationArgument | undefined;
    let publication: PublisherArgument | undefined;
    const exporter = createCenturionThreadCorpusExporter({
      createReader: () => makeDefaultLoaderReader(events),
      hydrate: async (input) => {
        events.push('hydrate');
        hydrationInput = input;
        return makeHydration();
      },
      publish: async (args) => {
        events.push('publish');
        publication = args;
        return { outDir: '/private/allocated/default-loader' };
      },
    });

    const result = await exporter(makeRequest());

    expect(events).toEqual(['load', 'close', 'hydrate', 'publish']);
    expect(hydrationInput?.formatted).toEqual({
      threads: [],
      quarantineRecords: [],
    });
    expect(hydrationInput?.attachmentLocators).toEqual([]);
    expect(publication?.context.asOf).toBe(AS_OF);
    expect(result).toEqual({
      outDir: '/private/allocated/default-loader',
      summary: {
        asOf: AS_OF,
        includedMessageCount: 0,
        sourceRowCount: 0,
        threadCount: 0,
        quarantineRecordCount: 0,
        unscopedQuarantineCount: 0,
      },
    });
  });

  it('derives sealed context only from safe and loaded fields', async () => {
    const loaded = makeLoadedResult();
    let publication: PublisherArgument | undefined;
    const exporter = createCenturionThreadCorpusExporter({
      createReader: () => makeReader(async () => undefined),
      load: async () => loaded,
      hydrate: async () => makeHydration(),
      publish: async (args) => {
        publication = args;
        return { outDir: '/private/allocated/context' };
      },
    });

    await exporter(makeRequest());

    expect(publication?.context).toEqual({
      snapshotId: 'task9-synthetic-snapshot',
      scope: {
        scopeKeys: [
          'centurion_transport',
          'designated_reservationist_mailbox',
        ],
        transportIds: ['transport-a', 'transport-z'],
        participantAddressRef: 'private_designated_reservationist_address',
        messagePredicate:
          'selected_transports_or_private_designated_address_before_as_of',
        quarantinePredicate:
          'selected_ingest_mailbox_or_owner_header_before_as_of',
      },
      asOf: AS_OF,
      exporterVersion: 'task9-test',
      unscopedQuarantineExcluded: 1,
    });
    const contextText = JSON.stringify(publication?.context);
    for (const marker of [
      PRIVATE_ADDRESS_MARKER,
      PRIVATE_BODY_MARKER,
      PRIVATE_LOCATOR_MARKER,
    ]) {
      expect(contextText).not.toContain(marker);
    }

    let withoutAddressPublication: PublisherArgument | undefined;
    const withoutAddress = createCenturionThreadCorpusExporter({
      createReader: () => makeReader(async () => undefined),
      load: async () => makeLoadedResult(),
      hydrate: async () => makeHydration(),
      publish: async (args) => {
        withoutAddressPublication = args;
        return { outDir: '/private/allocated/no-address' };
      },
    });
    await withoutAddress(
      makeRequest({
        source: { designatedAddresses: [] },
      }),
    );
    expect(
      withoutAddressPublication?.context.scope.participantAddressRef,
    ).toBeNull();
  });

  it('returns only allocated outDir and a fresh exact safe summary', async () => {
    const loaded = makeLoadedResult();
    const exporter = createCenturionThreadCorpusExporter({
      createReader: () => makeReader(async () => undefined),
      load: async () => loaded,
      hydrate: async () => makeHydration(),
      publish: async () =>
        ({
          outDir: '/private/allocated/summary',
          privateMarker: PRIVATE_RESULT_MARKER,
        }) as unknown as { outDir: string },
    });

    const result = await exporter(makeRequest());

    expect(Object.keys(result)).toEqual(['outDir', 'summary']);
    expect(result.outDir).toBe('/private/allocated/summary');
    expect(result.summary).toEqual(loaded.safeSummary);
    expect(result.summary).not.toBe(loaded.safeSummary);
    expect(Object.keys(result.summary).sort()).toEqual([
      'asOf',
      'includedMessageCount',
      'quarantineRecordCount',
      'sourceRowCount',
      'threadCount',
      'unscopedQuarantineCount',
    ]);
    const resultText = JSON.stringify(result);
    for (const marker of [
      PRIVATE_ADDRESS_MARKER,
      PRIVATE_BODY_MARKER,
      PRIVATE_LOCATOR_MARKER,
      PRIVATE_RESULT_MARKER,
    ]) {
      expect(resultText).not.toContain(marker);
    }
  });

  it('creates and closes a fresh reader for each export', async () => {
    const readers: ClosableThreadCorpusReader[] = [];
    const closeCounts: number[] = [];
    const exporter = createCenturionThreadCorpusExporter({
      createReader: () => {
        const index = closeCounts.length;
        closeCounts.push(0);
        const reader = makeReader(async () => {
          closeCounts[index] += 1;
        });
        readers.push(reader);
        return reader;
      },
      load: async () => makeLoadedResult(),
      hydrate: async () => makeHydration(),
      publish: async () => ({ outDir: '/private/allocated/fresh' }),
    });

    await exporter(makeRequest());
    await exporter(makeRequest());

    expect(readers).toHaveLength(2);
    expect(readers[0]).not.toBe(readers[1]);
    expect(closeCounts).toEqual([1, 1]);
  });

  it('closes once after a load failure and blocks hydration and publication', async () => {
    const loadFailure = new Error('SYNTHETIC_LOAD_FAILURE');
    let closeCount = 0;
    let hydrateCount = 0;
    let publishCount = 0;
    const exporter = createCenturionThreadCorpusExporter({
      createReader: () =>
        makeReader(async () => {
          closeCount += 1;
        }),
      load: async () => {
        throw loadFailure;
      },
      hydrate: async () => {
        hydrateCount += 1;
        return makeHydration();
      },
      publish: async () => {
        publishCount += 1;
        return { outDir: '/private/unreachable' };
      },
    });

    await expect(exporter(makeRequest())).rejects.toBe(loadFailure);
    expect(closeCount).toBe(1);
    expect(hydrateCount).toBe(0);
    expect(publishCount).toBe(0);
  });

  it('stops on a successful load followed by a close failure', async () => {
    const closeFailure = new Error('SYNTHETIC_CLOSE_FAILURE');
    let hydrateCount = 0;
    let publishCount = 0;
    const exporter = createCenturionThreadCorpusExporter({
      createReader: () =>
        makeReader(async () => {
          throw closeFailure;
        }),
      load: async () => makeLoadedResult(),
      hydrate: async () => {
        hydrateCount += 1;
        return makeHydration();
      },
      publish: async () => {
        publishCount += 1;
        return { outDir: '/private/unreachable' };
      },
    });

    await expect(exporter(makeRequest())).rejects.toBe(closeFailure);
    expect(hydrateCount).toBe(0);
    expect(publishCount).toBe(0);
  });

  it('preserves load failure when close also fails', async () => {
    const loadFailure = new Error('SYNTHETIC_LOAD_FAILURE');
    const closeFailure = new Error('SYNTHETIC_CLOSE_FAILURE');
    let closeCount = 0;
    const exporter = createCenturionThreadCorpusExporter({
      createReader: () =>
        makeReader(async () => {
          closeCount += 1;
          throw closeFailure;
        }),
      load: async () => {
        throw loadFailure;
      },
      hydrate: async () => makeHydration(),
      publish: async () => ({ outDir: '/private/unreachable' }),
    });

    await expect(exporter(makeRequest())).rejects.toBe(loadFailure);
    expect(closeCount).toBe(1);
  });

  it('blocks publication when hydration fails after reader closure', async () => {
    const hydrationFailure = new Error('SYNTHETIC_HYDRATION_FAILURE');
    const events: string[] = [];
    let publishCount = 0;
    const exporter = createCenturionThreadCorpusExporter({
      createReader: () =>
        makeReader(async () => {
          events.push('close');
        }),
      load: async () => {
        events.push('load');
        return makeLoadedResult();
      },
      hydrate: async () => {
        events.push('hydrate');
        throw hydrationFailure;
      },
      publish: async () => {
        publishCount += 1;
        return { outDir: '/private/unreachable' };
      },
    });

    await expect(exporter(makeRequest())).rejects.toBe(hydrationFailure);
    expect(events).toEqual(['load', 'close', 'hydrate']);
    expect(publishCount).toBe(0);
  });

  it('preserves publisher failure after reader closure', async () => {
    const publicationFailure = new Error('SYNTHETIC_PUBLICATION_FAILURE');
    const events: string[] = [];
    const exporter = createCenturionThreadCorpusExporter({
      createReader: () =>
        makeReader(async () => {
          events.push('close');
        }),
      load: async () => {
        events.push('load');
        return makeLoadedResult();
      },
      hydrate: async () => {
        events.push('hydrate');
        return makeHydration();
      },
      publish: async () => {
        events.push('publish');
        throw publicationFailure;
      },
    });

    await expect(exporter(makeRequest())).rejects.toBe(publicationFailure);
    expect(events).toEqual(['load', 'close', 'hydrate', 'publish']);
  });

  it('closes once then rejects every incoherent loader summary before hydration', async () => {
    const countKeys: Array<Exclude<keyof ThreadCorpusSnapshotSafeSummary, 'asOf'>> = [
      'includedMessageCount',
      'sourceRowCount',
      'threadCount',
      'quarantineRecordCount',
      'unscopedQuarantineCount',
    ];
    const variants: Array<{
      name: string;
      result: ThreadCorpusSnapshotLoadResult;
    }> = [
      {
        name: 'mismatched asOf',
        result: makeLoadedResult({
          safeSummary: { asOf: '2026-08-22T12:00:01.000Z' },
        }),
      },
      ...countKeys.flatMap((key) =>
        [-1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((value) => ({
          name: `${key} is not a non-negative safe integer`,
          result: makeLoadedResult({
            safeSummary: { [key]: value },
          }),
        })),
      ),
      {
        name: 'unscoped quarantine count differs from rows',
        result: makeLoadedResult({
          safeSummary: { unscopedQuarantineCount: 0 },
        }),
      },
    ];

    for (const variant of variants) {
      let closeCount = 0;
      let hydrateCount = 0;
      let publishCount = 0;
      const exporter = createCenturionThreadCorpusExporter({
        createReader: () =>
          makeReader(async () => {
            closeCount += 1;
          }),
        load: async () => variant.result,
        hydrate: async () => {
          hydrateCount += 1;
          return makeHydration();
        },
        publish: async () => {
          publishCount += 1;
          return { outDir: '/private/unreachable' };
        },
      });

      await expect(exporter(makeRequest()), variant.name).rejects.toThrowError(
        'Invalid thread corpus snapshot result',
      );
      expect(closeCount, variant.name).toBe(1);
      expect(hydrateCount, variant.name).toBe(0);
      expect(publishCount, variant.name).toBe(0);
    }
  });

  it('uses loaded formatted records and attachment locators over runtime-poisoned fields', async () => {
    const loaded = makeLoadedResult();
    const poisonedFormatted = {
      poison: PRIVATE_RESULT_MARKER,
    } as unknown as FormattedLogicalMessages;
    const poisonedAttachmentLocators = [
      {
        attachmentId: 'poisoned',
        messageId: 'poisoned',
        s3Key: PRIVATE_RESULT_MARKER,
        mimeType: 'text/plain',
        sizeBytes: 1,
      },
    ] as ThreadCorpusAttachmentLocator[];
    let hydrationInput: HydrationArgument | undefined;
    const exporter = createCenturionThreadCorpusExporter({
      createReader: () => makeReader(async () => undefined),
      load: async () => loaded,
      hydrate: async (input) => {
        hydrationInput = input;
        return makeHydration();
      },
      publish: async () => ({ outDir: '/private/allocated/loaded-input' }),
    });

    await exporter(
      makeRequest({
        hydration: {
          storage: {},
          formatted: poisonedFormatted,
          attachmentLocators: poisonedAttachmentLocators,
        } as unknown as ThreadCorpusExportRequest['hydration'],
      }),
    );

    expect(hydrationInput).toBeDefined();
    expect(hydrationInput?.formatted).toBe(loaded.formatted);
    expect(hydrationInput?.attachmentLocators).toBe(loaded.attachmentLocators);
    expect(hydrationInput?.formatted).not.toBe(poisonedFormatted);
    expect(hydrationInput?.attachmentLocators).not.toBe(poisonedAttachmentLocators);
  });
});

function exporterSourceGuardViolations(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(
    'centurion-thread-corpus-exporter.ts',
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const violations: string[] = [];
  const consoleAliases = new Set<string>();
  const fetchAliases = new Set<string>();
  const prohibitedIdentifiers = new Set([
    'createThreadCorpusPostgresReader',
    'exec',
    'execFile',
    'execFileSync',
    'getS3Storage',
    'parseArgs',
    'postgres',
    'S3Client',
    'spawn',
    'spawnSync',
  ]);
  const unwrapExpression = (node: ts.Expression): ts.Expression => {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return unwrapExpression(node.expression);
    }
    return node;
  };
  const propertyName = (
    node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): string | null => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    const argument = node.argumentExpression;
    return argument &&
      (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
      ? argument.text
      : null;
  };
  const isCapabilityPath = (node: ts.Expression): boolean => {
    const unwrapped = unwrapExpression(node);
    if (ts.isIdentifier(unwrapped)) {
      return ['global', 'globalThis', 'process'].includes(unwrapped.text);
    }
    if (
      ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped)
    ) {
      return isCapabilityPath(unwrapped.expression);
    }
    return false;
  };
  const isConsoleReference = (node: ts.Expression): boolean => {
    const unwrapped = unwrapExpression(node);
    if (ts.isIdentifier(unwrapped)) {
      return unwrapped.text === 'console' || consoleAliases.has(unwrapped.text);
    }
    if (
      ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped)
    ) {
      return (
        isConsoleReference(unwrapped.expression) ||
        (propertyName(unwrapped) === 'console' &&
          isCapabilityPath(unwrapped.expression))
      );
    }
    return false;
  };
  const isFetchReference = (node: ts.Expression): boolean => {
    const unwrapped = unwrapExpression(node);
    if (ts.isIdentifier(unwrapped)) {
      return unwrapped.text === 'fetch' || fetchAliases.has(unwrapped.text);
    }
    if (
      ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped)
    ) {
      return (
        (propertyName(unwrapped) === 'fetch' &&
          isCapabilityPath(unwrapped.expression)) ||
        isFetchReference(unwrapped.expression)
      );
    }
    return false;
  };
  const isProhibitedModule = (specifier: string): boolean =>
    specifier === 'node:fs' ||
    specifier.startsWith('node:fs/') ||
    specifier === 'node:child_process' ||
    specifier.startsWith('@aws-sdk/') ||
    specifier.includes('centurion-thread-corpus-postgres-reader') ||
    specifier.includes('postgres') ||
    specifier.includes('storage/s3') ||
    specifier.includes('deploy') ||
    specifier.includes('ssm');
  const reportModule = (specifier: string): void => {
    if (isProhibitedModule(specifier)) {
      violations.push(`Prohibited module: ${specifier}`);
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      reportModule(node.moduleSpecifier.text);
    }
    if (
      ts.isIdentifier(node) &&
      ['global', 'globalThis', 'process'].includes(node.text)
    ) {
      violations.push('Global or process capability is prohibited');
    }
    if (ts.isIdentifier(node) && node.text === 'console') {
      violations.push('Console is prohibited');
    }
    if (ts.isIdentifier(node) && node.text === 'fetch') {
      violations.push('Fetch is prohibited');
    }
    if (ts.isIdentifier(node) && prohibitedIdentifiers.has(node.text)) {
      violations.push(`Prohibited capability: ${node.text}`);
    }
    if (
      ts.isIdentifier(node) &&
      /^(databaseUrl|DATABASE_URL|ThreadCorpusPostgres)/.test(node.text)
    ) {
      violations.push('Database capability is prohibited');
    }
    if (
      ts.isStringLiteral(node) &&
      /DATABASE_URL|postgres|s3|ssm/i.test(node.text)
    ) {
      violations.push('Database or storage value is prohibited');
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      if (isCapabilityPath(node.expression)) {
        violations.push('Global or process member access is prohibited');
      }
      if (isConsoleReference(node.expression)) {
        violations.push('Console member access is prohibited');
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      if (isConsoleReference(node.initializer)) {
        consoleAliases.add(node.name.text);
      }
      if (isFetchReference(node.initializer)) {
        fetchAliases.add(node.name.text);
      }
    }
    if (ts.isCallExpression(node)) {
      if (isFetchReference(node.expression)) {
        violations.push('Fetch call is prohibited');
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        reportModule(node.arguments[0].text);
      }
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        reportModule(node.arguments[0].text);
      }
    }
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Error' &&
      node.arguments?.some(
        (argument) =>
          !ts.isStringLiteral(argument) &&
          !ts.isNoSubstitutionTemplateLiteral(argument),
      )
    ) {
      violations.push('Dynamic error detail is prohibited');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe('centurion thread corpus exporter source boundary', () => {
  it('keeps shared snapshot code under the server source root', () => {
    const sourcePath = fileURLToPath(
      new URL(
        '../src/ops/centurion-thread-corpus-snapshot.ts',
        import.meta.url,
      ),
    );

    expect(existsSync(sourcePath)).toBe(true);
  });

  it('has no direct environment, database, AWS, filesystem, CLI, network, or console capability', () => {
    const sourcePath = fileURLToPath(
      new URL(
        '../src/ops/centurion-thread-corpus-exporter.ts',
        import.meta.url,
      ),
    );
    expect(exporterSourceGuardViolations(readFileSync(sourcePath, 'utf8'))).toEqual(
      [],
    );
  });

  it.each([
    "import { readFile } from 'node:fs/promises';",
    "import { exec } from 'node:child_process';",
    "import { S3Client } from '@aws-sdk/client-s3';",
    "import postgres from 'postgres';",
    "import { createThreadCorpusPostgresReader } from './centurion-thread-corpus-postgres-reader.js';",
    "import { getS3Storage } from '../storage/s3.js';",
    'process.env.DATABASE_URL;',
    'globalThis.process.env.DATABASE_URL;',
    "globalThis['process']['env'];",
    "global['process']['env'];",
    "fetch('https://synthetic.invalid');",
    "globalThis['fetch']('https://synthetic.invalid');",
    "const send = globalThis['fetch']; send('https://synthetic.invalid');",
    "console.log('synthetic');",
    "console['error']('synthetic');",
    "(console as unknown as { log: (...args: unknown[]) => void }).log('synthetic');",
    "((console)).log('synthetic');",
    "const logger = globalThis['console']; logger['log']('synthetic');",
    "const log = console.log; log('synthetic');",
    "require('node:fs');",
    "import('node:fs');",
    'parseArgs([]);',
    'createThreadCorpusPostgresReader({});',
    'getS3Storage();',
    'new Error(`source body ${body}`);',
    'new Error(caughtError.message);',
  ])('rejects prohibited composition capability: %s', (fixture) => {
    expect(exporterSourceGuardViolations(fixture)).not.toEqual([]);
  });
});
