import {nativePartyUseName, type NativePartyUse, type PolicyKeys} from './history-policy.js';

const aliases = [
  ['MISA', 'Municipal Infrastructure Support Agent'],
  ['IEC', 'Independent Electoral Commission'],
  ['IMERYS', 'Imerys Refractory Minerals SA (Pty) Ltd'],
  ['NWU', 'North West University', 'North West University Potchefstroom'],
  ['SITA', 'State Information Technology Agency', 'State Information Technology Agency - SITA'],
  ['TFG', 'Foschini Retail Group', 'Foschini Retail Group (Pty) Ltd'],
  ['SKA', 'Square Kilometre Array', 'Square Kilometre Array SKA'],
  ['MTPA', 'Mpumalanga Tourism and Parks Agency'],
  ['SAFCOL', 'South African Forestry Company', 'SAFCOL - Gov - Forestry'],
] as const;

export const PARTY_STOPWORDS = new Set([
  'travel', 'travels', 'tours', 'tour', 'agency', 'agent', 'agents', 'company',
  'group', 'stores', 'services', 'service', 'solutions', 'holdings', 'pty', 'ltd', 'limited',
  'south', 'africa', 'african', 'hotel', 'hotels', 'booking', 'bookings',
  'local', 'district', 'metropolitan', 'municipality', 'municipal', 'department',
  'national', 'provincial', 'office', 'the', 'and', 'for', 'of', 'sa',
]);

const legalSuffixes = new Set(['pty', 'ltd', 'limited', 'ptyltd', 'cc', 'inc', 'llc', 'plc', 'proprietary', 'npc', 'rf']);

const partyNameParts = (value:string) => value.toLowerCase().split(/\bt\s*\/\s*a\b/).map(part => {
  const tokens = (part.normalize('NFKD').replace(/\p{M}/gu, '').replace(/&/g, ' and ')
    .match(/[\p{L}\p{N}]+/gu) ?? []).map(token => token.toLowerCase());
  while (tokens.length > 1 && legalSuffixes.has(tokens.at(-1) ?? '')) tokens.pop();
  return tokens.join(' ');
}).filter(Boolean);

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

function aliasPartyName(left:string,right:string,kind:string):boolean {
  const a = normalizePartyName(left), b = normalizePartyName(right);
  return kind === 'organization' && aliases.some(names =>
    names.some(name => normalizePartyName(name) === a) && names.some(name => normalizePartyName(name) === b));
}

