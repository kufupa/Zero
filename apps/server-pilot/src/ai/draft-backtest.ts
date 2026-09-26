/**
 * Centurion draft backtest — eval-only, no SMTP, no HMS writes, no product draft promote.
 * Purpose-built corpus scoring; never import from Vitest suites that touch pilot RDS.
 */
import {
  assertNoUncitedCriticalLiterals,
  formatMissingBracket,
  type EvidenceClaim,
} from './draft-evidence.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { PreparedAsk, PreparedFact } from './prepared-draft-input.js';
import { assessReply, type ReplyAssessment } from './reply-assessment.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const CENTURION_TRANSPORT_ID = 'transport-centurion';

/** Mailbox locals we treat as Centurion shared inbox (not personal staff). */
export function isCenturionMailboxFrom(fromAddress: string | null | undefined): boolean {
  if (!fromAddress) return false;
  const a = fromAddress.trim().toLowerCase();
  const angle = a.match(/<([^>]+)>/);
  const addr = (angle?.[1] ?? a).trim();
  return addr.startsWith('centurion@');
}

export type GoldPairingKind = 'centurion_outbound' | 'forward_or_external' | 'no_gold_reply';
export type EvaluationMode = 'current-state' | 'historical-replay' | 'future-shadow';

export type CorpusPair = {
  threadId: string;
  inboundMessageId: string;
  inboundMessageIdHash: string;
  goldKind: GoldPairingKind;
  /** Redacted/hash-only; never log raw body in callers. */
  goldOutboundMessageId: string | null;
};

export type DraftEvalRecord = {
  runId: string;
  inboundMessageIdHash: string;
  threadIdHash: string;
  goldKind: GoldPairingKind;
  draftText: string;
  evidenceTokens: string[];
  bracketLines: string[];
  failureClasses: FailureClass[];
  scoredAt: string;
  /** Fraction of gold critical tokens covered by draft or brackets (0..1). */
  goldCriticalCoverage?: number;
  /** Soft word Jaccard vs gold (0..1); PII-free aggregate only. */
  softWordOverlap?: number;
  draftMode?: string;
  /** (1) facts we could cite vs gold critical tokens. */
  toolCoverageRate?: number;
  /** (1) unresolved brackets count. */
  missingToolBracketCount?: number;
  /** (2) gold critical tokens not covered (wrong/missing vs real reply). */
  wrongOrMissingFactCount?: number;
  /** (3) tone overlap alias of softWordOverlap. */
  toneOverlap?: number;
  /** Gold reply id hash — dedupe key for centurion-from-replies sample. */
  goldMessageIdHash?: string;
  /** Explicit boundary between current, historical, and future evaluation. */
  evaluationMode: EvaluationMode;
};

export type FailureClass =
  | 'INVENTED_FACT'
  | 'MISSING_BRACKET'
  | 'NO_GOLD_REPLY'
  | 'FORWARD_OR_EXTERNAL'
  | 'LOW_GOLD_COVERAGE'
  | 'LOW_TONE'
  | 'SOFT_OTHER';

export type AggregateScorecard = {
  runId: string;
  evaluationMode: EvaluationMode;
  scored: number;
  byClass: Record<FailureClass, number>;
  inventedFactRate: number;
  meanGoldCriticalCoverage: number;
  meanSoftWordOverlap: number;
  meanToolCoverageRate: number;
  meanToneOverlap: number;
  totalMissingToolBrackets: number;
  totalWrongOrMissingFacts: number;
};

export type GoldCompareResult = {
  goldCriticalCoverage: number;
  softWordOverlap: number;
  goldTokenCount: number;
  uncoveredGoldTokens: number;
  toolCoverageRate: number;
  missingToolBracketCount: number;
  wrongOrMissingFactCount: number;
  toneOverlap: number;
};

const CRITICAL_TOKEN_RE =
  /\b(?:ZAR|R)\s?\d[\d,.]*|\b\d{4}-\d{2}-\d{2}\b|\b(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})\b|\bCONF-[A-Z0-9-]{2,}\b|\bEXT-[A-Z0-9-]{2,}\b|\b\d{6,}(?:-\d{1,3})?\b/gi;

export function hashOpaqueId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 16);
}

/**
 * Same-thread gold: earliest outbound after inbound from Centurion transport.
 * Labels without outbound → NO_GOLD; forward markers → FORWARD_OR_EXTERNAL.
 */
