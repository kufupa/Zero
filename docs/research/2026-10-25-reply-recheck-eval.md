# Reply re-check evaluation — 2026-10-25

Status: exploratory offline result. No product path, flag, mailbox state, or deployment changed.
On this selected cohort GPT-6 Luna scores higher than the rule baseline, but these labels are
model-adjudicated rather than independent human gold, and the candidate input omits production
attachment/thread context. This result is not sufficient to ship or shadow the LLM.

**Review correction (2026-10-25):** The original label/scoring run used Azure Foundry with raw
production message text in model prompts (potentially containing PII), contrary to the repository's
no-PII-to-hosted-prompts rule. This report preserves those historical aggregates, but they must be
re-run before use in a product decision. The evaluator now fails closed unless
`AI_MODEL_ROUTE=approved-local` and an explicitly configured `judge` route reports `egress=none`;
the current shell has no such route configured. No production message text was sent during this
review.

## Source and reproducible cohort recipe

Read-only production SQL ran through `apps/server-pilot/deploy/ssm-run-command.sh` under
`BEGIN READ ONLY` / `ROLLBACK`. Snapshot: **2026-10-25 01:00:00 UTC**. Raw message export and
per-row predictions remained in mode-0600 files under `/tmp`; only aggregates are committed here.
The reply-check SUT did not produce these labels or predictions. Cohort IDs are direct production
links; neither Nava's work-item `status` nor any reply-check output was read for selection or truth.

Credential-free reconstruction recipe (the SSM/psql command supplies the production connection;
the SQL selection itself needs no credentials):

1. Start with `work_item` rows and join `message` twice through `source_message_id` and
   `sent_message_id`. Require matching `transport_id` and `thread_id`, inbound source and outbound
   staff reply, and `mail_thread.spam_at IS NULL`. Deduplicate on
   `(work_item.id, work_item.sent_message_id)`. Do not filter on `work_item.status`.
2. Set reply time from the linked outbound message's `sent_at` (fall back to `work_item.sent_at`);
   keep replies at least 24 hours old at the fixed snapshot.
3. For each pair, choose the earliest later message in the same transport in the next 24 hours,
   ordered by its direction-specific timestamp (`received_at` for inbound, `sent_at` for
   outbound), then message ID. A candidate must share the work-item thread or have an RFC link to
   the staff reply (`in_reply_to = reply.message_id_header` or `references` contains that header).
   Keep the linked message text, direction, timestamp, and whether its sender exactly matches the
   source sender only in the private export.
4. Exclude an explicit auto-response if the next message subject/body matches, case-insensitively,
   `automatic reply|auto(?:matic)?-?reply|out of office|delivery status notification|mail delivery subsystem|do not reply`.
   The two matched rows were inbound; no raw subject/body or sender is included here.
5. Check the linked source/thread window for confirmed booking evidence (`stay_commit`, successful
   status, and a non-empty confirmation number in `hitl_tool_run`, plus episode booking confirmation).
   There were no confirmed bookings in this cohort.

The earlier **166** `In-Reply-To`-only pair count was not the evaluation denominator: fewer than
100 of those had a linked next event. The broader direct work-item links above were used, then the
next-event and maturity rules were applied:

| Selection stage | Distinct `(workItemId, replyMessageId)` pairs | Source / rule |
|---|---:|---|
| Directly linked, non-spam production pairs | 1,017 | inbound source + outbound staff reply, same transport/thread |
| Mature at snapshot (at least 24 h) | 953 | reply time ≤ snapshot − 24 h |
| First later message linked within 24 h | 116 | same thread or RFC reference to the reply |
| Explicit automatic replies excluded | 2 | subject/body marker above |
| **Truth-labelled rows** | **114** | all remaining distinct pair keys; selected without predictions |

## Predictor-blind labels

Labels were frozen before either predictor ran. All 114 retained cases were ambiguous: no
confirmed-booking event supplied deterministic `handled` labels, and direction or sender match
alone cannot identify who owns the next action. Each case received a GPT-6 Luna medium-reasoning
draft and a second GPT-6 Luna adjudication. Both passes saw only work-item kind, source request,
staff reply, and the first next event's direction, text, and source-sender-match boolean. They saw
no predictor output, message/work-item IDs, or Nava work-item status; the adjudicator also saw the
draft label. Neither pass could inspect later events after this first linked message.

The two label passes agreed on **91/114 = 79.8%**; the adjudicator supplied the final label for
each row. Final label support from the same **n=114 production event-resolved source** is **32
`handled`, 26 `waiting_on_guest`, 56 `needs_more_action`**. Of 116 first next events, 108 were
inbound and 8 outbound; after the two auto-replies were excluded, 106 inbound and 8 outbound
remained. Only **22/106** retained inbound messages had a sender exactly matching the original
source sender. Rows span **66 threads**, **72 reply messages**, and **72 next messages**; they are
clustered, not independent.

