# Nava “10/10” product shape and evidence handoff

**Prepared:** 2026-10-29
**Historical snapshot:** For the later HMS rewrite, see [HMS Cloud tooling](../../apps/server-pilot/tooling/hms-cloud/README.md).
**Purpose:** durable resume point for the opening “10/10 product” discussion, the current HMS/reservationist tool inventory, and the evidence behind workflow priority. The scope intentionally stops before the later PDF-candidate-building exchange. This is a sanitized synthesis from current product/source files and dated research, not a verbatim transcript or claim that the product currently meets the vision. The research index explicitly says historical evidence does not establish current readiness or adoption and asks that raw mail, model responses, credentials, and full transcripts stay out of Git ([research handling and freshness rules](README.md#L82-L91)).

## Bottom line

The “10/10” product is not “more AI tools.” It is a fast, dependable reservationist workflow that understands a whole mail thread, distinguishes a new stay from an existing booking or system notice, brings forward only evidence-backed HMS facts, makes uncertainty visible, and leaves every guest-facing message unsent and every HMS write under staff approval. It makes the common quote path excellent first, then adds create/amend/cancel without confusing those different end states. This is a product-quality synthesis, not an owner-scored 10/10 acceptance bar.

The current owner baseline orders work Quote → Create → Amend → Cancel (cancel is Labtest-only) → payment/voucher/billing/group/event after the first four work on real mail; staff are not using Nava yet because the product is incomplete ([`PRODUCT.md`](../../PRODUCT.md#L7-L27), especially [current adoption statement](../../PRODUCT.md#L9-L11)). A dated architecture note recommends one intake/prefill with two endings—“Make quote” as default and “Create provisional booking”—and explicitly labels itself a recommendation, not deployment or HMS-write authority ([D9](../context/DECISIONS-2026-10-20.md#L31-L39); [architecture status](2026-10-20-arch-lanes/ARCHITECTURE.md#L1-L10)).

## What a 10/10 workflow should feel like

The flow below combines owner-confirmed product rules with research-informed design ideas. It describes the target; it is not evidence that every step is implemented, deployed, or currently usable.

| Step | Product behavior | Evidence / boundary |
|---|---|---|
| 1. Read the mail correctly | Classify every inbound; skip OTA/channel, automated, and spam mail at the door, while keeping travel agents in scope. A hotel's own mailbox sending itself a “Pre Stay” message with a confirmation number means an existing stay: never offer a new booking. | Owner rules: [`PRODUCT.md`](../../PRODUCT.md#L29-L35). |
| 2. Understand the request, not just the sender | Read the selected email with relevant thread context and attachments; show source and extracted facts. Keep quote contact, guest, booking agency, and bill-to company distinct. Never silently bind an ambiguous party or guess a missing stay field. | Pane requirements: [`PRODUCT-DETAIL.md`](../context/PRODUCT-DETAIL.md#L9-L21). The historical recommendation says one card per guest/date when a thread covers multiple stays and says sender domain is only a clue ([L1](2026-10-20-arch-lanes/l1-linkage-domains.md#L185-L222)). |
| 3. Make quotes the polished default | On open, prepare a priced quote in the background using reads only; the staff click may generate a PDF. Use current HMS availability/rates; prioritize the applicable company/agency contract rate, then BAR B&B, with hotel-specific dinner as an add-on. Keep requested room type/occupancy/board separate from HMS accommodation/person fields. Ask when dates, occupancy, room/sharing, or board remain unresolved; do not turn “single” into a particular bed type. | Owner quote rules: [`PRODUCT.md`](../../PRODUCT.md#L17-L27). Historical room/board sample shows why not to guess: 6/12 “single” rows mapped to Standard Queen, 5/12 to Standard Twin, and 1/12 was unparsed; direct ask text seldom specified type ([L3](2026-10-20-arch-lanes/l3-missing-info-rooms.md#L7-L13), [room mapping](2026-10-20-arch-lanes/l3-missing-info-rooms.md#L46-L68)). |
| 4. Put a human in control | Show rate/room choices and an editable quote PDF/Excel/reply. Keep company/agency out of the reply body. Staff select alternatives before they enter a reply. The default fully-booked response is a one-line decline. Save only an unsent draft; Nava never sends. Keep one primary action per step and hide dead controls. | Owner rules: [`PRODUCT.md`](../../PRODUCT.md#L21-L27), [pane details](../context/PRODUCT-DETAIL.md#L9-L21). |
| 5. Treat booking as a separate, approved ending | Staff may explicitly choose “Create provisional booking” after the quote step. Before exposing Create, verify which HMS Save actions can trigger a confirmation email and control that side effect; the historical architecture review identified this as an unresolved safety risk. | Owner D9: [`DECISIONS-2026-10-20.md`](../context/DECISIONS-2026-10-20.md#L31-L39); the 2026-10-20 architecture note flags possible send-on-save and says its status was unproven ([ARCHITECTURE.md](2026-10-20-arch-lanes/ARCHITECTURE.md#L12-L23)). |
| 6. Make existing-booking work explicit | Match the right reservation before an amend/cancel; if the match or paid/guaranteed state is unclear, show an unresolved/check state rather than guessing. Keep payment proof, voucher, billing, and penalty review separate from the action type. Cancellation stays Labtest-only until the owner changes scope; never accept penalty dialogs. | Product safety rules: [`PRODUCT.md`](../../PRODUCT.md#L41-L49). The architecture flow is a dated recommendation—not implementation proof—for quote default, human resolution of ambiguous/unknown state, and money review ([ARCHITECTURE.md](2026-10-20-arch-lanes/ARCHITECTURE.md#L25-L47)). |
| 7. Make completion observable and safe | Writes follow Prepare → Queue → Act → Review with a screenshot; present errors in staff language and do not claim “done” from a merge, flag, or green test alone. | [`PRODUCT.md`](../../PRODUCT.md#L13-L20), [hard rules and done gate](../../PRODUCT.md#L41-L55). |

### Safety and quality bar

- No guest email is sent by Nava. No real-guest HMS write is authorized by this note; verify the owner’s current scoped authority and effective runtime before acting. Product guidance restricts writes to Labtest except the stated owner-controlled save gate, forbids automatic real-guest bookings, and forbids accepting cancellation-penalty dialogs ([`PRODUCT.md`](../../PRODUCT.md#L41-L49)).
- Evaluate on production-equivalent inputs against independent truth, using the same versioned rows; historical samples and labels do not prove today’s behavior. The roughly 30-row golden-set mix (quote 12, amend 6, cancel 4, create 3, channel/system skip 5) is an evaluation design, not real-world prevalence ([`PRODUCT-DETAIL.md`](../context/PRODUCT-DETAIL.md#L23-L30)).
- The 2026-10-14 party-bind, price, front-door, and amend/cancel thresholds in the detail table were **proposed**, not universally owner-approved. D3 later approved replacing the agent-proposed “≥10 pricing threads” bar but did not state a replacement. D19 separately accepted ≥85% **quote recall** on a target of ≥100 independent outbound-grounded rows for that 2026-10-20 plan; that is not a pricing-correctness bar ([proposed bars and scope](../context/PRODUCT-DETAIL.md#L31-L43); [D3/D19](../context/DECISIONS-2026-10-20.md#L31-L46)). The old 15/26 → 24/26 score was a fair same-row historical comparison, not a current pass ([`PRODUCT-DETAIL.md`](../context/PRODUCT-DETAIL.md#L25-L30)).

## HMS and reservationist tool inventory in source

These names are code-level surfaces, not a promise that staff can invoke them. Registry promotion, runner injection, effective process configuration, live proof, and staff adoption are separate facts.

### Phase-B HMS read registry: eight IDs

[`READ_TOOL_IDS`](../../apps/server-pilot/src/hms/read-tools.ts#L16-L25) currently contains exactly these eight. The registry only considers a read production-active when live evidence and a live-verified/shadow-enabled capability state are present ([predicate](../../apps/server-pilot/src/hms/read-tools.ts#L676-L689)). On the current source snapshot, **only `hms_find_reservation` passes that registry test**. This does not prove that a deployed process exposes it to staff.

| Tool ID | Code-defined purpose | Current registry evidence / caveat |
|---|---|---|
| `hms_find_reservation` | Find a stay from an exact confirmation or external reference. | `promotionEvidence.live` and `liveProofDigest` are present; the only Phase-B production-active ID ([definition](../../apps/server-pilot/src/hms/read-tools.ts#L286-L323)). |
| `hms_quote_stay` | Read room/rate availability for an unambiguous stay request. | Fixture/discovery only; explicitly fails closed until a trusted current-rate reference exists ([definition](../../apps/server-pilot/src/hms/read-tools.ts#L346-L382)). |
| `hms_list_documents` | List document metadata for an authorized reservation/document scope. | No live promotion proof; denied actions include opening/fetching document bytes ([definition](../../apps/server-pilot/src/hms/read-tools.ts#L383-L424)). |
| `hms_sent_email_audit` | Read sent-email metadata/audit. | Live promotion false; opening attachments and resending are denied ([definition](../../apps/server-pilot/src/hms/read-tools.ts#L425-L456)). |
| `hms_read_folio` | Read folio/deposit summary. | Live promotion false; role-masked money values are explicitly a fail-closed gap ([definition](../../apps/server-pilot/src/hms/read-tools.ts#L457-L508)). |
| `hms_company_account_read` | Read billing summary for an exactly linked organization. | Live promotion false; arbitrary company search, credit limits, and contact reads are denied ([definition](../../apps/server-pilot/src/hms/read-tools.ts#L509-L546)). |
| `hms_group_block_read` | Read a bounded group-block summary. | Live promotion false; operational/edit surfaces are denied ([definition](../../apps/server-pilot/src/hms/read-tools.ts#L547-L592)). |
| `hms_event_read` | Read an event summary from an exact event reference. | Live promotion false ([definition](../../apps/server-pilot/src/hms/read-tools.ts#L593-L633)). |

### Separate context-read and reservationist-agent surfaces

- `hms_read_reservation` is **not** one of the eight Phase-B IDs. It is a separate reservation-context read path; its evidence has fixture and discovery digests but no `liveProofDigest`, so the context tool is not production-active ([IDs and context policy](../../apps/server-pilot/src/hms/read-tools.ts#L37-L45), [context evidence and activation test](../../apps/server-pilot/src/hms/read-tools.ts#L691-L710)). A low-level agent adapter also exposes trusted-reference wrappers for `hms_find_reservation`, `hms_read_reservation`, and `hms_quote_stay`; that is a separate interface, not additional proof of production availability ([`agent-read-tools.ts`](../../apps/server-pilot/src/hms/agent-read-tools.ts#L40-L109)).
- `hms_read_notes_traces` is included in the broader read scope and U15 context-read IDs but is outside Phase-B `READ_TOOL_IDS`; inclusion/typed worker support is not the Phase-B production-active status ([registry scopes](../../apps/server-pilot/src/hms/read-tools.ts#L37-L66)).
- The separate Mastra reservationist agent defines four higher-level tools when runners are injected: `quote_stay`, `party_lookup`, `quote_proposal_pdf`, and `create_reservation_dry_run`. Quote calls a read-only runner; party lookup returns candidates; PDF renders quoted lines; create is validation-only with `dryRun: true` and `saved: false`. With no runners the tool map is `{}` ([`reservationist-agent.ts`](../../apps/server-pilot/src/ai/reservationist-agent.ts#L108-L157)). This is distinct from the Phase-B IDs and does not establish deployed availability.
- The pane analysis adapter currently hands that agent only `quote_stay` and `party_lookup`; its PDF and create runner stubs throw/fail closed ([`agent-pane-adapter.ts`](../../apps/server-pilot/src/ai/agent-pane-adapter.ts#L136-L149)). Thus “tool exists in the agent factory” must not be paraphrased as “the pane can create bookings or generate PDFs through it.”

## Corpus evidence worth retaining

All values below are dated historical observations. They help define what to measure and what not to automate; they do **not** prove current quality, live HMS prices, or staff adoption.

### 24 Oct: six-mailbox rate-word scan (S5)

Read-only 30-day outbound window ending about 2026-10-24 14:00Z. The 3,473 messages included 1,458 “quote-like” items, but only 344/1,458 (24%) joined to a prior inbound on the thread. “Quote-like” includes body keywords, rate-looking documents, or inline room/price/stay text; confirmation letters also print rate code/nightly price and inflate BAR. These are document/word counts, not validated price answers ([scope and method](2026-10-24-multihotel-shape-S5-rate-patterns.md#L14-L24)).

| Mailbox | Quote-like | BAR | STO/net | Contract/NC | Wholesale | GOV | Airline | Promo | Corporate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Centurion | 619 | 487 | 1 | 6 | 0 | 18 | 1 | 11 | 44 |
| Da Vinci shared | 577 | 551 | 3 | 3 | 1 | 2 | 2 | 1 | 1 |
| Faith | 73 | 26 | 33 | 35 | 0 | 0 | 0 | 0 | 1 |
| Ayanda | 17 | 5 | 1 | 4 | 0 | 3 | 2 | 0 | 0 |
| Epick | 108 | 87 | 1 | 2 | 0 | 0 | 0 | 2 | 0 |
| Kmgidi | 64 | 41 | 10 | 11 | 0 | 2 | 3 | 2 | 0 |
| Total | 1,458 | 1,197 | 49 | 61 | 1 | 25 | 8 | 16 | 46 |

Rows are “docs with that word”; labels overlap and must not be summed. Faith’s STO/net and contract hits suggest a hypothesis, not an HMS strategy-code mapping. The tested sender rules were weak: GOV sender→GOV was 7/10 (tiny n); travel-agent→STO/net 17/128; named company/rate in ask→contract 10/84; company-domain→corporate 2/238. The study says sender class alone cannot safely pick rates and asks for a truth set joined to HMS rate code and bound party ([mailbox table](2026-10-24-multihotel-shape-S5-rate-patterns.md#L26-L39); [rule denominators and eval requirement](2026-10-24-multihotel-shape-S5-rate-patterns.md#L41-L74)).

### 26 Oct: outbound “human quote” bucket (R-CORPUS)

Rolling 30-day read-only production aggregate. The bucket order is disjoint but heuristic: own-mailbox sender plus HMS signature wins as HMS-auto; otherwise quote subject/filename/body signal becomes “human quote”; rest is “other.” It is not gold, not inbound demand, not accuracy, and not an adoption measure ([method](2026-10-26-r-corpus.md#L3-L19)).

| Mailbox | Outbound copies | Distinct keys | HMS-auto | “Human quote” heuristic | Other |
|---|---:|---:|---:|---:|---:|
| Da Vinci shared | 958 | 958 | 586 | 40 | 332 |
| DV-2 | 281 | 281 | 18 | 58 | 205 |
| DV-3 | 176 | 176 | 12 | 15 | 149 |
| DV-4 | 336 | 336 | 29 | 52 | 255 |
| DV-5 | 250 | 250 | 26 | 67 | 157 |
| Centurion | 1,426 | 1,414 | 635 | 237 | 554 |
| Total | 3,427 | 3,415 | 1,306 | 469 | 1,652 |

This is not a trend comparison with 24-Oct S5: the window, SQL, and bucket definitions differ. S5 measures broad “quote-like” documents/words; R-CORPUS first peels off HMS-auto and then uses a quote signal. Also, 884/1,223 confirmation-letter copies had no same-thread inbound; the join is incomplete and the report explicitly warns not to generalize from joined letters ([counts and caveats](2026-10-26-r-corpus.md#L7-L48)).

### Da Vinci rate facts: body scan vs attachment answer key

- The 24-Oct S2 body-only pass saw 1,931 Da Vinci outbound messages, 148 quote/quotation messages across 98 threads, 15 crude body candidates, and **0 validated price rows**; no extracted outbound PDF/XLSX text existed in that scan ([S2](2026-10-24-multihotel-shape-S2-dv-rates.md#L1-L20), [answer-key gate](2026-10-24-multihotel-shape-S2-dv-rates.md#L54-L79)).
- The separate S4 attachment pass scanned 150 attachments (140 PDFs, 10 XLSX), found 97 heuristic candidates, and validated 38 complete PDF rows / 27 distinct facts. All validated rows were BAR B&B; the 27 facts ranged ZAR 2,700 min, 4,071 median, 22,813 max. No named company/agency linked to a validated fact; no XLSX passed unique same-row rate binding; no live HMS rate shop was inspected. This validates a narrow BAR attachment answer key—not contract/GOV/airline mapping, current price accuracy, or a Nava replay ([S4](2026-10-24-multihotel-shape-S4-dv-answer-key.md#L1-L35)).

These two results are complementary: the earlier lane was body-only; the later one inspected attachment content and found a small validated BAR set. Neither is evidence that a current model selected the right rate.

### Other workflow evidence and denominator warnings

- In the 30-Jul–13-Oct local corpus, the L1 core cohort was 189 external non-OTA quote/booking messages out of 449 quote/booking messages; 103/189 had a reply anchor, and 39/103 linked an HMS letter within ±30 minutes of the first staff reply. Only 14/103 linked a filename-matched hand Quote PDF in that window. The broader 4,941-message external non-OTA inbound denominator includes non-stay mail and must not be used as quote-request prevalence ([L1 answer and definition](2026-10-20-arch-lanes/l1-linkage-domains.md#L3-L25), [cohort table](2026-10-20-arch-lanes/l1-linkage-domains.md#L30-L57)).
- L2’s 223 thread-level amendment candidates were 44 paid-evidence, 54 unpaid-evidence, and 125 unknown. Paid overrides a zero-deposit letter; a voucher is not cash proof; missing evidence is not unpaid. Among 74 usable prior-letter links, 14 had a same-number follow-up letter, 0 had a new-number letter, and 60 had no matching letter; absence of a letter does not prove no HMS update ([L2 answer/method](2026-10-20-arch-lanes/l2-amend-payment.md#L3-L24), [payment denominator](2026-10-20-arch-lanes/l2-amend-payment.md#L63-L104)).
- L3’s 79/3,151 detected staff clarification messages were heuristic candidates, not human labels. Payment/guarantee was tagged in 33/79. An exact-date/recipient ask→letter join covered 82/1,179 PDFs from 43 asks; no explicit Rate Code/Plan/Type label appeared in 0/1,179 letters. It found no safe basis to infer BAR/GOV or bed type from email words alone ([L3 method](2026-10-20-arch-lanes/l3-missing-info-rooms.md#L5-L23), [clarifications](2026-10-20-arch-lanes/l3-missing-info-rooms.md#L27-L45), [rate evidence](2026-10-20-arch-lanes/l3-missing-info-rooms.md#L87-L116)).
- A historical leave-one-out party-history test found agency history with support ≥1 right on 109/150, wrong on 0/150, and abstained on 41/150; at support ≥2 it was right on 95/150, wrong on 0/150. Company history for senders that never book via an agency was weaker: 27/159 right and 3/159 wrong (support ≥2: 15/159 right, 1/159 wrong). This is selective, dated history evidence—not current production auto-bind accuracy—and supports presenting candidates/abstaining over forced selection ([L0 party evidence](2026-10-20-arch-lanes/l0-known-facts.md#L74-L76)).
- Voucher evidence is also not enough to infer payment or new booking. The 19-Oct TMC scan found 15 automated `new_booking` notices; 0/15 asked staff to book/confirm, and only 6/15 carried a machine-matchable booking reference. This supports “find/check first,” not automatic booking or a payment guarantee ([TMC study](2026-10-19-tmc-voucher-notices.md#L9-L22), [unresolved evidence](2026-10-19-tmc-voucher-notices.md#L31-L35)).

## Resume checklist

1. Start with current [`PRODUCT.md`](../../PRODUCT.md), [`docs/context/START-HERE.md`](../context/START-HERE.md), and [`docs/context/ACTIVE.md`](../context/ACTIVE.md); then inspect the owner’s current ask. `START-HERE.md` is a map, not runtime truth, and older approvals do not authorize a new run ([START-HERE](../context/START-HERE.md#L1-L13); [PRODUCT authority/freshness](../../PRODUCT.md#L1-L3), [historical approvals](../../PRODUCT.md#L56-L60)).
2. For any “is tool X live?” question, re-check current registry source **and** runtime release/flags/runner wiring/property. A registry ID or agent factory is not staff adoption; owner currently says staff are not using Nava ([`PRODUCT.md`](../../PRODUCT.md#L9-L11)). Use only the authorized read-only probe for the current property before batching; this note authorizes no HMS call, write, deploy, or flag change.
3. For rate strategy, do not train from the S5 word table or sender domains. Build the owner-scoped independent outbound-grounded quote set, bind each row to the right party and authoritative HMS rate code/rate facts, separate confirmation letters from quotes, and report join coverage plus uncertainty ([S5 eval requirements](2026-10-24-multihotel-shape-S5-rate-patterns.md#L70-L74); [D19 scope](../context/DECISIONS-2026-10-20.md#L43-L46)).
4. For price correctness, identify the current authorized HMS quote path and demonstrate it with a safe current read. `hms_quote_stay` being defined is insufficient: current registry code still marks its production evidence false and says it fails closed pending a trusted current-rate reference ([tool definition](../../apps/server-pilot/src/hms/read-tools.ts#L346-L382)).
5. Re-score only on the current same-version evaluation rows and the applicable owner-confirmed bar. Keep proposal-only bars labeled; do not turn a historic sample, PDF corpus, “green” test, or deployment into a product pass ([evaluation gate](../../PRODUCT.md#L52-L60), [bar scope](../context/PRODUCT-DETAIL.md#L25-L43)).
6. Keep future notes sanitized and source-linked; refresh dated counts only if mail mix or a decision depends on them. See [`docs/research/README.md`](README.md#L82-L91) for source/freshness handling.
