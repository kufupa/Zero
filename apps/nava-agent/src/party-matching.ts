const aliases = [
  ['MISA', 'Municipal Infrastructure Support Agent'],
  ['IEC', 'Independent Electoral Commission'],
  ['IMERYS', 'Imerys Refractory Minerals SA (Pty) Ltd'],
] as const;

export const PARTY_STOPWORDS = new Set([
  'travel', 'travels', 'tours', 'tour', 'agency', 'agent', 'agents', 'company',
  'group', 'stores', 'services', 'service', 'solutions', 'holdings', 'pty', 'ltd', 'limited',
  'south', 'africa', 'african', 'hotel', 'hotels', 'booking', 'bookings',
  'local', 'district', 'metropolitan', 'municipality', 'municipal', 'department',
  'national', 'provincial', 'office', 'the', 'and', 'for', 'of', 'sa',
]);

const partyNameParts = (value:string) => value.toLowerCase().split(/\bt\s*\/\s*a\b/).map(part =>
  part.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    .replace(/(?:\s+(?:pty|ltd|limited|cc))+$/, ''),
).filter(Boolean);

export const normalizePartyName = (value:string) => partyNameParts(value).join(' ');

export function partyAcronym(value:string):string {
  return value.split(/[^a-z0-9]+/i).filter(Boolean).map(part=>part[0]??'').join('').toLowerCase();
}

export function distinctivePartyTokens(value:string):string[] {
  return normalizePartyName(value).split(/[^a-z0-9]+/).filter(token=>token.length>=3 && !PARTY_STOPWORDS.has(token));
}

export function partySearchQueries(name:string, kind:string):string[] {
  const normalized=normalizePartyName(name);
  const group=kind==='organization' ? aliases.find(names=>names.some(item=>normalizePartyName(item)===normalized)) : undefined;
  const out=[name, normalized, ...partyNameParts(name), ...(group ?? [])];
  const acr=partyAcronym(name);
  if(kind==='organization' && acr.length>=3 && acr.length<=6 && name.trim().includes(' ')) out.push(acr.toUpperCase());
  const tokens = [...new Set(distinctivePartyTokens(name))].sort((a,b) => b.length-a.length);
  return [...new Set([...out, ...tokens.slice(0, 2)].filter(Boolean))];
}

function samePartyName(left:string,right:string,kind:string):boolean {
  const a = normalizePartyName(left), b = normalizePartyName(right);
  return !!a && (a === b || kind === 'organization' && aliases.some(names =>
    names.some(name => normalizePartyName(name) === a) && names.some(name => normalizePartyName(name) === b)));
}

export type LearnedSenderHit = { host: string; kind: 'agency' | 'organization'; name: string; nativeId: string | null; support: number };

function senderDomain(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const address = (/<([^<>]+)>$/.exec(value.trim())?.[1] ?? value).trim().toLowerCase();
  return /^(?:[^@\s<>]+@)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\.?$/.exec(address)?.[1];
}

function isLegacyHotelsHost(host: string | null | undefined): boolean {
  return !!host && /(?:^|\.)legacyhotels?\.(?:com|co\.za)$/.test(host);
}

function candidateMatchesLearned(candidate: Record<string, unknown>, learned: LearnedSenderHit): boolean {
  if (learned.nativeId && String(candidate.nativeId ?? candidate.native_id ?? '') === learned.nativeId) return true;
  const name = String(candidate.displayName ?? candidate.name ?? '');
  if (normalizePartyName(name) === normalizePartyName(learned.name)) return true;
  const learnedTokens = new Set(distinctivePartyTokens(learned.name));
  return distinctivePartyTokens(name).some(token => learnedTokens.has(token));
}

function learnedCandidateHits(candidates: Array<Record<string, unknown>>, learned: LearnedSenderHit) {
  return candidates.filter(candidate => candidateMatchesLearned(candidate, learned));
}

/** Prefer sender_host; else email/domain query. Skip freemail + owned-hotel hosts. */
export function extractSenderHost(senderHost: unknown, query: string): string | null {
  const host = senderDomain(senderHost) ?? senderDomain(query);
  return !host || /(?:^|\.)(?:(?:gmail|googlemail|outlook|icloud|live|msn|me|aol|protonmail|mail)\.com|(?:yahoo|hotmail)\.(?:com|co\.uk|fr|de|co\.za)|proton\.me|gmx\.(?:com|de|net)|yandex\.(?:com|ru)|(?:mweb|webmail)\.co\.za|telkomsa\.net|legacyhotels?\.(?:com|co\.za))$/.test(host) ? null : host;
}

const forwardHeaderRe = /(?:^|\n)[ \t]*(?:>[ \t]*)*(?:-{2,}[ \t]*(?:Original Message|Forwarded message)[ \t]*-{2,}[ \t]*\r?\n[ \t]*(?:>[ \t]*)*)?\*?From:\*?[ \t]*([^\r\n]+)/im;
const fromEmailRe = /<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i;

