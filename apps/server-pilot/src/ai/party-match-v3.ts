import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import type { ModelAdapter } from './bedrock/adapter.js';
import { matchKey } from './party-match.js';
import type { PanePartyCandidate, PanePartyOutcome } from './pane-party-lookup.js';
import {
  applyPartyBindRule,
  normalisePartyName,
  partyMatchSearchTerms,
  pickPartyMatch,
  planPartySearches,
  type PartyMatchCandidate,
  type PartyMatchDecision,
  type PartyMatchEmailContext,
  type PartyMatchKind,
  type PartyMatchPick,
  type PartyMatchRow,
} from './party-match-v2.js';

export type PartyMatchV3Row = PartyMatchRow &
  Pick<PanePartyCandidate, 'iata' | 'city' | 'address' | 'country' | 'externalId'>;

export type PartyMatchV3Search = { kind: PartyMatchKind; term: string };

export type PartyMatchV3FindResult = {
  outcome: string;
  results: readonly PartyMatchV3Row[];
  truncated: boolean;
  searchedFor?: string | null;
};

const PARTY_OUTCOMES = new Set<string>([
  'resolved',
  'ambiguous',
  'no_match',
  'input_gap',
  'execution_failure',
  'external_system_unavailable',
  'refused_flag_off',
  'refused_input_invalid',
  'refused_origin_mismatch',
  'refused_lock_unavailable',
  'refused_lock_busy',
]);

function partyOutcome(value: string): PanePartyOutcome {
  return PARTY_OUTCOMES.has(value) ? (value as PanePartyOutcome) : 'execution_failure';
}

export type PartyMatchV3JobResult = {
  outcome: PanePartyOutcome;
  results: PartyMatchV3Row[];
  truncated: boolean;
  best: PartyMatchV3Row | null;
  searchedFor: string | null;
  matchVersion: 2;
  matcher: 'v3';
  matchStatus: 'bound' | 'needs_pick';
  boundParty: PartyMatchV3Row | null;
  suggestions: PartyMatchV3Row[];
  reason: string;
  searchesTried: Array<{
    term: string;
    candidateName: string;
    kind: PartyMatchKind;
    outcome: string;
    returned: number;
  }>;
  confidence: 'high' | 'medium' | 'low';
  pickSource: 'llm' | 'fallback';
};

const ROUND1_TERM_CAP = 5;
const ROUND2_TERM_CAP = 3;
const MAX_BATCHES = 2;
const MIN_TERM_CHARS = 3;

/** Default-off. Same explicit true/1 gate as PARTY_MATCH_V2 so `on` cannot silently enable it. */
export function partyMatchV3Enabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env.PARTY_MATCH_V3 === 'true' || env.PARTY_MATCH_V3 === '1';
}

export function sanitizePartySearchTerms(
  terms: readonly PartyMatchV3Search[],
  minChars = MIN_TERM_CHARS,
): PartyMatchV3Search[] {
  const out: PartyMatchV3Search[] = [];
  const seen = new Set<string>();
  for (const item of terms) {
    if (item.kind !== 'company' && item.kind !== 'agency') continue;
    const term = item.term.replace(/\s+/g, ' ').trim();
    if (term.length < minChars) continue;
    const key = `${item.kind}:${normalisePartyName(term)}`;
    if (!normalisePartyName(term) || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: item.kind, term });
  }
  return out;
}

function triedSearchKey(kind: PartyMatchKind, term: string): string {
  // matchKey folds case/punctuation; unlike normalisePartyName it keeps legal suffixes, so
  // "Acme Ltd" (0 rows) and "Acme" stay distinct HMS queries.
  return `${kind}:${matchKey(term)}`;
}

/** Drop already-tried terms; if none remain and a round-1 term returned 0 rows, use V2 distinctive fallbacks. */
export function selectRound2SearchTerms(
  nextTerms: readonly PartyMatchV3Search[],
  searchesTried: readonly Pick<
    PartyMatchV3JobResult['searchesTried'][number],
    'kind' | 'term' | 'returned'
  >[],
): PartyMatchV3Search[] {
  const tried = new Set(searchesTried.map((row) => triedSearchKey(row.kind, row.term)));
  const fromModel = sanitizePartySearchTerms(nextTerms).filter(
    (item) => !tried.has(triedSearchKey(item.kind, item.term)),
  );
  if (fromModel.length) return fromModel.slice(0, ROUND2_TERM_CAP);
  if (!searchesTried.some((row) => row.returned === 0)) return [];
  const out: PartyMatchV3Search[] = [];
  const seen = new Set(tried);
  for (const search of searchesTried) {
    if (search.returned !== 0) continue;
    for (const term of partyMatchSearchTerms(search.term)) {
      const [kept] = sanitizePartySearchTerms([{ kind: search.kind, term }]);
      if (!kept) continue;
      const key = triedSearchKey(kept.kind, kept.term);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(kept);
      if (out.length >= ROUND2_TERM_CAP) return out;
    }
  }
  return out;
}

