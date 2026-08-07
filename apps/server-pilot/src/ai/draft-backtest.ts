/**
 * Centurion draft backtest — eval-only, no SMTP, no HMS writes, no product draft promote.
 * Purpose-built corpus scoring; never import from Vitest suites that touch pilot RDS.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  assertNoUncitedCriticalLiterals,
  formatMissingBracket,
  type EvidenceClaim,
} from './draft-evidence.js';

export const CENTURION_TRANSPORT_ID = 'transport-centurion';

export type GoldPairingKind =
  | 'centurion_outbound'
  | 'forward_or_external'
  | 'no_gold_reply';

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
};

export type FailureClass =
  | 'INVENTED_FACT'
  | 'MISSING_BRACKET'
  | 'NO_GOLD_REPLY'
  | 'FORWARD_OR_EXTERNAL'
  | 'LOW_GOLD_COVERAGE'
  | 'SOFT_OTHER';

export type AggregateScorecard = {
  runId: string;
  scored: number;
  byClass: Record<FailureClass, number>;
  inventedFactRate: number;
  meanGoldCriticalCoverage: number;
  meanSoftWordOverlap: number;
};

export type GoldCompareResult = {
  goldCriticalCoverage: number;
  softWordOverlap: number;
  goldTokenCount: number;
  uncoveredGoldTokens: number;
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
    transportId?: string | null;
    createdAt: string;
    subject?: string | null;
  }>;
}): CorpusPair {
  const inbound = input.messages.find((m) => m.id === input.inboundMessageId);
  if (!inbound || inbound.direction !== 'inbound') {
    throw new Error('inbound message required for gold pairing');
  }
  const inboundAt = Date.parse(inbound.createdAt);
  const laterOutbound = input.messages
    .filter(
      (m) =>
        m.direction === 'outbound' && Date.parse(m.createdAt) >= inboundAt,
    )
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const first = laterOutbound[0] ?? null;
  let goldKind: GoldPairingKind = 'no_gold_reply';
  if (first) {
    const subj = (first.subject ?? '').toLowerCase();
    goldKind =
      /\bfw:|\bfwd:|forward(ed)?\b/.test(subj) ||
      /\bexternal\b/.test(subj)
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

export function extractCriticalTokens(text: string): string[] {
  CRITICAL_TOKEN_RE.lastIndex = 0;
  const found = text.match(CRITICAL_TOKEN_RE) ?? [];
  const normalize = (v: string) => v.toLocaleLowerCase().replace(/\s+/g, '');
  return [...new Set(found.map(normalize))];
}

export function scoreDraftAgainstEvidence(input: {
  draftText: string;
  evidenceTokens: readonly string[];
  bracketLines: readonly string[];
  goldKind: GoldPairingKind;
  selectedClaimIds?: readonly string[];
  claims?: ReadonlyMap<string, EvidenceClaim>;
  goldCriticalCoverage?: number;
}): FailureClass[] {
  const classes: FailureClass[] = [];
  if (input.goldKind === 'no_gold_reply') classes.push('NO_GOLD_REPLY');
  if (input.goldKind === 'forward_or_external') {
    classes.push('FORWARD_OR_EXTERNAL');
  }

  const allowed = new Set(
    [
      ...input.evidenceTokens.map((t) =>
        t.toLocaleLowerCase().replace(/\s+/g, ''),
      ),
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

  if (
    input.selectedClaimIds &&
    input.claims &&
    input.selectedClaimIds.length > 0
  ) {
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

  const needsFact =
    /\b(confirm|rate|balance|deposit|availability|quote)\b/i.test(
      input.draftText,
    );
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

  if (classes.length === 0) classes.push('SOFT_OTHER');
  return [...new Set(classes)];
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
  const goldCriticalCoverage =
    goldTokens.length === 0 ? 1 : hit / goldTokens.length;

  const draftWords = softWordSet(input.draftText);
  const goldWords = softWordSet(input.goldText);
  let inter = 0;
  for (const w of draftWords) {
    if (goldWords.has(w)) inter += 1;
  }
  const union = draftWords.size + goldWords.size - inter;
  const softWordOverlap = union === 0 ? 0 : inter / union;

  return {
    goldCriticalCoverage,
    softWordOverlap,
    goldTokenCount: goldTokens.length,
    uncoveredGoldTokens: goldTokens.length - hit,
  };
}

/** Bracket kinds that structurally account for gold token classes (no value echo). */
function structuralBracketCoversToken(
  token: string,
  brackets: readonly string[],
): boolean {
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

function softWordSet(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  );
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

export function appendEvalRecord(
  root: string,
  runId: string,
  record: DraftEvalRecord,
): void {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'results.jsonl'), `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
  });
}

export function loadScoredHashes(root: string, runId: string): Set<string> {
  const path = join(root, runId, 'results.jsonl');
  const out = new Set<string>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as DraftEvalRecord;
      if (row.inboundMessageIdHash) out.add(row.inboundMessageIdHash);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

export function writeScorecard(
  root: string,
  runId: string,
  card: AggregateScorecard,
): void {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scorecard.json'), JSON.stringify(card, null, 2));
}

export function aggregateRecords(
  runId: string,
  records: readonly DraftEvalRecord[],
): AggregateScorecard {
  const byClass: Record<FailureClass, number> = {
    INVENTED_FACT: 0,
    MISSING_BRACKET: 0,
    NO_GOLD_REPLY: 0,
    FORWARD_OR_EXTERNAL: 0,
    LOW_GOLD_COVERAGE: 0,
    SOFT_OTHER: 0,
  };
  let covSum = 0;
  let softSum = 0;
  let covN = 0;
  let softN = 0;
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
  }
  const scored = records.length;
  return {
    runId,
    scored,
    byClass,
    inventedFactRate: scored === 0 ? 0 : byClass.INVENTED_FACT / scored,
    meanGoldCriticalCoverage: covN === 0 ? 0 : covSum / covN,
    meanSoftWordOverlap: softN === 0 ? 0 : softSum / softN,
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
