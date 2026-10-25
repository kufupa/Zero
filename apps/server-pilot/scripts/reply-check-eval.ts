/**
 * U11a private, offline reply-recheck evaluation.
 * `freeze` derives truth from the first linked post-reply action before any prediction;
 * `score` receives only the pre-reply work-item source and staff reply.
 * Never connects to a database. PII outputs must stay outside Git and mode 0600.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createAzureLunaModel, LunaModelAdapter } from '../src/ai/bedrock/luna.js';

const LABELS = ['handled', 'waiting_on_guest', 'needs_more_action'] as const;
type Outcome = (typeof LABELS)[number];
type RawRow = {
  sampleOrdinal: number; cohortN: number; asOf: string; workItemId: string; threadId: string;
  sourceMessageId: string; replyMessageId: string; kind?: string | null;
  sourceSubject?: string | null; sourceBody?: string | null; replySubject?: string | null; replyBody?: string | null;
  replyAt: string;
  firstNext: { messageId: string; at: string; direction: string; sameThread: boolean; rfcLink: boolean;
    sameSourceSender: boolean; autoMarker: boolean; subject?: string | null; body?: string | null };
  confirmedBooking: boolean;
};
type Input = { kind: string; sourceSubject: string; sourceText: string; replySubject: string; replyText: string; clipped: boolean };
type Case = {
  sampleOrdinal: number; cohortN: number; asOf: string; workItemId: string; sourceMessageId: string;
  threadId: string; replyMessageId: string; gold: Outcome; input: Input;
};
type AmbiguousCase = { row: RawRow; input: Input };

const MIN_N = 100;
const BODY_MAX_BYTES = 8_000;
const MODEL_MAX_INPUT_BYTES = 26_000;
const LABEL_MAX_OUTPUT_TOKENS = 4_096;
const CODEX_CONFIG = path.join(process.env.HOME ?? '', '.codex/config.toml');
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: { outcome: { type: 'string', enum: LABELS } },
  required: ['outcome'],
  additionalProperties: false,
};

function asOutcome(value: unknown): value is Outcome {
  return typeof value === 'string' && LABELS.includes(value as Outcome);
}

function stripQuotedAndSignature(raw: string): string {
  const plain = raw
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p\s*>|<\/div\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\r/g, '');
  const lines = plain.split('\n');
  const cut = lines.findIndex((line) =>
    /^\s*(?:>{1}|-{2,}\s*original message\s*-{2,}|begin forwarded message:|on .{1,180}\bwrote:|(?:from|to|sent|subject):\s)/i.test(line) ||
    /^\s*(?:--\s*|_{5,}\s*)$/.test(line) ||
    /^\s*(?:kind regards|best regards|warm regards|regards|sincerely|cheers|thanks)[,!\s.]*$/i.test(line),
  );
  return lines.slice(0, cut < 0 ? undefined : cut).join('\n').replace(/[ \t]+\n/g, '\n').trim();
}

function clipUtf8(raw: string, maxBytes: number): { text: string; clipped: boolean } {
  if (Buffer.byteLength(raw) <= maxBytes) return { text: raw, clipped: false };
  let text = '';
  let bytes = 0;
  for (const char of raw) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes - 16) break;
    text += char;
    bytes += size;
  }
  return { text: `${text}\n[truncated]`, clipped: true };
}

function makeInput(row: RawRow): Input | null {
  const source = clipUtf8(stripQuotedAndSignature(row.sourceBody ?? ''), BODY_MAX_BYTES);
  const reply = clipUtf8(stripQuotedAndSignature(row.replyBody ?? ''), BODY_MAX_BYTES);
  const sourceSubject = clipUtf8(stripQuotedAndSignature(row.sourceSubject ?? ''), 512);
  const replySubject = clipUtf8(stripQuotedAndSignature(row.replySubject ?? ''), 512);
  if (!source.text && !sourceSubject.text) return null;
  if (!reply.text && !replySubject.text) return null;
  return {
    kind: row.kind ?? 'unknown',
    sourceSubject: sourceSubject.text,
    sourceText: source.text,
    replySubject: replySubject.text,
    replyText: reply.text,
    clipped: source.clipped || reply.clipped || sourceSubject.clipped || replySubject.clipped,
  };
}

function deriveGold(row: RawRow): Outcome | null {
  if (row.firstNext.autoMarker) return null;
  if (row.confirmedBooking) return 'handled';
  if (row.firstNext.direction === 'inbound' && row.firstNext.sameSourceSender) {
    return 'waiting_on_guest';
  }
  if (row.firstNext.direction === 'outbound') return 'needs_more_action';
  return null;
}

function buildCases(rows: RawRow[]): { cases: Case[]; ambiguous: AmbiguousCase[]; excludedAuto: number; excludedUnusable: number; sameSourceSenderInbound: number } {
  const pairs = new Set<string>();
  const ordinals = new Set<number>();
  const cases: Case[] = [];
  const ambiguous: AmbiguousCase[] = [];
  let excludedAuto = 0;
  let excludedUnusable = 0;
  let sameSourceSenderInbound = 0;
  for (const row of rows) {
    const key = `${row.workItemId}:${row.replyMessageId}`;
    if (!row.workItemId || !row.sourceMessageId || !row.replyMessageId || !row.threadId || pairs.has(key)) {
      throw new Error('source_pair_invalid_or_duplicate');
    }
    if (row.cohortN !== rows.length || row.asOf !== rows[0]?.asOf) {
      throw new Error('source_cohort_count_mismatch');
    }
    if (!Number.isSafeInteger(row.sampleOrdinal) || ordinals.has(row.sampleOrdinal)) {
      throw new Error('source_ordinal_invalid_or_duplicate');
    }
    pairs.add(key);
    ordinals.add(row.sampleOrdinal);
    const replyAt = Date.parse(row.replyAt);
    const nextAt = Date.parse(row.firstNext?.at ?? '');
    if (!Number.isFinite(replyAt) || !Number.isFinite(nextAt) || nextAt <= replyAt) {
      throw new Error('source_event_time_invalid');
    }
    if (!row.firstNext.messageId || !(row.firstNext.sameThread || row.firstNext.rfcLink)) {
      throw new Error('source_event_link_invalid');
    }
    if (row.firstNext.autoMarker) {
      excludedAuto++;
      continue;
    }
    const labeled = deriveGold(row);
    const input = makeInput(row);
    if (!input) {
      excludedUnusable++;
      continue;
    }
    if (row.firstNext.direction === 'inbound' && row.firstNext.sameSourceSender) sameSourceSenderInbound++;
    if (labeled) cases.push(toCase(row, input, labeled));
    else ambiguous.push({ row, input });
  }
  if (cases.length + ambiguous.length < MIN_N) throw new Error('truth_rows_below_minimum');
  return { cases, ambiguous, excludedAuto, excludedUnusable, sameSourceSenderInbound };
}

function toCase(row: RawRow, input: Input, gold: Outcome): Case {
  return { sampleOrdinal: row.sampleOrdinal, cohortN: row.cohortN, asOf: row.asOf,
    workItemId: row.workItemId, sourceMessageId: row.sourceMessageId, threadId: row.threadId,
    replyMessageId: row.replyMessageId, gold, input };
}

function asksGuest(text: string): boolean {
  return /\?|\b(?:can|could|would) you\b|\bplease (?:send|share|confirm|provide|advise|let us know)\b|\bwe need you to\b|\blet us know\b/i.test(text);
}

function ruleBaseline(input: Input): Outcome {
  const text = input.replyText.toLowerCase();
  if (asksGuest(input.replyText)) return 'waiting_on_guest';
  // A specific staff promise (e.g. returning with rates) is still staff work;
  // only a bare “we'll revert” follows the plan's waiting-on-guest cue.
  if (/\b(?:we|i)(?:'ll| will| shall)\s+(?:check|confirm|send|provide|prepare|follow up)\b/i.test(text) ||
      /\b(?:we|i)(?:'ll| will| shall)\s+(?:come back|get back|revert)\b[^.?!]{0,100}\b(?:rates?|quotes?|availability|confirmations?|bookings?|details|updates?)\b/i.test(text) ||
      /\b(?:still checking|currently checking|pending|partially answered|not yet confirmed|awaiting (?:internal|manager|hotel) confirmation)\b/i.test(text)) {
    return 'needs_more_action';
  }
  if (/\b(?:we|i)(?:'ll| will| shall)\s+revert\b/i.test(text)) return 'waiting_on_guest';
  return 'handled';
}

function score(gold: Outcome[], predictions: Outcome[]) {
  const confusion = Object.fromEntries(LABELS.map((label) => [
    label,
    Object.fromEntries(LABELS.map((predicted) => [predicted, 0])),
  ])) as Record<Outcome, Record<Outcome, number>>;
  let correct = 0;
  for (let i = 0; i < gold.length; i++) {
    confusion[gold[i]][predictions[i]]++;
    if (gold[i] === predictions[i]) correct++;
  }
  const perClass = Object.fromEntries(LABELS.map((label) => {
    const tp = confusion[label][label];
    const predicted = LABELS.reduce((sum, actual) => sum + confusion[actual][label], 0);
    const goldSupport = LABELS.reduce((sum, predictedLabel) => sum + confusion[label][predictedLabel], 0);
    const precision = predicted ? tp / predicted : null;
    const recall = goldSupport ? tp / goldSupport : null;
    return [label, { correct: tp, support: goldSupport, predicted, precision, recall }];
  })) as Record<Outcome, {
    correct: number;
    support: number;
    predicted: number;
    precision: number | null;
    recall: number | null;
  }>;
  const supported = LABELS.filter((label) => perClass[label].support > 0);
  const balancedAccuracy = supported.reduce((sum, label) => sum + (perClass[label].recall ?? 0), 0) / supported.length;
  return { n: gold.length, correct, accuracy: correct / gold.length, balancedAccuracy, supportedClasses: supported.length, perClass, confusion };
}

function readAzureBaseUrl(): string | undefined {
  try {
    const section = readFileSync(CODEX_CONFIG, 'utf8').split(/(?=^\[)/m)
      .find((part) => part.startsWith('[model_providers.azure]'));
    return section?.match(/^\s*base_url\s*=\s*["']([^"']+)["']/m)?.[1];
  } catch { return undefined; }
}

function assertPrivatePath(filename: string): string {
  const resolved = path.resolve(filename);
  const relative = path.relative(REPO_ROOT, resolved);
  const outsideRepo = relative === '..' || relative.startsWith(`..${path.sep}`);
  if (!outsideRepo && !relative.split(path.sep).includes('.private')) {
    throw new Error('output_must_be_outside_repo_or_in_private_directory');
  }
  return resolved;
}

async function writePrivate(filename: string, contents: string): Promise<void> {
  const handle = await open(assertPrivatePath(filename), 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
  } finally {
    await handle.close();
  }
}

function parseFlag(args: string[], name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  return value ?? fallback;
}

function assertNoDatabaseEnvironment(): void {
  if (process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || process.env.VITEST_ALLOW_PILOT_RDS) {
    throw new Error('database_environment_must_be_unset');
  }
}

function safeModelFailure(error: unknown): string {
  const details = error as { status?: number; statusCode?: number; message?: string; name?: string; cause?: { status?: number; statusCode?: number; message?: string } };
  const status = Number(details?.statusCode ?? details?.status ?? details?.cause?.statusCode ?? details?.cause?.status);
  if (status === 401 || status === 403) return 'model_auth_failed';
  if (status === 429) return 'model_rate_limited';
  if (status === 400) return 'model_request_rejected';
  if (status >= 500) return 'model_provider_error';
  const message = details?.message ?? '';
  if (['model_input_limit_exceeded', 'model_outcome_invalid', 'model_cost_cap_exceeded'].includes(message)) {
    return message === 'model_outcome_invalid' ? 'model_output_invalid' : message;
  }
  const incomplete = message.match(/^model_response_incomplete:(stop|length|content-filter|tool-calls|error)$/i);
  if (incomplete) return `model_response_incomplete_${incomplete[1].replace('-', '_')}`;
  if (/fetch failed|network|socket|connection reset|timed out/i.test(`${message} ${details?.cause?.message ?? ''}`)) return 'model_network_error';
  if (/invalid url/i.test(message)) return 'model_invalid_url';
  if (/json|parse/i.test(message)) return 'model_response_parse_error';
  if (details?.name === 'AbortError') return 'model_aborted';
  return 'model_call_failed';
}

function createAdapter(): LunaModelAdapter {
  if (!process.env.AZURE_OPENAI_BASE_URL) {
    const baseUrl = readAzureBaseUrl();
    if (baseUrl) process.env.AZURE_OPENAI_BASE_URL = baseUrl;
  }
  try {
    return new LunaModelAdapter({ model: createAzureLunaModel(), reasoningEffort: 'medium',
      routeId: 'reply_check_eval', modelId: 'gpt-6-luna', protocol: 'azure-openai-responses' });
  } catch {
    throw new Error('azure_luna_unavailable');
  }
}

async function invokeOutcome(adapter: LunaModelAdapter, systemPrompt: string, userPrompt: string, maxOutputTokens = 512) {
  const result = await adapter.invoke({ modelId: 'gpt-6-luna', maxOutputTokens,
    maxInputBytes: MODEL_MAX_INPUT_BYTES, systemPrompt, userPrompt, responseSchema: RESPONSE_SCHEMA });
  if (!asOutcome(result.output.outcome)) throw new Error('model_outcome_invalid');
  return { outcome: result.output.outcome, cost: result.usage.estimatedCostUsd,
    inputTokens: result.usage.inputTokens };
}

async function forEachConcurrent(count: number, limit: number, run: (index: number) => Promise<void>): Promise<void> {
  let cursor = 0, failed = false, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(count, limit) }, async () => {
    while (!failed) {
      const index = cursor++;
      if (index >= count) return;
      try { await run(index); } catch (error) { failed = true; failure = error; }
    }
  }));
  if (failed) throw failure;
}

async function labelAmbiguous(rows: AmbiguousCase[], concurrency: number, costCap: number) {
  if (!rows.length) return { outcomes: [] as Outcome[], agreement: 0, cost: 0, inputTokens: 0, clippedRows: 0 };
  const adapter = createAdapter();
  const outcomes: Outcome[] = new Array(rows.length);
  let cost = 0;
  let inputTokens = 0;
  let agreement = 0;
  let clippedRows = 0;
  try {
    await forEachConcurrent(rows.length, concurrency, async (index) => {
      const { row, input } = rows[index];
      const next = clipUtf8(stripQuotedAndSignature(`${row.firstNext.subject ?? ''}\n${row.firstNext.body ?? ''}`), 7_000);
      if (next.clipped) clippedRows++;
      const evidence = { kind: input.kind, request: { subject: input.sourceSubject, body: input.sourceText },
        staffReply: { subject: input.replySubject, body: input.replyText },
        nextEvent: { direction: row.firstNext.direction, senderMatchesSource: row.firstNext.sameSourceSender, text: next.text } };
      const draft = await invokeOutcome(adapter,
        'Blindly label the state immediately after the staff reply, using only the observed next event and request/reply context. ' +
        'No predictor outputs or Nava work-item status are available. handled means completed; waiting_on_guest means an external participant owns the next move; ' +
        'needs_more_action means staff still own follow-up. Return only the schema outcome.', JSON.stringify(evidence), LABEL_MAX_OUTPUT_TOKENS);
      const adjudication = await invokeOutcome(adapter,
        'Adjudicate this draft label using evidence only. You are blind to both predictor outputs and Nava work-item status; retain or change it as warranted. ' +
        'handled means completed; waiting_on_guest means an external participant owns the next move; needs_more_action means staff still own follow-up. Return only the schema outcome.',
        JSON.stringify({ evidence, draftOutcome: draft.outcome }), LABEL_MAX_OUTPUT_TOKENS);
      outcomes[index] = adjudication.outcome;
      if (draft.outcome === adjudication.outcome) agreement++;
      cost += draft.cost + adjudication.cost;
      inputTokens += draft.inputTokens + adjudication.inputTokens;
      if (cost > costCap) throw new Error('model_cost_cap_exceeded');
      if (outcomes.filter(Boolean).length % 20 === 0) process.stderr.write(`reply_check_label_progress: ${outcomes.filter(Boolean).length}/${rows.length}\n`);
    });
  } catch (error) { throw new Error(safeModelFailure(error)); }
  return { outcomes, agreement, cost, inputTokens, clippedRows };
}

function selfTest(): void {
  const input = (replyText: string): Input => ({
    kind: 'quote', sourceSubject: '', sourceText: 'Please quote two rooms.',
    replySubject: '', replyText, clipped: false,
  });
  assert.equal(ruleBaseline(input('Could you confirm your dates?')), 'waiting_on_guest');
  assert.equal(ruleBaseline(input("We'll come back with rates.")), 'needs_more_action');
  assert.equal(ruleBaseline(input('We will revert.')), 'waiting_on_guest');
  assert.equal(ruleBaseline(input('We are still checking availability.')), 'needs_more_action');
  assert.equal(ruleBaseline(input('Your booking is confirmed.')), 'handled');
  assert.equal(stripQuotedAndSignature('Rates attached.\n\nOn Tuesday, the guest wrote:\nCan you quote?'), 'Rates attached.');
  const metrics = score(['waiting_on_guest', 'needs_more_action'], ['waiting_on_guest', 'waiting_on_guest']);
  assert.equal(metrics.n, 2);
  assert.equal(metrics.correct, 1);
  assert.equal(score(['needs_more_action'], ['handled']).perClass.needs_more_action.precision, null);
  const raw = (direction: string, sameSourceSender: boolean): RawRow => ({
    sampleOrdinal: 1, cohortN: 1, asOf: '2026-10-25T01:00:00Z', workItemId: 'work-1',
    threadId: 'thread-1', sourceMessageId: 'source-1', replyMessageId: 'reply-1',
    sourceBody: 'Please quote a room.', replyBody: 'I will check.', replyAt: '2026-10-20T10:00:00Z',
    firstNext: { messageId: 'next-1', at: '2026-10-20T11:00:00Z', direction, sameThread: true,
      rfcLink: false, sameSourceSender, autoMarker: false, subject: 'Follow-up', body: 'Please let us know.' },
    confirmedBooking: false,
  });
  assert.equal(deriveGold(raw('inbound', false)), null, 'unverified inbound actor needs blind adjudication');
  assert.equal(deriveGold(raw('inbound', true)), 'waiting_on_guest');
  assert.equal(deriveGold(raw('outbound', false)), 'needs_more_action');
  process.stdout.write('reply_check_eval_self_test: ok\n');
}

async function freeze(inputPath: string, outputPath: string, concurrency: number, costCap: number): Promise<void> {
  assertNoDatabaseEnvironment();
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('concurrency_invalid');
  if (!Number.isFinite(costCap) || costCap <= 0) throw new Error('cost_cap_invalid');
  const rows = (await readFile(inputPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RawRow);
  const built = buildCases(rows);
  const labels = await labelAmbiguous(built.ambiguous, concurrency, costCap);
  const cases = [...built.cases, ...built.ambiguous.map((item, index) =>
    toCase(item.row, item.input, labels.outcomes[index]))].sort((a, b) => a.sampleOrdinal - b.sampleOrdinal);
  if (cases.length < MIN_N) throw new Error('truth_rows_below_minimum');
  const output = cases.map((item) => JSON.stringify(item)).join('\n') + '\n';
  await writePrivate(outputPath, output);
  const classCounts = Object.fromEntries(LABELS.map((label) => [label, cases.filter((item) => item.gold === label).length]));
  process.stdout.write(JSON.stringify({ phase: 'truth_frozen', n: cases.length,
    snapshotAsOf: cases[0].asOf, eventResolvedCohortN: cases[0].cohortN,
    excludedAuto: built.excludedAuto, excludedUnusable: built.excludedUnusable,
    threads: new Set(cases.map((item) => item.threadId)).size,
    replyMessages: new Set(cases.map((item) => item.replyMessageId)).size,
    sameSourceSenderInbound: built.sameSourceSenderInbound,
    classes: classCounts, labelsDerivedBeforePrediction: true,
    blindLabeling: { deterministicRows: built.cases.length, ambiguousRows: built.ambiguous.length,
      lunaDraftAdjudicatorAgreement: { matches: labels.agreement, n: built.ambiguous.length },
      clippedNextEvents: labels.clippedRows,
      estimatedCostUsd: labels.cost, inputTokens: labels.inputTokens },
  }) + '\n');
}

async function scoreCases(inputPath: string, outputPath: string, aggregatePath: string | undefined, concurrency: number, costCap: number): Promise<void> {
  assertNoDatabaseEnvironment();
  const cases = (await readFile(inputPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Case);
  if (cases.length < MIN_N || cases.some((item) => !asOutcome(item.gold))) throw new Error('truth_input_invalid');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('concurrency_invalid');
  if (!Number.isFinite(costCap) || costCap <= 0) throw new Error('cost_cap_invalid');
  const rules1 = cases.map((item) => ruleBaseline(item.input));
  const rules2 = cases.map((item) => ruleBaseline(item.input));
  const ruleRepeatMatches = rules1.filter((prediction, index) => prediction === rules2[index]).length;
  const adapter = createAdapter();
  const predictions: Outcome[] = new Array(cases.length);
  const inputTokens: number[] = new Array(cases.length).fill(0);
  let totalCost = 0;
  let completed = 0;
  try {
    await forEachConcurrent(cases.length, concurrency, async (index) => {
      const item = cases[index];
      const userPrompt = JSON.stringify({
        workItemKind: item.input.kind,
        originalRequest: { subject: item.input.sourceSubject, body: item.input.sourceText },
        staffReply: { subject: item.input.replySubject, body: item.input.replyText },
      });
      const result = await invokeOutcome(adapter,
        'Classify the state immediately after this staff reply, using only the source request and reply. ' +
        'handled means the request is complete; waiting_on_guest means staff asked an external participant for information or a decision; ' +
        'needs_more_action means staff follow-up or unfinished work remains. Ignore quoted history and do not infer later events, mailbox status, or labels. ' +
        'Return only the schema outcome.', userPrompt);
      predictions[index] = result.outcome;
      inputTokens[index] = result.inputTokens;
      totalCost += result.cost;
      if (totalCost > costCap) throw new Error('model_cost_cap_exceeded');
      completed++;
      if (completed % 20 === 0) process.stderr.write(`reply_check_eval_progress: ${completed}/${cases.length}\n`);
    });
  } catch (error) {
    process.stderr.write(`${safeModelFailure(error)}\n`);
    process.exitCode = 1;
    return;
  }
  const gold = cases.map((item) => item.gold);
  const rule = score(gold, rules1);
  const llm = score(gold, predictions);
  const rows = cases.map((item, index) => JSON.stringify({
    sampleOrdinal: item.sampleOrdinal, workItemId: item.workItemId, sourceMessageId: item.sourceMessageId,
    replyMessageId: item.replyMessageId, threadId: item.threadId,
    gold: item.gold, rule: rules1[index], llm: predictions[index],
  })).join('\n') + '\n';
  await writePrivate(outputPath, rows);
  const aggregate = {
    phase: 'scored', n: cases.length,
    source: { snapshotAsOf: cases[0].asOf, eventResolvedCohortN: cases[0].cohortN },
    threads: new Set(cases.map((item) => item.threadId)).size,
    replyMessages: new Set(cases.map((item) => item.replyMessageId)).size,
    classSupport: Object.fromEntries(LABELS.map((label) => [label, gold.filter((value) => value === label).length])),
    ruleBaseline: rule, ruleRepeatAgreement: { matches: ruleRepeatMatches, n: cases.length },
    llm: { model: 'gpt-6-luna', reasoningEffort: 'medium', ...llm },
    input: { preReplyOnly: true, futureEventSentToModel: false,
      clippedRows: cases.filter((item) => item.input.clipped).length, maxBodyBytesPerField: BODY_MAX_BYTES },
    usage: { totalInputTokens: inputTokens.reduce((sum, value) => sum + value, 0),
      estimatedCostUsd: totalCost, routeId: 'reply_check_eval' },
  };
  await writePrivate(aggregatePath ?? `${outputPath}.aggregate.json`, JSON.stringify(aggregate, null, 2) + '\n');
  process.stdout.write(JSON.stringify(aggregate) + '\n');
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--self-test') return selfTest();
  const input = parseFlag(args, 'input');
  const output = parseFlag(args, 'out');
  if (!input || !output) throw new Error('usage: freeze|score --input=PRIVATE.jsonl --out=PRIVATE.jsonl');
  const concurrency = Number(parseFlag(args, 'concurrency', '4'));
  const costCap = Number(parseFlag(args, 'cost-cap-usd', '5'));
  if (command === 'freeze') return freeze(input, output, concurrency, costCap);
  if (command === 'score') {
    return scoreCases(input, output, parseFlag(args, 'aggregate'), concurrency, costCap);
  }
  throw new Error('unknown_command');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  if (process.argv.includes('--self-test') && error instanceof assert.AssertionError) {
    process.stderr.write(`reply_check_eval_self_test_failed: ${message}\n`);
    process.exitCode = 1;
    return;
  }
  const allowed = /^(source_[a-z_]+|truth_rows_below_minimum|output_must_be_outside_repo_or_in_private_directory|database_environment_must_be_unset|usage: freeze\|score --input=PRIVATE\.jsonl --out=PRIVATE\.jsonl|truth_input_invalid|concurrency_invalid|cost_cap_invalid|azure_luna_unavailable|unknown_command|model_(?:auth_failed|rate_limited|request_rejected|provider_error|input_limit_exceeded|output_invalid|cost_cap_exceeded|network_error|invalid_url|response_incomplete_(?:stop|length|content_filter|tool_calls|error)|response_parse_error|aborted|call_failed))$/;
  process.stderr.write(`${allowed.test(message) ? message : 'reply_check_eval_failed'}\n`);
  process.exitCode = 1;
});
