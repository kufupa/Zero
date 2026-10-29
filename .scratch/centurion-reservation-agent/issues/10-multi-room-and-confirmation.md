# Define complete multi-room booking and confirmation

Type: grilling
Labels: wayfinder:grilling
Status: open
Assignee: unassigned
Blocked by: 02, 06, 08, 09
Mode: HITL

**Map:** [Centurion end-to-end reservation agent](../map.md)

**Dependencies:** [Map Centurion native booking fields and Add-Ons](02-native-fields-evidence.md), [Define the reservation case and email boundaries](06-case-identity.md), [Define one approval and partial-result recovery](08-single-approval.md), [Decide prelookup, eligibility and price freshness](09-lookups-and-rates.md)

## Question

What exact HMS writes and independent readbacks complete one or more rooms/stays from the reviewed email, including child ages, agency, guarantee, room/rate and CMS confirmation?

Reuse the existing one-click room loop and linked-room Labtest evidence. Determine when rooms share an HMS parent and when guests/dates require separate stays. Cover the current added-room 13–17 child-band refusal, CMS ID nonblank owner rule, correct Centurion recipient/template and the separate HMS Send Mail side effect. Do not assume a visible form value proves persistence or delivery.

**Starting evidence:** [room loop](../../../apps/mail/components/quote-workflow/booking-card.tsx) · [linked-room runner](../../../apps/server-pilot/tooling/playwright-quote/add-room-stay.mjs) · [CMS owner rule and lookup](../../../docs/research/2026-10-28-hrdav-cms-message-id-codes.md) · [latest dated Labtest handoff](../../../docs/context/ACTIVE.md).
