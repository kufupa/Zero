# LANE R2 — Party truth from staff-sent HMS PDFs

## 1. Answer

**30/1,179 confirmation PDFs name a company/agency candidate [M]; only 1/30 labeled rows join to an earlier eligible inbound [M].**
**There are 1,149 unlabelled confirmations [M], but 0 verified private-guest negatives [M]; do not relabel missing party fields as `none`.**
**The sole paired positive [M] matches in a sender legal footer; strategy lift is unproven [I]. Keep auto-bind off [I].**

## 2. Method

- Read local snapshot only: `/home/orca/nava-research/corpus/2026-10-13`; 12,433 messages [M], 2,162 headerless `staff_pdfs.tsv` rows [M], 46,443 attachment rows [M], 2,426 messages with a latest succeeded extraction [M]. Validated 2,162/2,162 PDFs [M] as outbound from `@legacyhotels.co.za`, with 2,162/2,162 attachment/message joins [M]. No network, database, or HMS calls.
- HMS scope: S3 keys in the `Confirmation_Letter` family (including naming variants) or matching `HRCEN_offer_*`: 1,179 confirmations [M] + 6 offers [M] = 1,185 docs [M]. Parsed text is present for 1,185/1,185 scoped PDFs [M]. Other PDFs were excluded from labels.
- Staff senders validated as `@legacyhotels.co.za`; inbound join uses the nearest earlier inbound in the same thread. Excluded internal staff and sender domains containing SynXis, Expedia/PartnerCentral, WebBeds, Hotelbeds, Booking.com, Get-e, Hotels.com, Agoda, Trip.com, Traveloka, Airbnb, ReviewPro, TrustYou, Tripadvisor, Revinate, or Medallia.
- Extraction: latest `succeeded` row by `created_at`; `extracted_name` exports agency first, otherwise endClient. Parsed confirmation number, guest/client name, arrival/departure, room, rate, board, and party fields from local PDF text; values stay in memory except party labels needed in the private test set. Inbound text is parsed locally, HTML stripped. No raw body is written to output; `hms_reads` and `staff_quotes` were not used.
- Party labels: explicit company/agency/travel-agent/billing-to/voucher-to fields; `Account Name` retained only when not matching The Centurion Hotel property name. Non-property account kind inferred from name cues. `none` requires an explicit private/personal/individual marker in parsed Account Name or Account Type values; found 0 such confirmation rows [M]. The other 1,149 unlabelled confirmation documents [M] stay unlabeled and out of the test set. Offers enter test set only if they name a party.
- Testset confidence is rule-based, not calibrated: 0.93 for other named explicit party fields [I], 0.70 for non-property Account Name [I], and 0.55 for a four-uppercase-letter Agency value [I].
- Matching uses candidate names observed in these PDFs only; input is paired inbound subject+body. `exact` is case-insensitive substring; `normalised` removes parenthetical/bracketed text, diacritics, punctuation, and case, then strips trailing PTY LTD/PTY LIMITED/PROPRIETARY LIMITED/LTD/LIMITED/CC/INC/NPC/SOC/SA [I]; `token` searches the first significant token of at least 4 characters [I]; `fuzzy` is max character-trigram Jaccard ≥0.30 [I]; `domain` is leave-one-thread-out majority from other paired positive rows; `combo` uses text rank first, domain only as fallback. Precision is top-1 [M] correct / all assignments (including false assignments to `none`), recall is top-1 [M] correct / paired positives, top-3 [M] is gold in returned top 3 / paired positives.
- Re-run: `python3 /home/orca/nava-research/scripts/r2/party_analysis.py --corpus /home/orca/nava-research/corpus/2026-10-13 --report /home/orca/nava-research/reports/r2-party-truth.md --testset /home/orca/nava-research/testsets/party-v1.jsonl`.

## 3. Findings

### HMS document fields

