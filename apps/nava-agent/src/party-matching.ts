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

/** Prefer sender_host; else email/domain query. Skip freemail + owned-hotel hosts. */
export function extractSenderHost(senderHost: unknown, query: string): string | null {
  const host = senderDomain(senderHost) ?? senderDomain(query);
  return !host || /(?:^|\.)(?:(?:gmail|googlemail|outlook|icloud|live|msn|me|aol|protonmail|mail)\.com|(?:yahoo|hotmail)\.(?:com|co\.uk|fr|de|co\.za)|proton\.me|gmx\.(?:com|de|net)|yandex\.(?:com|ru)|(?:mweb|webmail)\.co\.za|telkomsa\.net|legacyhotels?\.(?:com|co\.za))$/.test(host) ? null : host;
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
  if (learned && query && !samePartyName(query, learned.name, kind)) {
    return {selection: 'none' as const, ambiguity: 'Sender history suggests a different party; staff selection is required.'};
  }
  const ok = ['organization', 'agency'].includes(kind) && !truncated;
  if (ok && candidates.length === 1) return { selection: candidates[0]!, ambiguity: null as string | null };
  if (ok && candidates.length > 1 && learned) {
    const hit = candidates.filter(c => (learned.nativeId && String(c.nativeId ?? c.native_id ?? '') === learned.nativeId)
      || normalizePartyName(String(c.displayName ?? c.name ?? '')) === normalizePartyName(learned.name));
    if (hit.length === 1) return { selection: hit[0]!, ambiguity: null };
  }
  return { selection: 'none' as const, ambiguity: 'Multiple or incomplete candidates require staff selection.' };
}
