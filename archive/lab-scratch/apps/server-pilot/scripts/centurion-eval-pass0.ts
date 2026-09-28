#!/usr/bin/env tsx
/**
 * Pass 0: thread outbound index, restore skipped channel-auto gold,
 * useful-attachment queue, occupancy without for-N. Counts on stdout.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  assignThreadOutcome,
  isUsefulEvalAttachment,
  parseOccupancyFromBody,
  THREAD_OUTCOME_COPY,
  type ThreadOutcome,
} from '../../../../../apps/server-pilot/src/ops/centurion-eval-lab.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SNAP = path.join(
  ROOT,
  '.private/connected-mailbox-corpus/centurion-nine-day-4a8bb7ad-2d78-4d9a-92b2-9a5f31d2dd67/messages.jsonl',
);
const QPATH = path.join(
  ROOT,
  '.private/connected-mailbox-corpus/centurion-quarantine-2b18fff0-87b7-4713-914a-74e14a665a82/quarantine.jsonl',
);
const DEMAND = path.join(ROOT, '.private/centurion-corpus/centurion-tool-demand-20260919');
const WIN_END = '2026-09-18T14:50:00.000Z';
const CUTOFF_START = '2026-09-17T22:00:00.000Z';
const NO_REPLY_REASONS = new Set([
  'ota_channel_already_created',
  'thanks_ack_fyi',
  'processed_in_hms_no_email',
  'spam_or_channel_auto',
  'quote_waiting_on_guest',
]);

type JsonRow = Record<string, unknown>;

function loadJsonl(filePath: string): JsonRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRow);
}

function bump(map: Record<string, number>, key: string, n = 1) {
  map[key] = (map[key] || 0) + n;
}

function isOut(row: JsonRow): boolean {
  return (
    row.direction === 'outbound' ||
    row.businessDirection === 'outbound' ||
    row.confirmedOutbound === true
  );
}

function blob(row: JsonRow | undefined): string {
  if (!row) return '';
  return `${row.subject || ''}\n${row.textBody || ''}`;
}

const THANKS_RE = /\bthank(?:s| you)\b|\bkindly received\b|\bwell received\b/i;
const OTA_RE = /synxis|booking\.com|expedia|travelclick|hotelbeds|agoda|channel manager/i;
const BOOK_RE = /please\s+(?:kindly\s+)?book|new booking|would like to book/i;

function noReplyFromBody(text: string): boolean {
  if (OTA_RE.test(text)) return true;
  if (THANKS_RE.test(text) && !BOOK_RE.test(text)) return true;
  return false;
}

const messages = loadJsonl(SNAP);
const byId = new Map(messages.map((row) => [String(row.id), row]));
const byThread = new Map<string, JsonRow[]>();
for (const row of messages) {
  const threadId = String(row.threadId || '');
  if (!threadId) continue;
  if (!byThread.has(threadId)) byThread.set(threadId, []);
  byThread.get(threadId)!.push(row);
}

let quarantineById = new Map<string, JsonRow>();
try {
  for (const row of loadJsonl(QPATH)) {
    quarantineById.set(String(row.id), row);
  }
} catch {
  quarantineById = new Map();
}

const skips = new Set(
  loadJsonl(path.join(DEMAND, 'skips.jsonl'))
    .filter((row) => row.skipReason === 'channel_auto')
    .map((row) => String(row.goldId)),
);
const pairs = loadJsonl(path.join(DEMAND, 'pairs.jsonl'));
const pairedInbound = new Map(pairs.map((row) => [String(row.inboundId), String(row.goldId)]));
const pairedThreads = new Set<string>();
for (const pair of pairs) {
  const inbound = byId.get(String(pair.inboundId));
  if (inbound?.threadId) pairedThreads.add(String(inbound.threadId));
}

const pass2 = new Map<string, JsonRow>();
try {
  for (let i = 0; i < 5; i += 1) {
    for (const row of loadJsonl(path.join(DEMAND, `extracts/pass2-${i}.jsonl`))) {
      pass2.set(String(row.inboundId), row);
    }
  }
} catch {
  /* optional */
}

const extracts = loadJsonl(path.join(DEMAND, 'extracts/all-inbound-demand.jsonl'));

function mailFor(inboundId: string): JsonRow | undefined {
  return byId.get(inboundId) ?? quarantineById.get(inboundId);
}