export function pairCenturionGold(input: {
  inboundMessageId: string;
  threadId: string;
  messages: ReadonlyArray<{
    id: string;
    direction: 'inbound' | 'outbound';
    transportId: string | null;
    createdAt: string;
    subject?: string | null;
  }>;
}): CorpusPair {
  const inbound = input.messages.find((m) => m.id === input.inboundMessageId);
  if (!inbound || inbound.direction !== 'inbound') {
    throw new Error('inbound message required for gold pairing');
  }
  if (inbound.transportId !== CENTURION_TRANSPORT_ID) {
    return {
      threadId: input.threadId,
      inboundMessageId: input.inboundMessageId,
      inboundMessageIdHash: hashOpaqueId(input.inboundMessageId),
      goldKind: 'no_gold_reply',
      goldOutboundMessageId: null,
    };
  }
  const inboundAt = Date.parse(inbound.createdAt);
  const laterOutbound = input.messages
    .filter(
      (m) =>
        m.direction === 'outbound' &&
        m.transportId === CENTURION_TRANSPORT_ID &&
        Date.parse(m.createdAt) >= inboundAt,
    )
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const first = laterOutbound[0] ?? null;
  let goldKind: GoldPairingKind = 'no_gold_reply';
  if (first) {
    const subj = (first.subject ?? '').toLowerCase();
    goldKind =
      /\bfw:|\bfwd:|forward(ed)?\b/.test(subj) || /\bexternal\b/.test(subj)
        ? 'forward_or_external'
        : 'centurion_outbound';
  }

  return {
    threadId: input.threadId,
    inboundMessageId: input.inboundMessageId,
    inboundMessageIdHash: hashOpaqueId(input.inboundMessageId),
    goldKind,
    goldOutboundMessageId: first?.id ?? null,
  };
}

/**
 * Gold = message FROM centurion@ that replies on an existing thread
 * (at least one prior message). Trigger = latest prior message.
 * Only an outbound Centurion message may be gold; the trigger must be the
 * latest earlier inbound on the same Centurion transport.
 */
