export type PartyKind = 'organization' | 'agency';
export type NativePartyUse = Partial<Record<PartyKind, Record<string, number>>>;
export type PartyUseHistory = Record<PartyKind, Record<string, number[]>>;

/** Only HMS reservation observations with a native party ID can break a tie. */
export function indexPartyUse(history: Iterable<Record<string, unknown>>): PartyUseHistory {
  const timelines = {organization: new Map<string, number[]>(), agency: new Map<string, number[]>()};
  const seen = new Set<string>();
  for (const row of history) {
    const created = Date.parse(String(row.created_at ?? ''));
    const updated = Date.parse(String(row.updated_at ?? ''));
    const at = Number.isFinite(updated) ? Math.max(created, updated) : created;
    const conf = String(row.conf ?? '').trim();
    if (!conf || seen.has(conf) || !Number.isFinite(at) || /labtest|proof/i.test(String(row.guest_name ?? ''))
      || /\bnavaai\b/i.test(String(row.created_by ?? ''))) continue;
    seen.add(conf);
    for (const [kind, field] of [['organization', 'organization_id'], ['agency', 'agency_id']] as const) {
      const id = String(row[field] ?? '').trim();
      if (!id) continue;
      const dates = timelines[kind].get(id) ?? [];
      dates.push(at);
      timelines[kind].set(id, dates);
    }
  }
  return {
    organization: Object.fromEntries([...timelines.organization].map(([id, dates]) => [id, dates.sort((a, b) => a - b)])),
    agency: Object.fromEntries([...timelines.agency].map(([id, dates]) => [id, dates.sort((a, b) => a - b)])),
  };
}

export function partyUseBefore(history: PartyUseHistory, cutoff: number): NativePartyUse {
  const count = (dates: number[]) => {
    let lo = 0, hi = dates.length;
    while (lo < hi) {
      const i = (lo + hi) >>> 1;
      if (dates[i]! < cutoff) lo = i + 1;
      else hi = i;
    }
    return lo;
  };
  return {
    organization: Object.fromEntries(Object.entries(history.organization ?? {}).map(([key, dates]) => [key, count(dates)])),
    agency: Object.fromEntries(Object.entries(history.agency ?? {}).map(([key, dates]) => [key, count(dates)])),
  };
}
