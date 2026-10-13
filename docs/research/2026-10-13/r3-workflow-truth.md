## Answer

**About 36.5% [I] of in-scope inbound mail needs reservationist action — about 38.1 messages/day [I] (95% CI: 32.9–43.3/day [I]); the other 63.5% [I] is no-action/closure/system traffic.**  
**Agent vouchers are usually booking documents, not POP: 24/35 [M] sample vouchers also requested a booking, and 0/35 [M] contained payment-proof evidence.**  
**Current extraction `kind` is not a needs-action label: only 11.8% [I] of manual new-booking volume was `booking`; 79.3% [I] had no successful extraction.**  
**No same-thread staff Confirmation Letter PDF was found for the 35 [M] sampled agent vouchers, so actual HMS keying is not proven by this snapshot. Confidence: moderate for total mix; lower for small/ambiguous classes.**

## Method

- Read only the local `2026-10-13` snapshot and current code at `/home/ubuntu/projects/zero/.worktrees/qm-l5`; no network, database, or HMS calls. No product-repo files were changed.
- Loaded inbound messages, attachments, extraction rows, staff-sent PDF text, HMS read logs, and staff-quote runs. “Current extraction” is the latest successful row by `created_at` then row ID; no success is `(none)`.
- Frame: inbound messages from `2026-07-30T18:30:59Z` through `2026-10-13T17:54:13Z` [M]. Internal means sender host `legacyhotels.co.za`; all other senders are external. Excluded the supplied channel/system hosts and their subdomains (Synxis, Expedia Partner Central, Webbeds, Hotelbeds, Booking.com, Get-e, Hotels.com, Agoda, Trip.com, Traveloka, Airbnb, ReviewPro, TrustYou, TripAdvisor, Revinate, Medallia). Matching is by exact host root/subdomain, not substring; Travelit, TBO, Nexus, Tiket.com, Profitroom, RateTiger, and other unlisted hosts remain eligible for manual labeling.
- Population: `7,827` [M] non-channel inbound messages (`5,206` external + `2,621` internal [M]); `104.36` messages/day [M] using the `75`-day [M] snapshot window. The deterministic sample is `400` [M], seed `20261013` [M], stratified by internal/external × latest successful extraction kind across `15` [M] nonempty cells. Each cell received at least `10` [M] labels, then remaining slots were allocated proportionally. See the ID-only [sample manifest](/home/orca/nava-research/scripts/r3/sample-manifest.json).
- I manually labeled each target message `needs_action`, primary action, and one-line evidence, using its subject/body, attachment names/types and staff-PDF semantic tags, prior/next thread messages, and later staff replies/PDFs. Resolved acknowledgments are labeled `no_action` even when an earlier message in the thread required work. Binary flags record recognized agent/TMC notice, booking request, actual payment-proof evidence, and agent voucher; flags are not mutually exclusive. One analyst labeled the sample; there was no second-rater adjudication.
- Population shares use stratified weights `N_h/n_h`; 95% intervals are approximate normal intervals with finite-population correction. Daily estimates are share × population/day. Intervals cover sampling error only, not labeler uncertainty. Extraction instability is a full-frame comparison of earliest/latest successful versions, not a sample estimate.
- Re-runnable helper: [r3_research.py](/home/orca/nava-research/scripts/r3/r3_research.py); manual labels: [labels.tsv](/home/orca/nava-research/scripts/r3/labels.tsv). To reproduce the snapshot inventory, estimates, and packs:

  ```bash
  python3 scripts/r3/r3_research.py inventory
  python3 scripts/r3/r3_research.py metrics
  python3 scripts/r3/r3_research.py packs
  ```

  To re-open the manual sample, run `batch --batch 1 --batches 8` and `audit --batch 1 --batches 8` for each batch `1`–`8` [M]; use `detail --message-id <id>` on edge cases. The scripts do not auto-label. Do not regenerate the manifest unless intentionally drawing a new sample.

## Findings

### Action mix and daily volume

`[M]` = measured in the snapshot or labeled sample. `[I]` = design-weighted estimate/inference. “Sample n” is the analyst’s labeled count; confidence is qualitative. Counts and intervals are rounded.

