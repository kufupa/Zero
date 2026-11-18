# Common rules

Use the current inbound request and its relevant earlier context. Split independent tasks by guest, stay and document; keep the requested values attached to the right task. An existing-confirmation or pre-stay notice concerns an existing stay, not a new booking. Surface guest text as an amend/note request (20/107 pre-stay self-mails contained guest text).

**Prefill for staff:** publish `propose` for an identifiable supported task, including the information already known and editable defaults or empty fields for staff to finish. Missing native results, an unread attachment, or an editable native choice alone does not make the whole proposal `staff_review`. Put the specific gap in `missing` or `warnings`; never invent a price, confirmation, native code, payment or result. Use `needs_info` when a material guest detail is genuinely needed to identify or understand the request; use `staff_review` for an unsupported task or a conflict staff cannot resolve in the editor. Preserve other supported tasks.

Use explicit request and prior agreed context before editable defaults. An attachment's filename is a hint, not its contents; an unread attachment is not evidence that no attachment exists. A voucher or pro-forma is not proof of payment. Search an existing stay using the available confirmation, surname, dates and property; show relevant candidates, but do not assume the pane can bind a selected stay. Never select a different guest or stay to fill a gap.

Property, prices, availability, rate/code meanings and current reservation state come from the session or HMS, not historical examples. CMS Send defaults on for Create; Amend preserves the existing CMS setting unless changed. Prefill a usable requester email when requested and allow staff to change it. In 217/222 sampled confirmed creates the confirmation went to the requester; this is not a measured checkbox rate. Labtest CMS is off.

Prepare is unsaved. Real guest Save happens only when staff click Go. After an uncertain Save, re-read HMS before any retry. A requested, prepared or quoted action is not completed; only claim a booking, cancellation, filing or payment when the corresponding result establishes it. Nava creates drafts, never sends them.

Load shared references via `skill_read` with `path:"../references/common.md"` or `"../references/tools-and-proposal.md"`; local references use `"references/..."`. Use the registered tools and their schemas.