export function pairCenturionFromReply(input: {
  threadId: string;
  goldMessageId: string;
  messages: ReadonlyArray<{
    id: string;
    direction: 'inbound' | 'outbound';
    transportId: string | null;
    fromAddress?: string | null;
    createdAt: string;
    subject?: string | null;
  }>;
}): CorpusPair {
  const gold = input.messages.find((m) => m.id === input.goldMessageId);
  if (!gold) throw new Error('gold message required');
  if (
    gold.direction !== 'outbound' ||
    gold.transportId !== CENTURION_TRANSPORT_ID ||
    !isCenturionMailboxFrom(gold.fromAddress)
  ) {
    throw new Error('gold must be from centurion@ mailbox');
  }
  const goldAt = Date.parse(gold.createdAt);
  const priors = input.messages
    .filter(
      (m) =>
        m.id !== gold.id &&
        m.direction === 'inbound' &&
        m.transportId === CENTURION_TRANSPORT_ID &&
        Date.parse(m.createdAt) < goldAt,
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  if (priors.length === 0) {
    return {
      threadId: input.threadId,
      inboundMessageId: gold.id,
      inboundMessageIdHash: hashOpaqueId(gold.id),
      goldKind: 'no_gold_reply',
      goldOutboundMessageId: null,
    };
  }

  const trigger = priors[0]!;
  const subj = (gold.subject ?? '').toLowerCase();
  const goldKind: GoldPairingKind =
    /\bfw:|\bfwd:|forward(ed)?\b/.test(subj) || /\bexternal\b/.test(subj)
      ? 'forward_or_external'
      : 'centurion_outbound';

  return {
    threadId: input.threadId,
    inboundMessageId: trigger.id,
    inboundMessageIdHash: hashOpaqueId(trigger.id),
    goldKind,
    goldOutboundMessageId: gold.id,
  };
}

export function extractCriticalTokens(text: string): string[] {
  CRITICAL_TOKEN_RE.lastIndex = 0;
  const found = text.match(CRITICAL_TOKEN_RE) ?? [];
  const normalize = (v: string) => v.toLocaleLowerCase().replace(/\s+/g, '');
  return [...new Set(found.map(normalize))];
}

/** Deterministic fact/ask assessment used by offline scoring and normal replies. */
export function assessDraftAgainstFacts(input: {
  draftText: string;
  asks: readonly PreparedAsk[];
  facts: readonly PreparedFact[];
  authorizedAttachmentRefs?: ReadonlySet<string> | readonly string[];
}): ReplyAssessment {
  return assessReply({
    replyText: input.draftText,
    asks: input.asks,
    facts: input.facts,
    authorizedAttachmentRefs: input.authorizedAttachmentRefs,
  });
}

export function scoreDraftAgainstEvidence(input: {
  draftText: string;
  evidenceTokens: readonly string[];
  bracketLines: readonly string[];
  goldKind: GoldPairingKind;
  selectedClaimIds?: readonly string[];
  claims?: ReadonlyMap<string, EvidenceClaim>;
  asks?: readonly PreparedAsk[];
  facts?: readonly PreparedFact[];
  authorizedAttachmentRefs?: ReadonlySet<string> | readonly string[];
  goldCriticalCoverage?: number;
  toneOverlap?: number;
}): FailureClass[] {
  const classes: FailureClass[] = [];
  if (input.goldKind === 'no_gold_reply') classes.push('NO_GOLD_REPLY');
  if (input.goldKind === 'forward_or_external') {
    classes.push('FORWARD_OR_EXTERNAL');
  }

  const allowed = new Set(
    [
      ...input.evidenceTokens.map((t) => t.toLocaleLowerCase().replace(/\s+/g, '')),
      ...input.bracketLines.flatMap((line) => extractCriticalTokens(line)),
    ].filter(Boolean),
  );

  const draftTokens = extractCriticalTokens(input.draftText);
  for (const token of draftTokens) {
    if (!allowed.has(token)) {
      classes.push('INVENTED_FACT');
      break;
    }
  }

  if (input.selectedClaimIds && input.claims && input.selectedClaimIds.length > 0) {
    try {
      assertNoUncitedCriticalLiterals({
        textBody: input.draftText,
        selectedClaimIds: input.selectedClaimIds,
        claims: input.claims,
      });
    } catch {
      if (!classes.includes('INVENTED_FACT')) classes.push('INVENTED_FACT');
    }
  }

  if (input.asks && input.facts) {
    const assessment = assessDraftAgainstFacts({
      draftText: input.draftText,
      asks: input.asks,
      facts: input.facts,
      authorizedAttachmentRefs: input.authorizedAttachmentRefs,
    });
    if (assessment.issues.some((issue) => issue.severity === 'critical')) {
      if (!classes.includes('INVENTED_FACT')) classes.push('INVENTED_FACT');
    }
    if (assessment.issues.some((issue) => issue.code === 'MISSING_BRACKET')) {
      if (!classes.includes('MISSING_BRACKET')) classes.push('MISSING_BRACKET');
    }
  }

  const needsFact = /\b(confirm|rate|balance|deposit|availability|quote)\b/i.test(input.draftText);
  const hasBracket = input.bracketLines.some((l) => l.includes('[MISSING:'));
  const hasEvidence = input.evidenceTokens.length > 0;
  if (needsFact && !hasEvidence && !hasBracket) {
    classes.push('MISSING_BRACKET');
  }

  if (
    typeof input.goldCriticalCoverage === 'number' &&
    input.goldKind === 'centurion_outbound' &&
    input.goldCriticalCoverage < 0.35
  ) {
    classes.push('LOW_GOLD_COVERAGE');
  }

  if (
    typeof input.toneOverlap === 'number' &&
    input.goldKind === 'centurion_outbound' &&
    input.toneOverlap < 0.08
  ) {
    classes.push('LOW_TONE');
  }

  if (classes.length === 0) classes.push('SOFT_OTHER');
  return [...new Set(classes)];
}

function softWordSet(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  );
}

function stripBracketLines(text: string): string {
  return text.replace(/\[MISSING:[^\]]*\]/g, ' ');
}

/** Bracket kinds that structurally account for gold token classes (no value echo). */
function structuralBracketCoversToken(token: string, brackets: readonly string[]): boolean {
  const joined = brackets.join('\n').toLowerCase();
  const t = token.toLowerCase();
  if (/(?:zar|r)\d/.test(t) || /^r[\d,.]+$/.test(t)) {
    return /folio|deposit|quote|rate/.test(joined);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t) || /[/.-]/.test(t)) {
    return /stay dates|quote|find_reservation/.test(joined);
  }
  if (/^(?:conf|ext)-/.test(t) || /^\d{6,}/.test(t)) {
    return /confirmation|find_reservation/.test(joined);
  }
  return false;
}

