# Jarat Tours outbound shuttle templates

Extends [the 2026-10-26 shuttle corpus](2026-10-26-shuttle-corpus.md): that report verified a Jarat outbound message in the Faith export, but did not give per-mailbox coverage for all five DV mailboxes.

## Coverage and method

The local Faith/Ayanda export results below reuse the prior thread review. Da Vinci, Epick and Kmgidi counts come from a read-only production snapshot taken 2026-10-27. The query counted distinct outbound messages and thread IDs where a direct To/Cc recipient matched a Jarat domain; it had no time-window filter. The aggregate query inspected subject/body only for rows passing that recipient filter and returned counts rather than message text. A separate extraction selected subject/body only from those matching rows and reduced samples to placeholders before review; its response contained eight of Epick's 18 matching rows and no Kmgidi body row. Kmgidi's template shape is therefore based on aggregate field cues, not a sentence-level sample. Faith/Ayanda are the 2026-10-19 local-export snapshot, so their counts are not a current-production census.

| DV mailbox | Outbound messages | Threads | Source |
|---|---:|---:|---|
| Faith | 1 | 1 | Prior manual review of the local export ([source](2026-10-26-shuttle-corpus.md#2-provider-emails)) |
| Ayanda | 0 | 0 | Prior review of the local export |
| Da Vinci | 0 | 0 | Read-only production snapshot |
| Epick | 18 | 15 | Read-only production snapshot |
| Kmgidi | 8 | 7 | Read-only production snapshot |

The two local-export mailboxes and three production mailboxes are counted independently; thread IDs were not deduplicated across mailboxes.

## Field cues

Faith's single message was manually reviewed in the prior report: flight 1/1, drop-off time 1/1, pickup time 0/1, passenger-count/`pax` mention 1/1, explicit guest-name field 0/1, confirmation number 0/1, and price 0/1.

For Epick and Kmgidi, these are broad keyword-presence counts across each mailbox's matching messages, not confirmed structured fields. Categories can overlap.

| Keyword cue | Epick | Kmgidi |
|---|---:|---:|
| Flight / airline | 6/18 | 7/8 |
| Pickup / drop-off wording | 16/18 | 1/8 |
| Airport | 17/18 | 3/8 |
| Pax / passenger / person / guest | 14/18 | 8/8 |
| Explicit guest-name label | 0/18 | 0/8 |
| Confirmation / booking-reference wording | 2/18 | 3/8 |
| Price / rate / cost / amount / currency token | 12/18 | 7/8 |

Price-token matches do not establish a valid rate, a price field, or who pays whom. The private artifact below contains placeholder-only normalized shapes; this Git report contains no message-body excerpts or guest data.

## Limits and output

Zero matches mean no outbound message to those domains was found in the mailbox source and snapshot named above; they do not establish absence of other shuttle traffic. Keyword counts are cues for template design, not evidence that every message requests every field. No live HMS state, rate, billing route, or mandatory provider field was verified.

Anonymized template shapes are stored outside Git at `/home/ubuntu/projects/zero/.private/templates/jarat-outbound.md` (file mode `0600`).
