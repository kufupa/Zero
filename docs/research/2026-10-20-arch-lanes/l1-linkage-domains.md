# L1 — request → reply → HMS letter linkage and sender-domain map

## Answer

- The primary set is 449/8,892 inbound messages classified as quote or booking in the full corpus window. It splits into 189/449 external non-OTA, 68/449 own-domain, and 192/449 listed-OTA messages.
- A reply anchor was found for 103/189 core external non-OTA asks and 122/449 primary asks. For core asks, 95/189 replies were same-thread and 8/189 were exact-address cross-thread.
- In the ±30m window after the first staff reply, 39/103 core asks linked to an HRCEN letter (39/189 of all core asks). In the +3d window, 31/88 eligible core asks linked (31/189 of all core asks).
- At ±30m, 14/103 core asks linked a filename-matched hand Quote PDF, 0/103 Excel, 2/103 a Proforma-named PDF, and 3/103 a separate PDF with a Proforma text marker. 13/103 first replies had no non-inline attachment.
- Broad-cut numbers are much less specific: 1,428/4,941 external non-OTA inbound messages had a reply anchor; 174/1,428 linked HRCEN within ±30m. This cut includes non-stay mail, so do not use it as the stay-request rate (inference).
- Among 95 unique core first-reply messages, a body-level co-occurrence scan found 4/95 confirmation, 38/95 Proforma, 40/95 other-document, and 40/95 any-document flags; 45/95 matched a booking-made/status regex. 3/95 typed an 8-digit-1-shaped token.
- Sender profile lines are mixed for large generic domains: Gmail had 34 profile variants/108 letters (largest variant 21/108); Nexustravel had 5/35 (largest 12/35); Atlantis Corporate had 5/37 (largest 27/37). A fixed profile per domain is not safe to assume (inference).
- 9/164 core request threads had at least two linked guest/date letter cases; all 9/9 used separate confirmation numbers. A combined quote/new-booking stay flow with a payment-state branch is the simplest pane shape (inference).

## Method

- Read-only source: /home/orca/nava-research/corpus/2026-10-13. Observed message timestamps span 2026-07-30T18:30:59Z to 2026-10-13T17:54:13Z. This lane did not touch the supplied prod SQL evidence, HMS, network, or git.
- Corpus has 12,433/12,433 message rows: 8,892 inbound and 3,541 outbound, for 2026-07-30..2026-10-13. The latest extraction row per message was used. The payload action field was not found; quote/booking uses extraction kind.
- Own domain means legacyhotels.co.za or legacyhotels.com, including subdomains. OTA exclusion uses the supplied substring list: synxis, booking.com, expedia, webbeds, hotelbeds, profitroom, siteminder, ratetiger, tiket.
- “Primary” means latest extraction kind quote or booking. “Core” means primary plus external non-own, non-OTA sender. “Broad” means every external non-own, non-OTA inbound message: 4,941/8,892.
- Reply anchor: first own-domain staff outbound after the inbound in the same thread. If none, first own-domain outbound to the exact sender address in To/Cc within 72 hours, accepted only when exactly one inbound from that sender falls from the ask through that outbound. Ambiguous exact-address candidates are not anchors. Broad anchors are a sensitivity set, not proof of reservation intent (inference).
- Windows are relative to the first staff reply: symmetric ±30m, ±60m, ±3h, then [reply, reply+72h]. For censoring, the date-labelled export was treated as complete through 2026-10-13 23:59:59 UTC. The actual last message is earlier; see Open gaps.
- HRCEN match score: +4 exact sender address in To/Cc, +1 sender domain in To/Cc, +3 exact surname token from the letter subject in ask text/extraction, +3 exact Arrival date match, +2 same thread. Accept only score ≥7, at least two independent key families (recipient counts as one), and no arrival-date conflict unless same thread; same-thread still requires recipient match. Each letter is assigned only to a unique highest-scoring ask; ties are dropped.
- HRCEN inventory: 1,180/9,859 non-inline own outbound attachment rows; 1,179/1,180 had an Arrival date parsed; 1,127/1,180 had a parseable confirmation-letter subject; 655/1,180 distinct 8-digit confirmation IDs. Six/1,180 HRCEN-prefix attachments lacked an 8-digit filename ID and were excluded from confirmation-letter matching; their exact type is not found.
- Other assets are non-inline own-domain outbound attachments. Excel uses extension/MIME; Quote uses a filename word boundary; Proforma is split into filename signal and PDF-text-only signal (first 5,000 characters). HRCEN is not also counted as Proforma. Other-asset links require sender address or domain in recipient To/Cc and the requested time window; same-thread domain matches are accepted, while cross-thread matches require exact address and exactly one inbound from that sender within ±72h of the attachment. Text-only means no non-inline attachment on the first reply and no tracked asset linked by +3d; it is conservative, not “no attachment of any kind.”
- Manual match check: 30/57 unique high-confidence core HRCEN confirmation links in the +3d window were sampled with seed 20261020. One masked reviewer checked recipient, surname, arrival, thread, and date conflict; verdicts are below. This is precision checking of accepted links, not recall checking.
- All table counts use Python 3 stdlib gzip/json, as pasted in Appendix. Counts are message-level unless a column says attachment, conf ID, thread, profile line, or unique guest. Asset categories may overlap at request level.

## Findings (tables)

### Reply anchors

Counts are over the full corpus window. “Asks” numerator/denominator is primary messages or broad inbound messages. Reply columns use the cohort denominator.

| Cohort | Messages | Same-thread reply | Exact-address cross-thread unique | Ambiguous exact candidate | No anchor | Anchored |
|---|---:|---:|---:|---:|---:|---:|
| All quote/booking | 449/8,892 inbound | 108/449 | 14/449 | 16/449 | 311/449 | 122/449 |
| Core external non-OTA quote/booking | 189/449 primary | 95/189 | 8/189 | 8/189 | 78/189 | 103/189 |
| Broad external non-OTA inbound | 4,941/8,892 inbound | 1,040/4,941 | 388/4,941 | 290/4,941 | 3,223/4,941 | 1,428/4,941 |

### Linked outputs by reply window

