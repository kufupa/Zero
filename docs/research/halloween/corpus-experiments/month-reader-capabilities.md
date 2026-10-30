# Rebuilt Stay 360 readers: research boundaries

This is a snapshot of the readers and captures available during the 2026-10-30 investigation. The later [HMS Cloud tools](../../../../apps/server-pilot/tooling/hms-cloud/README.md) also include a detailed guest-form reader and other modules.

## Why this matters

The owner is rebuilding HMS tools from scratch. The prior run mistakenly focused its recommendation on legacy quote code. The current research maps observed staff needs to the newer readers without assuming they are complete, deployed, or appropriate for a new quote.

## What the new reader work covers

| Reader | Source-defined behavior | Useful for journeys | Boundary |
|---|---|---|---|
| **1a: confirmation** | Search Stay 360 by confirmation, return selected cards and rendered grids, and use optional name/date hints to disambiguate. Fail rather than guess when results are ambiguous or capped. | Find an existing stay and read displayed stay and association context. Observed fields include dates, room type, rate/meal plan, average nightly amount, total, organization and booking agency. | A new quote request often has no confirmation. Existing-stay amounts are not a current availability or eligible-rate quote. Unopened tabs and hidden content are excluded. |
| **1b: Record View** | Verify the selected confirmation, open Record View and read visible expanded fields and rendered grids. | Compare displayed stay dates, adults and children, rate/meal facts, organization, booking agency and contract, booker, reservation status and notes when those fields are rendered. | Later HMS state does not establish the state when an earlier email was sent. A visible agency contract is not proof of current quote eligibility. Hidden tabs and unloaded grid pages are excluded. A read field is not proof it can be written. |
| **1c: Guest Details** | Open the Guest Details tab after 1b and return rendered fields and current grid content. | Review guest and arrival/departure context for an identified stay. | The saved inventory says the guest row was not selected; unloaded pages and hidden content are excluded. Do not assume it proves transfer fulfillment or complete guest data. |

Source: [merged confirmation reader](https://github.com/kufupa/Zero/blob/7216c2fd5e8d0ec236a06ce12b2a46fbaf537816/apps/server-pilot/tooling/playwright-quote/stay360-confirmation.mjs#L262), [merged Record View reader](https://github.com/kufupa/Zero/blob/7216c2fd5e8d0ec236a06ce12b2a46fbaf537816/apps/server-pilot/tooling/playwright-quote/stay360-record-view.mjs#L5), [merged Guest Details reader and field inventory](https://github.com/kufupa/Zero/blob/7216c2fd5e8d0ec236a06ce12b2a46fbaf537816/apps/server-pilot/tooling/playwright-quote/stay360-guest-details.mjs#L5), and its [exploratory verification note](https://github.com/kufupa/Zero/blob/7216c2fd5e8d0ec236a06ce12b2a46fbaf537816/apps/server-pilot/tooling/playwright-quote/STAY360-READ-VERIFICATION.md). Source and saved observations do not establish current production readiness or pricing correctness.

## Recent main-branch work

GitHub reported the following PRs merged. This working branch also has untracked reader files. In a local byte comparison with the merge commit for #731, 1b and 1c matched, while 1a differed in name-matching logic and its field-inventory comments. Do not assume the local 1a behavior is the merged or deployed behavior.

- [Confirmation reader #718](https://github.com/kufupa/Zero/pull/718).
- [Record View reader #719](https://github.com/kufupa/Zero/pull/719).
- [Concurrent-read stabilization #727](https://github.com/kufupa/Zero/pull/727).
- [Guest Details and Notes handling #730](https://github.com/kufupa/Zero/pull/730).
- [Confirmation disambiguation #731](https://github.com/kufupa/Zero/pull/731).

## Populated values versus rendered controls

An [aggregate check](month-reader-population.py) matched the added-period PDF anchors to later saved captures by attachment ID and filename token, then kept the first matched capture per token. Across **294 distinct filename tokens**, all 294 had rendered first-name and last-name controls in 1c, but neither control was populated in any capture. All 294 had aligned visible guest-grid rows with nonempty cells under both name headers. Arrival-type, arrival-time and arrival-notes form controls were also rendered but blank; the visible arrival-time grid column had a nonempty cell in four captures. Nonempty means only a nonblank rendered value, not semantic validity or completion of a transfer. Counts were independently replayed for the guest-name and arrival-time checks.

In those same later captures, 1b rendered and populated stay-date, occupancy, meal-plan, rate-plan and average-rate controls for all 294 tokens. These selected confirmations are not representative of all requests, and a displayed historical-stay amount is not a new quote or proof of current eligibility. Controls, visible grid rows, selected guest details, hidden pages and completed actions are different evidence. The reader did not select a guest row; these counts neither prove a defect nor establish complete guest data.

**Research consequence:** Inspect original request requirements first. For existing-stay cases, assess whether the available saved 1a–1c observations answer the specific question. For new quotes, independently establish what the rewritten availability, party and rate tools can do. Do not use post-booking state as an input to the earlier request or infer a booking, payment, delivered email or write from a visible read.
