# Centurion: what was tagged “other”

## Scope and counts

Among the 1,361 actionable inbound emails in the main Centurion window (26 Sep 00:00–30 Oct 17:00 SAST, end exclusive), 327 carried the `other` workflow tag. The model assigned **one primary other-topic bin per email** below. These are estimates from real emails, not independently verified labels. An email can have several other tasks; this table retains the main one.

| Primary other-topic bin | Emails | Examples |
|---|---:|---|
| Guest stay logistics/services | 101 | Arrival/check-in, shuttles, meals, amenities |
| Payment/banking administration | 85 | Payment status or method, bank letters, card problems |
| Existing booking confirmation/status | 45 | Confirmation or reservation number, booking checks |
| Group/event coordination | 23 | Group itinerary or event/venue arrangements connected to a stay |
| Missing/requested proof or voucher | 19 | Chasing a missing proof, requested or promised voucher |
| Inventory/channel/system | 18 | Hotel inventory, allocations, platform or system issues |
| Guest information or other documents | 15 | Rooming lists, guest details, forms or policies |
| Miscellaneous or unclear | 9 | Other tasks that do not fit the bins |
| Acknowledgement or simple reply | 8 | Receipt acknowledgements and callbacks |
| Possibly outside reservation scope | 2 | Venue-only requests without a stay |
| No separate other task found | 2 | Earlier tag may not represent an additional task |
| **Total** | **327** | |

The original `other` tag overlaps with other workflows: 194 emails had only `other`, and 133 had at least one additional tag. Of the 327, 85 were also judged potentially helpable because they had another supported task. **33** had the separate >10-room group tag; they can appear in any bin. The 23 group/event coordination emails are not the same as the 33 large-group emails: only 13 of the 23 had that group tag. These counts do not change the original opportunity estimate. The last four emails are review flags, not confirmed corrections.

## How this breakdown was made

- Selected the 327 real rows tagged `other` from [the main candidate dataset](../../../../.private/centurion-opportunity-october-20261101/bulk-v22-effective/dataset-final-v32.jsonl); no invented emails were used.
- The first 24 real emails were used to refine the bins. A single `gpt-6-luna` medium pass then classified all 327 using the cleaned inbound, bounded earlier context, attachment metadata, and prior task descriptions. Each result has one primary bin; `store:false`, no model tools, and sensitive-data checks. The prior descriptions and any later-reply-derived context are fallible.
- 327/327 returned a bin. Source, prompt, schema, endpoint and projected-input hashes are stored with each result. [Summary](../../../../.private/centurion-opportunity-october-20261101/other-bins-20261102/summary-v2.json) includes counts for helpability, original tags and groups; [per-email results](../../../../.private/centurion-opportunity-october-20261101/other-bins-20261102/results-v2.jsonl) keep the model's short explanations.
- A further 21 real emails were selected by predicted bin, excluding the initial 24. An agent spot-checked the cleaned messages and prior task descriptions; this is not a human gold set or a representative accuracy estimate. `I02292` asks whether a rate is commissionable but was put under inventory/system; commission questions need a clearer bin rule. `I03501` asks about both check-in and payment, illustrating that one primary bin is a judgment. Cases `I00552` and `I01508` are venue-only requests that appear outside the stated reservation scope. Keep these flags without silently altering the earlier dataset.

## Tools

- [Classification prompt](other-bin-prompt-v2.md) and its [earlier version](other-bin-prompt-v1.md).
- [Real-email classifier](other-bin-classify.py); [source-checked summary](other-bin-summary.py). Both write private outputs. The classifier validates source/prompt identity when resuming and never retries held cases by inference.
- For the exact Centurion run and replay paths, see the [dashboard guide](README.md) and [original run record](../corpus-analysis/2026-11-02-centurion-corpus-run.md).

The output is descriptive. It does not establish that a new Nava workflow is implemented or that staff completed the work. Before reusing the bins for another mailbox, check its scope and review real examples, including commission and multi-task boundaries.