| Field / signal | Confirmation PDFs | HMS offers | Confidence / caveat |
|---|---:|---:|---|
| confirmation number in filename | 1,176/1,179 (99.7%) [M] | 0/6 (0.0%) [M] | High — filename pattern, not a value copied into report |
| confirmation number label/value in PDF | 1,152/1,179 (97.7%) [M] | 5/6 (83.3%) [M] | High — explicit confirmation-number label; values withheld |
| guest name label/value | 1,176/1,179 (99.7%) [M] | 5/6 (83.3%) [M] | High — confirmation guest field; offer client-name label |
| arrival label/value | 1,176/1,179 (99.7%) [M] | 5/6 (83.3%) [M] | High — labelled text; values withheld |
| departure label/value | 1,176/1,179 (99.7%) [M] | 5/6 (83.3%) [M] | High — labelled text; values withheld |
| room/type line | 1,176/1,179 (99.7%) [M] | 5/6 (83.3%) [M] | Medium — confirmation label; offer keyword/occupancy signal |
| rate label/value | 1,176/1,179 (99.7%) [M] | 5/6 (83.3%) [M] | Medium — explicit confirmation line; offer rate/currency term |
| board/meal explicit label/value | 0/1,179 (0.0%) [M] | 0/6 (0.0%) [M] | High — explicit board/meal label; values withheld |
| board/meal text | 1,176/1,179 (99.7%) [M] | 5/6 (83.3%) [M] | Medium — keyword/row text, not validated board inclusion |
| Account Name present | 1,167/1,179 (99.0%) [M] | 5/6 (83.3%) [M] | High — explicit field; usually property account |
| Account Name matches hotel property | 1,163/1,179 (98.6%) [M] | 5/6 (83.3%) [M] | High — matched `Centurion` + `Hotel`; excluded as guest party |
| Account Type / Account Number field present | Type 1,165/1,179 (98.8%) [M]; number 1,167/1,179 (99.0%) [M] | Type 5/6 (83.3%) [M]; number 5/6 (83.3%) [M] | Medium — explicit field parser |
| Account Type values containing `Business` | 1,176/1,176 (100.0%) [M] values | 5/5 (100.0%) [M] values | High — no private/personal marker in these values |
| Generic “Dear Partner” salutation | 1,128/1,179 (95.7%) [M] | 0/6 (0.0%) [M] | High — generic, not a named party |
| Explicit Agency field | 26/1,179 (2.2%) [M] | 0/6 (0.0%) [M] | Medium — 26 [M] four-uppercase-letter values repeat; code-vs-name unresolved |
| Explicit Company field | 0/1,179 (0.0%) [M] | 0/6 (0.0%) [M] | High — no nonempty named field found |
| Travel-agent / billing-to / voucher-to values | 0/1,179 (0.0%) [M] | 0/6 (0.0%) [M] | High — no distinct named values parsed |
| Non-property Account Name values | 4/1,179 (0.3%) [M] | 0/6 (0.0%) [M] | Medium — 2 [M] distinct confirmation names; kind inferred [I] from text |
| Named company/agency candidate in any parsed field | 30/1,179 (2.5%) [M] | 0/6 (0.0%) [M] | Medium — includes inferred account-name kinds |

**Field reading:** `Account Name` is not a reliable customer-party field here: its distinct values are 3 [M], with the dominant value matching the hotel property [M]. A populated account field does not equal a company label [I].

### Labels, email evidence, and domain consistency

| Measure | Value | Confidence |
|---|---:|---|
| Named party candidates in confirmation PDFs | 30/1,179 (2.5%) [M] | Medium — 26 [M] Agency-field + 4 [M] non-property Account Name source rows |
| Named rows with >1 distinct party candidate | 0/30 (0.0%) [M] | Medium — multiple values would be ambiguous in a single-label row |
| Unlabelled confirmation documents | 1,149/1,179 (97.5%) [M] | High — absent party is not treated as private |
| Explicit private `none` labels | 0/1,179 (0.0%) [M] | High — requires private/personal/individual account marker |
| Party kinds among named rows | 28/30 (93.3%) agency; 2/30 (6.7%) company [M] | Medium — account-based kinds inferred [I] |
| Unique candidate names from documents | 3 [M] | Medium — 1 [M] candidate is an opaque repeated Agency value; code-vs-name is unresolved [I] |
| Named rows with preceding eligible inbound | 1/30 (3.3%) [M] | High — thread + timestamp join |
| All confirmation PDFs with preceding eligible inbound | 8/1,179 (0.7%) [M] | High — includes 7 unlabelled rows |
| Paired inbound sender display-name present | 8/8 (100.0%) [M] | High — parsed from sender header; value omitted |
| Joined inbounds with signature-org evidence | 5/8 (62.5%) [M] | Medium — signature line chosen by organization-word heuristic |
| Paired positives with signature-org evidence | 1/1 (100.0%) [M] | Low — only 1 paired positive [M] |
| Exact HMS party string in subject/body | 1/1 (100.0%) [M] | Low — one paired positive; located in legal footer/signature |
| Fuzzy-only party mention | 0/1 (0.0%) [M] | Low — one paired positive [M] |
| Party recoverable only through leave-one-out domain | 0/1 (0.0%) [M] | Low — one paired positive [M] |
| Party not found in text or leave-one-out domain | 0/1 (0.0%) [M] | Low — one paired positive [M] |
| Positive domains with repeated party labels | 0/1 (0.0%) [M] | Not estimable — 1 distinct domain [M], 1 positive row [M]; no repeats |
| Consistent repeated positive domains | 0/0 (n/a) [M] | Not estimable — no repeated domains |
| Paired positives with extracted agency / endClient | Agency 1/1 (100.0%) [M]; endClient 0/1 (0.0%) [M] | Low — one paired positive [M] |
| HMS party equals extracted agency / endClient | Agency 1/1 (100.0%) [M]; endClient 0/1 (0.0%) [M] | Low — one paired positive [M]; cannot generalize |

