---
title: Grid-only WAL merge still drops native restricted Walk-in
date: 2026-10-25
category: logic-errors
module: playwright-quote
problem_type: logic-errors
component: fetch-quote
tags: [WAL, includeRestricted, BAR]
---
# WAL #548

HMS BAR grid showed Walk-in Rate (WAL) that Nava omitted.

Shipped `#548` `e688ddf09`: unique *calendar* WAL merges into native rates (`fetch-quote.mjs`). Restrictions stay unknown for grid-only rows. `Bed & Breakfast NR` maps to breakfast.

Live WAL on A095 is *native* `restricted=true` `maxLeadTime=1`. Default shop `includeRestricted=false` drops it. Fixture used unrestricted WAL. G9 re-run PARK. Owner confirms whether restricted walk-in should appear.
