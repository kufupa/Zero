---
title: 'Dashboard Cached Export Accepted After Failed Refetch'
date: '2026-09-10'
category: 'logic-errors'
module: 'apps/mail admin dashboard export hook'
problem_type: 'logic_error'
component: 'tooling'
symptoms:
  - 'A dashboard export could report success and download cached data after a later refetch failed.'
  - 'A failed refetch retained previous data, so checking data presence alone accepted a stale export.'
root_cause: 'logic_error'
resolution_type: 'code_fix'
severity: 'high'
related_components: ['testing_framework']
tags:
  [
    'admin-dashboard',
    'cached-export',
    'refetch-error',
    'react-query',
    'query-identity',
    'cache-invalidation',
    'snapshot-validation',
    'export-hook',
  ]
---

# Dashboard Cached Export Accepted After Failed Refetch

## Problem

The admin dashboard export hook could return success and download an old payload after a later refetch failed. React Query can retain previous `data` on error, so data presence alone is not evidence of a successful export refresh.

## Symptoms

The observable failure was a two-step sequence: the first export downloaded successfully, then a transient failure occurred on the next refresh, yet the hook could still return success and invoke the downloader using the first payload. The key distinction is that a failed query may have both `isError === true` and non-empty historical `data`; data presence alone does not prove that the latest explicit export request succeeded.

The [export hook](../../../apps/mail/hooks/use-admin-dashboard.ts#L159) also checks the envelope's schema version, cohort, window, and explicitly requested observation cutoff. Its query identity includes the session viewer and mail-cache/transport scope; acceptance compares the current mail-cache scope with the captured scope. This concerns export correctness and cache identity, not an established cross-user leak.

## What Didn't Work

Checking only `result.data` (or treating the query's retained data as a successful refresh) was insufficient. It made the cache look like a fresh server response precisely when React Query was reporting the refresh error.

A later review proposed an additional mounted viewer/selection closure race. That hypothesis was tested with the real mounted hook and React Query observer: both the combined attempt and the later split viewer-timing/selection-timing attempt passed against unchanged production at `2ba0c392`. The installed TanStack Query 5.81.5 observer updates its query identity and returns its current observer result on `refetch()`, and the dashboard page invokes the current callback while the hook remains mounted. The independent adjudication therefore rejected I-1 as not established and made no production race fix. This is evidence about the exercised mounted path, not a claim that every lifecycle or unmount race is impossible; a post-unmount cancellation contract would be a separate requirement.

## Solution

The hook now treats the explicit refetch result as an envelope whose error state must be valid before its data can be accepted. It builds an export query identity from the requested input, report version, session viewer, cached user, and active transport, and removes only that exact query when validation fails:

```typescript
const exportQueryKey = [
  ...(exportQueryOptions.queryKey as readonly unknown[]),
  ADMIN_DASHBOARD_REPORT_VERSION,
  viewerScopeKey,
] as typeof exportQueryOptions.queryKey;
const exportQuery = useQuery({ ...exportQueryOptions, queryKey: exportQueryKey });
const clearCachedExport = () => {
  queryClient.removeQueries({ queryKey: exportQueryKey, exact: true });
};
```

The download path handles a rejected promise, then rejects a settled error or any invalid/mismatched payload before calling `downloadAdminDashboardExport`:

```typescript
try {
  result = await exportQuery.refetch();
} catch {
  clearCachedExport();
  return false;
}
const payload = result.data as AdminDashboardExport | undefined;
// payloadQuery and scopeStillMatches are derived from the current request/scope.
if (
  result.isError ||
  !payload ||
  payload.schemaVersion !== 'admin-dashboard-export-v1' ||
  !queryMatchesSelection ||
  !scopeStillMatches
) {
  clearCachedExport();
  return false;
}
downloadAdminDashboardExport(payload);
return true;
```

The focused [regression](../../../apps/mail/tests/admin-dashboard/export-hook.test.tsx#L117) uses a real `QueryClientProvider`. Its query function returns `successfulPayload` once and then throws `transient export refresh failure`; the first `download()` returns `true`, the second returns `false`, and the downloader remains at one call. The existing deferred mounted-transition diagnostics remain useful evidence for the rejected I-1 hypothesis, but they are not presented as a new race repair.

## Why This Works

The fix separates transport state from cache contents. `result.isError` describes the current refetch; `result.data` may describe the last successful fetch. Requiring both a non-error result and a valid payload prevents historical data from being promoted to a new download. The `catch` branch covers implementations or failures that reject rather than returning an error result, and both paths remove the exact export entry so a later action cannot reuse the failed attempt's cached value.

The query key separates requested input, report version, and viewer/cache/transport identity. Explicit acceptance checks compare the payload selection and current mail-cache scope. The schema-version check rejects unsupported export envelopes; it is not a complete runtime validation of every nested field. Mounted transition behavior also depends on the installed observer and caller lifecycle described above. Returning `true` means the hook accepted the payload and called the downloader, not that a browser file save or live end-to-end journey was independently proved.

## Prevention

For any manually triggered export or refresh, keep these acceptance rules together: inspect the returned error state, require payload presence and schema, compare the payload's normalized selection with the request, compare the current viewer/transport scope, and clear the exact query key on failure. Do not use the presence of cached data as a proxy for a successful network attempt.

Keep a regression that performs a successful export followed by a failed refresh and asserts both `false` and no additional downloader call. Prefer a real mounted hook and the installed query library for cache/observer behavior; mocks can still isolate the server procedure and browser downloader. When a lifecycle race is alleged, first inspect the installed observer implementation and the actual page caller, then require a reproducible RED before changing production. The current tests cover the mounted viewer/selection transitions that were proposed, but download serialization is mocked and this evidence is not a joined browser/database/live-system proof. Preserve those boundaries when extending the coverage rather than claiming that all race classes are solved.

## Related Issues

- [Mail-content cache ownership and retry identity](mail-content-cache-ownership-retry-identity.md): a related cache-state boundary, with a different root cause and owner.
- [Draft refresh and editor lifecycle](mail-draft-refresh-data-loss-and-lifecycle.md): protecting current editor state from late server data, distinct from accepting an export.
- [Execution ledger](../../superpowers/plans/handoff-reports/2026-09-07-centurion-dashboard-tools-execution.md): accepted repair and review chronology, including the rejected mounted-race hypothesis.

The related-doc search found no duplicate and no contradicted guidance. GitHub issue search was unavailable because repository issues are disabled; no issue link is inferred.
