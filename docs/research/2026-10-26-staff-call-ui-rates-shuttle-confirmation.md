# Staff call evidence: rates, shuttle, booking confirmation

**Snapshot:** 2026-10-26. Transcript-derived requirements evidence only. No code, HMS records, flags, provider emails, or deployments changed.

## TL;DR

- **Shuttle:** Staff describes a staged workflow: create accommodation booking with a shuttle Add-On; email transport desk; after provider confirmation, send confirmation/charge details to guest; remove the billable Add-On to avoid duplicate posting; retain transfer/pickup details in guest/reception notes. Exact billing/accounting mechanics remain unclear.
- **Rates:** Staff asks whether a “closer Netball rate” is available. ASR may be wrong. Speaker 2 says it was expected to be live but was not; later staff describes rate-dependent controls appearing greyed out. Exact rate, property, dates, and cause are unknown.
- **Pane clarity:** Staff is unsure what `Create booking` does, where `Copy for HMS notes` text goes, whether a shuttle amount can be entered, and how to get/inspect the PMS confirmation. Speaker 2 repeatedly cannot see the staff screen, so transcript alone does not identify the exact controls or defects.
- **Confirmation:** Staff wants PMS confirmation routed to her own staff-controlled mailbox first, then manually reviewed and forwarded to the guest. Speaker 2 says the current path would go directly to the client and promises a staff-mailbox route; this is a request/promise in conversation, not implementation proof.
- **Evidence limit:** The source received here is an AI-generated text transcript. It contains no screenshots/images, original audio, recipient address, or verifiable HMS event trail. Do not treat garbled wording as settled policy.

## 1. Reported shuttle workflow

| Step | What staff describes | Evidence / confidence |
|---|---|---|
| 1. Guest request | Guest asks for a shuttle and wants its cost included with accommodation so they can pay together. | 03:17–03:48; transcript wording is garbled, but intent is repeated. |
| 2. Accommodation booking | Staff creates the accommodation booking with a shuttle Add-On in Infor. The provisional booking/confirmation may initially show the shuttle charge. | 02:07–02:34 and 04:12–04:21; speaker 2 repeats this understanding and staff does not clearly correct it. |
| 3. Provider request | Staff emails the transport desk/provider to request the service, without waiting for provider confirmation before sending the request. | 03:21–04:01. Exact recipient, template, passenger/vehicle fields, and booking identifier are absent. |
| 4. Provider response | Transport desk returns a confirmation and/or invoice; staff sends the confirmation and charge information to the guest. | 03:48–04:21. The exact document and billing sequence are unclear. |
| 5. Avoid duplicate posting | Staff removes the shuttle Add-On from Infor after confirmation, describing duplicate charging/posting as the reason. | 02:07–02:34; 04:01–04:21. Exact accounting mechanism is not established. |
| 6. Preserve operations note | Staff adds transfer details to the booking’s guest details/reception area after removing the Add-On; reception can see the transfer and pickup information. | Screen-share narration at 07:26–08:01; exact field name and saved record are not independently verified. |

**Payer caveat:** The ASR around 04:36–05:33 suggests the guest pays the hotel and the hotel pays transport, but staff says they do not know the accounting mechanics. Treat payer, invoice issuer, and whether a second HMS posting occurs as **unresolved**. Do not encode “provider always charges guest directly” or “shuttle is never hotel-billed.” This new staff account supplements—but does not fully settle—the prior [Add-On/shuttle scope evidence](2026-10-26-addons-shuttle-scope-evidence.md), which found Centurion policy unknown.

**Product distinction:** Keep these separate in future design: (1) quoted shuttle price, (2) billable HMS Add-On, (3) provider request/confirmation, and (4) non-billable reception/guest note. Deleting a charge row must not erase the operational reminder. The exact HMS note field and retention behavior need read-only confirmation.

## 2. UI questions and confusion

