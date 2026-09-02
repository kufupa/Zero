/**
 * Offline corpus audit: thread linkage layers, subject clusters, breakfast-pack exemplars.
 * Reads trusted private JSON only — no RDS, no PII in stdout.
 */
import { writeCenturionThreadLinkageAudit } from '../src/ops/centurion-thread-linkage-audit.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORK = path.join(
  REPO_ROOT,
  '.private/connected-mailbox-corpus/follow-up/_work',
);

async function main(): Promise<void> {
  const outDir = path.join(WORK, 'thread-linkage-audit-2026-09-02');
  const { reportPath, summaryPath } = await writeCenturionThreadLinkageAudit({
    defensiblePath: path.join(WORK, 'defensible-daily-chart-2026-09-01.json'),
    walkthroughPath: path.join(WORK, 'thread-walkthrough-2026-09-01.json'),
    staffBriefPath: path.join(WORK, 'staff-email-brief-analysis-2026-09-01.json'),
    outDir,
  });
  console.log(
    JSON.stringify({
      event: 'thread_linkage_audit.completed',
      reportPath,
      summaryPath,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'thread_linkage_audit.failed',
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
