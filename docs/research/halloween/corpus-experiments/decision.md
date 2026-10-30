# Centurion journey decision

**Recommendation:** Use the HMS tools being rewritten to make a reviewable, correctly priced quote from the selected real email on both staff surfaces. Prove the new read-only quote path before broad cross-thread automation or the next HMS write workflow. The owner confirmed on 2026-10-30 that the tools are being rewritten from scratch. The previous recommendation to diagnose the old quote path first was wrong; checked-in legacy code is not evidence that the new tools are complete or should be reused.

## Evidence and limits

The saved 19–23 October slice contains 1,288 logical message records across 759 threads and 92 selected confirmation-PDF records. All 92 selected records matched later successful saved HMS captures, representing 87 unique confirmation identifiers. Among those 87 later records, 58 had source-of-business `E-Mail` and five had a populated CMS Booker Email field. These fields are not reliable eligibility rules, and the selected set is not representative. The later captures are not historical snapshots.

We directly reviewed [10 deliberately selected PDF anchors](booking-journeys.md), across all five stored dates, and [three independently selected request-first quote threads](quote-journeys.md). Selection favored structural candidates and variety, not random sampling. The quote summaries were checked against saved message rows. No selected confirmation PDF shares those three threads; a cross-thread outcome may still exist. These examples cannot estimate prevalence, linkage precision, recall or a production pass.

**Unavailable:** A complete proof that any reviewed quote never had a confirmation PDF anywhere in the mailbox cannot be made from this export: it lacks a complete attachment inventory and the 92 PDFs are a selected subset. QJ-03 has no selected confirmation in its thread or addressed to its requester, but a PDF sent to another party or outside the slice remains unknown. B02 satisfies the bounded search for a case where no “booked” reply was found; proof that no differently worded or unsaved staff reply exists is unavailable.

A saved email or PDF is not proof of delivery; an email's claim of an attachment is not file-level proof. Stored timestamp timezone semantics are unverified. The owner explains that HMS queues and batches confirmation emails, so their stored timestamps must not be treated as the booking time.

## What the journeys show

| Observation | Evidence | Consequence |
|---|---|---|
| A complete-looking booking trail is possible but not universal | B03 has an inbound request, reply with a matching message header and a customer-addressed confirmation PDF; a later internal forward has identical PDF bytes. B02 has a plausible matching PDF but no staff “booked” reply among reviewed candidates. | Preserve each event and show uncertainty. Do not require a “booked” sentence or assume a missing reply means no booking. |
| Many-to-many correspondence matters | B04 has two different guest requests from one agency close together. B08 has one forwarded conversation referring to multiple confirmation IDs and an unavailable guest-list attachment. | Same contact or domain can find candidates, not choose the guest. A message can relate to several bookings, and a booking can span threads. |
| Useful matches can be outside a short window or a source category | B04's linked request precedes the PDF by about 50 stored minutes. B07 precedes it by about 61 minutes and its later HMS source-of-business value is Tour Operator. | Never use ±30 minutes or `E-MAIL` as hard eligibility filters. Time and source category are clues. |
| Quotes need not become bookings | QJ-01 requests a quote and staff say nothing is held. QJ-02 negotiates room-only pricing and remains unresolved in its thread. QJ-03 withdraws a quote, not a reservation. | Start quote evaluation from inbound requests, not just confirmation PDFs. Distinguish quote, decision to proceed, existing booking and cancellation. |
| Documents and HMS snapshots can disagree over time | In B09 a French-language guest disputes an arrival date; two same-ID PDFs show different arrival dates, independently checked in the originals. Later HMS state differs again. | Preserve request, staff response, each document version and later HMS read separately. Do not turn the latest value into historical truth. |
| Text can mislead | In B05 an identifier appears inside quoted-looking text in a later reply, but not in the earlier saved inbound body. In B10 a related-looking invoice request cannot be tied to the selected booking because its attachment is unavailable. | Do not assume quoted text was unchanged, infer a relationship from the sender alone, or treat an unavailable attachment as empty. |

Case detail and owner-only source pointers: [booking journeys](booking-journeys.md) and [quote journeys](quote-journeys.md). The [case-product map](case-product-map.md) identifies the recognition and HMS implications of each investigation. The stopped run's [aggregate candidate counts](prior-agent-leads.md) were independently reproduced, but remain exploratory co-occurrences, not verified links or accuracy measurements.

