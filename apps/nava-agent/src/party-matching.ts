const aliases = [
  ['MISA', 'Municipal Infrastructure Support Agent'],
  ['IEC', 'Independent Electoral Commission'],
  ['IMERYS', 'Imerys Refractory Minerals SA (Pty) Ltd'],
] as const;

export const normalizePartyName = (value:string) => value.trim().replace(/\s+/g,' ').toLowerCase();

export function partySearchQueries(name:string, kind:string):string[] {
  const normalized=normalizePartyName(name);
  const group=kind==='organization' ? aliases.find(names=>names.some(item=>normalizePartyName(item)===normalized)) : undefined;
  return group ? [name,...group.filter(item=>normalizePartyName(item)!==normalized)] : [name];
}

export function samePartyName(left:string,right:string,kind:string):boolean {
  return partySearchQueries(left,kind).some(item=>normalizePartyName(item)===normalizePartyName(right));
}
