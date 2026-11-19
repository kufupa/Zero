import { hmsReadTargetForProperty, type HmsReadTarget } from '../hms/hms-read-target.js';
import { quoteRateContextEnabled } from './quote-rate-switch.js';
import { partyMatchSearchTerms } from './party-match-v2.js';

export type NativePartyRole = 'agency' | 'organization' | 'ar_account';

export type ReservationWorkflowV2NativePartyRead = {
  status: 'complete' | 'partial' | 'unavailable' | 'failed';
  result: Record<string, unknown>;
  coverage: { complete: boolean; notes: string[] };
};

const specs = {
  agency: { tool: 'searchPrimaryBookingAgency', id: 'travelagencyid', name: 'travelagencyname' },
  organization: { tool: 'searchOrganization', id: 'companyid', name: 'companyname' },
  ar_account: { tool: 'searchArAccount', id: 'araccountid', name: 'araccountname' },
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Native issue codes are safe to report; arbitrary browser messages may contain private data.
function issue(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[a-zA-Z0-9_]{1,100}$/.test(value) ? value : fallback;
}

function failure(role: NativePartyRole, name: string, status: 'unavailable' | 'failed', reason: string): ReservationWorkflowV2NativePartyRead {
  return { status, result: { outcome: status === 'failed' ? 'execution_failure' : 'unavailable', kind: role,
    searchedFor: name, candidates: [], truncated: null, reason }, coverage: { complete: false, notes: [reason] } };
}

/** Read source-provided party names in a guarded blank Guest Stay. Never select a candidate. */
export async function lookupNativeParty(input: {
  role: NativePartyRole; name: string; target: HmsReadTarget; transportId?: string; signal?: AbortSignal; exactTerm?: boolean;
}): Promise<ReservationWorkflowV2NativePartyRead> {
  const { role, target, signal } = input;
  if (!quoteRateContextEnabled()) {
    return { status: 'failed', result: { outcome: 'refused_flag_off', kind: role, searchedFor: null,
      candidates: [], truncated: false }, coverage: { complete: false, notes: ['refused_flag_off'] } };
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!Object.hasOwn(specs, role)) return failure(role, name, 'unavailable', 'native_party_role_unsupported');
  if (!target) return failure(role, name, 'unavailable', 'native_party_target_unsupported');
  let expected;
  try { expected = hmsReadTargetForProperty(target.propertyCode); }
  catch { return failure(role, name, 'unavailable', 'native_party_target_unsupported'); }
  if (!target || target.propertyCode !== expected.propertyCode || target.browserSlot !== expected.browserSlot ||
      target.secretId !== expected.secretId || target.origin !== expected.origin ||
      target.installationEnvName !== expected.installationEnvName) {
    return failure(role, name, 'unavailable', 'native_party_target_unsupported');
  }
  if (!name || name.length > 200 || /[\r\n]/.test(name)) {
    return failure(role, name, 'unavailable', 'native_party_name_required');
  }
  if (target.propertyCode !== 'HRCEN') {
    const { nativeReadCapabilityAvailable } = await import('../hms/hms-service.js');
    if (!await nativeReadCapabilityAvailable({ propertyCode: target.propertyCode, transportId: input.transportId })) {
      return failure(role, name, 'unavailable', 'native_party_read_capability_unavailable');
    }
  }
  signal?.throwIfAborted();
  try {
    const sessionUrl = new URL('../../tooling/hms-cloud/hms-lookup-read-session.mjs', import.meta.url);
    const session = await import(sessionUrl.href) as {
      withCloudLookupReadSession<T>(operation: (context: { runTool: (input: Record<string, unknown>) => Promise<Record<string, unknown>> }) => Promise<T>,
        options?: Record<string, unknown>): Promise<T>;
    };
    const result = await session.withCloudLookupReadSession<ReservationWorkflowV2NativePartyRead>(async ({ runTool }) => {
      signal?.throwIfAborted();
      const spec = specs[role];
      let nativeQuery = name;
      let found = await runTool({ tool: spec.tool, query: nativeQuery });
      const searchesTried = [{ query: nativeQuery, outcome: found.outcome }];
      if (found.outcome === 'no_match' && !input.exactTerm) {
        for (const term of partyMatchSearchTerms(name).filter(term => term !== name).slice(0, 2)) {
          signal?.throwIfAborted();
          nativeQuery = term;
          found = await runTool({ tool: spec.tool, query: nativeQuery });
          searchesTried.push({ query: nativeQuery, outcome: found.outcome });
          if (found.outcome !== 'no_match') break;
        }
      }
      const closed = await runTool({ tool: 'closeGuestStayPartyPicker', propertyCode: target.propertyCode });
      const outcome = text(found.outcome) ?? 'execution_failure';
      const closeOutcome = text(closed.outcome) ?? 'execution_failure';
      const nativeCoverage = record(found.coverage);
      const criteria = record(found.criteria);
      const correlation = record(found.correlation);
      const verifiedFields = Array.isArray(correlation?.verifiedFields)
        ? correlation.verifiedFields.filter((field): field is string => typeof field === 'string') : [];
      const verified = new Set(verifiedFields);
      const rawCandidates = Array.isArray(found.candidates) ? found.candidates : [];
      const identityVerified = verified.has(spec.id) && verified.has(spec.name);
      let valid = Array.isArray(found.candidates) && identityVerified;
      const candidates = rawCandidates.flatMap((value) => {
        const row = record(value), nativeId = text(row?.nativeId), candidateName = text(row?.name);
        if (!identityVerified || !nativeId || !/^\d{1,30}$/.test(nativeId) || !candidateName) { valid = false; return []; }
        const code = role === 'agency' && row?.referenceNumberEvidence === 'response_grid_correlated'
          ? text(row.referenceNumber) : role === 'organization' && verified.has('corporateaccountnumber')
            ? text(row?.corporateAccountNumber) : role === 'ar_account' && verified.has('araccountnumber')
              ? text(row?.accountNumber) : null;
        return [{ nativeId, name: candidateName, code, meaning: candidateName,
          ...(role === 'agency' && code ? { referenceNumber: code } : {}),
          ...(role === 'agency' && row?.referenceNumberTypeEvidence === 'response_grid_correlated' && text(row.referenceNumberType)
            ? { referenceNumberType: text(row.referenceNumberType) } : {}),
          ...(role === 'organization' && code ? { corporateAccountNumber: code } : {}),
          ...(role === 'ar_account' && code ? { accountNumber: code } : {}),
          ...(role === 'ar_account' && verified.has('arstatuscodedesc') && text(row?.status) ? { status: text(row?.status) } : {}),
          ...(role === 'ar_account' && verified.has('accttype') && text(row?.accountType) ? { accountType: text(row?.accountType) } : {}),
          ...(verified.has('address') && text(row?.address) ? { address: text(row?.address) } : {}),
          ...(verified.has('city') && text(row?.city) ? { city: text(row?.city) } : {}),
          ...(verified.has('country') && text(row?.country) ? { country: text(row?.country) } : {}) }];
      });
      candidates.sort((left, right) => Number(reservationEntityKey(right.name, role) === reservationEntityKey(name, role)) -
        Number(reservationEntityKey(left.name, role) === reservationEntityKey(name, role)));
      if (new Set(candidates.map((candidate) => candidate.nativeId)).size !== candidates.length) valid = false;
      const truncated = typeof nativeCoverage?.truncated === 'boolean' ? nativeCoverage.truncated : null;
      const loaded = nativeCoverage?.loaded;
      const complete = ['matches', 'no_match'].includes(outcome) && typeof found.searchId === 'string' &&
        criteria?.query === nativeQuery && nativeCoverage?.possiblyTruncated === false && truncated === false &&
        typeof loaded === 'number' && Number.isInteger(loaded) && loaded >= 0 && loaded === rawCandidates.length &&
        (outcome === 'matches' ? loaded > 0 : loaded === 0) && valid && closeOutcome === 'closed_unsaved';
      const isError = !['matches', 'no_match'].includes(outcome);
      const reason = isError ? issue(found.issue, 'native_party_search_failed') : closeOutcome !== 'closed_unsaved'
        ? issue(closed.issue, 'native_party_picker_close_unverified') : 'native_party_lookup_incomplete';
      const status = complete ? 'complete' : isError ? (outcome === 'input_gap' || outcome === 'unavailable' ? 'unavailable' : 'failed') : 'partial';
      return { status, result: { propertyCode: target.propertyCode, outcome, kind: role, searchedFor: name, nativeQuery, searchesTried, nativeCriteria: criteria,
        candidates, truncated,
        ...(complete ? {} : { reason }),
        ...(isError ? { searchIssue: issue(found.issue, 'native_party_search_failed'),
          ...(found.stage ? { stage: issue(found.stage, 'native_party_search') } : {}) } : {}),
        ...(closeOutcome !== 'closed_unsaved' ? { closeIssue: issue(closed.issue, 'native_party_picker_close_unverified') } : {}),
        nativeCoverage, correlation: { verifiedFields }, closeOutcome },
      coverage: { complete, notes: complete ? [] : [reason] } };
    }, { propertyCode: target.propertyCode, transportId: input.transportId, signal });
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    const details = record(error);
    return failure(role, name, 'failed', issue(details?.message, 'native_party_session_failed'));
  }
}

/** Mechanical aliases stay within their entity type; commercial names remain display evidence. */
function reservationEntityKey(value: string, role: 'agency' | 'organization' | 'ar_account'): string {
  const tokens = value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  const suffixes = new Set(['pty', 'ltd', 'limited', 'inc', 'llc', 'cc', 'plc']);
  if (role === 'agency') for (const word of ['travel', 'travels', 'tour', 'tours', 'agency', 'agencies']) suffixes.add(word);
  while (tokens.length > 1 && suffixes.has(tokens.at(-1) ?? '')) tokens.pop();
  return tokens.join('');
}