### Offline strategy simulation

Candidate list: 3 observed names [M] (lower bound on live HMS choices [I]). Evaluation set: 1 paired labelled confirmation rows [M] = 1 positive + 0 verified private `none` [M]; 7 additional joined rows [M] are excluded as unlabelled. No verified private negatives means false-positive rate is untestable [I]. Top-3 is weak evidence with this small list [I].

| Strategy | Assigned rows | Precision@1 | Recall@1 | Top-3 recall | False assignments to private `none` | Confidence |
|---|---:|---:|---:|---:|---:|---|
| exact | 1/1 (100.0%) [M] | 100.0% [M] | 100.0% [M] | 100.0% [M] | n/a (0 negatives [M]) [M] | Low — n=1 [M] |
| normalized | 1/1 (100.0%) [M] | 100.0% [M] | 100.0% [M] | 100.0% [M] | n/a (0 negatives [M]) [M] | Low — n=1 [M] |
| token | 1/1 (100.0%) [M] | 100.0% [M] | 100.0% [M] | 100.0% [M] | n/a (0 negatives [M]) [M] | Low — n=1 [M] |
| fuzzy | 1/1 (100.0%) [M] | 100.0% [M] | 100.0% [M] | 100.0% [M] | n/a (0 negatives [M]) [M] | Low — n=1 [M] |
| domain | 0/1 (0.0%) [M] | n/a [M] | 0.0% [M] | 0.0% [M] | n/a (0 negatives [M]) [M] | Low — n=1 [M] |
| combo | 1/1 (100.0%) [M] | 100.0% [M] | 100.0% [M] | 100.0% [M] | n/a (0 negatives [M]) [M] | Low — n=1 [M] |

**Readout:** Exact text hits the sole paired positive [M] in a sender legal footer/signature, not the booking request. Leave-one-thread-out domain memory has no independent same-domain label [M]. Precision is not safety evidence with zero verified negatives [I]; these descriptive counts do not establish comparative lift [I]. Confidence: **low**.

## 4. Examples

- Positive: `lease inform the sender immediately and destroy this original e-mail. [PARTY] (Pty) Ltd accepts no liability of whatsoever nature for any loss, lia` — inbound `ecfecac3-88e9-4b8e-88b7-36b29fd1661e`, PDF `a35487dc-f3b3-4800-9d84-fafd3b812abb`. Exact match is in sender legal footer/signature, not booking request.
- Unlabelled, not a negative: `Payment// [NAME]- [PHONE] — Good day Please acknowledge receipt of booking for [NAME] and charge below card for bed and breakfast.` — inbound `16e49443-2104-4067-8b28-4cf4e8f850c6`, PDF `d9fd2ff4-0c4b-4910-8712-a98f9c9935aa`; no party name in PDF, but no private-account label either.
- Unpaired label: `[HMS agency field contains a masked organization/code; no eligible inbound precedes PDF]` — staff message `fd6b3854-9ea6-4103-801d-57cdafa8ec22`, PDF `e6203659-fe7a-495e-896b-37a1486dfb4b`.

## 5. Implications for the product

- **Search order [I]:** query the normalized full company/agency name first; if no rows, try the first distinctive token (operational minimum 4 characters [I]), skipping legal suffixes and generic words (group, hotel, travel, services, holdings, company). Try a bracketed acronym only as a later fallback; no measured corpus evidence shows that a four-letter field code is safe as a standalone query [I].
- **Live search + picker [I]:** keep it as staff-assisted candidate retrieval, not auto-bind. This evidence cannot tell whether an LLM pick beats domain memory; only 1 positive email row [M] is pairable. Current code tries cleaned name then first distinctive word and returns candidates for staff selection [M]; it does not link automatically. The acronym is a third term [M], while the per-kind runner caps attempts at 2 [M].
- **Domain memory [I]:** do not claim lift yet. If added, use as a ranking/tie-break signal only, and require multiple independent same-domain labels with no disagreement; never use domain alone to bind.
- **Auto-bind rule [I]:** keep auto-bind off. Future binding should require one untruncated live HMS candidate of the explicit party kind, exact normalized full-name agreement, and an independent confirming signal; any conflict, code-only value, or domain-only evidence returns to staff. No numeric confidence threshold is calibrated by this sample.
- Code checked read-only: [party-match.ts](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/ai/party-match.ts), [pane-party-lookup.ts](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/ai/pane-party-lookup.ts), [party-index.ts](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/ai/party-index.ts).

## Open questions

- Is the repeated four-letter `Agency` value [M] a display name, agency code, or default? Confirm against a permitted HMS reservation export; not checked live here.
- Can the export include `company` and `bookingAgency` display names/native IDs for these confirmation numbers? Mail PDFs alone leave most rows unlabelled.
- Can the thread export include the originating inbound for the other named rows? 29/30 [M] named rows have no preceding eligible inbound in this snapshot.
