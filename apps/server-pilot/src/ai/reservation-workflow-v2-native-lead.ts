import { CENTURION_HMS_READ_TARGET, type HmsReadTarget } from '../hms/hms-read-target.js';
import { quoteRateContextEnabled } from './quote-rate-switch.js';

export type NativeLeadKind = 'guest' | 'organization' | 'agency' | 'ar_account';
export type NativeLeadVerification = {
  outcome: 'matched' | 'not_found' | 'incomplete' | 'failed' | 'refused';
  match: Record<string, unknown> | null;
  candidates: Record<string, unknown>[];
  rowVerification: { status: 'verified' | 'unverified'; method: 'response_grid_correlation'; verifiedFields: string[] };
  coverage: { complete: boolean; native: Record<string, unknown> | null; returned: number;
    inspectedMatched: number | null; closeOutcome: string | null };
  issue?: string;
};

const specs = {
  guest: { tool: 'searchGuestProfiles', id: 'guestid', names: ['firstname', 'lastname'], field: 'profileId' },
  organization: { tool: 'searchOrganization', id: 'companyid', names: ['companyname'], field: 'Organization ID' },
  agency: { tool: 'searchPrimaryBookingAgency', id: 'travelagencyid', names: ['travelagencyname'], field: 'Booking Agency Name' },
  ar_account: { tool: 'searchArAccount', id: 'araccountid', names: ['araccountname'], field: 'A/R Account' },
} as const;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const scalar = (value: unknown): string | null => value == null ? null : String(value).trim() || null;

function empty(outcome: NativeLeadVerification['outcome'], issue: string): NativeLeadVerification {
  return { outcome, match: null, candidates: [], issue,
    rowVerification: { status: 'unverified', method: 'response_grid_correlation', verifiedFields: [] },
    coverage: { complete: false, native: null, returned: 0, inspectedMatched: null, closeOutcome: null } };
}

