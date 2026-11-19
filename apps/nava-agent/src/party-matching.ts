const aliases = [
  ['MISA', 'Municipal Infrastructure Support Agent'],
  ['IEC', 'Independent Electoral Commission'],
  ['IMERYS', 'Imerys Refractory Minerals SA (Pty) Ltd'],
] as const;

export const PARTY_STOPWORDS = new Set([
  'travel', 'travels', 'tours', 'tour', 'agency', 'agent', 'agents', 'company',
  'group', 'services', 'service', 'solutions', 'holdings', 'pty', 'ltd', 'limited',
  'south', 'africa', 'african', 'hotel', 'hotels', 'booking', 'bookings',
  'local', 'district', 'metropolitan', 'municipality', 'municipal', 'department',
  'national', 'provincial', 'office', 'the', 'and', 'for', 'of', 'sa',
]);

export const normalizePartyName = (value:string) => value.trim().replace(/\s+/g,' ').toLowerCase();

export function partyAcronym(value:string):string {
  return value.split(/[^a-z0-9]+/i).filter(Boolean).map(part=>part[0]??'').join('').toLowerCase();
}

export function distinctivePartyTokens(value:string):string[] {
  return normalizePartyName(value).split(/[^a-z0-9]+/).filter(token=>token.length>=3 && !PARTY_STOPWORDS.has(token));
}

export function partySearchQueries(name:string, kind:string):string[] {
  const normalized=normalizePartyName(name);
  const group=kind==='organization' ? aliases.find(names=>names.some(item=>normalizePartyName(item)===normalized)) : undefined;
  const out=[name,...(group ? group.filter(item=>normalizePartyName(item)!==normalized) : [])];
  const acr=partyAcronym(name);
  if(kind==='organization' && acr.length>=3 && acr.length<=6 && name.trim().includes(' ')) out.push(acr.toUpperCase());
  const distinctive=distinctivePartyTokens(name);
  if(distinctive.length===1 && distinctive[0] && distinctive[0]!==normalized) out.push(distinctive[0]);
  return [...new Set(out)];
}

export function samePartyName(left:string,right:string,kind:string):boolean {
  return partySearchQueries(left,kind).some(item=>normalizePartyName(item)===normalizePartyName(right));
}
