import {
  createThreadCorpusSnapshotLoader,
  publishPrivateThreadCorpusSnapshot,
  type PrivateThreadCorpusPublishArgs,
  type PrivateThreadCorpusSnapshotContext,
  type ThreadCorpusSnapshotLoadRequest,
  type ThreadCorpusSnapshotLoadResult,
  type ThreadCorpusSnapshotReader,
  type ThreadCorpusSnapshotSafeSummary,
} from '../../scripts/export-thread-corpus.js';
import { hydrateThreadCorpusArtifacts } from './centurion-thread-corpus-hydrator.js';

export type ClosableThreadCorpusReader = ThreadCorpusSnapshotReader & {
  close(): Promise<void>;
};

export type ThreadCorpusExportRequest = {
  repoRoot: string;
  outDir: string;
  snapshotId: string;
  exporterVersion: string;
  source: ThreadCorpusSnapshotLoadRequest;
  hydration: Omit<
    Parameters<typeof hydrateThreadCorpusArtifacts>[0],
    'formatted' | 'attachmentLocators'
  >;
};

export type ThreadCorpusExportDependencies = {
  createReader(): ClosableThreadCorpusReader;
  load?(
    reader: ThreadCorpusSnapshotReader,
    request: ThreadCorpusSnapshotLoadRequest,
  ): Promise<ThreadCorpusSnapshotLoadResult>;
  hydrate?: typeof hydrateThreadCorpusArtifacts;
  publish?: (
    args: PrivateThreadCorpusPublishArgs,
  ) => Promise<{ outDir: string }>;
};

export type ThreadCorpusExportSafeResult = {
  outDir: string;
  summary: ThreadCorpusSnapshotSafeSummary;
};

const SAFE_SUMMARY_COUNT_KEYS = [
  'includedMessageCount',
  'sourceRowCount',
  'threadCount',
  'quarantineRecordCount',
  'unscopedQuarantineCount',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasCoherentLoadResult(
  result: ThreadCorpusSnapshotLoadResult,
): boolean {
  try {
    const candidate = result as unknown;
    if (!isRecord(candidate) || typeof candidate.asOf !== 'string') return false;
    if (!isRecord(candidate.safeSummary)) return false;
    if (!Array.isArray(candidate.unscopedQuarantineRows)) return false;

    const summary = candidate.safeSummary;
    if (summary.asOf !== candidate.asOf) return false;
    if (
      SAFE_SUMMARY_COUNT_KEYS.some(
        (key) => !isNonNegativeSafeInteger(summary[key]),
      )
    ) {
      return false;
    }
    return (
      summary.unscopedQuarantineCount ===
      candidate.unscopedQuarantineRows.length
    );
  } catch {
    return false;
  }
}

function validateLoadResult(result: ThreadCorpusSnapshotLoadResult): void {
  if (!hasCoherentLoadResult(result)) {
    throw new Error('Invalid thread corpus snapshot result');
  }
}

function contextFor(
  request: ThreadCorpusExportRequest,
  result: ThreadCorpusSnapshotLoadResult,
): PrivateThreadCorpusSnapshotContext {
  return {
    snapshotId: request.snapshotId,
    scope: {
      scopeKeys: [
        'centurion_transport',
        'designated_reservationist_mailbox',
      ],
      transportIds: [
        ...new Set([
          request.source.centurionTransportId,
          request.source.designatedTransportId,
        ]),
      ].sort(),
      participantAddressRef:
        request.source.designatedAddresses.length > 0
          ? 'private_designated_reservationist_address'
          : null,
      messagePredicate:
        'selected_transports_or_private_designated_address_before_as_of',
      quarantinePredicate:
        'selected_ingest_mailbox_or_owner_header_before_as_of',
    },
    asOf: result.asOf,
    exporterVersion: request.exporterVersion,
    unscopedQuarantineExcluded: result.safeSummary.unscopedQuarantineCount,
  };
}

function cloneSafeSummary(
  summary: ThreadCorpusSnapshotSafeSummary,
): ThreadCorpusSnapshotSafeSummary {
  return {
    asOf: summary.asOf,
    includedMessageCount: summary.includedMessageCount,
    sourceRowCount: summary.sourceRowCount,
    threadCount: summary.threadCount,
    quarantineRecordCount: summary.quarantineRecordCount,
    unscopedQuarantineCount: summary.unscopedQuarantineCount,
  };
}

export function createCenturionThreadCorpusExporter(
  dependencies: ThreadCorpusExportDependencies,
): (
  request: ThreadCorpusExportRequest,
) => Promise<ThreadCorpusExportSafeResult> {
  return async (request) => {
    const reader = dependencies.createReader();
    let result: ThreadCorpusSnapshotLoadResult;

    try {
      result = dependencies.load
        ? await dependencies.load(reader, request.source)
        : await createThreadCorpusSnapshotLoader(reader)(request.source);
    } catch (error) {
      try {
        await reader.close();
      } catch {}
      throw error;
    }

    await reader.close();
    validateLoadResult(result);

    const hydration = await (
      dependencies.hydrate ?? hydrateThreadCorpusArtifacts
    )({
      ...request.hydration,
      formatted: result.formatted,
      attachmentLocators: result.attachmentLocators,
    });
    const published = await (
      dependencies.publish ?? publishPrivateThreadCorpusSnapshot
    )({
      repoRoot: request.repoRoot,
      outDir: request.outDir,
      context: contextFor(request, result),
      formatted: result.formatted,
      hydration,
    });

    return {
      outDir: published.outDir,
      summary: cloneSafeSummary(result.safeSummary),
    };
  };
}
