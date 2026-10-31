# HMS Cloud: Labtest writes and reservation-note memory

The 31 October run extended the new Cloud tools and verified two fake stay lifecycles in the real Centurion HMS. It did not deploy or enable a staff workflow. The detailed [plan](../../plans/2026-10-31-001-feat-hms-write-and-memory-plan.md) records the scope and decisions; the [previous build retro](2026-10-31-hms-cloud-build-retro.md) covers the 30 October run.

## What is available

| Capability | What was actually verified | Change |
|---|---|---|
| Guest + A/R + guarantee | Two unsaved fake drafts retained the verified guest and A/R while selecting a guarantee. | [#782](https://github.com/kufupa/Zero/pull/782) |
| Rate after A/R | Five unsaved draft cases covered A/R alone, guest plus A/R, replacement, and the existing blank/guest cases. | [#787](https://github.com/kufupa/Zero/pull/787) |
| New fake stay | A date-specific preimage, verified fake profile, room, rate, guarantee and unsent CMS state gate a single save. A fresh reader verifies the resulting confirmation. | [#785](https://github.com/kufupa/Zero/pull/785) |
| Saved fake stay: amend note | Only Reservation Note / Billing Instructions is supported. The action checks the clean record and complete saved payload, then requires independent readback. | [#786](https://github.com/kufupa/Zero/pull/786) |
| Saved fake stay: cancel | Opens the live reason picker and confirms the Test Reservations reason only for the checked fake stay; a later fee warning is returned and left untouched. | [#788](https://github.com/kufupa/Zero/pull/788) |
| Booking agent session | An opt-in fake-stay preimage precedes the blank form; `saveNewLabtestStay` takes the current preimage ID and explicit fields. Same-page calls are queued, snapshotted and rejected after closure. | [#789](https://github.com/kufupa/Zero/pull/789) |
| Saved-stay agent session | Separate same-page `read`, `amendNote`, `openCancel`, and `confirmCancel` actions; the full reader results and available ambiguous-candidate context are retained. | [#790](https://github.com/kufupa/Zero/pull/790), review in progress |
| Note memory | Query historical Reservation Note / Billing Instructions patterns and bounded pages of full private observations with source and provenance. | [#784](https://github.com/kufupa/Zero/pull/784) |
| Read-only guard | Blocks the observed cloud save indicated by `pageaction=SAVE` in the query string as well as form-action values. | [#783](https://github.com/kufupa/Zero/pull/783) |

The saved-record session uses the existing shallow/record readers; after Record View is open, use a fresh session for another record. A weak single-candidate hint was corrected on the same page during a live check. Retry after a multi-candidate ambiguity has not been established; start a fresh session.

## Actual fake-stay evidence

Two newly created, separate HRCEN Proof Labtest stays were independently read back as Reserved after save, with the expected identity, dates, room, rate, synthetic note and unsent CMS fields. Each was changed through the note tool, then independently read again. Both were subsequently cancelled using the Test Reservations reason and independently read back as Cancelled.

**Cancellation warning:** on each fake stay, HMS showed a possible penalty *after* the status had changed. We did not accept either warning. Both records showed a zero balance at readback; that does not prove HMS cannot post a fee later. A warning does not itself prove a charge, and leaving it untouched does not make the cancellation fee-free. This is evidence for fake stays, not a general real-guest cancellation capability or fee policy.

CMS Send was off and the recipient and guest email fields were blank. The browser observed no send request; that does not prove what HMS may queue server-side. The earlier fake stay with a recorded hold was not modified. Live diagnostics, identifiers and private captures are kept outside Git under `/home/orca/.local/share/zero/research/halloween/hms-write-overnight-20261031/`.

A timeout or dialog can occur after a request has been dispatched. The modules return an uncertain or pending outcome and quarantine the page; the caller must reopen and reconcile the record before retrying. An invalid cancellation note consumes the one-shot reason picker; reopen the stay in a fresh session.

## How the memory is useful

The memory accepts E-Mail, Voice Call and Call Center source labels, and distinguishes exact address from domain and outbound recipient from independently linked inbound sender. Across 612 eligible observed confirmation numbers in those three sources, the earlier analysis found 350 with an agency, 452 with an organization and 150 with an A/R account. These are observed historical clues, not confirmed current selections or independently established booking causes.

For the 492 E-Mail-source observations, 491 had a populated reservation note and there were 295 distinct exact note texts. Exact-pattern summaries keep material text differences such as amounts and negations; they do not infer that similar instructions or prices are interchangeable. The default bounded result includes previews and counts. `notePage` can retrieve full original wording and observation provenance privately. A future agent can use those observations as context, then decide against the current request and HMS; this does not automatically learn staff corrections or encode hotel policy.

The earlier [note analysis](memory-experiments/2026-10-30-email-reservation-note-patterns.md) found that 416 of the 491 nonblank notes had an exact or near-text neighbour using a character-similarity heuristic. One cluster of 127 mentioned DBB, payment to the agent, extras direct and government dinner at R210; all 127 carried the NGOVDB rate plan. This suggests useful examples for the agent, but the similarity score and historical amount do not establish equivalent instructions or today's policy.

## Coverage and remaining work

- Real-guest save, amendment and cancellation are not supported or authorized by these Labtest modules. The note is the only saved-stay field whose amendment was verified in this slice; a separate lane is exploring a room upgrade.
- The client-designated quote screen remains **Hotel Availability**. Prior exploratory checks covered 12 adult-only requests; historical child age bands are not exact child ages, and that sample is not a production accuracy claim.
- Pane integration, deployment, staff correction learning and a database migration were not part of this run. No real-guest write or deliberate email send was initiated.
- Inbound-to-booking linkage remains incomplete: a separate session recorded automatic execution denials for the source manifest, association check, inspection edits and PR #764 merge. The recorded merge denial said `Blocked by fast classifier`; the other exact reasons were not preserved. Those denied actions were not retried or routed around.
- Nine finished owned worktrees were removed through Orca. Orca retained one branch whose squashed changes were no longer direct ancestors. Other trees were left in place when their terminal handles were stale while processes still existed, or when they contained another session's work.

## Verification and pace

Substantive PRs use same-head Greptile Apex and hosted review, Product EC2 typecheck and the existing HMS production-boundary test, with the coordinator reading each product diff. The boundary test is a release check, not a substitute for testing the new module against HMS. Valid P1 findings on the save fence and amendment's dirty-field protection were fixed and live-checked; P2 requests for extra synthetic tests were not treated as a reason to add mock suites. Reviews and independent lanes ran concurrently.

The earlier 30 October run produced 26 feature/fix PRs in about 3 hours 52 minutes, with a median 11.8 minutes from PR opening to merge; that median excludes coding and probing. This run's first overnight feature PR opened at 02:52 UTC and the booking-session PR merged at 03:38 UTC. A single full write feature took longer than a one-click save because the live response, full record payload, independent readback and a valid review finding had to be reconciled; the simple docs/skill updates were pushed directly.
