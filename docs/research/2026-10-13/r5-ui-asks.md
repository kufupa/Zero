# R5 — UI/UX asks and status

## Answer

**[I] 16 deduplicated requirements: [I] 3 done (18.75%), [I] 11 partial (68.75%), [I] 2 not done (12.5%) in the inspected checkout.**
**The clearest misses: read-as/Needs-you taxonomy mismatch, excessive copy actions, and no Needs-you Undo/Finished path.**
**Contact and sync are near the top, but the contact block does not explain its PDF role; code snapshot is not main or live.**

## Method

- Read Claude user entries under `/home/orca/.claude/projects/*/*.jsonl` and Codex user entries under `/home/orca/.codex/sessions/**`. Window: **[M] 2026-10-09 through 2026-10-13 UTC inclusive**. Claude parsing accepted `type == "user"` with string/text content; Codex parsing accepted `response_item` user messages. Ignored assistant/tool-result events, stripped system-reminder blocks, skipped hook/system-reminder text, filtered the supplied research prompt, and deduplicated by message ID.
- Read-only scan sample: **[M] 39 Claude files / 830 distinct in-window user messages; [M] 269 Codex files / 134 in-window user messages.** Codex file scan used an **[M] one-day modification-time cushion** before the start date, then filtered messages by their UTC timestamps. The helper's UI-term + ask-cue filter returned **[M] 402 candidate messages / 1,673 candidate snippets**. It is intentionally noisy; I retained only source-checked UI/UX asks below. Email, phone, and card-number patterns are redacted; emitted snippets are capped at **[M] 200 characters**.
- Read the Bongi staff-call transcript, Davinci kickoff transcript, `docs/plans/2026-10-13-002-staff-ui-feedback.md`, relevant pane/UI plans, `docs/pilot/*`, and the local demo HTML. The Bongi call is dated **[M] 2026-10-09** by the feedback memo, but its transcript has only relative audio offsets—not UTC clock time. Davinci kickoff had no usable date/time and no distinct UI request surfaced.
- Searched local code/transcripts for `hermes` and `outlook-side-pane-demo`; found the local design source [2026-09-23-centurion-outlook-side-pane-demo.html](/home/ubuntu/projects/zero/.worktrees/qm-l5/docs/superpowers/specs/2026-09-23-centurion-outlook-side-pane-demo.html) and plan references. The plan points at a Hermes-hosted copy, but I did not fetch it.
- Static code audit only: `/home/ubuntu/projects/zero/.worktrees/qm-l5`, branch `feat/channel-mail-skip`, HEAD `3abcc4375`. This is not `main`; statuses below describe that checkout only. No UI render, test suite, deployment, project/production service, mailbox, database, or HMS action was run. A developer-provided, read-only Hindsight knowledge-page lookup returned no pages and was not used as evidence. No product-repo file was changed.
- Re-run transcript scan: `python3 /home/orca/nava-research/scripts/r5/scan_ui_asks.py`; optional `--start YYYY-MM-DD --end YYYY-MM-DD --limit N`. Main helper: [scan_ui_asks.py](/home/orca/nava-research/scripts/r5/scan_ui_asks.py). Claude file locators below are relative to `/home/orca/.claude/projects/-home-ubuntu-projects-zero--worktrees-centurion-dashboard-tools/`; Codex locators are relative to `/home/orca/.codex/`.

## Findings

### Counts and confidence

| Measure | Result | Confidence |
|---|---:|---|
| Older consolidated memo, timestamp **[M] 2026-10-12 23:50 UTC**, counted against main `a2816a753` | **[M] 29 asks**; **[M] 5 done ([I] 17%)**, **[M] 11 partial ([I] 38%)**, **[M] 11 not done ([I] 38%)**, **[M] 2 unknown ([I] 7%)** | High that the memo records these counts; low as current-code status because its baseline predates this checkout. Source: `docs/plans/2026-10-13-002-staff-ui-feedback.md:1,3`. |
| This pass: normalized code-audit groups | **[I] 16 groups**; **[I] 3 done (3/16; 18.75%)**, **[I] 11 partial (11/16; 68.75%)**, **[I] 2 not done (2/16; 12.5%)** | Medium: analyst grouping and static inspection; branch is not main and no rendered UI was checked. |

The **[M] 29** memo count and **[I] 16** groups are different units: the former counts asks in a prior synthesis; the latter deduplicates related asks for a current, static code comparison.

