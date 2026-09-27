---
title: "Contextual HMS quotes returned partial and trace capture took 13 minutes"
date: 2026-09-26
category: logic-errors
module: "playwright-quote fetch-quote + HMS trace privacy"
problem_type: logic_error
component: tooling
severity: high
symptoms:
  - "Organization/agency quotes end outcome partial with RATE_NOT_BOUND_TO_VISIBLE_GRID and INCOMPLETE_DATES on negotiated rates."
  - "OPTION_LIMIT forces partial even when every verified match is returned."
  - "fetch-quote spends ~13 minutes in sanitizePlaywrightTraceFile after a ~3 minute browser run."
root_cause: logic_error
resolution_type: code_fix
tags: ["infor-hms", "hotel-availability", "rate-context", "trace-privacy", "extjs", "performance"]
---

# Contextual HMS quotes returned partial and trace capture took 13 minutes

## Problem

Live Woolworths (organization `49`) and CWT JNB (agency `290`) quotes on HRCEN both ended `partial`, and each run spent ~13 minutes sanitizing a 15 MB Playwright trace.

## Root causes

1. **Grid label drift.** Hotel Availability renders some rate plans with a label different from the `inquiryForGrid` native `desc` for the same code. Seen on HRCEN: `NCOR2B` grid `Negiotiated rate` vs native `Negotiated Contracted  Rate 2`; `NGDS3B` `Momentum Group` vs `Metropolitan - MMI Holdings`; `WSG4B` `Pohl and Pohlster BB Rate` vs `Wholesale Group Rate 4`. `extractOptions` bound DOM rows on `code: desc`, so these rows were dropped. `rateRow()` already bound on code prefix only.
2. **Output cap treated as coverage gap.** A contextual search returns every rate plan (496 rows = 9 rooms x ~55 rates). `maxOptionsPerGroup` 50 set `search: truncated` and `matchingRowsUnseen: true` whenever anything was hidden, even though all 496 rows were examined and match rows sort first.
3. **ExtJS ids harvested as secrets.** `looksLikeDynamicSecret` matched ExtJS generated ids (`container-1234-innerCt`, grid column class tokens) in frame-snapshot DOM attributes. Thousands became "secrets", each expanded to ~8 escaped variants, and `redactText` walked every variant for every trace string while rebuilding the percent-encoding `RegExp` each call. Cost was ~65 ms per harvested value over this trace, and grid ids/classes were redacted into noise.

## Fix

- Bind by room code + `rate.code: ` prefix (still exactly one row). Per-night price/inventory agreement stays the binding proof. `rate.label` is the on-screen label (schema contract); `nativeLabel` carries the native desc when different.
- `limitOptions()` reports `matchingRowsUnseen` only when a hidden row is a `match`. `OPTION_LIMIT` is still emitted.
- Compile the percent pattern once per variant and skip it when text has no `%`. Exempt the ExtJS id shape only for `id`/`class`/`for`/`aria-*`/`data-componentid`/`data-boundview` attributes inside a trace-stream `frame-snapshot` `snapshot.html` tree, and never when the value contains a credential keyword. The same shape in API JSON or other fields is still classified (Greptile P1 on the first, broader version).

## Verification

- Offline replay of saved `group-1-source.json` through `extractOptions` reproduced the live issue counts exactly before the fix; after it, Woolworths has 18 verified contextual matches.
- Live Woolworths quote after fix: outcome `quote`, 18 `contextual|match|verified|available` rows, total run 3m40s, trace finalize 14s (was ~13 min). Redaction markers 544 (was 16,603); `bookingSessionID` and `JSESSIONID` still redacted.
- CWT JNB with no negotiated rates now returns public BAR as `quote` plus `NO_SPECIAL_RATES` (not a contracted rate). Silent BAR fulfilment only when the bound party has zero contextual rows.

## Prevention

- Replay saved `group-N-source.json` offline through `extractOptions` before any live rerun; it is deterministic and fast.
- When the sanitizer is slow, count distinct harvested dynamic values first. Sanitizer cost scales with harvested values x trace strings, not with trace size.
