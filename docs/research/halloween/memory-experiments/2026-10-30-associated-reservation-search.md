# Search for associated reservations

> Historical findings from 30 October 2026; implementation status may have changed since this analysis.

Read-only exploration on 30 October 2026. The sample came from 892 successful
Centurion confirmations in the existing outbound-confirmation corpus. It was
deliberately targeted; it does not estimate how common links are at the hotel.
Raw guest data and screenshots remain in the private Halloween data directory.

## Result

Sixty distinct stays were read successfully. **None of their loaded Associated
Reservations grids showed a different confirmation.** Thirty-six grids were
empty; 24 showed only the stay being viewed. These are in addition to six
earlier checks, which also found no other confirmations.

| Sample | Selection | Read | Empty | Current stay only | Other confirmation |
| --- | --- | ---: | ---: | ---: | ---: |
| First 30 | Same message or same profile/name and dates; 15 clusters | 30 | 26 | 4 | 0 |
| Second 30 | Reserved/in-house snapshots with same outbound recipient and dates; 15 clusters | 30 | 10 | 20 | 0 |

In the first 30, ten shared an outbound message and dates with another corpus
confirmation, and 20 shared a guest profile and dates. All 30 shared an
outbound recipient and dates. In the second 30, all shared an outbound recipient
and dates, and 28 also shared the recorded agency/organization/A/R combination
and dates. These are clues, not evidence of a PMS association; an outbound
recipient is not necessarily the sender of an inbound booking request.

By the earlier corpus snapshot, the 60 comprised 24 Reserved, 24 Checked Out,
11 In-house and one Cancelled. Every Reserved snapshot showed its own row;
the others showed empty grids. Statuses can change after the snapshot. The
previously checked stay with a populated Group field was the only such field in
the 892-record corpus, and its grid was empty.

Two second-sample lookups initially failed because their live arrival dates were
one day earlier than the corpus snapshot. Both had one complete search result
whose guest name matched the historical record and PDF hint. They were retried
using the current arrival date and guest name together and succeeded.

## Interpretation and limitations

The results do not prove that the hotel never links multi-room stays. Matching
dates, recipient or guest profile does not mean staff explicitly associated the
reservations. Also, the reader has not yet been verified on a Centurion grid
showing a second confirmation, and it captures rendered, loaded rows only.

An earlier **28 October** Da Vinci (`HRDAV`) Labtest demonstrated the workflow:
adding a second room through Associated Reservations produced two separate
confirmations (Labtest identifiers retained privately), which the operator observed on
both records. That is historical evidence for a different property, not a
Centurion result or a fresh positive test of this reader. Its accompanying
Group value was populated; this does not establish a universal rule.

On all 24 self-only grids, the store reported a total of zero despite one
loaded row. The reader now flags a total/count mismatch as possibly truncated;
earlier batch output was captured before that correction. Even matching counts
do not independently prove there are no unloaded pages. One self-only and two
empty grids were unchanged after an additional ten-second wait; these checks
are not a positive-control test.

The most useful next validation is a known linked Centurion pair, or a suitable
existing Labtest pair on the same screen, checked against the live UI and reader.
No real-guest booking was created or edited during this search.

## Private evidence

The consolidated 60 reads, sample selection, retries, summaries and screenshots
are under `/home/orca/.local/share/zero/research/halloween/associated-reservations-20261030/`.
The consolidated file is `results-all-60.private.json`; it recomputes the 24
count-mismatch warnings and records the original flags. The original batches
and the two successful retries are preserved separately.
