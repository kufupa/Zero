/**
 * Dual-hotel quote price gold replay (U12). Offline fixtures only.
 *
 * Prod input: readQuoteAttachments → live PANE_BRAIN prompt path.
 * Live default PANE_BRAIN is classifier, so the prompt is buildQuoteWorkflowPrompt.
 * PANE_BRAIN=agent uses selectionToAgentPrompt. Quotes run one at a time.
 *
 * Score: rate plan + price per night vs staff PDF/Excel/reply.
 * Exact match pass; price mismatch with no named HMS reason fail;
 * named HMS refusal (fully booked) pass per PRODUCT; non-plannable excluded.
 *
 * No --apply. No live mail. No HMS write. Stdout is counts. Masked ids only.
 *
 *   pnpm --dir apps/server-pilot exec tsx scripts/quote-price-gold-replay.ts \
 *     --fixture <asks.jsonl> --out <scores.jsonl>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { paneBrain } from '../src/ai/pane-brain.js';
import { buildQuoteWorkflowPrompt } from '../src/ai/quote-workflow-llm.js';
import {
  readQuoteAttachments,
  type QuoteAttachmentRow,
  type SyncedQuoteSelection,
} from '../src/ai/quote-workflow-synced-selection.js';
import { isNamedRefusal } from './nava-quote-proof-result.js';

/** Plan §1: evidence scoped after the 2026-10-20 18:01Z ARCHITECTURE.md cut-off. */
export const QUOTE_PRICE_CUTOFF_ISO = '2026-10-20T18:01:00.000Z';

export type HotelCode = 'HRCEN' | 'HRDAV';
export type QuotePriceProdInput =
  | 'readQuoteAttachments → buildQuoteWorkflowPrompt'
  | 'readQuoteAttachments → selectionToAgentPrompt';

export type StaffQuoteTruth = { ratePlan: string; pricePerNightMinor: number };
export type QuoteAskAttachment = {
  id: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  text: string;
};
export type QuoteAskFixture = {
  id: string;
  hotel: HotelCode;
  askedAt: string;
  staffSent: { pdf?: boolean; excel?: boolean; reply?: boolean };
  staffTruth?: StaffQuoteTruth;
  plannable?: boolean;
  excludeReason?: string;
  attachments?: QuoteAskAttachment[];
  nava?: QuoteQueueResult;
};

export type QuoteQueueJob = {
  id: string;
  hotel: HotelCode;
  promptPath: QuotePriceProdInput;
  prompt: string;
};
export type QuoteQueueResult =
  | { status: 'priced'; ratePlan: string; pricePerNightMinor: number; hmsReason?: string }
  | { status: 'refused'; outcome: string }
  | { status: 'error'; reason: string };
export type QuoteQueueRunner = (job: QuoteQueueJob) => Promise<QuoteQueueResult>;

export type QuoteScoreRow = {
  id: string;
  hotel: HotelCode;
  verdict: 'pass' | 'fail' | 'excluded';
  reason: string;
};
export type HotelScore = {
  n: number;
  plannable: number;
  passed: number;
  failed: number;
  excluded: number;
};
export type QuotePriceSummary = {
  n: number;
  plannable: number;
  passed: number;
  failed: number;
  excluded: number;
  byHotel: Record<HotelCode, HotelScore>;
  misses: Array<{ id: string; reason: string }>;
  prodInput: QuotePriceProdInput;
  scoreKind: 'behaviour_check';
};
export type QuotePriceCli = { fixturePath: string; outPath: string };

const USAGE = 'quote-price-gold-replay.ts --fixture <asks.jsonl> --out <scores.jsonl>';
const HOTELS: HotelCode[] = ['HRCEN', 'HRDAV'];

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export function quotePriceProdInput(env: NodeJS.Dict<string> = process.env): QuotePriceProdInput {
  return paneBrain(env) === 'agent'
    ? 'readQuoteAttachments → selectionToAgentPrompt'
    : 'readQuoteAttachments → buildQuoteWorkflowPrompt';
}

function hasStaffSent(ask: QuoteAskFixture): boolean {
  return Boolean(ask.staffSent.pdf || ask.staffSent.excel || ask.staffSent.reply);
}

function askedAtMs(ask: QuoteAskFixture): number {
  const time = Date.parse(ask.askedAt);
  return Number.isFinite(time) ? time : 0;
}

