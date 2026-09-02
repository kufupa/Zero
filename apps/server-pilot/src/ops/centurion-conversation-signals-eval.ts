/**
 * Gold eval harness for Layer B conversation signals — ports trigger selection from
 * `.private/.../defensible-daily-chart-2026-09-01.py` + snapshot parsing from
 * `staff-email-brief-analysis-2026-09-01.py`.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildAutoConfirmIndex,
  buildOrphanOutboundIndex,
  detectConversationSignals,
  isAutoOutbound,
  isConversationResponded,
  type ConversationMessage,
  type IndexableMessage,
} from '../mail/conversation-signals.js';

export const GOLD_RECALL_MIN = 221;
export const GOLD_RESPONDED_TOTAL = 246;
export const GOLD_FALSE_POSITIVE_MAX = 4;
export const GOLD_UNANSWERED_TOTAL = 192;
export const GOLD_ACTIONABLE_TOTAL = 438;

export type SnapshotRow = {
  messageId: string;
  threadId: string;
  direction: 'inbound' | 'outbound';
  from: string;
  to: string;
  cc: string;
  subject: string;
  bodyText: string;
  receivedAt: string;
};

export type DefensibleGoldThread = {
  threadId: string;
  responded: boolean;
};

export type GoldEvalCase = {
  threadIdPrefix: string;
  fullThreadId: string;
  goldResponded: boolean;
  predictedResponded: boolean;
  triggerMessageId: string;
};

export type ConfusionMatrixCounts = {
  truePositives: number;
  falseNegatives: number;
  falsePositives: number;
  trueNegatives: number;
  goldResponded: number;
  goldUnanswered: number;
  goldTotal: number;
  predictedResponded: number;
  skippedThreads: number;
};

export type GoldEvalResult = {
  matrix: ConfusionMatrixCounts;
  cases: readonly GoldEvalCase[];
};

const OTA_SUBJECT_HINTS = [
  'booking.com',
  'expedia',
  'channel manager',
  'channelmanager',
  'synxis',
  'travelclick',
  'hotelbeds',
  'agoda',
  'hrs',
  'hotels.com',
] as const;

const CHANNEL_AUTO_RE =
  /(?:synxis|travelclick|channel manager|channelmanager|booking\.com(?: notification)?|expedia(?: notification)?|hotelbeds|agoda|hrs\.com|guestrevu|fortimail|night audit|mailer-daemon|do not reply|automatic reply|out of office|reservation confirmation(?: notice)?|confirmation letter|booking update|failed to integrate|security digest|quarantine digest|nondelivery|noreply@noreply\.reservecloud)/i;

const REQUEST_SIGNAL_RE =
  /(?:request(?:ing)?|enquiry|inquiry|please (?:book|quote|assist|confirm|advise)|availability|quote|quotation|RFQ|room block|group booking|would like to book|need(?:ing)?\s+(?:a\s+)?room|hold(?:ing)?\s+room|proforma|proof of payment|POP\b|deposit|travel agent|voucher)/i;

const STAFF_LOCALPART_HINTS = [
  'navaai',
  'centurion',
  'reservations',
  'reservation',
  'info@',
  'frontoffice',
  'fo@',
] as const;

const SYSTEM_LOCALPART_HINTS = [
  'noreply',
  'no-reply',
  'donotreply',
  'mailer-daemon',
  'postmaster',
  'bounce',
  'notification',
  'notifications',
  'alert',
  'alerts',
  'system',
] as const;

function emailParts(addr: string): [local: string, domain: string] {
  const trimmed = addr.trim().toLowerCase();
  const match = /<?([^<>\s]+@[^>\s]+)>?/.exec(trimmed);
  const email = match?.[1] ?? trimmed;
  if (!email.includes('@')) return ['', email];
  const at = email.lastIndexOf('@');
  return [email.slice(0, at), email.slice(at + 1)];
}

function classifySender(fromAddr: string, subject: string): string {
  const [local, domain] = emailParts(fromAddr);
  const subj = (subject ?? '').toLowerCase();
  if (domain === 'legacyhotels.co.za') {
    if (local === 'navaai' || local === 'centurion') return 'staff_centurion_mailbox';
    if (STAFF_LOCALPART_HINTS.some((hint) => local.includes(hint))) return 'staff_legacy_other';
    if (SYSTEM_LOCALPART_HINTS.some((hint) => local.includes(hint))) return 'system_legacy';
    if (local && local.length < 40) return 'staff_legacy_personal';
    return 'staff_legacy_other';
  }
  if (SYSTEM_LOCALPART_HINTS.some((hint) => local.includes(hint))) return 'system_external';
  if (OTA_SUBJECT_HINTS.some((hint) => subj.includes(hint))) return 'ota_channel';
  if (['invoice', 'statement', 'marketing', 'newsletter', 'unsubscribe'].some((hint) => subj.includes(hint))) {
    return 'vendor_b2b';
  }
  return 'external_guest_or_partner';
}

function classifyInboundObligation(subject: string, senderClass: string, textLen: number): string {
  const subj = (subject ?? '').toLowerCase();
  if (['system_legacy', 'system_external', 'ota_channel'].includes(senderClass)) {
    if (['confirmation letter', 'booking update', 'reservation confirmation'].some((hint) => subj.includes(hint))) {
      return 'channel_notice';
    }
    if (['failure', 'unpaid', 'update failure', 'bounce', 'undeliverable'].some((hint) => subj.includes(hint))) {
      return 'exception_recovery';
    }
    if (['guestrevu', 'review', 'fortimail', 'quarantine'].some((hint) => subj.includes(hint))) {
      return 'system_digest';
    }
    return 'automated_or_system';
  }
  if (senderClass.startsWith('staff_legacy')) return 'internal_handoff';
  if (subj.includes('quote') || subj.includes('availability') || subj.includes('rate')) return 'quote_request';
  if (subj.includes('cancel')) return 'cancellation';
  if (['invoice', 'tax', 'receipt', 'voucher', 'document'].some((hint) => subj.includes(hint))) return 'documents';
  if (['payment', 'deposit', 'refund', 'vcc', 'virtual card'].some((hint) => subj.includes(hint))) return 'payment';
  if (['group', 'block', 'event', 'conference'].some((hint) => subj.includes(hint))) return 'group_event';
  if (['modify', 'amend', 'change date', 'extension'].some((hint) => subj.includes(hint))) return 'modification';
  if (['booking', 'reservation', 'room', 'stay'].some((hint) => subj.includes(hint))) return 'booking_request';
  if (textLen === 0) return 'empty_or_sparse';
  return 'guest_service_or_other';
}

function isExternalSender(fromAddr: string, subject: string): boolean {
  const senderClass = classifySender(fromAddr, subject);
  return ['external_guest_or_partner', 'vendor_b2b', 'ota_channel'].includes(senderClass);
}

function isChannelAutomatedInbound(row: SnapshotRow): boolean {
  const body = `${row.bodyText}\n${row.subject}`;
  const senderClass = classifySender(row.from, row.subject);
  const obligation = classifyInboundObligation(row.subject, senderClass, row.bodyText.length);
  if (
    ['system_legacy', 'system_external', 'ota_channel'].includes(senderClass) &&
    ['channel_notice', 'automated_or_system', 'system_digest'].includes(obligation)
  ) {
    return true;
  }
  if (senderClass === 'ota_channel' && obligation === 'channel_notice') return true;
  if (CHANNEL_AUTO_RE.test(body) && !REQUEST_SIGNAL_RE.test(body)) return true;
  if (isAutoOutbound(row.subject, row.to)) return true;
  return false;
}

export function resolvePrivateCorpusRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, '.private', 'connected-mailbox-corpus');
    const goldPath = path.join(candidate, 'follow-up', '_work', 'defensible-daily-chart-2026-09-01.json');
    if (existsSync(goldPath)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate .private/connected-mailbox-corpus with defensible gold JSON');
}

export function parseConnectedMailboxSnapshot(text: string): {
  rows: SnapshotRow[];
  byThread: ReadonlyMap<string, readonly SnapshotRow[]>;
} {
  const normalized = text.replace(/\r\n/g, '\n');
  const blocks = normalized.split(/\n---\n/);
  const rows: SnapshotRow[] = [];

  for (const block of blocks) {
    if (!/^## Message \d+:/m.test(block)) continue;

    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
      const match = /^- \*\*(.+?):\*\*\s*(.*)$/.exec(line.trim());
      if (match) fields.set(match[1]!, match[2]!.trim().replace(/^`|`$/g, ''));
    }

    const subjectMatch = /## Message \d+: (.+)/.exec(block);
    const textBodyMatch = /### Text body\s*\n\s*```text\n([\s\S]*?)```/.exec(block);
    const threadId = fields.get('Thread ID');
    const messageId = fields.get('Message ID');
    const direction = fields.get('Direction')?.toLowerCase();
    if (!threadId || !messageId || (direction !== 'inbound' && direction !== 'outbound')) continue;

    rows.push({
      messageId,
      threadId,
      direction,
      from: fields.get('From') ?? '',
      to: fields.get('To') ?? '',
      cc: fields.get('CC') ?? '',
      subject: subjectMatch?.[1]?.trim() ?? '',
      bodyText: textBodyMatch?.[1]?.replace(/\n$/, '') ?? '',
      receivedAt: fields.get('Received') ?? fields.get('Sent') ?? fields.get('Created') ?? '',
    });
  }

  const grouped = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.threadId) ?? [];
    existing.push(row);
    grouped.set(row.threadId, existing);
  }

  for (const [threadId, threadRows] of grouped) {
    threadRows.sort((left, right) =>
      left.receivedAt === right.receivedAt
        ? left.messageId.localeCompare(right.messageId)
        : left.receivedAt.localeCompare(right.receivedAt),
    );
    grouped.set(threadId, threadRows);
  }

  return { rows, byThread: grouped };
}

function snapshotRowToConversationMessage(row: SnapshotRow): ConversationMessage {
  return {
    id: row.messageId,
    threadId: row.threadId,
    direction: row.direction,
    from: row.from,
    to: row.to,
    cc: row.cc,
    subject: row.subject,
    bodyText: row.bodyText,
    receivedAt: row.receivedAt,
  };
}

function snapshotRowToIndexable(row: SnapshotRow): IndexableMessage {
  const message = snapshotRowToConversationMessage(row);
  const { bodyText: _bodyText, ...indexable } = message;
  return indexable;
}

function findThreadIdByPrefix(
  byThread: ReadonlyMap<string, readonly SnapshotRow[]>,
  prefix: string,
): string | undefined {
  for (const threadId of byThread.keys()) {
    if (threadId.startsWith(prefix)) return threadId;
  }
  return undefined;
}

function pickTriggerMessage(messages: readonly SnapshotRow[]): SnapshotRow {
  const inbound = messages.filter((message) => message.direction === 'inbound');
  let trigger = inbound[0]!;
  for (const message of inbound) {
    if (isExternalSender(message.from, message.subject) && !isChannelAutomatedInbound(message)) {
      trigger = message;
      break;
    }
  }
  return trigger;
}

export function loadDefensibleGoldThreads(corpusRoot: string): DefensibleGoldThread[] {
  const goldPath = path.join(corpusRoot, 'follow-up', '_work', 'defensible-daily-chart-2026-09-01.json');
  const parsed = JSON.parse(readFileSync(goldPath, 'utf8')) as {
    threads: Array<{ threadId: string; responded: boolean }>;
  };
  return parsed.threads.map((thread) => ({
    threadId: thread.threadId,
    responded: thread.responded,
  }));
}

export function runConversationSignalsGoldEval(input: {
  goldThreads: readonly DefensibleGoldThread[];
  rows: readonly SnapshotRow[];
  byThread: ReadonlyMap<string, readonly SnapshotRow[]>;
}): GoldEvalResult {
  const indexableRows = input.rows.map(snapshotRowToIndexable);
  const autoConfirmIndex = buildAutoConfirmIndex(indexableRows);
  const orphanByGuest = buildOrphanOutboundIndex(indexableRows);

  const cases: GoldEvalCase[] = [];
  let skippedThreads = 0;

  for (const gold of input.goldThreads) {
    const fullThreadId = findThreadIdByPrefix(input.byThread, gold.threadId);
    if (!fullThreadId) {
      skippedThreads += 1;
      continue;
    }

    const threadRows = input.byThread.get(fullThreadId)!;
    const trigger = pickTriggerMessage(threadRows);
    const messages = threadRows.map(snapshotRowToConversationMessage);
    const signals = detectConversationSignals({
      threadId: fullThreadId,
      triggerMessageId: trigger.messageId,
      messages,
      autoConfirmIndex,
      orphanByGuest,
    });
    const predictedResponded = isConversationResponded(signals);

    cases.push({
      threadIdPrefix: gold.threadId,
      fullThreadId,
      goldResponded: gold.responded,
      predictedResponded,
      triggerMessageId: trigger.messageId,
    });
  }

  let truePositives = 0;
  let falseNegatives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let goldResponded = 0;
  let goldUnanswered = 0;
  let predictedResponded = 0;

  for (const evalCase of cases) {
    if (evalCase.goldResponded) goldResponded += 1;
    else goldUnanswered += 1;
    if (evalCase.predictedResponded) predictedResponded += 1;

    if (evalCase.goldResponded && evalCase.predictedResponded) truePositives += 1;
    else if (evalCase.goldResponded && !evalCase.predictedResponded) falseNegatives += 1;
    else if (!evalCase.goldResponded && evalCase.predictedResponded) falsePositives += 1;
    else trueNegatives += 1;
  }

  return {
    matrix: {
      truePositives,
      falseNegatives,
      falsePositives,
      trueNegatives,
      goldResponded,
      goldUnanswered,
      goldTotal: cases.length,
      predictedResponded,
      skippedThreads,
    },
    cases,
  };
}

export function evaluateGoldGate(matrix: ConfusionMatrixCounts): {
  recallPass: boolean;
  falsePositivePass: boolean;
  pass: boolean;
} {
  const recallPass = matrix.truePositives >= GOLD_RECALL_MIN;
  const falsePositivePass = matrix.falsePositives <= GOLD_FALSE_POSITIVE_MAX;
  return {
    recallPass,
    falsePositivePass,
    pass: recallPass && falsePositivePass,
  };
}

export function formatConfusionMatrixStdout(matrix: ConfusionMatrixCounts): string {
  const recallPct =
    matrix.goldResponded > 0
      ? ((matrix.truePositives / matrix.goldResponded) * 100).toFixed(1)
      : '0.0';
  const fpPct =
    matrix.goldUnanswered > 0
      ? ((matrix.falsePositives / matrix.goldUnanswered) * 100).toFixed(1)
      : '0.0';

  return JSON.stringify(
    {
      confusion: {
        truePositives: matrix.truePositives,
        falseNegatives: matrix.falseNegatives,
        falsePositives: matrix.falsePositives,
        trueNegatives: matrix.trueNegatives,
      },
      gold: {
        actionable: matrix.goldTotal,
        responded: matrix.goldResponded,
        unanswered: matrix.goldUnanswered,
      },
      predicted: {
        responded: matrix.predictedResponded,
      },
      rates: {
        recall: `${matrix.truePositives}/${matrix.goldResponded} (${recallPct}%)`,
        falsePositive: `${matrix.falsePositives}/${matrix.goldUnanswered} (${fpPct}%)`,
      },
      gate: {
        recallMin: `${GOLD_RECALL_MIN}/${GOLD_RESPONDED_TOTAL}`,
        falsePositiveMax: `${GOLD_FALSE_POSITIVE_MAX}/${GOLD_UNANSWERED_TOTAL}`,
        ...evaluateGoldGate(matrix),
      },
      skippedThreads: matrix.skippedThreads,
    },
    null,
    2,
  );
}

export function runConversationSignalsGoldEvalFromCorpus(corpusRoot: string): GoldEvalResult {
  const snapshotPath = path.join(corpusRoot, 'connected-mailbox-inbox-2026-08-30.md');
  const snapshotText = readFileSync(snapshotPath, 'utf8');
  const { rows, byThread } = parseConnectedMailboxSnapshot(snapshotText);
  const goldThreads = loadDefensibleGoldThreads(corpusRoot);
  return runConversationSignalsGoldEval({ goldThreads, rows, byThread });
}