function threadOuts(inboundId: string): JsonRow[] {
  const row = byId.get(inboundId);
  if (!row?.threadId) return [];
  return (byThread.get(String(row.threadId)) ?? []).filter(isOut);
}

function laterOuts(inboundId: string): JsonRow[] {
  const row = byId.get(inboundId);
  const at = String(row?.eventAt || '');
  if (!at) return [];
  return threadOuts(inboundId).filter((out) => String(out.eventAt || '') > at);
}

const outcomeCounts: Record<string, number> = {};
const toolTagCounts: Record<string, number> = {};
const attachmentQueue: Array<{
  inboundId: string;
  filename: string | null;
  contentType: string | null;
  byteSize: number | null;
  s3Key: string | null;
}> = [];
const labRows: JsonRow[] = [];
const canonical: JsonRow[] = [];
let occupancyKnown = 0;
let usefulAttMessages = 0;
let trueGap = 0;
let channelAutoRestored = 0;

for (const row of extracts) {
  const inboundId = String(row.inboundId);
  const mail = mailFor(inboundId);
  const p2 = pass2.get(inboundId);
  const goldId = pairedInbound.get(inboundId);
  const goldSkipped = goldId ? skips.has(goldId) : false;
  const later = laterOuts(inboundId);
  const threadHasAutoGold = threadOuts(inboundId).some((out) => skips.has(String(out.id)));
  const hasLaterHuman = later.some((out) => out.dailyIncluded === true && !skips.has(String(out.id)));
  const sibling = Boolean(mail?.threadId && pairedThreads.has(String(mail.threadId)) && !goldId);
  const parseFailure =
    row.matchMethod === 'parse_failure_unanswered' || String(row.matchMethod || '').includes('parse_failure');
  const eventAt = String(mail?.eventAt || row.eventAt || '');
  const windowCutoff = Boolean(eventAt && eventAt >= CUTOFF_START && eventAt < WIN_END && later.length === 0);
  const noReplyOwed =
    NO_REPLY_REASONS.has(String(p2?.noReplyReason || '')) || noReplyFromBody(blob(mail));

  const outcome: ThreadOutcome = assignThreadOutcome({
    unanswered: Boolean(row.unanswered),
    writeStateIndependent: p2?.writeStateIndependent ? String(p2.writeStateIndependent) : null,
    hasHumanGold: Boolean(goldId && !goldSkipped),
    hasChannelAutoGold: goldSkipped || threadHasAutoGold,
    hasLaterOutbound: hasLaterHuman || later.length > 0,
    hasSiblingGold: sibling,
    otherDesk: row.otherDesk ? String(row.otherDesk) : p2?.noReplyReason === 'other_desk_martha_kamala_penny' ? 'other' : null,
    noReplyOwed,
    windowCutoff,
    parseFailure,
  });
  bump(outcomeCounts, outcome);
  if (outcome === 'true_gap') trueGap += 1;
  if (outcome === 'gold_channel_auto') channelAutoRestored += 1;

  const tools = Array.isArray(row.pmsTools) ? (row.pmsTools as string[]) : [];
  if (row.decision !== 'skip') {
    for (const tool of new Set(tools)) bump(toolTagCounts, tool);
  }

  const occ = parseOccupancyFromBody(blob(mail));
  if (occ.paxTotal != null) occupancyKnown += 1;

  const descriptors = Array.isArray(mail?.attachmentDescriptors)
    ? (mail!.attachmentDescriptors as JsonRow[])
    : Array.isArray(mail?.attachments)
      ? (mail!.attachments as JsonRow[])
      : [];
  let queued = false;
  for (const att of descriptors) {
    const meta = {
      contentType: (att.contentType as string) ?? null,
      filename: (att.filename as string) ?? null,
      byteSize: typeof att.byteSize === 'number' ? att.byteSize : null,
    };
    if (!isUsefulEvalAttachment(meta)) continue;
    queued = true;
    attachmentQueue.push({
      inboundId,
      filename: meta.filename,
      contentType: meta.contentType,
      byteSize: meta.byteSize,
      s3Key: (att.s3Key as string) ?? null,
    });
  }
  if (queued) usefulAttMessages += 1;

  const goldMail = goldId ? byId.get(goldId) : undefined;
  labRows.push({
    inboundId,
    threadId: mail?.threadId ?? null,
    eventAt: eventAt || null,
    tools,
    decision: row.decision ?? null,
    threadOutcome: outcome,
    threadOutcomeCopy: THREAD_OUTCOME_COPY[outcome],
    otherDesk: row.otherDesk ?? null,
    paxTotal: occ.paxTotal,
    paxSource: occ.source,
    demandFamily: p2?.demandFamily ?? null,
    writeStateIndependent: p2?.writeStateIndependent ?? row.writeState ?? null,
    centurionReplyNeeded: p2?.centurionReplyNeeded ?? null,
    channelAuto: outcome === 'gold_channel_auto',
    inbound: {
      subject: mail?.subject ?? null,
      textBody: mail?.textBody ?? '',
      from: mail?.from ?? null,
      to: mail?.to ?? null,
    },
    gold: goldMail
      ? {
          id: goldId,
          subject: goldMail.subject ?? null,
          textBody: goldMail.textBody ?? '',
          channelAuto: goldSkipped,
        }
      : threadHasAutoGold
        ? {
            id: later.find((out) => skips.has(String(out.id)))?.id ?? threadOuts(inboundId).find((out) => skips.has(String(out.id)))?.id ?? null,
            subject: null,
            textBody: '',
            channelAuto: true,
          }
        : null,
    request: row.requestExtract ?? {},
    usedResult: row.usedResultHints ?? [],
    staffFilledAbsentFromInbound: [],
    spans: [],
    attachmentRefs: attachmentQueue.filter((item) => item.inboundId === inboundId).map((item) => ({
      filename: item.filename,
      contentType: item.contentType,
      byteSize: item.byteSize,
    })),
  });

  canonical.push({
    inboundId,
    threadOutcome: outcome,
    tools,
    demandFamily: p2?.demandFamily ?? null,
    paxTotal: occ.paxTotal,
    usefulAttachmentCount: attachmentQueue.filter((item) => item.inboundId === inboundId).length,
    pass: 'pass0',
  });
}

