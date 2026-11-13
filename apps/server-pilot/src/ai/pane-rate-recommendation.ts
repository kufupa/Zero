import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DB } from '../db/client.js';
import type { RateContext } from './hms-availability.js';
import { loadStaffRatePicks, type LoggedStaffRatePick } from './staff-rate-pick-history.js';

type Frequency = { confirmationCount: number; codes: Record<string, number> };
type Aggregate = { propertyCode: string; countingUnit: 'distinct_observed_confirmations'; full: Frequency; email: Frequency };
export type PaneRateHistory = {
  email: Record<string, number>; full: Record<string, number>; boundParty: Record<string, number>;
  digest: string | null; asOf: string | null; issues: string[];
};
const cache = new Map<string, { stamp: string; value: Promise<{ aggregate: Aggregate; digest: string; asOf: string | null }> }>();

/** Exact native IDs for every selected party, distinct prepared quotes, actual native codes only. */
function boundPartyCounts(context: RateContext, picks: LoggedStaffRatePick[], cutoff: number): Record<string, number> {
  if (!context.agencyId && !context.organizationId) return {};
  const codes = new Map<string, Set<string>>();
  for (const pick of picks) {
    if (!(pick.at instanceof Date) || !Number.isFinite(pick.at.getTime()) || pick.at.getTime() >= cutoff ||
        pick.property !== context.propertyCode || !pick.preparationId ||
        (pick.partyRef?.agencyNativeId ?? null) !== context.agencyId ||
        (pick.partyRef?.companyNativeId ?? null) !== context.organizationId) continue;
    for (const code of pick.nativeRateCodes ?? []) {
      const ids = codes.get(code) ?? new Set<string>(); ids.add(pick.preparationId); codes.set(code, ids);
    }
  }
  return Object.fromEntries([...codes].map(([code, ids]) => [code, ids.size]));
}

/** Existing private snapshot/env inputs; missing memory never prevents native rate reads. */
export async function loadPaneRateHistory(context: RateContext, db?: DB, arrivedAt?: string | Date | null): Promise<PaneRateHistory> {
  const history: PaneRateHistory = { email: {}, full: {}, boundParty: {}, digest: null, asOf: null, issues: [] };
  if (context.propertyCode !== 'HRCEN') return history;
  const cutoff = arrivedAt instanceof Date ? arrivedAt.getTime() : typeof arrivedAt === 'string' ? Date.parse(arrivedAt) : NaN;
  if (!Number.isFinite(cutoff)) {
    history.issues.push('RATE_MEMORY_CUTOFF_UNAVAILABLE');
    return history;
  }
  const path = process.env.HMS_MEMORY_PMS_PATH || join(process.env.HMS_MEMORY_DATA_DIR ||
    '/home/orca/.local/share/zero/research/halloween/raw-data', 'stay360-1a-1b-1c-20261029-run01.json');
  try {
    const file = await stat(path), stamp = `${file.mtimeMs}:${file.size}`;
    let entry = cache.get(path);
    if (!entry || entry.stamp !== stamp) {
      const value = (async () => {
        const bytes = await readFile(path, 'utf8');
        const snapshot = JSON.parse(bytes) as { startedAt?: string; updatedAt?: string };
        const moduleUrl = new URL('../../tooling/hms-cloud/hms-booking-memory.mjs', import.meta.url);
        const memory = await import(moduleUrl.href) as { buildHmsRateFrequency: (input: { propertyCode: string; pmsSnapshots: unknown[] }) => Aggregate };
        const times = [snapshot.startedAt, snapshot.updatedAt].filter((value): value is string => Boolean(value));
        const captured = times.length && times.every(value => Number.isFinite(Date.parse(value)))
          ? Math.max(...times.map(value => Date.parse(value))) : NaN;
        return { aggregate: memory.buildHmsRateFrequency({ propertyCode: context.propertyCode, pmsSnapshots: [snapshot] }),
          digest: createHash('sha256').update(bytes).digest('hex'),
          asOf: Number.isFinite(captured) ? new Date(captured).toISOString() : null };
      })();
      entry = { stamp, value }; cache.set(path, entry);
    }
    const loaded = await entry.value;
    if (!loaded.asOf) history.issues.push('RATE_MEMORY_TIME_UNAVAILABLE');
    else if (Date.parse(loaded.asOf) >= cutoff) history.issues.push('RATE_MEMORY_AFTER_MESSAGE');
    else {
      history.email = loaded.aggregate.email.codes; history.full = loaded.aggregate.full.codes;
      history.digest = loaded.digest; history.asOf = loaded.asOf;
    }
  } catch (error) {
    cache.delete(path);
    const code = (error as NodeJS.ErrnoException)?.code;
    history.issues.push(['ENOENT', 'EACCES', 'ENOTDIR'].includes(code ?? '') ? 'RATE_MEMORY_FILES_UNAVAILABLE' : 'RATE_MEMORY_INVALID');
  }
  if (db && (context.agencyId || context.organizationId)) {
    try { history.boundParty = boundPartyCounts(context, await loadStaffRatePicks(db, context.propertyCode), cutoff); }
    catch { history.issues.push('PREPARED_PARTY_RATE_HISTORY_UNAVAILABLE'); }
  }
  if ((context.agencyId || context.organizationId) && Object.keys(history.boundParty).length === 0) {
    // The PMS corpus retains historical party labels, not current native IDs. Do not join it by name.
    history.issues.push('NO_NATIVE_ID_BOUND_RATE_HISTORY');
  }
  return history;
}