/** Soft compare draft vs Centurion gold — never logs raw bodies. */
export function compareDraftToGold(input: {
  draftText: string;
  goldText: string;
  bracketLines?: readonly string[];
}): GoldCompareResult {
  const goldTokens = extractCriticalTokens(input.goldText);
  const covered = new Set([
    ...extractCriticalTokens(input.draftText),
    ...(input.bracketLines ?? []).flatMap((l) => extractCriticalTokens(l)),
  ]);
  let hit = 0;
  for (const t of goldTokens) {
    if (covered.has(t) || structuralBracketCoversToken(t, input.bracketLines ?? [])) {
      hit += 1;
    }
  }
  const goldCriticalCoverage = goldTokens.length === 0 ? 1 : hit / goldTokens.length;

  const draftWords = softWordSet(stripBracketLines(input.draftText));
  const goldWords = softWordSet(input.goldText);
  let inter = 0;
  for (const w of draftWords) {
    if (goldWords.has(w)) inter += 1;
  }
  const union = draftWords.size + goldWords.size - inter;
  const softWordOverlap = union === 0 ? 0 : inter / union;

  const missingToolBracketCount = (input.bracketLines ?? []).filter((l) =>
    l.includes('[MISSING:'),
  ).length;
  const wrongOrMissingFactCount = goldTokens.length - hit;
  const toolCoverageRate = goldCriticalCoverage;

  return {
    goldCriticalCoverage,
    softWordOverlap,
    goldTokenCount: goldTokens.length,
    uncoveredGoldTokens: wrongOrMissingFactCount,
    toolCoverageRate,
    missingToolBracketCount,
    wrongOrMissingFactCount,
    toneOverlap: softWordOverlap,
  };
}

/**
 * Evidence-aware offline draft from inbound signals only.
 * Confirmation/dates present in inbound become citable evidence; PMS-only
 * facts stay bracketed (never invented).
 */
export function draftFromInboundSignals(input: {
  inboundText: string;
  unresolvedExtras?: ReadonlyArray<{ need: string; acquisition: string }>;
}): {
  textBody: string;
  bracketLines: string[];
  evidenceTokens: string[];
} {
  const evidenceTokens = extractCriticalTokens(input.inboundText);
  const unresolved: Array<{ need: string; acquisition: string }> = [];

  const hasConf = /\b(?:CONF-|EXT-|\d{6,}(?:-\d)?)\b/i.test(input.inboundText);
  if (!hasConf) {
    unresolved.push({
      need: 'confirmation number',
      acquisition: 'hms_find_reservation',
    });
  }
  if (!/\b\d{4}-\d{2}-\d{2}\b/.test(input.inboundText)) {
    unresolved.push({
      need: 'stay dates',
      acquisition: 'hms_find_reservation | inbound clarification',
    });
  }
  unresolved.push(
    {
      need: 'stay quote / availability',
      acquisition: 'hms_quote_stay',
    },
    {
      need: 'folio / deposit summary',
      acquisition: 'hms_read_folio',
    },
    {
      need: 'company billing terms',
      acquisition: 'BLOCKED_COMPANY_READ_SURFACE_UNPROVEN',
    },
    ...(input.unresolvedExtras ?? []),
  );

  const cited =
    evidenceTokens.length > 0
      ? 'Thank you for your email regarding your reservation enquiry. We noted the reservation details from your message and will verify them in the PMS before confirming.'
      : 'Thank you for your email regarding your reservation enquiry. We are preparing a reply.';

  const { textBody, bracketLines } = renderOfflineBracketDraft({
    opening: cited,
    unresolved,
    closing: 'Kind regards,\nCenturion Hotel Reservations',
  });
  return { textBody, bracketLines, evidenceTokens };
}

/** Offline draft: never invents — brackets unresolved PMS facts. */
export function renderOfflineBracketDraft(input: {
  salutation?: string;
  opening: string;
  unresolved: ReadonlyArray<{ need: string; acquisition: string }>;
  closing?: string;
}): { textBody: string; bracketLines: string[] } {
  const bracketLines = input.unresolved.map((u) =>
    formatMissingBracket({ need: u.need, acquisition: u.acquisition }),
  );
  const textBody = [
    input.salutation ?? 'Hello,',
    input.opening,
    ...bracketLines,
    input.closing ?? 'Kind regards,\nReservations',
  ].join('\n\n');
  return { textBody, bracketLines };
}

