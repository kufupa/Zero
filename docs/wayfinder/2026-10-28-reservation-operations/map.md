---
title: Nava reservation operations
labels: [wayfinder:map]
status: open
---

## Destination

An implementable, evidence-backed product and technical direction for Nava to handle reservation operations across Centurion SaaS and Da Vinci's LAN-to-SaaS move: price quotes, provisional and prepaid bookings, native hotel-specific fields and Add-Ons, payment workflow, amendments and cancellations. The result is a route to delivery and proof, not implementation or deployment.

## Notes

- **Evidence first:** reuse existing owner asks, staff interviews, corpus work, current code and trial evidence. Ask the owner only about genuine unresolved choices; never ask again for a decision already recorded. Prefer a targeted missing observation over another broad research dossier.
- The owner chose reservation operations first and parity for every field, lookup and hotel-specific option needed by a supported workflow. Plan the workflows together around shared capabilities; don't infer that all must be released simultaneously.
- Two quote-stage outcomes were previously chosen: **Make quote** and **Create provisional booking**, using one intake. The later owner request includes an HMS provisional quote, not an Excel-only solution. Verify native status, document and recipient from evidence. [Prior decisions](../../context/DECISIONS-2026-10-20.md#owner-decisions-1530z-ask-163) · [provisional plan](../../plans/2026-10-27-010-hms-booking-provisional-priorities-shape.md)
- The owner wants the full staff payment workflow. Distinguish an agent voucher, payment evidence, actual payment state and a booking request; do not guess unseen posting steps.
- The owner now says to skip automated channel messages, including failed-integration notices. Human travel-agent requests remain in scope. This newer choice supersedes the older request to surface those channel notices.
- Self-host browser/tools; approved Azure AI is acceptable. Compare against the existing stack before selecting a replacement. The owner is open to one approval covering multiple writes and selective automation later; neither idea changes present authorization by itself.
- Centurion has moved online; the owner says Da Vinci will move on **16 November 2026**. Treat these as separate deployments and revalidate each property at cutover.
- Current [product rules](../../../PRODUCT.md) still govern live actions, per-write approval, property locks, guest data and Labtest; cancellation is lab-only. Nava's reply stays unsent. HMS-native confirmation delivery is a separate side effect that must be understood.
- This is the local-Markdown tracker fallback: no configured issue-tracker convention was found. Tickets are individual files under `tickets/`; status, assignee and dependency metadata are in each file. Open, unclaimed children can be found by searching that directory for `status: open` and `assignee: unassigned`; a ticket is unblocked only when all linked blockers are closed. Claim first by setting the assignee. On resolution, put the answer in a separate `resolutions/` comment file, close the ticket and add its named link and one-line gist to Decisions so far. Resolve at most one non-research ticket per session.

## Decisions so far

<!-- Closed decision tickets are indexed here when resolved. -->

## Not yet specified

- Additional property-specific branches and cutover differences that only become clear from the remaining HMS observations.
- Whether other hotel onboarding or staff-permission variations change the route once the first two deployments are understood.

## Out of scope

- General guest support beyond reservation operations; replacing staff's Outlook workspace.
- Implementing, deploying or conducting unapproved real-guest actions as part of this map. Profitroom automation remains outside the current product scope.
