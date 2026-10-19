import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { quoteProofPass } from './nava-quote-proof-result.js';
import type { QuoteProofSummary } from './nava-quote-proof.js';
import type { DB } from '../src/db/client.js';
import { mailActionLabel, message } from '../src/db/schema/mail.js';
import { mailExtraction } from '../src/db/schema/work.js';
import type { MailAction } from '../src/mail/action-labels.js';

const DEFAULT_TRANSPORT_ID = 'transport-centurion';
const QUOTE_BLOCKERS = new Set([
  'source_not_found', 'extraction_not_succeeded', 'not_quote', 'not_inbound', 'history_copy', 'spam',
  'system_notice', 'no_action', 'channel_or_ota', 'triage_pending', 'missing_sender', 'mailbox_sender',
  'staff_sender',
  'party_match_pending', 'invalid_extraction', 'invalid_quote_input', 'missing_stay', 'missing_dates',
  'invalid_dates', 'past_dates', 'stay_too_long', 'missing_rooms', 'too_many_room_types',
  'missing_occupancy', 'room_type_unresolved', 'not_ready',
]);
const PROOF_BLOCKERS = new Set([
  'needs_edits', 'guard_blocked', 'crashed', 'rates_timeout', 'rates_failed', 'partial_rate_refusal',
  'not_quote', 'rates_screenshot_missing', 'documents_failed', 'documents_screenshot_missing',
]);

export type NavaScorecardOptions = { transportId: string; since: Date; limit: number };
type Metric = { cohortHash: string; percent: number | null };
type Readiness = Metric & { prefillable: number; quoteMessages: number; quoteThreads: number; blockerHistogram: Record<string, number> };
type Proof = Metric & { passed: number; threads: number; blockerHistogram: Record<string, number> };
type Pair = { owner: MailAction; nava: MailAction | 'missing'; count: number };
type OwnerGoldRow = { messageId: string; threadId: string; action: MailAction; receivedAt: Date };
type QuoteEvaluator = (input: { messageId: string; transportId: string }, db: DB, now: Date) => Promise<{
  plan: { inputs: readonly unknown[] } | null;
  reason: string | null;
}>;
export type NavaScorecard = {
  schemaVersion: 2; generatedAt: string;
  filters: { transportId: string; since: string; limit: number; messages: number; threads: number; navaLabelSource: 'mail_extraction.kind' };
  classification: { ownerGoldLabels: number; ownerGoldThreads: number; ownerGoldMessagesInLimit: number; compared: number; missingPrediction: number; agreement: { correct: number; denominator: number; percent: number | null }; confusionPairs: Pair[]; cohortHash: string };
  quoteReadiness: Readiness; quoteProof: Proof | null;
  regressions: Array<{ section: string; baselinePercent: number; currentPercent: number; delta: number }>;
  comparisonSkipped: string[];
};

export function parseNavaScorecardArgs(
  args: string[],
): NavaScorecardOptions & { out: string; quoteProofPath?: string; baselinePath?: string } {
  const allowed = ['--transport-id', '--since', '--limit', '--out', '--quote-proof', '--baseline'];
  const values = new Map<string, string>();
  const invalid = () => new Error('Invalid scorecard options');
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!, value = args[++i];
    if (!allowed.includes(key) || values.has(key) || !value?.trim() || value.startsWith('--')) throw invalid();
    values.set(key, value);
  }
  const sinceText = values.get('--since') ?? '', since = new Date(sinceText);
  const limit = Number(values.get('--limit')), out = values.get('--out');
  const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
  if (
    !isoDate.test(sinceText) || !Number.isFinite(since.getTime()) ||
    !Number.isSafeInteger(limit) || limit < 1 || !out
  ) throw invalid();
  return {
    transportId: values.get('--transport-id')?.trim() || DEFAULT_TRANSPORT_ID,
    since,
    limit,
    out,
    ...(values.has('--quote-proof') ? { quoteProofPath: values.get('--quote-proof')! } : {}),
    ...(values.has('--baseline') ? { baselinePath: values.get('--baseline')! } : {}),
  };
}