### Verbatim ask register

Owner transcript times are UTC. Staff-call offsets are elapsed audio time; quoted call text is noisy ASR and marked accordingly. Each quotation is a short exact excerpt (or masked excerpt) under **[M] 200 characters**.

| Ref | Date/time (UTC) | Source | Verbatim ask | Theme | Confidence |
|---|---|---|---|---|---|
| a | **[M] 2026-10-09 09:25:42Z** | Owner Claude user; `2c995390-3379-4251-8a36-ffee8baa8bfa.jsonl:5295` | “right now i'm seeing like two fuck-ass buttons on the right side” | Copy/buttons, design polish | High |
| b | **[M] 2026-10-09 09:33:18Z** | Owner Claude user; `2c995390-3379-4251-8a36-ffee8baa8bfa.jsonl:5437` | “So the demo is a good starting point design-wise, and then we need to make it a production application.” | Design-v1 parity | High |
| c | **[M] 2026-10-09 09:43:12Z** | Owner Claude user; `2087195a-dd7e-41f3-a230-7363785b4eb8.jsonl:11` | “Is there a way for me to check the side panel without having to get them to open and share their screen every single time?” | Self-serve preview | High |
| d | **[M] 2026-10-09 10:12:42Z** | Owner Claude user; `2087195a-dd7e-41f3-a230-7363785b4eb8.jsonl:480` | “We should be adding a side panel to the webmail application, right?” | Webmail/Outlook parity | High |
| e | **[M] 2026-10-09 15:17:46Z** | Owner Claude user; `5010619f-5020-416f-9bac-d4799e66573b.jsonl:356` | “we should put the name company email details at the very, very top. So that should be pre-filled at the very top.” | Contact block | High; owner repeats staff feedback |
| f | **[M] 2026-10-09 15:17:46Z** | Owner Claude user; same source as `e` | “...that only allows her to select one type of room and it wasn't clear what's going on”; “maybe we provide a total number of rooms or total occupancy count” | Room selection, occupancy totals | High; owner repeats staff feedback |
| g | **[M] 2026-10-09 15:17:46Z** | Owner Claude user; same source as `e` | “if anything takes over 30 seconds, then it's probably worth flagging”; “not show errors to non-technical users to scare them unless we're confident” | Wait status, plain-language errors | High |
| h | **[M] 2026-10-09 15:17:46Z** | Owner Claude user; same source as `e` | “she treats the side panel ... as like a to-do UI” | Needs-you/task view | High; owner paraphrases staff |
| i | **[M] 2026-10-09 15:17:46Z** | Owner Claude user; same source as `e` | “why does the find this booking HMS button exist after they've clicked it already” | Hide Find after result | High |
| j | **[M] 2026-10-09 15:17:46Z** | Owner Claude user; same source as `e` | “Also why can't Nava read the client virtual PDF? ... we should be able to read them from the side pane.” | PDF reading | High |
| k | **[M] 2026-10-09 15:17:46Z** | Owner Claude user; same source as `e` | “It's not really clear what it does, because if it's downloading the attachment locally to her laptop, then that functionality already exists in Outlook” | Attachment-action clarity | High |
| l | **[M] 2026-10-09 15:17:46Z** | Owner Claude user; same source as `e` | “She thought this would save the attachment into her HMS record.” | Attach to HMS vs local download | High; describes staff expectation |
| m | **[M] 2026-10-09; UTC time not recorded; audio +01:49** | Centurion staff call, Speaker 1; `bongi UI call transcript.md:77` | “I thought that you could do the same here where you could pick it and then would go to download, maybe you can see what you can do for us.” | Attachment/download action | Low; ASR is unclear |
| n | **[M] 2026-10-09; UTC time not recorded; audio +05:38** | Centurion staff call; `bongi UI call transcript.md:201` | “But why is it not picking a the person's name? The Booker.” | Booker/contact extraction | Medium; ASR |
| o | **[M] 2026-10-09; UTC time not recorded; audio +06:39** | Centurion staff call; `bongi UI call transcript.md:233` | “It's duplicating. Can you see that stay one and then stay 2 and then stay 31.” | Duplicate stays, clarity | Medium; ASR |
| p | **[M] 2026-10-09; UTC time not recorded; audio +07:46** | Centurion staff call; `bongi UI call transcript.md:269` | “Able to I can I manually instruct it? That's what I want to ask you.” | Manual correction | Low; ASR is unclear |
| q | **[M] 2026-10-09; UTC time not recorded; audio +08:56 / +09:27** | Centurion staff call; `bongi UI call transcript.md:305,313` | “it will be nice to be able to edit it”; “that's why we need it in an editor” | Editable/saved rates | Medium; ASR |
| r | **[M] 2026-10-09; UTC time not recorded; audio +09:41** | Centurion staff call; `bongi UI call transcript.md:317` | “in the comments I'll say authorised by [manager redacted]” | Discount approval trail | Medium; ASR; name masked |
| s | **[M] 2026-10-09; UTC time not recorded; audio +10:38 / +10:52 / +11:03** | Centurion staff call; `bongi UI call transcript.md:341,345,349` | “can you do it like this?”; “Can you put the company the name of the person?”; “And the contact details ... And then AI can just pick that up” | Quote-template parity, first-page contact | Medium for company/name; low for the +11:03 phrase (ASR) |
| t | **[M] 2026-10-09; UTC time not recorded; audio +11:37** | Centurion staff call; `bongi UI call transcript.md:373` | “maybe AI picks this up again, and then I can just like across where I say, take this out” | Edit/remove quote line | Low; ASR is unclear |
| u | **[M] 2026-10-09; UTC time not recorded; audio +14:55** | Centurion staff call; `bongi UI call transcript.md:493` | “I want to see how it's oh download to XL but now it's not going to be able to I won't be able to test it here.” | Excel/download test | Low; ASR is unclear |
| v | **[M] 2026-10-11 23:33:41Z** | Owner Claude user; `42d2a9c1-c0a1-4b1f-9deb-137025e8e367.jsonl:6480` | “But maybe instead of moving them then, is there a smart way that we could use the folder or tag them somehow?” | Workflow folders/tags | High |
| w | **[M] 2026-10-12 10:22:09Z** | Owner Claude user; `da411a9d-374b-4c40-a6ac-78ebd27fa776.jsonl:15` | “these copy buttons are kind of semi useless” | Copy-button reduction | High |
| x | **[M] 2026-10-12 10:22:09Z** | Owner Claude user; same source as `w` | “Firstly, it's not clear what the save attachment does.” | Attachment-action clarity | High |
| y | **[M] 2026-10-12 10:22:09Z** | Owner Claude user; same source as `w` | “whenever we hit dismiss there should probably be an undo button as well” | Needs-you Undo | High |
| z | **[M] 2026-10-12 10:22:09Z** | Owner Claude user; same source as `w` | “I don't like the fact that we've written room one room two it's not super clear what's going on there” | Room labels/clarity | High |
| aa | **[M] 2026-10-12 10:22:09Z** | Owner Claude user; same source as `w` | “if I edit this does it edit it inside of the HMS too?” | Edit destination/HMS writes | High |
| ab | **[M] 2026-10-12 10:22:09Z** | Owner Claude user; same source as `w` | “So now we're using this as quote request booking and other options, but it needs you ... amendment ... voucher or pop ... then quote.” | Read-as/Needs-you mismatch | Medium; spoken taxonomy is imprecise |
| ac | **[M] 2026-10-13 18:13:25Z** | Owner Claude user; `da411a9d-374b-4c40-a6ac-78ebd27fa776.jsonl:8665` | “They really like the design of the design one, the V1.”; “it's just not super clear what they need to do every single time.” | Design-v1 parity, clarity | High |
| ad | **[M] 2026-10-13 18:13:25Z** | Owner Claude user; same source as `ac` | “contact is at the top right now doesn't really make sense unless we make it super clear” | Contact block purpose | High |
| ae | **[M] 2026-10-13 18:13:25Z** | Owner Claude user; same source as `ac` | “why is there a copy? I don't think we really need to have a copy there; furthermore why is it editable? does it edit the HMS?” | Copy, editability, HMS boundary | High |
| af | **[M] 2026-10-13 18:13:25Z** | Owner Claude user; same source as `ac` | “the synced and what mail we're actually hooking up to needs to be at the top”; “what it got synced as or what it got read as” | Mailbox/sync and read-as position | High |
| ag | **[M] 2026-10-13 18:13:25Z** | Owner Claude user; same source as `ac` | “why does the Needs You have so many different classifications like amendment cancellation but then the read as only has quote request and booking” | Classification mismatch | High |
| ah | **[M] 2026-10-13 18:13:25Z** | Owner Claude user; same source as `ac` | “change the Nava admin UI so that ... you have nice folders that I can click on” | Clickable workflow folders | High |
| ai | **[M] 2026-10-13 18:13:25Z** | Owner Claude user; same source as `ac` | “swap out the current ... AI triage in the webmail entirely with a new workflow driven one” | Workflow-led triage | High |
| aj | **[M] 2026-10-12 23:28:30Z** | Owner Codex user; `sessions/2026/10/12/rollout-2026-10-12T23-28-03-01a13271-d44d-7791-8228-c997239fc143.jsonl:10` | “Keep the existing visual design (cards, colours); change ORDER, COPY and STATE only. Hide any control that does nothing on this build” | Preserve design, remove dead controls | High as owner task instruction |
| ak | **[M] 2026-10-13 02:04:13Z** | Owner Codex user; `sessions/2026/10/13/rollout-2026-10-13T02-03-46-01a13300-64e5-7911-8720-4f32eb32df1f.jsonl:10` | “ONE Copy confirmation button”; “Hide the ‘Find’ button once a result is showing” | One-copy result, hide Find | High as owner task instruction |