/** Most recent staff-answered quote asks per hotel since the cut-off. */
export function selectRecentQuoteAsks(
  asks: readonly QuoteAskFixture[],
  options: { cutoff?: Date } = {},
): QuoteAskFixture[] {
  const cutoffMs = (options.cutoff ?? new Date(QUOTE_PRICE_CUTOFF_ISO)).getTime();
  const picked: QuoteAskFixture[] = [];
  for (const hotel of HOTELS) {
    const candidates = asks
      .filter((row) => row.hotel === hotel && hasStaffSent(row) && askedAtMs(row) >= cutoffMs)
      .slice()
      .sort((a, b) => askedAtMs(b) - askedAtMs(a) || a.id.localeCompare(b.id));
    picked.push(...candidates);
  }
  return picked;
}

function normPlan(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function scoreQuotePriceRow(input: { staff: StaffQuoteTruth; nava: QuoteQueueResult }): {
  verdict: 'pass' | 'fail';
  reason: string;
} {
  const { staff, nava } = input;
  if (nava.status === 'refused') {
    return isNamedRefusal(nava.outcome)
      ? { verdict: 'pass', reason: 'named_hms_refusal' }
      : { verdict: 'fail', reason: 'unnamed_refusal' };
  }
  if (nava.status === 'priced') {
    const match =
      normPlan(nava.ratePlan) === normPlan(staff.ratePlan) &&
      nava.pricePerNightMinor === staff.pricePerNightMinor;
    if (match) return { verdict: 'pass', reason: 'exact_match' };
    if (nava.hmsReason && isNamedRefusal(`refused: ${nava.hmsReason}`)) {
      return { verdict: 'pass', reason: 'hms_explained' };
    }
    return { verdict: 'fail', reason: 'price_mismatch' };
  }
  return { verdict: 'fail', reason: nava.reason || 'quote_error' };
}

function emptyHotel(): HotelScore {
  return { n: 0, plannable: 0, passed: 0, failed: 0, excluded: 0 };
}

function attachmentRow(attachment: QuoteAskAttachment): QuoteAttachmentRow {
  return {
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType ?? 'application/pdf',
    sizeBytes: attachment.sizeBytes ?? Math.max(1_000, attachment.text.length),
    isInline: false,
    s3Key: `fixture/${attachment.id}`,
    messageId: 'fixture-message',
  };
}

async function prodPromptForAsk(
  ask: QuoteAskFixture,
  promptPath: QuotePriceProdInput,
): Promise<string> {
  const files = ask.attachments ?? [];
  const texts = new Map(files.map((file) => [file.id, file.text]));
  const attachments = await readQuoteAttachments(files.map(attachmentRow), async (row) => ({
    text: texts.get(row.id) ?? null,
  }));
  const selection: SyncedQuoteSelection = {
    subject: 'Synthetic quote ask',
    bodyText: 'Please quote one room.',
    receivedAt: ask.askedAt,
    preceding: [],
    attachments,
    messageId: ask.id,
    threadId: ask.id,
  };
  if (promptPath === 'readQuoteAttachments → selectionToAgentPrompt') {
    const { selectionToAgentPrompt } = await import('../src/ai/agent-pane-adapter.js');
    return selectionToAgentPrompt(selection);
  }
  return buildQuoteWorkflowPrompt(selection).user;
}

function excludeAsk(ask: QuoteAskFixture): QuoteScoreRow | null {
  if (ask.plannable === false) {
    return { id: ask.id, hotel: ask.hotel, verdict: 'excluded', reason: ask.excludeReason || 'non_plannable' };
  }
  if (!hasStaffSent(ask)) {
    return { id: ask.id, hotel: ask.hotel, verdict: 'excluded', reason: 'no_staff_output' };
  }
  if (!ask.staffTruth) {
    return { id: ask.id, hotel: ask.hotel, verdict: 'excluded', reason: 'unparseable_staff_price' };
  }
  return null;
}

export async function runQuotePriceGoldReplay(
  asks: readonly QuoteAskFixture[],
  deps: {
    runQuote: QuoteQueueRunner;
    env?: NodeJS.Dict<string>;
    cutoff?: Date;
  },
): Promise<{ rows: QuoteScoreRow[]; summary: QuotePriceSummary }> {
  const promptPath = quotePriceProdInput(deps.env);
  const selected = selectRecentQuoteAsks(asks, { cutoff: deps.cutoff });
  const rows: QuoteScoreRow[] = [];
  for (const ask of selected) {
    const excluded = excludeAsk(ask);
    if (excluded) {
      rows.push(excluded);
      continue;
    }
    const staff = ask.staffTruth;
    if (!staff) {
      rows.push({ id: ask.id, hotel: ask.hotel, verdict: 'excluded', reason: 'unparseable_staff_price' });
      continue;
    }
    const prompt = await prodPromptForAsk(ask, promptPath);
    const nava = await deps.runQuote({ id: ask.id, hotel: ask.hotel, promptPath, prompt });
    const scored = scoreQuotePriceRow({ staff, nava });
    rows.push({ id: ask.id, hotel: ask.hotel, verdict: scored.verdict, reason: scored.reason });
  }
  const byHotel: Record<HotelCode, HotelScore> = { HRCEN: emptyHotel(), HRDAV: emptyHotel() };
  for (const row of rows) {
    const hotel = byHotel[row.hotel];
    hotel.n += 1;
    if (row.verdict === 'excluded') hotel.excluded += 1;
    else {
      hotel.plannable += 1;
      if (row.verdict === 'pass') hotel.passed += 1;
      else hotel.failed += 1;
    }
  }
  const plannable = byHotel.HRCEN.plannable + byHotel.HRDAV.plannable;
  const passed = byHotel.HRCEN.passed + byHotel.HRDAV.passed;
  const failed = byHotel.HRCEN.failed + byHotel.HRDAV.failed;
  const excluded = byHotel.HRCEN.excluded + byHotel.HRDAV.excluded;
  return {
    rows,
    summary: {
      n: rows.length,
      plannable,
      passed,
      failed,
      excluded,
      byHotel,
      misses: rows
        .filter((row) => row.verdict !== 'pass')
        .map((row) => ({ id: row.id, reason: row.reason })),
      prodInput: promptPath,
      scoreKind: 'behaviour_check',
    },
  };
}

export function formatQuotePriceStdout(summary: QuotePriceSummary): string {
  const { misses: _misses, ...counts } = summary;
  return `${JSON.stringify(counts)}\n`;
}

export function parseQuotePriceGoldReplayArgs(argv: readonly string[]): QuotePriceCli {
  if (argv.includes('--apply')) throw codedError('apply_forbidden');
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') throw codedError('usage');
    if (arg === '--fixture' || arg === '--out') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw codedError('usage');
      flags.set(arg, value);
      i += 1;
      continue;
    }
    throw codedError('unknown_option');
  }
  const fixturePath = flags.get('--fixture');
  const outPath = flags.get('--out');
  if (!fixturePath || !outPath) throw codedError('usage');
  for (const candidate of [fixturePath, outPath]) {
    if (/^(postgres|postgresql|https?):\/\//i.test(candidate)) throw codedError('local_paths_only');
  }
  return { fixturePath, outPath };
}