Each outcome cell is matched request messages / eligible reply-anchored messages; the second fraction is matched messages / the full cohort. Example: 39/103; 39/189. A request can link more than one kind of asset. HRCEN outcomes mean confirmation-letter attachments with an 8-digit filename ID; six other HRCEN-prefix attachments were inventory-only, not scored.

| Cohort | Window | Eligible / cohort | HRCEN | Quote PDF | Excel | Proforma filename | Proforma PDF-text-only marker | First reply no non-inline | Strict text-only through +3d |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| All primary, N=449 | ±30m | 122/449 | 39/122; 39/449 | 14/122; 14/449 | 0/122; 0/449 | 2/122; 2/449 | 4/122; 4/449 | 15/122; 15/449 | — |
| All primary, N=449 | ±60m | 122/449 | 41/122; 41/449 | 14/122; 14/449 | 0/122; 0/449 | 2/122; 2/449 | 5/122; 5/449 | 15/122; 15/449 | — |
| All primary, N=449 | ±3h | 122/449 | 41/122; 41/449 | 14/122; 14/449 | 0/122; 0/449 | 2/122; 2/449 | 5/122; 5/449 | 15/122; 15/449 | — |
| All primary, N=449 | +3d | 101/449 | 31/101; 31/449 | 11/101; 11/449 | 0/101; 0/449 | 4/101; 4/449 | 6/101; 6/449 | 12/101; 12/449 | 8/101; 8/449 |
| Core non-OTA, N=189 | ±30m | 103/189 | 39/103; 39/189 | 14/103; 14/189 | 0/103; 0/189 | 2/103; 2/189 | 3/103; 3/189 | 13/103; 13/189 | — |
| Core non-OTA, N=189 | ±60m | 103/189 | 40/103; 40/189 | 14/103; 14/189 | 0/103; 0/189 | 2/103; 2/189 | 4/103; 4/189 | 13/103; 13/189 | — |
| Core non-OTA, N=189 | ±3h | 103/189 | 40/103; 40/189 | 14/103; 14/189 | 0/103; 0/189 | 2/103; 2/189 | 4/103; 4/189 | 13/103; 13/189 | — |
| Core non-OTA, N=189 | +3d | 88/189 | 31/88; 31/189 | 11/88; 11/189 | 0/88; 0/189 | 2/88; 2/189 | 5/88; 5/189 | 11/88; 11/189 | 7/88; 7/189 |
| Broad non-OTA, N=4,941 | ±30m | 1,428/4,941 | 174/1,428; 174/4,941 | 40/1,428; 40/4,941 | 1/1,428; 1/4,941 | 24/1,428; 24/4,941 | 67/1,428; 67/4,941 | 263/1,428; 263/4,941 | — |
| Broad non-OTA, N=4,941 | ±60m | 1,428/4,941 | 167/1,428; 167/4,941 | 40/1,428; 40/4,941 | 2/1,428; 2/4,941 | 24/1,428; 24/4,941 | 73/1,428; 73/4,941 | 263/1,428; 263/4,941 | — |
| Broad non-OTA, N=4,941 | ±3h | 1,428/4,941 | 164/1,428; 164/4,941 | 42/1,428; 42/4,941 | 4/1,428; 4/4,941 | 31/1,428; 31/4,941 | 81/1,428; 81/4,941 | 263/1,428; 263/4,941 | — |
| Broad non-OTA, N=4,941 | +3d | 1,349/4,941 | 141/1,349; 141/4,941 | 37/1,349; 37/4,941 | 4/1,349; 4/4,941 | 32/1,349; 32/4,941 | 90/1,349; 90/4,941 | 244/1,349; 244/4,941 | 225/1,349; 225/4,941 |

### Manual HRCEN-link review

Sample was 30/57 unique HRCEN conf IDs assigned to core requests with a complete +3d window. No guest/date values are shown. All 30/30 verdicts supported; 0/30 had a date conflict.

| Masked pair IDs | Visible key families | Verdict |
|---|---|---|
| A01, A05, A28 | Exact recipient + arrival | Supported, 3/30 |
| A02–A04, A06–A20, A22–A27, A29–A30 | Exact recipient + surname + arrival | Supported, 26/30 |
| A21 | Exact recipient + surname; arrival unavailable | Supported, 1/30 |

### Text promise signals in first replies

Denominator is 95 unique core first-reply messages (from 103/189 core request→reply pairs). Each document flag means a document term and a future-send/follow term both appear somewhere in the normalized full body; there is no sentence or proximity check. These are regex flags, not human-coded intent. The three document families overlap; the union is deduplicated.

| Signal family | Flagged reply messages |
|---|---:|
| Confirmation/future-send or follow language | 4/95 |
| Pro forma/future-send or follow language | 38/95 |
| Other document/future-send or follow language | 40/95 |
| Any future-document family | 40/95 |
| Booking-made / reservation-status wording (inference) | 45/95 |
| Any 8-digit token, optional “-1” suffix | 4/95 |
| Exact 8-digit-1 suffix shape | 3/95 |

### Asset choice by request features

Complete +3d core cohort is 88/189 requests. In each row, feature-group count is requests / 88; asset cells are linked request messages / that feature-group size. Categories can overlap. Rooms use maximum extracted room count; nights use maximum extracted stay length. “Direct/other” includes missing agency and end-client labels. Rate uses a keyword scan of subject/body; priority is government, contract, BAR, then not explicit. Lead time uses earliest extracted arrival from received date.