| Action | Sample n | Estimated population | Share (approx. 95% CI) | Average/day (approx. 95% CI) | Confidence |
|---|---:|---:|---:|---:|---|
| no_action | 227 [M] | 4,968 [I] | 63.47% [I] (58.46–68.47% [I]) | 66.23 [I] (61.01–71.46 [I]) | Moderate |
| quote_availability | 16 [M] | 245 [I] | 3.13% [I] (1.31–4.96% [I]) | 3.27 [I] (1.36–5.18 [I]) | Low–moderate |
| new_booking | 39 [M] | 787 [I] | 10.05% [I] (6.88–13.23% [I]) | 10.49 [I] (7.18–13.81 [I]) | Moderate |
| amend | 16 [M] | 211 [I] | 2.69% [I] (1.01–4.37% [I]) | 2.81 [I] (1.05–4.56 [I]) | Low–moderate |
| cancel | 16 [M] | 57 [I] | 0.72% [I] (0.02–1.43% [I]) | 0.75 [I] (0.02–1.49 [I]) | Low |
| payment_proof | 16 [M] | 347 [I] | 4.44% [I] (2.24–6.64% [I]) | 4.63 [I] (2.34–6.93 [I]) | Low–moderate |
| billing | 33 [M] | 590 [I] | 7.54% [I] (4.86–10.21% [I]) | 7.86 [I] (5.07–10.66 [I]) | Moderate |
| group_event | 22 [M] | 296 [I] | 3.78% [I] (1.82–5.74% [I]) | 3.94 [I] (1.90–5.99 [I]) | Low–moderate |
| other_actionable | 15 [M] | 327 [I] | 4.18% [I] (1.98–6.38% [I]) | 4.36 [I] (2.07–6.66 [I]) | Low–moderate |

Overall actionable volume is `173/400` [M] in the sample and `36.53%` [I] of the frame (`2,859` [I], about `38.13/day` [I], 95% CI `32.91–43.35/day` [I]). Confidence is moderate for this aggregate, lower for smaller classes. The frame includes obvious non-reservation system notices from unlisted platforms; those were manually labeled `no_action`, not silently filtered.

### Agent notices, vouchers, POP, and billing

The weighted flag estimates below use the same strata and are not counts of distinct bookings. Flags mean: `agent_notice` = identifiable agent/TMC/corporate booking sender; `booking_request` = new stay creation is requested/implied; `payment_proof_evidence` = actual POP/transfer receipt, not a promise or virtual card; `agent_voucher` = agent-supplied hotel booking voucher/document.

| Flag | Labeled sample | Estimated population | Share (approx. 95% CI) |
|---|---:|---:|---:|
| agent_notice | 70/400 (17.50%) [M] | 1,097 [I] | 14.02% [I] (10.62–17.42% [I]) |
| booking_request | 45/400 (11.25%) [M] | 908 [I] | 11.60% [I] (8.25–14.96% [I]) |
| payment_proof_evidence | 23/400 (5.75%) [M] | 469 [I] | 5.99% [I] (3.45–8.54% [I]) |
| agent_voucher | 35/400 (8.75%) [M] | 615 [I] | 7.86% [I] (5.16–10.57% [I]) |

Among the `35` [M] voucher labels, `24` [M] were also booking requests and not POP (`75.6%` [I] weighted composition); `11` [M] were neither booking requests nor POP (`24.4%` [I]); `0` [M] had actual POP evidence. The zero overlap is a sample observation, not proof that such cases never occur in the population. Billing differs from POP: invoice/folio/pro-forma/statement requests, payment-link failures, virtual-card charging, refunds, and account allocation need billing work; POP means evidence that money was already transferred/paid and must be matched. A VCC, invoice, payment promise/link, declined-card alert, or staff’s refund receipt is not guest/agent POP.

