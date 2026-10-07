/**
 * U5 case census: run the U1 analyser over corpus A+B.
 * Private outputs under .private/luna-mvp/census/ (gitignored). Aggregates only on stdout.
 * No getDb. Azure env is loaded, never printed.
 */
import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  analyseQuoteSelection,
  buildQuoteWorkflowPrompt,
  quoteWorkflowLlmEnabled,
} from '../src/ai/quote-workflow-llm.js';
import { lunaAnalysisSchema, type LunaAnalysis } from '../src/ai/reservationist-decision.js';
import type { SyncedQuoteSelection } from '../src/ai/quote-workflow-synced-selection.js';
import { createAzureLunaModel, LunaModelAdapter } from '../src/ai/bedrock/luna.js';
import { maskCardNumbers } from '../src/ai/card-mask.js';

const COST_CAP_USD = 50;
const DEFAULT_CONCURRENCY = 8;
const CHECK_SEED = 42;
const MANUAL_FLAGS = new Set(['conference_or_group', 'amendment_or_cancel', 'long_stay']);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const SIBLING_TOOLS = path.resolve(REPO_ROOT, '../centurion-dashboard-tools');
const CORPUS_A = path.join(SIBLING_TOOLS, '.private/reservationist-backtest/corpus/messages.jsonl');
const CORPUS_B_DIR = path.join(SIBLING_TOOLS, '.private/cli-coverage/shards');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, '.private/luna-mvp/census');
const CODEX_CONFIG = path.join(process.env.HOME ?? '', '.codex/config.toml');

type Workflow = LunaAnalysis['workflow'];
type Bucket = 'full' | 'partial' | 'manual' | 'other';
type CorpusTag = 'A' | 'B';

type AttachmentDescriptor = {
  id?: string;
  filename?: string;
  contentType?: string;
  inline?: boolean | null;
};

type CorpusARow = {
  id: string;
  threadId: string;
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  receivedAt?: string | null;
  businessDirection?: string | null;
  contextOnly?: boolean | null;
  attachmentDescriptors?: AttachmentDescriptor[] | null;
};

type CorpusBRow = {
  inboundId: string;
  subject?: string | null;
  textBody?: string | null;
  attachmentText?: string | null;
};

type CensusCase = {
  id: string;
  corpus: CorpusTag;
  selection: SyncedQuoteSelection;
};

type CensusRow = {
  id: string;
  corpus: CorpusTag;
  source: 'luna' | 'regex_fallback';
  fallbackReason?: string;
  workflow: Workflow | 'unavailable';
  flags: string[];
  bucket: Bucket;
  staffEquivalent: boolean;
  inventedPrice: boolean;
  inventedPriceCodes: string[];
  taskKinds: string[];
  taskSequence: string;
  missingPricing: boolean;
  costUsd: number;
  latencyMs: number;
  analysis?: LunaAnalysis;
};