function allPartyTokens(value:string):string[] {
  return normalizePartyName(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function bigramSimilarity(left:string,right:string):number {
  if (left === right) return 1;
  const grams=(value:string)=>new Set([...value].slice(1).map((_,i)=>value.slice(i,i+2)));
  const a=grams(left), b=grams(right);
  if (!a.size || !b.size) return 0;
  let overlap=0; for (const gram of a.keys()) if (b.has(gram)) overlap++;
  return 2*overlap/(a.size+b.size);
}

function editSimilarity(left:string,right:string):number {
  const width=left.length+1, height=right.length+1, dist:number[]=Array(width*height).fill(0);
  for(let i=0;i<width;i++) dist[i]=i;
  for(let j=0;j<height;j++) dist[j*width]=j;
  for(let j=1;j<height;j++) for(let i=1;i<width;i++) {
    const cost=left[i-1]===right[j-1]?0:1;
    dist[j*width+i]=Math.min(dist[j*width+i-1]+1,dist[(j-1)*width+i]+1,dist[(j-1)*width+i-1]+cost);
    if(i>1&&j>1&&left[i-1]===right[j-2]&&left[i-2]===right[j-1]) dist[j*width+i]=Math.min(dist[j*width+i],dist[(j-2)*width+i-2]+1);
  }
  return 1-dist[width*height-1]/Math.max(left.length,right.length);
}

function tokenSimilarity(left:string,right:string):number {
  if (left === right) return 1;
  if (left.length >= 5 && right.length >= 5) {
    const similarity=Math.max(bigramSimilarity(left,right),editSimilarity(left,right));
    return similarity >= 0.74 ? similarity : 0;
  }
  return 0;
}

function acronymPartyName(left:string,right:string):boolean {
  const a=normalizePartyName(left), b=normalizePartyName(right);
  const acronym=(one:string,other:string)=>!one.includes(' ') && one.length>=3 && partyAcronym(other)===one;
  return !!a && !!b && (acronym(a,b) || acronym(b,a));
}

/** Exact/legal/alias/acronym party identity. Deliberately stricter than candidate scoring. */
export function partyNameMatch(left:string,right:string,kind:string):boolean {
  const a=normalizePartyName(left), b=normalizePartyName(right);
  return !!a && (a===b || a.replace(/\s/g,'')===b.replace(/\s/g,'') || aliasPartyName(left,right,kind) || acronymPartyName(left,right));
}

/** Deterministic fit for native candidates: exact/distinctive-token cover, with typo-tolerant token matching. */
export function partyCandidateScore(query:string,candidate:string,kind:string):number {
  if (!query.trim()) return 0;
  if (partyNameMatch(query,candidate,kind)) return 100;
  const q=allPartyTokens(query), c=allPartyTokens(candidate);
  if (!q.length || !c.length) return 0;
  const sim=(a:string,b:string)=>tokenSimilarity(a,b);
  const qDistinct=[...new Set(distinctivePartyTokens(query))];
  const cDistinct=[...new Set(distinctivePartyTokens(candidate))];
  const hit=(token:string,pool:string[])=>pool.some(other=>sim(token,other)>0);
  const qDistinctHits=qDistinct.filter(token=>hit(token,c)).length;
  const cDistinctHits=cDistinct.filter(token=>hit(token,q)).length;
  const qHits=q.filter(token=>hit(token,c)).length;
  const qCover=(qDistinct.length?qDistinctHits/qDistinct.length:qHits/q.length);
  const cPrecision=(cDistinct.length?cDistinctHits/cDistinct.length:qHits/c.length);
  const allCover=qHits/q.length;
  return Math.round(45*qCover+45*cPrecision+10*allCover);
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

function messageFromAddress(message: Record<string, unknown>): string | null {
  if (typeof message.from_address === 'string' && message.from_address.trim()) return message.from_address;
  const from = message.from;
  if (typeof from === 'string' && from.trim()) return from;
  if (from && typeof from === 'object' && !Array.isArray(from)) {
    const email = (from as {email?: unknown}).email;
    if (typeof email === 'string' && email.trim()) return email;
  }
  return null;
}

/**
 * Production selected-mail host for Turn-1 client card.
 * Unique `messages[].id === selected_message_id`; never last/head/source_input nested mail.
 * Missing/conflicting id, non-inbound, missing address ⇒ null. Caller fences live/replay.
 */
function selectedInboundSender(mail: unknown) {
  if (!mail || typeof mail !== 'object' || Array.isArray(mail)) return null;
  const root = mail as Record<string, unknown>;
  const selectedId = root.selected_message_id;
  if (typeof selectedId !== 'string' || !selectedId) return null;
  if (!Array.isArray(root.messages)) return null;
  const matches = root.messages.filter((item): item is Record<string, unknown> =>
    !!item && typeof item === 'object' && !Array.isArray(item) && (item as {id?: unknown}).id === selectedId);
  if (matches.length !== 1) return null;
  const selected = matches[0]!;
  if (selected.direction !== 'inbound') return null;
  const fromEmail = messageFromAddress(selected);
  if (!fromEmail) return null;
  const subject = typeof selected.subject === 'string' ? selected.subject : null;
  const body = typeof selected.body_text === 'string' ? selected.body_text
    : typeof selected.body === 'string' ? selected.body : null;
  return {fromEmail, body, subject};
}

export function resolveSelectedSenderHost(mail: unknown): string | null {
  const sender = selectedInboundSender(mail);
  return sender ? effectiveSenderHost(sender.fromEmail, sender.body, sender.subject) : null;
}

export function senderPolicyKeys(fromEmail: string, body?: string | null, subject?: string | null): PolicyKeys {
  return {
    booker_email: isLegacyHotelsHost(senderDomain(fromEmail))
      ? extractForwardedSender(body, subject).innerEmail : fromEmailRe.exec(fromEmail)?.[1] ?? null,
    booker_domain: effectiveSenderHost(fromEmail, body, subject),
  };
}

export function resolveSelectedSenderKeys(mail: unknown): PolicyKeys {
  const sender = selectedInboundSender(mail);
  return sender ? senderPolicyKeys(sender.fromEmail, sender.body, sender.subject) : {};
}

export function explicitPartyQuery(query: string) {
  // An email/domain query asks for the sender's party; a name or acronym is a sourced identity.
  return query && !senderDomain(query) ? query : '';
}

export type PartySearchHistory = {
  sender: PolicyKeys;
  learned: (kind: 'agency' | 'organization') => LearnedSenderHit | null | Promise<LearnedSenderHit | null>;
  organizationUse: () => NativePartyUse | Promise<NativePartyUse>;
};

export async function searchPartyWithFallback(query: string, kind: string,
  search: (term: string) => Promise<Record<string, unknown>>,
  history: () => Promise<LearnedSenderHit | null> | LearnedSenderHit | null) {
  const company = kind === 'organization' || kind === 'agency';
  const explicit = company ? explicitPartyQuery(query) : query;
  const learned = company && !explicit ? await history() : null;
  const requested = explicit || learned?.name || '';
  const terms = requested ? company ? partySearchQueries(requested, kind) : [requested] : [];
  let result: Record<string, unknown> = {outcome: 'no_match', candidates: [], coverage: {possiblyTruncated: false}};
  let bestFit = 0;
  for (const term of terms) {
    const read = await search(term);
    const candidates = Array.isArray(read.candidates) ? read.candidates.filter(row => row && typeof row === 'object' && !Array.isArray(row)) : [];
    const fit = candidates.reduce((best, candidate) => Math.max(best, partyCandidateScore(requested, partyCandidateName(candidate), kind)), 0);
    if (!company || fit >= 82 || (read.outcome !== 'no_match' && !candidates.length)) return {result: read, learned};
    if (fit >= bestFit) { result = read; bestFit = fit; }
  }
  return {result, learned};
}

const partyCandidateName = (candidate: Record<string, unknown>) => String(candidate.displayName ?? candidate.name ?? '');
const partyCandidateId = (candidate: Record<string, unknown>) => String(candidate.nativeId ?? candidate.native_id ?? '');

export async function resolvePartySelection(kind: string, candidates: Array<Record<string, unknown>>, truncated: boolean,
  learned: LearnedSenderHit | null, query: string, organizationUse?: PartySearchHistory['organizationUse']) {
  if (!['organization', 'agency'].includes(kind) || truncated) {
    return {selection: 'none' as const, ambiguity: 'Multiple or incomplete candidates require staff selection.'};
  }
  const requested = explicitPartyQuery(query) || learned?.name || '';
  const groups = new Map<string, {candidates: Array<Record<string, unknown>>; score: number}>();
  for (const candidate of candidates) {
    const name = partyCandidateName(candidate);
    const key = normalizePartyName(name).replace(/\s/g, '');
    const score = partyCandidateScore(requested, name, kind)
      + (normalizePartyName(requested) === normalizePartyName(name) ? 6 : 0);
    const group = groups.get(key) ?? {candidates: [], score: 0};
    group.candidates.push(candidate);
    group.score = Math.max(group.score, score);
    groups.set(key, group);
  }
  const [best, next] = [...groups.values()].sort((a, b) => b.score - a.score);
  if (best && best.score >= 82 && best.score - (next?.score ?? 0) >= 6) {
    if (best.candidates.length === 1) return {selection: best.candidates[0]!, ambiguity: null};
    if (kind === 'organization' && organizationUse) {
      const use = await organizationUse();
      // Prefer per-ID evidence. If the harvest only has names, use counts only
      // when each exact display spelling identifies one candidate.
      const candidates = best.candidates;
      const names = candidates.map(candidate => nativePartyUseName(partyCandidateName(candidate)));
      const hasIds = candidates.some(candidate => Object.hasOwn(use.ids ?? {}, partyCandidateId(candidate)));
      const ranked = candidates.map((selection, i) => ({selection, stays: hasIds
        ? use.ids?.[partyCandidateId(selection)] ?? 0
        : names.indexOf(names[i]!) === names.lastIndexOf(names[i]!) ? use.names?.[names[i]!] ?? 0 : 0
      })).sort((a, b) => b.stays - a.stays);
      if (ranked[0]!.stays > ranked[1]!.stays) return {selection: ranked[0]!.selection, ambiguity: null};
    }
    return {selection: 'none' as const, ambiguity: 'Duplicate native records share the best party name; name may be used without an ID.'};
  }
  return {selection: 'none' as const, ambiguity: 'No single native candidate fits the requested party.'};
}