### Deduplicated requirements and current code status

Status is an **[I] analyst judgement** against the `qm-l5` source tree, not a claim about deployed behavior. Confidence reflects static code evidence and the branch caveat.

| Ref | Deduplicated requirement | Source refs | Current status and code evidence | Confidence |
|---|---|---|---|---|
| A | Same pane usable from Outlook and webmail; owner can inspect without staff screen-sharing. | c, d, `docs/plans/2026-10-05-002-feat-reservationist-outlook-quoting-ui-plan.md:7` | **[I] Done in code.** Authenticated `/nava-preview` lists recent threads, labels itself read-only, and embeds the pane (`apps/mail/app/(routes)/nava-preview/page.tsx:10-14,50-53,87-100`). Outlook route renders `NavaPane` (`apps/mail/app/(routes)/outlook-pane/page.tsx:4-6`); webmail `WebPanePanel` renders the same component (`apps/mail/components/nava-pane/web-pane-panel.tsx:65-70`). Route access/render not tested. | Medium |
| B | Keep the preferred V1 visual language; reduce density; retain a visible right scrollbar and one clear action per step. | a, b, ac, aj; `docs/plans/2026-10-09-001-feat-nava-pane-weekend-v4-plan.md:180`; `docs/plans/2026-10-13-002-staff-ui-feedback.md:25`; local HTML | **[I] Partial.** Shared styling, constrained pane and scroll body exist (`apps/mail/components/nava-pane/nava-pane.tsx:1720,1722,1908`); no screenshot comparison was run. Several blocks precede the quote steps, and multiple copy controls remain. | Medium |
| C | Put the actual mailbox and sync state in the global header; show which email is selected before the quote workflow. | e, af; `docs/plans/2026-10-13-002-staff-ui-feedback.md:16` | **[I] Partial.** Top header contains the connection dot and `OutlookSyncProgress` (`nava-pane.tsx:1725,1744,1750`); when sync is ineligible it falls back to “Centurion”, not the active mailbox. The selected-email strip is below the contact block (`nava-pane.tsx:1916,1926`). | High for source location; Medium for satisfaction |
| D | One consistent, visible “read as” vocabulary aligned with Needs-you item kinds; keep workflow type distinct from task status. | ab, ag | **[I] Not done.** `WorkflowBadge` offers Quote request / Booking / Other, with Amendment/Cancellation as separate chips (`workflow-badge.tsx:7,26,52,59,84`); Needs-you kinds also include Amendment, Cancellation and Voucher/POP (`needs-you.tsx:35`), with a separate state chip set (`needs-you.tsx:21`). The mismatch owner called out remains. | High |
| E | Prefill the quote recipient/contact near the top and say plainly that these values appear in the quote PDF; distinguish that from the contract/billing company. | e, n, s, ad; `docs/plans/2026-10-13-002-staff-ui-feedback.md:6,16` | **[I] Partial.** `ContactBlock` is first selected-message context and is populated with name/email/phone/company (`contact-block.tsx:23,62,69`), but its title is only “Guest & contact” (`:64`). `withContactLines` fills blank Attention/email/telephone from name/email/phone (`document-contact.ts:6,18,19,20`); the PDF prints Attention, Company, email and telephone (`proposal-pdf.ts:100`). PDF Company comes from the separate quote header/party field (`quote-workflow-panel.tsx:451,454`), not `contact.company`. | High |
| F | Make every editable field’s save destination explicit; edits must not silently write to HMS. | p, q, aa, ae; `docs/plans/2026-10-13-002-staff-ui-feedback.md:17` | **[I] Partial.** Contact editor says corrections save to this request and HMS is not changed (`contact-block.tsx:96,105,120`); `recordContact` logs `contact.<field>` against the stored work item (`use-work-item.ts:430,440`). However `quoteNotesBlock` carries contact name/company into notes used in the later workflow (`quote-workflow-panel.tsx:878,884,885,886`); the explicit booking action is separate (`booking-card.tsx:612`). Label the two-stage effect. | High for code path; Medium for user comprehension |
| G | Remove per-field/repeated copy actions; after an HMS match offer one Copy confirmation and Open HMS only if real. | a, w, ae, ak; `docs/plans/2026-10-13-002-staff-ui-feedback.md:23` | **[I] Not done.** Contact has Copy for each field (`contact-block.tsx:77,84`); `HmsLinkActions` can show Copy link, Copy confirmation, Copy for HMS and Open HMS (`hms-link-actions.tsx:142,147,151,155`). Booking cards also expose per-field Copy rows (`booking-card.tsx:676`). | High |
| H | Hide Find after a result has been returned; allow a retry only when a retry is actually available. | i, ak; `docs/plans/2026-10-13-002-staff-ui-feedback.md:13,23` | **[I] Done in the voucher-find path.** Find renders only when `searchIdle` is true (`voucher-find-card.tsx:169,223`); a completed result is rendered separately (`:235`). Not browser-tested. | High for code path |
| I | Needs-you is a short typed to-do list; Dismiss has Undo and moves to Finished; define cutoff handling. | h, y; `docs/plans/2026-10-13-002-staff-ui-feedback.md:22,29`; Codex `sessions/2026/10/12/rollout-2026-10-12T01-19-22-01a12db1-62ef-70d2-9e72-c60ff34f00b1.jsonl:10` | **[I] Partial.** List rows show kind, status, sender/subject/time and Dismiss (`needs-you.tsx:150,164,167,173,197,202`), but no Undo/Finished path is present in this screen. An unavailable state still says “not available in this version yet” (`:263`). | High |
| J | Replace the old triage sidebar with clickable workflow folders; do not keep obsolete folders as primary navigation. | v, ah, ai | **[I] Partial.** The sidebar injects a “Folders” section from live categories; the allowlist is the workflow slugs plus `urgent` (`apps/mail/config/navigation.ts:65-94,97-115`; `apps/mail/components/ui/app-sidebar.tsx:62-73`). Workflow slugs include Bookings, Groups & Events and Exceptions & Recovery (`apps/mail/lib/mail/hotel-folder-presentation.ts:22-34`). `urgent` is still admitted, sorted first and rendered as a clickable folder item (`apps/mail/config/navigation.ts:58-60,70-94`; `apps/mail/lib/mail/hotel-folder-presentation.ts:44`). Legacy `new-bookings` and `ops` are excluded from the live-nav allowlist; `groups-events` is reused as a workflow slug. Live mailbox categories/sidebar were not queried. | Medium |
| K | Use room-type rows with counts/occupancy, mixed types, room and guest totals, and no confusing “Room 1/2” label. | f, o, z; `docs/plans/2026-10-13-002-staff-ui-feedback.md:7,8,18` | **[I] Partial.** Each Stay has room rows, a total, and “Add room type” (`requirement-card.tsx:122,126,261,276,290,200`; `quote-workflow-panel.tsx:1387`). Visible row heading is the room label, not “Room N”; row index is metadata (`requirement-card.tsx:228,261`). Mixed-type selection is represented, but the duplicate-stay complaint was not exercised against sample emails. | High for layout; Medium for duplicate behavior |
| L | Support manual/one-off and saved rates; capture who authorized discounted rates; do not hide required rate choices. | p, q; `docs/plans/2026-10-13-002-staff-ui-feedback.md:20` | **[I] Partial.** Override rate, rate code, saved-rate controls and required “Authorised by” are present (`rate-controls.tsx:883,893,905`; `quote-workflow-panel.tsx:1330`). Whether rate search can run before room selection and whether every staff rate choice is exposed were not live-validated. | Medium |
| M | Read incoming PDFs where supported, and make clear whether an attachment is downloaded locally or attached to an HMS booking. | j, k, l, m, x; `docs/plans/2026-10-13-002-staff-ui-feedback.md:9,30` | **[I] Partial.** The current voucher action downloads the file locally (`voucher-find-card.tsx:185,189`); copy says “Save attachment” then “Saved. Upload it in HMS Documents.” (`voucher-find.ts:69,71`). It does not attach to an HMS booking. General incoming-PDF coverage was not tested. | High for save path; Medium for PDF coverage |
| N | Run HMS reads in the background; show useful queued/running/done/failure status; flag long waits in plain language and never expose raw technical errors. | g; `docs/plans/2026-10-13-002-staff-ui-feedback.md:21,29` | **[I] Partial.** A pending chip and completion/failure banner exist (`hms-job-notices.tsx:477,486,491,560`), with safe failure mapping (`:106,123`). Staff-quote failure may display `view.result.message` directly (`:199,203`); no **[M] 30-second** nudge was found. Done notices auto-dismiss after **[M] 20 seconds** (`:502,504`). | High for code; Medium for UX outcome |
| O | Produce the quote PDF/Excel, allow reply editing, then save/create an unsent reply—not send automatically. | u; `docs/plans/2026-10-13-002-staff-ui-feedback.md:23`; `docs/plans/2026-10-05-002-feat-reservationist-outlook-quoting-ui-plan.md:7` | **[I] Done in code.** Quote review exposes Prepare PDF, Download Excel and an editable reply (`document-review.tsx:71,91,98,104`); UI states the Outlook draft is not sent (`:109`). Actual Outlook/webmail draft success was not tested. | Medium |
| P | Make the task path obvious, with one primary action per step and no dead “Coming soon” controls. | b, ac, aj; `docs/plans/2026-10-13-002-staff-ui-feedback.md:16,24,29` | **[I] Partial.** Workflow sections are numbered Stay → Company/agency → Rates → Quote (`quote-workflow-panel.tsx:1367,1399,1414,1701`), but contact/email/translation/follow-up/voucher content precedes them (`nava-pane.tsx:1916,1926,1928,1938,1945,1978`). No literal “Coming soon” string was found in the quote components, but the Needs-you unavailable placeholder remains (`needs-you.tsx:263`). | Medium |