/** Same strip as `inbound-reaction-parser.ts:42` — inlined so this script stays off getDb/mail. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .trim();
}

function messageBody(row: { textBody?: string | null; htmlBody?: string | null }): string {
  const text = (row.textBody ?? '').trim();
  if (text) return text;
  const html = row.htmlBody ?? '';
  return html ? htmlToPlainText(html) : '';
}

function parseArgs(argv: string[]) {
  const out = {
    limit: 0,
    concurrency: DEFAULT_CONCURRENCY,
    costCap: COST_CAP_USD,
    outDir: DEFAULT_OUT_DIR,
    dropIds: new Set<string>(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--limit' && next) {
      out.limit = Number(next);
      i += 1;
    } else if (arg === '--concurrency' && next) {
      out.concurrency = Number(next);
      i += 1;
    } else if (arg === '--cost-cap' && next) {
      out.costCap = Number(next);
      i += 1;
    } else if (arg === '--out-dir' && next) {
      out.outDir = path.resolve(next);
      i += 1;
    } else if (arg === '--drop-ids' && next) {
      for (const id of next.split(',')) {
        if (id) out.dropIds.add(id);
      }
      i += 1;
    } else if (arg === '--drop-ids-file' && next) {
      const text = readFileSync(next, 'utf8');
      for (const id of text.split(/\s+/)) {
        if (id) out.dropIds.add(id);
      }
      i += 1;
    }
  }
  if (!Number.isInteger(out.limit) || out.limit < 0) {
    throw new Error('--limit must be an integer >= 0');
  }
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  if (!Number.isFinite(out.costCap) || out.costCap <= 0) {
    throw new Error('--cost-cap must be a finite number > 0');
  }
  return out;
}

function loadAzureBaseUrlFromCodex(): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(CODEX_CONFIG, 'utf8');
  } catch {
    return undefined;
  }
  let inAzure = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inAzure = trimmed === '[model_providers.azure]';
      continue;
    }
    if (!inAzure || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    if (key !== 'base_url') continue;
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    return value || undefined;
  }
  return undefined;
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const rows: T[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line) as T);
  }
  return rows;
}

function isPdfDescriptor(desc: AttachmentDescriptor): boolean {
  const filename = desc.filename ?? '';
  const contentType = desc.contentType ?? '';
  return /\.pdf$/i.test(filename) || /pdf/i.test(contentType);
}

function unreadPdfAttachments(descs: AttachmentDescriptor[]): SyncedQuoteSelection['attachments'] {
  const picked: SyncedQuoteSelection['attachments'] = [];
  for (const desc of descs) {
    if (desc.inline === true) continue;
    if (!isPdfDescriptor(desc)) continue;
    picked.push({
      id: desc.id ?? `pdf-${picked.length}`,
      filename: desc.filename ?? 'attachment.pdf',
      bytesPresent: false,
      readFailure: 'no readable text',
      // U1 prompt skips null text; marker lets Luna set attachment_unread.
      text: '[unread]',
    });
    if (picked.length >= 3) break;
  }
  return picked;
}

function validIsoDate(value: string | null): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
  );
}

function missingPricing(analysis: LunaAnalysis): boolean {
  if (analysis.groups.length === 0) return true;
  return analysis.groups.some(
    (group) =>
      !validIsoDate(group.arrival) ||
      !validIsoDate(group.departure) ||
      group.rooms === null ||
      group.adultsPerRoom === null,
  );
}

function bucketOf(analysis: LunaAnalysis): Bucket {
  if (analysis.flags.some((flag) => MANUAL_FLAGS.has(flag))) return 'manual';
  if (analysis.workflow === 'other') return 'other';
  if (analysis.flags.length === 0 && !missingPricing(analysis)) return 'full';
  return 'partial';
}

/** Staff-equivalent: dates/rooms/occupancy present; extras/unread/discount flags do not disqualify. */
export function staffEquivalentOf(analysis: LunaAnalysis): boolean {
  if (analysis.workflow === 'other') return false;
  if (analysis.flags.some((flag) => MANUAL_FLAGS.has(flag))) return false;
  return !missingPricing(analysis);
}

function compactAmount(value: string): string {
  return value.replace(/[\s,\u00a0]/g, '').replace(/^[A-Za-z$€£R¥]+/u, '');
}

