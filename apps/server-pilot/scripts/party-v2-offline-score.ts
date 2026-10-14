import {
  applyPartyBindRule,
  buildPartyMatchCandidates,
  normalisePartyName,
  partyMatchEmailContext,
  partyMatchSearchTerms,
  pickPartyMatch,
  planPartySearches,
  PARTY_MATCH_V2_ROW_CAP,
  PARTY_MATCH_V2_SEARCH_CAP,
  type PartyMatchCandidate,
  type PartyMatchDecision,
  type PartyMatchKind,
  type PartyMatchPick,
  type PartyMatchRow,
} from '../src/ai/party-match-v2.js';
import type { ModelAdapter } from '../src/ai/bedrock/adapter.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const DEFAULT_PATHS = {
  truth: '/home/orca/nava-research/testsets/party-truth.jsonl',
  confDomain: '/home/orca/nava-research/testsets/party-truth-conf-domain.json',
  messages: '/home/orca/nava-research/corpus/2026-10-13/messages.jsonl.gz',
  extractions: '/home/orca/nava-research/corpus/2026-10-13/extractions.jsonl.gz',
  report: '/home/orca/nava-research/reports/r7-party-v2-score.md',
};

const PREFERRED_EXTRACTION_KINDS = new Set(['quote', 'booking', 'amendment', 'voucher_pop']);
const HMS_CONTAINS_CAP = 50;
const DOMAIN_CONSISTENCY_THRESHOLD = 0.8;
const DEFAULT_MAX_PER_DOMAIN = 5;

export type JsonRecord = Record<string, unknown>;
type PartyNameInput = Parameters<typeof buildPartyMatchCandidates>[0];

type CliOptions = {
  truth: string;
  confDomain: string;
  messages: string;
  extractions: string;
  report: string;
  maxPerDomain: number;
  /** Call the production quote-workflow model route for each pick (needs the prod env, e.g. on EC2). */
  livePicker: boolean;
  help: boolean;
};

type NameTally = {
  normalizedName: string;
  count: number;
  variants: Map<string, number>;
};

export type RankedPartyName = {
  name: string;
  normalizedName: string;
  count: number;
};

export type DomainTruth = {
  domain: string;
  n: number;
  agencies: RankedPartyName[];
  companies: RankedPartyName[];
  dominantAgency: RankedPartyName | null;
  dominantCompany: RankedPartyName | null;
  consistency: string;
};

export type TestEmail = {
  domain: string;
  extractionKind: string;
  receivedAt: string;
  expected: { kind: PartyMatchKind; name: string };
  emailInput: PartyNameInput;
};

type SearchProvenance = {
  term: string;
  candidateName: string;
};

type WrongBind = {
  mode: string;
  domain: string;
  term: string;
  bound: string;
  expected: string;
  extractedOrgName: string;
};

export type ScoredEmail = {
  testEmail: TestEmail;
  candidates: PartyMatchCandidate[];
  candidateFound: boolean;
  truthRetrieved: boolean;
  truthInPickerRows: boolean;
  truncated: boolean;
  fallbackDecision: PartyMatchDecision;
  perfectDecision: PartyMatchDecision;
  /** The production picker route (`--live-picker`); null when the run is offline only. */
  liveDecision?: PartyMatchDecision | null;
  provenanceByRowId: Map<string, SearchProvenance>;
};

export function simulateHmsContains(
  universe: readonly PartyMatchRow[],
  term: string,
  cap = HMS_CONTAINS_CAP,
): { rows: PartyMatchRow[]; truncated: boolean } {
  const loweredTerm = term.toLowerCase();
  const matches = universe.filter((row) => row.name.toLowerCase().includes(loweredTerm));
  return { rows: matches.slice(0, cap), truncated: matches.length > cap };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/gu, ' ').trim();
  return text ? text : null;
}

function normalizeDomain(value: unknown): string | null {
  const raw = cleanText(value);
  if (!raw) return null;
  let host = raw.toLowerCase().replace(/^mailto:/u, '');
  if (host.includes('@')) host = host.split('@').at(-1) ?? '';
  if (/^https?:\/\//u.test(host)) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  host =
    host
      .split(/[/?#]/u, 1)[0]
      ?.replace(/^www\./u, '')
      .replace(/\.$/u, '') ?? '';
  if (!host.includes('.') || /\s/u.test(host)) return null;
  return host;
}

function emailDomain(value: unknown): string | null {
  const address = cleanText(value);
  if (!address) return null;
  const match = address.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/iu);
  return normalizeDomain(match?.[1]);
}

export async function readRows(file: string): Promise<JsonRecord[]> {
  const bytes = await readFile(file);
  const source = file.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
  const rows: JsonRecord[] = [];
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`${file.split('/').at(-1)} has invalid JSON on line ${index + 1}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${file.split('/').at(-1)} line ${index + 1} must be a JSON object`);
    }
    rows.push(parsed as JsonRecord);
  }
  return rows;
}

