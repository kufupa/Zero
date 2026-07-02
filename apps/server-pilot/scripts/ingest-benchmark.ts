/**
 * Ingest capacity benchmark for the EC2 pilot.
 *
 * Processes 1,000 fixture messages through `ingestOnce` with a fake POP3
 * client (100 PDF-like attachments), records wall time + max RSS, and
 * extrapolates 15,000 delivered-copy/day throughput.
 *
 * Run:
 *   pnpm --filter @zero/server tsx scripts/ingest-benchmark.ts
 *   pnpm --filter @zero/server tsx scripts/ingest-benchmark.ts --allow-prod
 *   pnpm --filter @zero/server tsx scripts/ingest-benchmark.ts --cleanup
 *
 * Env:
 *   INGEST_BENCHMARK_COUNT     default 1000
 *   INGEST_BENCHMARK_PDF_COUNT default 100
 *   INGEST_BENCHMARK_MAX       default INGEST_BENCHMARK_COUNT (per cycle cap)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { like } from 'drizzle-orm';
import { closeDb, getDb } from '../src/db/client.js';
import {
  fakePop3FromMessages,
  ingestOnce,
} from '../src/mail/ingest/worker.js';
import type { FakePop3Message } from '../src/mail/ingest/pop3-client.js';
import { INGEST_MAILBOX_ID } from '../src/db/seed.js';
import { mailThread } from '../src/db/schema/mail.js';
import { parseEnv } from '../src/env.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'tests', 'fixtures');

const PILOT_PROD_DB_HOST = 'nava-zero-mail-pilot';
const BENCHMARK_SUBJECT_PREFIX = 'Benchmark';

const MESSAGE_COUNT = Number(process.env.INGEST_BENCHMARK_COUNT ?? 1000);
const PDF_COUNT = Number(process.env.INGEST_BENCHMARK_PDF_COUNT ?? 100);
const MAX_PER_CYCLE = Number(
  process.env.INGEST_BENCHMARK_MAX ?? MESSAGE_COUNT,
);
const DAILY_TARGET = Number(process.env.INGEST_DAILY_TARGET ?? 15_000);
const RSS_SAMPLE_MS = Number(process.env.INGEST_RSS_SAMPLE_MS ?? 250);

type CliFlags = {
  allowProd: boolean;
  cleanup: boolean;
};

function parseFlags(argv: string[]): CliFlags {
  return {
    allowProd: argv.includes('--allow-prod'),
    cleanup: argv.includes('--cleanup'),
  };
}

function isPilotProdDatabase(databaseUrl: string): boolean {
  try {
    const host = new URL(databaseUrl).hostname;
    return host.includes(PILOT_PROD_DB_HOST);
  } catch {
    return databaseUrl.includes(PILOT_PROD_DB_HOST);
  }
}

function assertSafeToRun(flags: CliFlags): void {
  const env = parseEnv(process.env);
  const onPilotProdDb = isPilotProdDatabase(env.DATABASE_URL);
  const onPilotIngestMailbox = INGEST_MAILBOX_ID === 'ingest-nava-legacy';

  if (!flags.allowProd && (onPilotProdDb || onPilotIngestMailbox)) {
    console.error(
      'ingest-benchmark refused: targets pilot production ingest mailbox / database.',
    );
    console.error(
      'Re-run with --allow-prod only if you intend to write benchmark rows to production.',
    );
    process.exit(1);
  }
}

async function cleanupBenchmarkRows(): Promise<number> {
  const db = getDb();
  const deleted = await db
    .delete(mailThread)
    .where(like(mailThread.subject, `${BENCHMARK_SUBJECT_PREFIX}%`))
    .returning({ id: mailThread.id });
  return deleted.length;
}

function readFixture(name: string): Buffer {
  return readFileSync(join(fixturesDir, name));
}

function cloneTemplate(
  template: Buffer,
  uidl: string,
  messageId: string,
  subject: string,
): Buffer {
  let text = template.toString('utf8');
  text = text.replace(/Message-ID: <[^>]+>/, `Message-ID: <${messageId}>`);
  if (/^Subject:/m.test(text)) {
    text = text.replace(/^Subject:.*$/m, `Subject: ${subject}`);
  } else {
    text = `Subject: ${subject}\r\n${text}`;
  }
  return Buffer.from(text, 'utf8');
}

function buildFixtureMessages(): FakePop3Message[] {
  const plainTemplate = readFixture('centurion-stamped.eml');
  const pdfTemplate = readFixture('centurion-attachment.eml');
  const messages: FakePop3Message[] = [];

  for (let i = 0; i < MESSAGE_COUNT; i += 1) {
    const uidl = `bench-uidl-${String(i + 1).padStart(5, '0')}`;
    const usePdf = i < PDF_COUNT;
    const template = usePdf ? pdfTemplate : plainTemplate;
    const messageId = `bench-msg-${i + 1}@legacyhotel.com`;
    const subject = usePdf
      ? `${BENCHMARK_SUBJECT_PREFIX} PDF message ${i + 1}`
      : `${BENCHMARK_SUBJECT_PREFIX} plain message ${i + 1}`;
    messages.push({
      uidl,
      raw: cloneTemplate(template, uidl, messageId, subject),
    });
  }
  return messages;
}

function sampleMaxRss(intervalMs: number): { stop: () => number } {
  let maxRss = process.memoryUsage().rss;
  const timer = setInterval(() => {
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
      maxRss = Math.max(maxRss, process.memoryUsage().rss);
      return maxRss;
    },
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  assertSafeToRun(flags);

  if (flags.cleanup) {
    const removed = await cleanupBenchmarkRows();
    console.log(
      JSON.stringify(
        {
          cleanup: true,
          removedThreads: removed,
          subjectPrefix: BENCHMARK_SUBJECT_PREFIX,
        },
        null,
        2,
      ),
    );
    await closeDb().catch(() => undefined);
    return;
  }

  const messages = buildFixtureMessages();
  const pop3 = fakePop3FromMessages(messages);
  const rssSampler = sampleMaxRss(RSS_SAMPLE_MS);

  console.log(
    `ingest-benchmark: starting ${MESSAGE_COUNT} messages (${PDF_COUNT} pdf-like attachments)`,
  );

  const start = performance.now();
  const result = await ingestOnce({
    pop3,
    ingestMailboxId: INGEST_MAILBOX_ID,
    maxMessages: MAX_PER_CYCLE,
  });
  const elapsedMs = performance.now() - start;
  const maxRss = rssSampler.stop();

  await closeDb().catch(() => undefined);

  const elapsedSec = elapsedMs / 1000;
  const perSecond = elapsedSec > 0 ? result.processed / elapsedSec : 0;
  const extrapolatedPerDay = perSecond * 86_400;
  const remainingBacklog = Math.max(0, result.listed - result.deled);
  const backlogGrows = remainingBacklog > 0;

  const report = {
    messageCount: MESSAGE_COUNT,
    pdfAttachmentCount: PDF_COUNT,
    ingestMailboxId: INGEST_MAILBOX_ID,
    usedFakePop3: result.usedFakePop3,
    listed: result.listed,
    processed: result.processed,
    deled: result.deled,
    errors: result.items.filter((i) => i.status === 'error').length,
    cycleError: result.cycleError ?? null,
    timing: {
      elapsedMs: Math.round(elapsedMs),
      messagesPerSecond: Number(perSecond.toFixed(3)),
    },
    memory: {
      maxRssBytes: maxRss,
      maxRssMiB: Number((maxRss / (1024 * 1024)).toFixed(2)),
    },
    extrapolation: {
      dailyTarget: DAILY_TARGET,
      extrapolatedMessagesPerDay: Math.round(extrapolatedPerDay),
      meetsDailyTarget: extrapolatedPerDay >= DAILY_TARGET,
      uidlBacklogRemaining: remainingBacklog,
      backlogWouldGrowAtTargetRate: backlogGrows,
    },
    gate: {
      pass:
        !result.cycleError &&
        result.processed === MESSAGE_COUNT &&
        result.deled === MESSAGE_COUNT &&
        !backlogGrows &&
        extrapolatedPerDay >= DAILY_TARGET,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.gate.pass) process.exit(1);
}

main().catch((err) => {
  console.error('ingest-benchmark failed:', err);
  process.exit(1);
});
