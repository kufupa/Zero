import {exactHistoryKey} from './history-policy.js';

export type NativePartyUse = {ids?: Record<string, number>; names?: Record<string, number>};
export const nativePartyUseName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** Order duplicate native organizations by prior stays, never by sender affinity. */
export function indexOrganizationUse(history: Iterable<Record<string, unknown>>) {
  const ids = new Map<string, number[]>();
  const names = new Map<string, number[]>();
  const seen = new Set<string>();
  const add = (map: Map<string, number[]>, key: string, at: number) => {
    if (!key) return;
    const dates = map.get(key) ?? [];
    dates.push(at);
    map.set(key, dates);
  };
  for (const row of history) {
    const at = Date.parse(String(row.created_at ?? ''));
    const conf = String(row.conf ?? '').trim();
    if (!conf || seen.has(conf) || !Number.isFinite(at) || /labtest|proof/i.test(String(row.guest_name ?? ''))
      || exactHistoryKey(row.created_by) === 'navaai') continue;
    seen.add(conf);
    add(ids, String(row.companyid ?? row.organization_id ?? '').trim(), at);
    add(names, nativePartyUseName(String(row.company ?? '')), at);
  }
  for (const dates of [...ids.values(), ...names.values()]) dates.sort((a, b) => a - b);
  const counts = (map: Map<string, number[]>, cutoff: number): Record<string, number> => Object.fromEntries(
    Array.from(map).flatMap(([key, dates]) => {
      let lo = 0, hi = dates.length;
      while (lo < hi) {
        const i = (lo + hi) >>> 1;
        if (dates[i]! < cutoff) lo = i + 1;
        else hi = i;
      }
      return lo ? [[key, lo]] : [];
    }),
  );
  return (cutoff: number): NativePartyUse => ({ids: counts(ids, cutoff), names: counts(names, cutoff)});
}
