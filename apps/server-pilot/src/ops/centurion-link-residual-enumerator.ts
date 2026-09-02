/**
 * Layer C residual pair enumeration — cross-thread B-signals, quoted hotel body links,
 * and guarded subject clusters for deterministic linker backfill.
 */

import {
  buildAutoConfirmIndex,
  buildOrphanOutboundIndex,
  detectConversationSignals,
  externalEmails,
  isAutoOutbound,
  type AutoConfirmRow,
  type ConversationMessage,
  type IndexableMessage,
  type OrphanOutboundRow,
} from '../mail/conversation-signals.js';
import {
  parseConnectedMailboxSnapshot,
  resolvePrivateCorpusRoot,
  type SnapshotRow,
} from './centurion-conversation-signals-eval.js';

export type { SnapshotRow };

export type ResidualLinkType =
  | 'domain_conf'
  | 'domain_guest_email'
  | 'quoted_body'
  | 'subject_cluster';

export type ResidualReason =
  | 'cross_thread_conf'
  | 'orphan_auto_confirm'
  | 'orphan_centurion_human'
  | 'quoted_hotel_header'
  | 'subject_cluster';

export type ConfidenceBand = 'high' | 'medium' | 'low';

export type DefensibleThreadRow = {
  threadId: string;
  day: string;
  intent: string;
  centurionOnly: boolean;
  responded: boolean;
  threadClass: string;
  responseSignals: readonly string[];
};

export type StaffBriefThreadRow = {
  threadId: string;
  subject: string;
  day: string;
  intent: string;
};

export type ThreadLinkResidualPair = {
  srcThreadId: string;
  dstThreadId: string;
  linkType: ResidualLinkType;
  reason: ResidualReason;
  confidenceBand: ConfidenceBand;
  confidence: number;
  evidence: {
    matchKey?: string;
    spanHours?: number;
    normSubject?: string;
  };
};

export type ThreadLinkResidualReport = {
  schemaVersion: 1;
  generatedAt: string;
  sources: {
    defensible: string;
    walkthrough: string;
    staffBrief: string;
    inboxMarkdown: string;
  };
  totals: {
    actionable: number;
    pairsTotal: number;
    byReason: Record<ResidualReason, number>;
    byLinkType: Record<ResidualLinkType, number>;
    byConfidenceBand: Record<ConfidenceBand, number>;
    deterministicLinker: number;
    llmResidual: number;
  };
  handoff: {
    deterministicLinker: { count: number; linkTypes: readonly ResidualLinkType[] };
    llmResidual: { count: number; linkTypes: readonly ResidualLinkType[] };
  };
  pairs: readonly ThreadLinkResidualPair[];
};

export type LinkResidualEnumerationInput = {
  defensibleThreads: readonly DefensibleThreadRow[];
  staffBriefThreads: readonly StaffBriefThreadRow[];
  rows: readonly SnapshotRow[];
  byThread: ReadonlyMap<string, readonly SnapshotRow[]>;
  sources: ThreadLinkResidualReport['sources'];
  generatedAt?: string;
};

const CONF_RE = /n[°º]\s*(\d{6,})-1/i;
const QUOTED_FROM_HOTEL_RE =
  /From:\s*(?:Centurion Hotel Reservations|Martha Mthembu|Isaac Seabi)\s*<(?:centurion|marthamthembu|isaacseabi)@legacyhotels/i;
const INTERNAL_DOMAINS = ['legacyhotels', 'navaai', 'synxis', 'reservecloud', 'fortimail'] as const;
const OPS_DIGEST_SUBJECT_RE =
  /(?:night audit|fortimail|quarantine|security digest|guestrevu|mailer-daemon|unpaid booking|failure notification|update failure|daily summary|do not reply|booking update notification)/i;
const SUBJECT_CLUSTER_MAX_HOURS = 72;
const MIN_CONFIDENCE = 0.55;

const EMPTY_REASON_COUNTS = (): Record<ResidualReason, number> => ({
  cross_thread_conf: 0,
  orphan_auto_confirm: 0,
  orphan_centurion_human: 0,
  quoted_hotel_header: 0,
  subject_cluster: 0,
});

const EMPTY_LINK_TYPE_COUNTS = (): Record<ResidualLinkType, number> => ({
  domain_conf: 0,
  domain_guest_email: 0,
  quoted_body: 0,
  subject_cluster: 0,
});

