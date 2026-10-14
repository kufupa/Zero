import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { and, eq, isNotNull } from 'drizzle-orm';
import { computeActionLabelEval, readActionLabelEvalRows } from './action-label-eval.js';
import { finalQuoteVersion, scoreQuoteOutcomes, type QuoteOutcomeCase, type QuoteOutcomeFinalOutput } from '../src/ai/quote-outcomes.js';
import type { DB } from '../src/db/client.js';
import { workEvent, workItem } from '../src/db/schema/work.js';

type Options = { fixture?: string; transportId?: string; version?: string };
type QuoteRow = QuoteOutcomeCase & { sourceMessageId: string };

export function parseQuoteOutcomeEvalArgs(args: string[], env: NodeJS.ProcessEnv = process.env): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    const value = args[++i];
    if (!['--fixture', '--transport', '--version'].includes(key) || values.has(key) || !value?.trim() || value.startsWith('--'))
      throw new Error('Invalid quote outcome eval options');
    values.set(key, value.trim());
  }
  const fixture = values.get('--fixture');
  const transportId = values.get('--transport') ?? env.HMS_MAILBOX_TRANSPORT_ID?.trim();
  const version = values.get('--version');
  if (fixture && !values.has('--transport') && !version) return { fixture };
  if (!fixture && transportId && version) return { transportId, version };
  throw new Error('Invalid quote outcome eval options');
}

export function parseQuoteOutcomeFixture(jsonl: string): QuoteOutcomeCase[] {
  const lines = jsonl.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length || lines.some((line) => !line.trim())) throw new Error('invalid quote outcome fixture');
  return lines.map((line) => {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const prepared = finalQuoteVersion(row.prepared), staffFinal = finalQuoteVersion(row.staffFinal);
      const action = row.action as { model?: unknown; owner?: unknown } | undefined;
      const output = row.finalOutput as QuoteOutcomeFinalOutput | undefined;
      if (!prepared || !staffFinal || (output !== undefined && typeof output.replyHtml !== 'string') ||
        (action !== undefined && (typeof action?.model !== 'string' || typeof action?.owner !== 'string')))
        throw new Error('invalid quote outcome fixture');
      return { prepared, staffFinal, ...(output ? { finalOutput: output } : {}),
        ...(action ? { action: action as { model: string; owner: string } } : {}) };
    } catch {
      throw new Error('invalid quote outcome fixture');
    }
  });
}

export function formatQuoteOutcomeSummary(result: ReturnType<typeof scoreQuoteOutcomes>): string {
  return JSON.stringify({ cases: result.cases, judgments: {
    action: result.action, dates: result.dates, occupancy: result.occupancy, contact: result.contact,
    party: result.party, lineTotals: result.lineTotals, finalOutput: result.finalOutput,
  } }, null, 2);
}

async function readFinalizedQuoteRows(db: DB, transportId: string): Promise<QuoteRow[]> {
  const rows = await db.select({ sourceMessageId: workItem.sourceMessageId, aiValue: workEvent.aiValue, value: workEvent.value })
    .from(workEvent).innerJoin(workItem, eq(workEvent.workItemId, workItem.id)).where(and(
      eq(workEvent.type, 'quote.finalized'), eq(workItem.transportId, transportId), isNotNull(workItem.sourceMessageId),
    ));
  return rows.map((row) => {
    const prepared = finalQuoteVersion(row.aiValue);
    const value = row.value as { staffQuote?: unknown; output?: QuoteOutcomeFinalOutput } | null;
    const staffFinal = finalQuoteVersion(value?.staffQuote);
    if (!prepared || !staffFinal || typeof value?.output?.replyHtml !== 'string' || !row.sourceMessageId)
      throw new Error('invalid_quote_outcome_event');
    return { prepared, staffFinal, finalOutput: value.output, sourceMessageId: row.sourceMessageId };
  });
}

function addActionLabels(cases: QuoteRow[], labels: Awaited<ReturnType<typeof readActionLabelEvalRows>>,
  options: { transportId: string; version: string }): QuoteOutcomeCase[] {
  const sources = new Set(cases.map((item) => item.sourceMessageId));
  const selected = computeActionLabelEval(labels.filter((row) => sources.has(row.messageId)), options).labels;
  const byMessage = new Map(selected.map((row) => [row.messageId, row]));
  return cases.map(({ sourceMessageId, ...item }) => {
    const label = byMessage.get(sourceMessageId);
    return { ...item, ...(label?.model && label.owner ? { action: { model: label.model.action, owner: label.owner.action } } : {}) };
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  const options = parseQuoteOutcomeEvalArgs(args);
  if (options.fixture) {
    console.log(formatQuoteOutcomeSummary(scoreQuoteOutcomes(parseQuoteOutcomeFixture(await readFile(options.fixture, 'utf8')))));
    return;
  }
  const { getDb, closeDb } = await import('../src/db/client.js');
  try {
    const db = getDb(), scope = { transportId: options.transportId!, version: options.version! };
    const rows = await readFinalizedQuoteRows(db, scope.transportId);
    const labels = await readActionLabelEvalRows(db, scope);
    console.log(formatQuoteOutcomeSummary(scoreQuoteOutcomes(addActionLabels(rows, labels, scope))));
  } finally { await closeDb(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => { console.error('Quote outcome evaluation failed'); process.exitCode = 1; });
