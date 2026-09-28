---
title: "Quote HITL loop retro"
date: 2026-09-22
category: workflow-issues
module: apps/mail
problem_type: workflow_issue
component: development_workflow
severity: high
symptoms:
  - "A green quote gate and a card count were treated as a finished lab"
  - "Overlay steps lived only in the chat, so the next session could not repeat them without a transcript"
  - "The holdout was opened more than once while the filler was still changing"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
applies_when:
  - "Filling Centurion lab tool cards from mail, staff reply, and PDF text"
  - "Calling a one-tool loop done"
  - "Overlaying the private lab index without switching the EC2 git branch"
tags: [hitl, quote-stay, holdout, overlay, false-green-gate]
---

# Quote HITL loop retro

## Context

The quote pass fills `hms_quote_stay` cards for the Sep 9–18 Centurion corpus. A card stays on the rail when a required field is blank. A field stays blank only after the mail, the staff reply, and the PDF were actually read and do not state it. Inventing a confirmation number, a rate, a room code, or a PMS payload is a failed fill.

This note has no mail bodies and no inbound ids. Evidence packs stay under the private corpus review directory.

## What worked

- One tool until the gate was clear and two deep-read slices in a row added no new class. Find, read, and folio stayed frozen on purpose.
- Label or blank. A check-in, rate, or board is filled only from a label in the source. Conflicting days blank the field. A multi-stay rooming list stays blank rather than picking one stay.
- PDF text is `pdftotext -layout`. A buffer that starts with `%PDF` is not a read. Fifteen quote PDFs are absent from object storage; that is a listed hole, not an unread file.
- Native room codes are copied only when the source contains the code. "Standard Queen" is a product name. "Single" is a bed word. A voucher sentence is neither.
- Blank cards stay visible. An empty required field is a failed fill, not a reason to hide the call.
- Availability pings (vacant/clean/inspected, or an availability update with no check-in) are dropped and not put back.
- The lab contract can grow a slot the production quote schema already has. The production schema was not edited. Lab dates stay as the mail spelled them.

## What failed

- Stopping on a green gate. The flag counter can be zero while a labeled check-in, rate, or board is still blank. A class is a wrong fill, or a labeled check-in, rate, or board that is still blank after the mail, the reply, and the PDF were opened. A card count is not that class.
- Grading the same rows that were used to write the rule. A fix has to be checked on two slices that did not motivate it. [Tune-set pass rate is not an eval](https://dev.to/byteio_3726/tuning-set-pass-rate-is-not-an-eval-1204). Self-correction loops that re-score their own training rows drift. See the [holdout method](https://mlbenchmarks.org/pdf/04-holdout-method.pdf): a holdout is one-shot evidence.
- The holdout was opened more than once in the earlier session, including once to find bugs. That contaminated it. This execution opened it once, after the tune pair was clean, and did not edit the filler from those rows.
- Overlay steps existed only in the session. `ops-deploy.sh` and the default git-bundle sync are the wrong tools: the sync checks out and hard-resets a branch. The lab overlay is an S3 tar of the SPA plus a private index file. The EC2 git branch stays `feat/outlook-setup-download-button`.

## Classes the last pass had to encode

These were still wrong after the gate was already clear:

- Month-first dates (`September 22, 2026`) and a comma between "check out" and the weekday.
- The letter R inside the word "Rate" was read as currency, so the real ZAR amount was dropped.
- "Rate Basis: Breakfast", a standalone "Bed & Breakfast" line, and dinner phrases that are not spelled "dinner, bed and breakfast" (`B&B and dinner`, `bed, breakfast, dinner`, `include breakfast and dinner`). A dinner phrase replaces a stored breakfast. "Dinner & breakfast times" does not.
- Adults copied from room quantity were deleted even when the mail stated the same number as people. Stated pax stays. Unstated equality is still a fake pax.
- Emphasis marks between a check-in label and the date. A "from 19 Sept to 21 Sept 2026" range. A dinner cap stored as the stay amount.

Honest blanks that stayed blank: conflicting labeled days, multi-stay lists, source-absent PDFs, two different nightly rates, product names, a subject date with no check-in label.

## Overlay proof (2026-09-22)

- SPA hash `centurion-eval-lab-ao_Vekcd.js`. The filler chunk shipped with that build is `centurion-eval-b6q0hLtu.js`.
- EC2 branch before and after: `feat/outlook-setup-download-button`.
- Public index path absent. Private index mode `0640`, 1069 rows.
- Unauthenticated GET on `:8788` and `:8789` returned 401.
- Authenticated GET returned 200 and 1069 rows on both nginx hosts and both loopbacks.
- Lab Vitest: 20 passed. Quote gate: 252 live quote rows, 15 source-absent PDFs, the five stored flags otherwise zero.

## Guidance

1. Freeze the holdout ids before the first edit. Hash the filler. Deep-read only the tune pool.
2. A green gate does not end the loop. Two slices that were not used to write the current fix must add no class.
3. Open the holdout once, after that pair. If it fails, record the class. Do not retune on those ids.
4. Check the overlay script into the repo before the loop is called done. Do not reconstruct it from a transcript.
5. Do not start the next tool in the same pass.
