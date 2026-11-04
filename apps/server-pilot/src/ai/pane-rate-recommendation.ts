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
function boundPartyCounts(context: RateContext, picks: LoggedStaffRatePick[]): Record<string, number> {
  if (!context.agencyId && !context.organizationId) return {};
  const codes = new Map<string, Set<string>>();
  for (const pick of picks) {
    if (pick.property !== context.propertyCode || !pick.preparationId ||
        (pick.partyRef?.agencyNativeId ?? null) !== context.agencyId ||
        (pick.partyRef?.companyNativeId ?? null) !== context.organizationId) continue;
    for (const code of pick.nativeRateCodes ?? []) {
      const ids = codes.get(code) ?? new Set<string>(); ids.add(pick.preparationId); codes.set(code, ids);
    }
  }
  return Object.fromEntries([...codes].map(([code, ids]) => [code, ids.size]));
}

/** Existing private snapshot/env inputs; missing memory never prevents native rate reads. */
export async function loadPaneRateHistory(context: RateContext, db?: DB): Promise<PaneRateHistory> {
  const history: PaneRateHistory = { email: {}, full: {}, boundParty: {}, digest: null, asOf: null, issues: [] };
  if (context.propertyCode !== 'HRCEN') return history;
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
        const time = snapshot.updatedAt ?? snapshot.startedAt;
        return { aggregate: memory.buildHmsRateFrequency({ propertyCode: context.propertyCode, pmsSnapshots: [snapshot] }),
          digest: createHash('sha256').update(bytes).digest('hex'),
          asOf: time && Number.isFinite(Date.parse(time)) ? new Date(time).toISOString() : null };
      })();
      entry = { stamp, value }; cache.set(path, entry);
    }
    const loaded = await entry.value;
    history.email = loaded.aggregate.email.codes; history.full = loaded.aggregate.full.codes;
    history.digest = loaded.digest; history.asOf = loaded.asOf;
  } catch (error) {
    cache.delete(path);
    const code = (error as NodeJS.ErrnoException)?.code;
    history.issues.push(['ENOENT', 'EACCES', 'ENOTDIR'].includes(code ?? '') ? 'RATE_MEMORY_FILES_UNAVAILABLE' : 'RATE_MEMORY_INVALID');
  }
  if (db && (context.agencyId || context.organizationId)) {
    try { history.boundParty = boundPartyCounts(context, await loadStaffRatePicks(db, context.propertyCode)); }
    catch { history.issues.push('PREPARED_PARTY_RATE_HISTORY_UNAVAILABLE'); }
  }
  if ((context.agencyId || context.organizationId) && Object.keys(history.boundParty).length === 0) {
    // The PMS corpus retains historical party labels, not current native IDs. Do not join it by name.
    history.issues.push('NO_NATIVE_ID_BOUND_RATE_HISTORY');
  }
  return history;
}
