# Da Vinci: recorded inbound email

Read-only production aggregate, observed 2 November 2026 at 11:04 South African time. Windows are 30 days and end exclusive. Counts include OTA and automated messages.

| Mailbox | To 2 Nov 11:04 SAST | To 30 Oct 17:00 SAST |
|---|---:|---:|
| Da Vinci reservations | 1,894 | 1,770 |
| Ayanda | 1,731 | 1,589 |
| Faith | 1,948 | 1,856 |
| Elizabeth | 1,840 | 1,750 |
| Khanyisile | 1,372 | 1,304 |
| **Five Da Vinci inbox copies** | **8,785** | **8,269** |
| **Five Da Vinci inboxes, distinct Message-ID proxy** | **6,962** | **6,609** |
| Nava AI transport, separate from Da Vinci | 462 | 462 |

The five Da Vinci mailboxes have repeated copies of some messages. Distinct counts normalize `message_id_header` and collapse the same ID across mailboxes; all rows in these two windows had a Message-ID. Counts by mailbox count recorded incoming rows.

**Coverage:** Da Vinci's recorded inbound data starts 7 October for Ayanda and 8 October for the other four, so neither window has a full 30 days of recorded history. Nava AI has no recorded inbound after 16 October. These are recorded volumes, not proof of complete delivery.

## Rough 30-day projection

| Da Vinci mailbox | Projected inbox copies |
|---|---:|
| Da Vinci reservations | 2,290 |
| Ayanda | 2,001 |
| Faith | 2,355 |
| Elizabeth | 2,224 |
| Khanyisile | 1,659 |
| **Total copies** | **10,528** |
| **Estimated unique emails** | **8,343** |

For each mailbox, multiply its recorded count by 30 and divide by the elapsed days from its first recorded message to 2 November 09:04:42.953 UTC. Sum the unrounded mailbox estimates, then apply the observed distinct-to-copy ratio of `6,962 / 8,785`; rounding the individual rows separately produces a one-email difference. This assumes each inbox's recorded rate and the cross-inbox overlap remain similar throughout the month. Nava AI is excluded from this Da Vinci projection.

**Method:** On Product EC2, `BEGIN READ ONLY`, then aggregate the production `message` table by `transport_id` where `direction='inbound'` and `COALESCE(received_at, sent_at, created_at)` falls in each UTC window; roll back. The 2 November window is `2026-10-03T09:04:42.953Z` to `2026-11-02T09:04:42.953Z`. The comparison window is `2026-09-30T15:00:00Z` to `2026-10-30T15:00:00Z`, matching the [Centurion 30-day report](2026-11-02-30-day-future-scope.md). The five transport IDs are `transport-davinci`, `transport-ayanda`, `transport-faith`, `transport-epick`, and `transport-kmgidi`; `transport-nava` is shown separately. An independent aggregate confirmed the earliest and latest recorded inbound for each transport. No model calls or message bodies were needed.
