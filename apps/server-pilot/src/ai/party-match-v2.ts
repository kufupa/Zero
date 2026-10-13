import { extractPartyMentions, suggestPartyFromSender } from './party-aliases.js';
import type { ModelAdapter } from './bedrock/adapter.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { matchKey } from './party-match.js';
import { z } from 'zod';

export type PartyMatchKind = 'company' | 'agency';
export type PartyMatchStrength = 'strong' | 'weak';
export type PartyMatchSource =
  | 'extraction_agency'
  | 'extraction_end_client'
  | 'quote_llm'
  | 'body'
  | 'signature'
  | 'sender_domain_alias'
  | 'sender_domain_label';

export type PartyMatchCandidate = {
  name: string;
  kind: PartyMatchKind;
  source: PartyMatchSource;
  /** Domain-derived candidates can guide searches and suggestions, but can never authorize a bind. */
  strength: PartyMatchStrength;
};

export type PartyMatchRow = {
  kind: PartyMatchKind;
  nativeId: string;
  name: string;
};

export type PartyMatchSearch = {
  term: string;
  kind: PartyMatchKind;
  candidateName: string;
  source: PartyMatchSource;
  strength: PartyMatchStrength;
};

export type PartyMatchEmailContext = {
  fromAddress: string | null;
  displayName: string | null;
  subject: string | null;
  signatureBlock: string;
  extractedNames: string[];
};

export type PartyMatchPick = {
  pickNativeId: string | null;
  kind: PartyMatchKind | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  alternatives: string[];
  source: 'llm' | 'fallback';
};

export type PartyMatchDecision = {
  matchStatus: 'bound' | 'needs_pick';
  boundParty: PartyMatchRow | null;
  suggestions: PartyMatchRow[];
  reason: string;
};

const MAX_CANDIDATE_NAME = 256;
const MAX_SEARCH_TERMS_PER_CANDIDATE = 4;
export const PARTY_MATCH_V2_SEARCH_CAP = 6;
export const PARTY_MATCH_V2_ROW_CAP = 25;
const MAX_SIGNATURE_CHARS = 2_000;
const MAX_PERSON_SCAN_CHARS = 20_000;

const GENERIC_WORDS = new Set([
  'group',
  'travel',
  'travels',
  'tours',
  'services',
  'holdings',
  'hotel',
  'company',
  'solutions',
  'management',
  'consulting',
  'international',
  'africa',
  'sa',
  'the',
  'and',
  'of',
]);
const LEGAL_FORMS = new Set([
  'pty',
  'ltd',
  'proprietary',
  'cc',
  'inc',
  'limited',
  'sa',
  'llc',
  'sl',
]);
const BRACKETED = /\(([^()]*)\)|\[([^\[\]]*)\]/g;
const LEGAL_ABBREVIATION = /\b(?:P\.T\.Y\.?|L\.T\.D\.?|L\.L\.C\.?|S\.A\.?|S\.L\.?)\b/giu;
const ACRONYM = /^\p{Lu}[\p{Lu}\p{N}&]{1,15}$/u;
const ORG_WORDS =
  /\b(?:pty\s*ltd|proprietary|limited|incorporated|llc|llp|cc|travel|travels|tours|agency|services|holdings|group|hotel|university|management|solutions|restaurant|surgical|health|science|destination|consulting|international|africa|company)\b/i;
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'yahoo.co.za',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'example.com',
  'example.net',
  'example.org',
  'example.test',
  'localhost',
]);

