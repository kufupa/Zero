# Centurion booking workflow wayfinding (2026-10-28)

Scope: bounded reuse of existing Zero evidence plus current source. Checkout HEAD and origin/main were 00d814ca3. The initial local review used no raw mail, live HMS, tests, credentials, web research, or external upload; the later framework comparison used public web research described below. This is a research note, not implementation approval.

## Decision: owner has already ranked the next slice

- Owner’s current next-slice preference is complete new bookings, including native Add-Ons; then direct Tours, then amendments/cancellations. The 2026-10-27 target pairs end-to-end new bookings with provisional HMS quotes, explicitly not Excel. [OWNER-ASKS.md#L419](../context/OWNER-ASKS.md#L419) [OWNER-ASKS.md#L474](../context/OWNER-ASKS.md#L474)
- This conflicts with PRODUCT’s standing global ROI order: quote first, then create, amend, cancel, then payment/voucher/billing/group work. Treat the newer owner asks as the next-slice priority, not a silent rewrite of the long-term spec. [PRODUCT.md#L21](../../PRODUCT-ASKS-HISTORY.md#L21) [PRODUCT.md#L22](../../PRODUCT-ASKS-HISTORY.md#L22) [PRODUCT.md#L25](../../PRODUCT-ASKS-HISTORY.md#L25)
- Ask 314 requested a ranked plan; it did not authorize implementation. Do not re-ask whether bookings matter or whether Excel is the target. [OWNER-ASKS.md#L474](../context/OWNER-ASKS.md#L474) [2026-10-27-010-hms-booking-provisional-priorities-shape.md#L12](../plans/2026-10-27-010-hms-booking-provisional-priorities-shape.md#L12)

## Correction: child-age create is no longer a blanket source gap

- The Oct 27 parity note was source-only at 92be0e5d2 and said child-bearing saves were refused; it is stale against current HEAD 00d814ca3. [booking-parity.md#L5](2026-10-27-next-run/booking-parity.md#L5) [booking-parity.md#L13](2026-10-27-next-run/booking-parity.md#L13)
- Current source has individual child-age inputs in the booking card, a childAges pane-save field, a Playwright HMS age-entry step, and saved age-band readback. These are source facts, not proof of every property’s behavior. [booking-card.tsx#L1679](../../apps/mail/components/quote-workflow/booking-card.tsx#L1679) [pane-stay-save.ts#L75](../../apps/server-pilot/src/ai/pane-stay-save.ts#L75) [create-lab-stay.mjs#L857](../../apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs#L857) [create-lab-stay.mjs#L1393](../../apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs#L1393)
- ACTIVE records an earlier partial HRDAV Labtest: one room with a child in the 3–12 age band saved and read back; another room in that attempt was refused as a duplicate. A later HRDAV Labtest created linked multi-room reservations. Neither establishes current HRCEN end-to-end parity. [ACTIVE.md#L16](../context/ACTIVE.md#L16) [ACTIVE.md#L18](../context/ACTIVE.md#L18)
- The current 2026-10-28 ACTIVE booking run is HRDAV-only; it does not establish current CEN parity. The prior 2026-10-27 plan left HRCEN availability/create unproven in its snapshot. [ACTIVE.md#L15](../context/ACTIVE.md#L15) [2026-10-27-010-hms-booking-provisional-priorities-shape.md#L26](../plans/2026-10-27-010-hms-booking-provisional-priorities-shape.md#L26)

## Existing tools, required fields, and human gates

- Deterministic quote/availability, create, amend, cancel, and document-attachment contracts are already mapped. The current full-field live evidence cited in ACTIVE is HRDAV, not CEN; the older static field map is not live readiness proof. [2026-10-24-multihotel-shape-S1-infor-fields.md#L19](2026-10-24-multihotel-shape-S1-infor-fields.md#L19) [2026-10-24-multihotel-shape-S1-infor-fields.md#L20](2026-10-24-multihotel-shape-S1-infor-fields.md#L20) [2026-10-24-multihotel-shape-S1-infor-fields.md#L21](2026-10-24-multihotel-shape-S1-infor-fields.md#L21) [2026-10-24-multihotel-shape-S1-infor-fields.md#L22](2026-10-24-multihotel-shape-S1-infor-fields.md#L22) [2026-10-24-multihotel-shape-S1-infor-fields.md#L23](2026-10-24-multihotel-shape-S1-infor-fields.md#L23)
- Common create-required data: arrival/departure, adults, room type, rate plan, first/last name, source of business, track, and guarantee. Create remains Preview → explicit “Create provisional booking.” [2026-10-24-multihotel-shape-S1-infor-fields.md#L20](2026-10-24-multihotel-shape-S1-infor-fields.md#L20) [booking-parity.md#L12](2026-10-27-next-run/booking-parity.md#L12)
- Quote inputs/review keep room-type rows, counts/occupancy, dates, HMS rates, and quote contact (name/email/phone) separate from company/agency. Staff choose rates; discount needs “Authorised by”; Nava saves an unsent draft and never sends. [PRODUCT.md#L38](../../PRODUCT-ASKS-HISTORY.md#L38) [PRODUCT.md#L39](../../PRODUCT-ASKS-HISTORY.md#L39) [PRODUCT.md#L40](../../PRODUCT-ASKS-HISTORY.md#L40) [PRODUCT.md#L42](../../PRODUCT-ASKS-HISTORY.md#L42)
- Guest, contact/booker, and company/agency are distinct. Current create source searches and selects a uniquely matched native booking agency before saving; HRCEN end-to-end behavior remains unproved. The Oct 27 source audit reported booking prefetch without rate preparation and a V2 party-hydration identity defect; treat those as dated findings until rechecked at the current head. Current availability-prefetch source still selects quote extractions. [create-lab-stay.mjs#L507](../../apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs#L507) [create-lab-stay.mjs#L1175](../../apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs#L1175) [hms-jobs.ts#L2191](../../apps/server-pilot/src/ai/hms-jobs.ts#L2191) [prefetch-parity.md#L13](2026-10-27-next-run/prefetch-parity.md#L13)
- Writes stay human-approved. Staff must review guest/party, room/occupancy/ages, rate/board, recipient/status, and any Add-On before committing; unsupported values must not be guessed. [PRODUCT.md#L19](../../PRODUCT-ASKS-HISTORY.md#L19) [PRODUCT.md#L22](../../PRODUCT-ASKS-HISTORY.md#L22)
- Native Add-Ons are an owner priority. The 92be0e5d2 source audit found no create request field, pane control, writer, or readback; current-head parity still needs checking. Do not equate Add-Ons with meal plan/board, a shuttle draft, or reservation notes. [booking-parity.md#L14](2026-10-27-next-run/booking-parity.md#L14)

## Dated corpus evidence (observed vs inferred)

| Evidence | Result and limitation |
|---|---|
| R3, 2026-07-30–2026-10-13; 7,827 non-channel inbound; weighted sample 400 messages | New booking 39/400 → estimated 10.05% / 787 messages; quote/availability 16/400 → 3.13% / 245. One analyst, no second-rater adjudication; overlapping labels. Directional volume signal, not ROI. [FACTS.md#L9](../context/FACTS.md#L9) [FACTS.md#L14](../context/FACTS.md#L14) [FACTS.md#L15](../context/FACTS.md#L15) [FACTS.md#L24](../context/FACTS.md#L24) |
| Centurion booking prefill, 2026-10-20; 26 messages / 23 threads, 10 purposively sampled | Only one provisional same-thread find, with no confirmation-linked truth. Across pool, 14/31 room rows lacked type, 6/31 lacked board; six saved revisions lacked party context. Not an accuracy estimate. [2026-10-20-booking-prefill-backtest.md#L8](2026-10-20-booking-prefill-backtest.md#L8) [2026-10-20-booking-prefill-backtest.md#L31](2026-10-20-booking-prefill-backtest.md#L31) [2026-10-20-booking-prefill-backtest.md#L43](2026-10-20-booking-prefill-backtest.md#L43) [2026-10-20-booking-prefill-backtest.md#L44](2026-10-20-booking-prefill-backtest.md#L44) |
| Quote backtest, 2026-10-20; n=8 plannable individual threads | 5/8 matched plan-class + board + room; 2/8 exact price. Below the product ≥10-thread quote-price bar. [2026-10-20-quote-backtest-pool.md#L39](2026-10-20-quote-backtest-pool.md#L39) [2026-10-20-quote-backtest-pool.md#L63](2026-10-20-quote-backtest-pool.md#L63) [2026-10-20-quote-backtest-pool.md#L65](2026-10-20-quote-backtest-pool.md#L65) |
| Party production snapshot, 72 h to 2026-10-19 12:06Z; 121 successful reads | 18 had answer-key business senders; 4/18 auto-bound. Independent labels n=7, with 0/1 wrong-bound observation; this cannot establish the zero-wrong bar or safe auto-binding. [2026-10-19-party-eval-72h.md#L9](2026-10-19-party-eval-72h.md#L9) [2026-10-19-party-eval-72h.md#L55](2026-10-19-party-eval-72h.md#L55) [PRODUCT.md#L68](../../PRODUCT-ASKS-HISTORY.md#L68) |
| Rate-word scan, 30 d to 2026-10-24; six mailboxes | HRCEN had 619 quote-like outbound signals and 487 BAR-word hits, but confirmation letters inflate the scan. Across six mailboxes, travel-agent sender predicted STO/net in 17/128 (13%); “wholesale” in 0/128. Owner’s STO/wholesale default request is not validated by these text proxies. [OWNER-ASKS.md#L420](../context/OWNER-ASKS.md#L420) [2026-10-24-multihotel-shape-S5-rate-patterns.md#L20](2026-10-24-multihotel-shape-S5-rate-patterns.md#L20) [2026-10-24-multihotel-shape-S5-rate-patterns.md#L24](2026-10-24-multihotel-shape-S5-rate-patterns.md#L24) [2026-10-24-multihotel-shape-S5-rate-patterns.md#L30](2026-10-24-multihotel-shape-S5-rate-patterns.md#L30) [2026-10-24-multihotel-shape-S5-rate-patterns.md#L59](2026-10-24-multihotel-shape-S5-rate-patterns.md#L59) [2026-10-24-multihotel-shape-S5-rate-patterns.md#L60](2026-10-24-multihotel-shape-S5-rate-patterns.md#L60) |
| Shuttle/Add-On corpus; keyword-screened overlapping exports | HRCEN candidates: C 46/3,599 threads (1.3%), D0 64/3,083 (2.1%); Add-On/remove mention does not establish a native workflow. Jarat provider evidence is HRDAV-only; CEN provider remains unknown. [2026-10-26-shuttle-corpus.md#L18](2026-10-26-shuttle-corpus.md#L18) [2026-10-26-shuttle-corpus.md#L24](2026-10-26-shuttle-corpus.md#L24) [2026-10-26-shuttle-corpus.md#L31](2026-10-26-shuttle-corpus.md#L31) [2026-10-26-shuttle-corpus.md#L57](2026-10-26-shuttle-corpus.md#L57) |

## Remaining gaps and evidence that would rank ROI

- Do not re-ask the owner’s booking-first / not-Excel decision. Still unresolved: what “provisional HMS quote” means in native status, letter, and recipient; exact CEN Add-On catalog/row identity/charge/date/removal/readback; safe rate-default and party-binding evidence. [2026-10-27-010-hms-booking-provisional-priorities-shape.md#L14](../plans/2026-10-27-010-hms-booking-provisional-priorities-shape.md#L14) [HANDOFF-2026-10-27-booking-completeness-planning.md#L92](../context/HANDOFF-2026-10-27-booking-completeness-planning.md#L92)
- Corpus frequency alone cannot establish staff time, revenue impact, or cost saved. Compare independent CEN mail IDs against staff/HMS outcomes; count staff minutes, edits, abstentions, wrong-field/rate/party errors, and Add-On failures. Owner-requested booking extraction target is ≥100 independent examples per hotel; quote-price bar is ≥10 plannable threads and quote recall bar is ≥85% on ≥100 independent outbound-grounded rows. [2026-10-27-010-hms-booking-provisional-priorities-shape.md#L42](../plans/2026-10-27-010-hms-booking-provisional-priorities-shape.md#L42) [PRODUCT.md#L69](../../PRODUCT-ASKS-HISTORY.md#L69) [PRODUCT.md#L108](../../PRODUCT-ASKS-HISTORY.md#L108)
- 95 threshold: documented next-slice priority is supported by owner decisions; measured ROI, CEN end-to-end create/quote, native Add-On semantics, safe party binding, and a CEN rate default remain unresolved. Route: local docs and current source only; no web. Research cost was not metered. The research skill requested a background reader, but no spawn-agent tool was exposed, so source checking was done inline.

## 2026-10-28 follow-up: chosen slice and existing answer keys

- Owner selected **booking-ready draft first**: extract stay details, search agency and rate, show uncertainty, then staff approve HMS creation. The latest steer was to reuse prior corpus research and avoid repeating already answered questions. No product implementation or live HMS run was requested in this discussion.
- The existing versioned action-class gold has 26 rows, with zero create examples in the measured version; it is not a booking-field answer key. [PRODUCT.md#L55](../../PRODUCT-ASKS-HISTORY.md#L55) [research CATALOG#L24](CATALOG.md#L24)
- An existing HMS party answer-key set has 194 rows: 167 found, 26 not found and one failure. Among the 167 found reservations, agency was present on 107, company on 115, and both on 74; these overlapping fields should remain distinct. Reuse this historical set for party research, but it is not a field-complete current booking gold set. [research README#L15](2026-10-13/README.md#L15) [party-strategy decision#L15](2026-10-19-party-strategy-decision.md#L15)
- In 93 heuristically paired quote asks, 29 lacked a complete date pair, 18 asked for a room count without a type, and 58 mentioned meal/dinner. These are historical quote requests, not a new-booking accuracy score. Ask staff for a missing required value rather than silently inventing it; preserve requested board, price and room allocations separately. [R1#L34](2026-10-13/r1-quote-gold.md#L34) [R1#L45](2026-10-13/r1-quote-gold.md#L45)
- Of 35 sampled agent vouchers in R3, 24 also requested a booking and zero had actual payment-proof evidence. This is a small sample, not proof that vouchers never prove payment. Keep booking intent and payment status separate. [FACTS.md#L28](../context/FACTS.md#L28)
- Prior agency work already tested cheaper approaches: on 107 historical agency bookings, sender history using only earlier arrivals yielded 65 correct suggestions, one wrong and 41 abstentions. A selected Oct 19 live replay of 42 mails had a hybrid party-search median of 29 seconds versus 65 seconds for v2; it bound the right profile for 20/22 staff-confirmed positives versus 21/22 for v2. Those are historical, selected samples, not current HRCEN performance or a deployment recommendation. [party-strategy decision#L11](2026-10-19-party-strategy-decision.md#L11) [corrected replay#L89](2026-10-19-party-strategy-decision.md#L89)
- Existing September thread-link evidence covered 438 actionable cases: detected responded cases rose from 71 using same-thread outbound only, to 149 with confirmation-number cross-thread links, then 246 with quoted/orphan matching. Those are response classifications, not proof of booking-field accuracy. [thread matching handoff#L40](../superpowers/plans/handoff-reports/2026-09-02-centurion-thread-matching.md#L40)
- In the Oct 26 captured-mail study, 884/1,223 confirmation-letter copies across six mailboxes had no same-thread inbound. This is not a Centurion-only estimate or a mailbox-coverage rate. It supports trying cross-thread linkage, not assuming recipient alone identifies a reservation. [corpus report#L40](2026-10-26-r-corpus.md#L40)
- The Oct 20 linkage method combined recipient, surname, arrival date, same thread, and chronology, rejected conflicting dates and ties, and accepted only a unique high-score candidate supported by at least two key families. A masked reviewer supported 30/30 sampled positive links; this checks selected-link precision, not recall. [linkage report#L22](2026-10-20-arch-lanes/l1-linkage-domains.md#L22)
- For an actual booking gold set, retain confirmation number, property, candidate recipient and request/staff/HMS provenance privately; match across threads using the existing linker; ask a reviewer to resolve collisions and missing evidence. Freeze system input at the original decision timestamp, excluding later staff replies and confirmations. Include independently sampled unanswered, ambiguous, quote-only and no-confirmation cases; unresolved is unknown, not a negative. The last three days of a three-day follow-up window are right-censored. Start with 10–20 reviewed exploratory examples; scale to the owner's ≥100 independent booking examples per hotel before claiming accuracy. Availability of all past-week Centurion mail remains unproved until source-mailbox coverage is compared independently.

### Fresh Centurion captured-mail inventory

Read-only Product database aggregates for 2026-10-21 18:36:29 through 2026-10-28 18:36:29 UTC, using the indexed `transport_id` + `received_at` range and a five-second SQL statement timeout:

| Direction | Captured rows | Distinct Message-ID-or-row-ID keys | Outbound confirmation-letter subject candidates |
|---|---:|---:|---:|
| Inbound | 896 | 839 | — |
| Outbound | 701 | 681 | 505 |

The 505 candidate copies had 485 distinct Message-ID-or-row-ID keys and 62 distinct raw `To` strings after case-folding and trimming. A further count found 470/505 had no inbound at or before the candidate's `received_at` in the same transport and thread. This is a same-thread absence, not proof that no matching request exists elsewhere. Subject matching used `confirmation[[:space:]_-]*letter`, a candidate heuristic, not proof that every row is a unique completed HMS booking; `To` strings were not fully parsed/canonicalized and `Cc` was not included. The `received_at` filter is not an independently reconciled sent-mailbox inventory. No names, addresses, subjects, mail bodies or credentials were returned, and no website/HMS operation occurred. Comparing with the source mailbox and checking ingest/forwarding is still required to establish completeness.

## 2026-10-28 follow-up: framework fit

Exa Agent ran public-source research only, cost $0.5001, with no private mail or credentials sent. It did not establish a numerical speed, cost or accuracy winner for Infor. See [Pomerado core](https://github.com/Pomerado/pomerado), [Stagehand v4 act](https://docs.stagehand.dev/v4/basics/act), [Stagehand local browser](https://docs.stagehand.dev/v4/configuration/browser), [v4 caching](https://docs.stagehand.dev/v4/best-practices/caching), and [Playwright frames](https://playwright.dev/docs/frames).

| Option | What the self-hosted path provides | Gap in this stack |
|---|---|---|
| Pomerado | AI builds/Guardian-reviews deterministic operation code; normal published runs require no Pomerado model request. One integration can expose one business operation and many can be minted. | Local core lacks Cloud automatic breakage detection/repair and saved logins; local host rejects CDP attach to Nava's existing browser. Native reauthentication exists but the current Infor reset/arrival flow is unproved. |
| Stagehand v4 local | `observe` plus `act(Action)` can replay without inference; `selfHeal` can re-infer once when a recorded selector fails. Local mode can connect by CDP. | Requires its extension and Stagehand-managed page, not Playwright Page interoperability; CDP/session/lock compatibility with actual Infor is unproved. Local v4 has no Browserbase server-side inference cache. Login expiry still needs app handling. |
| Codex-authored Playwright | Existing Nava tools, browser and property lock can be reused; reviewed runtime code can make zero model calls. | Browser/UI changes require a repair process and no automatic semantic self-healing is supplied by Playwright alone. |

Recommendation is to keep the existing pane, extraction, job/lock and approval contracts and compare one read operation behind that seam before deciding a provider; no stack rewrite is needed for the trial. The strongest counterargument is that repeated UI churn could make manually maintained Playwright more expensive than adaptive Stagehand or Pomerado generation. Compare time/cost to first verified result and repair, independent output correctness, login expiry and warm/cold runs on the same case; report failures and any model calls. Self-hosted browser/runtime with Azure inference is not fully local inference, and exact model-prompt/page-data egress remains to be verified.

Pomerado `.477`'s `get_job` reports running, input-required, completed or failed and supports up to 30 seconds waiting; its running snapshot does not report a detailed step or percentage. More granular progress needs additional instrumentation, not repeated mints. Input requests can be answered via `provide_input`; mint jobs disappear when their MCP process stops. [installed MCP server](/home/orca/.local/share/pomerado/native-canary477/node_modules/pomerado/dist/typescript/src/standalone/mcp-server.js) [job snapshot](/home/orca/.local/share/pomerado/native-canary477/node_modules/pomerado/dist/typescript/src/standalone/mcp-jobs.js)

The current published arrival lookup minted in about 13 minutes, then a separate run failed after 29.4 seconds; a second, owner-authorized diagnostic failed after 32.3 seconds before reaching search, on a property-button timeout. The exact login/page cause is unconfirmed. This is a failure signal for that integration, not a fair speed comparison. [ACTIVE.md#L3](../context/ACTIVE.md#L3)

Pomerado's Azure launcher was updated to Terra/xhigh for minter and Luna/medium for Guardian. `node --check` and mocked routing passed; a non-sensitive direct Azure Luna/medium completion succeeded. A real Pomerado Guardian pass has not yet been run with the new mapping; existing sessions need reconnecting to load it. The `wayfinder`, `prototype`, and `research` skills are installed and enabled for new Codex sessions; no broad skill sync was run.

## Timing and next handoff

The first checkpoint is a half-to-one-engineer-day timebox to inventory accessible messages and manually verify an exploratory 10–20 matched examples, conditional on accessible source data and reuse of the existing matcher. It is not a promised 100-row completion date. Measure labeling throughput before estimating the full answer key. For one narrow HRCEN booking-ready Labtest demo, 4–8 elapsed hours is a provisional planning budget if existing runners and login work; native Add-On automation, a 100-row evaluation and production readiness are not included. It may exceed the budget if authentication or parity fails. Prior separate ledger rows reported server-code median 32 minutes (n=26), UI 52 minutes (n=5), deploy 18 minutes (n=2), and live HMS 64 minutes (n=4; upper quartile 321 minutes); these are historical task durations, not a statistical prediction or production ETA. The critical booking chain includes native-tool/readiness, correct extraction and party/rates, staff approval, deployed pane, and live proof. [booking plan timing](../plans/2026-10-27-001-booking-completeness-plan.md#L177)

The owner confirmed a fresh login or browser per operation is acceptable for a fast MVP, with optimization over the weekend. Prefer a working authenticated session where convenient, otherwise use one bounded clean login and verify the resulting property/page under the existing hotel lock; do not add a speculative session-recovery platform. A new tab shares the original browser context unless isolated, so it may inherit an expired session. Pomerado's recent failed call does not establish that a clean browser solves the Infor root-page/reset issue. Pomerado's native input tool says secrets supplied there are visible to its MCP client and model; local browser hosting alone does not imply local model inference.

<details>
<summary>Original owner request and follow-up</summary>

> 1) "Pomerado’s source defaults use Sol medium for minting
>       and Luna medium for Guardian" :: lets do terra xhigh for minting and luna medium for guardian
>
>   2) shall we mint a harder real tool that we'd use...
>   help me figure out what we even need to build first
>
>   whats 10/10 product, whats highest roi i reckon new bookingsm whats the key fields i.e lets put together a gold dataset.
>
>   for the past week we've ingestsed all the centurion inbound / outbound right?
>   lets 1. get all the outbound automated confirmation messages from PMS via subject.
>   2. see which email addr  they're sent to
>   3. collate / aggregate by email addr
>   find all the inbound / outbound mail for the email addr
>   sort thru to see which confirmations line up to which inbound / outbound threads i.e match confirmation number to reuqest thread.
>   see where the request would fit in chronologically in that thread i.e just after outbound response if any
>   4. from that we can put together a real live reservationist dataset.
>   5. pls help out i wanna sketch out eta etc for this n put this together then we can use orca cli / worktrees / subagents to build this shit asap.
>   i wanna get this done as fast as possible is the goal ok to skip some routine / bullshit steps.
>
> lets do a grilling session to find out what i want n how to deliver then we can run it.
> we need...
> self hosted.
> speed.
> new centurion Saas focused.
> gotta remind ourselves what the HMS tools that we need to build and what the ROI on them is in step 1
> step 2 is what fields we need to pass and extract / predict / HITL (this is the hard part... where we've done SO much previous corpus analysis on so worth deploying subagents etc to read n fetch that)
>
> ok im lost fuck it lets do the grilling session idek what to build and why n how. help me chat thru it please.
>
> can we add n use https://www.aihero.dev/skills-wayfinder https://www.aihero.dev/skills-prototype https://www.aihero.dev/skills-research i think this will be a multi chat task cos tldr it looks like we're just overhauling everything lmao.
> maybe pomerado isn't even optimal for speed idk is it worth, like we had codex + playwright + browser directly to explore and drive what fields to grab / now, is that worth doing w the new website i.e pomerado
>
> i fee like cos pomerado is newer / no self healing in the self hosted it might even be worth using https://docs.stagehand.dev/v4/basics/act
>
> but idek im kinda confused at this point do research using exa agent on the OPEN SOURCE SELF HOSTED VERSIONS OF ALL 3 OPTIONS THEN CHAT THRU IT W ME.
> ig step 1 describe best product
> how does HMS automation kick in n specifically what tools i,e inputs n outputs.
> where does HITL live
> then we can use to decide vs stagehand vs pomerado n self healing stuff.
> main problem w infor will just be the logging in / out problems.
> yeah lets chat pls goal is just maintainable, cheap to dev n run, n fastest speed that i can build this automations with.
> tbh i feel like we're building such a simple customer support agent for legacy for centurion i.e
> infor for : new bookings, quote bookings, prepaid bookings. hard part is the travel agency lookup / profiles / rates n making sure details are extracted correctly / HITL side pane for that. also addons add some complexity in the infor UI too
> manual stuff for: jarat tours email workflow i.e add addon, wait for payment link to be sent, then remove addon and add as stay details once paid or smth i forgot.
> then also the excel sometimes for quoting.
> stuff is out of scope too i.e group bookings for now.
>
> yeah come chat to me i feel like what we're building is so easy and its october 2026 where we have access to sota models i.e luna 6 max for cheap, 6.1 terra xhigh / max for smart intelligent model n adversarial reviews via grok 4.7xhigh too ofc.
> lets research n chat thru this w me ig this is more a wayfinder thingy im asking for now in terms of choosing framework, how to build, how to build fast asf asf asf, etc etc

The owner selected “Booking-ready draft first” when asked for the first usable slice. Follow-ups:

> i feel like ive answered lots of these questions many times alr btw i reckon u just gotta find the evidence backed research on why we've done a lot of corupus passes alr so we have specific evidence backed numbers find n surface relevant ones to me to explain what to do n why.

> we can always just do a new login fresh tab or browser or smth every time worst case for this if we need an MVP type shit fast then over the weekend we can make it better but if u find best n elegant soln rn then thats optimal

</details>
