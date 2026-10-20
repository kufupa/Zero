# L5 — Da Vinci reservationist workflow

## Answer

- This was not one live inbound-email-to-HMS-to-reply trace. The reservationist reviewed finished mail, described recurring work, and showed templates. A new reply being composed and sent was not shown.
- Mail is routed by work type and staff role: post-checkout invoices, channel messages, group requests, transfers, and routine reservations. Inbox folders are visible, but no active Outlook auto-rule was demonstrated.
- Da Vinci quote flow differs by booking type: group quote/proforma uses Excel; individual documents come from a system. A proforma follows quote acceptance. Confirmation starts provisional and needs a payment guarantee. These are spoken descriptions; exact HMS document steps are not shown.
- GDS/OTA work crosses SynXis, ProfitRoom, Infor, and channel extranets. Staff report manual checks, company-name fixes, voucher attachment, and channel-specific cancellation handling.
- Human Infor screen order is **not found**. Reviewed crops show Outlook messages and a PDF, not Infor. Availability, rooming-list entry, a Legacy-member marker, and deposit due dates are only described aloud.
- Template inventory covers **8/8** numbered sections in `templates.md`, for the interview segment 16:00–18:36. Appendix script reproduces the count. Pool-deck copy is retired.
- For Centurion, reuse a staged quote/provisional workflow and staff-approved writes; keep rates, guarantee terms, letters, extras, channel rules, and staff routing hotel-configurable. (inference)

## Method

- Read the 2026-10-14 [interview README](/home/orca/nava-research/davinci/2026-10-14-interview/extracted/interview-2026-10-14-handoff/README.md), [timestamped transcript](/home/orca/nava-research/davinci/2026-10-14-interview/extracted/interview-2026-10-14-handoff/transcript.txt), [frame-to-speech map](/home/orca/nava-research/davinci/2026-10-14-interview/extracted/interview-2026-10-14-handoff/mapping.md), [template transcription](/home/orca/nava-research/davinci/2026-10-14-interview/extracted/interview-2026-10-14-handoff/templates.md), and targeted crops. Compared with [Centurion shared facts](/tmp/opus-run-1020/research/common.md:3), [L0](/tmp/opus-run-1020/research/l0-known-facts.md:8), and [L4](/tmp/opus-run-1020/research/l4-infor-order-dropped.md:5).
- `SHOWN` means visible in a crop; `SAID` means spoken in the interview; `(inference)` marks cross-hotel or product-design conclusions. Interview times below are elapsed source timestamps. Timer values (for example, payment due dates) are spoken operating rules, not measured counts.
- No mailbox corpus, production, HMS, or network access used. No guest/person names, email addresses, phone values, card/bank details, or full email bodies reproduced. No corpus counts were run. The sole new count is the template-heading check above; its script is in the Appendix.
- Research route: local evidence only. No Exa/web or workers used. Model cost is not exposed by the session tools. **95 threshold: not met for human Infor screen order or broad hotel generalization (inference)**; the interview supports only the described Da Vinci practices. Centurion facts below are from supplied notes and were not re-queried.

## Findings (tables)

### From inbound mail to a finished reply