const EMPTY_BAND_COUNTS = (): Record<ConfidenceBand, number> => ({
  high: 0,
  medium: 0,
  low: 0,
});

function pairKey(pair: Pick<ThreadLinkResidualPair, 'srcThreadId' | 'dstThreadId' | 'linkType'>): string {
  const [left, right] = [pair.srcThreadId, pair.dstThreadId].sort();
  return `${left}|${right}|${pair.linkType}`;
}

function dayFromReceived(receivedAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(receivedAt ?? '');
  return match?.[1] ?? '';
}

function isExternalEmail(email: string): boolean {
  const lower = email.toLowerCase();
  return !INTERNAL_DOMAINS.some((domain) => lower.includes(domain));
}

function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.75) return 'high';
  if (confidence >= 0.55) return 'medium';
  return 'low';
}

/** RFC-style subject normalize for conversation-layer grouping (not ingest). */
export function normalizeConversationSubject(subject: string): string {
  let s = subject.trim().toLowerCase();
  for (let i = 0; i < 12; i++) {
    const stripped = s.replace(/^(re|fwd|fw|aw|sv)\s*:\s*/i, '').trim();
    const bracket = stripped.replace(/^\[[^\]]+\]\s*/i, '').trim();
    if (bracket === s) break;
    s = bracket;
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** Collapse Outlook-style spaced subjects ("B re akfast Pack Re quest"). */
export function collapseSpacedSubjectArtifacts(normSubject: string): string {
  const tokens = normSubject.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return normSubject;
  const shortCount = tokens.filter((token) => token.length <= 3).length;
  if (shortCount / tokens.length < 0.35) return normSubject;
  return tokens.join('');
}

export function isOpsDigestSubject(subject: string): boolean {
  return OPS_DIGEST_SUBJECT_RE.test(subject);
}

export function resolvePrivateCorpusWorkRoot(corpusRoot: string): string {
  return `${corpusRoot.replace(/\/$/, '')}/follow-up/_work`;
}

export function resolveLinkResidualOutputPath(workRoot: string): string {
  return `${workRoot.replace(/\/$/, '')}/thread-link-residual-2026-09-02.json`;
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

function pickTriggerMessage(messages: readonly SnapshotRow[]): SnapshotRow {
  return messages.find((message) => message.direction === 'inbound') ?? messages[0]!;
}

function primaryParticipants(rows: readonly SnapshotRow[]): Set<string> {
  const participants = new Set<string>();
  for (const row of rows) {
    for (const email of externalEmails(`${row.from} ${row.to} ${row.cc}`)) {
      if (isExternalEmail(email)) participants.add(email);
    }
  }
  return participants;
}

function participantsOverlap(left: Set<string>, right: Set<string>): boolean {
  for (const email of left) {
    if (right.has(email)) return true;
  }
  return false;
}

function spanHoursBetweenThreads(
  leftRows: readonly SnapshotRow[],
  rightRows: readonly SnapshotRow[],
): number {
  const timestamps = [...leftRows, ...rightRows]
    .map((row) => Date.parse(row.receivedAt))
    .filter((value) => Number.isFinite(value));
  if (timestamps.length < 2) return 0;
  return (Math.max(...timestamps) - Math.min(...timestamps)) / (60 * 60 * 1000);
}

function hasInThreadOutbound(signals: readonly string[]): boolean {
  return signals.some((signal) => signal.includes('in_thread'));
}

function normalizeSignalName(signal: string): string {
  return signal.split(/\s+/)[0] ?? signal;
}

function findCrossThreadPairs(input: {
  threadId: string;
  messages: readonly ConversationMessage[];
  trigger: ConversationMessage;
  autoConfirmIndex: readonly AutoConfirmRow[];
  orphanByGuest: ReadonlyMap<string, readonly OrphanOutboundRow[]>;
}): ThreadLinkResidualPair[] {
  const pairs: ThreadLinkResidualPair[] = [];
  const threadText = input.messages.map((message) => `${message.subject}\n${message.bodyText}`).join('\n');
  const triggerDay = dayFromReceived(input.trigger.receivedAt);
  const normText = threadText.toLowerCase().replace(/[^a-z0-9]/g, '');
  const confMatches = new Set<string>();
  for (const match of threadText.matchAll(new RegExp(CONF_RE.source, 'gi'))) {
    if (match[1]) confMatches.add(match[1]);
  }

  for (const auto of input.autoConfirmIndex) {
    if (auto.threadId === input.threadId) continue;
    if (auto.day && triggerDay && auto.day < triggerDay) continue;

    if (auto.conf && confMatches.has(auto.conf)) {
      pairs.push({
        srcThreadId: input.threadId,
        dstThreadId: auto.threadId,
        linkType: 'domain_conf',
        reason: 'cross_thread_conf',
        confidence: 0.9,
        confidenceBand: 'high',
        evidence: { matchKey: `conf:${auto.conf}` },
      });
      continue;
    }

    if (auto.guestNorm.length > 4 && normText.includes(auto.guestNorm)) {
      pairs.push({
        srcThreadId: input.threadId,
        dstThreadId: auto.threadId,
        linkType: 'domain_guest_email',
        reason: 'cross_thread_conf',
        confidence: 0.82,
        confidenceBand: 'high',
        evidence: { matchKey: `guest:${auto.guestNorm}` },
      });
    }
  }

  const guestEmails = new Set<string>();
  const triggerIdx = input.messages.findIndex((message) => message.id === input.trigger.id);
  for (const message of input.messages.slice(0, triggerIdx + 1)) {
    if (message.direction === 'inbound') {
      for (const email of externalEmails(message.from)) guestEmails.add(email);
    }
  }

  for (const guestEmail of guestEmails) {
    for (const orphan of input.orphanByGuest.get(guestEmail) ?? []) {
      if (orphan.threadId === input.threadId) continue;
      const subject = orphan.subject.toLowerCase();
      const from = orphan.from.toLowerCase();

      if (subject.includes('confirmation letter')) {
        pairs.push({
          srcThreadId: input.threadId,
          dstThreadId: orphan.threadId,
          linkType: 'domain_guest_email',
          reason: 'orphan_auto_confirm',
          confidence: 0.86,
          confidenceBand: 'high',
          evidence: { matchKey: `guest:${guestEmail}` },
        });
        continue;
      }

      if (from.includes('centurion@') && !orphan.isAuto) {
        pairs.push({
          srcThreadId: input.threadId,
          dstThreadId: orphan.threadId,
          linkType: 'domain_guest_email',
          reason: 'orphan_centurion_human',
          confidence: 0.8,
          confidenceBand: 'high',
          evidence: { matchKey: `guest:${guestEmail}` },
        });
      }
    }
  }

  return pairs;
}

function buildThreadTimeIndex(rows: readonly SnapshotRow[]): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  for (const row of rows) {
    const parsed = Date.parse(row.receivedAt);
    if (!Number.isFinite(parsed)) continue;
    const existing = index.get(row.threadId);
    if (existing === undefined || parsed < existing) {
      index.set(row.threadId, parsed);
    }
  }
  return index;
}

function parseQuotedHeaderBlock(threadText: string): { emails: Set<string>; normSubject: string | null } {
  const blockMatch = threadText.match(
    /From:\s*(?:Centurion Hotel Reservations|Martha Mthembu|Isaac Seabi)[\s\S]*?(?:\n\n|\r\n\r\n|$)/i,
  );
  const block = blockMatch?.[0] ?? threadText;
  const emails = new Set<string>();
  for (const email of externalEmails(block)) {
    if (isExternalEmail(email)) emails.add(email);
  }
  const subjectMatch = /Subject:\s*(.+)/i.exec(block);
  const normSubject = subjectMatch ? normalizeConversationSubject(subjectMatch[1]!) : null;
  return { emails, normSubject };
}

function findQuotedHotelPairs(input: {
  threadId: string;
  messages: readonly ConversationMessage[];
  trigger: ConversationMessage;
  rows: readonly SnapshotRow[];
  threadTimes: ReadonlyMap<string, number>;
}): ThreadLinkResidualPair[] {
  const threadText = input.messages.map((message) => `${message.subject}\n${message.bodyText}`).join('\n');
  if (!QUOTED_FROM_HOTEL_RE.test(threadText)) return [];

  const pairs: ThreadLinkResidualPair[] = [];
  const triggerTime = Date.parse(input.trigger.receivedAt);
  const srcParticipants = primaryParticipants(
    input.messages.map((message) => ({
      messageId: message.id,
      threadId: message.threadId,
      direction: message.direction,
      from: message.from,
      to: message.to,
      cc: message.cc ?? '',
      subject: message.subject,
      bodyText: message.bodyText,
      receivedAt: message.receivedAt,
    })),
  );
  const quotedHeader = parseQuotedHeaderBlock(threadText);
  const participantUnion = new Set<string>([...srcParticipants, ...quotedHeader.emails]);

  const candidates: Array<{ threadId: string; score: number; matchKey: string }> = [];

  for (const row of input.rows) {
    if (row.direction !== 'outbound') continue;
    if (row.threadId === input.threadId) continue;
    if (!row.from.toLowerCase().includes('centurion@') && !row.from.toLowerCase().includes('marthamthembu@')) {
      continue;
    }

    const rowParticipants = externalEmails(`${row.to} ${row.cc}`);
    const overlap = [...participantUnion].filter((email) => rowParticipants.has(email));
    if (overlap.length === 0) continue;

    const rowTime = input.threadTimes.get(row.threadId);
    if (Number.isFinite(triggerTime) && rowTime !== undefined && rowTime > triggerTime) {
      continue;
    }

    let score = 0.62;
    if (!isAutoOutbound(row.subject, row.to)) score += 0.08;
    if (
      quotedHeader.normSubject &&
      normalizeConversationSubject(row.subject) === quotedHeader.normSubject
    ) {
      score += 0.08;
    }
    if (overlap.length >= 2) score += 0.04;

    candidates.push({
      threadId: row.threadId,
      score: Math.min(score, 0.78),
      matchKey: `guest:${overlap[0]}`,
    });
  }

  candidates.sort((left, right) => right.score - left.score);
  const bestByThread = new Map<string, { score: number; matchKey: string }>();
  for (const candidate of candidates) {
    const existing = bestByThread.get(candidate.threadId);
    if (!existing || candidate.score > existing.score) {
      bestByThread.set(candidate.threadId, candidate);
    }
  }

  for (const [dstThreadId, candidate] of bestByThread) {
    pairs.push({
      srcThreadId: input.threadId,
      dstThreadId,
      linkType: 'quoted_body',
      reason: 'quoted_hotel_header',
      confidence: candidate.score,
      confidenceBand: confidenceBand(candidate.score),
      evidence: { matchKey: candidate.matchKey },
    });
  }

  return pairs;
}

function subjectClusterKey(subject: string): string | null {
  const norm = normalizeConversationSubject(subject);
  if (!norm || norm.length < 8 || isOpsDigestSubject(norm)) return null;
  const collapsed = collapseSpacedSubjectArtifacts(norm);
  return collapsed.length >= 8 ? collapsed : norm;
}

function findSubjectClusterPairs(input: {
  actionableThreadIds: ReadonlySet<string>;
  subjectByThreadId: ReadonlyMap<string, string>;
  byThread: ReadonlyMap<string, readonly SnapshotRow[]>;
}): ThreadLinkResidualPair[] {
  const groups = new Map<string, string[]>();

  for (const threadId of input.actionableThreadIds) {
    const subject = input.subjectByThreadId.get(threadId);
    if (!subject) continue;
    const key = subjectClusterKey(subject);
    if (!key) continue;
    const bucket = groups.get(key) ?? [];
    bucket.push(threadId);
    groups.set(key, bucket);
  }

  const pairs: ThreadLinkResidualPair[] = [];
  for (const [normSubject, threadIds] of groups) {
    if (threadIds.length < 2) continue;

    for (let leftIndex = 0; leftIndex < threadIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < threadIds.length; rightIndex += 1) {
        const leftThreadId = threadIds[leftIndex]!;
        const rightThreadId = threadIds[rightIndex]!;
        const leftRows = input.byThread.get(leftThreadId) ?? [];
        const rightRows = input.byThread.get(rightThreadId) ?? [];
        const spanHours = spanHoursBetweenThreads(leftRows, rightRows);
        if (spanHours > SUBJECT_CLUSTER_MAX_HOURS) continue;

        const leftParticipants = primaryParticipants(leftRows);
        const rightParticipants = primaryParticipants(rightRows);
        if (!participantsOverlap(leftParticipants, rightParticipants)) continue;

        const overlapCount = [...leftParticipants].filter((email) => rightParticipants.has(email)).length;
        const confidence =
          spanHours <= 24 && overlapCount >= 1 ? 0.7 : spanHours <= 72 ? 0.62 : 0.5;
        if (confidence < MIN_CONFIDENCE) continue;

        pairs.push({
          srcThreadId: leftThreadId,
          dstThreadId: rightThreadId,
          linkType: 'subject_cluster',
          reason: 'subject_cluster',
          confidence,
          confidenceBand: confidenceBand(confidence),
          evidence: {
            normSubject,
            spanHours: Math.round(spanHours * 10) / 10,
            matchKey: `overlap:${overlapCount}`,
          },
        });
      }
    }
  }

  return pairs;
}