### Specific interpretation

- **Contact block:** staff asked for the booker/company/contact details on the first quote page; owner later clarified that the card must say what will be written in the quote PDF. Code maps blank contact `name/email/phone` to PDF Attention/email/telephone. The PDF Company field is from the separate Company/agency quote header. `ContactBlock.company` is also included in later HMS notes, but typing a correction logs it to this request; only the explicit booking action writes the booking. Current comments are potentially contradictory: `quote-workflow-panel.tsx:465` says nothing fills quote contact fields from email, while `document-contact.ts:18,19,20` fills blank fields from email contact. Make this distinction explicit in the UI.
- **Copy:** the request is not “remove every useful copy operation.” Owner objects to copy controls in the contact block and repeated buttons; the later requirement is one Copy confirmation plus Open HMS only when supported. Current implementation offers more than that.
- **Sync/mailbox:** the global status belongs in the header, separate from the contact card. The header has a connection/sync control; the selected-email strip is after ContactBlock, and read-as is later still inside QuoteWorkflowPanel.
- **Read-as vs Needs-you:** these are different dimensions in code: workflow intent vs item kind/status. The owner’s complaint is valid at the UI layer; use one shared intent vocabulary (quote, booking, amendment, cancellation, voucher/POP, other) and keep “Needs you / Queued / In HMS / Review” as separate state.
- **Nava-admin folders:** the current sidebar creates clickable rows from live category data. `bookings`, `groups-events`, and `exceptions-recovery` are workflow folders; legacy `new-bookings` and `ops` are excluded, while `urgent` remains a clickable first row even though taxonomy calls it an overlay. No live sidebar data was read, so the categories actually visible to staff are unverified.

