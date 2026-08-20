# Centurion mailbox audit (2026-08-09, historical snapshot)

> Aggregate-only report. Raw mail remains in local, gitignored audit artifacts.
>
> **Correction / operational status (2026-08-10): `not_available`.** All figures and claims below describe a dated retained snapshot only. The previous response assessment used message-level and limited linkage evidence, not validated current thread-state. Its response figures, including 66/116, are **superseded for operational use**. Do not infer a current work queue, zero work, resolved cases, or service performance from this report. Publish new operational aggregate facts only after a validated canonical Task 1 corpus, Task 3 adjudication, and private Task 4 report run.
>
> **Metric meaning:** former `no observed response` means **“no qualifying response observed in the reviewed retained snapshot.”** It never means unanswered, missed, or current work.

## Verdict

- Corpus is genuinely inbound-heavy: **1304** Canonical Centurion messages, **1176 inbound** and **128 outbound**.
- Outbound corpus is almost entirely document workflow output: **116/128 (90.6%)** are template/document-delivery messages; zero were classified as a substantive staff-composed reservation response.
- Historical manual inbound review found **116 new reservation requests**. **31/116 (26.7%)** had an observed verified internal-human response; **41/116 (35.3%)** had any observed tracked response including automated-only. These response figures are superseded for operational use.
- Former `no observed response` means **“no qualifying response observed in the reviewed retained snapshot.”** It does not prove a missed reply or identify current work.

## Scope and method

- Canonical transport: every one of 1304 retained messages, dated 2026-07-27 through 2026-08-09.
- Full retained RDS topology: 25 messages outside Canonical Centurion also read manually for linkage. Header-link query found 0 outbound links from another transport to a Centurion inbound.
- Each inbound body manually classified as new request, existing-booking follow-up, automated reservation notice, non-reservation, or unclear.
- Every new-request thread manually checked against same-thread and cross-thread response candidates; qualifying human reply independently re-verified as an internal sender that substantively answered that request.
- Every Canonical outbound body manually classified for shape, delivery mode, and few-shot usefulness; an independent stratified spot check re-read 16 messages.

## Mail flow

| Measure | Count |
| --- | ---: |
| Canonical Centurion messages | 1304 |
| Inbound | 1176 |
| Outbound | 128 |
| Inbound share | 90.2% |
| Threads | 1026 |
| Peak inbound day (2026-08-04) | 140 |
| Peak outbound day (2026-08-05) | 26 |

## Every inbound body: manual classification

| Class | Count | Share of inbound |
| --- | ---: | ---: |
| new reservation request | 116 | 9.9% |
| existing reservation followup | 342 | 29.1% |
| automated reservation notice | 215 | 18.3% |
| non reservation | 497 | 42.3% |
| unclear | 6 | 0.5% |

## Historical new reservation requests: former response outcome

> **Historical figures — superseded for operational use.** This table is retained to preserve the dated analysis. It is not a current queue, response rate, or resolved/unresolved-case count.

| Outcome | Requests | Share |
| --- | ---: | ---: |
| human response (historical) | 31 | 26.7% |
| automated response only (historical) | 10 | 8.6% |
| no qualifying response observed in the reviewed retained snapshot (historical) | 66 | 56.9% |
| ambiguous (historical) | 9 | 7.8% |

Historical human-response classification required an internal Legacy/Anew/Centurion sender plus a substantive answer to that exact new request. It was not merely an email sent from an internal address.

## New-request mix

| Request origin | Count |
| --- | ---: |
| guest | 48 |
| travel agent | 45 |
| internal staff | 13 |
| unknown | 10 |

| Booking type | Count |
| --- | ---: |
| individual | 32 |
| group | 40 |
| corporate | 37 |
| unknown | 7 |

## Every outbound body: manual shape review

| Shape | Count | Share of outbound |
| --- | ---: | ---: |
| template document delivery | 116 | 90.6% |
| staff composed reservation response | 0 | 0.0% |
| staff composed nonreservation | 0 | 0.0% |
| test or duplicate | 10 | 7.8% |
| unknown | 2 | 1.6% |

| Few-shot value | Count |
| --- | ---: |
| strong | 0 |
| tone only | 0 |
| workflow only | 116 |
| none | 12 |

Independent outbound spot check: 16/16 agreement, 0/16 disagreement.

## Verified human response style

This review covers 36 unique messages linked to 31 human-answered request threads. A thread can have multiple reply messages and one message can serve more than one request.

| Style value | Count |
| --- | ---: |
| strong | 4 |
| tone only | 3 |
| workflow only | 25 |
| none | 4 |

| Authorship shape | Count |
| --- | ---: |
| substantive human | 8 |
| template with human wrapper | 3 |
| template only | 21 |
| unknown | 4 |

Requires live grounding: 31/36. This is why a pure prompt or imitation model cannot safely send most replies.

Direction reconciliation: 25/36 verified response messages are captured as Canonical outbound; 11/36 arrived as inbound from internal staff. The outbound-shape review therefore does not contradict the 8 substantive-human messages: 8/8 are staff-to-Centurion traffic rather than a send from Canonical Centurion.

## Other retained RDS mail: linkage result

- Other-mailbox messages manually reviewed: 25.
- Linked to a Centurion reply/follow-up: 0.
- Could change Centurion response attribution: 0.
- Unrelated other-mailbox mail: 25; unclear: 0.

## Historical build implication

1. Build a grounded **drafting triage** agent first: classify intent, extract stay/booking facts and attachment references, select a response path, and produce a cited draft for human approval.
2. Prioritize read tools over prose imitation: reservation lookup, availability + rates, attachment/PDF reading, property-document lookup/fetch, then folio/sent-mail/company/group reads.
3. Treat document delivery as a first-class workflow. Most observed outbound shape is confirmation/payment document delivery, not a free-form paragraph.
4. Keep send/create/amend/cancel/payment writes behind explicit human approval until read grounding and audit evidence are solid.
5. Collect a deliberately consented sample of genuine, composed agent replies if tone imitation is a product goal. This corpus contains scarce usable few-shot prose.

## Historical artifact references

- Former local Markdown dumps were snapshot-bound raw artifacts. Do not refresh, transfer, or use them as the current operational runbook input.
- `.tmp-centurion-outbound-audit/*/review-summary.json`: exact local manual-review decisions and responder attribution. Do not commit raw content or identities.
- `docs/infor-hms/centurion-pms-tool-demand-2026-08-09.md`: aggregate read-tool demand and safest build order.

## Limits

- Snapshot is retained RDS data at audit time, not proof of all historical mailbox activity.
- Direction indicates ingest/send classification, not authorship by itself; body review supplied the shape and response findings.
- Regex demand analysis is supplementary. Exact counts above come from manual classification.