function buildTotals(pairs: readonly ThreadLinkResidualPair[], actionable: number) {
  const byReason = EMPTY_REASON_COUNTS();
  const byLinkType = EMPTY_LINK_TYPE_COUNTS();
  const byConfidenceBand = EMPTY_BAND_COUNTS();

  for (const pair of pairs) {
    byReason[pair.reason] += 1;
    byLinkType[pair.linkType] += 1;
    byConfidenceBand[pair.confidenceBand] += 1;
  }

  const deterministicLinker = pairs.filter((pair) => pair.confidenceBand === 'high').length;
  const llmResidual = pairs.filter((pair) => pair.confidenceBand === 'medium').length;

  const deterministicTypes = [
    ...new Set(
      pairs.filter((pair) => pair.confidenceBand === 'high').map((pair) => pair.linkType),
    ),
  ] as ResidualLinkType[];
  const llmTypes = [
    ...new Set(
      pairs.filter((pair) => pair.confidenceBand === 'medium').map((pair) => pair.linkType),
    ),
  ] as ResidualLinkType[];

  return {
    actionable,
    pairsTotal: pairs.length,
    byReason,
    byLinkType,
    byConfidenceBand,
    deterministicLinker,
    llmResidual,
    handoff: {
      deterministicLinker: { count: deterministicLinker, linkTypes: deterministicTypes },
      llmResidual: { count: llmResidual, linkTypes: llmTypes },
    },
  };
}