const percent = (n: number, d: number): number | null => (d ? (n / d) * 100 : null);
const digest = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const add = (histogram: Record<string, number>, key: string) => { histogram[key] = (histogram[key] ?? 0) + 1; };
const quoteBlocker = (reason: string | null) => reason && QUOTE_BLOCKERS.has(reason) ? reason : 'other';
function proofBlocker(blocker: string | null, outcome: string | null): string {
  const key = blocker?.split(/[:\s]/, 1)[0]?.toLowerCase();
  if (key && PROOF_BLOCKERS.has(key)) return key;
  return blocker || outcome ? 'other' : 'rates_unavailable';
}
const storedActionForKind = (kind: string | null | undefined): MailAction | null =>
  ({ quote: 'quote_availability', booking: 'new_booking', amendment: 'amend', cancellation: 'cancel',
    voucher_pop: 'payment_proof', spam: 'no_action', other: 'no_action' } as Partial<Record<string, MailAction>>)[kind ?? ''] ?? null;
function metrics(s: NavaScorecard): Array<{ section: string; cohortHash: string; percent: number | null } | null> {
  return [
    { section: 'classification', cohortHash: s.classification.cohortHash, percent: s.classification.agreement.percent },
    { section: 'quoteReadiness', ...s.quoteReadiness },
    s.quoteProof && { section: 'quoteProof', ...s.quoteProof },
  ];
}

