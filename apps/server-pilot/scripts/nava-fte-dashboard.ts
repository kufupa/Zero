import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboard, renderDashboardMarkdown } from '../src/ops/nava-fte-dashboard.js';
import type { NavaHoursStats } from '../src/ops/nava-fte-hours.js';
import { createPrivateInputReader } from '../src/ops/private-output.js';

function repoRootFromScript(): string {
  const override = process.env.NAVA_REPO_ROOT;
  if (override) return path.resolve(override);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

async function main(): Promise<void> {
  const repoRoot = repoRootFromScript();
  const reader = createPrivateInputReader({
    repoRoot,
    privateDirectoryName: 'connected-mailbox-corpus',
    allowedExtensions: ['.json'],
  });
  const raw = await reader.read('hours.json');
  const hours = JSON.parse(raw) as NavaHoursStats;
  const dashboard = buildDashboard(hours);
  const docsDir = path.join(repoRoot, 'docs', 'infor-hms');
  await mkdir(docsDir, { recursive: true });
  const jsonPath = path.join(docsDir, 'nava-fte-dashboard.json');
  const mdPath = path.join(docsDir, 'nava-fte-dashboard.md');
  await writeFile(jsonPath, `${JSON.stringify(dashboard, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, renderDashboardMarkdown(dashboard), 'utf8');
  process.stdout.write(
    `wrote ${path.relative(repoRoot, jsonPath)} nEligible=${dashboard.hours.nEligibleFirstResponse} mixTotal=${dashboard.mixTotal}\n`,
  );
}

const entryPath = process.argv[1];
if (
  typeof entryPath === 'string' &&
  fileURLToPath(import.meta.url) === path.resolve(entryPath)
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