/** Human-readable search form: accents, brackets, punctuation and trailing legal forms are removed. */
function cleanPartySearchName(value: string): string {
  const raw = value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(LEGAL_ABBREVIATION, (form) => form.replace(/\./gu, ''))
    .replace(BRACKETED, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ');
  const words = raw.split(/\s+/u).filter(Boolean);
  while (words.length && LEGAL_FORMS.has(matchKey(words.at(-1) ?? ''))) words.pop();
  return words.join(' ').trim();
}

/** Lower-case, accent-insensitive identity used by planning, comparisons and exact fallback. */
export function normalisePartyName(value: string): string {
  return matchKey(cleanPartySearchName(value));
}

function distinctiveTokens(value: string): string[] {
  return cleanPartySearchName(value)
    .split(/\s+/u)
    .filter((word) => {
      const key = matchKey(word);
      return [...key].length >= 3 && !GENERIC_WORDS.has(key);
    });
}

function bracketedAcronyms(value: string): string[] {
  const out: string[] = [];
  for (const match of value.matchAll(BRACKETED)) {
    const inside = (match[1] ?? match[2] ?? '').trim();
    if (ACRONYM.test(inside) && !LEGAL_FORMS.has(matchKey(inside))) out.push(inside);
  }
  return [...new Set(out)];
}

/**
 * Ordered HMS terms for one party: cleaned full name, distinctive word(s), a two-word phrase, then bracketed acronym.
 * Each candidate contributes at most four terms. The global planner also caps an email at six searches.
 */
export function partyMatchSearchTerms(name: string): string[] {
  const full = cleanPartySearchName(name);
  if (!full) return [];
  const distinctive = distinctiveTokens(full);
  const acronyms = bracketedAcronyms(name);
  const singles = distinctive.slice(0, acronyms.length ? 1 : 2);
  const phrase = distinctive.slice(0, 2).join(' ');
  const proposed = [full, ...singles, phrase, ...acronyms];
  const terms: string[] = [];
  for (const term of proposed) {
    const key = normalisePartyName(term);
    if (key && !terms.some((kept) => normalisePartyName(kept) === key)) terms.push(term);
    if (terms.length >= MAX_SEARCH_TERMS_PER_CANDIDATE) break;
  }
  return terms;
}

function sourcePriority(candidate: PartyMatchCandidate): number {
  // Agency contracts are the first place a reservationist checks when the sender is an agency.
  const kind = candidate.kind === 'agency' ? 0 : 10;
  const strength = candidate.strength === 'strong' ? 0 : 1;
  return kind + strength;
}

/** Pure, deterministic plan; duplicate searches of the same HMS list and term are removed. */
export function planPartySearches(candidates: readonly PartyMatchCandidate[]): PartyMatchSearch[] {
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (left, right) =>
        sourcePriority(left.candidate) - sourcePriority(right.candidate) ||
        left.index - right.index,
    );
  const perCandidate = ordered.map(({ candidate }) => ({
    candidate,
    terms: partyMatchSearchTerms(candidate.name),
  }));
  const out: PartyMatchSearch[] = [];
  const seen = new Set<string>();
  // Full names for both agency and client are tried before either name burns the budget on shorter terms.
  for (let termIndex = 0; termIndex < MAX_SEARCH_TERMS_PER_CANDIDATE; termIndex += 1) {
    for (const { candidate, terms } of perCandidate) {
      const term = terms[termIndex];
      if (!term) continue;
      const key = `${candidate.kind}:${normalisePartyName(term)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        term,
        kind: candidate.kind,
        candidateName: candidate.name,
        source: candidate.source,
        strength: candidate.strength,
      });
      if (out.length >= PARTY_MATCH_V2_SEARCH_CAP) return out;
    }
  }
  return out;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 && cleaned.length <= MAX_CANDIDATE_NAME ? cleaned : null;
}

function parseSender(raw: string | null | undefined): {
  address: string | null;
  displayName: string | null;
} {
  if (!raw?.trim()) return { address: null, displayName: null };
  const trimmed = raw.trim();
  const angle = trimmed.match(/^\s*["']?([^<>"']{1,120}?)["']?\s*<([^<>\s]+@[^<>\s]+)>\s*$/u);
  if (angle) {
    const displayName = angle[1]?.trim().replace(/^['"]|['"]$/g, '') || null;
    return { address: angle[2] ?? null, displayName };
  }
  const address = trimmed.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0] ?? null;
  return { address, displayName: null };
}

/** Best-effort bounded signature window; the source email stays available elsewhere for audit. */
export function extractPartySignature(body: unknown): string {
  if (typeof body !== 'string') return '';
  const lines = body.slice(-12_000).split(/\r?\n/u);
  const signoff =
    /^(?:--\s*|regards\b|kind regards\b|best regards\b|sincerely\b|thank you\b|thanks\b|cheers\b)/i;
  let start = Math.max(0, lines.length - 10);
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - 24); index -= 1) {
    if (signoff.test(lines[index]?.trim() ?? '')) {
      start = index;
      break;
    }
  }
  return lines.slice(start).join('\n').trim().slice(0, MAX_SIGNATURE_CHARS);
}

function isLikelyPersonName(value: string): boolean {
  const cleaned = value
    .trim()
    .replace(/^(?:(?:mr|mrs|ms|miss|dr|prof)\.?\s+)/iu, '')
    .replace(/\s+/gu, ' ');
  const words = cleaned.split(/\s+/u);
  if (
    words.length < 2 ||
    words.length > 4 ||
    ORG_WORDS.test(cleaned) ||
    /\b(?:director|assistant|manager|officer|consultant|reservations?|sales|executive|team|office|department|operations)\b/i.test(
      cleaned,
    )
  )
    return false;
  return words.every((word) => /^\p{Lu}[\p{L}'’.-]*$/u.test(word));
}

function namesFromText(textValue: string): string[] {
  const out = new Set<string>();
  const boundedText = textValue.slice(0, MAX_PERSON_SCAN_CHARS);
  const patterns = [
    /\b(?:guest|lead guest|traveller|traveler|passenger|booker|contact)(?:\s+name)?\s*[:\-]\s*([^\n,;]{2,100})/giu,
    /\b(?:accommodation|booking|stay|rooms?)\s+for\s+(?:(?:mr|mrs|ms|miss|dr)\.?\s+)?([\p{Lu}][\p{L}'’.-]+(?:\s+[\p{Lu}][\p{L}'’.-]+){1,2})(?=$|[\s,.;:!])/gu,
    /\b(?:regards|kind regards|best regards|sincerely|thank you|thanks|cheers)\s*[,\-:]?\s*((?:(?:mr|mrs|ms|miss|dr)\.?\s+)?[\p{Lu}][\p{L}'’.-]+(?:\s+[\p{Lu}][\p{L}'’.-]+){1,2})(?=$|[\s,.;:!|])/giu,
  ];
  for (const pattern of patterns) {
    for (const match of boundedText.matchAll(pattern)) {
      const name = text(match[1]);
      if (name && isLikelyPersonName(name))
        out.add(name.replace(/^(?:(?:mr|mrs|ms|miss|dr|prof)\.?\s+)/iu, ''));
    }
  }
  return [...out];
}

function signaturePersonNames(signature: string): string[] {
  return signature
    .split(/\r?\n/u)
    .map(
      (line) =>
        line
          .trim()
          .replace(/^[\s>*-]+/u, '')
          .replace(
            /^(?:kind regards|best regards|regards|sincerely|thank you|thanks|cheers)\s*[,\-:]?\s*/iu,
            '',
          )
          .replace(/^(?:contact|name|attention|attn)\s*:\s*/iu, '')
          .split(/\s*[|–—•]\s*/u)[0]
          ?.split(/\s*,\s*/u)[0]
          ?.trim() ?? '',
    )
    .map((line) => line.replace(/^(?:(?:mr|mrs|ms|miss|dr|prof)\.?\s+)/iu, ''))
    .filter((line) => isLikelyPersonName(line));
}

function signatureOrganisationRows(
  signature: string,
): Array<{ name: string; kind: PartyMatchKind }> {
  const found: Array<{ name: string; kind: PartyMatchKind }> = [];
  for (const rawLine of signature.split(/\r?\n/u)) {
    const line = rawLine.trim().replace(/^[\s>*-]+/u, '');
    const label = line.match(
      /^(agency|travel agency|company|organisation|organization|employer)\s*:\s*(.{2,160})$/i,
    );
    if (label?.[2]) {
      found.push({
        name: label[2].trim(),
        kind: /agency/i.test(label[1] ?? '') ? 'agency' : 'company',
      });
      continue;
    }
    if (line.length <= MAX_CANDIDATE_NAME && ORG_WORDS.test(line) && !isLikelyPersonName(line)) {
      found.push({
        name: line,
        kind: /\b(?:travel|travels|tours|agency)\b/i.test(line) ? 'agency' : 'company',
      });
    }
  }
  return found;
}

function quoteLlmPartyOf(input: { quoteLlmParty?: unknown; payload: Record<string, unknown> }): {
  name: string | null;
  kind: PartyMatchKind | null;
  guestNames: string[];
} {
  const extraction = objectRecord(input.payload);
  const quoteOutput = objectRecord(
    input.quoteLlmParty ??
      extraction.quoteLlmParty ??
      extraction.quoteParty ??
      extraction.lunaAnalysis ??
      extraction.party,
  );
  const nested = objectRecord(quoteOutput.lunaAnalysis);
  const party = objectRecord(quoteOutput.party ?? nested.party ?? quoteOutput);
  const rawKind = typeof party.kind === 'string' ? party.kind.toLowerCase() : '';
  const kind =
    rawKind === 'agency'
      ? 'agency'
      : ['organization', 'company', 'government'].includes(rawKind)
        ? 'company'
        : null;
  const groups = Array.isArray(quoteOutput.groups)
    ? quoteOutput.groups
    : Array.isArray(nested.groups)
      ? nested.groups
      : [];
  const guests = [
    ...(Array.isArray(party.guestNames) ? party.guestNames : []),
    ...groups.flatMap((value) => {
      const names = objectRecord(value).guestNames;
      return Array.isArray(names) ? names : [];
    }),
  ].filter((value): value is string => typeof value === 'string');
  return { name: text(party.name), kind, guestNames: guests };
}

function domainLabel(address: string | null): { name: string; host: string } | null {
  const host = address?.split('@').at(-1)?.toLowerCase().replace(/>.*$/, '') ?? '';
  if (!host || PUBLIC_EMAIL_DOMAINS.has(host) || !host.includes('.')) return null;
  const labels = host.split('.').filter(Boolean);
  if (labels.length > 2 && /^(?:co|com|org|gov|ac|net)$/i.test(labels.at(-2) ?? ''))
    labels.splice(-2, 2);
  else labels.pop();
  const label = labels.at(-1) ?? '';
  const name = label
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name.length >= 2 ? { name, host } : null;
}

function isAgencyDomainLabel(value: string): boolean {
  const key = matchKey(value);
  const compact = key.replace(/\s+/gu, '');
  return (
    /\b(?:travel|travels|tours?|agency|booking)\b/u.test(key) ||
    /(?:travel(?:s|agency|desk|services)?|tours?|agency|booking)$/iu.test(compact)
  );
}

function overlapsPersonName(candidate: string, person: string): boolean {
  const candidateKey = normalisePartyName(candidate);
  const comparisonName = person
    .trim()
    .split(/\s*[|–—•,;]\s*/u)[0]
    ?.replace(/^(?:(?:mr|mrs|ms|miss|dr|prof)\.?\s+)/iu, '')
    .trim();
  const personKey = comparisonName ? normalisePartyName(comparisonName) : '';
  if (!candidateKey || !personKey) return false;
  if (` ${candidateKey} `.includes(` ${personKey} `)) return true;
  const personTokens = personKey.split(' ');
  if (
    personTokens.length > 1 &&
    personTokens.every((token) => candidateKey.split(' ').includes(token))
  )
    return true;
  // A surname/first-name-only candidate is especially dangerous when it came from a parsed person line.
  return candidateKey.split(' ').length === 1 && personTokens.includes(candidateKey);
}

/** Builds strong extracted/explicit candidates, plus domain-only weak hints that can never bind. */
export function buildPartyMatchCandidates(input: {
  payload?: unknown;
  fromAddress?: string | null;
  displayName?: string | null;
  subject?: string | null;
  body?: string | null;
  quoteLlmParty?: unknown;
  guestNames?: readonly string[];
}): PartyMatchCandidate[] {
  const payload = objectRecord(input.payload);
  const sender = parseSender(input.fromAddress);
  const displayName = text(input.displayName) ?? sender.displayName;
  const signature = extractPartySignature(input.body);
  const quoteParty = quoteLlmPartyOf({ payload, quoteLlmParty: input.quoteLlmParty });
  const contact = objectRecord(payload.contact);
  const bodyAndSubject = `${input.subject ?? ''}\n${input.body ?? ''}`.slice(
    0,
    MAX_PERSON_SCAN_CHARS,
  );
  const people = new Set([
    ...(displayName && isLikelyPersonName(displayName) ? [displayName] : []),
    ...(text(contact.name) ? [text(contact.name)!] : []),
    ...quoteParty.guestNames,
    ...(input.guestNames ?? []),
    ...namesFromText(bodyAndSubject),
    ...signaturePersonNames(signature),
  ]);
  const candidates: PartyMatchCandidate[] = [];
  const add = (
    nameValue: unknown,
    kind: PartyMatchKind,
    source: PartyMatchSource,
    strength: PartyMatchStrength,
  ) => {
    const name = text(nameValue);
    if (!name || peopleHasMatch(name, people)) return;
    const key = `${kind}:${normalisePartyName(name)}`;
    const existing = candidates.find(
      (candidate) => `${candidate.kind}:${normalisePartyName(candidate.name)}` === key,
    );
    if (existing) {
      if (existing.strength === 'weak' && strength === 'strong') {
        existing.source = source;
        existing.strength = strength;
      }
      return;
    }
    candidates.push({ name, kind, source, strength });
  };

  const agency = text(payload.agency);
  const endClient = text(payload.endClient);
  add(agency, 'agency', 'extraction_agency', 'strong');
  add(endClient, 'company', 'extraction_end_client', 'strong');
  if (quoteParty.name && quoteParty.kind)
    add(quoteParty.name, quoteParty.kind, 'quote_llm', 'strong');
  for (const mention of extractPartyMentions(input.body)) {
    add(mention.name, mention.kind, 'body', 'strong');
  }
  for (const row of signatureOrganisationRows(signature))
    add(row.name, row.kind, 'signature', 'strong');

  const alias = suggestPartyFromSender(sender.address);
  if (alias) add(alias.name, alias.kind, 'sender_domain_alias', 'weak');
  const domain = domainLabel(sender.address);
  if (domain) {
    const kind: PartyMatchKind =
      alias?.kind ?? (isAgencyDomainLabel(domain.name) ? 'agency' : 'company');
    add(domain.name, kind, 'sender_domain_label', 'weak');
  }
  return candidates;
}

function peopleHasMatch(name: string, people: ReadonlySet<string>): boolean {
  for (const person of people) if (overlapsPersonName(name, person)) return true;
  return false;
}

export function partyMatchEmailContext(input: {
  payload?: unknown;
  fromAddress?: string | null;
  displayName?: string | null;
  subject?: string | null;
  body?: string | null;
  quoteLlmParty?: unknown;
  guestNames?: readonly string[];
}): PartyMatchEmailContext {
  const payload = objectRecord(input.payload);
  const sender = parseSender(input.fromAddress);
  const quoteParty = quoteLlmPartyOf({ payload, quoteLlmParty: input.quoteLlmParty });
  const signature = extractPartySignature(input.body);
  const names = [
    text(payload.agency),
    text(payload.endClient),
    quoteParty.name,
    text(objectRecord(payload.contact).name),
    sender.displayName,
    text(input.displayName),
    ...extractPartyMentions(input.body).map((mention) => mention.name),
    ...signatureOrganisationRows(signature).map((row) => row.name),
    ...namesFromText(`${input.subject ?? ''}\n${input.body ?? ''}`.slice(0, MAX_PERSON_SCAN_CHARS)),
    ...signaturePersonNames(signature),
    ...quoteParty.guestNames,
    ...(input.guestNames ?? []),
  ].filter((name): name is string => Boolean(name));
  return {
    fromAddress: sender.address,
    displayName: text(input.displayName) ?? sender.displayName,
    subject: text(input.subject),
    signatureBlock: signature,
    extractedNames: [...new Set(names)].slice(0, 12),
  };
}

const partyPickSchema = z
  .object({
    pickNativeId: z.string().min(1).max(100).nullable(),
    kind: z.enum(['company', 'agency']).nullable(),
    confidence: z.enum(['high', 'medium', 'low']),
    reason: z.string().min(1).max(500),
    alternatives: z.array(z.string().min(1).max(100)).max(3),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.pickNativeId === null) !== (value.kind === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pickNativeId and kind must both be null or set',
      });
    }
    if (new Set(value.alternatives).size !== value.alternatives.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'alternatives must be unique' });
    }
    if (value.pickNativeId && value.alternatives.includes(value.pickNativeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'picked party cannot also be an alternative',
      });
    }
  });

function fallbackPartyPick(
  candidates: readonly PartyMatchCandidate[],
  rows: readonly PartyMatchRow[],
): PartyMatchPick {
  if (!candidates.length || !rows.length) {
    return {
      pickNativeId: null,
      kind: null,
      confidence: 'low',
      reason: !candidates.length
        ? 'No safe company or agency name could be extracted from the email.'
        : 'HMS returned no party rows for the planned searches.',
      alternatives: [],
      source: 'fallback',
    };
  }
  const exact = new Map<string, PartyMatchRow>();
  for (const candidate of candidates) {
    if (candidate.strength !== 'strong') continue;
    const wanted = normalisePartyName(candidate.name);
    if (!wanted) continue;
    for (const row of rows) {
      if (row.kind === candidate.kind && normalisePartyName(row.name) === wanted) {
        exact.set(`${row.kind}:${row.nativeId}`, row);
      }
    }
  }
  const matches = [...exact.values()];
  if (matches.length === 1) {
    const [row] = matches;
    return {
      pickNativeId: row!.nativeId,
      kind: row!.kind,
      confidence: 'high',
      reason: 'The model was unavailable; one HMS row exactly matched a non-domain extracted name.',
      alternatives: [],
      source: 'fallback',
    };
  }
  return {
    pickNativeId: null,
    kind: null,
    confidence: 'low',
    reason:
      matches.length > 1
        ? 'The model was unavailable and more than one exact HMS row matched; choose a suggestion.'
        : 'The model was unavailable and there was no single exact HMS name match; choose a suggestion.',
    alternatives: matches.slice(0, 3).map((row) => row.nativeId),
    source: 'fallback',
  };
}

/** Calls the same gpt-6-luna ModelAdapter seam used by quote workflow; a failed/invalid call falls back exactly. */
export async function pickPartyMatch(input: {
  adapter: ModelAdapter | null;
  candidates: readonly PartyMatchCandidate[];
  rows: readonly PartyMatchRow[];
  context: PartyMatchEmailContext;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<PartyMatchPick> {
  const rows = input.rows.slice(0, PARTY_MATCH_V2_ROW_CAP);
  if (!input.adapter) return fallbackPartyPick(input.candidates, rows);
  try {
    const invoked = await input.adapter.invoke({
      modelId: 'gpt-6-luna',
      systemPrompt: [
        'You are matching the organisation or booking agency named in an email to records already returned by an HMS search.',
        'Pick a row only when the email evidence and name are a clear match. Similar spelling, one shared generic word, or sender domain alone is not enough.',
        'If the sender books for a client, the contract may be under either organisation; choose only the row supported by the context.',
        'Return null when uncertain. Never choose a person or a row that only resembles a person name.',
        'Return JSON matching the supplied schema. Alternatives must be other returned nativeIds, at most three.',
      ].join('\n'),
      userPrompt: JSON.stringify({ context: input.context, returnedRows: rows }),
      responseSchema: zodToJsonSchema(partyPickSchema, { $refStrategy: 'none' }) as Record<
        string,
        unknown
      >,
      signal: input.signal,
      deadlineAt: input.deadlineAt,
      maxOutputTokens: 500,
    });
    const parsed = partyPickSchema.safeParse(invoked.output);
    if (!parsed.success) return fallbackPartyPick(input.candidates, rows);
    const returned = new Map(rows.map((row) => [`${row.kind}:${row.nativeId}`, row]));
    if (
      parsed.data.pickNativeId &&
      !returned.has(`${parsed.data.kind}:${parsed.data.pickNativeId}`)
    ) {
      return fallbackPartyPick(input.candidates, rows);
    }
    if (
      parsed.data.alternatives.some(
        (id) =>
          !rows.some(
            (row) =>
              row.nativeId === id &&
              `${row.kind}:${row.nativeId}` !== `${parsed.data.kind}:${parsed.data.pickNativeId}`,
          ),
      )
    ) {
      return fallbackPartyPick(input.candidates, rows);
    }
    return { ...parsed.data, reason: parsed.data.reason.trim(), source: 'llm' };
  } catch {
    return fallbackPartyPick(input.candidates, rows);
  }
}

function partyClaimScore(candidate: PartyMatchCandidate, row: PartyMatchRow): 0 | 1 | 2 {
  if (candidate.kind !== row.kind || candidate.strength !== 'strong') return 0;
  const wanted = normalisePartyName(candidate.name);
  const found = normalisePartyName(row.name);
  if (!wanted || !found) return 0;
  if (wanted === found) return 2;
  const distinctive = distinctiveTokens(candidate.name).map(matchKey);
  if (!distinctive.length) return 0;
  const foundWords = new Set(found.split(' '));
  return distinctive.every((token) => foundWords.has(token)) ? 1 : 0;
}

function rowSuggestionScore(
  candidates: readonly PartyMatchCandidate[],
  row: PartyMatchRow,
): number {
  const scores = candidates.map((candidate) => partyClaimScore(candidate, row));
  if (scores.includes(2)) return 0;
  if (scores.includes(1)) return 1;
  if (
    candidates.some(
      (candidate) =>
        candidate.kind === row.kind &&
        normalisePartyName(candidate.name) &&
        candidate.strength === 'weak',
    )
  )
    return 2;
  return 3;
}

/** Precision-first authorization: a model opinion is not sufficient without a unique exact/all-token name claim. */
export function applyPartyBindRule(input: {
  candidates: readonly PartyMatchCandidate[];
  rows: readonly PartyMatchRow[];
  pick: PartyMatchPick;
  truncated?: boolean;
}): PartyMatchDecision {
  const truncated = Boolean(input.truncated) || input.rows.length > PARTY_MATCH_V2_ROW_CAP;
  const rows = input.rows.slice(0, PARTY_MATCH_V2_ROW_CAP);
  const byId = new Map<string, PartyMatchRow>();
  for (const row of rows) byId.set(`${row.kind}:${row.nativeId}`, row);
  const picked =
    input.pick.pickNativeId && input.pick.kind
      ? (byId.get(`${input.pick.kind}:${input.pick.pickNativeId}`) ?? null)
      : null;
  const suggestions: PartyMatchRow[] = [];
  const addSuggestion = (row: PartyMatchRow | undefined) => {
    if (
      !row ||
      suggestions.some((kept) => kept.kind === row.kind && kept.nativeId === row.nativeId)
    )
      return;
    if (suggestions.length < 3) suggestions.push(row);
  };
  // The model's pick is shown first for review, even when a safety rule blocks the bind.
  addSuggestion(picked ?? undefined);
  for (const id of input.pick.alternatives) {
    const row = rows.find((candidate) => candidate.nativeId === id);
    addSuggestion(row);
  }
  const ranked = rows
    .map((row, index) => ({ row, index, score: rowSuggestionScore(input.candidates, row) }))
    .sort((left, right) => left.score - right.score || left.index - right.index);
  for (const { row } of ranked) addSuggestion(row);

  if (!picked) {
    return {
      matchStatus: 'needs_pick',
      boundParty: null,
      suggestions,
      reason: input.pick.reason || 'No HMS party was selected; choose one of the suggestions.',
    };
  }
  if (input.pick.confidence !== 'high') {
    return {
      matchStatus: 'needs_pick',
      boundParty: null,
      suggestions,
      reason: 'The party match confidence was not high; choose the correct company or agency.',
    };
  }
  if (truncated) {
    return {
      matchStatus: 'needs_pick',
      boundParty: null,
      suggestions,
      reason:
        'HMS returned a truncated list, so another equal match may be missing; choose a suggestion.',
    };
  }

  const claims = input.candidates
    .map((candidate) => ({ candidate, score: partyClaimScore(candidate, picked) }))
    .filter((claim) => claim.score > 0);
  if (!claims.length) {
    return {
      matchStatus: 'needs_pick',
      boundParty: null,
      suggestions,
      reason:
        'The selected HMS row did not contain all distinctive words from an extracted party name.',
    };
  }
  const bestClaimScore = Math.max(...claims.map((claim) => claim.score));
  for (const { candidate, score } of claims) {
    if (score !== bestClaimScore) continue;
    const equalClaims = rows.filter((row) => partyClaimScore(candidate, row) === score);
    if (equalClaims.some((row) => row.nativeId !== picked.nativeId || row.kind !== picked.kind)) {
      return {
        matchStatus: 'needs_pick',
        boundParty: null,
        suggestions,
        reason:
          'More than one HMS row makes an equally strong claim to the party name; choose a suggestion.',
      };
    }
  }
  return {
    matchStatus: 'bound',
    boundParty: picked,
    suggestions: [picked, ...suggestions.filter((row) => row.nativeId !== picked.nativeId)].slice(
      0,
      3,
    ),
    reason:
      input.pick.reason || 'One high-confidence HMS row uniquely matched the extracted party name.',
  };
}