export async function buildNavaScorecard(
  db: DB, options: NavaScorecardOptions,
  dependencies: {
    quoteProof?: QuoteProofSummary;
    baseline?: NavaScorecard;
    evaluateQuoteReady?: QuoteEvaluator;
    now?: Date;
  } = {},
): Promise<NavaScorecard> {
  const scoped = await db.select({ id: message.id, threadId: message.threadId, receivedAt: message.receivedAt }).from(message).where(and(
    eq(message.transportId, options.transportId), eq(message.direction, 'inbound'),
    gte(message.receivedAt, options.since),
  )).orderBy(desc(message.receivedAt), desc(message.id)).limit(options.limit);
  const limitedIds = new Set(scoped.map((row) => row.id));
  const latestInboundByThread = new Map([...scoped].reverse().map((row) => [row.threadId, row] as const));

  const ownerLabels = await db.select({ messageId: mailActionLabel.messageId, action: mailActionLabel.action }).from(mailActionLabel).where(and(
    eq(mailActionLabel.transportId, options.transportId),
    eq(mailActionLabel.source, 'owner'),
    eq(mailActionLabel.version, 'owner'),
  ));
  const ownerMessageIds = [...new Set(ownerLabels.map((row) => row.messageId))];
  const ownerMessages = await db.select({ id: message.id, threadId: message.threadId, receivedAt: message.receivedAt }).from(message).where(and(
    eq(message.transportId, options.transportId), eq(message.direction, 'inbound'),
    gte(message.receivedAt, options.since), inArray(message.id, ownerMessageIds),
  ));
  const ownerMessageById = new Map(ownerMessages.map((row) => [row.id, row]));
  const ownerGoldRows: OwnerGoldRow[] = ownerLabels.flatMap(({ messageId, action }) => {
    const source = ownerMessageById.get(messageId);
    return source?.receivedAt ? [{ messageId, threadId: source.threadId, action, receivedAt: source.receivedAt }] : [];
  });
  const ownerGoldByThread = new Map<string, OwnerGoldRow>();
  for (const row of ownerGoldRows) {
    const previous = ownerGoldByThread.get(row.threadId);
    if (!previous || row.receivedAt > previous.receivedAt ||
      (row.receivedAt.getTime() === previous.receivedAt.getTime() && row.messageId > previous.messageId)) ownerGoldByThread.set(row.threadId, row);
  }

  const relevantIds = [...new Set([
    ...scoped.map((row) => row.id), ...[...ownerGoldByThread.values()].map((row) => row.messageId),
  ])];
  const storedReads = await db.select({ messageId: mailExtraction.messageId, kind: mailExtraction.kind }).from(mailExtraction).where(and(
    inArray(mailExtraction.messageId, relevantIds), eq(mailExtraction.status, 'succeeded'),
  )).orderBy(desc(mailExtraction.createdAt), desc(mailExtraction.id));
  const relevantIdSet = new Set(relevantIds);
  const latestStoredReadByMessage = new Map<string, (typeof storedReads)[number]>();
  for (const read of storedReads) if (relevantIdSet.has(read.messageId) && !latestStoredReadByMessage.has(read.messageId)) latestStoredReadByMessage.set(read.messageId, read);

  const goldByThread = [...ownerGoldByThread].sort(([a], [b]) => a.localeCompare(b));
  const confusion = new Map<string, Pair>();
  let correct = 0;
  let compared = 0;
  let missingPrediction = 0;
  for (const [, row] of goldByThread) {
    const nava = storedActionForKind(latestStoredReadByMessage.get(row.messageId)?.kind) ?? 'missing';
    const key = `${row.action}:${nava}`;
    const previous = confusion.get(key);
    confusion.set(key, { owner: row.action, nava, count: (previous?.count ?? 0) + 1 });
    if (nava === 'missing') missingPrediction++;
    else {
      compared++;
      if (row.action === nava) correct++;
    }
  }
  const confusionPairs = [...confusion.values()];
  confusionPairs.sort((a, b) => a.owner.localeCompare(b.owner) || a.nava.localeCompare(b.nava));

  const quoteMessages = scoped.filter((row) => latestStoredReadByMessage.get(row.id)?.kind === 'quote').length;
  const quoteThreadRows = [...latestInboundByThread.values()]
    .filter((row) => latestStoredReadByMessage.get(row.id)?.kind === 'quote')
    .sort((a, b) => a.threadId.localeCompare(b.threadId));
  const now = dependencies.now ?? new Date();
  const evaluate = dependencies.evaluateQuoteReady ?? (async (input, targetDb, date) => {
    const { evaluateQuoteReadyForMessage } = await import('../src/ai/hms-jobs.js');
    return evaluateQuoteReadyForMessage(input, targetDb, process.env, date);
  });
  const blockerHistogram: Record<string, number> = {};
  let prefillable = 0;
  for (const row of quoteThreadRows) {
    const result = await evaluate({ messageId: row.id, transportId: options.transportId }, db, now);
    if (result.plan?.inputs.length) prefillable++;
    else add(blockerHistogram, quoteBlocker(result.reason ?? 'not_ready'));
  }
  let quoteProof: Proof | null = null;
  if (dependencies.quoteProof) {
    const threads = dependencies.quoteProof.threads;
    const passed = threads.filter((thread) => quoteProofPass([thread])).length;
    const blockers: Record<string, number> = {};
    for (const thread of threads) {
      if (!quoteProofPass([thread])) add(blockers, proofBlocker(thread.blocker, thread.rates.outcome));
    }
    quoteProof = {
      passed, threads: threads.length, percent: percent(passed, threads.length),
      blockerHistogram: blockers, cohortHash: digest(threads.map((thread) => thread.threadId).sort()),
    };
  }
  const ownerCohort = goldByThread.map(([threadId, row]) => [threadId, row.messageId, row.action]);
  const score: NavaScorecard = {
    schemaVersion: 2,
    generatedAt: now.toISOString(),
    filters: {
      transportId: options.transportId, since: options.since.toISOString(),
      limit: options.limit, messages: scoped.length, threads: latestInboundByThread.size,
      navaLabelSource: 'mail_extraction.kind',
    },
    classification: {
      ownerGoldLabels: ownerGoldRows.length, ownerGoldThreads: ownerGoldByThread.size,
      ownerGoldMessagesInLimit: ownerGoldRows.filter((row) => limitedIds.has(row.messageId)).length,
      compared, missingPrediction,
      agreement: { correct, denominator: ownerGoldByThread.size, percent: percent(correct, ownerGoldByThread.size) },
      confusionPairs,
      cohortHash: digest(ownerCohort),
    },
    quoteReadiness: {
      prefillable, quoteMessages, quoteThreads: quoteThreadRows.length,
      percent: percent(prefillable, quoteThreadRows.length), blockerHistogram,
      cohortHash: digest(quoteThreadRows.map(({ threadId, id }) => [threadId, id])),
    },
    quoteProof, regressions: [], comparisonSkipped: [],
  };
  if (dependencies.baseline) {
    const previous = metrics(dependencies.baseline);
    score.regressions = metrics(score).flatMap((current, i) => {
      const before = previous[i];
      if (!current || !before || current.cohortHash !== before.cohortHash || current.percent === null || before.percent === null) {
        if (current || before) score.comparisonSkipped.push(current?.section ?? before?.section ?? 'unknown');
        return [];
      }
      if (current.percent >= before.percent) return [];
      return [{
        section: current.section, baselinePercent: before.percent,
        currentPercent: current.percent, delta: current.percent - before.percent,
      }];
    });
  }
  return score;
}