function inventedPriceCodes(analysis: LunaAnalysis, maskedSource: string): string[] {
  const codes: string[] = [];
  for (const [index, claim] of analysis.rateClaims.entries()) {
    if (!claim.quote || !maskedSource.includes(claim.quote)) codes.push(`quote:${index}`);
    const compact = compactAmount(claim.amount);
    const quoteCompact = compactAmount(claim.quote ?? '');
    const amountInQuote = Boolean(compact) && Boolean(claim.quote) && quoteCompact.includes(compact);
    if (!amountInQuote) codes.push(`amount:${index}`);
  }
  return codes;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample<T>(items: T[], count: number, seed: number): T[] {
  const copy = items.slice();
  const rand = mulberry32(seed);
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy.slice(0, Math.min(count, copy.length));
}

async function loadCorpus(): Promise<CensusCase[]> {
  const allA = await readJsonl<CorpusARow>(CORPUS_A);
  const aIds = new Set(allA.map((row) => row.id));
  const byThread = new Map<string, CorpusARow[]>();
  for (const row of allA) {
    const list = byThread.get(row.threadId) ?? [];
    list.push(row);
    byThread.set(row.threadId, list);
  }

  const cases: CensusCase[] = [];
  for (const row of allA) {
    if (row.businessDirection !== 'inbound' || row.contextOnly) continue;
    const selectedAt = row.receivedAt ? Date.parse(row.receivedAt) : Number.NaN;
    const thread = byThread.get(row.threadId) ?? [];
    const preceding = thread
      .filter((candidate) => candidate.id !== row.id)
      .filter((candidate) => {
        if (!candidate.receivedAt || Number.isNaN(selectedAt)) return false;
        return Date.parse(candidate.receivedAt) <= selectedAt;
      })
      .sort((left, right) => {
        const delta = Date.parse(left.receivedAt ?? '') - Date.parse(right.receivedAt ?? '');
        if (delta !== 0) return delta;
        return left.id.localeCompare(right.id);
      })
      .map((candidate) => ({ bodyText: messageBody(candidate) }));

    cases.push({
      id: row.id,
      corpus: 'A',
      selection: {
        subject: row.subject ?? '',
        bodyText: messageBody(row),
        receivedAt: row.receivedAt ?? undefined,
        preceding,
        attachments: unreadPdfAttachments(row.attachmentDescriptors ?? []),
      },
    });
  }

  const shardNames = (await readdir(CORPUS_B_DIR))
    .filter((name) => name.endsWith('-bodies.jsonl'))
    .sort();
  for (const name of shardNames) {
    const rows = await readJsonl<CorpusBRow>(path.join(CORPUS_B_DIR, name));
    for (const row of rows) {
      if (aIds.has(row.inboundId)) continue;
      const attachments: SyncedQuoteSelection['attachments'] = [];
      if (row.attachmentText) {
        attachments.push({
          id: `${row.inboundId}-att`,
          filename: 'attachment.pdf',
          bytesPresent: true,
          text: row.attachmentText,
        });
      }
      cases.push({
        id: row.inboundId,
        corpus: 'B',
        selection: {
          subject: row.subject ?? '',
          bodyText: row.textBody ?? '',
          preceding: [],
          attachments,
        },
      });
    }
  }
  return cases;
}

async function loadDone(
  rowsPath: string,
): Promise<{ ids: Set<string>; costUsd: number; rows: CensusRow[] }> {
  const ids = new Set<string>();
  let costUsd = 0;
  const rows: CensusRow[] = [];
  try {
    const existing = await readJsonl<CensusRow>(rowsPath);
    for (const row of existing) {
      ids.add(row.id);
      costUsd += row.costUsd ?? 0;
      rows.push(row);
      if (row.analysis) {
        const parsed = lunaAnalysisSchema.safeParse(row.analysis);
        if (parsed.success) row.analysis = parsed.data;
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
  return { ids, costUsd, rows };
}

function countMap(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function markdownTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

function deferredUnlocks(rows: CensusRow[], analyses: Map<string, LunaAnalysis>) {
  const b1 = rows.filter((row) => row.flags.includes('multi_date')).length;
  let a3 = 0;
  let amendment = 0;
  let cancel = 0;
  let alternatives = 0;
  for (const row of rows) {
    const analysis = analyses.get(row.id);
    if (!analysis) continue;
    const kinds = new Set(analysis.tasks.map((task) => task.kind));
    if (
      analysis.workflow === 'create_booking' &&
      (analysis.party.reference || kinds.has('quote'))
    ) {
      a3 += 1;
    }
    if (analysis.flags.includes('amendment_or_cancel') || kinds.has('amend')) {
      amendment += 1;
    }
    if (kinds.has('cancel')) cancel += 1;
    if (kinds.has('availability')) alternatives += 1;
  }
  return [
    { item: 'B1 multi-date', rows: b1 },
    { item: 'A3 accept-prior-quote', rows: a3 },
    { item: 'amendment', rows: amendment },
    { item: 'cancel', rows: cancel },
    { item: 'alternatives', rows: alternatives },
  ].sort((left, right) => right.rows - left.rows);
}

function writeSummary(input: {
  cases: number;
  done: CensusRow[];
  analyses: Map<string, LunaAnalysis>;
  costUsd: number;
  costCapped: boolean;
  inventedAfterTune?: number;
}): string {
  const luna = input.done.filter((row) => row.source === 'luna');
  const fallback = input.done.filter((row) => row.source !== 'luna');
  const workflows = countMap(luna.map((row) => row.workflow));
  const buckets = countMap(input.done.map((row) => row.bucket));
  const flagValues = luna.flatMap((row) => row.flags);
  const flags = countMap(flagValues);
  const invented = input.done.filter((row) => row.inventedPrice).length;
  const multi = luna.filter((row) => row.taskKinds.length > 1).length;
  const sequences = countMap(luna.map((row) => row.taskSequence || '(none)'));
  const topSeq = Object.entries(sequences)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 15);
  const amendTasks = luna.filter((row) => row.taskKinds.includes('amend')).length;
  const cancelTasks = luna.filter((row) => row.taskKinds.includes('cancel')).length;
  const availabilityTasks = luna.filter((row) => row.taskKinds.includes('availability')).length;
  const deferred = deferredUnlocks(luna, input.analyses);

  const lines: string[] = [
    '# Luna case census',
    '',
    'Aggregates only. No message bodies, names, or addresses.',
    '',
    `Cases in corpus: ${input.cases}`,
    `Rows written: ${input.done.length} (luna ${luna.length}, fallback ${fallback.length})`,
    `Cost USD: ${input.costUsd.toFixed(4)}${input.costCapped ? ' (HIT CAP)' : ''}`,
    `Invented prices: ${invented}`,
    '',
    '## Workflows',
    markdownTable(
      ['workflow', 'n'],
      ['quote', 'create_booking', 'other'].map((key) => [key, String(workflows[key] ?? 0)]),
    ),
    '',
    '## Flags',
    markdownTable(
      ['flag', 'n'],
      Object.entries(flags)
        .sort((left, right) => right[1] - left[1])
        .map(([flag, n]) => [flag, String(n)]),
    ),
    '',
    '## Buckets',
    markdownTable(
      ['bucket', 'n'],
      ['full', 'partial', 'manual', 'other'].map((key) => [key, String(buckets[key] ?? 0)]),
    ),
    '',
    `staffEquivalent: ${luna.filter((row) => row.staffEquivalent).length} (old full ${buckets.full ?? 0})`,
    '',
    '## Multi-tool (K14)',
    `Rows with tasks.length > 1: ${multi}`,
    `amend tasks: ${amendTasks}; cancel tasks: ${cancelTasks}; availability tasks: ${availabilityTasks}`,
    '',
    markdownTable(
      ['sequence', 'n'],
      topSeq.map(([seq, n]) => [seq, String(n)]),
    ),
    '',
    '## Deferred items ranked by rows unlocked',
    markdownTable(
      ['item', 'rows'],
      deferred.map((row) => [row.item, String(row.rows)]),
    ),
  ];
  if (input.inventedAfterTune !== undefined) {
    lines.push('', `Invented prices after prompt-tuning round 1: ${input.inventedAfterTune}`);
  }
  return `${lines.join('\n')}\n`;
}

function excerptForCheck(selection: SyncedQuoteSelection): string {
  const prompt = buildQuoteWorkflowPrompt(selection);
  const masked = maskCardNumbers(prompt.user);
  return masked.length > 800 ? `${masked.slice(0, 800)}…` : masked;
}

function writeCheck30(
  cases: CensusCase[],
  done: CensusRow[],
  analyses: Map<string, LunaAnalysis>,
): string {
  const byId = new Map(cases.map((item) => [item.id, item]));
  const luna = done.filter((row) => row.source === 'luna');
  const quote = sample(
    luna.filter((row) => row.workflow === 'quote'),
    10,
    CHECK_SEED,
  );
  const booking = sample(
    luna.filter((row) => row.workflow === 'create_booking'),
    10,
    CHECK_SEED + 1,
  );
  const other = sample(
    luna.filter((row) => row.workflow === 'other'),
    10,
    CHECK_SEED + 2,
  );
  const sections: Array<[string, CensusRow[]]> = [
    ['quote', quote],
    ['booking', booking],
    ['other', other],
  ];
  const parts = [
    '# Check 30',
    '',
    'Seed 42. Masked excerpts plus analysis. Private file — do not commit.',
    '',
  ];
  for (const [label, rows] of sections) {
    parts.push(`## ${label} (${rows.length})`, '');
    for (const row of rows) {
      const kase = byId.get(row.id);
      const analysis = analyses.get(row.id);
      parts.push(`### ${row.id}`);
      parts.push(
        `corpus=${row.corpus} bucket=${row.bucket} invented=${row.inventedPrice} flags=${row.flags.join(',') || '(none)'} tasks=${row.taskSequence || '(none)'}`,
      );
      if (kase) {
        parts.push('', '#### excerpt', '', '```', excerptForCheck(kase.selection), '```');
      }
      if (analysis) {
        parts.push('', '#### analysis', '', '```json', JSON.stringify(analysis, null, 2), '```');
      }
      parts.push('');
    }
  }
  return parts.join('\n');
}

async function main(): Promise<void> {
  if (process.env.DATABASE_URL) {
    throw new Error('luna-case-census refuses DATABASE_URL (unset before invoke)');
  }
  if (process.env.VITEST_ALLOW_PILOT_RDS === '1') {
    throw new Error('luna-case-census refuses VITEST_ALLOW_PILOT_RDS=1');
  }
  if (process.env.TEST_DATABASE_URL) {
    throw new Error('luna-case-census refuses TEST_DATABASE_URL (unset before invoke)');
  }

  const args = parseArgs(process.argv.slice(2));
  if (!process.env.AZURE_OPENAI_BASE_URL) {
    const fromToml = loadAzureBaseUrlFromCodex();
    if (fromToml) process.env.AZURE_OPENAI_BASE_URL = fromToml;
  }

  await mkdir(args.outDir, { recursive: true });
  const rowsPath = path.join(args.outDir, 'rows.jsonl');
  const summaryPath = path.join(args.outDir, 'summary.md');
  const checkPath = path.join(args.outDir, 'check-30.md');

  if (args.dropIds.size > 0) {
    const existing = await loadDone(rowsPath);
    const kept = existing.rows.filter((row) => !args.dropIds.has(row.id));
    await writeFile(
      rowsPath,
      kept.map((row) => JSON.stringify(row)).join('\n') + (kept.length ? '\n' : ''),
    );
  }

  const cases = await loadCorpus();
  const limited = args.limit > 0 ? cases.slice(0, args.limit) : cases;
  const doneState = await loadDone(rowsPath);
  const pending = limited.filter((item) => !doneState.ids.has(item.id));

  let adapter: LunaModelAdapter | null = null;
  try {
    adapter = new LunaModelAdapter({
      model: createAzureLunaModel(),
      reasoningEffort: 'medium',
      routeId: 'azure_quote',
      modelId: 'gpt-6-luna',
      protocol: 'azure-openai-responses',
    });
  } catch {
    adapter = null;
  }

  const enabled = quoteWorkflowLlmEnabled(process.env) && Boolean(adapter);
  if (!enabled || !adapter) {
    console.error('census_blocked: azure_unavailable');
    process.exitCode = 1;
    return;
  }
  const liveAdapter = adapter;

  let spent = doneState.costUsd;
  let writeChain = Promise.resolve();
  let costCapped = spent >= args.costCap;
  const analyses = new Map<string, LunaAnalysis>();
  for (const row of doneState.rows) {
    if (row.analysis) analyses.set(row.id, row.analysis);
  }

  const appendRow = (row: CensusRow, analysis?: LunaAnalysis) => {
    writeChain = writeChain.then(async () => {
      await appendFile(rowsPath, `${JSON.stringify(row)}\n`);
    });
    if (analysis) analyses.set(row.id, analysis);
    return writeChain;
  };

  const trackUsage = () => {
    const box = { usd: 0, latencyMs: 0 };
    return {
      box,
      adapter: {
        invoke: async (input: Parameters<LunaModelAdapter['invoke']>[0]) => {
          try {
            const result = await liveAdapter.invoke(input);
            box.usd = result.usage.estimatedCostUsd;
            box.latencyMs = result.usage.latencyMs;
            return result;
          } catch (error) {
            const usage = (error as { usage?: { estimatedCostUsd?: number; latencyMs?: number } }).usage;
            if (usage && Number.isFinite(usage.estimatedCostUsd)) {
              box.usd = usage.estimatedCostUsd ?? 0;
              box.latencyMs = usage.latencyMs ?? 0;
            }
            throw error;
          }
        },
      },
    };
  };

  let cursor = 0;
  const workers = Array.from({ length: args.concurrency }, async () => {
    while (true) {
      if (spent >= args.costCap) {
        costCapped = true;
        return;
      }
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) return;
      const item = pending[index]!;
      const tracked = trackUsage();
      const result = await analyseQuoteSelection({
        selection: item.selection,
        adapter: tracked.adapter,
        enabled: true,
      });
      const costUsd = tracked.box.usd;
      spent += costUsd;

      if (result.source !== 'luna') {
        const row: CensusRow = {
          id: item.id,
          corpus: item.corpus,
          source: result.source,
          fallbackReason: result.fallbackReason,
          workflow: 'unavailable',
          flags: [],
          bucket: 'other',
          staffEquivalent: false,
          inventedPrice: false,
          inventedPriceCodes: [],
          taskKinds: [],
          taskSequence: '',
          missingPricing: true,
          costUsd,
          latencyMs: tracked.box.latencyMs,
        };
        await appendRow(row);
      } else {
        const parsed = lunaAnalysisSchema.safeParse(result.analysis);
        const analysis = parsed.success ? parsed.data : result.analysis;
        const maskedSource = buildQuoteWorkflowPrompt(item.selection).user;
        const inventedCodes = inventedPriceCodes(analysis, maskedSource);
        const kinds = analysis.tasks.map((task) => task.kind);
        const row: CensusRow = {
          id: item.id,
          corpus: item.corpus,
          source: 'luna',
          workflow: analysis.workflow,
          flags: analysis.flags,
          bucket: bucketOf(analysis),
          staffEquivalent: staffEquivalentOf(analysis),
          inventedPrice: inventedCodes.length > 0,
          inventedPriceCodes: inventedCodes,
          taskKinds: kinds,
          taskSequence: kinds.join('>'),
          missingPricing: missingPricing(analysis),
          costUsd,
          latencyMs: tracked.box.latencyMs,
          analysis,
        };
        await appendRow(row, analysis);
      }

      if ((index + 1) % 5 === 0 || index + 1 === pending.length) {
        console.log(`progress newly=${index + 1}/${pending.length} cost_usd=${spent.toFixed(4)}`);
      }
    }
  });
  await Promise.all(workers);
  await writeChain;

  const after = await loadDone(rowsPath);
  for (const row of after.rows) {
    if (row.analysis) analyses.set(row.id, row.analysis);
  }
  const lunaRows = after.rows.filter((row) => row.source === 'luna');
  const summary = writeSummary({
    cases: cases.length,
    done: after.rows,
    analyses,
    costUsd: after.costUsd,
    costCapped,
  });
  await writeFile(summaryPath, summary);

  if (args.limit === 0 || after.rows.length >= 30) {
    const check = writeCheck30(cases, after.rows, analyses);
    await writeFile(checkPath, check);
  }

  const invented = after.rows.filter((row) => row.inventedPrice).length;
  const workflows = countMap(lunaRows.map((row) => String(row.workflow)));
  const buckets = countMap(after.rows.map((row) => row.bucket));
  console.log(
    JSON.stringify({
      ok: !costCapped,
      corpus: cases.length,
      wrote: after.rows.length,
      luna: lunaRows.length,
      fallback: after.rows.length - lunaRows.length,
      workflows,
      buckets,
      inventedPrices: invented,
      staffEquivalent: lunaRows.filter((row) => row.staffEquivalent).length,
      multiTool: lunaRows.filter((row) => row.taskKinds.length > 1).length,
      costUsd: Number(after.costUsd.toFixed(6)),
      costCapped,
    }),
  );

  if (args.limit > 0) {
    const sampleRows = lunaRows.slice(0, 5);
    for (const row of sampleRows) {
      console.log(
        `eyeball id_hash=${row.id.slice(0, 8)} workflow=${row.workflow} bucket=${row.bucket} flags=${row.flags.length} invented=${row.inventedPrice} tasks=${row.taskKinds.length} cost=${row.costUsd.toFixed(4)}`,
      );
    }
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'census_failed');
    process.exitCode = 1;
  });
}