const pass0 = {
  extracts: extracts.length,
  threadOutcome: outcomeCounts,
  trueGap,
  channelAutoRestored,
  occupancyKnown,
  usefulAttachmentMessages: usefulAttMessages,
  usefulAttachmentFiles: attachmentQueue.length,
  toolTagCounts,
  stillNeededHypothesis: {
    pass2StillNeeded: [...pass2.values()].filter((row) => row.writeStateIndependent === 'still_needed').length,
    trueGapAfterPass0: trueGap,
  },
};

const truthDir = path.join(DEMAND, 'truth');
const labDir = path.join(DEMAND, 'lab');
mkdirSync(truthDir, { recursive: true, mode: 0o700 });
mkdirSync(labDir, { recursive: true, mode: 0o700 });
mkdirSync(path.join(DEMAND, 'extracts'), { recursive: true, mode: 0o700 });

writeFileSync(path.join(truthDir, 'pass0-thread-outcome.json'), `${JSON.stringify(pass0, null, 2)}\n`, {
  mode: 0o600,
});
writeFileSync(
  path.join(truthDir, 'attachment-queue.json'),
  `${JSON.stringify({ n: attachmentQueue.length, files: attachmentQueue }, null, 2)}\n`,
  { mode: 0o600 },
);
writeFileSync(path.join(DEMAND, 'extracts/canonical.jsonl'), `${canonical.map((row) => JSON.stringify(row)).join('\n')}\n`, {
  mode: 0o600,
});
writeFileSync(
  path.join(truthDir, 'pass0-per-inbound.jsonl'),
  `${canonical.map((row) => JSON.stringify(row)).join('\n')}\n`,
  { mode: 0o600 },
);
writeFileSync(path.join(labDir, 'index.json'), `${JSON.stringify({ generated: 'pass0', rows: labRows })}\n`, {
  mode: 0o600,
});
writeFileSync(
  path.join(truthDir, 'ledger-20260919.json'),
  `${JSON.stringify(
    {
      pass: 'pass0',
      nextProbe: trueGap > 200 ? 'pass3_threadOutcome_full_corpus' : 'pass3_true_gap_only',
      disagreements: { trueGap, pass2StillNeeded: pass0.stillNeededHypothesis.pass2StillNeeded },
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

console.log(JSON.stringify(pass0, null, 2));
