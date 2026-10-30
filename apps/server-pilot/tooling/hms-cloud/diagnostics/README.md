# HMS cloud batch diagnostics

These read-only drivers use the existing Centurion Stay 360 readers and their pinned Stagehand Playwright dependency:

```sh
node apps/server-pilot/tooling/hms-cloud/diagnostics/batch-read-guest-details.mjs <candidates.md> <output.json> <workers>
node apps/server-pilot/tooling/hms-cloud/diagnostics/batch-read-guest-forms.mjs <candidates.json> <output.json> <workers>
```

The details driver reads the first column of the Markdown table under `## Distinct exact ID candidates`. It requires unique confirmation IDs with at least six digits, a hyphen, and a numeric suffix. Optionally, `STAY360_DATE_HINTS_FILE` can point to a JSON object with a `candidates` array containing `confirmation`, `arrivalDateHint`, and `guestNameHint` fields. The name is used only if the first lookup is ambiguous.

The forms driver reads a JSON object with a `candidates` array. Each item contains `confirmation` and may contain `arrivalDate` and `guestName`; the name is used only after an ambiguous lookup. Dates must be calendar-day strings in `YYYY-MM-DD` form.

`workers` is a positive integer. Each worker launches a headless browser for each attempt, so at most that many browsers run concurrently; an ambiguous lookup may need a second attempt. Both drivers exit nonzero if a read fails or the run is interrupted. The forms driver also fails when guest identities are unresolved or the grid is known to be incomplete, retaining partial data privately.

Keep inputs, hints, outputs, Notes, and screenshots in private storage; never commit or print their contents. The output's parent directory must deny group and other access. Each driver reserves a new output file and writes private, atomic snapshots without overwriting an existing output. Legacy `playwright-quote/diagnostics/` paths remain available as wrappers.

## Historical confirmation-corpus helpers

These Python tools use the Centurion PDF and Stay 360 research formats; they are not production HMS readers. Inputs and outputs contain guest data and must remain private. Use a new output directory or filename for each run.

```sh
python3 prepare-centurion-confirmation-corpus.py <pdf-records.jsonl> <previous-results.json> <new-output-directory>
python3 prepare-confirmation-retries.py <results.json> <new-retries.md>
python3 merge-centurion-confirmation-corpus.py <candidate-evidence.json> <previous-results.json> <pending-batch.json> <new-output.json> [--retry-batch <retry.json>]
python3 recover-ambiguous-pdf-names.py <candidate-evidence.json> <results.json> <pdf-root> <new-evidence.json> [--source-records <pdf-records.jsonl>]
```

Run these commands from this directory, or supply the scripts' paths. Name recovery requires `pdftotext` and uses the saved confirmation-letter layout; review its hints before using them. `--source-records` replaces the source path recorded in older evidence if that file has moved. Recovery and merge preserve their inputs and refuse to overwrite output files.
