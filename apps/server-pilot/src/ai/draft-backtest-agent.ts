/**
 * Backtest drafting helpers — claim-safe Mastra path + signal fallback.
 * Never sends mail. Never mutates HMS. Eval-only.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  createMockCandidateSession,
  runClaimSafeCandidateDraft,
  type ClaimSafeCandidateResult,
} from './candidate-draft-agent.js';
import {
  draftFromInboundSignals,
  renderOfflineBracketDraft,
} from './draft-backtest.js';
import { formatMissingBracket, type ToolResult } from './draft-evidence.js';
import {
  extractLookupCandidates,
  filterExactReservationCandidates,
} from './thread-context.js';
import type {
  ReservationReadData,
  StayOptionReadData,
} from '../hms/contracts.js';
import type { ArtifactData } from '../mail/artifacts/read-artifact.js';

export type BacktestDraftMode = 'signals' | 'claim-safe-stub' | 'live-hms';

export type BacktestDraftResult = {
  textBody: string;
  bracketLines: string[];
  evidenceTokens: string[];
  draftMode: BacktestDraftMode;
  claimSafeOutcome?: ClaimSafeCandidateResult['outcome'];
};

function extractBracketLines(text: string): string[] {
  return [...text.matchAll(/\[MISSING:[^\]]+\]/g)].map((m) => m[0]!);
}

function emptyNotFoundResult<T>(toolId: string, data: T): ToolResult<T> {
  return {
    status: 'not_found' as const,
    draftReady: false,
    data,
    unresolvedFields: ['reservation'],
    evidence: {
      kind: 'hms' as const,
      id: randomUUID(),
      toolId,
      toolVersion: '1.2.0',
      propertyCode: 'CENTURION',
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      claimKeys: [] as string[],
      sourceHash: createHash('sha256').update(`nf:${toolId}`).digest('hex'),
    },
  };
}

/** Convert claim-safe non-candidate outcomes into bracketed draft. */
export function bracketFromInsufficient(input: {
  inboundText: string;
  outcome: ClaimSafeCandidateResult['outcome'];
  draftMode?: BacktestDraftMode;
}): BacktestDraftResult {
  const signal = draftFromInboundSignals({ inboundText: input.inboundText });
  const extras = [
    formatMissingBracket({
      need: `claim_safe_outcome=${input.outcome}`,
      acquisition: 're-run with live HMS read tools when confirmation present',
    }),
  ];
  return {
    textBody: `${signal.textBody}\n\n${extras.join('\n\n')}`,
    bracketLines: [...signal.bracketLines, ...extras],
    evidenceTokens: signal.evidenceTokens,
    draftMode: input.draftMode ?? 'claim-safe-stub',
    claimSafeOutcome: input.outcome,
  };
}

/**
 * Signal-only drafting (fast corpus). Inbound literals may be cited;
 * PMS facts stay bracketed.
 */
export function draftSignalsOnly(inboundText: string): BacktestDraftResult {
  const d = draftFromInboundSignals({ inboundText });
  return { ...d, draftMode: 'signals' };
}

/**
 * Claim-safe gather with stub not_found handlers (no browser).
 * Exercises Mastra tool registry; empty evidence → brackets (no invent).
 */
export async function draftClaimSafeStub(input: {
  inboundText: string;
  signal: AbortSignal;
  planModel?: (prompt: {
    systemPrompt: string;
    userPrompt: string;
  }) => Promise<unknown>;
}): Promise<BacktestDraftResult> {
  const candidates = extractLookupCandidates(input.inboundText);
  const lookup = new Map(candidates.map((c) => [c.id, c]));
  const session = createMockCandidateSession({
    lookupCandidates: lookup,
    findReservation: async () =>
      emptyNotFoundResult<ReservationReadData>('hms_find_reservation', {
        matches: [],
        matchCount: 0,
        capped: false,
      }),
    quoteStay: async () =>
      emptyNotFoundResult<StayOptionReadData>('hms_quote_stay', {
        nightlyObservations: [],
        bookable: false,
        stayTotal: null,
        occupancyPriced: false,
        requestedRooms: 1,
      }),
    readArtifact: async () =>
      emptyNotFoundResult<ArtifactData>('mail_read_artifact', {
        mimeType: 'application/pdf',
        text: null,
        pageCount: null,
        reason: 'unsupported',
      }),
    readFolio: async () =>
      emptyNotFoundResult<unknown>('hms_read_folio', {}),
    activeToolIds: new Set([
      'hms_find_reservation',
      'hms_quote_stay',
      'hms_read_folio',
    ]),
  });

  const result = await runClaimSafeCandidateDraft({
    session,
    normalizedThreadText: input.inboundText.slice(0, 8_192),
    signal: input.signal,
    planMode: 'fixture',
    planModel:
      input.planModel ??
      (async () => ({
        outcome: 'insufficient_evidence',
        questionCodes: [],
        unavailableSources: ['hms', 'mail_attachment'],
      })),
  });

  if (result.outcome === 'candidate' && result.textBody) {
    return {
      textBody: result.textBody,
      bracketLines: extractBracketLines(result.textBody),
      evidenceTokens: [],
      draftMode: 'claim-safe-stub',
      claimSafeOutcome: result.outcome,
    };
  }

  return bracketFromInsufficient({
    inboundText: input.inboundText,
    outcome: result.outcome,
  });
}

export function hasExactReservationSignal(inboundText: string): boolean {
  return (
    filterExactReservationCandidates(extractLookupCandidates(inboundText))
      .length === 1
  );
}

export function emptyCandidateFallbackDraft(): {
  textBody: string;
  bracketLines: string[];
} {
  return renderOfflineBracketDraft({
    opening: 'Thank you for your email. Evidence gather did not complete.',
    unresolved: [
      {
        need: 'reservation evidence',
        acquisition: 'hms_find_reservation',
      },
    ],
  });
}