export function appendEvalRecord(root: string, runId: string, record: DraftEvalRecord): void {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'results.jsonl'), `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
  });
}

export function loadScoredHashes(
  root: string,
  runId: string,
  evaluationMode?: EvaluationMode,
): Set<string> {
  const path = join(root, runId, 'results.jsonl');
  const out = new Set<string>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: DraftEvalRecord;
    try {
      row = JSON.parse(line) as DraftEvalRecord;
    } catch {
      /* skip corrupt line */
      continue;
    }
    if (evaluationMode && row.evaluationMode !== evaluationMode) {
      throw new Error('persisted evaluation mode does not match requested mode');
    }
    if (row.goldMessageIdHash) out.add(row.goldMessageIdHash);
    else if (row.inboundMessageIdHash) out.add(row.inboundMessageIdHash);
  }
  return out;
}

/** Prefer gold hash when present (one row per Centurion reply). */
export function evalDedupeKey(record: {
  inboundMessageIdHash: string;
  goldMessageIdHash?: string;
}): string {
  return record.goldMessageIdHash ?? record.inboundMessageIdHash;
}

export function writeScorecard(root: string, runId: string, card: AggregateScorecard): void {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scorecard.json'), JSON.stringify(card, null, 2));
}

export function aggregateRecords(
  runId: string,
  records: readonly DraftEvalRecord[],
  requestedEvaluationMode?: EvaluationMode,
): AggregateScorecard {
  const recordModes = records.map((record) => record.evaluationMode);
  const modes = new Set(recordModes.filter(Boolean));
  if (recordModes.some((mode) => !mode) || modes.size > 1) {
    throw new Error('evaluation mode is required and records must not mix evaluation modes');
  }
  const evaluationMode = requestedEvaluationMode ?? recordModes[0] ?? 'historical-replay';
  if (modes.size === 1 && !modes.has(evaluationMode)) {
    throw new Error('evaluation mode does not match requested mode');
  }
  const byClass: Record<FailureClass, number> = {
    INVENTED_FACT: 0,
    MISSING_BRACKET: 0,
    NO_GOLD_REPLY: 0,
    FORWARD_OR_EXTERNAL: 0,
    LOW_GOLD_COVERAGE: 0,
    LOW_TONE: 0,
    SOFT_OTHER: 0,
  };
  let covSum = 0;
  let softSum = 0;
  let toolSum = 0;
  let toneSum = 0;
  let covN = 0;
  let softN = 0;
  let toolN = 0;
  let toneN = 0;
  let missingBrackets = 0;
  let wrongFacts = 0;
  for (const r of records) {
    for (const c of r.failureClasses) byClass[c] += 1;
    if (typeof r.goldCriticalCoverage === 'number') {
      covSum += r.goldCriticalCoverage;
      covN += 1;
    }
    if (typeof r.softWordOverlap === 'number') {
      softSum += r.softWordOverlap;
      softN += 1;
    }
    if (typeof r.toolCoverageRate === 'number') {
      toolSum += r.toolCoverageRate;
      toolN += 1;
    }
    if (typeof r.toneOverlap === 'number') {
      toneSum += r.toneOverlap;
      toneN += 1;
    }
    missingBrackets += r.missingToolBracketCount ?? 0;
    wrongFacts += r.wrongOrMissingFactCount ?? 0;
  }
  const scored = records.length;
  return {
    runId,
    evaluationMode,
    scored,
    byClass,
    inventedFactRate: scored === 0 ? 0 : byClass.INVENTED_FACT / scored,
    meanGoldCriticalCoverage: covN === 0 ? 0 : covSum / covN,
    meanSoftWordOverlap: softN === 0 ? 0 : softSum / softN,
    meanToolCoverageRate: toolN === 0 ? 0 : toolSum / toolN,
    meanToneOverlap: toneN === 0 ? 0 : toneSum / toneN,
    totalMissingToolBrackets: missingBrackets,
    totalWrongOrMissingFacts: wrongFacts,
  };
}

/** Refuse mutation/send call patterns in runner source text (preflight). */
export function assertBacktestSourceSafe(source: string): void {
  const forbidden = [
    /\bdb\.insert\s*\(/i,
    /\bdb\.update\s*\(/i,
    /\bdb\.delete\s*\(/i,
    /\.insert\s*\(\s*\{/i,
    /\bsendMail\s*\(/i,
    /\boutboundSendQueue\b/,
    /\boutbound_send_queue\b/,
    /\bmail\.send\b/,
    /\bpromoteDraft\s*\(/,
  ];
  for (const re of forbidden) {
    if (re.test(source)) {
      throw new Error(`backtest source safety refuse: matched ${re}`);
    }
  }
}