## Next product slice: quote-ready on open

1. **Classify and extract the selected request.** Recognize a human quote request, including travel agencies, room-only, dinner add-ons and multiple rooms. Preserve dates, counts, occupancy, requested board, contact and known company/agency separately. Show missing or contradictory details instead of inventing them. A request to withdraw a quotation is not automatically a reservation cancellation.
2. **Prepare with read-only HMS data.** Search for company or agency candidates in the correct property. Let staff select a party rather than binding solely from an email domain. Read availability and eligible public or selected-party rates for the actual dates and room groups. Keep rates and dinner separate when HMS does not supply a supported dinner price. A discount needs the product's authorization field. Do not represent available inventory as held.
3. **Give staff one reviewable result.** Show room counts, per-night rate, inclusions and total with explicit uncertainty and source; generate the quote PDF on staff action if needed. Provide the editable, unsent reply in both Outlook and webmail. Do not put the company name in the reply body. If full, default to a one-line decline; only include an alternative the staff member selects.
4. **Stop safely when evidence is missing.** If party, price, availability or dinner pricing is uncertain, show what needs review rather than guessing or implying a booking. Quote preparation is read-only; creating or changing a reservation requires the separate staff-approved write flow.

This targets the product's quote-first priority using the tools being rebuilt. The steps above are capability requirements, not claims that the new tools already support them. The slice does not require a universal journey graph, automatic cross-thread association, new parsing pipeline, or autonomous booking. The examples show why the slice matters; they do not establish that it is the most common request or quantify its ROI.

## Rewrite status versus historical source

The [source inventory](tool-inventory.md) records older source paths as historical context, not capabilities of the rewrite. Their existence does not mean they work, will be reused, or should be debugged first. The owner says the HMS tools are being rewritten from scratch; the new quote, party and availability tools' coverage and integration are not established by this audit. A separate, currently untracked [Stay 360 verification note](../../../../apps/server-pilot/tooling/playwright-quote/STAY360-READ-VERIFICATION.md) reports exploratory confirmation, Record View and Guest Details reads, not a proven new quote or pricing tool.

The [historical capture verifier](verify-hms-captures.py) confirms successful saved Stay 360, Record View and Guest Details results for the selected PDF records. A separate [read-only runtime observation](runtime-observation.md) records the pilot checkout, online processes and a limited startup/configuration check of the quote-rate switch. Neither proves effective in-process flags, current HMS rate correctness, automatic readiness, or both-surface end-to-end behavior.

The agent's create tool is a dry run, whereas a separate source-defined pane create path has guarded preview and commit. A separate amendment path also exists. Neither source path establishes current write authority or effective deployment. Do not infer that finding and reading a stay is live for Centurion from a registry entry or standalone reader alone.

## How to prove the recommendation later

- Form a versioned request-first evaluation set from the saved period. Include quote-only, declined, withdrawn, unanswered, agency, room-only, dinner and multi-room cases when independently supported. Keep their later outcomes separate. These 13 examples are a research sample, not the evaluation set or a pass.
- Replay each request with only the email and attachments available at that decision point. Later replies, PDF versions and HMS observations may be outcome evidence, never input. Ground expected actions and prices in independently verified staff artifacts and relevant contemporaneous HMS evidence; label unsupported fields unknown rather than inventing gold. The owner previously preferred staff artifacts over manual labeling.
- Compare baseline and changed versions on the same rows. Report classification, extraction, party ambiguity, availability and rate correctness, PDF/reply usefulness, abstentions and errors separately. The historical 85% quote-recall target and 100 outbound-grounded row target apply to their accepted plan, not automatically to every metric or this sample.
- When the rewritten quote tools are ready, verify the current property, effective runtime and the new HMS quote path with an authorized read-only probe before claiming staff readiness. This research inspected process metadata but made no live HMS quote probe, deploy, flag change, HMS write or outbound email.

## Booking and amendment implications

A clear request to proceed can lead to staff-approved booking, but an email, voucher or later PDF must not silently trigger creation. Find the existing reservation first when the request concerns a stay. For an amendment, compare the requested fields against the found current record, show any disagreement and keep writes behind approval. B09 also includes an airport transfer; the currently inventoried amendment fields do not establish transfer-write support. Preserve such requests for staff rather than pretending the full amendment is covered.
