import {
  computeNavaHoursStats,
  parseAsOfFromDump,
  parseConnectedMailboxDump,
} from '../src/ops/nava-fte-hours.js';
import {
  createPrivateInputReader,
  createPrivateOutputWriter,
} from '../src/ops/private-output.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PRIVATE_DIRECTORY_NAME = 'connected-mailbox-corpus';

function repoRootFromScript(): string {
  const override = process.env.NAVA_REPO_ROOT;
  if (override) return path.resolve(override);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

async function main(): Promise<void> {
  const repoRoot = repoRootFromScript();
  const reader = createPrivateInputReader({
    repoRoot,
    privateDirectoryName: PRIVATE_DIRECTORY_NAME,
    allowedExtensions: ['.md'],
  });
  const writer = createPrivateOutputWriter({
    repoRoot,
    privateDirectoryName: PRIVATE_DIRECTORY_NAME,
    allowedExtensions: ['.json'],
  });
  const markdown = await reader.read('connected-mailbox-inbox.md');
  const asOf = parseAsOfFromDump(markdown);
  if (!asOf) {
    throw new Error('Dump header missing Snapshot as of');
  }
  const stats = computeNavaHoursStats(parseConnectedMailboxDump(markdown), asOf);
  await writer.write('hours.json', `${JSON.stringify(stats, null, 2)}\n`);
  process.stdout.write(
    [
      `asOf=${stats.asOf}`,
      `threadCount=${stats.threadCount}`,
      `threadsWithOutbound=${stats.threadsWithOutbound}`,
      `inboundOnlyThreads=${stats.inboundOnlyThreads}`,
      `nEligibleFirstResponse=${stats.nEligibleFirstResponse}`,
      `medianFirstResponseMinutes=${stats.medianFirstResponseMinutes}`,
      `p90FirstResponseMinutes=${stats.p90FirstResponseMinutes}`,
      `droppedNegativeOrMissing=${stats.droppedNegativeOrMissing}`,
      '',
    ].join('\n'),
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