| Interview time | What happened | Evidence status and limit |
|---|---|---|
| 00:00–01:22 | Outlook opens on a reservation message. The reservationist reports duplicate forwarded mail appearing in Outlook and Sent Items. The interviewer proposes deleting forwarded duplicates after about an hour; no configured rule is shown. | **SHOWN:** Outlook and folder tree in `crop_0000_00000.0s.jpg`. **SAID:** duplication and Sent Items; the one-hour rule was only a proposal. |
| 02:03–04:32 | She reviews examples and routes work: post-checkout tax-invoice requests to invoice staff; Booking.com/Expedia messages to channel staff for Extranet replies; group requests to group staff; transport requests to the transport desk. Easier tasks may be forwarded to another staff member. | **SHOWN:** existing Outlook messages/forwards. **SAID:** routing practice. No routing rule or folder move was demonstrated. |
| 04:42–07:01 | For GDS bookings, staff attach emailed vouchers and add company names that did not arrive in the PMS feed. If a SynXis notification has not produced an Infor record, staff check/push it through ProfitRoom. They report checking each booking for company, notes, late arrival, and voucher. No voucher for a same-day arrival triggers a prepayment follow-up. | **SAID.** No Infor or ProfitRoom screen shown. |
| 07:06–08:00 | Agent card details are kept outside the reservation in a shared folder limited to Reservations and Reception; she says they are not attached to the booking. | **SAID.** Storage controls are Da Vinci-specific; do not assume Nava may read or copy these details. (inference) |
| 08:35–10:41 | Cancellation handling depends on timing, occupancy, group status, and channel. She says direct bookings normally need 48 hours' notice; some late individual cancellations cost one night, while groups can be charged the whole stay. For Booking.com/Expedia/Hotelbeds online bookings, the guest is directed to cancel on the original channel; hotel-side cancellation could leave commission payable. | **SAID.** These are Da Vinci rules, not Centurion policy (inference). The exact policy matrix is not shown. |
| 11:16–12:05 | After a quote is accepted, staff produce a proforma. Groups use an Excel document; individuals use a system-generated document. The confirmation template calls the reservation provisional and requests a payment guarantee; total and payment options are on the attached letter. She says payment is accessed through the confirmation; exact click/link is not shown. | **SAID.** Exact system, trigger, and send action are not shown. The interview does not establish that every quote creates an HMS reservation. |
| 12:31–15:01 | Transport and dinner may be separate services. Group charges can be added to the Excel quote and paid together on one folio. Banqueting uses SCS for venue/dinner work; the reservations participant says she uses it only when that team is unavailable. | **SAID.** Property/system-specific (inference). |
| 15:02–16:46 | Shuttle rates live in a personal Outlook signature, not the shared Da Vinci mailbox. Passenger count determines vehicle; the third-party provider is strict about matching them. She says rates normally rise on 1 December and still need an update. | **SHOWN/SAID:** signature card and transcript; see `templates.md` and `crop_0177_00960.5s.jpg`. Do not reuse its values for Centurion. (inference) |
| 16:54–18:36 | She walks through transport-desk, cancellation, confirmation, Indulge-package, retired pool-deck, annual-rate, and airport-pickup templates. See template table below. | **SHOWN/SAID:** Outlook Quick Parts/signature examples; the transcript explains timing and use. |
| 24:09–26:20 | In a group example, staff start from the requested room allocation; when asked, they say availability is present. They show a group Pro Forma PDF and describe entering guest names manually in the system. Requests continue with amendments/add-ons after the first reply. | **SHOWN:** forwarded mail and Pro Forma PDF (`crop_0295_01491.0s.jpg`, `crop_0298_01534.5s.jpg`, `crop_0305_01547.0s.jpg`). **SAID:** availability, manual system entry, and back-and-forth. This exchange is not a live Infor order. |
| 26:36–27:45 | Discount requests are common. Comp/educational rates go to an approver and form; repeat clients may be checked for a Legacy-member marker before quoting below BAR. | **SAID.** The marker and rate screen are not shown. |
| 28:49–31:05 | Staff ask for payment reminders. She says some agents pay 72 hours after booking; contracted agents pay 30 days before arrival. Staff review Infor deposit due dates daily; she suggests a reminder 2 days before the due date. | **SAID.** Deposit-due field name, payment posting, and reminder automation are not shown. These are spoken timers, not measured counts. |

The sequence above is a reconstruction across examples, not a verified single-case timeline (inference). In particular, the quote-to-proforma and confirmation-to-guarantee stages are described, but the operator does not demonstrate the HMS clicks or the final send.

### Outlook folders, visible fields, and Infor order