export async function readConfDomains(file: string): Promise<Map<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    throw new Error(`${file.split('/').at(-1)} is not valid JSON`);
  }
  const mapRecord = asRecord(parsed);
  const result = new Map<string, string>();
  for (const [conf, value] of Object.entries(mapRecord)) {
    const domain = normalizeDomain(value);
    if (domain) result.set(conf.trim(), domain);
  }
  return result;
}

function isFoundTruth(row: JsonRecord): boolean {
  return cleanText(row.outcome)?.toLowerCase() === 'found';
}

function partyName(commercial: JsonRecord, kind: PartyMatchKind): string | null {
  return cleanText(asRecord(commercial[kind]).name);
}

function addNameTally(tallies: Map<string, NameTally>, name: string): void {
  const normalizedName = normalisePartyName(name) || name.toLowerCase();
  const tally = tallies.get(normalizedName) ?? {
    normalizedName,
    count: 0,
    variants: new Map<string, number>(),
  };
  incrementNameTally(tally, name);
  tallies.set(normalizedName, tally);
}

function incrementNameTally(tally: NameTally, name: string): void {
  tally.count += 1;
  tally.variants.set(name, (tally.variants.get(name) ?? 0) + 1);
}

function rankedNames(tallies: Map<string, NameTally>): RankedPartyName[] {
  return [...tallies.values()]
    .map((tally) => {
      const displayName = [...tally.variants.entries()].sort(
        ([leftName, leftCount], [rightName, rightCount]) =>
          rightCount - leftCount || leftName.localeCompare(rightName),
      )[0]?.[0];
      return {
        name: displayName ?? tally.normalizedName,
        normalizedName: tally.normalizedName,
        count: tally.count,
      };
    })
    .sort(
      (left, right) =>
        right.count - left.count || left.normalizedName.localeCompare(right.normalizedName),
    );
}

function share(count: number, denominator: number): number {
  return denominator > 0 ? count / denominator : 0;
}

function consistencyLabel(
  n: number,
  agencies: readonly RankedPartyName[],
  companies: readonly RankedPartyName[],
): string {
  if (!n) return 'No found rows';
  if (!agencies.length && !companies.length) return 'No company/agency names in found rows';
  const dominant = [
    { kind: 'agency', count: agencies[0]?.count ?? 0 },
    { kind: 'company', count: companies[0]?.count ?? 0 },
  ].filter((item) => share(item.count, n) >= DOMAIN_CONSISTENCY_THRESHOLD);
  if (!dominant.length) return 'Inconsistent (<80% for either kind)';
  return `Consistent: ${dominant
    .map((item) => `${item.kind} ${formatPercent(item.count, n)}`)
    .join(' + ')}`;
}

export function buildDomainTruth(
  truthRows: readonly JsonRecord[],
  confDomains: ReadonlyMap<string, string>,
): { domains: DomainTruth[]; foundRows: number; foundRowsMissingDomain: number } {
  const grouped = new Map<
    string,
    { n: number; agencies: Map<string, NameTally>; companies: Map<string, NameTally> }
  >();
  let foundRows = 0;
  let foundRowsMissingDomain = 0;
  for (const row of truthRows) {
    if (!isFoundTruth(row)) continue;
    foundRows += 1;
    const conf = cleanText(row.conf);
    const domain = conf ? confDomains.get(conf) : null;
    if (!domain) {
      foundRowsMissingDomain += 1;
      continue;
    }
    const value = grouped.get(domain) ?? {
      n: 0,
      agencies: new Map<string, NameTally>(),
      companies: new Map<string, NameTally>(),
    };
    value.n += 1;
    const commercial = asRecord(row.commercial);
    const agency = partyName(commercial, 'agency');
    const company = partyName(commercial, 'company');
    if (agency) addNameTally(value.agencies, agency);
    if (company) addNameTally(value.companies, company);
    grouped.set(domain, value);
  }

  const domains = [...grouped.entries()]
    .map(([domain, value]) => {
      const agencies = rankedNames(value.agencies);
      const companies = rankedNames(value.companies);
      return {
        domain,
        n: value.n,
        agencies,
        companies,
        // Below the consistency bar the domain has no single answer; leave it unscored.
        dominantAgency:
          agencies[0] && share(agencies[0].count, value.n) >= DOMAIN_CONSISTENCY_THRESHOLD ? agencies[0] : null,
        dominantCompany:
          companies[0] && share(companies[0].count, value.n) >= DOMAIN_CONSISTENCY_THRESHOLD ? companies[0] : null,
        consistency: consistencyLabel(value.n, agencies, companies),
      };
    })
    .sort((left, right) => left.domain.localeCompare(right.domain));
  return { domains, foundRows, foundRowsMissingDomain };
}

