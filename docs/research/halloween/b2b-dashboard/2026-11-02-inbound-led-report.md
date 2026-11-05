# Centurion: inbound-led opportunity

**Window:** 26 September 00:00 to 30 October 17:00, 2026, South African time; end exclusive. Unit: deduplicated inbound email.

## Main figures

| Measure | Emails |
|---|---:|
| All inbound | 4,516 |
| Actionable reservation work | 1,361 |
| Nava could potentially assist | 1,007 / 1,361 = **74.0%** |
| Any linked reply or PMS confirmation | 753 / 1,361 |
| Linked staff reply, including cases also linked to a PMS confirmation | 723 / 1,361 |
| Nava could potentially assist among staff-linked emails | **557 / 723 = 77.0%** |
| Large-group emails (>10 rooms) | 82 / 1,361 |

The 1,361 include some internal instructions. Actual OTA/channel work was excluded by the classifier. Group-only work is excluded from potential help; a separate individual task can count. In the existing labels, 344 actionable emails are not helpable and 10 have no help decision. These are estimates of prospective help, not Nava usage.

## Which actions could Nava help with?

The first column counts the original task tag. The other columns count emails where the separate action-detail pass marked that specific task Nava-supported. One email can appear in several rows; the passes can also disagree about a task. A linked staff reply is to the email and may address a different task in it.

| Workflow | Tagged inbounds | Supported task in detail pass | Of those, linked staff reply |
|---|---:|---:|---:|
| File supplied voucher | 372 | 367 | 128 |
| Reservation invoice | 250 | 226 | 137 |
| Create booking | 204 | 178 | 130 |
| Quote | 175 | 138 | 88 |
| Amend booking | 118 | 95 | 60 |
| File proof of payment | 90 | 84 | 65 |
| Cancel booking | 46 | 41 | 33 |

An `other` tag appears on 327 actionable emails; [its breakdown](2026-11-02-other-breakdown.md) covers logistics, payment administration and other tasks. Payment requests appear on 112; collecting payment alone is outside the assumed workflows.

## Reply evidence

| Inbound response label | Actionable emails | Potentially helpable |
|---|---:|---:|
| Staff reply only | 619 | 453 |
| Staff reply and PMS confirmation | 104 | 104 |
| PMS confirmation only | 29 | 28 |
| Other reply | 1 | 1 |
| No linked reply found | 608 | 421 |

These are inbound-level response labels. A single reply can link to multiple inbounds; an inbound can link to multiple replies. The earlier, separately classified outbound-type summary gives 722 staff-linked inbounds because it uses a different label source. Its 511/648 statistic counts distinct externally addressed outbound replies, not inbound emails. PMS confirmations are template candidates. No link found is not proof of no reply.

**Real cross-thread example:** [I00768](../../../../.private/centurion-opportunity-october-20261101/bulk-v22-effective/dataset-final-v32.jsonl): the inbound requested two bookings and invoices. A different-thread PMS confirmation for one named guest appeared 184 minutes later; the model linked it to the request. The confirmation described the booking as provisional until payment.

**Proof example:** [I00020](../../../../.private/centurion-opportunity-october-20261101/bulk-v22-effective/dataset-final-v32.jsonl) supplied a proof; staff replied that it was received. The owner says that Centurion receipt acknowledgement means the proof was filed. The saved detail row records the acknowledgement; it has not been rewritten to add that inference.

## Linker and limitations

1. Find outbound candidates after each inbound: direct reply header, same thread within seven days, or same sender/recipient within 72 hours. Direct header matches have no time cap. Rank header, thread and cross-thread candidates by subject overlap and timing; the initial inbound search retains up to five.
2. Search backwards from sent emails too, considering up to three inbound candidates per outbound; supplement the inbound candidate list and retain original source IDs. This recovers cross-thread confirmations missed by the first limit.
3. Luna checks the actual stay and task, then links zero or more outgoing IDs. It recorded at least one cross-thread link for 162 actionable inbound emails. The [frame builder](../corpus-analysis/mailbox-frame-build.py) and [reverse supplement](../corpus-analysis/mailbox-reply-candidate-supplement.py) implement candidate search.

This re-aggregates saved model outputs; it makes no new model calls. Some original inbound classifications used the earlier outgoing-type estimate as context. The saved action-detail pass found no same-request reply for 13 of the 753 linked inbounds; 21 of the 1,007 helpable inbounds have no proposed action step. These cases remain in the headline counts. For 181 of the 372 voucher-tagged emails the model received extracted PDF snippets; 191 lacked extracted content in the final packet. Classification can see later replies, so this is retrospective rather than a live-triage accuracy measurement.

## Reproduce

- Source: [main per-email dataset](../../../../.private/centurion-opportunity-october-20261101/bulk-v22-effective/dataset-final-v32.jsonl), with source IDs, inbound classifications, linked replies and action details.
- Aggregate: [private JSON](../../../../.private/centurion-opportunity-october-20261101/inbound-led-summary-20261102-v2.json); it records the source SHA-256. [Summary script](inbound-led-summary.py) takes any same-schema dataset and a new private output path.
- DaVinci needs its own source frame and classification run; this script can summarise the resulting same-schema dataset.

```bash
python3 -B docs/research/halloween/b2b-dashboard/inbound-led-summary.py \
  --dataset .private/centurion-opportunity-october-20261101/bulk-v22-effective/dataset-final-v32.jsonl \
  --output .private/centurion-opportunity-october-20261101/inbound-led-summary-replay.json
```

The output path must not already exist.
