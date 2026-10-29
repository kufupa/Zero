---
title: Next-day HMS booking priorities
date: 2026-10-27
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
---

# Next-day HMS booking priorities

## Owner request

Ask 314: “list in prio what we should do n why... goal is by tmrw we have new bookings + provisial HMS quotes (not excel) working e2e. table output”. Target date: 2026-10-28; no exact deadline or execution authorization was supplied. Excel is outside this target, not removed from the roadmap.

Working interpretation: a provisional HMS quote is a real provisional reservation and its HMS confirmation/price offer, rather than an Excel calculation. Owner wording and historical evidence support this interpretation but do not prove every quote must create a reservation. Confirm the exact native status, letter and recipient before acting.

## Evidence and priorities

| Priority | Requirement | Current evidence / limit |
|---|---|---|
| 1 | Complete Pomerado read trial and prove HMS provisional/create operation. | Ask 313 retry active at 20:36 UTC; no published read or three-case comparison. Prior trial incomplete at sign-in. Read proof is not create proof. |
| 2 | Verify HMS quote/confirmation delivery and correct status/recipient. | HRDAV Labtest E3 created a Non-Guaranteed stay through a CLI-driven runner, not a signed-in Outlook session. #654 ticks HMS Send Mail. E4 delivery was inconclusive because the collector was not ingesting; do not assume no email arrived. Check CMS message list and inbox health before another test create. |
| 3 | Extract and prefill booking facts, hotel, agency, occupancy, ages, dates and chosen rates. | Source audit found hotel-forward prefetch skipped, company extraction errors, missing party-property hydration and quote-only rate/availability prep. Triage/pane shape is owned by a separate child chat. |
| 4 | Make native quote and booking correct per property, including linked agency, required fields, children and per-room outcomes. | Source audit found child-bearing create refused, supplied required fields wrongly blocked, agency association unverified and multi-room receipt collisions. HRDAV one-room E3 and multi-room rate quote are individual test passes, not full booking coverage. |
| 5 | Support requested native Add-Ons. | Owner ask 279 includes Add-Ons in new-booking completeness. No native Add-On reader, writer or readback proved. Do not silently remove scope. |
| 6 | Complete staff review, safe create, result and confirmation on both pane surfaces. | Existing #644 receipt and #654 send path are partial; actual HMS status and delivery need proof. Staff approve writes. Never automatically resend an uncertain create. |
| 7 | Run post-deploy end-to-end proof and representative accuracy checks in both hotels. | HRDAV and HRCEN must each pass quote and booking proof on the deployed SHA; HRCEN cloud availability and create remain unproven. One canary is progress, not the full accuracy bar. |

Parallelize evidence gathering, extraction and pane design with provider trial, but coordinate shared files and property locks. The separate triage/pane chat is shaping UI. Do not interrupt the active Pomerado controller.

## Shape gates

| Gate | Requirement / open fact |
|---|---|
| G1 properties | HRDAV and HRCEN; derive hotel from mailbox; unknown property fails closed. |
| G2 canaries | Each hotel: one approved Labtest booking and one approved provisional HMS quote. Verify native status, dates, party, occupancy, room, price, recipient, requested Add-Ons, screenshots and readback; both Outlook and webmail viewers after the last deployment. Exact quote semantics remain to be confirmed. |
| G3 flags | Check the current process-specific create, provider and hotel flags and dependencies before any changes. Real-guest create remains subject to explicit owner authorization; existing historical flag reports are not current proof. |
| G4 diagnosis | Record and diagnose repeated live failures from actual screenshots/DOM; do not invent an attempt-count stop where the owner specified timeboxing. Share the existing property lock and reconcile uncertain writes before retries. |
| G5 timing | Tomorrow is an owner target, not a reliable completion forecast. No successful Pomerado mint or complete create/Add-On chain has been measured. No defensible full ETA or LOC sizing yet. |
| G6 freshness | Canary each property on the deployed SHA after the last workflow-changing deployment; prove staff bundle loads. |
| G7 failure copy | Show staff the actionable cause: setup, hotel unavailable, lock busy, invalid or missing details, or uncertain outcome. |
| G8 patch versus replacement | Owner directed Pomerado as the primary runtime. Keep existing deterministic runners as a fallback, not a silent pivot or deletion. Switching runtime requires owner decision. Avoid third property-specific special cases. |
| G9 score | Quote prices and rate plans match staff truth on at least 10 plannable threads; booking extraction target is at least 100 independent staff-created examples per hotel as requested. Independent HMS/staff evidence, not system-generated answers. |
| G10 holds | Explicit staff approval for every HMS write; real-guest writes only under current authorized flag; no independent email sends, cancellation-penalty acceptance, new GitHub Actions or disruptive deploy. |

## Units and ownership

- Provider read, create and Add-On operations: HMS/write lane, Grok 4.6 high; review under the currently applicable owner-selected reviewer and Greptile. Scope and LOC unknown until native tool contracts and operation proofs exist.
- Extraction, prefill and booking validation: isolate product files from the child pane lane; small mechanical slices to Luna max, escalated for HMS/write behavior. LOC unknown; avoid parallel edits to shared booking-card files.
- Email delivery diagnosis and contract verification: read-only evidence first. Do not repeat a create until an uncertain write is reconciled.
- Surface and truth-set verification: both hotels and both staff surfaces. Compile independent answer keys offline; serialize live browser work by property lock.

No implementation, install, flag flip, deploy, send or live HMS action was launched by this prioritization.

Sources: [owner asks](../context/OWNER-ASKS.md), [current state](../context/ACTIVE.md), [booking completeness](2026-10-27-001-booking-completeness-plan.md), [booking parity](../research/2026-10-27-next-run/booking-parity.md), [booking and cancellation reassessment](../research/2026-10-27-next-run/pomerado-delivery-reassessment.md), and the origin/main Da Vinci handoff in `docs/plans/2026-10-27-001-dv-run-007-handoff.md`.
