# Centurion: 30-day workflow scenario

**Window:** 30 September 17:00–30 October 17:00, 2026, South African time; end exclusive. Counts are inbound emails, not bookings or distinct replies.

| Measure | Emails |
|---|---:|
| Inbound | 4,006 |
| Actionable reservation inbound | 1,204 |
| With a model-linked staff reply | 629 |
| Original potential help: planned non-group workflows | 485 / 629 (77.1%) |
| Additional large-group workflow candidates | 28 |
| Additional reviewed requests with unspecified group size | 4 |
| Future potential including groups | **517 / 629 (82.2%)** |
| Outside this future-workflow estimate | 112 |

The 485, 28 and 4 are disjoint; 517 is their sum. The 485 is a prospective, planned-tool estimate, not a count of today's working product. There were 31 group-tagged staff-linked emails; three do not meet the current-task filter. The 112 are outside this particular estimate, not necessarily beyond every possible future Nava feature.

The assumed future workflows are quotes, creates, amendments, cancellations, reservation invoices, and filing supplied vouchers or payment proofs. Partial help and staff approval count. Large-group functionality is hypothetical; groups mean more than 10 rooms. Nava does not send emails. An approval-assisted opportunity is not a count of unattended automation.

## Group detail

Among the 28 group candidates: 14 quotes, 7 amendments, 5 creates, 5 invoices, and one each for cancellation, payment proof and voucher. Actions overlap within an email. Two group-tagged candidates have `unclear` task scope in the action pass, but the earlier group-context review tied them to a specific larger block.

## Method and limits

1. Slice the saved, deduplicated inbound dataset by timestamp. Retain the model's actionable reservation emails with a staff-linked reply; this excludes OTA/channel work as classified in the original pass.
2. Start with the original `can_help=true` cases. Add group-tagged cases only if the separate action pass identifies one of the seven workflows above as requested, supplied for action, or completed/confirmed in the retrospective evidence. Do not add unsupported-only tasks or future promises.
3. Review originally undecided cases with an otherwise relevant workflow. Four real cases qualify for the future scenario regardless of whether the party needs more than 10 rooms: three quotes and one supplied rooming list. Their IDs are explicit in the command below. This does not change their group labels.
4. The classifier used later replies and some attachment context. These are retrospective LLM estimates, not independently labelled accuracy or actual Nava usage. One linked reply can cover multiple inbounds. Review original `can_help=false` cases separately when measuring false negatives; this script does not promote them automatically apart from the group scenario.

**Today:** no defensible per-email count yet. On 2 November at 08:37 UTC, a read-only process-environment check found quote preparation on in the worker, off in the HTTP process, and the create/amend/cancel write flags restricted to Labtest. This does not establish an end-to-end staff-ready quote or voucher rate. Verify actual staff capabilities, then reclassify these same inbound IDs against that capability list.

## Reproduce and locate emails

Source: [per-email dataset](../../../../.private/centurion-opportunity-october-20261101/bulk-v22-effective/dataset-final-v32.jsonl), SHA-256 `7c95be34030929e6bf1ceae35ad209cdffefcc47db65d7bbf16ed7f572540a7d`. The [saved split](../../../../.private/centurion-opportunity-october-20261101/future-scope-30day-20261102.json) contains all selected and excluded case IDs; the source dataset maps each ID to the original email, linked replies, actions and provenance. No new model call was made for this split.

Run the [summary script](future-scope-summary.py) with a new output filename. For another mailbox, review its proposed uncertain cases and pass only the accepted IDs; do not reuse the Centurion IDs.

```bash
python3 -B docs/research/halloween/b2b-dashboard/future-scope-summary.py \
  --dataset .private/centurion-opportunity-october-20261101/bulk-v22-effective/dataset-final-v32.jsonl \
  --start 2026-09-30T17:00:00+02:00 --end 2026-10-30T17:00:00+02:00 \
  --accept-uncertain I02189 I02190 I03342 I04009 \
  --output .private/centurion-opportunity-october-20261101/future-scope-30day-replay.json
```