For the follow-up test, I looked only for a later outbound staff PDF semantically tagged as a Confirmation Letter, in the same thread and addressed to the sampled sender’s domain. Result: `0/35` [M] agent vouchers and `0/26` [M] agent-notice + booking-request messages had such a PDF. There are `1,174` [M] staff PDF attachments with the `hrcen_confirmation_letter_*` filename prefix and `6` [M] with `hrcen_offer_*` (`2,162` [M] staff PDF rows total); these are attachment counts, not unique stays. The absence of a same-thread match does not prove no HMS entry—thread splits and unlinked follow-up mail are possible—but the sampled agent vouchers cannot be claimed as keyed on this evidence alone.

**Travel-agent domains should not be filtered wholesale.** In-scope agent messages include booking vouchers, amendments, cancellations, POPs, and invoice requests; sender-domain filtering would drop reservation work. Keep the supplied OTA/channel exclusions, match agent notices to an existing reservation/reference, and classify by current action/document rather than sender alone. Unlisted automated systems remain in the frame and were manually labeled when clearly informational.

### Manual action vs. current extraction kind

Cells are weighted estimated population count / percent within the manually labeled action row [I]. `(none)` means no successful extraction row, not “no action.”

| Manual action \ Current extraction | (none) | other | voucher_pop | booking | amendment | cancellation | quote | spam |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| no_action | 3,727 / 75.0% [I] | 817 / 16.5% [I] | 77 / 1.6% [I] | 80 / 1.6% [I] | 14 / 0.3% [I] | 6 / 0.1% [I] | 14 / 0.3% [I] | 233 / 4.7% [I] |
| quote_availability | 198 / 80.9% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] | 47 / 19.1% [I] | 0 / 0.0% [I] |
| new_booking | 624 / 79.3% [I] | 0 / 0.0% [I] | 60 / 7.6% [I] | 93 / 11.8% [I] | 5 / 0.7% [I] | 0 / 0.0% [I] | 6 / 0.7% [I] | 0 / 0.0% [I] |
| amend | 168 / 79.6% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] | 43 / 20.4% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] |
| cancel | 29 / 50.7% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] | 28 / 49.3% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] |
| payment_proof | 253 / 73.0% [I] | 21 / 5.9% [I] | 73 / 21.1% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] |
| billing | 331 / 56.1% [I] | 172 / 29.2% [I] | 75 / 12.7% [I] | 4 / 0.7% [I] | 2 / 0.4% [I] | 0 / 0.0% [I] | 6 / 0.9% [I] | 0 / 0.0% [I] |
| group_event | 198 / 67.1% [I] | 21 / 7.0% [I] | 14 / 4.6% [I] | 25 / 8.5% [I] | 18 / 6.0% [I] | 0 / 0.0% [I] | 20 / 6.9% [I] | 0 / 0.0% [I] |
| other_actionable | 253 / 77.4% [I] | 56 / 17.2% [I] | 14 / 4.1% [I] | 0 / 0.0% [I] | 2 / 0.6% [I] | 2 / 0.6% [I] | 0 / 0.0% [I] | 0 / 0.0% [I] |

The current `booking` kind covers only `11.8%` [I] of manual new-booking volume; `79.3%` [I] is `(none)`. Only `21.1%` [I] of manual POP cases are `voucher_pop`; that kind also appears in new-booking, billing, group/event, and no-action rows. The current prompt explicitly prioritizes reservation action over attached voucher/POP and maps invoice/folio requests to `other`, but the extraction kind still is not a calibrated `needs_action` decision. See [extract.ts](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/ai/extraction/extract.ts:27).

### Extraction-kind instability

Within the `7,827` [M] in-scope messages, `2,046` [M] have a successful extraction; those messages have `3,027` [M] successful version rows. `945/2,046` [M] (`46.2%` [M]) have multiple successful versions; earliest-to-latest kind changed for `227/945` [M] (`24.0%` [M] of repeats; `11.1%` [M] of current extracted messages).

| Latest kind | Current messages | Multiple versions | Kind changed | Changed / all current class | Changed / repeated class |
|---|---:|---:|---:|---:|---:|
| other | 1,087 [M] | 620 [M] | 67 [M] | 6.2% [M] | 10.8% [M] |
| voucher_pop | 312 [M] | 119 [M] | 40 [M] | 12.8% [M] | 33.6% [M] |
| booking | 202 [M] | 119 [M] | 95 [M] | 47.0% [M] | 79.8% [M] |
| amendment | 84 [M] | 36 [M] | 16 [M] | 19.0% [M] | 44.4% [M] |
| cancellation | 36 [M] | 16 [M] | 2 [M] | 5.6% [M] | 12.5% [M] |
| quote | 92 [M] | 30 [M] | 6 [M] | 6.5% [M] | 20.0% [M] |
| spam | 233 [M] | 5 [M] | 1 [M] | 0.4% [M] | 20.0% [M] |