export function buildUniverse(truthRows: readonly JsonRecord[]): PartyMatchRow[] {
  const grouped = new Map<string, { kind: PartyMatchKind; tally: NameTally }>();
  for (const row of truthRows) {
    if (!isFoundTruth(row)) continue;
    const commercial = asRecord(row.commercial);
    for (const kind of ['agency', 'company'] as const) {
      const name = partyName(commercial, kind);
      if (!name) continue;
      const normalizedName = normalisePartyName(name) || name.toLowerCase();
      const key = `${kind}:${normalizedName}`;
      const existing = grouped.get(key);
      if (existing) incrementNameTally(existing.tally, name);
      else {
        const tally: NameTally = {
          normalizedName,
          count: 0,
          variants: new Map<string, number>(),
        };
        incrementNameTally(tally, name);
        grouped.set(key, { kind, tally });
      }
    }
  }
  return [...grouped.values()]
    .map(({ kind, tally }) => {
      const name =
        rankedNames(new Map([[tally.normalizedName, tally]]))[0]?.name ?? tally.normalizedName;
      const digest = createHash('sha256')
        .update(`${kind}:${tally.normalizedName}`)
        .digest('hex')
        .slice(0, 16);
      return { kind, nativeId: `offline-${kind}-${digest}`, name };
    })
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        normalisePartyName(left.name).localeCompare(normalisePartyName(right.name)),
    );
}

export function latestSucceededExtractions(rows: readonly JsonRecord[]): Map<string, JsonRecord> {
  const latest = new Map<string, JsonRecord>();
  for (const row of rows) {
    if (cleanText(row.status)?.toLowerCase() !== 'succeeded') continue;
    const messageId = cleanText(row.message_id);
    if (!messageId) continue;
    const previous = latest.get(messageId);
    const createdAt = cleanText(row.created_at) ?? '';
    const previousCreatedAt = cleanText(previous?.created_at) ?? '';
    const rowId = cleanText(row.id) ?? '';
    const previousId = cleanText(previous?.id) ?? '';
    if (
      !previous ||
      createdAt > previousCreatedAt ||
      (createdAt === previousCreatedAt && rowId > previousId)
    ) {
      latest.set(messageId, row);
    }
  }
  return latest;
}

export function corpusTextBody(message: JsonRecord): string {
  const body = typeof message.body === 'string' ? message.body : '';
  if (message.body_is_html !== true) return body;
  return body
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<\s*br\s*\/?>/giu, '\n')
    .replace(/<\/(?:p|div|li|tr|table|blockquote|h[1-6]|section)\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/[ \t]+\n/gu, '\n');
}