export function formatNavaScorecardMarkdown(score: NavaScorecard): string {
  const fmt = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}%`);
  const blockers = (histogram: Record<string, number>) =>
    Object.keys(histogram).length ? JSON.stringify(histogram) : 'none';
  const proof = score.quoteProof;
  const row = (label: string, count: string, value: number | null, blockerText: string) =>
    `| ${label} | ${count} | ${fmt(value)} | ${blockerText} |`;
  return [
    '| Section | Count | Percent | Blockers |',
    '| --- | ---: | ---: | --- |',
    row('Classification', `${score.classification.agreement.correct}/${score.classification.ownerGoldThreads} threads (${score.classification.ownerGoldLabels} owner-label messages)`, score.classification.agreement.percent, `${score.classification.missingPrediction} missing; ${score.classification.ownerGoldMessagesInLimit}/${score.classification.ownerGoldLabels} inside message limit`),
    row('Quote readiness', `${score.quoteReadiness.prefillable}/${score.quoteReadiness.quoteThreads} threads (${score.quoteReadiness.quoteMessages} quote messages)`, score.quoteReadiness.percent, blockers(score.quoteReadiness.blockerHistogram)),
    row('Quote proof', proof ? `${proof.passed}/${proof.threads} threads` : '—', proof?.percent ?? null, proof ? blockers(proof.blockerHistogram) : 'not supplied'),
    '',
  ].join('\n');
}

async function readQuoteProof(path: string): Promise<QuoteProofSummary> {
  const summary = JSON.parse(await readFile(path, 'utf8')) as QuoteProofSummary;
  const invalid = !Array.isArray(summary.threads) || typeof summary.pass !== 'boolean' || summary.threads.some((thread) =>
    !thread?.rates || typeof thread.threadId !== 'string' ||
    (thread.blocker !== null && typeof thread.blocker !== 'string') ||
    (thread.rates.outcome !== null && typeof thread.rates.outcome !== 'string')) || summary.pass !== quoteProofPass(summary.threads);
  if (invalid) {
    throw new Error('Invalid quote proof summary');
  }
  return summary;
}
async function readBaseline(path: string): Promise<NavaScorecard> {
  const baseline = JSON.parse(await readFile(path, 'utf8')) as NavaScorecard;
  if (baseline.schemaVersion !== 2 || !baseline.classification?.agreement || !baseline.quoteReadiness) {
    throw new Error('Invalid scorecard baseline');
  }
  return baseline;
}
async function main(): Promise<void> {
  const options = parseNavaScorecardArgs(process.argv.slice(2));
  const quoteProof = options.quoteProofPath ? await readQuoteProof(options.quoteProofPath) : undefined;
  const baseline = options.baselinePath ? await readBaseline(options.baselinePath) : undefined;
  const { getDb, closeDb } = await import('../src/db/client.js');
  try {
    const score = await buildNavaScorecard(getDb(), options, { quoteProof, baseline });
    await writeFile(options.out, formatNavaScorecardMarkdown(score), { mode: 0o600 });
    console.log(JSON.stringify(score));
  } finally {
    await closeDb();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`nava-scorecard: ${error instanceof Error ? error.message : 'failed'}`);
    process.exitCode = 2;
  });
}