export function enumerateCenturionLinkResiduals(
  input: LinkResidualEnumerationInput,
): ThreadLinkResidualReport {
  const indexableRows = input.rows.map(snapshotRowToIndexable);
  const autoConfirmIndex = buildAutoConfirmIndex(indexableRows);
  const orphanByGuest = buildOrphanOutboundIndex(indexableRows);
  const threadTimes = buildThreadTimeIndex(input.rows);

  const subjectByPrefix = new Map(
    input.staffBriefThreads.map((thread) => [thread.threadId, thread.subject]),
  );

  const actionableThreadIds = new Set<string>();
  const subjectByThreadId = new Map<string, string>();

  for (const gold of input.defensibleThreads) {
    const fullThreadId = findThreadIdByPrefix(input.byThread, gold.threadId);
    if (!fullThreadId) continue;
    actionableThreadIds.add(fullThreadId);
    const subject = subjectByPrefix.get(gold.threadId);
    if (subject) subjectByThreadId.set(fullThreadId, subject);
  }

  const pairMap = new Map<string, ThreadLinkResidualPair>();

  const addPairs = (pairs: readonly ThreadLinkResidualPair[]) => {
    for (const pair of pairs) {
      if (pair.confidence < MIN_CONFIDENCE) continue;
      if (pair.srcThreadId === pair.dstThreadId) continue;
      pairMap.set(pairKey(pair), pair);
    }
  };

  for (const gold of input.defensibleThreads) {
    const fullThreadId = findThreadIdByPrefix(input.byThread, gold.threadId);
    if (!fullThreadId) continue;

    const threadRows = input.byThread.get(fullThreadId) ?? [];
    if (threadRows.length === 0) continue;

    const messages = threadRows.map(snapshotRowToConversationMessage);
    const trigger = pickTriggerMessage(threadRows);
    const triggerMessage = snapshotRowToConversationMessage(trigger);
    const signals = detectConversationSignals({
      threadId: fullThreadId,
      triggerMessageId: trigger.messageId,
      messages,
      autoConfirmIndex,
      orphanByGuest,
    }).map(normalizeSignalName);

    const defensibleSignals = gold.responseSignals.map(normalizeSignalName);
    const responded = gold.responded;
    const crossThreadSignals = new Set<ResidualReason>([
      'cross_thread_conf',
      'orphan_auto_confirm',
      'orphan_centurion_human',
    ]);

    const shouldEnumerateCross =
      responded &&
      (signals.some((signal) => crossThreadSignals.has(signal as ResidualReason)) ||
        defensibleSignals.some((signal) => crossThreadSignals.has(signal as ResidualReason))) &&
      !hasInThreadOutbound([...signals, ...defensibleSignals]);

    if (shouldEnumerateCross) {
      addPairs(
        findCrossThreadPairs({
          threadId: fullThreadId,
          messages,
          trigger: triggerMessage,
          autoConfirmIndex,
          orphanByGuest,
        }),
      );
    }

    const quotedSignal =
      signals.includes('quoted_hotel_header') || defensibleSignals.includes('quoted_hotel_header');
    if (responded && quotedSignal) {
      addPairs(
        findQuotedHotelPairs({
          threadId: fullThreadId,
          messages,
          trigger: triggerMessage,
          rows: input.rows,
          threadTimes,
        }),
      );
    }
  }

  addPairs(
    findSubjectClusterPairs({
      actionableThreadIds,
      subjectByThreadId,
      byThread: input.byThread,
    }),
  );

  const pairs = [...pairMap.values()].sort((left, right) => {
    const reason = left.reason.localeCompare(right.reason);
    if (reason !== 0) return reason;
    const src = left.srcThreadId.localeCompare(right.srcThreadId);
    if (src !== 0) return src;
    return left.dstThreadId.localeCompare(right.dstThreadId);
  });

  const totals = buildTotals(pairs, input.defensibleThreads.length);

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    sources: input.sources,
    totals: {
      actionable: totals.actionable,
      pairsTotal: totals.pairsTotal,
      byReason: totals.byReason,
      byLinkType: totals.byLinkType,
      byConfidenceBand: totals.byConfidenceBand,
      deterministicLinker: totals.deterministicLinker,
      llmResidual: totals.llmResidual,
    },
    handoff: totals.handoff,
    pairs,
  };
}

