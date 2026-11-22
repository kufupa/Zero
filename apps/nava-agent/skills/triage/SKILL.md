---
name: triage
description: Use when a selected hotel email needs routing, including replies, notices and overlapping requests.
---

# Triage

Read the selected message with `mail_read_thread`. Use [common rules](../references/common.md), [proposal bindings](../references/tools-and-proposal.md) and [routing details](references/rules.md).

Decide what staff are being asked to do **now**, before loading a workflow. The current instruction outranks the subject, quoted history and any attachment used only as background. In a forward relaying work to reservations, read the forwarded request as its payload; an old request quoted in a reply does not become current. A reply can accept an offer, supply a requested booking detail, or chase a specific outstanding quote. A thank-you, progress report or generic status check does not restart the prior task.

| Work to do now | Workflow |
|---|---|
| Reserve new rooms, accept an offer and ask to proceed, or send an accommodation order or rooming list to book | Create |
| Ask for rates, availability, inventory, an event quote, or changes to an unaccepted quote | Quote |
| Change an existing stay or room block: extend, shorten, move dates, change rooms or guests, or add services | Amend |
| Cancel a booked stay or room, or ask the terms of a prospective cancellation | Cancel |
| Supply a voucher or proof of payment for an existing stay | Filing |
| Check or reconfirm an existing booking as-is, handle billing or settlement, or report a completed outcome | Triage |

- Read the selected voucher or rooming list to tell an **order for lodging** from paperwork for a stay the hotel already has. A supplier order specifying guests, stay dates and rooms can instruct Create on its own. A pax count, voucher number, agency booking reference or prepayment instruction is not evidence that the hotel has already booked the stay. A matching hotel confirmation, earlier hotel acceptance of that stay, or wording that submits a document for the existing booking points to Filing. An updated voucher or list that asks for changes to an existing stay points to Amend.
- Distinguish a decision to go ahead from a question before deciding. “Please book the quoted rooms” is Create even if the sender also asks how to pay. Prices or revised billing requested as part of an explicit change to an existing stay do not displace Amend. A new checkout stated as an instruction to update reservations is Amend even after a phone agreement; a report that the system change is already complete is Triage.
- Route the actual request even if details or a matching stay are missing. Use the disposition to show whether staff can proceed. An invoice copy, commission claim, payment link, card-charge instruction or payment-status check alone is Triage; a voucher copied in as billing context does not change that. A remittance or POP supplied for the stay is Filing, including a forwarded submission or one that also asks for receipt acknowledgement.

Load each applicable workflow and use its workflow name when publishing; route and action count are independent. Keep a genuine second ask visible: if a sender asks to book and explicitly requests a fresh quote for the same stay, publish Quote as well so staff can price it before deciding on the booking.

For Triage, use the dispositions and lookup shape in the routing details.