| Feature | Group | Requests | HRCEN | Quote PDF | Excel | Proforma filename | Proforma PDF-text marker |
|---|---|---:|---:|---:|---:|---:|---:|
| Rooms | <10 | 67/88 | 30/67 | 7/67 | 0/67 | 1/67 | 5/67 |
| Rooms | 10+ | 9/88 | 1/9 | 2/9 | 0/9 | 1/9 | 0/9 |
| Rooms | Unknown | 12/88 | 0/12 | 2/12 | 0/12 | 0/12 | 0/12 |
| Stay nights | 1–2 | 27/88 | 12/27 | 2/27 | 0/27 | 0/27 | 3/27 |
| Stay nights | 3–5 | 40/88 | 17/40 | 7/40 | 0/40 | 1/40 | 1/40 |
| Stay nights | 6+ | 5/88 | 0/5 | 1/5 | 0/5 | 1/5 | 0/5 |
| Stay nights | Unknown | 16/88 | 2/16 | 1/16 | 0/16 | 0/16 | 1/16 |
| Extracted sender profile | Agency | 69/88 | 29/69 | 8/69 | 0/69 | 2/69 | 5/69 |
| Extracted sender profile | Company/end-client only | 2/88 | 0/2 | 1/2 | 0/2 | 0/2 | 0/2 |
| Extracted sender profile | Direct/other | 17/88 | 2/17 | 2/17 | 0/17 | 0/17 | 0/17 |
| Rate clue | Government | 12/88 | 6/12 | 2/12 | 0/12 | 0/12 | 0/12 |
| Rate clue | Contract | 4/88 | 1/4 | 0/4 | 0/4 | 0/4 | 0/4 |
| Rate clue | BAR | 1/88 | 1/1 | 0/1 | 0/1 | 0/1 | 0/1 |
| Rate clue | Not explicit | 71/88 | 23/71 | 9/71 | 0/71 | 2/71 | 5/71 |
| Lead time | 0–6 days | 42/88 | 24/42 | 4/42 | 0/42 | 1/42 | 4/42 |
| Lead time | 7–30 days | 18/88 | 4/18 | 3/18 | 0/18 | 0/18 | 1/18 |
| Lead time | 31+ days | 14/88 | 2/14 | 3/14 | 0/14 | 1/14 | 0/14 |
| Lead time | Past arrival | 1/88 | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 |
| Lead time | Unknown | 13/88 | 1/13 | 1/13 | 0/13 | 0/13 | 0/13 |

No Excel match appears in these 88/189 complete core requests. Hand Quote and HRCEN overlap; this is descriptive, not a validated decision rule (inference).

### External sender-domain map

Top 30 domains ranked by core quote/booking asks: 154/189 asks across 30/65 domains that had at least one core ask. Domain thread counts are domain×thread pairs (3,715 total); outbound messages can be counted under more than one recipient domain (3,438 own outbound messages); HRCEN letters are unique confirmation IDs per recipient domain (655 total; domains can overlap). Distinct guests are unique parsed letter-subject names / parseable letter subjects; names are omitted. Say “not found” where no letter/profile data exists. All counts use the full corpus window.

| External sender domain | Inbound messages / 4,941 | Inbound threads / 3,715 | Outbound to domain / 3,438 | HRCEN conf IDs / 655 | Distinct guests / parsed subjects |
|---|---:|---:|---:|---:|---:|
| travelit.co.za | 180/4,941 | 180/3,715 | 0/3,438 | 0/655 | not found |
| gmail.com | 390/4,941 | 249/3,715 | 360/3,438 | 108/655 | 82/107 |
| nexustravel.co.za | 117/4,941 | 86/3,715 | 99/3,438 | 35/655 | 24/31 |
| lekkeslaap.co.za | 45/4,941 | 45/3,715 | 0/3,438 | 0/655 | not found |
| 360travel.co.za | 31/4,941 | 13/3,715 | 34/3,438 | 12/655 | 9/12 |
| amoebatsc.com | 15/4,941 | 7/3,715 | 16/3,438 | 3/655 | 2/3 |
| pepstores.com | 25/4,941 | 13/3,715 | 20/3,438 | 12/655 | 10/11 |
| travel.co.za | 66/4,941 | 45/3,715 | 32/3,438 | 10/655 | 10/10 |
| unica.co.za | 10/4,941 | 5/3,715 | 4/3,438 | 1/655 | 1/1 |
| allsportstravel.co.za | 15/4,941 | 5/3,715 | 9/3,438 | 0/655 | not found |
| amazing-africa.co.za | 77/4,941 | 45/3,715 | 38/3,438 | 0/655 | not found |
| indabatravel.co.za | 7/4,941 | 3/3,715 | 8/3,438 | 3/655 | 3/3 |
| live.co.za | 3/4,941 | 1/3,715 | 6/3,438 | 4/655 | 1/4 |
| munghanatravel.co.za | 28/4,941 | 10/3,715 | 30/3,438 | 8/655 | 8/8 |
| sa.kobo-safaris.com | 34/4,941 | 25/3,715 | 14/3,438 | 7/655 | 5/5 |
| zaptravel.co.za | 9/4,941 | 6/3,715 | 12/3,438 | 6/655 | 6/6 |
| contractcatering.co.za | 18/4,941 | 8/3,715 | 17/3,438 | 4/655 | 3/4 |
| hotelplanner.com | 10/4,941 | 10/3,715 | 0/3,438 | 0/655 | not found |
| letscruizetravel.co.za | 5/4,941 | 5/3,715 | 13/3,438 | 5/655 | 5/5 |
| outlook.com | 10/4,941 | 6/3,715 | 14/3,438 | 7/655 | 1/4 |
| purplesurgical.com | 2/4,941 | 1/3,715 | 3/3,438 | 1/655 | 1/1 |
| sapp.co.zw | 3/4,941 | 3/3,715 | 0/3,438 | 0/655 | not found |
| trip.com.na | 5/4,941 | 4/3,715 | 7/3,438 | 3/655 | 3/3 |
| amicishealth.co.za | 1/4,941 | 1/3,715 | 0/3,438 | 0/655 | not found |
| atlantiscorporate.co.za | 156/4,941 | 87/3,715 | 123/3,438 | 37/655 | 35/37 |
| blinsdguys.co.za | 1/4,941 | 1/3,715 | 0/3,438 | 0/655 | not found |
| christlikechurch.co.za | 1/4,941 | 1/3,715 | 1/3,438 | 0/655 | not found |
| club-travel.co.za | 9/4,941 | 4/3,715 | 6/3,438 | 1/655 | 1/1 |
| consultm.co.za | 3/4,941 | 1/3,715 | 2/3,438 | 0/655 | not found |
| crc.ag | 7/4,941 | 7/3,715 | 5/3,438 | 3/655 | 3/3 |

“Outside thread” is a proxy: core ask messages whose own thread has no earlier staff outbound. Median is ask messages per distinct core-request thread for that domain. The profile fingerprint is the fifth non-empty PDF text line (after the fixed address block), whitespace-normalized and uppercased; no profile text is exposed.

