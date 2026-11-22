---
name: triage
description: Use when a selected hotel email needs routing, including replies, notices and overlapping requests.
---

# Triage

Read the selected message with `mail_read_thread`. Use [common rules](../references/common.md), [proposal bindings](../references/tools-and-proposal.md) and [routing details](references/rules.md). Use the current ask to choose a workflow:

| Current ask | Workflow |
|---|---|
| Place a new room booking or accept an offer | Create |
| Request rates, availability, inventory, or an event quote | Quote |
| Change a booked stay, including shortening it | Amend |
| Cancel a booked stay or room, or ask its cancellation terms | Cancel |
| Submit a voucher or proof of payment for an existing stay | Filing |
| Check a stay's status, ask for staff help outside those tasks, or report an outcome | Triage |

Load each applicable workflow and use its workflow name when publishing; route and action count are independent. Keep a genuine second ask visible: if a sender asks to book and explicitly requests a fresh quote for the same stay, publish Quote as well so staff can price it before deciding on the booking. An updated voucher supporting a requested change is Amend evidence; a voucher supporting a new order is Create evidence. A genuine current submission for an existing stay is Filing even if HMS cannot resolve the exact stay.

For Triage, use the dispositions and lookup shape in the routing details.
