# Common business rules

Read before any workflow via `skill_read`; [tool/proposal bindings](tools-and-proposal.md) apply throughout. Guest drafts: normal polite grammar; terse docs ≠ terse guest mail.

## Request + evidence

- X01 Evaluate selected current inbound in session context. Latest actionable instruction for same task controls; newer mail can supersede an older selection, not silently switch task. Earlier messages supply context; quoted or later staff outcomes never create booking authority. Separate requested action from observed completed state. Historical selection stops at input cutoff.
- X02 One thread may contain several guests, stays, documents, workflows. Keep task per guest/stay/document; fulfil independent supported tasks. One unclear item must not erase other items.
- X03 Source priority: latest staff edit for proposed field; explicit current request; relevant supplied document; earlier agreed thread context; fresh HMS saved state for unchanged fields. Conflicts affecting action → explain exact conflict, ask one targeted question. Never invent missing values.
- X04 Inspect supplied attachment when its contents matter. Filename, subject, payment instructions, pro-forma ≠ proof of payment. Document receipt ≠ paid folio. Confirmation PDF ≠ fresh native reservation state.
- X05 Match reservation identifier + property, then verify guest + stay. Without identifier, search relevant guest/dates/company context. Sender/time alone, quoted number, same surname, same party ≠ unique booking. Ambiguous candidates → request distinguishing detail.
- R6 Mail about existing confirmation → look up existing stay, never Create from notice. Automated HMS pre-stay self-mail can carry guest free text (20/107); surface actual text as note/Amend candidate, keep distinct current asks. No property-specific subject match.
- X06 Codes come from native property catalogue: code + meaning. Price/availability comes from native quote/read, not historical email examples. Explicit staff edits remain authoritative, subject to native tool response; disclose changed price or unavailable code.
- X07 Missing info → specific question; unsupported/out-of-scope task → staff review, not invented policy. `decline` means demonstrated inability/refusal; `skip` means no new action (e.g. duplicate or thanks). Never use either to conceal tool failure.
- X08 Draft factual claims only. Quote ≠ reserved room; prepared ≠ saved; supplied POP ≠ settled account; cancellation request ≠ cancelled booking. Final confirmation requires actual corresponding result.

## Save: owner rules

- X09 Real guest: unsaved staging permitted; call `hms_save` only through staff-Go path. Agent waits on custom-tool result. Staff may edit; backend re-login/re-stage edited proposal, Save, fresh readback. Never bypass waiting with native Save script.
- X10 Autonomous Labtest Save only: guest `Proof Labtest`, stay 2027+, CMS off. Not permission for real bookings. Historical backtest remains read-only.
- X11 Uncertain Save result: fresh HMS read first; compare affected reservation/business fields/documents/status. Never blind-retry. Confirmed desired state → report; confirmed not applied → resume supported preparation; ambiguous/partial state → staff review. Multi-item Save results tracked separately; never replay already-saved items.
- X12 Save/readback disagreement → state discrepancy, not success. Report actual saved identifiers and state; draft only supported claims. Never send mail automatically.
- R3 Create/Amend CMS Send defaults on (228/228 sampled confirmed creates later got a letter; sample conditioned on confirmation, not proof of tick rate). Prefill current requester email when usable; staff may edit tick, recipient, supported message ID. Missing/ambiguous recipient → staff resolves or unticks. Only HMS sends on approved Save when ticked. Labtest off; Nava drafts only.

## Proposal semantics

Backend contract owns exact JSON/tool schema. Preserve: workflow; guest/stay/document identity; requested fields in staff order; fresh existing state separate from patch; code + meaning; native price/availability; source message/attachment IDs; missing details; warning/reason; proposed reply. Staff-filled vs AI-filled provenance must survive edits.

Historical mode: pre-cutoff inputs + supplied fixtures only; no live HMS/catalogue/price or Save. Missing fixture stays missing. Source corpus outcomes are authoring evidence, never runtime facts for an earlier cutoff.

No whole-form key/count/body pinning. Check business fields staff intended; native form drift alone must not become refusal.
