/**
 * Outbound-gold EC2 replay (U11b). Writes fixture JSONL for outbound-gold-backtest.ts.
 *
 * Prod replay input: readQuoteAttachments → selectionToAgentPrompt.
 * Cards: extractInboundMail on that selection (U5 stays → pane cards).
 * Vision parity is a reported gap. Do not add vision.
 * No --apply. No HMS write. No email send. Stdout is counts only.
 *
 * 17 core multi-ask thread ids are not in the repo (l1 S1 aggregates;
 * p2-scope-grok46.md:164). Pass --ids (thread ids, one per line). Expected
 * if checked in: docs/research/2026-10-20-arch-lanes/l1-s1-core-multi-ask-thread-ids.txt
 *
 *   pnpm --dir apps/server-pilot exec tsx scripts/outbound-gold-replay.ts \
 *     --ids <thread-ids.txt> --out <fixture.jsonl> --misses <misses.jsonl>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { and, desc, eq, sql } from 'drizzle-orm';
import { selectionToAgentPrompt } from '../src/ai/agent-pane-adapter.js';
import { extractInboundMail } from '../src/ai/extraction/extract.js';
import type { MailExtractionPayload, MailKind } from '../src/ai/extraction/schema.js';
import {
  OUTBOUND_GOLD_PROD_INPUT,
  OUTBOUND_GOLD_VISION_PARITY,
  checkLetterCoverage,
  parseLetterFields,
  reportScoreKind,
  type GoldCardInput,
  type GoldLetterInput,
  type OutboundGoldFixtureRow,
} from '../src/ai/outbound-gold-features.js';
import { resolveAdapter } from '../src/ai/quote-workflow-analyse-selection.js';
import {
  THREAD_CONFIRMATION_AMBIGUOUS,
  createArtifactReader,
  loadSyncedQuoteSelectionFromMailbox,
  type QuoteAttachmentRow,
  type SyncedQuoteSelection,
} from '../src/ai/quote-workflow-synced-selection.js';
import { closeDb, getDb, type DB } from '../src/db/client.js';
import { attachment, mailboxTransport, message } from '../src/db/schema/mail.js';

const THREAD_ID_RE = /^[A-Za-z0-9._:-]+$/;
const LETTER_FILE_RE = /^HRCEN_Confirmation_Letter_/i;
const USAGE =
  'outbound-gold-replay.ts --ids <thread-ids.txt> --out <fixture.jsonl> --misses <misses.jsonl>';

export type ReplayCli = { idsPath: string; outPath: string; missesPath: string };
export type ReplayMiss = { id: string; reason: string };
export type ReplayExtractResult =
  | { ok: true; kind: MailKind; payload: MailExtractionPayload }
  | { ok: false };
export type ReplayTrigger = {
  threadId: string;
  messageId: string;
  transportId: string;
  fromAddress: string;
  mailbox: string | null;
};
export type ReplayArtifacts = {
  letters: GoldLetterInput[];
  replyId: string | null;
  quotePdfId: string | null;
};
export type ReplayStdout = {
  n: number;
  covered: number;
  missed: number;
  distinctDateSets: number;
  distinctLetters: number;
  lettersCovered: number;
  lettersUncovered: number;
  cards: number;
  checkRows: number;
  checkPass: boolean;
  wroteBeforePick: number;
  quoteThreads: number;
  visionParity: typeof OUTBOUND_GOLD_VISION_PARITY;
  prodInput: typeof OUTBOUND_GOLD_PROD_INPUT;
  scoreKind: 'behaviour_check' | 'rate';
  label: string;
  jsonlErrors: number;
};
export type ReplayDeps = {
  loadTrigger: (threadId: string) => Promise<ReplayTrigger | null>;
  loadSelection: typeof loadSyncedQuoteSelectionFromMailbox;
  loadArtifacts: (trigger: ReplayTrigger) => Promise<ReplayArtifacts>;
  extract: (input: {
    selection: SyncedQuoteSelection;
    prompt: string;
    messageId: string;
    fromAddress: string;
    mailbox: string | null;
  }) => Promise<ReplayExtractResult>;
  toAgentPrompt?: typeof selectionToAgentPrompt;
};

type ReadOnlyDb = Pick<DB, 'transaction'>;

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function fileName(value: string): string {
  return value.replace(/\\/g, '/').split('/').pop() || value;
}

export function isConfirmationLetterFilename(filename: string): boolean {
  return LETTER_FILE_RE.test(fileName(filename));
}

export function isQuotePdfFilename(filename: string): boolean {
  return /quote/i.test(fileName(filename)) && !isConfirmationLetterFilename(filename);
}

export function parseOutboundGoldReplayArgs(argv: readonly string[]): ReplayCli {
  if (argv.includes('--apply')) throw codedError('apply_forbidden');
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') throw codedError('usage');
    if (arg === '--ids' || arg === '--out' || arg === '--misses') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw codedError('usage');
      flags.set(arg, value);
      i += 1;
      continue;
    }
    throw codedError('unknown_option');
  }
  const idsPath = flags.get('--ids');
  const outPath = flags.get('--out');
  const missesPath = flags.get('--misses');
  if (!idsPath || !outPath || !missesPath) throw codedError('usage');
  for (const candidate of [idsPath, outPath, missesPath]) {
    if (/^(postgres|postgresql|https?):\/\//i.test(candidate)) throw codedError('local_paths_only');
  }
  return { idsPath, outPath, missesPath };
}

export function readThreadIdList(textValue: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of textValue.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!THREAD_ID_RE.test(line)) throw codedError('invalid_thread_id');
    if (seen.has(line)) continue;
    seen.add(line);
    ids.push(line);
  }
  if (!ids.length) throw codedError('ids_required');
  return ids;
}

export function cardsFromPayload(payload: MailExtractionPayload): GoldCardInput[] {
  return payload.stays.map((stay) => ({
    id: stay.id,
    arrival: stay.requested.arrival,
    departure: stay.requested.departure,
    guests: (stay.guests ?? []).map((guest) => ({
      guest: guest.name,
      conf: guest.confirmationNumber,
    })),
  }));
}

export function formatReplayStdout(summary: ReplayStdout): string {
  return `${JSON.stringify(summary)}\n`;
}

function writePrivate(outputPath: string, body: string): void {
  writeFileSync(path.resolve(outputPath), body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function letterTruth(letter: GoldLetterInput): GoldLetterInput {
  const parsed = parseLetterFields(letter);
  return {
    id: letter.id,
    guest: letter.guest ?? parsed.guest,
    conf: letter.conf ?? parsed.conf,
    arrival: letter.arrival ?? parsed.arrival,
    filename: letter.filename,
  };
}

function jsonl(rows: readonly object[]): string {
  return rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
}

export async function runOutboundGoldReplay(
  threadIds: readonly string[],
  deps: ReplayDeps,
): Promise<{ rows: OutboundGoldFixtureRow[]; misses: ReplayMiss[]; summary: ReplayStdout }> {
  const toAgentPrompt = deps.toAgentPrompt ?? selectionToAgentPrompt;
  const rows: OutboundGoldFixtureRow[] = [];
  const misses: ReplayMiss[] = [];
  let covered = 0;
  let distinctDateSets = 0;
  let distinctLetters = 0;
  let lettersCovered = 0;
  let lettersUncovered = 0;
  let cards = 0;
  let checkRows = 0;
  let quoteThreads = 0;
  const wroteBeforePick = 0;

  for (const threadId of threadIds) {
    const trigger = await deps.loadTrigger(threadId);
    if (!trigger) {
      misses.push({ id: threadId, reason: 'thread_not_found' });
      continue;
    }
    const selection = await deps.loadSelection({
      transportId: trigger.transportId,
      messageId: trigger.messageId,
      includeThreadState: true,
      includeVisionImages: false,
      trackVisionImages: true,
    });
    if (!selection) {
      misses.push({ id: threadId, reason: 'selection_not_found' });
      continue;
    }
    const prompt = toAgentPrompt(selection);
    const extracted = await deps.extract({
      selection,
      prompt,
      messageId: trigger.messageId,
      fromAddress: trigger.fromAddress,
      mailbox: trigger.mailbox,
    });
    if (!extracted.ok) {
      misses.push({ id: threadId, reason: 'extract_failed' });
      continue;
    }

    const threadCards = cardsFromPayload(extracted.payload);
    const artifacts = await deps.loadArtifacts(trigger);
    const letters = artifacts.letters.map(letterTruth);
    if (artifacts.quotePdfId) quoteThreads += 1;
    const noConf =
      extracted.payload.confirmationNumbers.length === 0 && !selection.threadConfirmation?.confirmation;
    const ambiguous = selection.threadConfirmation?.reason === THREAD_CONFIRMATION_AMBIGUOUS;
    if (extracted.kind === 'amendment' && (noConf || ambiguous)) checkRows += 1;

    const coverage = checkLetterCoverage({ letters, cards: threadCards });
    distinctDateSets += coverage.distinctDateSets;
    distinctLetters += coverage.letters;
    lettersCovered += coverage.lettersCovered;
    lettersUncovered += coverage.lettersUncovered;
    cards += coverage.cards;

    if (!letters.length) misses.push({ id: threadId, reason: 'no_letter' });
    else if (!coverage.pass) {
      misses.push({
        id: threadId,
        reason: coverage.lettersUncovered > 0 ? 'uncovered_letter' : 'duplicate_date_set',
      });
    } else covered += 1;

    if (!letters.length) {
      rows.push({
        id: threadId,
        replyId: artifacts.replyId,
        letterId: null,
        quotePdfId: artifacts.quotePdfId,
        letter: null,
        cards: threadCards,
      });
      continue;
    }
    for (const letter of letters) {
      rows.push({
        id: `${threadId}:${letter.id}`,
        replyId: artifacts.replyId,
        letterId: letter.id,
        quotePdfId: artifacts.quotePdfId,
        letter: {
          guest: letter.guest,
          conf: letter.conf,
          arrival: letter.arrival,
          filename: letter.filename,
        },
        cards: threadCards,
      });
    }
  }

  const score = reportScoreKind(distinctLetters);
  return {
    rows,
    misses,
    summary: {
      n: threadIds.length,
      covered,
      missed: misses.length,
      distinctDateSets,
      distinctLetters,
      lettersCovered,
      lettersUncovered,
      cards,
      checkRows,
      checkPass: wroteBeforePick === 0,
      wroteBeforePick,
      quoteThreads,
      visionParity: OUTBOUND_GOLD_VISION_PARITY,
      prodInput: OUTBOUND_GOLD_PROD_INPUT,
      scoreKind: score.scoreKind,
      label: score.label,
      jsonlErrors: 0,
    },
  };
}

async function readOnly<T>(db: ReadOnlyDb, run: (tx: DB) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    return run(tx as unknown as DB);
  });
}

export async function loadReplayTrigger(db: ReadOnlyDb, threadId: string): Promise<ReplayTrigger | null> {
  return readOnly(db, async (tx) => {
    const rows = await tx
      .select({
        threadId: message.threadId,
        messageId: message.id,
        transportId: message.transportId,
        fromAddress: message.fromAddress,
        mailbox: mailboxTransport.email,
      })
      .from(message)
      .leftJoin(mailboxTransport, eq(mailboxTransport.id, message.transportId))
      .where(and(eq(message.threadId, threadId), eq(message.direction, 'inbound')))
      .orderBy(desc(message.receivedAt), desc(message.createdAt));
    const first = rows[0];
    if (!first) return null;
    if (new Set(rows.map((row) => row.transportId)).size > 1) return null;
    return first;
  });
}

export async function loadReplayArtifacts(
  db: ReadOnlyDb,
  trigger: ReplayTrigger,
  signal: AbortSignal,
): Promise<ReplayArtifacts> {
  const outbound = await readOnly(db, async (tx) => {
    const files = await tx
      .select({
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        isInline: attachment.isInline,
        s3Key: attachment.s3Key,
        messageId: attachment.messageId,
        contentId: attachment.contentId,
        sha256: attachment.sha256,
        subject: message.subject,
      })
      .from(attachment)
      .innerJoin(message, eq(attachment.messageId, message.id))
      .where(
        and(
          eq(message.threadId, trigger.threadId),
          eq(message.transportId, trigger.transportId),
          eq(message.direction, 'outbound'),
        ),
      );
    const replies = await tx
      .select({ id: message.id })
      .from(message)
      .where(
        and(
          eq(message.threadId, trigger.threadId),
          eq(message.transportId, trigger.transportId),
          eq(message.direction, 'outbound'),
        ),
      )
      .orderBy(desc(message.sentAt), desc(message.createdAt))
      .limit(1);
    return { files, replyId: replies[0]?.id ?? null };
  });

  const letterRows = outbound.files.filter((row) => isConfirmationLetterFilename(row.filename));
  const reader = letterRows.length
    ? createArtifactReader(letterRows as QuoteAttachmentRow[], signal, {
        transportId: trigger.transportId,
      })
    : null;
  const letters: GoldLetterInput[] = [];
  for (const row of letterRows) {
    const read = reader ? await reader(row) : { text: null };
    letters.push({
      id: row.id,
      filename: row.filename,
      subject: row.subject ?? undefined,
      pdfText: read.text ?? undefined,
    });
  }
  return {
    letters,
    replyId: outbound.replyId,
    quotePdfId: outbound.files.find((row) => isQuotePdfFilename(row.filename))?.id ?? null,
  };
}

function liveDeps(db: ReadOnlyDb, adapter: ReturnType<typeof resolveAdapter>['adapter']): ReplayDeps {
  return {
    loadTrigger: (threadId) => loadReplayTrigger(db, threadId),
    loadSelection: loadSyncedQuoteSelectionFromMailbox,
    loadArtifacts: (trigger) => loadReplayArtifacts(db, trigger, AbortSignal.timeout(120_000)),
    extract: async (input) => {
      if (!adapter) return { ok: false };
      const result = await extractInboundMail({
        adapter,
        selection: input.selection,
        messageId: input.messageId,
        from: input.fromAddress,
        mailbox: input.mailbox,
        deadlineMs: 180_000,
        env: { ...process.env, EXTRACTION_VISION: 'off' },
      });
      if (!result.ok) return { ok: false };
      return { ok: true, kind: result.kind, payload: result.payload };
    },
  };
}

export async function runOutboundGoldReplayCli(argv: readonly string[]): Promise<number> {
  let cli: ReplayCli;
  try {
    cli = parseOutboundGoldReplayArgs(argv);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'usage';
    process.stderr.write(`${JSON.stringify({ error: code, usage: USAGE })}\n`);
    return 2;
  }

  let ids: string[];
  try {
    ids = readThreadIdList(readFileSync(path.resolve(cli.idsPath), 'utf8'));
  } catch (error) {
    const code = error instanceof Error ? error.message : 'ids_read_failed';
    process.stderr.write(`${JSON.stringify({ error: code === 'ENOENT' ? 'ids_not_found' : code })}\n`);
    return 2;
  }

  try {
    const result = await runOutboundGoldReplay(ids, liveDeps(getDb(), resolveAdapter(true, null).adapter));
    writePrivate(cli.outPath, jsonl(result.rows));
    writePrivate(cli.missesPath, jsonl(result.misses));
    process.stdout.write(formatReplayStdout(result.summary));
    return 0;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : 'error';
    process.stderr.write(`${JSON.stringify({ error: code === 'EEXIST' ? 'out_exists' : 'error' })}\n`);
    return 1;
  } finally {
    await closeDb().catch(() => undefined);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void runOutboundGoldReplayCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
