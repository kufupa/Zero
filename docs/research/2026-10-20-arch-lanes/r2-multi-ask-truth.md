# R2 — Multi-ask truth in real mail

## Readout

- Best card unit: one guest × one full arrival/departure date set. Keep a parent mail/thread above those cards. Inference from linked staff letters and extracted date sets.
- Core quote/booking set: 9/164 complete threads had 2+ linked guest/date cases: 6/164 had several guests with the same dates; 3/164 had several guests across different dates. No one-guest/multiple-date HRCEN case in that linked subset.
- Broad external non-OTA set: 5/3,689 one guest/multiple date sets; 37/3,689 several guests/same dates; 6/3,689 several guests/different dates.
- Staff output: 33 core guest/date cases, 34 unique confirmation IDs, each ID in a separate outbound HRCEN message. No linked multi-case thread bundled all letters in one outbound message.
- Extractor: mostly preserved date sets, but not guest-to-stay links. In core multi-case threads, 10 stay objects cover 33 guest/date cases and have no guest field; full linked date ranges covered in 7/9 threads, missed in 2/9. Kind correctness is not independently scoreable from this cohort.

## 1. Evidence and limits

Reused `docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md`: definitions, first-reply and HRCEN matching, the core cohorts, and the Appendix script. L1 defines 189 core quote/booking inbound messages across 164 threads; 4,941 broad external non-OTA inbound messages; and the supplied 17/164 (2+ core asks), 10/164 (2+ extracted arrivals), and 9/164 (2+ linked guest/arrival cases) cohorts (`docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:16-26,185-204`). This pass counted distinct broad thread IDs: 3,689. L1’s matching method and its limits are at `docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:20-25,464-563,708-729`.

Shape labels below use guest subject plus full arrival/departure from matched HRCEN letters. L1’s case definition used guest subject plus arrival (`docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:723-729`); this pass also parsed departure from the same local PDF text. Departure parsed for 33/33 core guest/date cases and 147/147 broad cases. This is an extension of L1’s linked sample, not a recall estimate. L1 manually supported 30/30 sampled accepted core links; that checks precision only, not unmatched-letter recall (`docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:22-25,59-67,216`).

Latest stored extraction per message was used, as in L1; its corpus is historical (2026-10-13), has mixed extractor versions, and the old payload lacked the newer action field (`docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:16-19`). Current-repo code gates reads by prompt version and stores a versioned extraction row (`apps/server-pilot/src/ai/extraction/inbound-run.ts:255-257`; `apps/server-pilot/src/db/schema/work.ts:99-119`). So corpus rates describe saved production output, not a rerun of this snapshot.

Required context/research files were read and reused: `docs/context/FACTS.md`, `docs/research/README.md`, `docs/research/CATALOG.md`, `CONCEPTS.md`, `docs/context/MISTAKES.md`, plus the named architecture, README, P1 plan, and Grok P1 review. The exact requested `p2-scope-grok46.md` was not present; no substitute used. No `.codegraph` index was present, so no `codegraph explore`. Snapshot `origin/main 3e1acb694` is requester-provided; no Git command was run. No tests, installs, network, HMS, prod, or writes outside this output file.

## 2. Multi-ask shapes

Fractions use all core quote/booking threads (`/164`) and all external non-OTA threads (`/3,689`). Parentheses show the matched multi-case subset (`/9` core, `/48` broad), not full-cohort truth.

| Shape, from linked letters | Core | Broad external non-OTA |
|---|---:|---:|
| One guest, multiple full date sets | 0/164 (0/9) | 5/3,689 (5/48) |
| Several guests, same full date set | 6/164 (6/9) | 37/3,689 (37/48) |
| Several guests, different full date sets | 3/164 (3/9) | 6/3,689 (6/48) |
| Total linked multi-case threads | 9/164 | 48/3,689 |

Core case totals: 33/9 guest/date cases and 34/33 confirmation IDs. Broad totals: 147/48 cases and 148/147 IDs. One core case and one broad different-date case had an extra confirmation ID. L1’s original bucket table shows the same core 33 cases / 34 IDs (`docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:187-204`).