Largest earliest→latest transitions: `voucher_pop→booking` `70` [M], `voucher_pop→other` `51` [M], `other→voucher_pop` `38` [M], `other→booking` `24` [M], `other→amendment` `11` [M]. In-scope version-row counts: `extract-0d1ab7157181` `1,267` [M], `extract-ceb144e605e0` `683` [M], `extract-8648bac4f269` `1,072` [M], `extract-74e6088b9d8b` `5` [M].

The code hashes hotel rules, extraction prompt/note, translation rules, and both schemas into `EXTRACTION_VERSION` [M]; different hashes therefore do not prove a prompt-only change. The snapshot has no historical prompt payload/diff, so causation cannot be isolated. Booking vs. voucher/POP vs. `other` is an evident ambiguous boundary, and current rules give reservation action precedence; versioned prompt/schema changes may also contribute. Counts are high-confidence census measurements; causal explanation is low confidence. See [inbound-run.ts](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/ai/extraction/inbound-run.ts:65).

### Infor HMS use and code support

“HMS used” is an operational inference from the message/document workflow, not an observed write audit. Code support below is a read-only source audit [M]; only `hms_find_reservation` currently has live promotion evidence in the registry. `hms_quote_stay`, documents, folio, company-account, group, and event reads are present but remain live-gated. `hms_read_reservation` and `hms_read_notes_traces` are included-scope/context reads, not active production tools.

| Action | Staff uses HMS? [I] | Read support in code [M] | General production write tool [M] |
|---|---|---|---|
| no_action | No | None needed | No |
| quote_availability | Yes — check rates/availability and send offer | `hms_quote_stay`; standalone Playwright `fetch-quote` is read-only | No booking, hold, or price-lock action |
| new_booking | Yes — create/confirm stay; match references first | `hms_find_reservation` for lookup; context read exists but is inactive | No general create tool; a separate `create-lab-stay` harness can save a test stay |
| amend | Yes — update existing stay | `hms_find_reservation`; inactive reservation-context read | No general amend tool |
| cancel | Yes — cancel/reconcile existing stay | `hms_find_reservation`; inactive reservation-context read | No general cancel tool; separate guarded lab cancel script only |
| payment_proof | Yes — match proof to stay/deposit/folio | `hms_find_reservation`, `hms_read_folio`, `hms_list_documents`; company-account read for linked billing | No charge/post/settle/refund tool |
| billing | Yes — folio, invoice, statement, account, remittance work | `hms_read_folio`, `hms_company_account_read`, `hms_list_documents`, `hms_sent_email_audit` | No invoice-generation, payment-link, charge, refund, or account-write tool |
| group_event | Yes — group block/rooming/event coordination | `hms_group_block_read`, `hms_event_read`, `hms_list_documents` | No rooming-list entry, release, block, or event-write tool |
| other_actionable | Sometimes — depends on stay-linked request | `hms_find_reservation`; inactive reservation/notes-traces context reads | No general notes/special-request/transport write tool |

The [read-tool registry](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/src/hms/read-tools.ts:16) declares read effects and denies `create`, `amend`, `cancel`, `post`, `settle`, `refund`, and other mutations [M]. Production activation requires live evidence [M]; the current quote tool is specifically fail-closed until a trusted current-rate reference exists [M]. The [Playwright quote README](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/tooling/playwright-quote/README.md:1) says it is attach-only and performs no booking/hold. Separate lab scripts exist for create/cancel/document-upload tests ([create](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs:2), [cancel](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/tooling/playwright-quote/cancel-lab-stay.mjs:2), [attach](/home/ubuntu/projects/zero/.worktrees/qm-l5/apps/server-pilot/tooling/playwright-quote/attach-document.mjs:2)); they are not general model-facing production tools and were not run.