const searchTermSchema = z.object({
  kind: z.enum(['company', 'agency']),
  term: z.string().min(1).max(256),
});

const proposeSchema = z
  .object({
    searches: z.array(searchTermSchema).max(ROUND1_TERM_CAP),
  })
  .strict();

const pickSchema = z
  .object({
    pick: z.string().min(1).max(100).nullable(),
    kind: z.enum(['company', 'agency']).nullable(),
    confidence: z.enum(['high', 'medium', 'low']),
    reason: z.string().min(1).max(500),
    nextTerms: z.array(searchTermSchema).max(ROUND1_TERM_CAP).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.pick === null) !== (value.kind === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pick and kind must both be null or set',
      });
    }
  });

export type PartySenderHistory = { kind: PartyMatchKind; nativeId: string };

function emailHaystack(emailText: string, context?: PartyMatchEmailContext): string {
  return [
    emailText,
    context?.subject ?? '',
    context?.signatureBlock ?? '',
    ...(context?.extractedNames ?? []),
  ]
    .join('\n')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function columnValue(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/\s+/g, ' ').trim() ?? '';
  return cleaned.length >= MIN_TERM_CHARS ? cleaned.toLowerCase() : null;
}

function uniqueColumnCopy(
  copies: readonly PartyMatchV3Row[],
  emailText: string,
  context?: PartyMatchEmailContext,
): PartyMatchV3Row | null {
  const hay = emailHaystack(emailText, context);
  const hits = copies.filter((row) => {
    const city = columnValue(row.city);
    const iata = columnValue(row.iata);
    return Boolean((city && hay.includes(city)) || (iata && hay.includes(iata)));
  });
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

function uniqueSenderCopy(
  copies: readonly PartyMatchV3Row[],
  senderHistory: readonly PartySenderHistory[] | undefined,
): PartyMatchV3Row | null {
  if (!senderHistory?.length) return null;
  const wanted = new Set(
    senderHistory.map((row) => `${row.kind}:${row.nativeId}`),
  );
  const hits = copies.filter((row) => wanted.has(`${row.kind}:${row.nativeId}`));
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

function copiesOf(picked: PartyMatchV3Row, rows: readonly PartyMatchV3Row[]): PartyMatchV3Row[] {
  const name = normalisePartyName(picked.name);
  return rows.filter(
    (row) => row.kind === picked.kind && normalisePartyName(row.name) === name,
  );
}

function rowById(
  rows: readonly PartyMatchV3Row[],
  kind: PartyMatchKind | null,
  nativeId: string | null,
): PartyMatchV3Row | null {
  if (!kind || !nativeId) return null;
  return rows.find((row) => row.kind === kind && row.nativeId === nativeId) ?? null;
}

function withResolvedPick(
  pick: PartyMatchPick,
  resolved: PartyMatchV3Row,
): PartyMatchPick {
  return {
    ...pick,
    pickNativeId: resolved.nativeId,
    kind: resolved.kind,
  };
}

/**
 * Reuses V2's precision-first bind, then disambiguates duplicate HMS copies of the picked name.
 * Company and agency copies are separate lists even when they share a display name.
 */
export function applyPartyBindV3(input: {
  candidates: readonly PartyMatchCandidate[];
  rows: readonly PartyMatchV3Row[];
  pick: PartyMatchPick;
  truncated?: boolean;
  emailText: string;
  context?: PartyMatchEmailContext;
  senderHistory?: readonly PartySenderHistory[];
}): PartyMatchDecision {
  const picked = rowById(input.rows, input.pick.kind, input.pick.pickNativeId);
  const copies = picked ? copiesOf(picked, input.rows) : [];
  if (picked && copies.length >= 2) {
    const unique =
      uniqueColumnCopy(copies, input.emailText, input.context) ??
      uniqueSenderCopy(copies, input.senderHistory);
    if (unique) {
      return applyPartyBindRule({
        candidates: input.candidates,
        rows: [unique],
        pick: withResolvedPick(input.pick, unique),
        truncated: input.truncated,
      });
    }
    const rest = input.rows.filter(
      (row) => !copies.some((copy) => copy.kind === row.kind && copy.nativeId === row.nativeId),
    );
    return {
      matchStatus: 'needs_pick',
      boundParty: null,
      suggestions: [...copies, ...rest],
      reason:
        'More than one HMS row shares this party name; choose the matching city, IATA, or copy.',
    };
  }
  return applyPartyBindRule({
    candidates: input.candidates,
    rows: input.rows,
    pick: input.pick,
    truncated: input.truncated,
  });
}

function fallbackPick(
  candidates: readonly PartyMatchCandidate[],
  rows: readonly PartyMatchV3Row[],
  context: PartyMatchEmailContext,
): Promise<PartyMatchPick> {
  return pickPartyMatch({
    adapter: null,
    candidates,
    rows,
    context,
  });
}

async function proposeSearches(
  adapter: ModelAdapter,
  input: {
    candidates: readonly PartyMatchCandidate[];
    context: PartyMatchEmailContext;
    signal?: AbortSignal;
    deadlineAt?: number;
  },
): Promise<PartyMatchV3Search[]> {
  const invoked = await adapter.invoke({
    modelId: 'gpt-6-luna',
    systemPrompt: [
      'Propose HMS party-search terms a reservationist would type.',
      'Use the email context and extracted candidate names as hints only.',
      'Return at most five {kind, term} searches. Never invent a person name.',
      'Return JSON matching the supplied schema.',
    ].join('\n'),
    userPrompt: JSON.stringify({
      context: input.context,
      candidates: input.candidates,
    }),
    responseSchema: zodToJsonSchema(proposeSchema, { $refStrategy: 'none' }) as Record<
      string,
      unknown
    >,
    signal: input.signal,
    deadlineAt: input.deadlineAt,
    maxOutputTokens: 400,
  });
  const parsed = proposeSchema.safeParse(invoked.output);
  if (!parsed.success) return [];
  return sanitizePartySearchTerms(parsed.data.searches).slice(0, ROUND1_TERM_CAP);
}

type LoopPick = PartyMatchPick & { nextTerms: PartyMatchV3Search[] };

async function pickFromRows(
  adapter: ModelAdapter,
  input: {
    candidates: readonly PartyMatchCandidate[];
    context: PartyMatchEmailContext;
    rows: readonly PartyMatchV3Row[];
    searchesTried: PartyMatchV3JobResult['searchesTried'];
    signal?: AbortSignal;
    deadlineAt?: number;
  },
): Promise<LoopPick> {
  const invoked = await adapter.invoke({
    modelId: 'gpt-6-luna',
    systemPrompt: [
      'Pick the HMS party row that matches the organisation or booking agency in the email.',
      'Rows include optional iata, city, address, country and externalId columns.',
      'searchesTried lists each term already typed with how many HMS rows it returned.',
      'If a full name returned 0 rows, suggest its most distinctive single word or a shorter form as nextTerms.',
      'Never repeat a tried term (same kind and name).',
      'Return pick=null when uncertain. If no row fits, you may suggest nextTerms to type next.',
      'Return JSON matching the supplied schema.',
    ].join('\n'),
    userPrompt: JSON.stringify({
      context: input.context,
      returnedRows: input.rows,
      searchesTried: input.searchesTried.map((row) => ({
        kind: row.kind,
        term: row.term,
        returned: row.returned,
      })),
    }),
    responseSchema: zodToJsonSchema(pickSchema, { $refStrategy: 'none' }) as Record<
      string,
      unknown
    >,
    signal: input.signal,
    deadlineAt: input.deadlineAt,
    maxOutputTokens: 500,
  });
  const parsed = pickSchema.safeParse(invoked.output);
  if (!parsed.success) {
    const fallback = await fallbackPick(input.candidates, input.rows, input.context);
    return { ...fallback, nextTerms: [] };
  }
  const picked = rowById(input.rows, parsed.data.kind, parsed.data.pick);
  if (parsed.data.pick && !picked) {
    const fallback = await fallbackPick(input.candidates, input.rows, input.context);
    return { ...fallback, nextTerms: [] };
  }
  return {
    pickNativeId: parsed.data.pick,
    kind: parsed.data.kind,
    confidence: parsed.data.confidence,
    reason: parsed.data.reason.trim(),
    alternatives: [],
    source: 'llm',
    nextTerms: sanitizePartySearchTerms(parsed.data.nextTerms ?? []),
  };
}

function v3PlanTerms(candidates: readonly PartyMatchCandidate[]): PartyMatchV3Search[] {
  return sanitizePartySearchTerms(
    planPartySearches(candidates).map((search) => ({ kind: search.kind, term: search.term })),
    1,
  ).slice(0, ROUND1_TERM_CAP);
}

function finish(input: {
  rows: PartyMatchV3Row[];
  truncated: boolean;
  searchesTried: PartyMatchV3JobResult['searchesTried'];
  pick: PartyMatchPick;
  decision: PartyMatchDecision;
  failure?: PartyMatchV3FindResult | null;
}): PartyMatchV3JobResult {
  const outcome = input.failure
    ? partyOutcome(input.failure.outcome)
    : input.decision.matchStatus === 'bound'
      ? 'resolved'
      : input.rows.length
        ? 'ambiguous'
        : 'no_match';
  return {
    outcome,
    results: input.rows,
    truncated: input.truncated,
    best: input.decision.boundParty,
    searchedFor: input.searchesTried.at(-1)?.term ?? input.failure?.searchedFor ?? null,
    matchVersion: 2,
    matcher: 'v3',
    matchStatus: input.decision.matchStatus,
    boundParty: input.decision.boundParty,
    suggestions: input.decision.suggestions,
    reason: input.failure
      ? `HMS could not complete every planned party search (${input.failure.outcome}); choose a suggestion or use Find in HMS.`
      : input.decision.reason,
    searchesTried: input.searchesTried,
    confidence: input.pick.confidence,
    pickSource: input.pick.source,
  };
}

/** Two-batch reservationist loop. Flag-off callers never reach this. */
export async function runPartyMatchV3(input: {
  adapter: ModelAdapter | null;
  candidates: readonly PartyMatchCandidate[];
  context: PartyMatchEmailContext;
  emailText: string;
  findParty: (searches: readonly PartyMatchV3Search[]) => Promise<readonly PartyMatchV3FindResult[]>;
  senderHistory?: readonly PartySenderHistory[];
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<PartyMatchV3JobResult> {
  const searchesTried: PartyMatchV3JobResult['searchesTried'] = [];
  const rowsById = new Map<string, PartyMatchV3Row>();
  let truncated = false;
  let batches = 0;
  let failure: PartyMatchV3FindResult | null = null;

  const collected = (): PartyMatchV3Row[] => [...rowsById.values()];

  const runBatch = async (terms: readonly PartyMatchV3Search[]): Promise<void> => {
    if (failure || batches >= MAX_BATCHES || !terms.length) return;
    batches += 1;
    const jobResults = await input.findParty(terms);
    for (const [index, search] of terms.entries()) {
      const result = jobResults[index] ?? {
        outcome: 'execution_failure',
        results: [],
        truncated: false,
        searchedFor: search.term,
      };
      searchesTried.push({
        term: search.term,
        candidateName: search.term,
        kind: search.kind,
        outcome: result.outcome,
        returned: result.results.length,
      });
      truncated ||= result.truncated;
      for (const row of result.results) rowsById.set(`${row.kind}:${row.nativeId}`, row);
      if (!['resolved', 'ambiguous', 'no_match'].includes(result.outcome)) {
        failure = result;
        break;
      }
    }
  };

  const bind = (pick: PartyMatchPick) =>
    applyPartyBindV3({
      candidates: input.candidates,
      rows: collected(),
      pick,
      truncated,
      emailText: input.emailText,
      context: input.context,
      senderHistory: input.senderHistory,
    });

  const closedModel = async (): Promise<PartyMatchV3JobResult> => {
    if (!batches) await runBatch(v3PlanTerms(input.candidates));
    const pick = await fallbackPick(input.candidates, collected(), input.context);
    return finish({
      rows: collected(),
      truncated,
      searchesTried,
      pick,
      decision: bind(pick),
      failure,
    });
  };

  if (!input.adapter) return closedModel();

  let round1: PartyMatchV3Search[] = [];
  try {
    round1 = await proposeSearches(input.adapter, input);
  } catch {
    return closedModel();
  }
  await runBatch(round1);
  if (failure) {
    const pick = await fallbackPick(input.candidates, collected(), input.context);
    return finish({
      rows: collected(),
      truncated,
      searchesTried,
      pick,
      decision: bind(pick),
      failure,
    });
  }

  let loopPick: LoopPick;
  try {
    loopPick = await pickFromRows(input.adapter, {
      candidates: input.candidates,
      context: input.context,
      rows: collected(),
      searchesTried,
      signal: input.signal,
      deadlineAt: input.deadlineAt,
    });
  } catch {
    return closedModel();
  }

  const round2 = selectRound2SearchTerms(loopPick.nextTerms, searchesTried);
  if (!loopPick.pickNativeId && round2.length && batches < MAX_BATCHES) {
    await runBatch(round2);
    if (failure) {
      const pick = await fallbackPick(input.candidates, collected(), input.context);
      return finish({
        rows: collected(),
        truncated,
        searchesTried,
        pick,
        decision: bind(pick),
        failure,
      });
    }
    try {
      loopPick = await pickFromRows(input.adapter, {
        candidates: input.candidates,
        context: input.context,
        rows: collected(),
        searchesTried,
        signal: input.signal,
        deadlineAt: input.deadlineAt,
      });
    } catch {
      return closedModel();
    }
  }

  const pick: PartyMatchPick = {
    pickNativeId: loopPick.pickNativeId,
    kind: loopPick.kind,
    confidence: loopPick.confidence,
    reason: loopPick.reason,
    alternatives: loopPick.alternatives,
    source: loopPick.source,
  };
  return finish({
    rows: collected(),
    truncated,
    searchesTried,
    pick,
    decision: bind(pick),
    failure,
  });
}
