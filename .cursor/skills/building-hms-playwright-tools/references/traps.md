# HMS Playwright traps

Append one bullet after each tool. Do not rewrite history. No secrets, CDP URLs, mail bodies, guest PII.

## Quote v1/v2 (2026-09)

- CRS **Check Availability** creates records. Use **Hotel Availability** only.
- Stagehand runtime LLM: ~125 min, 0 quotes. Native Playwright CDP only.
- Restart-login loop kills speed. Persist borrowed browser; inspect failing step.
- `STWN` = Standard Twin room type, not twin beds. Keep code/label; expose `bedNative` + `bedType` from the bed card.
- Preset-filter null calendar is not sold-out. Ordinary BAR filter can still have inventory.
- Displayed nightly sum is not an official PMS total, tax, or payable.
- Missing `buildingCode` → allocation unknown. Do not invent `MAIN`.
- U1/U2 ~1500-char `/goal` worked. U4 stuffed AE checklist (~3800 chars) + tests/video on Astra → 87 min.
- `--video` and `node --test` belong on Grok after first live proof, not first Astra exec.
- Shop by Day / Reserve / save / config mutation forbidden on read tools.
- Sequential occupancy-group searches do not prove joint inventory.
- Astra parent for git/tests is the expensive bill. Grok orchestrates; `codex exec` + `resume` for live only.
- A mail phrase is not an HMS field. Breakfast wording does not become `boardBasis`.

## Party lookup (2026-09)

- Infor association docs say linking org/agency auto-adds A/R. Live HRCEN New Record hold-select of org filled company only; agency filled ta1+commission; A/R stayed blank. Independent A/R lookup exists with org/agency empty. Treat A/R as its own v1 search kind. Do not skip that dialog because the manual said auto-add.
- Agency Search can return “Cannot retrieve profile: External system” with an empty grid. That is a typed outcome, not a locator miss. Do not click Save to recover.
- Borrowed-CDP Playwright `tracing.stop` + sanitizer can hang after screenshots already exist. Party-lookup skips trace; criteria/results pngs are the proof.
- Organization/Agency/A/R picker Run control is **Run Filter** inside the dialog. Page-header **Run** is Guest Stay search. `query('grid')` misses `readonlygrid`.
- Local Booking Agencies filter-row `ff_travelagencyname` can hold the typed name while the grid stays unfiltered. The search that actually runs is the dialog toolbar query box next to the column dropdown, then dialog **Run** (not page-header Run, not external Search). Filling `.last()` toolbar input can hang on the operator combo; try inputs right-to-left with a short timeout.
- Borrowed `connectOverCDP` `browser.close()` kills the owner Chromium. Close only the isolated context. Disconnect the Playwright connection or the CLI event loop never exits.
- Guest Internal Search lastName-only `A` can sit on **Processing request.** for >60s. Wait until that spinner is gone before scrape. Do not call empty-grid `no_match` while it is still spinning. The Internal Search label is `Internal Search:` (trailing colon). CRM lastName-only raises `Cannot retrieve profile: … First Name is required` — never click that OK as if it were a penalty dialog; type `input_gap`.