| Surface | What is visible or said | Finding |
|---|---|---|
| Outlook | `crop_0000_00000.0s.jpg` shows Inbox and folder labels including Bookings, Vouchers, and Booking.com. Sent Items is mentioned in speech. Some staff/role folder names are omitted here. | No processing rule is visible. The suggested duplicate-deletion rule is not evidence of a live rule. A separate restricted card folder is described as a shared drive folder, not an Outlook folder. |
| SynXis reservation email | The Outlook message in `crop_0000_00000.0s.jpg` shows property/source, confirmation/status, arrival/departure, room/occupancy, rate/policy, and daily-rate labels. | This is an automated mail, not an Infor screen. Personal values are omitted. |
| Group Pro Forma PDF | `crop_0298_01534.5s.jpg` and `crop_0305_01547.0s.jpg` show a `Pro Forma Invoice`, guest/stay labels (`Name`, `Arrival Date`, `Departure date`, `Accommodation`), `Block Conf #`, group check-in/out text, and a table ordered by room type, rate, dates, room count, and total. Extras and summary rows include total, deposit paid, and grand total outstanding. | This is a PDF/document, not an Infor screen. Field order here must not be treated as HMS form order (inference). |
| Infor screens / human field order | No Infor screen or exact Infor field label was found in the reviewed evidence. Speech says staff check availability, enter group names, add missing company names, inspect a Legacy-member marker, and use a deposit due date. | **Not found:** first screen, tab order, room grid, profile/history screens, exact rate fields, guarantee controls, and save/document steps. Reviewed later crops `crop_0328_01632.5s.jpg`, `crop_0329_01671.0s.jpg`, and `crop_0342_01844.0s.jpg` still show Outlook mail, not Infor. The handoff README describes the share as Outlook. |

### Outlook templates and local rules

| Template | Purpose / when used | Variables or required content | Rule for an agent |
|---|---|---|---|
| Airport transfer rates (signature card) | Reply to airport-transfer price enquiries. Card has vehicle classes, capacities, and one-way rates. | To arrange: flight number, arrival time/date, adult count, luggage, contact. Rate values omitted. | Use current hotel/transport-provider card. Confirm passenger count against vehicle; rates need dated refresh. (inference) `templates.md:22`; `crop_0177_00960.5s.jpg`. |
| Airport request to transport desk | Send a structured booking request to transport office. | Transport type, guest label, date/time, vehicle, pax, luggage/trailer, flight, pickup/drop-off, VIP meet-and-greet. | Match pax and vehicle; use the property's transport desk fields. `templates.md:68`; `crop_0186_01020.5s.jpg`. |
| Cancellation | Acknowledge guest cancellation; cancellation confirmation is attached. | Client salutation and cancellation-confirmation attachment. | Apply channel-specific cancellation rules first; template does not authorize an OTA cancellation. (inference) `templates.md:115`; `crop_0189_01034.0s.jpg`. |
| Confirmation | Send booking confirmation. | Provisional confirmation attachment; total/payment options on the letter. | Request payment guarantee. The reservation is not described as confirmed until guarantee arrives. `templates.md:139`; `crop_0193_01043.5s.jpg`. |
| Indulge Package questions | Send after guest confirms this package. | Arrival, dinner, and breakfast times; guest names for menus; optional add-ons. | Ask only for this property's package; the package is promoted for special occasions and appears in ProfitRoom. Reuse at another hotel only if configured there. (inference) `templates.md:163`; `crop_0195_01049.0s.jpg`. |
| Pool Deck Renovations | Former notice about restricted pool-deck access during works. | No active variable identified. | **Retired — do not send.** `templates.md:189`; `crop_0204_01068.5s.jpg`. |
| Rates for 2026 | Rate letter to regular guests; attach the PDF rate letter. | Guest salutation; effective period and prices are in the attached letter. | Match letter to current approved rate version. (inference) `templates.md:201`; `crop_0207_01085.0s.jpg`. |
| Transfer pickup | Guest-facing directions after airport pickup is arranged. | Pickup location, driver/signboard instructions, guest names for driver, transport-office contact. Contact value omitted. | Keep the iPad/signboard and arrival-hall instructions; contact details must be property-configured. (inference) `templates.md:225`; `crop_0208_01098.0s.jpg`. |

The Quick Parts list is visible around `crop_0206_01082.5s.jpg`. Shuttle prices sit in the personal signature; the cancellation and confirmation replies, package questions, rate letter, and pickup note are separate content. The `Signatures…` menu item is not counted as a numbered template section.

### Da Vinci vs Centurion

