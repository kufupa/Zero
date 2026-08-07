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
};

export type FailureClass =
  | 'INVENTED_FACT'
  | 'MISSING_BRACKET'
  | 'NO_GOLD_REPLY'
  | 'FORWARD_OR_EXTERNAL'
  | 'SOFT_OTHER';

export type AggregateScorecard = {
  runId: string;
  scored: number;
  byClass: Record<FailureClass, number>;
  inventedFactRate: number;
};

const CRITICAL_TOKEN_RE =
  /\b(?:ZAR|R)\s?\d[\d,.]*|\b\d{4}-\d{2}-\d{2}\b|\bCONF-[A-Z0-9-]{2,}\b|\bEXT-[A-Z0-9-]{2,}\b/gi;

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

  if (classes.length === 0) classes.push('SOFT_OTHER');
  return [...new Set(classes)];
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
    SOFT_OTHER: 0,
  };
  for (const r of records) {
    for (const c of r.failureClasses) byClass[c] += 1;
  }
  const scored = records.length;
  return {
    runId,
    scored,
    byClass,
    inventedFactRate: scored === 0 ? 0 : byClass.INVENTED_FACT / scored,
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