## Examples

- “right now i'm seeing like two fuck-ass buttons on the right side” — owner, Claude user message `4850252f-aa42-41d0-9d65-fb75017be617`.
- “why does the Needs You have so many different classifications like amendment cancellation but then the read as only has quote request and booking” — owner, Claude user message `19288a32-8ada-4025-851c-478d9060f3ee`.
- “But why is it not picking a the person's name? The Booker.” — staff-call ASR, `bongi UI call transcript.md`, audio +05:38, line 201.
- “Can you put the company the name of the person?” — staff-call ASR, `bongi UI call transcript.md`, audio +10:52, line 345.

## Implications for the product

- Put mailbox identity + sync state in the global header; then show the selected email and a single read-as banner before workflow content. Use the same intent vocabulary in the pane and task list, with workflow kind separate from progress state.
- Rename the card to **Quote contact — appears in the PDF**. Show that name/email/phone fill Attention/contact lines; make Company/agency on the PDF visibly separate from `contact.company`. Keep **Correct** and state “saves to this request; does not write to HMS.” Explain that those values may be included in HMS notes only when staff explicitly books.
- Remove default per-field Copy buttons. On a matched HMS record show the record facts, one **Copy confirmation**, and **Open HMS** only when the target is supported. Hide Find after a result; show retry only for a failed/eligible search.
- Keep one Stay card per date range, room-type rows with counts/occupancy, totals, and readable dates; avoid “Room N” labels. Preserve manual/saved-rate controls and a required “Authorised by” field.
- Make attachment action truthful: **Download to this computer** if that is all the code does; a separate, explicitly approved **Attach to HMS booking** action is needed to meet staff expectation. Do not imply a local download changed HMS.
- Make background job progress persistent and plain-language; add the requested **[M] 30-second** “still working” indication and sanitize every failure path. Reconcile Needs-you Dismiss with Undo and a Finished view.
- Reuse the V1 look across Outlook and webmail; keep the visible right scrollbar and reduce competing blocks before the task flow. Use workflow folders in nava-admin and treat urgency as a filter/badge unless staff confirms it must remain a folder.