“0/164” for one guest/multiple dates means none among the 9 core threads with 2+ linked HRCEN cases—not no multi-date requests. Separately, 10/164 core threads had 2+ extracted arrivals; three had a later inbound add an arrival after a distinct date was already present. Broad equivalents: 19/3,689 and 9/3,689. These are extractor-date signals, not guest truth. The letter linker assigned core multi-cases to one source inbound in 0/9 threads; broad cases were split across multiple source inbounds in 2/48 threads.

## 3. What staff sent

“HRCEN output mail” means an outbound mail carrying a linked HRCEN confirmation attachment. L1 links these by recipient, guest, arrival, thread, and time; it parses HRCEN IDs from filenames (`docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:22-25,406-436,493-563`).

| Matched shape | Threads / cohort | Guest/date cases / threads | Unique confirmation IDs / cases | HRCEN outbound mails / IDs | Threads with every letter in one outbound mail |
|---|---:|---:|---:|---:|---:|
| Core — several guests, same dates | 6/164 | 17/6 | 17/17 | 17/17 | 0/6 |
| Core — several guests, different dates | 3/164 | 16/3 | 17/16 | 17/17 | 0/3 |
| Core total | 9/164 | 33/9 | 34/33 | 34/34 | 0/9 |
| Broad — one guest, multiple dates | 5/3,689 | 10/5 | 10/10 | 10/10 | 0/5 |
| Broad — several guests, same dates | 37/3,689 | 110/37 | 110/110 | 110/110 | 0/37 |
| Broad — several guests, different dates | 6/3,689 | 27/6 | 28/27 | 28/28 | 0/6 |
| Broad total | 48/3,689 | 147/48 | 148/147 | 148/148 | 0/48 |

Core multi-case threads had one first-reply anchor each (9/9); linked HRCEN confirmations came as separate outbound mails (34/34 IDs). Across the 17/164 threads with 2+ core ask messages, 7/17 had one unique first reply, 9/17 had two, and 1/17 had four. 5/17 mixed `quote` and `booking` across separate inbound messages; not same-mail mixed actions.

For quotes, the L1 filename screen found Quote-marked outbound assets in 3/17 repeated-ask threads, but 0/10 threads with 2+ extracted arrivals. No evidence here of one combined quote PDF covering multiple date sets. This is a filename match, not proof of document contents; L1 warns filename/MIME markers do not establish meaning (`docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:24,438-453,219`).

## 4. Extractor output vs linked stay truth

Current schema has one scalar `kind` and one scalar `action`; the stored payload has a top-level `confirmationNumbers[]` beside `stays[]` (`apps/server-pilot/src/ai/extraction/schema.ts:32-45,57-64`). Each stay holds requested/booked dates, room totals and room rows, but no guest field (`apps/server-pilot/src/ai/extraction/schema.ts:60-99`). Prompt says one stay per distinct date set (`apps/server-pilot/src/ai/extraction/extract.ts:54`). Confirmation IDs must match source text verbatim (`apps/server-pilot/src/ai/extraction/schema.ts:209-223`). Each inbound run reads one inbound message and stores one `kind` plus payload (`apps/server-pilot/src/ai/extraction/inbound-run.ts:247-253,352-360`).

| Check on linked multi-case sources | Core | Broad external non-OTA |
|---|---:|---:|
| Source inbound messages / threads | 9/9 | 50/48 |
| `stays[]` length 0 | 0/9 | 40/50 |
| `stays[]` length 1 | 8/9 | 9/50 |
| `stays[]` length 2 | 1/9 | 1/50 |
| Stay objects / guest-date cases | 10/33 | 11/147 |
| Stay objects with a guest field | 0/10 | 0/11 |
| Threads with all linked date ranges represented | 7/9 | 8/48 |
| Threads with at least one linked range missed | 2/9 | 40/48 |
| Threads with an extra extracted range | 0/9 | 0/48 |
| Non-empty source `confirmationNumbers[]` | 0/9 | 0/50 |

Core kind output: `booking` 8/9, `quote` 1/9. Broad: no extraction 40/50; `booking` 8/50, `quote` 1/50, `voucher_pop` 1/50. Wrong-kind count is **not scored**: the core cohort is selected by extracted `quote`/`booking` kind, and no independent mail-level truth labels exist in this corpus. Do not treat “0 wrong” as a finding. Broad is a sensitivity cut with unrelated mail and weaker intent; its 40/50 missing rows make an accuracy rate unsuitable.