export function selectTestEmails(input: {
  messages: readonly JsonRecord[];
  extractionsByMessage: ReadonlyMap<string, JsonRecord>;
  domains: readonly DomainTruth[];
  maxPerDomain: number;
}): { selected: TestEmail[]; candidateCount: number; preferredCount: number } {
  const domainsWithAgency = new Map(
    input.domains
      .filter((domain) => domain.dominantAgency)
      .map((domain) => [domain.domain, domain] as const),
  );
  const grouped = new Map<string, TestEmail[]>();
  let candidateCount = 0;
  for (const message of input.messages) {
    if (cleanText(message.direction)?.toLowerCase() !== 'inbound') continue;
    const domain = emailDomain(message.from_address);
    if (!domain || !domainsWithAgency.has(domain)) continue;
    const messageId = cleanText(message.id);
    const extraction = messageId ? input.extractionsByMessage.get(messageId) : undefined;
    if (!extraction) continue;
    candidateCount += 1;
    const truth = domainsWithAgency.get(domain)!;
    const kind = cleanText(extraction.kind) ?? 'unknown';
    const row: TestEmail = {
      domain,
      extractionKind: kind,
      receivedAt: cleanText(message.received_at) ?? cleanText(message.sent_at) ?? '',
      expected: { kind: 'agency', name: truth.dominantAgency!.name },
      emailInput: {
        payload: extraction.payload,
        fromAddress: cleanText(message.from_address),
        subject: cleanText(message.subject),
        body: corpusTextBody(message),
        // The current prefetch obtains this optional value from aiAgentRun; offline mode does not read the DB.
        quoteLlmParty: null,
      },
    };
    const entries = grouped.get(domain) ?? [];
    entries.push(row);
    grouped.set(domain, entries);
  }

  const selected: TestEmail[] = [];
  let preferredCount = 0;
  const compareRecency = (left: TestEmail, right: TestEmail) => {
    if (left.receivedAt !== right.receivedAt)
      return right.receivedAt.localeCompare(left.receivedAt);
    return left.extractionKind.localeCompare(right.extractionKind);
  };
  for (const [, rows] of [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const preferred = rows.filter((row) => PREFERRED_EXTRACTION_KINDS.has(row.extractionKind));
    const other = rows.filter((row) => !PREFERRED_EXTRACTION_KINDS.has(row.extractionKind));
    const ordered = [...preferred.sort(compareRecency), ...other.sort(compareRecency)];
    const domainSelection = ordered.slice(0, input.maxPerDomain);
    preferredCount += domainSelection.filter((row) =>
      PREFERRED_EXTRACTION_KINDS.has(row.extractionKind),
    ).length;
    selected.push(...domainSelection);
  }
  return { selected, candidateCount, preferredCount };
}

function isExpectedRow(row: PartyMatchRow, expected: TestEmail['expected']): boolean {
  return (
    row.kind === expected.kind && normalisePartyName(row.name) === normalisePartyName(expected.name)
  );
}

function rowKey(row: Pick<PartyMatchRow, 'kind' | 'nativeId'>): string {
  return `${row.kind}:${row.nativeId}`;
}

function safeOrgName(name: string): string {
  const cleaned = name.replace(/\s+/gu, ' ').trim();
  const withoutTitle = cleaned.replace(/^(?:(?:mr|mrs|ms|miss|dr|prof)\.?\s+)/iu, '');
  const words = withoutTitle.split(/\s+/u);
  const organizationWords =
    /\b(?:pty|ltd|proprietary|limited|incorporated|llc|llp|cc|travel|travels|tours?|agency|services|holdings|group|hotel|university|management|solutions|restaurant|surgical|health|science|destination|consulting|international|africa|company|mining)\b/iu;
  const looksLikePerson =
    words.length >= 2 &&
    words.length <= 4 &&
    !organizationWords.test(cleaned) &&
    words.every((word) => /^\p{Lu}[\p{L}'’.-]*$/u.test(word));
  if (/@/u.test(cleaned)) return '[masked email-like value]';
  if (looksLikePerson) return '[masked person-like value]';
  return cleaned;
}

function markdownCell(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}

function formatPercent(numerator: number, denominator: number): string {
  if (!denominator) return 'n/a';
  return `${((numerator / denominator) * 100).toFixed(1)}% (${numerator}/${denominator})`;
}

function candidateLabel(candidates: readonly PartyMatchCandidate[], kind: PartyMatchKind): string {
  const strong = candidates.find(
    (candidate) => candidate.kind === kind && candidate.strength === 'strong',
  );
  const anyStrong = strong ?? candidates.find((candidate) => candidate.strength === 'strong');
  return anyStrong ? safeOrgName(anyStrong.name) : '[no strong extracted organization name]';
}

export type PartyV2FailureExample = {
  domain: string;
  extractedOrgName: string;
  truthName: string;
};

export function selectPartyV2FailureExamples(
  scores: readonly {
    testEmail: { domain: string; expected: { kind: PartyMatchKind; name: string } };
    candidates: readonly PartyMatchCandidate[];
    fallbackDecision: Pick<PartyMatchDecision, 'boundParty'>;
  }[],
  maxExamples = 10,
): PartyV2FailureExample[] {
  const limit = Math.max(0, Math.floor(maxExamples));
  if (!limit) return [];
  const examples = new Map<string, PartyV2FailureExample>();
  for (const score of scores) {
    const boundParty = score.fallbackDecision.boundParty;
    if (boundParty && isExpectedRow(boundParty, score.testEmail.expected)) continue;
    const example = {
      domain: score.testEmail.domain,
      extractedOrgName: candidateLabel(score.candidates, score.testEmail.expected.kind),
      truthName: safeOrgName(score.testEmail.expected.name),
    };
    const key = `${example.domain}\n${example.extractedOrgName}\n${example.truthName}`;
    if (!examples.has(key)) examples.set(key, example);
    if (examples.size >= limit) break;
  }
  return [...examples.values()];
}

export async function scoreTestEmail(
  testEmail: TestEmail,
  universeByKind: ReadonlyMap<PartyMatchKind, readonly PartyMatchRow[]>,
  liveAdapter: ModelAdapter | null = null,
  extraCandidates: readonly PartyMatchCandidate[] = [],
): Promise<ScoredEmail> {
  const candidates = buildPartyMatchCandidates(testEmail.emailInput);
  for (const candidate of extraCandidates) {
    const key = `${candidate.kind}:${normalisePartyName(candidate.name)}`;
    const existing = candidates.find(
      (row) => `${row.kind}:${normalisePartyName(row.name)}` === key,
    );
    if (!existing) candidates.push({ ...candidate });
    else if (existing.strength === 'weak' && candidate.strength === 'strong') {
      existing.source = candidate.source;
      existing.strength = candidate.strength;
    }
  }
  const termsByCandidate = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${normalisePartyName(candidate.name)}`;
    const terms = termsByCandidate.get(key) ?? new Set<string>();
    for (const term of partyMatchSearchTerms(candidate.name)) terms.add(normalisePartyName(term));
    termsByCandidate.set(key, terms);
  }
  const searches = planPartySearches(candidates).slice(0, PARTY_MATCH_V2_SEARCH_CAP);
  const rowsById = new Map<string, PartyMatchRow>();
  const provenanceByRowId = new Map<string, SearchProvenance>();
  let candidateFound = false;
  let truthRetrieved = false;
  let truncated = false;
  for (const search of searches) {
    const candidateKey = `${search.kind}:${normalisePartyName(search.candidateName)}`;
    if (!termsByCandidate.get(candidateKey)?.has(normalisePartyName(search.term))) {
      throw new Error('Party V2 planner emitted a term outside its candidate term list');
    }
    const result = simulateHmsContains(
      universeByKind.get(search.kind) ?? [],
      search.term,
      HMS_CONTAINS_CAP,
    );
    if (result.rows.length) candidateFound = true;
    if (result.rows.some((row) => isExpectedRow(row, testEmail.expected))) truthRetrieved = true;
    truncated ||= result.truncated;
    for (const row of result.rows) {
      const key = rowKey(row);
      if (!rowsById.has(key)) {
        rowsById.set(key, row);
        provenanceByRowId.set(key, { term: search.term, candidateName: search.candidateName });
      }
    }
  }

  const unboundedRows = [...rowsById.values()];
  if (unboundedRows.length > PARTY_MATCH_V2_ROW_CAP) truncated = true;
  const rows = unboundedRows.slice(0, PARTY_MATCH_V2_ROW_CAP);
  const truthRow = rows.find((row) => isExpectedRow(row, testEmail.expected));
  const context = partyMatchEmailContext(testEmail.emailInput);
  const fallbackPick = await pickPartyMatch({ adapter: null, candidates, rows, context });
  const fallbackDecision = applyPartyBindRule({ candidates, rows, pick: fallbackPick, truncated });
  const perfectPick: PartyMatchPick = truthRow
    ? {
        pickNativeId: truthRow.nativeId,
        kind: truthRow.kind,
        confidence: 'high',
        reason: 'Offline perfect-picker upper bound selected the expected row when present.',
        alternatives: [],
        source: 'llm',
      }
    : {
        pickNativeId: null,
        kind: null,
        confidence: 'low',
        reason: 'Expected row was not present in the rows delivered to the picker.',
        alternatives: [],
        source: 'llm',
      };
  const perfectDecision = applyPartyBindRule({ candidates, rows, pick: perfectPick, truncated });
  // Same call shape as the V2 prefetch: no rows means no model call.
  const livePick = liveAdapter
    ? await pickPartyMatch({ adapter: rows.length ? liveAdapter : null, candidates, rows, context })
    : null;
  const liveDecision = livePick
    ? applyPartyBindRule({ candidates, rows, pick: livePick, truncated })
    : null;
  return {
    testEmail,
    candidates,
    candidateFound,
    truthRetrieved,
    truthInPickerRows: Boolean(truthRow),
    truncated,
    fallbackDecision,
    perfectDecision,
    liveDecision,
    provenanceByRowId,
  };
}

function scenarioMetrics(
  scores: readonly ScoredEmail[],
  scenario: 'fallback' | 'perfect' | 'live',
): { bound: number; correct: number; top3: number; wrongBinds: WrongBind[] } {
  let bound = 0;
  let correct = 0;
  let top3 = 0;
  const wrongBinds: WrongBind[] = [];
  for (const score of scores) {
    const decision =
      scenario === 'fallback'
        ? score.fallbackDecision
        : scenario === 'perfect'
          ? score.perfectDecision
          : (score.liveDecision ?? null);
    if (!decision) continue;
    const boundParty = decision.boundParty;
    if (decision.suggestions.some((row) => isExpectedRow(row, score.testEmail.expected))) {
      top3 += 1;
    }
    if (!boundParty) continue;
    bound += 1;
    if (isExpectedRow(boundParty, score.testEmail.expected)) {
      correct += 1;
      continue;
    }
    const provenance = score.provenanceByRowId.get(rowKey(boundParty));
    wrongBinds.push({
      mode:
        scenario === 'fallback'
          ? 'Oracle-free fallback'
          : scenario === 'perfect'
            ? 'Perfect picker'
            : 'Live production picker',
      domain: score.testEmail.domain,
      term: safeOrgName(provenance?.term ?? '[no search term]'),
      bound: `${boundParty.kind}: ${safeOrgName(boundParty.name)}`,
      expected: `${score.testEmail.expected.kind}: ${safeOrgName(score.testEmail.expected.name)}`,
      extractedOrgName: candidateLabel(score.candidates, boundParty.kind),
    });
  }
  return { bound, correct, top3, wrongBinds };
}

function formatNameList(
  names: readonly RankedPartyName[],
  dominant: RankedPartyName | null,
): string {
  if (!names.length) return '—';
  return names
    .map((row) => {
      const label = markdownCell(safeOrgName(row.name));
      const formatted = `${label} (${row.count})`;
      return dominant?.normalizedName === row.normalizedName ? `**${formatted}**` : formatted;
    })
    .join('<br>');
}

function buildReport(input: {
  domainTruth: DomainTruth[];
  foundRows: number;
  foundRowsMissingDomain: number;
  universe: PartyMatchRow[];
  testEmails: TestEmail[];
  extractionCandidates: number;
  preferredSelected: number;
  scores: ScoredEmail[];
}): string {
  const total = input.scores.length;
  const fallback = scenarioMetrics(input.scores, 'fallback');
  const perfect = scenarioMetrics(input.scores, 'perfect');
  const candidateFound = input.scores.filter((score) => score.candidateFound).length;
  const truthRetrieved = input.scores.filter((score) => score.truthRetrieved).length;
  const truthInPickerRows = input.scores.filter((score) => score.truthInPickerRows).length;
  const truncated = input.scores.filter((score) => score.truncated).length;
  const testedDomains = new Map<string, TestEmail[]>();
  for (const email of input.testEmails) {
    const rows = testedDomains.get(email.domain) ?? [];
    rows.push(email);
    testedDomains.set(email.domain, rows);
  }
  const kindCounts = new Map<string, number>();
  for (const email of input.testEmails) {
    kindCounts.set(email.extractionKind, (kindCounts.get(email.extractionKind) ?? 0) + 1);
  }
  const mismatchDomains = input.domainTruth.filter(
    (domain) =>
      domain.dominantAgency &&
      domain.dominantCompany &&
      domain.dominantAgency.normalizedName !== domain.dominantCompany.normalizedName,
  );
  const unscoredNoAgency = input.domainTruth.filter((domain) => !domain.dominantAgency).length;
  const fallbackPrecision = fallback.bound
    ? formatPercent(fallback.correct, fallback.bound)
    : 'n/a (0 binds)';
  const perfectPrecision = perfect.bound
    ? formatPercent(perfect.correct, perfect.bound)
    : 'n/a (0 binds)';
  const liveScored = input.scores.filter((score) => score.liveDecision).length;
  const live = liveScored ? scenarioMetrics(input.scores, 'live') : null;
  const livePrecision = live?.bound ? formatPercent(live.correct, live.bound) : 'n/a (0 binds)';
  const allWrong = [...fallback.wrongBinds, ...perfect.wrongBinds, ...(live?.wrongBinds ?? [])];
  const failureExamples = selectPartyV2FailureExamples(input.scores);
  const kindSummary =
    [...kindCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, count]) => `${kind}: ${count}`)
      .join(', ') || 'none';

  const lines = [
    '# R7 Party V2 offline score',
    '',
    '## Answer',
    '',
    `Scored ${total} inbound emails from ${testedDomains.size} mapped business domains. Oracle-free fallback auto-bound ${fallback.bound}/${total} (${formatPercent(fallback.bound, total)}) at ${fallbackPrecision} precision; the perfect-picker upper bound auto-bound ${perfect.bound}/${total} (${formatPercent(perfect.bound, total)}).`,
    ...(live
      ? [
        '',
        `Live production picker (${liveScored} emails): auto-bound ${live.bound}/${total} (${formatPercent(live.bound, total)}) at ${livePrecision} precision; wrong binds: ${live.wrongBinds.length}.`,
      ]
      : []),
    '',
    '## Method',
    '',
    `- Domain truth uses ${input.foundRows} answer-key rows with outcome 'found'; ${input.foundRowsMissingDomain} lacked a conf-to-domain mapping. A party name is dominant when its normalized name occurs in at least 80% of all found rows for that domain.`,
    '- Test emails are inbound messages whose sender host is a found-row domain with a dominant agency and whose latest succeeded extraction is available. Requested extraction kinds are preferred; other kinds fill remaining slots up to five per domain. Samples are sorted newest first within each kind group.',
    '- The corpus has no explicit staff flag; “non-staff” is operationalized as inbound mail from the external business domains present in the answer-key mapping. No sender address, subject, message ID, or email body is emitted to the report.',
    '- Inputs to `buildPartyMatchCandidates` and `partyMatchEmailContext` mirror V2 prefetch: extraction payload, sender, subject, and body. The optional persisted quote-Luna answer is unavailable without DB access, so it is null; no `guestNames` override is passed. HTML-flagged corpus bodies are converted to plain text for the prefetch text-body input.',
    `- \`partyMatchSearchTerms\`, \`planPartySearches\`, \`normalisePartyName\`, and \`buildPartyMatchCandidates\` produce the exact V2 candidate/search plan (maximum ${PARTY_MATCH_V2_SEARCH_CAP} terms per email). Each term searches only its planned party kind.`,
    `- HMS “Name contains” is simulated as case-insensitive substring matching over the normalized-distinct answer-key company/agency name universe, with deterministic kind/name ordering and a 50-row per-term cap. Retrieved rows are de-duplicated, then the V2 picker input is capped at ${PARTY_MATCH_V2_ROW_CAP}; any cap marks the result truncated. Synthetic IDs identify name/kind rows for scoring and are not reported.`,
    '- Scenario A calls production `pickPartyMatch` with `adapter: null` (the deterministic fallback), then `applyPartyBindRule`. Scenario B picks the expected row with high confidence only if it is in the capped picker input, then applies the same bind rule.',
    '',
    '## Findings',
    '',
    `- Test selection: ${input.extractionCandidates} inbound emails had a latest succeeded extraction across scored domains; selected ${total}, including ${input.preferredSelected} preferred-kind emails and ${total - input.preferredSelected} fallback-kind emails. Full kind mix: ${kindSummary}. Candidate universe contains ${input.universe.length} normalized-distinct company/agency names.`,
    `- Candidate found means any planned term returned at least one row. Truth retrieved means the expected dominant agency appeared in any per-term result. ${truthInPickerRows}/${total} truths survived into the capped picker rows; ${truncated}/${total} cases were marked truncated.`,
    '',
    '| Mode | Candidate found | Search retrieves truth | Auto-bind rate | Auto-bind precision | Wrong binds | Top-3 contains truth |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| Oracle-free fallback | ${formatPercent(candidateFound, total)} | ${formatPercent(truthRetrieved, total)} | ${formatPercent(fallback.bound, total)} | ${fallbackPrecision} | ${fallback.wrongBinds.length} | ${formatPercent(fallback.top3, total)} |`,
    `| Perfect picker upper bound | ${formatPercent(candidateFound, total)} | ${formatPercent(truthRetrieved, total)} | ${formatPercent(perfect.bound, total)} | ${perfectPrecision} | ${perfect.wrongBinds.length} | ${formatPercent(perfect.top3, total)} |`,
    ...(live
      ? [
          `| Live production picker | ${formatPercent(candidateFound, total)} | ${formatPercent(truthRetrieved, total)} | ${formatPercent(live.bound, total)} | ${livePrecision} | ${live.wrongBinds.length} | ${formatPercent(live.top3, total)} |`,
        ]
      : []),
    '',
    '### Domain truth by sender domain',
    '',
    '| Domain | n | Agency names | Company names | Consistency |',
    '| --- | ---: | --- | --- | --- |',
    ...input.domainTruth.map(
      (domain) =>
        `| ${markdownCell(domain.domain)} | ${domain.n} | ${formatNameList(domain.agencies, domain.dominantAgency)} | ${formatNameList(domain.companies, domain.dominantCompany)} | ${domain.consistency} |`,
    ),
    '',
    `Domains with no agency name in found truth: ${unscoredNoAgency}; test emails from those domains cannot be assigned the requested agency-kind expected party.`,
    '',
    '### Domains where dominant company differs from dominant agency',
    '',
    ...(mismatchDomains.length
      ? [
          '| Domain | Dominant agency (expected) | Dominant company |',
          '| --- | --- | --- |',
          ...mismatchDomains.map(
            (domain) =>
              `| ${markdownCell(domain.domain)} | ${markdownCell(safeOrgName(domain.dominantAgency!.name))} | ${markdownCell(safeOrgName(domain.dominantCompany!.name))} |`,
          ),
        ]
      : ['No mapped domain has different dominant agency and company names.']),
    '',
    '### Selected sample mix',
    '',
    '| Domain | Emails | Extraction kinds |',
    '| --- | ---: | --- |',
    ...(testedDomains.size
      ? [...testedDomains.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([domain, rows]) => {
            const counts = new Map<string, number>();
            for (const row of rows)
              counts.set(row.extractionKind, (counts.get(row.extractionKind) ?? 0) + 1);
            const kinds = [...counts.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([kind, count]) => `${kind} (${count})`)
              .join(', ');
            return `| ${markdownCell(domain)} | ${rows.length} | ${markdownCell(kinds)} |`;
          })
      : ['| — | 0 | — |']),
    '',
    `Wrong auto-binds across all modes: ${allWrong.length}.`,
    '',
    ...(allWrong.length
      ? [
          '| Mode | Domain | Search term | Bound | Expected |',
          '| --- | --- | --- | --- | --- |',
          ...allWrong.map(
            (row) =>
              `| ${row.mode} | ${markdownCell(row.domain)} | ${markdownCell(row.term)} | ${markdownCell(row.bound)} | ${markdownCell(row.expected)} |`,
          ),
        ]
      : ['No wrong binds.']),
    '',
    '## Failure examples (masked)',
    '',
    ...(failureExamples.length
      ? [
          'Up to 10 unique oracle-free cases without a correct auto-bind:',
          '',
          '| Domain | Extracted organization name | Truth name |',
          '| --- | --- | --- |',
          ...failureExamples.map(
            (row) =>
              `| ${markdownCell(row.domain)} | ${markdownCell(row.extractedOrgName)} | ${markdownCell(row.truthName)} |`,
          ),
        ]
      : ['No oracle-free abstentions or wrong binds in this sample.']),
    '',
    '## Implications',
    '',
    '- This is a lower-bound ambiguity simulation, not an HMS replay: the universe contains only names observed in the answer key, normalized name duplicates collapse to one row, and real HMS parties may add competing rows or duplicate native IDs.',
    '- The 50-row simulator cap, deterministic alphabetical row order, and 25-row V2 picker cap make top-row behavior approximate; live HMS search ordering, match semantics, and truncation can differ.',
    '- The perfect picker is an upper bound only after retrieval and row caps; it does not bypass `applyPartyBindRule` confidence, uniqueness, or truncation safeguards.',
    '- Current V2 prefetch is quote-only. Samples drawn from booking, amendment, or voucher-pop extractions are exploratory counterfactuals, not proof those messages enter the current production prefetch path.',
    '- The corpus sample is sparse and capped at five messages per domain. It omits database-stored quote-Luna output and does not call Luna, HMS, the network, or a database.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    ...DEFAULT_PATHS,
    maxPerDomain: DEFAULT_MAX_PER_DOMAIN,
    livePicker: false,
    help: false,
  };
  const pathFlags: Record<string, keyof typeof DEFAULT_PATHS> = {
    '--truth': 'truth',
    '--conf-domain': 'confDomain',
    '--messages': 'messages',
    '--extractions': 'extractions',
    '--report': 'report',
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    const equalsAt = arg.indexOf('=');
    const flag = equalsAt >= 0 ? arg.slice(0, equalsAt) : arg;
    const inlineValue = equalsAt >= 0 ? arg.slice(equalsAt + 1) : undefined;
    if (flag === '--live-picker') {
      options.livePicker = true;
      continue;
    }
    if (flag === '--max-per-domain') {
      const value = inlineValue ?? args[++index];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > DEFAULT_MAX_PER_DOMAIN) {
        throw new Error(`--max-per-domain must be an integer from 1 to ${DEFAULT_MAX_PER_DOMAIN}`);
      }
      options.maxPerDomain = parsed;
      continue;
    }
    const optionKey = pathFlags[flag];
    if (!optionKey) throw new Error(`unknown option: ${flag}`);
    const value = inlineValue ?? args[++index];
    if (!value?.trim()) throw new Error(`${flag} requires a path`);
    options[optionKey] = value;
  }
  return options;
}

function usage(): string {
  return [
    'Usage: pnpm exec tsx scripts/party-v2-offline-score.ts [options]',
    '',
    'Options:',
    `  --truth <path>         Answer key (default: ${DEFAULT_PATHS.truth})`,
    `  --conf-domain <path>   Conf-to-domain map (default: ${DEFAULT_PATHS.confDomain})`,
    `  --messages <path>      Inbound message corpus (default: ${DEFAULT_PATHS.messages})`,
    `  --extractions <path>   Extraction corpus (default: ${DEFAULT_PATHS.extractions})`,
    `  --report <path>        Markdown report (default: ${DEFAULT_PATHS.report})`,
    `  --max-per-domain <n>   Sample cap per domain (default: ${DEFAULT_MAX_PER_DOMAIN})`,
    '  --live-picker          Also score the production picker route (needs the prod env)',
  ].join('\n');
}

function assertReportOutsideRepo(reportPath: string): void {
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = resolve(dirname(scriptPath), '../../..');
  const outputPath = resolve(reportPath);
  const rel = relative(repoRoot, outputPath);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')) {
    throw new Error('Refusing to write the private score report inside the repository');
  }
}

