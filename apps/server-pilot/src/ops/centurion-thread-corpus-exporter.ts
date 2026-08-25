import {
  createThreadCorpusSnapshotLoader,
  publishPrivateThreadCorpusSnapshot,
  validatePrivateThreadCorpusOutputDestination,
  type PrivateThreadCorpusPublishArgs,
  type PrivateThreadCorpusSnapshotContext,
  type ThreadCorpusSnapshotLoadResult,
  type ThreadCorpusSnapshotReader,
  type ThreadCorpusSnapshotSafeSummary,
} from './centurion-thread-corpus-snapshot.js';
import { hydrateThreadCorpusArtifacts } from './centurion-thread-corpus-hydrator.js';

export type ClosableThreadCorpusReader = ThreadCorpusSnapshotReader & {
  close(): Promise<void>;
};

export type ThreadCorpusExportRequest = {
  repoRoot: string;
  outDir: string;
  snapshotId: string;
  exporterVersion: string;
  hydration: Omit<
    Parameters<typeof hydrateThreadCorpusArtifacts>[0],
    'formatted' | 'attachmentLocators'
  >;
};

export type ThreadCorpusExportDependencies = {
  createReader(): ClosableThreadCorpusReader;
  /** Test seam. Production defaults to Git-root and ignored-directory validation. */
  validateOutputDestination?(repoRoot: string, outDir: string): string;
  load?(reader: ThreadCorpusSnapshotReader): Promise<ThreadCorpusSnapshotLoadResult>;
  hydrate?: typeof hydrateThreadCorpusArtifacts;
  publish?: (args: PrivateThreadCorpusPublishArgs) => Promise<{ outDir: string }>;
};

export type ThreadCorpusExportSafeResult = {
  outDir: string;
  summary: ThreadCorpusSnapshotSafeSummary;
};

const SAFE_SUMMARY_COUNT_KEYS = ['includedMessageCount', 'sourceRowCount', 'threadCount'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSealedActiveTransportScope(value: unknown, asOf: string): boolean {
  if (!isRecord(value) || value.asOf !== asOf || !Array.isArray(value.transportIds)) {
    return false;
  }
  const transportIds = value.transportIds;
  return (
    transportIds.length > 0 &&
    transportIds.every((transportId) => typeof transportId === 'string' && transportId.trim()) &&
    transportIds.every(
      (transportId, index) => index === 0 || transportIds[index - 1]! < transportId,
    )
  );
}

function hasCoherentLoadResult(result: ThreadCorpusSnapshotLoadResult): boolean {
  try {
    const candidate = result as unknown;
    if (!isRecord(candidate) || typeof candidate.asOf !== 'string') return false;
    if (!isRecord(candidate.safeSummary)) return false;
    if (!isSealedActiveTransportScope(candidate.activeTransportScope, candidate.asOf)) {
      return false;
    }

    const summary = candidate.safeSummary;
    if (summary.asOf !== candidate.asOf) return false;
    if (SAFE_SUMMARY_COUNT_KEYS.some((key) => !isNonNegativeSafeInteger(summary[key]))) {
      return false;
    }
    return true;
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
      scopeKeys: ['active_transport'],
      transportIds: [...result.activeTransportScope.transportIds],
      messagePredicate: 'active_transport_before_as_of',
    },
    asOf: result.asOf,
    exporterVersion: request.exporterVersion,
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
  };
}

export function createCenturionThreadCorpusExporter(
  dependencies: ThreadCorpusExportDependencies,
): (request: ThreadCorpusExportRequest) => Promise<ThreadCorpusExportSafeResult> {
  const validateOutputDestination =
    dependencies.validateOutputDestination ?? validatePrivateThreadCorpusOutputDestination;

  return async (request) => {
    validateOutputDestination(request.repoRoot, request.outDir);
    const reader = dependencies.createReader();
    let result: ThreadCorpusSnapshotLoadResult;

    try {
      result = dependencies.load
        ? await dependencies.load(reader)
        : await createThreadCorpusSnapshotLoader(reader)();
    } catch (error) {
      try {
        await reader.close();
      } catch {}
      throw error;
    }

    await reader.close();
    validateLoadResult(result);

    const hydration = await (dependencies.hydrate ?? hydrateThreadCorpusArtifacts)({
      ...request.hydration,
      formatted: result.formatted,
      attachmentLocators: result.attachmentLocators,
    });
    const published = await (dependencies.publish ?? publishPrivateThreadCorpusSnapshot)({
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
