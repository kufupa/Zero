# HMS cloud batch diagnostics

These read-only drivers use the existing Centurion Stay 360 readers and their pinned Stagehand Playwright dependency:

```sh
node apps/server-pilot/tooling/hms-cloud/diagnostics/batch-read-guest-details.mjs <candidates.md> <output.json> <workers>
node apps/server-pilot/tooling/hms-cloud/diagnostics/batch-read-guest-forms.mjs <candidates.json> <output.json> <workers>
```

The details driver reads the first column of the Markdown table under `## Distinct exact ID candidates`. It requires unique confirmation IDs with at least seven digits, a hyphen, and a numeric suffix. Optionally, `STAY360_DATE_HINTS_FILE` can point to a JSON object with a `candidates` array containing `confirmation`, `arrivalDateHint`, and `guestNameHint` fields. The name is used only if the first lookup is ambiguous.

The forms driver reads a JSON object with a `candidates` array. Each item contains `confirmation` and may contain `arrivalDate` and `guestName`; the name is used only after an ambiguous lookup. Dates must be calendar-day strings in `YYYY-MM-DD` form.

`workers` is a positive integer. Each worker launches a headless browser for each attempt, so at most that many browsers run concurrently; an ambiguous lookup may need a second attempt. Both drivers exit nonzero if a read fails or the run is interrupted. The forms driver also fails when guest identities are unresolved or the grid is known to be incomplete, retaining partial data privately.

Keep inputs, hints, outputs, Notes, and screenshots in private storage; never commit or print their contents. The output's parent directory must deny group and other access. Each driver reserves a new output file and writes private, atomic snapshots without overwriting an existing output. Legacy `playwright-quote/diagnostics/` paths remain available as wrappers.