| Domain | Core asks / 189; ask threads / 164; median asks/thread | Outside-thread asks / domain asks | Profile-line variants / letters; most common variant / letters |
|---|---:|---:|---:|
| travelit.co.za | 40/189; 40/164; 1 | 40/40 | not found |
| gmail.com | 28/189; 21/164; 1 | 20/28 | 34/108; 21/108 |
| nexustravel.co.za | 11/189; 10/164; 1 | 9/11 | 5/35; 12/35 |
| lekkeslaap.co.za | 9/189; 9/164; 1 | 9/9 | not found |
| 360travel.co.za | 5/189; 4/164; 1 | 4/5 | 3/12; 6/12 |
| amoebatsc.com | 5/189; 2/164; 2.5 | 4/5 | 2/3; 2/3 |
| pepstores.com | 5/189; 3/164; 1 | 4/5 | 2/12; 11/12 |
| travel.co.za | 5/189; 4/164; 1 | 4/5 | 5/10; 5/10 |
| unica.co.za | 4/189; 3/164; 1 | 3/4 | 1/1; 1/1 |
| allsportstravel.co.za | 3/189; 2/164; 1.5 | 1/3 | not found |
| amazing-africa.co.za | 3/189; 3/164; 1 | 3/3 | not found |
| indabatravel.co.za | 3/189; 1/164; 3 | 2/3 | 1/3; 3/3 |
| live.co.za | 3/189; 1/164; 3 | 1/3 | 1/4; 4/4 |
| munghanatravel.co.za | 3/189; 3/164; 1 | 3/3 | 2/8; 7/8 |
| sa.kobo-safaris.com | 3/189; 3/164; 1 | 3/3 | 1/7; 7/7 |
| zaptravel.co.za | 3/189; 2/164; 1.5 | 2/3 | 3/6; 3/6 |
| contractcatering.co.za | 2/189; 2/164; 1 | 2/2 | 1/4; 4/4 |
| hotelplanner.com | 2/189; 2/164; 1 | 2/2 | not found |
| letscruizetravel.co.za | 2/189; 2/164; 1 | 2/2 | 1/5; 5/5 |
| outlook.com | 2/189; 1/164; 2 | 2/2 | 3/7; 3/7 |
| purplesurgical.com | 2/189; 1/164; 2 | 1/2 | 1/1; 1/1 |
| sapp.co.zw | 2/189; 2/164; 1 | 2/2 | not found |
| trip.com.na | 2/189; 2/164; 1 | 2/2 | 1/3; 3/3 |
| amicishealth.co.za | 1/189; 1/164; 1 | 1/1 | not found |
| atlantiscorporate.co.za | 1/189; 1/164; 1 | 1/1 | 5/37; 27/37 |
| blinsdguys.co.za | 1/189; 1/164; 1 | 1/1 | not found |
| christlikechurch.co.za | 1/189; 1/164; 1 | 1/1 | not found |
| club-travel.co.za | 1/189; 1/164; 1 | 1/1 | 1/1; 1/1 |
| consultm.co.za | 1/189; 1/164; 1 | 0/1 | not found |
| crc.ag | 1/189; 1/164; 1 | 1/1 | 1/3; 3/3 |

One profile-line variant means observed consistency; more than one means mixed. One letter is only one observation, not proof of a permanent domain rule (inference).

### Multiple guests/dates in one thread

Core requests total 189/189 across 164/164 threads. “Complete” means the thread’s linked HRCEN assignments had a complete +3d observation window. Cases are distinct parsed letter guest-subject + arrival-date pairs; values are masked.

| Signal | Count |
|---|---:|
| Threads with 2+ core quote/booking asks | 17/164 |
| Threads with 2+ extracted arrival dates | 10/164 |
| Complete threads with 2+ linked distinct guest/date letter cases | 9/164 |
| Multi-case threads with separate confirmation IDs for their cases | 9/9 |

| Distinct guest/date cases in thread | Threads / 9 | Conf IDs / cases |
|---|---:|---:|
| 2 | 3/9 | 6/6 |
| 3 | 3/9 | 9/9 |
| 4 | 1/9 | 4/4 |
| 5 | 1/9 | 5/5 |
| 9 | 1/9 | 10/9 |

One thread has 10/9 conf IDs for nine distinct guest/date pairs; why there is an extra ID is not found.

## What this means for the agent/pane

- Keep quote and new/provisional booking as one stay-request workflow. The next step is a staff-approved provisional HMS booking; payment state then branches unpaid work from paid amendment/cancellation work (inference).
- Model each guest/date as its own stay card under a mail thread. Do not collapse a multi-guest thread into one booking or one confirmation number (inference).
- Use sender domain as a clue, not an HMS-profile default. Large domains show multiple letter profile lines; even one observed line is a small sample (inference).
- Suggested pane order: source mail/thread → stay cards and extracted facts → fresh HMS reads → payment state → proposed HMS write with staff approval → HMS result/confirmation-letter evidence. No mail composer or send action (inference).

## Open gaps

- The export ends at 2026-10-13 17:54:13Z, but +3d eligibility treated the date as complete through 23:59:59Z. Late-day cases can be misclassified as complete; re-run only with a known export watermark (inference).
- HRCEN manual check is 30/57 accepted unique-conf links, so it estimates precision only. Unmatched candidates and recall were not manually reviewed.
- Phrase counts are body-level regex co-occurrence flags; quoted history or signatures can trigger them. They are not a semantic intent label or proof a promised document was later sent.
- Six/1,180 HRCEN-prefix attachment rows had no 8-digit filename conf ID, so they were not scored as confirmation-letter links; their exact document type is not found.
- Quote, Proforma, and Excel are attachment filename/MIME/text markers, not guaranteed document meaning. Proforma PDF text scan is limited to the first 5,000 characters.
- Feature groups are small and heuristic: BAR is 1/88, contract 4/88; rate words and extraction labels may be absent or wrong. Do not turn these tables into an automatic document-selection rule (inference).
- Profile fingerprint is the fifth non-empty PDF text line. It may shift with PDF layout; exact profile strings are withheld here. Mixed variants are direct evidence against a universal domain default, while a single observed variant is not proof it stays fixed (inference).
- Same-thread “first reply” can be shared by more than one inbound ask in a multi-ask thread. Message-level rates are not unique-thread conversion rates.

