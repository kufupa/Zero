---
title: "Live OSRESS searchExact: parse GRIDRESULT JSON before HTML or canary never reaches ROW_OK"
module: infor-hms
date: 2026-08-04
last_updated: 2026-08-05
category: integration-issues
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - "Live Guest Stay searchExact failed before HMS_LIVE_ROW_OK: without GRIDRESULT parse, live OSRESS JSON fell through to cheerio HTML and yielded empty/not_found (SCHEMA_DRIFT only when HTML correlation-failed markers fire)"
  - "Confirmation search body left unused slots empty and used wrong date window vs kind-scoped ±365 with ___NOMATCH___ fillers"
  - "Canary did not walk oldest eligible exact candidates (len≥6) until HMS match, so live path stalled after HMS_LIVE_NOT_FOUND_OK"
  - "Shadow DoD evidence chain blocked until GRIDRESULT parse + search body + canary unlocks reached HMS_LIVE_ROW_OK then shadow/rollback tokens"
  - "After live-envelope hardening, an exact candidate absent from HMS failed with SCHEMA_DRIFT instead of returning not_found"
root_cause: wrong_api
resolution_type: code_fix
tags:
  - infor-hms
  - osress
  - gridresult
  - search-exact
  - live-canary
  - guest-stay
  - server-pilot
  - null-grid
related_components:
  - assistant
  - development_workflow
---

# Live OSRESS searchExact: parse GRIDRESULT JSON before HTML or canary never reaches ROW_OK

## Problem

Live HMS reservation shadow definition-of-done stalled on `HMS_LIVE_ROW_OK`. The canary path could log in, run the not-found probe, and emit a structural row fingerprint, but exact Guest Stay search against live OSRESS returned empty results or tripped `SCHEMA_DRIFT` until the driver parsed live `GRIDRESULT.GRID.DATA`, kind-scoped the confirmation OR body, and walked oldest exact mail candidates until a live match.

## Symptoms