export async function runPartyV2OfflineScore(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  assertReportOutsideRepo(options.report);
  const inputPaths = [options.truth, options.confDomain, options.messages, options.extractions].map(
    (value) => resolve(value),
  );
  if (inputPaths.includes(resolve(options.report))) {
    throw new Error('Report path must not overwrite an input file');
  }

  const [truthRows, confDomains, messages, extractionRows] = await Promise.all([
    readRows(options.truth),
    readConfDomains(options.confDomain),
    readRows(options.messages),
    readRows(options.extractions),
  ]);
  const foundRows = truthRows.filter(isFoundTruth);
  const domainResult = buildDomainTruth(truthRows, confDomains);
  const universe = buildUniverse(foundRows);
  const latestExtractions = latestSucceededExtractions(extractionRows);
  const sampleSelection = selectTestEmails({
    messages,
    extractionsByMessage: latestExtractions,
    domains: domainResult.domains,
    maxPerDomain: options.maxPerDomain,
  });
  const universeByKind = new Map<PartyMatchKind, PartyMatchRow[]>([
    ['agency', universe.filter((row) => row.kind === 'agency')],
    ['company', universe.filter((row) => row.kind === 'company')],
  ]);
  let liveAdapter: ModelAdapter | null = null;
  if (options.livePicker) {
    const [{ quoteWorkflowLlmEnabled }, { resolveAdapter }] = await Promise.all([
      import('../src/ai/quote-workflow-llm.js'),
      import('../src/ai/quote-workflow-analyse-selection.js'),
    ]);
    const route = resolveAdapter(quoteWorkflowLlmEnabled(process.env), null);
    if (!route.enabled || !route.adapter) throw new Error('--live-picker needs the production quote-workflow model route');
    liveAdapter = route.adapter;
  }
  const scores: ScoredEmail[] = [];
  for (const email of sampleSelection.selected) {
    scores.push(await scoreTestEmail(email, universeByKind, liveAdapter));
  }
  const report = buildReport({
    domainTruth: domainResult.domains,
    foundRows: domainResult.foundRows,
    foundRowsMissingDomain: domainResult.foundRowsMissingDomain,
    universe,
    testEmails: sampleSelection.selected,
    extractionCandidates: sampleSelection.candidateCount,
    preferredSelected: sampleSelection.preferredCount,
    scores,
  });
  await mkdir(dirname(resolve(options.report)), { recursive: true });
  await writeFile(options.report, report, 'utf8');
  process.stdout.write(
    `Wrote offline party-v2 score: ${options.report} (${domainResult.domains.length} domains, ${scores.length} emails, ${universe.length} party names).\n`,
  );
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath && entryPath === resolve(fileURLToPath(import.meta.url))) {
  void runPartyV2OfflineScore().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'offline scorer failed'}\n`);
    process.exitCode = 1;
  });
}
