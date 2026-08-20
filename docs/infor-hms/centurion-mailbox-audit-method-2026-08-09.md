# Centurion mailbox audit method (2026-08-09, historical snapshot)

> Reproducible method summary. Aggregate-only; raw bodies and reviewer packets stay local and gitignored.
>
> **Correction / operational status (2026-08-10): `not_available`.** This is a dated description of the prior retained-snapshot method. Its message-level and limited linkage evidence did not establish validated current thread-state. Do not use its response reconstruction, outcome labels, or response figures as a current queue, service metric, or case-resolution result. New operational aggregate facts require a validated canonical Task 1 corpus, Task 3 adjudication, and private Task 4 report run.
>
> **Metric meaning:** former `no observed response` means **“no qualifying response observed in the reviewed retained snapshot.”** It never means unanswered, missed, or current work.

## Historical goal

Determine whether retained Centurion mail contains enough evidence to build an AI agent that safely drafts reservation replies:

1. Measure actual inbound/outbound volume.
2. Separate real new reservation requests from follow-ups, systems, and unrelated mail.
3. Link each new request to an observed response, including cross-thread candidates.
4. Attribute qualifying internal replies.
5. Establish whether outbound mail is reusable human prose or mostly a document workflow.

## Corpus boundary

- Read-only RDS snapshot taken 2026-08-09.
- Canonical `transport-centurion`: 1,304 messages, 1,176 inbound and 128 outbound, dated 2026-07-27 through 2026-08-09.
- Every one of the 25 retained messages outside that transport was also reviewed for a possible Centurion linkage.
- These counts describe retained RDS evidence, not all historical work performed by property staff through external systems.

## Manual review pipeline

### 1. Inbound intent classification

An LLM reviewer read each available subject and full body. Keyword hits were never treated as the final class.

Allowed classes:

- New reservation request
- Existing reservation follow-up
- Automated reservation notice
- Non-reservation
- Unclear

For each new reservation request, reviewer also assigned requester type and booking type. Results were schema-validated for exact message coverage, unique work-item IDs, permitted values, and non-identifying evidence.

### 2. Historical response reconstruction

For every new request, candidate responses were assembled from:

- Same thread.
- `In-Reply-To` / `References` header linkage.
- Normalized subject plus matching recipient/sender linkage across threads.

A reviewer read the request and candidates, then assigned one outcome:

- Human response.
- Automated-only response.
- No qualifying response observed in the reviewed retained snapshot (historical).
- Ambiguous.

Human responses required an internal Legacy/Anew/Centurion sender and a substantive answer to the exact request. A separate reviewer repeated this qualification pass before attribution was accepted.

### 3. Outbound-shape audit

Every one of the 128 Canonical outbound bodies was read and classified:

- Template/document delivery.
- Staff-composed reservation response.
- Staff-composed non-reservation response.
- Test/duplicate.
- Unknown.

Each was also marked for delivery mode and few-shot value. An independent stratified review re-read 16 messages; all 16 agreed with initial classifications.

### 4. Human-reply style audit

The 36 unique messages supporting 31 verified human-answered requests were read again. This pass distinguished reusable writing style from document delivery and recorded whether a live fact source would be needed before drafting.

Direction was preserved separately from authorship: 25 of these messages were captured as Canonical outbound, while 11 arrived as inbound from internal staff. All eight substantive-human messages are in the latter group. This prevents treating the Canonical outbound template corpus as a representative sample of all staff-written replies.

### 5. Other RDS mailbox cross-check

All 25 messages outside `transport-centurion` were reviewed with their possible Canonical candidates. None belonged to a Centurion reply/follow-up and none changed response attribution.

## Quality controls

- Review shards were bounded to small manual packets.
- Every result file was validated against the source packet for cardinality, ID equality, enum values, and evidence hygiene.
- IDs/addresses in reviewer records are local-only; aggregate reports omit them.
- No RDS mutation, PMS mutation, or mail send occurred.

## What the historical method reported

- Captured Centurion mail appeared inbound-heavy in this retained snapshot.
- The observed outbound corpus appeared overwhelmingly document/workflow delivery, not a training corpus of free-form reservation replies.
- The prior low observed staff-response count was not explained by the other 25 retained RDS messages examined for that snapshot.

## What it cannot prove

- It cannot establish current thread-state, a live queue, or whether any previously reviewed case is now resolved.
- It cannot show mail sent through a system that is not retained in this RDS corpus.
- Former `no observed response` means **“no qualifying response observed in the reviewed retained snapshot,”** not that no reply was ever sent.
- It cannot infer that a template was triggered automatically versus manually without an authoritative send-event audit.

## Historical source report

See `docs/infor-hms/centurion-mailbox-audit-2026-08-09.md` for preserved historical aggregates. For current operational trust status and required evidence, see `docs/infor-hms/centurion-thread-state-status-2026-08-10.md`.