- Live canary progressed past not-found and fingerprint tokens, then failed or waited before `HMS_LIVE_ROW_OK`.
- Exact OSRESS POSTs that should return a single list row looked empty to the driver, or correlation failed with `SCHEMA_DRIFT` when the response was not fixture HTML.
- Searches with empty unused OR filters returned broad date-window grids instead of a kind-scoped hit, so correlation could not isolate one confirmation or external reference.
- A single oldest mail candidate with length ≥ 6 still often `not_found` on live HRCEN even when later candidates in the same ordered set would match.
- Ops side-effects (not root cause of ROW_OK, but blocked proof runs per this session's EC2 notes): proof writes under `/opt/nava/shared` need a writable owner (EACCES when root-owned); quiesced ops-deploy refuses while http is online, so an alternate asset sync/compile path may be required mid-proof; status could falsely treat health as stale until the heartbeat stamp preferred `checkedAt`.

## What Didn't Work

- **Fixture-HTML-only parsing.** Cheerio over `[data-testid="result-row"]` is correct for loopback fixtures and unit HTML cases, but live XHR bodies are `pageData` / GRIDRESULT JSON. Falling through to HTML after a live POST produced empty fresh rows and `not_found`, or hit correlation-failed markers and threw `SCHEMA_DRIFT`.
- **Requiring GRIDRESULT for every live response.** A successful search with no matching reservation returns the canonical empty envelope `pageData: { fromCome: true, grid: null, messages: null }`, not a zero-row GRIDRESULT. Treating that shape as a missing live envelope falsely raised `SCHEMA_DRIFT`.
- **Leaving unused OR slots empty.** Empty BEGINS/`=` values in the soft-capture scaffold act as wildcards for the date window; the grid is not "exact" in the policy sense.
- **Narrow date windows for real lookups.** Canary-tight ±30 windows are appropriate for the not-found canary token, but real stays outside that window never appear.
- **One-shot oldest candidate.** Selecting a single mail-derived exact token and requiring an immediate live hit was too brittle for DoD.
- **Deploy/ops friction.** Proof JSON under `/opt/nava/shared` must be writable by the proof user (root-owned tree → EACCES). Quiesced ops-deploy refuses while http is online (`hms-live-proof` / deploy scripts encode that gate); mid-proof shipping may need alternate asset sync + compile rather than fighting the quiesce gate. Status heartbeat that only read `updatedAt` could miss runtime `checkedAt` and emit `HEALTH_STALE` after an otherwise good shadow.

## Solution

### 1. Validate both populated and canonical empty live envelopes

`extractOsressPageData` scans the response for `pageData:` and brace-balances the following object (live uses an unquoted key), then JSON-parses it. `parseLiveOsressGridRows` validates populated `GRIDRESULT.GRID.DATA` responses. It also maps the exact production no-match shape—`fromCome: true`, `grid: null`, and `messages: null`—to an empty row set. Other null-grid shapes still fail closed:

```212:258:apps/server-pilot/src/hms/live-guest-stay-driver.ts
export function parseLiveOsressGridRows(
  pageData: Record<string, unknown>,
): ReservationObservation[] | null {
  const schemaDrift = (): never => {
    throw new HmsRuntimeError('SCHEMA_DRIFT', 'OSRESS grid schema drift');
  };
  if ('success' in pageData && pageData.success !== true) schemaDrift();
  if (pageData.fromCome !== true) schemaDrift();
  const gridWrap = pageData.grid;
  if (gridWrap === null) {
    if (pageData.messages === null) return [];
    schemaDrift();
  }
  // ... validate GRIDRESULT type, dataspy, metadata, records, and rows ...
}
```

Production callers set `requireLiveEnvelope`; fixture HTML fallback remains available only to fixture callers. This prevents generic `404 not found` text from masquerading as a valid HMS no-match while accepting the real empty live envelope:

```429:445:apps/server-pilot/src/hms/live-guest-stay-driver.ts
  const pageData = extractOsressPageData(html);
  if (pageData) {
    const gridRows = parseLiveOsressGridRows(pageData);
    if (gridRows !== null) {
      return correlateObservations(
        gridRows,
        candidate,
        gridRows.length === 0 || NO_RESULTS_RE.test(html),
      );
    }
  }
  if (options.requireLiveEnvelope) {
    throw new HmsRuntimeError(
      'SCHEMA_DRIFT',
      'live OSRESS grid envelope missing',
    );
  }
```

Unit coverage under `describe('live OSRESS GRIDRESULT parser')` in `apps/server-pilot/tests/hms-live-guest-stay.test.ts` includes populated empty data, the production null-grid no-match, and malformed null-grid rejection.

### 2. Kind-scoped confirmation / OR body with `___NOMATCH___`

`OSRESS_OR_UNUSED_TOKEN` is the non-empty filler for unused OR slots. Empty slots are wildcards; canary fills every OR slot with the same canary token; real confirmation or external_reference pins only the matching slots; real lookups widen the date window to ±365:

```743:770:apps/server-pilot/src/hms/live-read-manifest.ts
export const OSRESS_OR_UNUSED_TOKEN = '___NOMATCH___';
// ...
  const unused = OSRESS_OR_UNUSED_TOKEN;
  const confVal = isCanary || candidate.kind === 'confirmation' ? v : unused;
  const extVal =
    isCanary || candidate.kind === 'external_reference' ? v : unused;
  const otherOr = isCanary ? v : unused;
  // Canary stays tight (±30). Real lookups widen so future-dated stays resolve.
  const departWindow = isCanary ? '-30' : '-365';
  const arriveWindow = isCanary ? '+30' : '+365';
```

### 3. Canary walk oldest exact candidates until match

Production reservation sessions still bind one opaque candidate and call `driver.searchExact` once. The live DoD canary walk is in the proof CLI: `selectOldestExactCandidates` keeps only extractors that yield exactly one exact candidate with `value.length >= 6`, then `runCanary` iterates until `matched`:

```660:671:apps/server-pilot/src/ops/hms-live-proof.ts
    let matched = false;
    for (const anchor of anchors!) {
      const search = await driver.searchExact(anchor.candidate, signal);
      if (search.outcome === 'matched') {
        matched = true;
        break;
      }
      if (search.outcome === 'ambiguous') emitFail('SCHEMA_DRIFT');
      // not_found → try next oldest eligible exact candidate
    }
    if (!matched) emitWait('NO_EXACT_CANDIDATE');
    emitOk('HMS_LIVE_ROW_OK');
```

Verified on branch `EC2-pilot` (local/pilot proof log `.superpowers/sdd/hms-dod-final2.log`, gitignored under `.superpowers/sdd/`; no PR number as of this writing — local commits ahead of origin may rewrite on rebase/squash): `HMS_LIVE_NOT_FOUND_OK` → `HMS_LIVE_ROW_FINGERPRINT_OK` → `HMS_LIVE_ROW_OK` → `HMS_SHADOW_OK` → `HMS_SHADOW_VERIFIED` → `HMS_ROLLBACK_OK`.

### 4. Brief status heartbeat fix (secondary)

`readHealthHeartbeat` prefers `checkedAt` and accepts `updatedAt` as alias (`apps/server-pilot/src/ops/hms-live-proof.ts`), so `HMS_SHADOW_VERIFIED` does not fail `HEALTH_STALE` solely because the runtime wrote the newer field name. Primary unlock for ROW_OK remains GRIDRESULT parsing + OR body + candidate walk.

## Why This Works

Live Guest Stay search is an XHR dataspy response, not a painted HTML table. A match uses `GRIDRESULT.GRID.DATA`; a valid no-match uses a null grid and null messages. Validating both shapes aligns the driver with the live transport without weakening fail-closed production parsing or fixture isolation. Filling unused OR slots with `___NOMATCH___` and scoping confirmation vs external reference restores the fail-closed "exact" intent of the soft-capture scaffold; widening real date windows to ±365 matches how stays sit relative to hotel date. Walking multiple oldest exact mail candidates absorbs false positives and absent PMS rows without opening detail screens or accepting ambiguous multi-row hits (ambiguous still fails canary as `SCHEMA_DRIFT`). Together, canary can honestly emit `HMS_LIVE_ROW_OK` before shadow enqueue and rollback.

## Prevention

- Cover both observed live OSRESS shapes: validated populated GRIDRESULT and the exact null-grid/null-messages no-match envelope. Keep fixture HTML fallback disabled for production and test malformed null-grid variants.
- Never leave dataspy OR filter values empty for "exact" policy bodies; use an explicit unused token and kind-scoped slot assignment; keep canary windows tight and real lookup windows wide enough for booked stays.
- For live DoD, walk a small ordered set of exact mail candidates (length floor, single-exact per message) instead of asserting the first oldest token exists in PMS.
- When shipping proof tooling to EC2-pilot, ensure `/opt/nava/shared` is writable by the proof user before canary/start; if quiesced deploy cannot run while http is online, use an alternate reviewed asset-sync + compile path rather than fighting the gate mid-proof.
- Align status health stamps with the field the runtime actually writes (`checkedAt`, with `updatedAt` alias) so verification does not false-fail after a good shadow.
- Keep proof artifacts digest-only; never log live confirmation numbers, guest emails, or raw lookup argv into operator stdout or proof JSON.

## Related Issues

- Prerequisite hostname DNS: [ec2-appsrv-hosts-nxdomain.md](./ec2-appsrv-hosts-nxdomain.md)
- Always-on OpenVPN path to hotel LAN: [../workflow-issues/ec2-pilot-nava-openvpn-always-on-health.md](../workflow-issues/ec2-pilot-nava-openvpn-always-on-health.md)
- Operator runbook (token sequence): [../../infor-hms/live-reservation-shadow-runbook.md](../../infor-hms/live-reservation-shadow-runbook.md)
- Implementation plan: [../../superpowers/plans/2026-08-01-infor-hms-live-reservation-shadow.md](../../superpowers/plans/2026-08-01-infor-hms-live-reservation-shadow.md)