### Proposed pane information architecture

```text
┌ Nava | active mailbox · sync status/progress | Needs you (count)                  [A, C, I]
├ Selected email: sender · subject · received time · sync state                      [C]
├ Nava reads this as: Quote | Booking | Amendment | Cancellation | Voucher/POP | Other [D]
│  Work state: Needs you | Queued | In HMS | Review                                [D, I]
├ Quote contact — appears in PDF: Attention/name · email · phone · [Correct]          [E, F]
│  Company/agency on quote: matched or typed separately                              [E, F]
├ Stay by date range                                                                   [K, L]
│  Room type · rooms · adults/children · meal plan; total rooms + guests
├ Company/agency · rates                                                               [L]
│  Search status · HMS rates · one-off/saved rate · Authorised by
├ HMS result / confirmation                                                           [G, H, N]
│  Plain status + evidence · [Copy confirmation] · [Open HMS if supported]
├ Quote review                                                                         [O, P]
│  PDF preview · Download Excel · editable reply · Save reply / Create unsent draft
└ Needs-you screen (opened from header)                                                [I, J]
   Short workflow rows · Dismiss ↶ Undo · Finished

nava-admin sidebar: Bookings | Groups & Events | Manage Stay | Confirm & Reconcile |
                  Money & Billing | Documents & Delivery | Exceptions & Recovery |
                  Guest Experience | Internal & Partner | Automated Channel | Unknown Review [J]
                  Urgent = separate filter/badge, not a competing workflow folder
```

## Open questions

- Should the shared intent set include `Other` as a selectable correction on every email, and is “Voucher/POP” a workflow class or only an attachment/booking-search state?
- Is `contact.company` the quote recipient’s company, the PDF Company field, or an HMS note? Who owns the canonical Company/agency value when these differ?
- Does staff expect attachment download only, upload to HMS Documents, or attach to a specific booking? The last two are HMS writes and need an explicit product/approval boundary.
- Which Copy action is essential for staff: confirmation only, or also a formatted “Copy for HMS” block? Should Open HMS remain hidden until its target is verified?
- Should `urgent` remain a separate urgency overlay, or be removed from the left-folder list entirely? Which live workflow folders should be visible for this mailbox?
- What are the exact cutoff date/time/timezone rules for Needs-you completion? What should staff see after Dismiss: immediate Undo, a Finished folder, or both?
- Can the owner confirm the ASR-dependent staff asks (especially +01:49, +07:46, +11:03 and +14:55) and the intended quote template?
- The supplied code path is a non-main worktree. If “current main” is authoritative, which `main` checkout/commit should replace this status baseline? Live UI/deployment status remains unverified by design.