Guest/date comparison: in core, 10 stay objects for 33 linked guest/date cases means 23 fewer separate objects than a per-guest/date card needs; 0/9 threads can assign those cases to stay-level guests because that field is absent. In broad, 11 objects for 147 cases; same structural loss. These are card-representation deficits, not proof that every individual date extraction is wrong.

Date check is better: linked HRCEN full ranges were covered in 7/9 core threads; two threads missed a linked range and none added an extra range. Broad: 8/48 complete coverage, 40/48 incomplete, no extra range; 49 per-thread linked date-range occurrences were absent (ranges can repeat across guests). Broad miss count is not a recall estimate because it includes non-stay mail and unreviewed links.

Zero source confirmation IDs is expected for initial requests under the source-text rule; outgoing confirmation IDs live in later staff letters. Still, extraction output alone cannot join the 34/33 core or 148/147 broad staff IDs back to guest/date cards. A separate artifact-link relation is needed (inference).

## 5. Mixed actions, later additions, groups

Same-mail mixed-action scan is only a phrase-co-occurrence screen: subject + first 1,400 normalized body characters; quoted history was not removed. Counts are candidate threads, not confirmed asks, and categories can overlap.

| Candidate phrase pair in one inbound | Core candidates /164 | Broad candidates /3,689 |
|---|---:|---:|
| Quote + amend/change | 4/164 | 100/3,689 |
| Booking + cancel | 2/164 | 158/3,689 |
| Voucher/POP + change | 0/164 | 68/3,689 |

No verified same-mail mixed-action truth rate can be reported from these hits. Historical payload has one `kind` and no action field (`docs/research/2026-10-20-arch-lanes/l1-linkage-domains.md:17`); current action classifier asks for exactly one action (`apps/server-pilot/src/ai/extraction/extract.ts:68-70`).

| Group/rooming signal screen | Core /164 | Broad /3,689 |
|---|---:|---:|
| Extracted `totalRooms >= 12` | 12/164 | 27/3,689 |
| Body/subject says `12+` guests/pax/people | 7/164 | 145/3,689 |
| Body/subject contains rooming-list/room-list phrase | 5/164 | 125/3,689 |
| Inbound attachment filename contains rooming-list/room-list phrase | 0/164 | 19/3,689 |

Raw text screens include quoted history; not confirmed group counts. Room count is not guest count. In the 17 repeated core-ask threads, 2/17 have extracted totals of 18 and 35 rooms; neither proves the number of guests. No exact ≥12-guest / rooming-list truth count was manually adjudicated. Current code maps `group_event` to >12 guests or rooming lists, while quote availability includes 12 or fewer (`apps/server-pilot/src/ai/extraction/extract.ts:71-78`); the historical `kind` vocabulary has no `group_event` (`apps/server-pilot/src/db/schema/work.ts:23-32`).

## 6. Card recommendation

**Inference:** keep one thread/mail parent, then one stay card per guest × full date set. A guest with two date sets gets two cards; two guests on the same dates get two cards; guests across different dates get separate cards. Linked staff evidence supports this: 33/9 core guest/date cases had 34/33 separate confirmation IDs, and the broad sample also shows one guest can have multiple dates.

Do not force quote and booking into different card identities. Let a quote parent share a response artifact across its stay cards if staff practice supports that; this sample does not prove a combined-PDF rule (0/10 core multi-arrival quote-file matches). On booking, preserve each guest/date card and its own confirmation ID: 34/34 linked core IDs and 148/148 broad IDs were sent in separate outbound HRCEN mails, not bundled into one thread reply.

For groups/rooming lists, safer inference: keep a group/date-set parent with roster/room rows beneath; create guest/date cards when staff’s actual confirmations split that way. Current data does not settle that group exception. Mixed-action mail likely needs multiple action tasks under the same mail parent, linked to the affected stay cards; current schema’s one-action field cannot express that (`apps/server-pilot/src/ai/extraction/schema.ts:32-45`; `apps/server-pilot/src/ai/extraction/extract.ts:68-78`).