Local audit evidence: `178` [M] HMS read rows (`find` `94`, `search_guest` `49`, `staff_quote` `18`, `party` `13`, null-kind `4` [M]) and `23` [M] staff-quote runs. These are read/quote events, not proof of write completion. The corpus does not include HMS write-audit rows.

## Examples

- `a20aad75-3a22-43f0-8184-6eda30eafb39` — human `new_booking`, extraction `(none)`: “Please download the attached booking voucher for more information.”
- `33b34021-25c2-4858-8415-c9127023ab72` — human `payment_proof`, extraction `(none)`: “Kindly find attached POP.”
- `bad020f7-a99a-486a-afac-774d8e9a4bae` — human `billing`, extraction `(none)`: “Attached please find the Payment documents for [name].”
- `f52c0824-4fe4-4c25-8a50-56447476c528` — human `billing`, extraction `other`: “wait for invoices and process payments accordingly.”
- `e84b2f87-8443-4c0c-8103-25b68fc859df` — human `other_actionable`, extraction `(none)`: “Kindly assist for shuttle services for the clients.”
- `2c1599b3-bac9-4188-8be7-90930ad2ead2` — human `cancel`, extraction `cancellation`: “BOOKING CANCELLED - NOTIFICATION.”

Snippets are masked and under `200` characters. Owner packs contain `10` [M] masked examples per action: [no_action](/home/orca/nava-research/reports/r3-review/no_action.md), [quote_availability](/home/orca/nava-research/reports/r3-review/quote_availability.md), [new_booking](/home/orca/nava-research/reports/r3-review/new_booking.md), [amend](/home/orca/nava-research/reports/r3-review/amend.md), [cancel](/home/orca/nava-research/reports/r3-review/cancel.md), [payment_proof](/home/orca/nava-research/reports/r3-review/payment_proof.md), [billing](/home/orca/nava-research/reports/r3-review/billing.md), [group_event](/home/orca/nava-research/reports/r3-review/group_event.md), [other_actionable](/home/orca/nava-research/reports/r3-review/other_actionable.md).

## Implications for the product

- Treat `needs_action` and `action` as separate workflow labels; do not infer either from extraction `kind` or attachment type alone. Use the target message plus thread state to distinguish a current task from prior/resolved work, acknowledgments, and reactions.
- Keep agent/TMC senders in scope. Detect voucher/booking intent, match an existing stay by agent reference/confirmation, and only route unmatched/new stays to manual HMS entry. Do not equate a voucher with POP.
- Split POP from billing: POP is evidence of completed transfer to reconcile; invoices, folios, statements, remittances, VCC/card processing, payment-link issues, refunds, and account allocation are billing. Keep financial posting/charging human-approved until a separate authorized write workflow exists.
- Use `hrcen_confirmation_letter_*` as a useful but incomplete outcome signal. Link by booking reference/date/party across threads; sender-domain or thread-only matching misses split conversations. Capture actual HMS create/amend/cancel outcomes before claiming that agent notices are synchronized.
- Prioritize safe reservation lookup and quote/read coverage first. Current write coverage is absent from the general model-facing tool registry; lab scripts are not operational write authorization. Keep group/event and account reads gated until their live evidence is present.

## Open questions

- Owner: are auto-generated TMC cancellation notices actionable when the booking is expected to exist, even without an in-thread Confirmation Letter or explicit “please cancel” request? Should a reservation match be mandatory?
- Owner: should agent vouchers with a complete itinerary but no later confirmation be labeled `new_booking` by default, or remain “agent notice—verify/synchronize” until HMS matching is available?
- Owner: should arrival-time/transport/group coordination sit in `group_event` or `other_actionable`? A few sampled cases straddle that boundary.
- Owner: after review, should unlisted platforms such as Profitroom/Tiket.com/RateTiger/H-Pay get explicit system-sender filters? They remain in this frame and are manually `no_action` when clearly automated.
- Needed for stronger validation: an authorized, privacy-minimized HMS write audit or owner confirmation of create/amend/cancel outcomes; this read-only snapshot cannot prove whether sampled vouchers were keyed.
