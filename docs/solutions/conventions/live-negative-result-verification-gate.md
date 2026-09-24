---
title: "Never trust a live negative: the six-proof verification gate for HMS/PMS reads"
module: infor-hms
date: 2026-08-05
last_updated: "2026-09-18"
category: conventions
problem_type: convention
component: tooling
severity: high
applies_when:
  - "Building or debugging any live PMS/HMS read tool (search, quote, folio, availability)"
  - "A live search returns zero rows, empty, or not_found and you are about to conclude the PMS has no record"
  - "A tool passes fixture/unit tests but behaves differently against live transport"
  - "Executing the Phase B empirical build-debug loop for a new read surface"
root_cause: wrong_api
resolution_type: workflow_improvement
tags:
  - infor-hms
  - live-integration
  - verification-gate
  - negative-result
  - known-positive-control
  - empirical-debug
  - server-pilot
  - osress
related_components:
  - assistant
  - development_workflow
---

# Never trust a live negative: the six-proof verification gate for HMS/PMS reads

## Context

While building `hms_find_reservation` the tool passed every fixture and unit test, then returned empty/`not_found` against live HMS. The coding LLM initially accepted that negative as business truth — "none of the real mail candidates resolve to a PMS record, so wait for more data." That conclusion was wrong. A full RCA (`/ce-debug`) showed the negative was manufactured by **several independent, stacked bugs**, not by the PMS lacking the reservation:

1. **Wrong DOM field** — filled `confirmationnumber` when the live form input is `ff_confirmationnumber` (`live-guest-stay-driver.ts:609`).
2. **Wrong search-request chrome** — assumed a `LIST_VIEW` component with old grid/dataspy IDs; live requires `COMPONENT_INFO_TYPE: DATA_ONLY`, `GRID_ID: 1775`, `DATASPY_ID: 1941` (`live-read-manifest.ts:736-739`; driver rejects any other dataspy id as `SCHEMA_DRIFT` at `live-guest-stay-driver.ts:234`).
3. **Stale filter/operator body** — old `equals` scaffold vs the live date-window + `BEGINS` OR-chain.
4. **Empty OR slots wildcarded** — unused OR filters left blank act as wildcards and returned ~30k-row date-window grids instead of an exact hit.
5. **Wrong response shape assumed** — live search is an XHR `pageData/GRIDRESULT` JSON body, not the painted fixture HTML; the parser fell through to cheerio and saw nothing. The canonical no-match is its own special shape: `fromCome:true, grid:null, messages:null`.
6. **Too-small / too-narrow scope** — a single oldest candidate over a narrow date window was mistaken for "PMS has no record," when later candidates over a wider window matched.

Any one of these produces a false negative that *looks* like a legitimate "not found."

## Guidance

**A negative live result is never accepted as business truth until all six of these are independently proven.** Treat a zero/empty/not_found as *unproven*, not as *false*, until the gate passes:

1. **Request** — the outbound request chrome matches live: correct form field names, component type, grid id, dataspy id, filter operators. Diff the actual sent body against a captured live request, not against the fixture.
2. **Response** — you parsed the *actual* live transport shape (e.g. `pageData/GRIDRESULT` JSON), not an assumed one. Log the raw envelope shape (digest/structure only — never PII) and confirm the parser consumed it.
3. **Parser** — the parser distinguishes populated-match, canonical-empty (`grid:null, messages:null`), and malformed shapes, and fails closed on the unknown case rather than silently returning empty.
4. **Scope** — no filter slot is accidentally wildcarded; unused OR slots carry an explicit non-matching token (`___NOMATCH___`), so "exact" is actually exact.
5. **Window** — the date/paging window is wide enough to contain a real record (real lookups ±365; canary windows stay tight for the not-found control).
6. **Known-positive control** — a reservation you *know* exists returns `ROW_OK` through the same code path. Without a green control, a red result proves nothing about the data.

Only when request + response + parser + scope + window are correct **and** a known-positive control is green may a remaining zero-row result be reported as "no record."

A private audit bundle can retain the request digest, source projection, named
checkpoints, trace, and postcondition evidence for these checks. It is a
container for the six proofs, not a seventh proof; video never replaces the
request, response, parser, scope, window, or known-positive control.

## Why This Matters

The failure mode is silent and business-dangerous: a false negative makes the tool (or the drafting LLM built on it) tell a hotel guest "we have no reservation for you" when the booking exists — or stalls a whole build waiting for "better data" that was never the problem. Fixture-green is not live-green: fixtures encode our *assumptions* about the transport; live encodes reality. Each of the six bugs above passed fixtures. The gate converts "it returned nothing, so there's nothing" (an assumption) into "it returned nothing, and I have independently proven every layer plus a positive control, so there's genuinely nothing" (evidence). This is the concrete, checkable form of the Phase B empirical build-debug loop, and it generalizes to every new read surface (quote, folio, availability, communications) — the transport IDs differ but the discipline is identical.

## When to Apply

- Before concluding any live read returned "no record" / empty / not_found.
- On the first live run of any new HMS/PMS read tool, even when unit/fixture tests are green.
- Whenever a tool's fixture behavior and live behavior diverge — run `/ce-debug`, reproduce, and walk the six proofs before hypothesizing about the data.
- As an explicit acceptance criterion in the promotion/real-example matrix for each Phase B tool.

## Examples

Before (assumption accepted as truth):

```text
searchExact(oldestCandidate) -> 0 rows over ±30d window
=> conclusion: "PMS has no record; wait for more real mail data"   # WRONG
```

After (gate applied):

```text
1. Request:  sent body diffed vs captured live req -> ff_confirmationnumber, DATA_ONLY, grid 1775, dataspy 1941  ✓
2. Response: raw envelope is pageData/GRIDRESULT JSON, parser consumed it (not HTML fallthrough)                 ✓
3. Parser:   populated / null-grid-null-messages / malformed all handled, fail-closed on unknown                ✓
4. Scope:    unused OR slots = ___NOMATCH___ (no wildcard); "exact" is exact                                     ✓
5. Window:   real lookup widened to ±365d                                                                         ✓
6. Control:  known-good confirmation walks the same path -> HMS_LIVE_ROW_OK                                       ✓
=> only now: a remaining 0-row candidate is genuinely "no record"
```

Minimal parser discipline (fail closed on unknown, accept the real empty envelope) — see `parseLiveOsressGridRows` in `apps/server-pilot/src/hms/live-guest-stay-driver.ts`:

```ts
if (pageData.fromCome !== true) schemaDrift();      // unknown shape -> fail closed
const gridWrap = pageData.grid;
if (gridWrap === null) {
  if (pageData.messages === null) return [];         // canonical live no-match
  schemaDrift();                                      // null grid w/ messages -> unknown -> fail closed
}
// else validate GRIDRESULT type, dataspy id, records, rows
```

## Related

- Bug-fix that this convention generalizes: [../integration-issues/live-osress-gridresult-parse-canary-row-ok.md](../integration-issues/live-osress-gridresult-parse-canary-row-ok.md)
- False-green gate (fixture/tsc-green != verified): [../workflow-issues/false-green-gate-unpersisted-tsc-fixes.md](../workflow-issues/false-green-gate-unpersisted-tsc-fixes.md)
- Operator runbook (token sequence incl. known-positive control): [../../infor-hms/live-reservation-shadow-runbook.md](../../infor-hms/live-reservation-shadow-runbook.md)
- Private Playwright audit-bundle pattern: [../architecture-patterns/private-playwright-audit-bundles-for-live-hms-read-tools.md](../architecture-patterns/private-playwright-audit-bundles-for-live-hms-read-tools.md)
