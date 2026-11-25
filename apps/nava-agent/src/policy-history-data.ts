import {exactHistoryKey, HISTORY_FIELDS, historyRowKey, nativePartyUseName, policyKeys, type NativePartyUse} from './history-policy.js';

type Row = Record<string, unknown>;
const jsonl = (source: string) => source.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as Row);

/** Observation dates for replay and prior stay counts for duplicate native organizations. Does not infer defaults. */
export function indexPolicyHistory(history: string, mail = '') {
  const mailByStay = new Map(jsonl(mail).filter(row => row.has_pre_create_request !== false).map(row => [
    String(row.conf ?? row.confirmation ?? ''), row,
  ]));
  const latest = new Map<string, Map<string, number>>();
  const ids = new Map<string, number[]>();
  const names = new Map<string, number[]>();
  const seen = new Set<string>();
  const add = (map: Map<string, number[]>, key: string, at: number) => {
    if (!key) return;
    const dates = map.get(key) ?? [];
    dates.push(at);
    map.set(key, dates);
  };
  for (const row of jsonl(history)) {
    const at = Date.parse(String(row.created_at ?? ''));
    const conf = String(row.conf ?? '').trim();
    if (!conf || seen.has(conf) || !Number.isFinite(at) || /labtest|proof/i.test(String(row.guest_name ?? ''))
      || exactHistoryKey(row.created_by) === 'navaai') continue;
    seen.add(conf);
    const linked = mailByStay.get(conf);
    const booker_email = exactHistoryKey(linked?.booker_email ?? row.booker_email);
    const booker_domain = exactHistoryKey(linked?.booker_domain ?? row.booker_domain) || booker_email.split('@')[1];
    for (const [type, key] of policyKeys({booker_email, booker_domain, company: exactHistoryKey(row.company), ta1: exactHistoryKey(row.ta1)})) {
      const token = historyRowKey(type, key);
      const fields = latest.get(token) ?? new Map<string, number>();
      latest.set(token, fields);
      for (const field of Object.keys(HISTORY_FIELDS)) {
        if (row[field] != null && at > (fields.get(field) ?? -Infinity)) fields.set(field, at);
      }
    }
    add(ids, String(row.companyid ?? row.organization_id ?? '').trim(), at);
    add(names, nativePartyUseName(String(row.company ?? '')), at);
  }
  for (const dates of [...ids.values(), ...names.values()]) dates.sort((a, b) => a - b);
  const counts = (map: Map<string, number[]>, cutoff: number): Record<string, number> => Object.fromEntries(
    Array.from(map, ([key, dates]) => {
      let lo = 0, hi = dates.length;
      while (lo < hi) {
        const i = (lo + hi) >>> 1;
        if (dates[i]! < cutoff) lo = i + 1;
        else hi = i;
      }
      return [key, lo];
    }),
  );
  return {latest, organizationUse(cutoff: number): NativePartyUse {
    return {ids: counts(ids, cutoff), names: counts(names, cutoff)};
  }};
}
