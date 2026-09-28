# Next HMS tool loop

**Status:** plan only. Do not implement a second tool in the quote pass.

**Execution posture:** not started. The quote overlay on 2026-09-22 is the predecessor. This file is the pipeline for the next tool, one tool at a time.

## Freeze order

Lab primary list in `apps/mail/lib/lab/centurion-eval.ts` (`HITL_PRIMARY_TOOLS`), quote first:

1. `hms_quote_stay` — this pass. Done as a lab fill, not as a second production schema edit.
2. `hms_amend_reservation` — next loop.
3. `hms_create_reservation` — scoped stub only. Guest Stay Save or CRS after Select. Never CRS Check Availability. See `docs/superpowers/plans/2026-09-11-centurion-pms-tools-dod-contracts.md`. Do not build it in the amend loop.
4. `hms_cancel_reservation`
5. `hms_read_folio`
6. `hms_generate_invoice`
7. `hms_post_payment`
8. `hms_email_folio`
9. `hms_refund`
10. `hms_event_read`
11. `hms_group_block_read`
12. `hms_company_account_read`
13. `hms_send_reservation_confirmation`
14. `hms_generate_quote_document`
15. `hms_generate_confirmation_proforma`
16. `mail.send_with_attachments`
17. `hms_attach_guest_stay_document`

`hms_find_reservation` and `hms_read_reservation` stay frozen companions. They are not the next loop. Demand-doc rank (find, then artifact, then documents) is a different list. The lab loop follows the primary list above.

Non-quote quirks wait in a jsonl until that tool's pass starts. Do not formalize every schema in the amend pass. Change the lab contract for the active tool only, and the production contract only when the same quirk repeats and an Infor page or the production schema already has a slot.

## Loop

```text
freeze holdout ids (15), hash-sorted, before the first edit
hash the filler
sample the tune pool only
repeat:
  gate (counts only)
  two deep-read slices that were not used to write the current fix
  a class = a wrong fill, or a labeled required field still blank after mail, reply, and PDF
  if a class: smallest fix, unit test, refill the private index mode 0600, new slices
  if both slices add no class: stop editing
open the holdout once
record the result
do not retune on holdout ids
overlay with apps/server-pilot/scripts/overlay-centurion-lab-spa.sh
prove branch unchanged, public index absent, 401 on :8788 and :8789, auth 200 and 1069
```

PDF text is `pdftotext -layout`. A `%PDF` buffer is not a read. A missing object is source-absent, not unread.

A blank required field stays on the card. Do not drop the card. Do not invent a confirmation number, a rate, a room code, or a PMS payload.

Other desks (replies that are not the Centurion gold mailbox) are a later join. Until that join, do not claim the corpus is complete.

## Overlay

`apps/server-pilot/scripts/overlay-centurion-lab-spa.sh`

- Builds nothing by itself. The caller builds the mail SPA first.
- Tars `apps/mail/build/client`, excluding `lab-centurion-index.json` and `*.map`.
- Uploads the tar and the private index to the existing lab buckets.
- SSM refuses the run unless EC2 HEAD is `feat/outlook-setup-download-button`.
- Does not call `ops-deploy.sh`. Does not run the default git-bundle sync (that script checks out and hard-resets).

## Done for a later tool

- Gate clear, and two tune slices with no new class, written under the private review directory.
- Holdout opened once after that pair.
- Overlay proof: branch unchanged, public index absent, new SPA hash, 401 both ports, auth 1069.
- No following tool started in the same pass.
