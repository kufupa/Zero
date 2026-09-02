#!/usr/bin/env npx tsx
/** Enumerate Layer C thread link residual pairs — counts only on stdout. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatResidualStdout,
  resolveCorpusRootFromStartDir,
  resolveLinkResidualOutputPath,
  resolvePrivateCorpusWorkRoot,
  runCenturionLinkResidualEnumerationFromCorpus,
} from '../src/ops/centurion-link-residual-enumerator.js';

async function main(): Promise<void> {
  const startDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const corpusRoot = resolveCorpusRootFromStartDir(startDir);
  const workRoot = resolvePrivateCorpusWorkRoot(corpusRoot);
  const report = await runCenturionLinkResidualEnumerationFromCorpus(corpusRoot);
  const outputPath = resolveLinkResidualOutputPath(workRoot);

  await mkdir(workRoot, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

  console.log(
    JSON.stringify({
      event: 'thread_link_residual.completed',
      outputPath,
    }),
  );
  console.log(formatResidualStdout(report));

  if (report.totals.actionable !== 438) {
    console.error(`Expected 438 actionable threads, got ${report.totals.actionable}`);
    process.exit(1);
  }
  if (report.totals.pairsTotal === 0) {
    console.error('Expected non-zero residual pairs');
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'thread_link_residual.failed',
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