export function formatResidualStdout(report: ThreadLinkResidualReport): string {
  return JSON.stringify(
    {
      totals: {
        actionable: report.totals.actionable,
        pairsTotal: report.totals.pairsTotal,
        byReason: report.totals.byReason,
        byLinkType: report.totals.byLinkType,
        byConfidenceBand: report.totals.byConfidenceBand,
        deterministicLinker: report.totals.deterministicLinker,
        llmResidual: report.totals.llmResidual,
      },
      handoff: report.handoff,
    },
    null,
    2,
  );
}

export async function runCenturionLinkResidualEnumerationFromCorpus(
  corpusRoot: string,
): Promise<ThreadLinkResidualReport> {
  const { readFile } = await import('node:fs/promises');
  const workRoot = resolvePrivateCorpusWorkRoot(corpusRoot);

  const defensible = JSON.parse(
    await readFile(`${workRoot}/defensible-daily-chart-2026-09-01.json`, 'utf8'),
  ) as { threads: DefensibleThreadRow[] };
  const staffBrief = JSON.parse(
    await readFile(`${workRoot}/staff-email-brief-analysis-2026-09-01.json`, 'utf8'),
  ) as { threads: StaffBriefThreadRow[] };
  const snapshotText = await readFile(`${corpusRoot}/connected-mailbox-inbox-2026-08-30.md`, 'utf8');
  const { rows, byThread } = parseConnectedMailboxSnapshot(snapshotText);

  return enumerateCenturionLinkResiduals({
    defensibleThreads: defensible.threads,
    staffBriefThreads: staffBrief.threads,
    rows,
    byThread,
    sources: {
      defensible: `${workRoot}/defensible-daily-chart-2026-09-01.json`,
      walkthrough: `${workRoot}/thread-walkthrough-2026-09-01.json`,
      staffBrief: `${workRoot}/staff-email-brief-analysis-2026-09-01.json`,
      inboxMarkdown: `${corpusRoot}/connected-mailbox-inbox-2026-08-30.md`,
    },
  });
}

export function resolveCorpusRootFromStartDir(startDir: string): string {
  return resolvePrivateCorpusRoot(startDir);
}

export { resolvePrivateCorpusRoot };
