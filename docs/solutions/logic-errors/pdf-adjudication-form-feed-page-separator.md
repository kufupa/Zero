# PDF adjudication: preserve form-feed page separators

## Symptom

A local PDF comparison heuristic classified one Poppler result as corrupted because its extracted text contained a C0 control character.

## Cause

Poppler's multi-page text extraction uses form-feed (`\f`, U+000C) as a page separator. A blanket C0-control check treated this valid layout delimiter as extraction corruption.

## Fix

When searching for suspicious control bytes in extracted text, exclude ordinary transport/layout separators:

- line feed (`\n`)
- carriage return (`\r`)
- form-feed page separator (`\f`)

Keep other unexpected C0 controls eligible for the insufficient-output bin. Apply this only as adjudication routing evidence; never treat it as semantic ground truth.

## Verification

Regenerating the private adjudication set changed one record from `both_insufficient` to `poppler_better`, producing `302` unique source-bound adjudications. No raw PDF text belongs in public reports or Git.