| Topic | Da Vinci interview | Centurion supplied facts | Shared vs hotel-specific |
|---|---|---|---|
| Rates and availability | Contract rates exist; staff check a Legacy-member marker for some repeat clients and quote below BAR. Rate screen/order is not shown. | Centurion safe reads separate Room Availability and Display Rates; company/agency can affect rate context. Exact human HMS order is not found. [L0:64](/tmp/opus-run-1020/research/l0-known-facts.md:64) [L0:68](/tmp/opus-run-1020/research/l0-known-facts.md:68) | **Shared:** stay criteria, availability, rate evidence, and party context. **Config:** room/rate catalog, contract/loyalty eligibility, approval roles, and precedence. (inference) |
| Quote and documents | Group quote/proforma uses Excel; individual documents are system-generated. Proforma follows acceptance; confirmation is provisional pending guarantee. | Centurion owner model links many quote/new-booking asks to an unpaid provisional booking and HMS confirmation letter with Proforma. L0 records exceptions and hand-made documents; the letter alone is not payment truth. [common.md:5](/tmp/opus-run-1020/research/common.md:5) [L0:8](/tmp/opus-run-1020/research/l0-known-facts.md:8) [L0:9](/tmp/opus-run-1020/research/l0-known-facts.md:9) [L0:10](/tmp/opus-run-1020/research/l0-known-facts.md:10) | **Shared:** one stay case can move from pricing to provisional booking. **Config:** document source, trigger, template, and whether group work remains a manual quote. Do not create a booking for every enquiry without the owner-approved transition. (inference) |
| Payment and cancellation | Guarantee is required before confirmation; reminder terms vary by agent contract. Direct, group, occupancy, and OTA cancellation handling differ. | Centurion first scope is unpaid quote/provisional work; paid amend/cancel is a separate phase. Voucher, guarantee, POP, and posted money are distinct evidence; cancellation and payment policy remain open. [common.md:5](/tmp/opus-run-1020/research/common.md:5) [L0:55](/tmp/opus-run-1020/research/l0-known-facts.md:55) [L0:108](/tmp/opus-run-1020/research/l0-known-facts.md:108) | **Shared:** explicit payment/evidence states. **Config:** guarantee rules, due-date calendars, cancellation windows, fees, and channel constraints. Never copy Da Vinci rules into Centurion. (inference) |
| Transfers and extras | Signature rate card, transport-desk form, pickup note, Indulge package, and SCS/banqueting path. | Centurion shuttle, pickup, and package rules are **not found** in `common.md`, L0, or L4. | Model extras generically; keep names, prices, fields, and fulfillment owners per hotel. (inference) |
| Channels and staff routing | Extranet messages, SynXis/ProfitRoom sync, invoice/group roles, and a restricted card folder all affect the work. | Nava reads inbound Outlook/webmail, uses deterministic Playwright HMS tools, requires staff approval for HMS writes, and never sends email. [common.md:3](/tmp/opus-run-1020/research/common.md:3) | Share intake, evidence, approval, and draft handling; configure channel integrations, do-not-touch rules, staff routing, and protected-data boundaries per hotel. (inference) |
| Screen and pane order | No human Infor order found in this interview. | L4 reports current pane code order: Contact → Agency & company → HMS notes → Stay → Availability & rates → Extras & alternatives → Documents. That is pane order, not proof of human HMS order (inference). [L4:5](/tmp/opus-run-1020/research/l4-infor-order-dropped.md:5) [L4:36](/tmp/opus-run-1020/research/l4-infor-order-dropped.md:36) | Use human observation to validate later; do not infer Infor tabs from the pane or automation. (inference) |

### Pain points and automation requests

| Pain point | Evidence | Automation signal |
|---|---|---|
| Forwarding creates duplicate mail and Sent Items clutter; staff say they have to delete copies. | 00:21–01:22 | Reservationist wants less duplication. Delayed auto-delete was the interviewer's idea, not a confirmed staff rule. |
| GDS data can be incomplete; company name, notes, late-arrival meaning, and voucher status need repeat checks across systems. | 05:01–07:01 | Good candidate for a completeness checklist/read-only cross-system evidence panel. (inference) |
| Group work needs manual rooming-list entry, Excel documents, and repeated amendment/add-on handling. | 04:30–05:23; 24:09–26:20 | Reservationist explicitly asks for help with quotes; do not infer permission for autonomous group booking. (inference) |
| Payment follow-up is manual and terms differ by agent. | 28:49–31:05 | Explicit request: payment reminders tied to the right due date. |
| Transfer prices sit in a personal signature and need periodic update. | 15:02–16:46 | Put current transport rates and validity in hotel configuration, not a hidden prompt. (inference) |
| Infor downtime interrupts system work. | 27:57–28:14 | She returns to tasks possible without Infor; no specific offline process is described. |

