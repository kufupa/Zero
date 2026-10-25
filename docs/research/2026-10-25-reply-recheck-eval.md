# Reply re-check evaluation — 2026-10-25

Status: exploratory offline result; no product path, flag, mailbox state, or deployment changed.
GPT-6 Luna beats the rule baseline on this selected set, but the result does not qualify the
re-check for shipping. Labels combine deterministic event evidence with blind Luna adjudication;
they are not independent human gold, and the input is not full production thread context.

## Source and cohort

Read-only production SQL ran through `apps/server-pilot/deploy/ssm-run-command.sh` with
`BEGIN READ ONLY` / `ROLLBACK`; database timezone was UTC. Snapshot: **2026-10-25 01:00:00Z**.
The reply-check SUT did not produce the cohort: rows come from the direct work-item
`source_message_id` / `sent_message_id` links to messages. No work-item `done` status or predictor
output was selected or used. The earlier strict `In-Reply-To`-only count (166 pairs) did not have
100 later-event rows, so this cohort uses the exact work-item source/reply links and then the
thread/reference-bound next event.

| Selection stage | Distinct `(workItemId, replyMessageId)` pairs | Source / rule |
|---|---:|---|
| Directly linked, non-spam production pairs | 1,017 | inbound source + outbound staff reply, same transport/thread |
| Mature at snapshot (at least 24 h since reply) | 953 | reply time ≤ snapshot − 24 h |
| First later message linked within 24 h | 116 | same thread or RFC reference to the reply |
| Explicit automatic-reply marker excluded | 2 | marker checked on the first later message |
| **Truth-labelled rows** | **114** | all remaining distinct pair keys; selected independently of predictions |

Labels were frozen before either predictor ran. Clear cases use event metadata; ambiguous events
were drafted and adjudicated by separate GPT-6 Luna medium-reasoning passes. Both label passes saw
only the work-item kind, source request, staff reply, first later event text/direction, and a boolean
indicating whether its sender matched the source sender. Neither pass saw predictor output, message
IDs, or Nava work-item status; the second pass also saw the first-pass label.

| Label evidence | Labeling method | Rows |
|---|---|---:|
| Confirmed successful booking | `handled` | 0 |
| Later inbound event, exact same sender as source | deterministic `waiting_on_guest` | 22 |
| Later outbound staff event | deterministic `needs_more_action` | 8 |
| Later inbound event, sender differs or is unverified | two-pass Luna draft/adjudication | 84 |

The two Luna label passes agreed on **72/84 (85.7%)** ambiguous rows; the adjudicator supplied the
final label on all 84. Final frozen support is **20 `handled`, 41 `waiting_on_guest`, 53
`needs_more_action`**. The 20 `handled` labels are inferred from event content; no confirmed booking
occurred in this horizon. Only **22/106** inbound follow-ups have the exact same sender as the
original inbound message, so other actor identities remain unverified. Rows span **66 threads**,
**72 reply messages**, and **72 next messages**; they are clustered, not independent.

## Predictor input and scoring

Both candidates were scored against the same frozen rows. Their available pre-reply fields were
work-item kind, source inbound subject/text, and staff-reply subject/text after quoted history and
signature stripping. Bodies were capped at 8 KB per field; **0/114** rows were clipped. The rule
uses reply text. GPT-6 Luna received only those pre-reply fields: no later message, event direction,
booking evidence, IDs, labels, or work-item status. No attachment text or other prior thread
messages were available, so this is a text-only candidate prompt, not exact parity with a future
production thread reader.

The deterministic rule was run twice with identical output on **114/114** rows. It maps a direct
guest-directed request to `waiting_on_guest`; a concrete staff follow-up promise, check, pending, or
partial answer to `needs_more_action`; a bare “we'll revert” cue to `waiting_on_guest`; otherwise
`handled`. The specific staff-promise rule preserves the plan's acceptance example (“come back with
rates” → more staff work) where the general “will revert” wording is ambiguous.

The predictor was GPT-6 Luna at medium reasoning via Azure Foundry (`store:false`), run once on each
row. It consumed 32,002 input tokens; estimated cost was **$0.0092**. Blind label drafting and
adjudication used 65,830 input tokens and an estimated **$0.0194**. Total estimated cost for the
successful labeling and scoring runs was **$0.0286**. Rates below all use the same source and
**n=114 distinct production pair rows** above. Balanced accuracy is mean recall across the three
supported labels.

| Predictor | Accuracy (correct / n=114) | Balanced accuracy (3 supported labels, n=114) |
|---|---:|---:|
| Rule baseline | 21/114 = **18.4%** | **32.4%** |
| GPT-6 Luna | 57/114 = **50.0%** | **49.1%** |

Per-label rates use the same `n=114` source; support is from the frozen, predictor-blind labels:

| Gold label | Support | Rule precision / recall | Luna precision / recall |
|---|---:|---:|---:|
| `handled` | 20 | 18/103 = 17.5% / 18/20 = 90.0% | 11/31 = 35.5% / 11/20 = 55.0% |
| `waiting_on_guest` | 41 | 3/11 = 27.3% / 3/41 = 7.3% | 10/22 = 45.5% / 10/41 = 24.4% |
| `needs_more_action` | 53 | no rule predictions / precision n/a, 0/53 = 0% recall | 36/61 = 59.0% / 36/53 = 67.9% |

Confusion counts, with row totals from the same 114-pair source:

| Gold (n) | Rule: handled / waiting / needs | Luna: handled / waiting / needs |
|---|---:|---:|
| `handled` (20) | 18 / 2 / 0 | 11 / 2 / 7 |
| `waiting_on_guest` (41) | 38 / 3 / 0 | 13 / 10 / 18 |
| `needs_more_action` (53) | 47 / 6 / 0 | 7 / 10 / 36 |

## Limits and decision

- This is the event-resolved subset: only 116/953 mature pairs had a linked next message within
  24 h; two explicit auto-replies were removed. It does not estimate performance on replies with no
  observed follow-up, and automatic mail beyond the explicit marker was not independently reviewed.
- Ambiguous labels were adjudicated by the same GPT-6 Luna model family being evaluated, so
  evaluator/model-family bias is possible; the second pass saw the draft and is not independent.
  No two-human semantic adjudication was done. Read these as next-event-informed labels, not
  independently verified semantic gold.
- The event stream had 106 later inbound messages, 8 later outbound staff messages, and no confirmed
  booking. Inbound senders are not verified guests unless matching the source sender. Final label
  support is 20/41/53; the set remains event-selected, not representative of every staff reply.
- GPT-6 Luna gains over this rule run but gets only 57/114 right; one predictor pass provides no
  run-to-run variance estimate. Two earlier label attempts stopped before completion; reported
  labeling cost covers only the successful complete pass.
- Pair rows cluster in 66 threads; rates are row-level and no cluster-adjusted interval is claimed.

**Decision:** keep `REPLY_RECHECK` off. Do not ship or shadow this LLM from these rates. A release
decision needs independently adjudicated next-action labels, verified guest/staff actors, handled
examples, and an input set matching the eventual production thread reader.
