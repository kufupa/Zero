# Month-sample hypotheses for quote-first decisions

**Prepared:** 2026-10-30

**Scope:** A decision framework for a wider saved Centurion-mail review covering 2026-09-28 through 2026-10-23 inclusive. This note reviews sanitized prior research only. It does not scan or reprocess raw mail, inspect live systems, or assess old implementation paths. HMS tools are being rewritten from scratch; no new quote tool is assumed to exist.

## Recommendation

Keep **Quote first** as the owner-set workflow order. Do not use this sample to re-litigate human approval, unsent replies, or the separation between a quote and a booking. Use it to settle only three first-slice choices, ranked by impact on a new read-only quote path:

1. What decision-time mail context is required before Nava may call a quote ready?
2. Which observed staff actions should make the pane show a prepared quote versus a needs-you review?
3. Which independently evidenced price components belong in the first quote-preparation contract?

Rank is by product leverage and safety, not estimated frequency. The existing 19–23 October review is deliberately selected: 10 confirmation-anchored journeys and three request-first quote journeys cannot establish prevalence, join accuracy, or ROI. The three quote cases show materially different staff actions—no room held, management input before a room-only price, and a withdrawn quote—but are examples, not a representative behavior mix. ([decision](decision.md#L7-L13); [quote journeys](quote-journeys.md#L13-L19))

## Review method for the wider period

- Build the denominator from inbound human quote requests, not quote-like outbound documents or confirmation PDFs. Include unanswered, declined, withdrawn, and unresolved requests; do not treat missing saved replies as proof that staff did nothing.
- Freeze each case at the original decision point. Use only earlier mail and actually available attachments as input. Later replies, PDFs, and saved HMS observations are outcome evidence, not input. Preserve missing or unavailable attachments as **unknown**. Stored timestamp timezone semantics are unverified. ([decision](decision.md#L11-L13); [quote-journey method](quote-journeys.md#L5-L10))
- Record the first human staff action separately from the later outcome: quote/price, clarification, management or manual approval, decline/alternative, wait/no saved response, or withdrawal. Do not translate staff behavior directly into a product requirement; compare it with the owner’s desired behavior.
- For each case, record whether the selected message alone supports dates, rooms/count, occupancy, board, party/rate eligibility, and price; identify which earlier thread or available attachment changes the answer. Keep exact-party and rate evidence separate from sender/domain clues.
- Prefer a complete, enumerated request set for the period. If review capacity requires sampling, predeclare date and action strata, report counts and the selection rule, and limit conclusions to the reviewed strata. Do not create a new percentage pass bar from this exploratory sample.

## Ranked hypotheses

### 1. A bounded thread/context read is needed before a request can be marked quote-ready

**Hypothesis.** The selected request alone will sometimes omit decision-critical facts that staff use from earlier thread context or an available attachment. The first slice should therefore keep the selected email as its anchor, but gather only the additional context shown to change a quote decision; it should never fill gaps by inference.

**Current evidence.** The sampled journeys show multi-message and cross-thread relationships, a multi-stay request with unavailable guest details, and date disagreement across request and confirmation versions. The quote cases also include a claimed quotation attachment that is not verifiable at file level. This supports preserving context and uncertainty, but says nothing about how often quote preparation needs that context. ([booking journeys](booking-journeys.md#L20-L27); [quote journeys](quote-journeys.md#L13-L18); [case-product map](case-product-map.md#L17-L20))

**What to check.** For every sampled quote request, compare the fields and action supported by the selected message against those supported by prior same-thread messages and available attachments. Label the precise field/action that changes and whether the source was actually available at that decision point. Do not infer attachment contents from an email’s claim that one was attached.

**Decision change.** If independent cases repeatedly show an available prior message or attachment changing party, dates, occupancy/board, requested room count, or whether staff can price, include a bounded context-reading step in the first-slice contract and surface its source. If reviewed requests remain equally classifiable and priceable from the selected message, defer broad attachment parsing; keep unsupported facts visibly unresolved. One exceptional case should produce a safe exception path, not automatically a universal parser.

**Counterexamples to seek.** Earlier correspondence may be stale or refer to another guest; the same agency can have concurrent stays. A quote-looking attachment may be unavailable or may not be a quote. A later PDF or HMS snapshot cannot repair missing decision-time evidence. ([booking journeys](booking-journeys.md#L20-L27); [decision](decision.md#L11-L13))

### 2. The first staff action, not the eventual outcome, should set the pane’s readiness state

**Hypothesis.** A useful quote-first pane needs at least two honest states: **review prepared quote** when required inputs and price are evidenced, and **needs you** when staff first clarify, obtain manual/management approval, or decline. It should not make an incomplete request look priced merely because a later staff reply contains an amount.

**Current evidence.** In the three request-first examples, staff behavior differs: one says nothing is held pending a signed quotation, one seeks management input before quoting room-only, and one gives a multi-room price that is later withdrawn. The owner baseline nevertheless calls for read-only quote preparation on open, with missing or contradictory details surfaced, and a staff click may generate the PDF. Observed behavior is not automatically the desired behavior. ([quote journeys](quote-journeys.md#L13-L18); [PRODUCT.md](../../../../PRODUCT.md#L17-L27); [decision](decision.md#L28-L35))

**What to check.** For each decision point, classify the **first human staff action** using only facts already available then. Compare directly priced cases with clarification, management/manual-rate approval, decline/alternative, and no saved response. Note whether the apparent information gap is real (missing or conflicting source facts) or simply not recorded in the export. Keep later acceptance, withdrawal, or booking outcome in a separate column.

**Decision change.** If first replies commonly price requests once required fields are evidenced, retain read-only background preparation and make quote review the primary action for those cases. If the first action is repeatedly clarification or manual approval despite apparently complete requests, tighten the readiness gate and make the missing-fact/manual-review action primary for that class. Do not imitate slow replies, infer a booking from a quote, or let an outcome change the original input.

**Counterexamples to seek.** Staff may ask a question for policy or commercial reasons not visible in the mail; a complete-looking request may still need rate authorization. No saved reply does not prove that no reply was sent. A withdrawn quotation is not a reservation cancellation. ([quote journeys](quote-journeys.md#L15-L18); [case-product map](case-product-map.md#L17-L19))

### 3. The first quote slice should cover only price families that can be independently grounded

**Hypothesis.** The new quote-preparation contract should expose a selected company/agency rate where eligibility is evidenced, preserve BAR B&B and room-only distinctions, and keep dinner separate unless an authorized hotel-specific price is supported. The wider sample may change which of these cases is in the first supported slice; it must not teach rate selection from sender type or quote wording.

**Current evidence.** The owner’s baseline prioritizes company/agency contract rates and specifies BAR B&B with dinner as a hotel-specific add-on. The older aggregate studies are not a safe strategy answer: quote-like text includes confirmation letters, sender-to-rate rules were weak, and the human-quote bucket was heuristic rather than inbound demand or accuracy. Request examples include room-only negotiation and dinner requests, but their email amounts are not proof of an eligible or current HMS rate. ([PRODUCT.md](../../../../PRODUCT.md#L17-L27); [rate-word scan](../../2026-10-24-multihotel-shape-S5-rate-patterns.md#L14-L24); [outbound bucket](../../2026-10-26-r-corpus.md#L7-L19); [case-product map](case-product-map.md#L17-L19))

**What to check.** For each request with an actual saved staff price artifact, record the stated rate type, per-night price, board, room count and dinner separately. Mark a rate family “independently grounded” only when the correct property, party eligibility, stay dates, and authoritative rate evidence can be matched; otherwise mark it unknown. Do not treat an email amount, company name, travel-agent status, source-of-business label, or confirmation-letter rate text as a current rate answer.

**Decision change.** Put a price family in the first quote slice only when it recurs across independent requests and its eligibility and price can be verified without sender-only inference. If staff repeatedly use manual or authorized one-off rates that cannot be grounded automatically, make that an explicit staff-review path rather than guessing or dropping it into BAR. If evidence is absent, the safe result is an unresolved price—not a claim that the rewritten HMS tools can quote. This refines implementation scope; it does not override the owner’s rate policy.

**Counterexamples to seek.** A request mentioning a company or government rate may not qualify for that party’s contract. A requested dinner limit does not show dinner is included. A travel-agent request can have a different later HMS source label. Quote-like confirmation PDFs can inflate apparent BAR frequency. ([booking journeys](booking-journeys.md#L19-L24); [case-product map](case-product-map.md#L9-L19); [rate-word scan](../../2026-10-24-multihotel-shape-S5-rate-patterns.md#L14-L24))

## Boundaries and limitations

- Current owner rules remain controlling: Quote → Create → Amend → Cancel; Nava never sends; quote preparation is read-only; booking is a separate staff-approved action. A wider historical sample can refine the quote slice, not authorize a write or merge quote and booking. ([PRODUCT.md](../../../../PRODUCT.md#L17-L27); [pane details](../../../../docs/context/PRODUCT-DETAIL.md#L9-L21))
- Saved mail is not proof of delivery; the export lacks a complete attachment inventory; cross-thread links may be missed; selected prior cases are non-random. Later HMS records are not historical snapshots. Treat absent evidence as unknown, not negative. ([decision](decision.md#L7-L13); [booking journeys](booking-journeys.md#L5-L12))
- The owner-confirmed 85% quote-recall target and 100-row target belong to the scoped 2026-10-20 plan. The older proposed price bar is not a universal approved target. This month-sample framework sets neither a new score bar nor production readiness. ([owner decision D19](../../../../docs/context/DECISIONS-2026-10-20.md#L43-L45); [PRODUCT-DETAIL.md](../../../../docs/context/PRODUCT-DETAIL.md#L25-L43))
- The cited evidence is sanitized, dated research. No live HMS probe, deployment, flag change, or test of the from-scratch rewrite is part of this recommendation.