## Predictor input and scoring

Both candidates scored the same 114 frozen rows by production pair ID. Their pre-reply inputs were
work-item kind, source inbound subject/text, and staff-reply subject/text after plain-text and HTML
blockquote history plus signature stripping. Each body was capped at 8 KB; **0/114** rows were
clipped. The rule consumes the reply text. GPT-6 Luna received only those pre-reply fields—no next
event, booking evidence, IDs, labels, or work-item status. Attachment text and earlier thread
messages were unavailable, so this is not input parity with a future production thread reader.

The deterministic baseline ran twice with identical output on **114/114** rows. It maps a direct
guest-directed request to `waiting_on_guest`; a concrete staff follow-up promise, check, pending,
or partial answer to `needs_more_action`; a bare “we'll revert” cue to `waiting_on_guest`; otherwise
`handled`. The specific staff-promise rule preserves the plan example (“come back with rates” →
more staff work).

The historical GPT-6 Luna medium-reasoning run used Azure Foundry (`store:false`) once per row;
the current evaluator no longer permits that hosted route. All rates below use the same **n=114**
event-resolved production source above; accuracy is correct/114 and balanced accuracy is mean recall
across the three supported labels. The current runner budgets the fully serialized prompt plus
system text and schema to 26 KB, clips only JSON string fields when needed, and records clipping;
the fitting search preserves the largest per-field text cap that still fits. The historical run
predates that guard.

| Predictor | Accuracy (n=114, this production source) | Balanced accuracy (n=114, same source) |
|---|---:|---:|
| Rule baseline | 31/114 = **27.2%** | **32.8%** |
| GPT-6 Luna | 59/114 = **51.8%** | **47.1%** |

Per-label precision and recall are also from the same **n=114** source; supports are the frozen
blind-label counts above:

| Gold label | Support (source n=114) | Rule precision / recall | Luna precision / recall |
|---|---:|---:|---:|
| `handled` | 32 | 29/103 = 28.2% / 29/32 = 90.6% | 16/34 = 47.1% / 16/32 = 50.0% |
| `waiting_on_guest` | 26 | 2/11 = 18.2% / 2/26 = 7.7% | 7/19 = 36.8% / 7/26 = 26.9% |
| `needs_more_action` | 56 | no rule predictions / precision n/a, 0/56 = 0% recall | 36/61 = 59.0% / 36/56 = 64.3% |

Confusion counts, with each row total from the same **n=114** production source:

| Gold label (support) | Rule: handled / waiting / needs | Luna: handled / waiting / needs |
|---|---:|---:|
| `handled` (32) | 29 / 3 / 0 | 16 / 3 / 13 |
| `waiting_on_guest` (26) | 24 / 2 / 0 | 7 / 7 / 12 |
| `needs_more_action` (56) | 50 / 6 / 0 | 11 / 9 / 36 |

Successful blind-label passes used **86,012 input tokens** (estimated **$0.0270**); successful
scoring used **32,002 input tokens** (estimated **$0.00833**). Known successful-run total: **$0.0354**.
One earlier scoring attempt stopped on an incomplete model response and produced no output files;
its billable partial usage was not captured in the aggregate and is excluded from that total.

## Limits and decision

- This is an event-resolved subset: only 116/953 mature pairs had a linked next message within
  24 h. It does not estimate performance when no follow-up was observed.
- Labels use the same model family as the LLM predictor; the adjudicator saw the draft and is not
  independent. No two-human semantic adjudication was done. Treat these as next-event-informed
  labels, not independently verified gold.
- Actor identity is weak: 84/106 retained inbound senders did not exactly match the original
  source sender. Thread clustering is material (66 threads for 114 rows); rates have no
  cluster-adjusted interval.
- Luna beats this rule run on accuracy and balanced accuracy but is correct on only 59/114 rows.
  A single predictor run gives no run-to-run variance estimate. The comparison is additionally
  limited by the missing attachments/full thread context.
- `score` now rejects duplicate `(workItemId, replyMessageId)` pairs or ordinals and mixed
  `asOf`/`cohortN` snapshots before calling a model. `cohortN` can exceed retained `n` because
  freeze excludes rows. Both `freeze` and `score` require positive, unique sample ordinals.

**Decision:** keep the LLM offline; do not ship or shadow it from these rates. Reconsider only
with independently adjudicated next-action labels, verified guest/staff actors, handled examples,
and inputs matching the eventual production thread reader.