| Staff question / observation | What it signals | What transcript cannot tell us |
|---|---|---|
| “Can I put in an amount here? And then will it show up?” (01:47) | Amount entry and its destination are unclear; staff expects a shuttle value to appear in the booking/quote. | Which control was on screen, whether amount is per trip/person, and whether it should be a quote price or HMS charge. |
| “Copy for HMS notes” and whether to put request details there (10:26–11:11) | Clipboard/paste helper is easy to confuse with a saved HMS write. | Whether text is copied, automatically saved, or pasted into the right Infor field. |
| Staff asks what `Create booking` does and whether confirmation comes from Infor (09:24–09:54; 11:26–11:55). | The boundary between preparing data, creating the HMS record, and sending/receiving a confirmation is not obvious. | The exact live button state or behavior; speaker 2 says they cannot see the screen. |
| Staff wants to revisit/check the booking and confirmation herself (12:11–12:29). | Post-create receipt/status and a route back to the created booking matter. | Whether current UI provides a reliable HMS link or stored confirmation. |
| “I’ll try and make that clickable” (14:16) | Some side-pane text/control looked non-interactive to staff. | Target element and intended action are unclear. |

**No screenshots were included in the supplied transcript.** Speaker 2 says more than once they cannot see the screen. Use the original images/audio or a controlled screen-share before filing a specific visual defect. Do not label `Copy for HMS notes` as broken based only on this text.

## 3. Missing-rate signal

- At 00:16, staff asks whether a phrase transcribed as “closer Netball rate” is usable/live. The exact wording and rate class are uncertain; do not turn “Netball” into a product requirement without checking audio/source.
- At 00:25, speaker 2 says it looked as though the rate should be live, but was not. At 10:14, staff describes a greyed-out area and says rates had not been picked up.
- This is evidence of **staff-visible missing/unclear rate readiness**, not proof that a particular rate is absent from HMS or that a backend lookup failed.
- Useful future acceptance check: for a named property, rate request, dates, party, and meal plan, show whether rates are loading, returned, unavailable, or awaiting staff selection; explain why the next action is disabled. Never imply a rate is live when it is not.

## 4. Confirmation recipient requirement

- Staff’s current Infor workaround, as described at 12:11–12:29: put her own email in the confirmation recipient field, inspect the generated confirmation, then forward it to the guest herself.
- Staff explicitly wants to receive the PMS confirmation first. Speaker 2 says the current flow would send straight to the client, promises routing to the staff inbox, and summarizes “send confirmation to [staff] … then you … send it out” (12:38–13:28).
- **Not proof of implementation.** No code or live HMS behavior was inspected in this transcript analysis.
- Design implication to evaluate before coding: show and verify a staff-controlled recipient before create; do not send the PMS confirmation directly to the guest by default; leave guest forwarding to staff; provide a clear created-booking/confirmation receipt so staff can return and check it. Recipient should be configurable from approved mailbox identity, not hard-coded to a person’s name. Nava itself must not independently send email.

## 5. Additional signal and transcription uncertainty

- At 14:20–14:49, staff raises what ASR renders as “technique sweets,” says these emails are frequent, and speaker 2 identifies a separate HMS/workflow but says it is not in current hotel scope. Phrase is too garbled to classify; check audio before creating a new ask or estimating ROI.
- Speaker 2 invites voice notes for future feedback/invoice notes (14:06); no committed product requirement was agreed.
- Transcript has likely ASR substitutions, missing turns, and inconsistent terminology. Use timestamps as locators, not as a verbatim policy oracle.

## 6. Follow-up evidence before implementation

1. Recover original audio/screenshots and confirm the exact rate name, pane control labels, selected property, and disabled-state cause.
2. Ask staff/finance to confirm who invoices the guest, who pays the transport provider, what triggers Add-On removal, and which HMS entry must remain visible to reception.
3. Verify whether the guest/reception detail field described is distinct from a billable Add-On and whether Nava’s current create path can persist/read it back.
4. Trace the create-confirmation recipient behavior in code and on Labtest. Prove that the staff mailbox receives the document and guest address does not, before making any production claim.
5. Keep Add-On writer, shuttle fulfillment, quote-rate readiness, and confirmation routing as separate work items. This evidence authorizes no implementation, provider email, HMS write, flag change, or deployment.

## Provenance

- Source: user-pasted, AI-generated transcript titled `00:49 Faith UI, missing rates, shuttle, confirmation monday_original.txt`.
- Private full-text copy: `/home/orca/nava-research/2026-10-26-staff-call-ui-rates-shuttle-confirmation.txt` (outside Git per `docs/research/README.md`).
- Relevant transcript timecodes: shuttle 01:31–08:01; rates 00:16–00:44 and 10:14; pane/confirmation 09:24–13:28; additional workflow mention 14:20–14:49.
- This is one staff account. It is not a property-wide policy, live-system proof, or owner approval for product behavior.