/** Outlook/Gmail forward: first non-hotel, non-freemail inner From + top staff instruction. */
export function extractForwardedSender(body: string | null | undefined, subject?: string | null): {
  innerEmail: string | null; innerHost: string | null; staffInstruction: string | null;
} {
  const text = typeof body === 'string' ? body : '';
  const subj = typeof subject === 'string' ? subject : '';
  const isForward = /^(?:fw|fwd):/i.test(subj.trimStart())
    || /(?:Forwarded message|Original Message)/i.test(text)
    || /(?:^|\n)[ \t]*(?:>[ \t]*)*\*?From:\*?[ \t]*[^\r\n]+\r?\n(?:[ \t]*\r?\n)*[ \t]*(?:>[ \t]*)*\*?Sent:\*?/im.test(text);
  if (!isForward || !text) return { innerEmail: null, innerHost: null, staffInstruction: null };

  const match = forwardHeaderRe.exec(text);
  if (!match) return { innerEmail: null, innerHost: null, staffInstruction: null };

  const fromLine = match[1] ?? '';
  const emailMatch = fromEmailRe.exec(fromLine);
  const innerEmail = emailMatch?.[1]?.toLowerCase() ?? null;
  const innerHost = innerEmail ? extractSenderHost(innerEmail, '') : null;
  const usableEmail = innerHost ? innerEmail : null;

  const head = text.slice(0, match.index).replace(/^\s+|\s+$/g, '');
  const staffInstruction = head
    ? head.replace(/\s+/g, ' ').trim().slice(0, 200) || null
    : null;
  return { innerEmail: usableEmail, innerHost, staffInstruction };
}

/** Prefer outer business host; legacyhotels staff forward → inner client host. */
export function effectiveSenderHost(
  senderEmail: unknown, body?: string | null, subject?: string | null, query?: string,
): string | null {
  const preferred = extractSenderHost(senderEmail, '');
  if (preferred) return preferred;
  const outer = senderDomain(senderEmail);
  if (isLegacyHotelsHost(outer)) {
    const inner = extractForwardedSender(body, subject).innerHost;
    if (inner) return inner;
  }
  return extractSenderHost('', query ?? '');
}

export async function searchPartyWithFallback(query: string, kind: string,
  search: (term: string) => Promise<Record<string, unknown>>,
  history: () => Promise<LearnedSenderHit | null>) {
  const company = kind === 'organization' || kind === 'agency';
  const learned = company ? await history() : null;
  const preferred = learned && (!query || samePartyName(query, learned.name, kind)) ? learned : null;
  const queries = query ? company ? partySearchQueries(query, kind) : [query] : [];
  const terms = [...new Set([
    ...(preferred ? [preferred.name] : []), ...queries,
    ...(learned && !preferred ? [learned.name] : []),
  ])];
  const coverage = {possiblyTruncated: false};
  let result: Record<string, unknown> = {outcome: 'no_match', candidates: [], coverage};
  for (const term of terms) {
    result = await search(term);
    if (result.outcome !== 'no_match' || Array.isArray(result.candidates) && result.candidates.length ||
        !(typeof result.coverage === 'object' && result.coverage !== null &&
          'possiblyTruncated' in result.coverage && result.coverage.possiblyTruncated === false)) {
      return {result, learned: preferred ?? (learned?.name === term ? learned : null)};
    }
  }
  return {result, learned};
}

export function resolvePartySelection(kind: string, candidates: Array<Record<string, unknown>>, truncated: boolean, learned: LearnedSenderHit | null, query: string) {
  const ok = ['organization', 'agency'].includes(kind) && !truncated;
  if (ok && candidates.length > 1 && learned) {
    const hit = learnedCandidateHits(candidates, learned);
    if (hit.length === 1) return { selection: hit[0]!, ambiguity: null as string | null };
  }
  if (ok && candidates.length === 1) {
    const only = candidates[0]!;
    if (learned && !candidateMatchesLearned(only, learned) && query && !samePartyName(query, learned.name, kind)) {
      // Unique HMS hit, but learned party is a different specific name and query disagrees.
      return { selection: 'none' as const, ambiguity: 'Sender history suggests a different party; staff selection is required.' };
    }
    return { selection: only, ambiguity: null as string | null };
  }
  if (learned && query && !samePartyName(query, learned.name, kind)) {
    const hit = learned ? learnedCandidateHits(candidates, learned) : [];
    if (hit.length === 0) {
      return { selection: 'none' as const, ambiguity: 'Sender history suggests a different party; staff selection is required.' };
    }
  }
  return { selection: 'none' as const, ambiguity: 'Multiple or incomplete candidates require staff selection.' };
}
