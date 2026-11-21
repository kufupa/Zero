---
name: quote
description: Use when the selected hotel email requests a quote, availability, inventory, or event pricing before authorizing a booking.
---

# Quote

Read [common rules](../references/common.md), [proposal bindings](../references/tools-and-proposal.md), [criteria rules](references/rules.md) and [reply drafts](references/replies.md). Keep availability, inventory and event RFQs in Quote. A separate instruction to book goes to Create.

1. Build the editable quote criteria from the request before calling HMS. Keep separate date groups and room rows. Use one quote action per requested quote or party, each with a stable, nonempty `quote_id`; keep alternatives distinct within the quote. Keep `bookings: []`. Keep dates, board and any requested room types under `/actions/0/details/groups` (or the matching action index). Explicit single occupancy for a stated number of guests means that many rooms. For manual inventory or event scopes, use `staff_review`; preserve the supplied date groups, use empty `rooms` where no room scope is stated, and do not call HMS to price an invented stay.
2. For a missing or conflicting required criterion, leave the unknown value null, use `needs_info` and ask for the actual gap. With complete criteria, call registered `hms_quote` read-only at the requested scope. A booking-size limit does not apply to an availability inquiry. If HMS cannot price the request (for example `TWIN_NO_PRICE`), use `needs_info` with all known request fields intact and state the missing HMS price. Missing occupancy also stays `needs_info`; ask for occupancy only if it is missing. Do not ask the guest to fix tool coverage.
3. Publish from the same source criteria as the tool request: reuse those rows unchanged through Publish, including on tool failure. Do not rebuild criteria from returned options or available subsets. Use editable specs at the actual paths. Keep unsupported room labels, board display text and extras out of native inputs. Report partial or unpriced groups distinctly and never equate no result with sold out.
4. Draft the cover and quote artifacts as described in the reply reference. Quote reads do not hold rooms or create a stay.