/** Verify a staff-requested native ID without selecting it. Caller owns transport authority and property locking. */
export async function verifyNativeLead(input: { kind: NativeLeadKind; nativeId: string; name?: string;
  target: HmsReadTarget; signal?: AbortSignal }): Promise<NativeLeadVerification> {
  const { kind, nativeId, target, signal } = input;
  signal?.throwIfAborted();
  if (!Object.hasOwn(specs, kind) || typeof nativeId !== 'string' || !/^\d{1,30}$/.test(nativeId))
    return empty('refused', 'native_lead_input_invalid');
  const expected = CENTURION_HMS_READ_TARGET;
  if (!target || (['propertyCode', 'secretId', 'browserSlot', 'origin', 'installationEnvName'] as const)
    .some(key => target[key] !== expected[key])) return empty('refused', 'native_lead_target_unsupported');
  if (kind !== 'guest' && !quoteRateContextEnabled()) return empty('refused', 'refused_flag_off');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if ((kind === 'agency' || kind === 'ar_account') && (!name || name.length > 200 || /[\r\n]/.test(name)))
    return empty('refused', 'native_lead_name_required');
  const query = kind === 'agency' || kind === 'ar_account' ? name : nativeId;
  try {
    const session = await import(new URL('../../tooling/hms-cloud/booking-lookup-session.mjs', import.meta.url).href) as {
      withBookingLookupSession<T>(operation: (context: { runTool: (input: Record<string, unknown>) => Promise<Record<string, unknown>> }) => Promise<T>,
        options: Record<string, unknown>): Promise<T> };
    signal?.throwIfAborted();
    const result = await session.withBookingLookupSession<NativeLeadVerification>(async ({ runTool }) => {
      signal?.throwIfAborted();
      const spec = specs[kind];
      const found = await runTool(kind === 'guest' ? { tool: spec.tool, field: 'profileId', query }
        : { tool: spec.tool, query, ...(kind === 'organization' ? { options: { field: 'nativeId' } } : {}) });
      signal?.throwIfAborted();
      const searchCoverage = record(found.coverage), criteria = record(found.criteria), correlation = record(found.correlation);
      const verifiedFields = Array.isArray(correlation?.verifiedFields)
        ? correlation.verifiedFields.filter((field): field is string => typeof field === 'string') : [];
      const searchId = text(found.searchId);
      const rows = Array.isArray(found.candidates) ? found.candidates : [];
      const searchValid = ['matches', 'no_match'].includes(String(found.outcome)) && Boolean(searchId) &&
        criteria?.field === spec.field && criteria.query === query && Array.isArray(found.candidates);
      let selectedRows = rows, inspectedMatched: number | null = null, inspectionValid = kind !== 'guest';
      if (kind === 'guest' && searchValid) {
        const inspected = await runTool({ tool: 'inspectGuestProfileCandidates', searchId, nativeId, offset: 0, limit: 2 });
        signal?.throwIfAborted();
        const inspectCriteria = record(inspected.criteria), inspectCoverage = record(inspected.coverage);
        const matched = inspected.matched, returned = inspected.returned;
        inspectionValid = inspected.outcome === 'current' && inspected.searchId === searchId &&
          inspectCriteria?.field === 'profileId' && inspectCriteria.query === query &&
          JSON.stringify(inspectCoverage) === JSON.stringify(searchCoverage) && inspected.offset === 0 &&
          typeof matched === 'number' && Number.isInteger(matched) && matched >= 0 &&
          returned === Math.min(2, matched) && inspected.hasMoreLoaded === (matched > 2) &&
          Array.isArray(inspected.candidates) && inspected.candidates.length === returned;
        if (inspectionValid) { selectedRows = inspected.candidates as unknown[]; inspectedMatched = matched as number; }
        else selectedRows = [];
      }
      signal?.throwIfAborted();
      const closed = await runTool(kind === 'guest' ? { tool: 'closeGuestProfilePicker' }
        : { tool: 'closeGuestStayPartyPicker', propertyCode: target.propertyCode });
      signal?.throwIfAborted();
      const closeOutcome = text(closed.outcome), fieldsVerified = [spec.id, ...spec.names].every(field => verifiedFields.includes(field));
      const candidates = selectedRows.flatMap(value => {
        const row = record(value), response = record(row?.responseData), grid = record(row?.gridData);
        if (!row || !response || !grid || !fieldsVerified || !text(row.nativeId) || !/^\d{1,30}$/.test(String(row.nativeId)) ||
            [spec.id, ...spec.names].some(field => !scalar(response[field]) || scalar(response[field]) !== scalar(grid[field])) ||
            scalar(response[spec.id]) !== row.nativeId) return [];
        if (kind === 'guest') {
          if (text(row.firstName) !== scalar(response.firstname) || text(row.lastName) !== scalar(response.lastname)) return [];
          const candidate: Record<string, unknown> = { nativeId: row.nativeId, firstName: row.firstName, lastName: row.lastName };
          for (const [key, field] of [['email', 'emailaddress'], ['phoneNumber', 'phonenumber'], ['city', 'city'], ['country', 'country']] as const)
            if (verifiedFields.includes(field) && scalar(response[field]) === scalar(grid[field]) && text(row[key])) candidate[key] = row[key];
          return [candidate];
        }
        if (text(row.name) !== scalar(response[spec.names[0]])) return [];
        const candidate: Record<string, unknown> = { nativeId: row.nativeId, name: row.name };
        for (const [key, field] of [['address', 'address'], ['city', 'city'], ['country', 'country'],
          ['corporateAccountNumber', 'corporateaccountnumber'], ['accountNumber', 'araccountnumber'],
          ['status', 'arstatuscodedesc'], ['accountType', 'accttype']] as const)
          if (verifiedFields.includes(field) && scalar(response[field]) === scalar(grid[field]) && text(row[key])) candidate[key] = row[key];
        if (kind === 'agency' && row.referenceNumberEvidence === 'response_grid_correlated' && text(row.referenceNumber))
          candidate.referenceNumber = row.referenceNumber;
        if (kind === 'agency' && row.referenceNumberTypeEvidence === 'response_grid_correlated' && text(row.referenceNumberType))
          candidate.referenceNumberType = row.referenceNumberType;
        return [candidate];
      });
      const rawIds = rows.map(value => record(value)?.nativeId);
      const rawIdsValid = rawIds.every(id => typeof id === 'string' && /^\d{1,30}$/.test(id));
      const idRows = kind === 'guest' ? selectedRows : rows;
      const targetCount = kind === 'guest' ? inspectedMatched : idRows.filter(value => record(value)?.nativeId === nativeId).length;
      const match = candidates.filter(candidate => candidate.nativeId === nativeId);
      const loaded = searchCoverage?.loaded;
      const loadedValid = typeof loaded === 'number' && Number.isInteger(loaded) && loaded >= 0;
      const rowsAccounted = kind === 'guest' ? loadedValid && found.returned === Math.min(25, loaded as number) && rows.length === found.returned
        : loadedValid && rows.length === loaded && rawIdsValid;
      const complete = Boolean(searchValid && inspectionValid && rowsAccounted && fieldsVerified && closeOutcome === 'closed_unsaved' &&
        searchCoverage?.possiblyTruncated === false && searchCoverage.truncated === false && searchCoverage.serverMoreRecords === false &&
        (loaded === 0 ? found.outcome === 'no_match' : found.outcome === 'matches'));
      const verified = Boolean(searchValid && inspectionValid && fieldsVerified && closeOutcome === 'closed_unsaved' &&
        (kind === 'guest' || rawIdsValid) && targetCount === 1 && match.length === 1);
      const coverage = { complete, native: searchCoverage, returned: rows.length, inspectedMatched, closeOutcome };
      const rowVerification = { status: verified ? 'verified' as const : 'unverified' as const,
        method: 'response_grid_correlation' as const, verifiedFields };
      if (verified) return { outcome: 'matched', match: match[0]!, candidates, rowVerification, coverage };
      if (complete && targetCount === 0) return { outcome: 'not_found', match: null, candidates, rowVerification, coverage };
      const failed = !['matches', 'no_match'].includes(String(found.outcome));
      return { outcome: failed ? 'failed' : 'incomplete', match: null, candidates, rowVerification, coverage,
        issue: failed ? text(found.issue) ?? 'native_lead_search_failed' : closeOutcome !== 'closed_unsaved'
          ? text(closed.issue) ?? 'native_picker_close_unverified' : targetCount !== null && targetCount > 1
            ? 'native_lead_duplicate_id' : 'native_lead_verification_incomplete' };
    }, { memory: null, blockServiceWorkers: true, signal });
    signal?.throwIfAborted();
    return result;
  } catch {
    signal?.throwIfAborted();
    return empty('failed', 'native_lead_session_failed');
  }
}