## Appendix (scripts)

The script below uses only the local corpus. It prints aggregate counts and sender domains, never addresses, guest names, full bodies, or profile strings. Manual QA verdicts are human review; the script only selects the seeded sample.

Run as: python3 - <<'PY' then this code, then a closing PY. Paths are the supplied read-only corpus.

```python
import bisect, collections, datetime, gzip, html, json, os, random, re, statistics

ROOT = "/home/orca/nava-research/corpus/2026-10-13"
OWN = ("legacyhotels.co.za", "legacyhotels.com")
OTA = ("synxis", "booking.com", "expedia", "webbeds", "hotelbeds",
       "profitroom", "siteminder", "ratetiger", "tiket")

def rows(name):
    with gzip.open(os.path.join(ROOT, name), "rt", encoding="utf8") as f:
        for line in f:
            yield json.loads(line)

messages = list(rows("messages.jsonl.gz"))
attachments = list(rows("attachments.jsonl.gz"))
extractions = list(rows("extractions.jsonl.gz"))
by_message = {m["id"]: m for m in messages}

def emails(value):
    if isinstance(value, str):
        value = [value]
    return [e.lower() for part in (value or [])
            for e in re.findall(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}",
                                str(part), re.I)]

def sender(m):
    return (emails(m.get("from_address") or "") or [""])[0]

def domain(address):
    return address.rsplit("@", 1)[-1].lower() if "@" in address else ""

def own(address):
    d = domain(address)
    return any(d == x or d.endswith("." + x) for x in OWN)

def external_nonota(address):
    d = domain(address)
    return bool(d) and not own(address) and not any(x in d for x in OTA)

def stamp(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None

def received(m):
    return stamp(m.get("received_at") or m.get("sent_at"))

def sent(m):
    return stamp(m.get("sent_at") or m.get("received_at"))

latest = {}
for e in extractions:
    mid = e.get("message_id")
    if mid not in latest or (e.get("created_at") or "") > (latest[mid].get("created_at") or ""):
        latest[mid] = e

inbound = [m for m in messages if m.get("direction") == "inbound"]
staff_out = [m for m in messages
             if m.get("direction") == "outbound" and own(sender(m))]
min_time = min(received(m) for m in messages if received(m))
last_time = max(received(m) for m in messages if received(m))
corpus_end = last_time.replace(hour=23, minute=59, second=59, microsecond=999999)

# First own-domain reply: same thread first; otherwise exact sender address in To/Cc
# within 72h, with exactly one inbound from that address from ask time through reply.
by_thread = collections.defaultdict(list)
by_recipient = collections.defaultdict(list)
inbound_by_sender = collections.defaultdict(list)
for m in inbound:
    if sender(m):
        inbound_by_sender[sender(m)].append(received(m))
for m in staff_out:
    by_thread[m.get("thread_id")].append(m)
    rcpts = set(emails((m.get("to_addresses") or []) + (m.get("cc_addresses") or [])))
    for address in rcpts:
        by_recipient[address].append(m)
for index in (by_thread, by_recipient):
    for values in index.values():
        values.sort(key=sent)
for values in inbound_by_sender.values():
    values.sort()

def first_reply(m):
    t, address = received(m), sender(m)
    same = [o for o in by_thread.get(m.get("thread_id"), []) if sent(o) > t]
    if same:
        return same[0], "same-thread"
    times = inbound_by_sender.get(address, [])
    lo = bisect.bisect_left(times, t)  # includes this inbound ask
    ambiguous = False
    for o in by_recipient.get(address, []):
        ot = sent(o)
        if ot <= t:
            continue
        if ot > t + datetime.timedelta(hours=72):
            break
        n = bisect.bisect_right(times, ot) - lo
        if n == 1:
            return o, "exact-address cross-thread"
        ambiguous = True
    return None, "ambiguous" if ambiguous else "none"

def plain(value):
    return html.unescape(re.sub(r"<[^>]+>", " ", str(value or "")))

def ask_row(m, e):
    reply, reply_type = first_reply(m)
    payload = (e or {}).get("payload") or {}
    arrivals = set()
    for stay in payload.get("stays") or []:
        value = (stay.get("requested") or {}).get("arrival")
        if value:
            try:
                arrivals.add(datetime.date.fromisoformat(value[:10]))
            except ValueError:
                pass
    raw = " ".join((str(m.get("subject") or ""), str(m.get("body") or ""),
                    str((payload.get("contact") or {}).get("name") or ""),
                    str(payload.get("agency") or ""),
                    str(payload.get("endClient") or "")))
    text = plain(raw).lower()
    tokens = set(re.findall(r"[a-zà-öø-ÿ][a-zà-öø-ÿ'’-]{1,}", text, re.I))
    return {"m": m, "e": e, "a": sender(m), "d": domain(sender(m)),
            "t": received(m), "reply": reply, "reply_type": reply_type,
            "arrivals": arrivals, "tokens": tokens}

primary = [ask_row(m, latest[m["id"]]) for m in inbound
           if m["id"] in latest and latest[m["id"]].get("kind") in ("quote", "booking")]
core = [x for x in primary if external_nonota(x["a"])]
broad = [ask_row(m, latest.get(m["id"])) for m in inbound
         if external_nonota(sender(m))]

def frac(n, d):
    return f"{n}/{d}"

print("CORPUS", frac(len(messages), len(messages)),
      "inbound", frac(sum(m["direction"] == "inbound" for m in messages), len(messages)),
      "outbound", frac(sum(m["direction"] == "outbound" for m in messages), len(messages)))
for name, cohort in (("primary", primary), ("core", core), ("broad", broad)):
    c = collections.Counter(x["reply_type"] for x in cohort)
    print("ANCHORS", name, "N", len(cohort),
          "same", frac(c["same-thread"], len(cohort)),
          "cross", frac(c["exact-address cross-thread"], len(cohort)),
          "ambiguous", frac(c["ambiguous"], len(cohort)),
          "none", frac(c["none"], len(cohort)))

# Local PDF text map and HRCEN letter inventory.
pdf_ids = set()
with open(os.path.join(ROOT, "staff_pdfs.tsv"), encoding="utf8") as f:
    for line in f:
        pdf_ids.add(line.rstrip("\n").split("\t")[0])

def pdf_text(aid, limit=None):
    path = os.path.join(ROOT, "pdftxt", aid + ".txt")
    if not os.path.isfile(path):
        return ""
    with open(path, encoding="utf8", errors="ignore") as f:
        return f.read() if limit is None else f.read(limit)

def pdf_arrival(text):
    for match in re.finditer(r"\bArrival\b", text, re.I):
        chunk = text[match.start():match.start() + 100]
        m = re.search(r"\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b", chunk)
        if m:
            day, month, year = map(int, m.groups())
            year += 2000 if year < 100 else 0
            try:
                return datetime.date(year, month, day)
            except ValueError:
                pass
        m = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", chunk)
        if m:
            try:
                return datetime.date(*map(int, m.groups()))
            except ValueError:
                pass
    return None

letters = []
outbound_files = []
asset_rows = collections.Counter()
other_assets = []
hrcen_arrival_count = 0
for a in attachments:
    if a.get("is_inline"):
        continue
    m = by_message.get(a.get("message_id"))
    if not m or m.get("direction") != "outbound" or not own(sender(m)):
        continue
    outbound_files.append(a)
    fn = os.path.basename(a.get("filename") or "")
    low = fn.lower()
    mime = (a.get("mime_type") or "").lower()
    if low.startswith("hrcen_"):
        asset_rows["HRCEN"] += 1
        hms_arrival = pdf_arrival(pdf_text(a["id"]))
        hrcen_arrival_count += int(bool(hms_arrival))
        c = re.search(r"(\d{8})", fn)
        if not c:
            continue
        subject = m.get("subject") or ""
        g = re.search(r"Confirmation Letter_(.*?)\s*\(n[°º]\s*\d", subject, re.I)
        guest = re.sub(r"\s+", " ", g.group(1)).strip() if g else ""
        names = re.findall(r"[a-zà-öø-ÿ][a-zà-öø-ÿ'’-]{1,}", guest.lower(), re.I)
        rcpts = set(emails((m.get("to_addresses") or []) + (m.get("cc_addresses") or [])))
        letters.append({"a": a, "m": m, "id": a["id"], "conf": c.group(1),
                        "guest": guest, "surname": names[-1] if names else "",
                        "arrival": hms_arrival,
                        "rx": rcpts, "domains": {domain(z) for z in rcpts}, "t": sent(m)})
        continue
    if re.search(r"\.(xls|xlsx|xlsm|csv)$", low) or "spreadsheet" in mime or "excel" in mime:
        cat = "Excel"
    elif re.search(r"\bquote(?:ation)?\b", low):
        cat = "Quote"
    elif re.search(r"pro[\s_-]*forma|proforma", low):
        cat = "Proforma filename"
    elif low.endswith(".pdf") and a["id"] in pdf_ids and re.search(
            r"pro[\s_-]*forma|proforma", pdf_text(a["id"], 5000), re.I):
        cat = "Proforma text"
    else:
        continue
    asset_rows[cat] += 1
    rcpts = set(emails((m.get("to_addresses") or []) + (m.get("cc_addresses") or [])))
    other_assets.append({"a": a, "m": m, "cat": cat, "rx": rcpts,
                         "domains": {domain(z) for z in rcpts},
                         "t": sent(m), "thread": m.get("thread_id")})

print("ASSET_ROWS", "noninline-own-out", len(outbound_files),
      "HRCEN", frac(asset_rows["HRCEN"], len(outbound_files)),
      "other-classes", {k: frac(v, len(outbound_files))
                        for k, v in asset_rows.items() if k != "HRCEN"})
print("HRCEN_PARSE", "arrival", frac(hrcen_arrival_count, asset_rows["HRCEN"]),
      "subject", frac(sum(bool(x["guest"]) for x in letters), asset_rows["HRCEN"]),
      "unique-conf", frac(len({x["conf"] for x in letters}), asset_rows["HRCEN"]),
      "scoreable-confirmation-files", frac(len(letters), asset_rows["HRCEN"]))

def letter_score(x, l):
    exact = x["a"] in l["rx"]
    same_domain = bool(x["d"] and x["d"] in l["domains"])
    recipient = exact or same_domain
    surname = bool(l["surname"] and l["surname"] in x["tokens"])
    arrival = bool(l["arrival"] and l["arrival"] in x["arrivals"])
    thread = x["m"].get("thread_id") == l["m"].get("thread_id")
    if thread and not recipient:
        return None
    if l["arrival"] and x["arrivals"] and l["arrival"] not in x["arrivals"] and not thread:
        return None
    families = sum((recipient, surname, arrival, thread))
    score = (4 if exact else 0) + (1 if same_domain else 0) \
            + (3 if surname else 0) + (3 if arrival else 0) + (2 if thread else 0)
    if score < 7 or families < 2:
        return None
    return {"score": score, "exact": exact, "domain": same_domain,
            "surname": surname, "arrival": arrival, "thread": thread}

scored = {}
for x in primary + broad:
    if x["reply"]:
        scored[x["m"]["id"]] = {l["id"]: letter_score(x, l) for l in letters}

def inbound_around(address, t):
    values = inbound_by_sender.get(address, [])
    return (bisect.bisect_right(values, t + datetime.timedelta(days=3))
            - bisect.bisect_left(values, t - datetime.timedelta(days=3)))

def other_link(x, a, window):
    if not x["reply"]:
        return False
    rt, gap = sent(x["reply"]), a["t"] - sent(x["reply"])
    limits = {"30m": datetime.timedelta(minutes=30),
              "60m": datetime.timedelta(hours=1),
              "3h": datetime.timedelta(hours=3)}
    if window in limits and abs(gap) > limits[window]:
        return False
    if window == "3d" and not rt <= a["t"] <= rt + datetime.timedelta(days=3):
        return False
    recipient = x["a"] in a["rx"] or (x["d"] and x["d"] in a["domains"])
    same_thread = x["m"].get("thread_id") == a["thread"]
    if same_thread and recipient:
        return True
    return x["a"] in a["rx"] and inbound_around(x["a"], a["t"]) == 1

def eligible(x, window):
    if not x["reply"]:
        return False
    t = sent(x["reply"])
    limits = {"30m": datetime.timedelta(minutes=30),
              "60m": datetime.timedelta(hours=1),
              "3h": datetime.timedelta(hours=3)}
    if window in limits:
        d = limits[window]
        return t - d >= min_time and t + d <= corpus_end
    return t + datetime.timedelta(days=3) <= corpus_end

def letter_in_window(x, l, window):
    gap = l["t"] - sent(x["reply"])
    limits = {"30m": datetime.timedelta(minutes=30),
              "60m": datetime.timedelta(hours=1),
              "3h": datetime.timedelta(hours=3)}
    if window in limits:
        return abs(gap) <= limits[window]
    return datetime.timedelta(0) <= gap <= datetime.timedelta(days=3)

files_by_message = collections.defaultdict(list)
for a in outbound_files:
    files_by_message[a["message_id"]].append(a)

def assess(cohort, window):
    xs = [x for x in cohort if eligible(x, window)]
    outcomes = {k: set() for k in ("HRCEN", "Quote", "Excel",
                                    "Proforma filename", "Proforma text")}
    per_request, by_letter = collections.defaultdict(set), {}
    for l in letters:
        candidates = []
        for x in xs:
            if letter_in_window(x, l, window):
                score = scored.get(x["m"]["id"], {}).get(l["id"])
                if score:
                    candidates.append((x, score))
        if candidates:
            best = max(s["score"] for _, s in candidates)
            winners = [(x, s) for x, s in candidates if s["score"] == best]
            if len(winners) == 1:
                x, s = winners[0]
                per_request[x["m"]["id"]].add(l["id"])
                by_letter[l["id"]] = (x, l, s)
    for mid in per_request:
        outcomes["HRCEN"].add(mid)
    for a in other_assets:
        for x in xs:
            if other_link(x, a, window):
                outcomes[a["cat"]].add(x["m"]["id"])
    no_attachment = {x["m"]["id"] for x in xs
                     if not files_by_message.get(x["reply"]["id"])}
    strict_text = (no_attachment - set().union(*outcomes.values())) if window == "3d" else set()
    return xs, outcomes, no_attachment, strict_text, per_request, by_letter

cohorts = {"all primary": primary, "core": core, "broad": broad}
results = {name: {w: assess(c, w) for w in ("30m", "60m", "3h", "3d")}
           for name, c in cohorts.items()}
for name, cohort in cohorts.items():
    for window, (xs, out, noatt, strict, _, _) in results[name].items():
        cells = []
        for category in out:
            n = len(out[category])
            cells.append(category + "=" + frac(n, len(xs)) + ";" + frac(n, len(cohort)))
        print("WINDOW", name, window, "eligible", frac(len(xs), len(cohort)),
              *cells, "first-reply-no-attachment", frac(len(noatt), len(xs)),
              "strict-text-only", frac(len(strict), len(xs)) if window == "3d" else "n/a")

# Unique core first replies. Document flags need a document term and a future verb
# in the same sentence; booking/status and number checks scan the body.
core_replies = {x["reply"]["id"]: x["reply"] for x in core if x["reply"]}
families = collections.Counter()
any_document = booking_status = any_8digit = exact_conf_shape = 0
doc_terms = (("confirmation", r"confirmation"),
             ("proforma", r"pro[\s-]*forma"),
             ("other", r"quote|quotation|invoice|document|letter|voucher|itinerary"))
future = r"\b(?:follow|will send|shall send|will forward|will issue|will attach|will provide|will share|will email|send shortly|provide shortly|forward shortly)\b"
book_re = re.compile(r"\b(?:book(?:ing|ed)?\s+(?:has been|is|was|have been|made|confirmed|done|created|reserved)|reservation\s+(?:has been|is|was|made|confirmed|done|created|reserved)|we\s+(?:have|had)\s+booked)\b", re.I | re.S)
for m in core_replies.values():
    body = re.sub(r"\s+", " ", plain(m.get("body") or "").lower())
    flags = []
    for name, term in doc_terms:
        found = bool(re.search(term, body, re.I) and re.search(future, body, re.I))
        families[name] += int(found)
        flags.append(found)
    any_document += int(any(flags))
    booking_status += int(bool(book_re.search(body)))
    any_8digit += int(bool(re.search(r"\b\d{8}(?:-1)?\b", body)))
    exact_conf_shape += int(bool(re.search(r"\b\d{8}-1\b", body)))
print("TEXT_FLAGS", "N", len(core_replies),
      *(k + "=" + frac(v, len(core_replies)) for k, v in families.items()),
      "any-document=" + frac(any_document, len(core_replies)),
      "booking-status=" + frac(booking_status, len(core_replies)),
      "8-digit-optional-suffix=" + frac(any_8digit, len(core_replies)),
      "8-digit-minus-1=" + frac(exact_conf_shape, len(core_replies)))

qxs, qout, _, _, qper, qbyletter = results["core"]["3d"]
def feature(x, key):
    p = x["e"].get("payload") or {}
    stays = p.get("stays") or []
    if key == "rooms":
        values = []
        for s in stays:
            n = s.get("totalRooms")
            if isinstance(n, (int, float)):
                values.append(n)
            else:
                rows_n = [r.get("rooms") for r in (s.get("rows") or [])
                          if isinstance(r.get("rooms"), (int, float))]
                if rows_n:
                    values.append(sum(rows_n))
        n = max(values) if values else None
        return "<10" if n is not None and n < 10 else ("10+" if n is not None else "unknown")
    if key == "nights":
        values = []
        for s in stays:
            r = s.get("requested") or {}
            try:
                values.append((datetime.date.fromisoformat(r["departure"][:10])
                               - datetime.date.fromisoformat(r["arrival"][:10])).days)
            except (KeyError, TypeError, ValueError):
                pass
        n = max(values) if values else None
        return "1-2" if n is not None and n <= 2 else ("3-5" if n is not None and n <= 5 else ("6+" if n is not None else "unknown"))
    if key == "profile":
        return "agency" if p.get("agency") else ("company" if p.get("endClient") else "direct")
    if key == "rate":
        text = (x["m"].get("subject") or "") + " " + (x["m"].get("body") or "")
        if re.search(r"\bgovernment(?:al)?\b", text, re.I): return "government"
        if re.search(r"\bcontract(?:ed)?\b", text, re.I): return "contract"
        if re.search(r"\bBAR\b|best available rate", text, re.I): return "BAR"
        return "not explicit"
    if key == "lead":
        if not x["arrivals"]: return "unknown"
        n = (min(x["arrivals"]) - x["t"].date()).days
        return "past" if n < 0 else ("0-6d" if n <= 6 else ("7-30d" if n <= 30 else "31+d"))

for key in ("rooms", "nights", "profile", "rate", "lead"):
    groups = collections.defaultdict(list)
    for x in qxs:
        groups[feature(x, key)].append(x)
    for label, group in sorted(groups.items()):
        cells = [frac(sum(x["m"]["id"] in qout[c] for x in group), len(group))
                 for c in ("HRCEN", "Quote", "Excel", "Proforma filename", "Proforma text")]
        print("FEATURE", key, label, "requests", frac(len(group), len(qxs)), *cells)

# Domain counts use unique confirmation IDs per recipient domain; profile strings stay masked.
requests_by_domain = collections.defaultdict(list)
external_by_domain = collections.defaultdict(list)
for x in core: requests_by_domain[x["d"]].append(x)
for x in broad: external_by_domain[x["d"]].append(x)
out_by_domain = collections.Counter()
for m in staff_out:
    for d in {domain(a) for a in emails((m.get("to_addresses") or []) + (m.get("cc_addresses") or []))}:
        if d: out_by_domain[d] += 1
letters_by_domain = collections.defaultdict(dict)
for l in letters:
    lines = [re.sub(r"\s+", " ", s.replace("\xa0", " ")).strip().upper()
             for s in pdf_text(l["id"]).splitlines() if s.strip()]
    profile = lines[4] if len(lines) > 4 else ""
    for d in {domain(a) for a in l["rx"] if external_nonota(a)}:
        letters_by_domain[d].setdefault(l["conf"], (l["guest"].lower(), profile))
thread_denominator = sum(len({x["m"]["thread_id"] for x in v})
                         for v in external_by_domain.values())
core_thread_n = len({x["m"]["thread_id"] for x in core})
conf_total = len({l["conf"] for l in letters})
print("DOMAIN_TOTALS", "core-asks", frac(len(core), len(primary)),
      "core-threads", frac(core_thread_n, len(core)),
      "external-inbound", frac(len(broad), len(inbound)),
      "domain-thread-pairs", frac(thread_denominator, thread_denominator),
      "own-outbound", frac(len(staff_out), len(staff_out)),
      "conf-ids", frac(conf_total, conf_total),
      "core-ask-domains", len(requests_by_domain),
      "all-external-domains", len(external_by_domain))
top_domains = sorted(requests_by_domain.items(), key=lambda z: (-len(z[1]), z[0]))[:30]
print("TOP30_DOMAIN_COVERAGE", frac(len(top_domains), len(requests_by_domain)),
      frac(sum(len(v) for _, v in top_domains), len(core)))
for d, items in top_domains:
    threads = collections.Counter(x["m"]["thread_id"] for x in items)
    outside = sum(not any(sent(o) < x["t"] for o in by_thread.get(x["m"].get("thread_id"), []))
                  for x in items)
    letters_d = letters_by_domain.get(d, {})
    guests = [v[0] for v in letters_d.values() if v[0]]
    profiles = collections.Counter(v[1] for v in letters_d.values() if v[1])
    mode = profiles.most_common(1)
    inbound_d = external_by_domain[d]
    print("DOMAIN", d, "in", frac(len(inbound_d), len(broad)),
          "threads", frac(len({x["m"]["thread_id"] for x in inbound_d}), thread_denominator),
          "out", frac(out_by_domain[d], len(staff_out)),
          "letters", frac(len(letters_d), conf_total),
          "guests", frac(len(set(guests)), len(guests)) if guests else "not-found",
          "asks", frac(len(items), len(core)),
          "ask-threads", frac(len(threads), core_thread_n),
          "median", statistics.median(threads.values()) if threads else 0,
          "outside", frac(outside, len(items)),
          "profile-variants", frac(len(profiles), len(letters_d)) if letters_d else "not-found",
          "modal-profile", frac(mode[0][1], len(letters_d)) if mode else "not-found")

# Same-thread multiple requests and linked guest/date cases, using +3d complete requests.
thread_requests = collections.defaultdict(list)
for x in core:
    thread_requests[x["m"].get("thread_id")].append(x)
multi_asks = sum(len(v) >= 2 for v in thread_requests.values())
multi_dates = sum(len({d for x in v for d in x["arrivals"]}) >= 2
                  for v in thread_requests.values())
conf_by_thread = collections.defaultdict(set)
letter_by_id = {l["id"]: l for l in letters}
for x in qxs:
    for lid in qper.get(x["m"]["id"], set()):
        conf_by_thread[x["m"].get("thread_id")].add(letter_by_id[lid]["conf"])
first_by_conf = {}
for l in letters:
    first_by_conf.setdefault(l["conf"], l)
cases_by_thread = {}
for thread, confs in conf_by_thread.items():
    cases = {(first_by_conf[c]["guest"].lower(), first_by_conf[c]["arrival"])
             for c in confs if c in first_by_conf and first_by_conf[c]["guest"]
             and first_by_conf[c]["arrival"]}
    if len(cases) >= 2:
        cases_by_thread[thread] = (confs, cases)
print("MULTI_THREAD", "asks", frac(multi_asks, len(thread_requests)),
      "arrival-dates", frac(multi_dates, len(thread_requests)),
      "linked-cases", frac(len(cases_by_thread), len(thread_requests)))
for n in sorted({len(v[1]) for v in cases_by_thread.values()}):
    selected = [v for v in cases_by_thread.values() if len(v[1]) == n]
    print("CASE_BUCKET", n, "threads", frac(len(selected), len(cases_by_thread)),
          "conf-ids/cases", frac(sum(len(v[0]) for v in selected), n * len(selected)))

# Seeded sample for manual precision check. Only size and seed are printed.
qa = {}
for _, (x, l, score) in qbyletter.items():
    qa.setdefault(l["conf"], (x, l, score))
sample = list(qa.values())
random.Random(20261020).shuffle(sample)
print("MANUAL_QA_SAMPLE", frac(min(30, len(sample)), len(sample)), "seed=20261020")
```