function parseFixtureJsonl(text: string): QuoteAskFixture[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw codedError('fixture_empty');
  return lines.map((line) => {
    const row = JSON.parse(line) as QuoteAskFixture;
    if (!row?.id || (row.hotel !== 'HRCEN' && row.hotel !== 'HRDAV') || !row.askedAt) {
      throw codedError('invalid_fixture');
    }
    return row;
  });
}

function fixtureRunner(asks: readonly QuoteAskFixture[]): QuoteQueueRunner {
  const byId = new Map(asks.map((ask) => [ask.id, ask]));
  return async (job) => {
    const nava = byId.get(job.id)?.nava;
    if (!nava) throw codedError('nava_result_required');
    return nava;
  };
}

export async function runQuotePriceGoldReplayCli(argv: readonly string[]): Promise<number> {
  let cli: QuotePriceCli;
  try {
    cli = parseQuotePriceGoldReplayArgs(argv);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'usage';
    process.stderr.write(`${JSON.stringify({ error: code, usage: USAGE })}\n`);
    return 2;
  }
  try {
    const fixturePath = path.resolve(cli.fixturePath);
    const outPath = path.resolve(cli.outPath);
    if (!existsSync(fixturePath)) throw codedError('fixture_not_found');
    if (existsSync(outPath)) throw codedError('out_exists');
    const asks = parseFixtureJsonl(readFileSync(fixturePath, 'utf8'));
    const result = await runQuotePriceGoldReplay(asks, { runQuote: fixtureRunner(asks) });
    writeFileSync(outPath, `${result.rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    process.stdout.write(formatQuotePriceStdout(result.summary));
    return 0;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as { code: string }).code) : 'replay_failed';
    process.stderr.write(`${JSON.stringify({ error: code === 'ENOENT' ? 'fixture_not_found' : code })}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void runQuotePriceGoldReplayCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
