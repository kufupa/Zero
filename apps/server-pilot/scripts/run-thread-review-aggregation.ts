#!/usr/bin/env node
/**
 * Run thread-review aggregation over completed batch results.
 *
 * Inputs (all private/gitignored unless noted):
 * - batches/manifest.json          — batch → threadIds map (from build-thread-review-batches)
 * - thread-review/*.result.json    — judged batches
 * - census.json                    — deterministic regex census (aggregate distributions)
 * - residual-thread-ids.json       — threads the regex census could not classify
 *
 * Outputs:
 * - thread-review/full-thread-census.json — aggregates + per-thread records (PRIVATE)
 * - stdout: counts-only JSON summary (safe for logs)
 */
import { aggregateThreadReviewResults } from './aggregate-thread-review-results.js';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

type Manifest = {
  schemaVersion: number;
  asOf?: string | null;
  threadCount: number;
  messageCount: number;
  batches: Array<{ batchId: string; threadIds: string[] }>;
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  function requireValue(flag: string): string {
    const index = args.indexOf(flag);
    if (index === -1 || index + 1 >= args.length) {
      throw new Error(`Missing required argument ${flag} <value>`);
    }
    return args[index + 1];
  }
  const corpusRoot = path.resolve(requireValue('--corpus-root'));
  const manifestRaw = await readFile(path.join(corpusRoot, 'batches', 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw) as Manifest;
  if (manifest.schemaVersion !== 1 || manifest.threadCount !== 2403) {
    throw new Error('Invalid connected-mailbox batch manifest');
  }

  const agg = await aggregateThreadReviewResults({
    manifest,
    resultsRoot: path.join(corpusRoot, 'thread-review'),
  });

  if (!agg.coverage.complete || agg.coverage.totalThreads !== 2403) {
    throw new Error(
      `Coverage incomplete: missing=${agg.coverage.missingThreads.length} duplicate=${agg.coverage.duplicateThreads.length}`,
    );
  }

  // Residual analysis: which threads the regex census could NOT classify now have judge classes.
  const residualPath = path.join(corpusRoot, 'residual-thread-ids.json');
  let residualAnalysis: { residualTotal: number; newlyClassified: Record<string, number> } | null =
    null;
  try {
    const residual = JSON.parse(await readFile(residualPath, 'utf8')) as {
      threadIds: string[];
    };
    const residualSet = new Set(residual.threadIds);
    const newlyClassified: Record<string, number> = {};
    for (const t of agg.threads) {
      if (residualSet.has(t.threadId)) {
        newlyClassified[t.intentClass] = (newlyClassified[t.intentClass] ?? 0) + 1;
      }
    }
    residualAnalysis = { residualTotal: residualSet.size, newlyClassified };
  } catch {
    // Optional input; skip analysis when absent.
  }

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    asOf: manifest.asOf ?? null,
    coverage: agg.coverage,
    totals: {
      threads: agg.threads.length,
      humanLockCount: agg.humanLockCount,
      lowConfidenceCount: agg.lowConfidenceCount,
      toolHitlCount: agg.toolHitlCount,
    },
    intentCounts: agg.intentCounts,
    routeCounts: agg.routeCounts,
    toolDemandCounts: agg.toolDemandCounts,
    toolVerbCounts: agg.toolVerbCounts,
    residualAnalysis,
    threads: agg.threads.map((t) => ({
      threadId: t.threadId,
      batchId: t.batchId,
      intentClass: t.intentClass,
      routeSlug: t.routeSlug,
      routeConfidence: t.routeConfidence,
      humanLockRequired: t.humanLockRequired,
      humanLockReason: t.humanLockReason,
      toolDemand: t.toolDemand,
      alreadyHandled: t.alreadyHandled,
      confidence: t.confidence,
      pmsFacts: t.pmsFacts,
    })),
  };

  const finalPath = path.join(corpusRoot, 'thread-review', 'full-thread-census.json');
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await rename(tmpPath, finalPath);

  // Counts-only stdout — safe for terminal logs.
  console.log(
    JSON.stringify({
      threads: agg.threads.length,
      coverageComplete: agg.coverage.complete,
      intentCounts: agg.intentCounts,
      routeCounts: agg.routeCounts,
      humanLockCount: agg.humanLockCount,
      lowConfidenceCount: agg.lowConfidenceCount,
      toolDemandCounts: agg.toolDemandCounts,
      residualNewlyClassified: residualAnalysis?.newlyClassified ?? null,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
