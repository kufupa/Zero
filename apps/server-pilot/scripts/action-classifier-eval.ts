import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inArray, eq } from 'drizzle-orm';
import { closeDb, getDb } from '../src/db/client.js';
import { mailboxTransport, message } from '../src/db/schema/mail.js';
import {
  createAzureExtractionAdapter,
  extractInboundMail,
} from '../src/ai/extraction/extract.js';
import {
  computeActionClassifierMetrics,
  type ActionEvalCase,
  type ActionPrediction,
} from '../src/ai/extraction/action-eval-metrics.js';
import { extractionVisionEnabled } from '../src/ai/extraction/config.js';
import { MAIL_ACTIONS, type MailAction } from '../src/ai/extraction/schema.js';
import { loadSyncedQuoteSelectionFromMailbox } from '../src/ai/quote-workflow-synced-selection.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LABELS_PATH = resolve(here, '../eval/action-labels-r3.tsv');

type Label = { messageId: string; expected: ActionPrediction };
type CliOptions = { limit?: number; concurrency: number; repeat: number; labelsPath: string; deadlineMs?: number };

function positiveInteger(name: string, raw: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`--${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function parseArgs(args: string[]): CliOptions | 'help' {
  const options: CliOptions = { concurrency: 4, repeat: 2, labelsPath: DEFAULT_LABELS_PATH };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--help' || arg === '-h') return 'help';
    const [rawName, inlineValue] = arg.startsWith('--') ? arg.slice(2).split('=', 2) : ['', undefined];
    if (!['limit', 'concurrency', 'repeat', 'labels', 'deadline-ms'].includes(rawName)) {
      throw new Error(`unknown option: ${arg}`);
    }
    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`--${rawName} requires a value`);
    if (rawName === 'limit') options.limit = positiveInteger(rawName, value);
    if (rawName === 'concurrency') {
      options.concurrency = positiveInteger(rawName, value, 16);
    }
    if (rawName === 'repeat') options.repeat = positiveInteger(rawName, value, 10);
    if (rawName === 'labels') options.labelsPath = resolve(value);
    if (rawName === 'deadline-ms') options.deadlineMs = positiveInteger(rawName, value, 600_000);
  }
  return options;
}

function parseLabels(tsv: string): Label[] {
  const [headerLine, ...lines] = tsv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const header = headerLine?.split('\t');
  if (header?.join('\t') !== 'message_id\tneeds_action\taction') {
    throw new Error('action label file must have columns: message_id, needs_action, action');
  }
  const labels: Label[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const [messageId, needsActionRaw, actionRaw, ...extra] = line.split('\t');
    if (!messageId || extra.length > 0 || !['yes', 'no'].includes(needsActionRaw ?? '')) {
      throw new Error(`invalid action label row ${index + 2}`);
    }
    if (!MAIL_ACTIONS.includes(actionRaw as MailAction)) {
      throw new Error(`invalid action label value at row ${index + 2}`);
    }
    const needsAction = needsActionRaw === 'yes';
    const action = actionRaw as MailAction;
    if (needsAction !== (action !== 'no_action')) {
      throw new Error(`inconsistent needs_action/action label at row ${index + 2}`);
    }
    labels.push({ messageId, expected: { needsAction, action } });
  }
  return labels;
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(items[index]!, index);
      }
    }),
  );
  return results;
}

function latencySummary(values: number[]): { p50: number; p90: number; max: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]!;
  return { p50: at(0.5), p90: at(0.9), max: sorted.at(-1)! };
}

function percent(value: number | null): number | null {
  return value === null ? null : Number((value * 100).toFixed(2));
}

function help(): void {
  console.log(
    [
      'Read-only action-classifier eval. Run from apps/server-pilot on EC2 with the production mailbox read env.',
      '  pnpm exec tsx scripts/action-classifier-eval.ts [--limit N] [--concurrency N] [--repeat N] [--labels PATH] [--deadline-ms N]',
      'Defaults: --concurrency 4, --repeat 2. No extraction or work-item rows are written.',
    ].join('\n'),
  );
}

export async function runActionClassifierEval(options: CliOptions): Promise<void> {
  const adapter = createAzureExtractionAdapter(process.env);
  if (!adapter) throw new Error('Azure GPT-6 Luna extraction credentials are not configured');
  const labelsText = await readFile(options.labelsPath, 'utf8');
  const labels = parseLabels(labelsText).slice(0, options.limit);
  if (labels.length === 0) throw new Error('action label file contains no labelled messages');

  const db = getDb();
  try {
    const rows = await db
      .select({
        id: message.id,
        transportId: message.transportId,
        direction: message.direction,
        fromAddress: message.fromAddress,
        mailbox: mailboxTransport.email,
      })
      .from(message)
      .leftJoin(mailboxTransport, eq(mailboxTransport.id, message.transportId))
      .where(inArray(message.id, labels.map((label) => label.messageId)));
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const visionEnabled = extractionVisionEnabled(process.env);
    // Reason codes and latencies only: never mail, model output, or provider error bodies.
    const failureReasons: Record<string, number> = {};
    const countFailure = (reason: string) => {
      failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
    };
    const latenciesMs: number[] = [];

    const scored = await mapConcurrent(labels, options.concurrency, async (label): Promise<ActionEvalCase> => {
      const row = rowById.get(label.messageId);
      const predictions: Array<ActionPrediction | null> = [];
      if (!row || row.direction !== 'inbound') {
        countFailure(row ? 'not_inbound' : 'message_missing');
        return { expected: label.expected, predictions: Array(options.repeat).fill(null) };
      }
      let selection: Awaited<ReturnType<typeof loadSyncedQuoteSelectionFromMailbox>> = null;
      try {
        selection = await loadSyncedQuoteSelectionFromMailbox({
          transportId: row.transportId,
          messageId: row.id,
          includeThreadState: true,
          includeVisionImages: visionEnabled,
          trackVisionImages: true,
        });
      } catch {
        // Keep one unreadable DB/storage record from suppressing metrics for every other label.
        countFailure('selection_load_error');
        return { expected: label.expected, predictions: Array(options.repeat).fill(null) };
      }
      if (!selection) {
        countFailure('selection_missing');
        return { expected: label.expected, predictions: Array(options.repeat).fill(null) };
      }

      for (let repeat = 0; repeat < options.repeat; repeat += 1) {
        const startedAt = Date.now();
        try {
          const result = await extractInboundMail({
            adapter,
            selection,
            messageId: row.id,
            from: row.fromAddress,
            mailbox: row.mailbox,
            env: process.env,
            deadlineMs: options.deadlineMs,
          });
          latenciesMs.push(Date.now() - startedAt);
          if (!result.ok) countFailure(`extract_${result.reason}`);
          predictions.push(
            result.ok ? { needsAction: result.needsAction, action: result.action } : null,
          );
        } catch {
          // Never print mail, attachments, model outputs, or provider error bodies from the eval process.
          countFailure('extract_threw');
          predictions.push(null);
        }
      }
      return { expected: label.expected, predictions };
    });

    const metrics = computeActionClassifierMetrics(scored);
    const failedFirstRun = scored.filter((item) => item.predictions[0] === null).length;
    const report = {
      messageCount: scored.length,
      repeat: options.repeat,
      concurrency: options.concurrency,
      unclassifiedFirstRun: failedFirstRun,
      failureReasons,
      latencyMs: latencySummary(latenciesMs),
      needsActionAccuracy: { ...metrics.needsActionAccuracy, percent: percent(metrics.needsActionAccuracy.accuracy) },
      actionAccuracy: { ...metrics.actionAccuracy, percent: percent(metrics.actionAccuracy.accuracy) },
      confusionMatrix: metrics.confusionMatrix,
      perClass: Object.fromEntries(
        Object.entries(metrics.perClass).map(([action, value]) => [
          action,
          { ...value, precisionPercent: percent(value.precision), recallPercent: percent(value.recall) },
        ]),
      ),
      stability: metrics.stability
        ? { ...metrics.stability, percent: percent(metrics.stability.rate) }
        : null,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await closeDb();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options === 'help') {
    help();
    return;
  }
  await runActionClassifierEval(options);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error('action classifier eval failed; no raw email or model output was logged');
    process.exitCode = 1;
  });
}