## What this means for the agent/pane

- **Workflow:** Keep one stay case for quote and new booking, but track stage separately: request → priced quote → accepted/provisional booking → guarantee/payment evidence. The accepted/provisional transition must be explicit; a quote request alone is not proof that staff should save a reservation. (inference)
- **Pane order:** Start with mail/thread and action; capture dates, occupancy, requested room lines/group size; show an initial all-room availability/rate grid before room choice; then resolve guest/company/agency/loyalty context and rerun final scoped pricing; collect group allocation, extras, guarantee/payment, and document choices; present one exact staff-approved HMS write. (inference)
- **Evidence:** Show source email/attachment, missing fields, system freshness, room/rate evidence, and why the pane picked a profile/contract. Do not hide nightly stock/prices or conflate a PDF field order with HMS screen order. (inference)
- **Taxonomy:** Keep primary action separate from work-needed state and overlapping flags such as group, voucher, OTA notice, payment proof, invoice, and extra service. A voucher or guarantee must not become a paid boolean. (inference)
- **Architecture:** Use a deterministic workflow spine and deterministic HMS tools; bound the LLM to classification, extraction, explanation, and clarification. Staff approve the prepared mutation; read back the result. Keep Nava's email draft unsent for staff. (inference; [Centurion boundary](/tmp/opus-run-1020/research/common.md:3), [L0 architecture](/tmp/opus-run-1020/research/l0-known-facts.md:105))
- **Hotel playbook:** Configure rate authority, room/board names, guest/party profiles, document generator, guarantee and payment terms, cancellation rules, OTA handling, transfer rates, extras, role routing, and sensitive-data policy per property. Share workflow mechanics, evidence shape, approval, and audit trail. (inference)
- No final architecture or human screen order is settled by this lane. L0 says the owner has not recorded a final architecture GO; this interview adds constraints, not that decision. ([L0:14](/tmp/opus-run-1020/research/l0-known-facts.md:14))

## Open gaps

- Shadow one real Da Vinci request from inbox through Infor lookup/create, document generation, guarantee, and final staff reply. Capture the exact Infor screen and field order; current evidence has no such trace.
- Confirm whether a quote acceptance always creates an Infor provisional booking, which system generates the individual document, and who/what sends the confirmation or proforma.
- Confirm exact party/profile/history checks, rate authority order, and how Legacy membership is found. The interview does not show these screens.
- Get owner-approved payment and cancellation rules per hotel and agent contract; distinguish guarantee, voucher, POP, posted deposit, and due date.
- Confirm current Outlook rules/folders and desired duplicate behavior; the proposed delayed deletion rule is not shown as configured.
- Confirm current versions and owners for transport rates, pickup instructions, packages, group documents, and channel/Extranet handling. Centurion equivalents are **not found** in supplied common/L0/L4 notes.
- This is one property's interview, not evidence that every hotel or every reservationist uses the same flow. (inference)

## Appendix (scripts)

Template section count: `8/8` numbered sections in `templates.md`; source speech window 16:00–18:36. Script used:

```python
from pathlib import Path
import re

source = Path("/home/orca/nava-research/davinci/2026-10-14-interview/extracted/interview-2026-10-14-handoff/templates.md")
text = source.read_text(encoding="utf-8")
found = [int(n) for n in re.findall(r"^##\s+(\d+)\.", text, flags=re.M)]
expected = set(range(1, 9))
present = expected.intersection(found)
print(f"{len(present)}/{len(expected)} numbered template sections; source speech window 16:00–18:36")
```

No corpus counts or production queries were run. All other numbers above are either source timestamps or spoken operational durations/dates, not computed rates.
