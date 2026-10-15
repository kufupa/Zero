# Nava product and delivery assessment

Date: 2026-10-14. Scope: assessment, not feature implementation. Current product-code/deployed reference: `15e5bb63b`. Remote main is `00c10fd21`, which merged handoff PR 240 at 16:25Z. The requested handoff was recovered from its `3584d1592` source commit before the remote reference was checked. This worktree is parked at `3571c4dee` and lacks current context files. No merge, commit, deploy, flag flip, email send, or HMS write performed.

## 1. Verdict

The avoidable delay is a delivery-system problem: broad parallel feature creation, late integration, review churn, and weak closure on real staff outcomes. The owner's folder correction is an example: an already familiar product path was described as a new UI-reuse project when the intended change is the triage feeding it. It is not evidence that the owner needs a cleverer incantation or that typing speed is the principal constraint. Existing HMS tools are components, not completed workflows.

The product is an AI reservationist in classic Outlook and the same webmail pane. It reads actionable mail, grounds it in Infor HMS, prepares the correct quote or reservation action, and leaves consequential writes to explicit staff approval. The pane replaces repetitive navigation, not Infor as the system of record.

## 2. Requirements parsed from the voice note

New asks are recorded in `docs/context/OWNER-ASKS.md`, rows 58–70. Transcription assumptions: "hitch mess" = HMS; "site pane" = side pane; "gold outbound" = request-linked staff response and attachments. The session declares Fable 5.1, while the local gateway repurposes Fable and Sonnet slots. Actual routed provider must be checked separately from a CLI label.

| Ask | Deliverable |
|---|---|
| 58 | Recover handoff, earlier and mid-chat retros, and original-chat evidence |
| 59 | Critique owner and agent mistakes, with counterevidence |
| 60 | Full product, decision flow, and concrete completion definition |
| 61 | Current code, delivered UI, live runtime, old unresolved asks |
| 62 / 69 | Existing normal folder/mail behavior with new action triage; no UI rebuild |
| 63 | Fast correction workflow plus defensible gold labels and held-out evals |
| 64 | ROI ranking without deleting eventual features |
| 65 | Conditional ETAs, tests, and production completion evidence |
| 66 | Owner-specific prompting and agent management contract |
| 67 | Cheap model routing, direct subagents, teams, safe parallelism, spend |
| 68 | Owner/staff involvement only for domain judgment, policy, approval and adoption |
| 70 | Confirm cheap subagents: Haiku 5.5 max for code/staff; verified GPT-6 Luna route for original-chat research |

No blocking grilling session is needed to deliver this assessment. A later grill must present evidence and recommendations for real policy decisions, not ask the owner to rediscover source-code facts.

## 3. Evidence already verified

| Claim | Support | Counterevidence or limit |
|---|---|---|
| Workflow folders still use a separate desk | Current main source and live `page-TbGlXVgy.js` contains Quote Desk, Review Nava and extracted fields | A static bundle check is not an authenticated interaction test |
| Save as gold is delivered in the normal pane | Live `nava-pane-V247sRKy.js` contains Save as gold, getOwnerActionLabel and setActionLabel | Delivery does not prove a saved label, complete paired gold dataset, or model improvement |
| Website and backends respond | Admin HTTPS returns 200; on-box health on 8788 and 8789 says ok | Health is not a quote accuracy or staff-adoption test |
| Deployed checkout is current main | On-box HEAD `15e5bb63b`, observed 18:03:56Z | Process NAVA_BUILD_COMMIT labels are older; labels alone do not prove old loaded code |
| Four runtime processes are online | PM2 and actual startup-environment observation | Remote-http lacks preparation at startup and its HTTP route checks that flag; matching is worker-side, so that absence is not itself an HTTP defect |
| Production writes are not authorized by observed startup environment | RESERVATIONIST_PANE_SAVE absent on all four processes | Runtime policy must remain explicitly guarded; do not infer authorization from a tool existing |
| Historical golden action score improved | Same 26 rows: 15 correct to 24 correct, private overnight scoreboard | Create has no rows; dates are unscored; this is not end-to-end product accuracy |
| Historical classifier gate failed | Overnight adjusted medium agreement 77%, max 73.9%; medium failures 0.5%, max 7.25% | Labels were partly model-adjudicated and some disagreements parked; not a clean population estimate |
| Historical party picker avoided observed wrong binds | 95 emails, no wrong binds, auto-bind 57.9% | Below coverage target; no observed failures is not proof of no risk |
| Work was over-batched | Prior retrospective: PR 214, 58 files, 16 review rounds, 454 min against 150 min | Reviews found real bugs; the remedy is smaller changes, not ignoring serious findings |
| Staff outcomes lagged activity | Oct 13 retrospective: 143 merged PRs and about $1,142 since Oct 9, with no recorded staff quote through the pane at that audit | Historical telemetry cannot establish current adoption; native Outlook work is not the same metric |

Raw runtime observations are retained privately under `/tmp/nava-assessment-6d18957a/`. The recovered handoff, pinned product specification and agent contract are preserved there as source snapshots.

## 4. What the owner should change, and what agents owe them

| Pattern | Why it wastes time | Better contract |
|---|---|---|
| "Everything, 10/10, tonight" becomes the execution plan | No operational stop condition; breadth compounds integration risk | Preserve the full roadmap, choose one acceptance-tested workflow increment |
| New asks become invisible additions during a run | Serial review/deploy/proof tail keeps growing | Record the ask immediately, identify a sequencing trade, keep the current run frozen unless changed explicitly |
| Pressure for a shorter ETA without a changed dependency | The plan becomes more optimistic, not faster | Ask which dependency was removed and what proof changed |
| Multiple chats each act as lead | Duplicated work and conflicting state | One accountable coordinator; other chats have named files, outputs and ownership |
| Extra agents or skills substitute for ground truth | More generated output does not discover business policy | Use staff evidence and real outputs before new infrastructure |
| Owner has to remember and repeat every ask | The agent failed intake and closure | Agent parses voice notes, logs asks and marks each answered or blocked |
| Merged, deployed and healthy mean done | Staff-visible integration defects survive | Done requires last-fix proof on both surfaces and staff outcome evidence |
| Proof tools become a parallel product | Time is spent repairing the verifier rather than solving staff work | Reuse the existing harness and add only regressions that cover actual failure classes |

The owner's narrow bedtime plan was sound. The previous agent expanded it after agreeing. The overnight retrospective records no wait for the owner on its missed critical path. Voice dictation is not a defect the owner needs to stop; the agent must structure it.

## 5. Full product and acceptance architecture

Read → Prepare → Queue → Act → Review is the canonical lifecycle. Reads may run automatically. Writes require a current, explicit approval and a result review.

| Stage | Complete convenience product |
|---|---|
| Read | Correct action class from message, thread and attachments; skip automated/channel notices without skipping human agent requests |
| Prepare | Source-linked facts, uncertainty explicit, correct company/agency/account/contact distinctions, HMS lookup and rate authority |
| Queue | Background work persists while staff move between emails; status, freshness, actionable failure and retry are visible |
| Act | One primary action for the current state; quote/PDF/Excel/reply saved or inserted; approved reservation writes execute deterministically |
| Review | Actual outcome, confirmation and screenshot for writes; partial failures and unknown outcomes reconcile before retry; edits feed evals |

### Gold review is useful, but unchecked predictions are not gold

Owner clarification after initial intake: this is not a new inbox-reuse project. Restore the familiar folder/mail behavior that already existed, with different action triage behind it. Filtering is a data concern, not a reason to invent another email reader. Keep existing reply/reply-all/forward and the same Nava pane. Save corrections without losing the selected email; support keyboard-next if existing navigation permits it.

False-positive-only review estimates precision within the predicted quote folder. It cannot find quotes wrongly placed in Other, New booking or skipped mail. A defensible loop has separate development cases and a hidden test set sampled from all inbound mail. Explicitly accepted rows can be gold. Unreviewed rows remain unreviewed or weakly labeled.

Gold must have separate judgments: action class, extracted fields, party identity, dates/occupancy/rooms, historical quote/rate output, and final write outcome. A correct Quote label does not validate a wrong year or price. Link the originating request to the appropriate staff response and PDF, not any reply in a long thread. Current HMS rates can differ from historical staff prices; a comparison needs compatible timing or an explicit HMS-side explanation.

A small regression set is useful for fast iteration. It is not proof of a rare-error target. Under independent representative binary trials, zero failures in 95 trials gives a one-sided 95% upper failure bound of about 3.10%. Zero failures in 299 trials gets that bound below 1%. Correlated retries on the same email do not provide independent trials. For wrong automatic party-bind risk, the denominator must be actual automatic binds, not all emails including abstentions. Do not apply the 95-trial calculation to 95 evaluated emails unless all 95 exposed that specific risk.

### Full feature map, without silently reducing scope

| Capability | Complete behavior | Human involvement that cannot be wished away |
|---|---|---|
| Existing workflow folders | Familiar mail experience, different action triage, correct pagination and source-message selection | Owner reviews semantic labels and sees familiar behavior |
| Quote intake | Inbound + thread + PDFs, grounded dates/rooms/occupancy/contact, clear missing-info reply | Staff answer genuinely missing guest details, not retype known fields |
| Party and authority | Company, agency, account and quote contact distinct; live match facts and trace | Ambiguous match, negotiated eligibility or discount authority |
| Availability/rates | Per type/night occupancy, raw stock, applicable contract/BAR rates, full-stay restrictions and freshness | Staff choose legitimate alternatives and price exceptions |
| Quote output | Correct PDF/Excel, totals once, editable cover reply, host-integrated unsent draft/attachments | Staff approve the offer; Nava never sends independently |
| New booking | Reuse approved quote, duplicate/existing-stay guard, guarantee, deterministic create, confirmation and screenshot | Explicit production write authorization and request approval |
| Amendment | Find the right reservation, show requested-vs-booked differences, re-rate only affected fields, apply approved changes | Exceptions, authorizations, unresolved identity or guarantee changes |
| Cancellation | Distinguish request vs notice, whole vs partial/release, display status/penalty, approved action and confirmation | Cancellation rules, fee/waiver authority, bot must not accept penalty dialogs |
| Voucher/proof/billing | Distinguish booking voucher from payment proof, find stay, compare evidence, approved record/attach action | Financial policy and unresolved account/payment evidence |
| Group/multiple rooms | Room-type allocations and clear partial success, retry only after reconciliation | Already parked grouped-create policy remains until explicitly reprioritized |
| Background and recovery | Read while staff move on, prioritized queue, honest status, freshness and actionable retry | Humans only for policy/uncertainty, not silent infrastructure failures |
| Next hotel | Mailbox access, tenant separation, per-hotel config/rates/options/PDF branding, onboarding and runtime proof | Property access, rate/policy validation and actual staff adoption |

OTA booking operations remain outside the current agreed email-only product. Recognize the channel and show existing-stay provenance; do not turn OTA notices into new create work. Payment/voucher and group/event stay on the full roadmap after the core workflows, not silently deleted because sequencing is quote-first.

"One click" means one approval when facts and authority are already known. It does not mean invent dates, silently bind an ambiguous company, suppress staff options, or bypass a penalty decision. Missing information should become a specific prepared request, not an unusable generic blocked screen.

### Company completion is broader than software completion

A credible company needs staff adoption, measured saved handling time, trusted results, recoverable operations, repeatable onboarding to another hotel, configuration rather than client-specific forks, support ownership and viable costs. Code completion alone cannot establish willingness to pay, retention or profitable scaling. No honest ETA can promise those outcomes without observing the customer.

### Model and parallelism contract

| Job | Model/routing | Why |
|---|---|---|
| Product decisions, coordination and critical final judgment | Intended lead: Opus 5.5; this session declares Fable 5.1 | Keep decision context focused; do not pay the lead to repeatedly digest raw corpora |
| Large local transcript/corpus reading and bounded implementation | GPT-6 Luna through the existing local gateway | Cheap volume; direct subagent was exercised in this assessment, without Codex |
| Independent scoped review and staff-evidence reading | Fresh Haiku 5.5 at max effort | Bound the brief, not an unenforceable hard context limit; budget for the higher pricing tier when it occurs |
| Hard disputed reasoning | GPT-6.1 Sol or lead escalation | Escalate on an actual failed check or contested decision, not by default |
| Live HMS and consequential runtime operations | One authorized lead | Single browser lock and real-user boundaries remain serial |

The existing launcher maps Sonnet's CLI slot to Luna and Fable's slot to Sol. These are aliases, not those Claude models. The session transcript itself labels the lead Fable, while gateway request logs show the Fable route forwarding to Sol. Treat this as a routing/accounting mismatch to make explicit, not proof from the UI label alone. No provider configuration was changed in this assessment.

Use direct subagents for independent evidence/review work. Use a persistent team only where ongoing communication or shared ownership buys something measurable. Do not migrate a working coding harness just for novelty. Current evidence establishes that the gateway serves requests, not that every team's retry, timeout, reboot and model-identity path is fully proven.

Parallelize corpus labeling, error clustering, independent review and non-overlapping fixture tests. Keep shared pane edits, evolving data contracts, full memory-heavy checks and live HMS serialized. There is no arbitrary total-writer cap; there is a concrete ownership rule and a dependency graph. The full roadmap can remain broad while the current workflow has one accountable owner.

Track $ per correctly completed slice, minutes of rework, and latency until the user sees a verified result. The owner declined a hard budget cap. Do not reinstall one through a retro recommendation. Cost-aware routing and stalled-work cutoffs can operate without a spend ceiling.

### What already worked

- The agent stack produced real-mail action-score improvements and an observed zero-wrong-bind party test. Safety and review gates prevented promotion of a failed classifier.
- The owner supplied useful rate, channel, cancellation and staff-UI distinctions, challenged weak corpus labels and an untested party-index proposal, and chose a narrow overnight plan.
- Small current changes shipped: room-type resolution, fallback reply handling, nightly facts, party-first pane ordering and a persistent owner action-label control.
- Existing local checks and one-browser ownership are assets. Replacing them with another harness would be a new project, not automatically an acceleration.
- The desired product architecture is already largely correct: action-specific deterministic workflows, grounded reads, approval-gated writes and shared staff surfaces. The missing work is reliable connection and acceptance, not a wholesale rewrite.

### Source contradictions worth keeping

- The early retro says eval/telemetry measured nothing; that is too broad. Real-mail action and party tests already produced useful signal. The problem was incomplete outcome coverage and gold provenance, not evaluation itself.
- An older nightly note recommends frequent keepalive pings. Current session rules and later retro reject that with the configured one-hour cache. No ping loop is justified.
- A raw research lane says changing the golden-set denominator invalidated progress. The pinned final scoreboard re-scores both versions on the same final rows, making its narrow action comparison fair. It still leaves create and dates uncovered.
- "No recorded staff action" is not "no staff work." Native Outlook work and missing telemetry remain plausible alternatives. Fresh adoption is unresolved here.
- Nightly room stock is not proof that a requested stay is bookable. Eligibility and minimum/maximum stay rules need separate checks.

## 6. Independent staff, engineering and original-chat findings

### Original-chat verification

The prior lead is `/home/orca/.claude/projects/-home-ubuntu-projects-zero--worktrees-centurion-dashboard-tools/33440ce7-6408-4198-a86f-61e722850de8.jsonl`, active 08:56–17:52Z. The handoff at 16:25Z was a checkpoint, not the end of the chat. The first worker report accidentally identified this assessment session instead; that pointer was rejected and corrected before final synthesis.

| Original passage | What it establishes |
|---|---|
| Prior transcript line 740, 09:48Z | Assistant admitted the owner's narrow plan was right and the assistant talked them out of it |
| Prior transcript line 2400, 13:14Z | Staff liked the overall walkthrough but specifically asked for less repetition, raw availability, full room options, obvious clickable controls and lookup visibility |
| Prior transcript line 4185, 16:08Z | Historical gateway alias/timeout limitations were already known; this assessment checks newer runtime independently |
| Prior transcript line 4334, 16:25Z | The custom workflow desk persisted after the removal PR, so familiar folder behavior was still open |
| Original evening extract lines 681–747 and 829–835 | Owner correctly challenged an untested party-index proposal; assistant admitted evidence gathering should have preceded the recommendation |
| Original evening extract lines 939–940 and 994–1001 | Owner asked for ROI ranking and reuse of old evidence; the assistant later reported unused gold sets |

The correct lesson is shared scope control plus accountable execution, not blaming voice notes or requiring the owner to become a full-time agent supervisor. Underlying historical corpus and cost figures remain report-derived, not newly billing-audited.

### Returned staff evidence

The staff-call notes were read. Their wording is transcription-noisy and their exact dates are not fully established. Their code references and older research reports were not accepted as proof of current implementation.

| Staff need | Direct source | Product consequence |
|---|---|---|
| Booker/contact is distinct from company | `bongi UI call transcript.md:193–201` | Matching a company is not enough; keep quote contact visible and correct in the PDF |
| Mixed room types and occupancy | `bongi UI call transcript.md:397–413` | Preserve legitimate room-type/count choices; do not infer a room split from headcount |
| Special/event rates and authorized overrides | `bongi UI call transcript.md:245–317`; `davinci kickoff.md:705–737` | HMS is not the only valid rate authority; show origin and required authorization for staff exceptions |
| PDF/Excel layout and editable lines | `bongi UI call transcript.md:341–373,493` | Documents and unsent reply are part of the workflow, not a detached download-only product |
| All booking work inside Outlook eventually | `davinci kickoff.md:729–737` | Remove repetitive Infor navigation while preserving staff options and approval boundaries |

Earlier walkthrough feedback does not prove current production adoption. Existing recorded policies already say amendment scope follows guest requests supported by staff outbound. Do not re-ask the owner to invent a field list. Cancellation/fee authority and production-write approval remain real unresolved holds.

### Current-code findings verified by the lead

| Finding | Verified source | Concrete impact |
|---|---|---|
| Current workflow routes still choose the special desk | `apps/mail/components/mail/mail.tsx:368–371` | The owner wants the familiar earlier folder/mail experience with new triage, not permission to keep a custom review desk |
| Gold save persists an owner action label only | `apps/server-pilot/src/trpc/routes/workflow-folders.ts:110–152` | A saved correction is durable, but does not by itself repair live membership |
| Live membership does not consult that owner label | `apps/server-pilot/src/mail/workflow-folders.ts:314–345,412–455` | Correcting a Quote false positive can save successfully while the message remains in Quotes |
| Workflow rows require successful extraction | Same query, `:436–444` | Unprocessed/failed-extraction mail can disappear from the action-folder view; folder-only review misses that blind spot |
| Gold selection can switch the pane to Quote/New booking | `apps/mail/components/quote-workflow/workflow-gold-label.tsx:66–72` | Do not claim corrections have no UI effect; pane/session behavior and folder membership are different layers |
| Gold is currently deliberately enabled for the normal webmail pane | `apps/mail/components/mail/mail.tsx:748–753`; `apps/mail/components/nava-pane/nava-pane.tsx:250–260,1931` | This is an owner-labeling control, not proof of both-surface quote-feature parity or an automatic requirement to put owner tools in staff Outlook |
| Amendment prepares a diff but does not save | `apps/server-pilot/src/ai/pane-hms-write.ts:230–260` | Amendment is a real implementation gap, not just a hidden enabled flag |
| Cancellation preview is disabled in the pane | `apps/mail/components/quote-workflow/amend-lookup-panel.tsx:175–180` | An existing server tool is not a usable live cancellation workflow |
| Create is explicitly off unless lab/on selected | `apps/server-pilot/src/ai/pane-stay-save.ts:134–176` | Production cannot be called complete before authority and safe write proof; current path also refuses child-age cases |
| Nightly raw stock can be available under full-stay restrictions | `apps/server-pilot/src/ai/hms-availability.ts:247–280` vs `tooling/playwright-quote/fetch-quote.mjs:489–501` | Display stock as stock; do not infer bookability without the full-stay check |
| Prepared-quote access checks the preparation flag in HTTP | `apps/server-pilot/src/trpc/routes/workstation.ts:555–561` | Actual missing remote-http startup flag can block consumption of a system-prepared quote |

The remaining worker summaries were independently checked before use. Rejected claims: the owner approved keeping the custom desk; all channel skips were missing; no create/cancel code existed; every write route should be owner-only; generic grep absence proved no behavior. Current source rules explicitly include Tiket, Profitroom contact-form exemptions and H-Pay payment-link-only filtering. The ingest and HMS paths call that policy. Staff approvals and mailbox authorization need service-level tracing, not a blanket owner-only restriction.

The eval compares versioned model/agent/owner label rows, not the live folder query. Its metric needs a clear link to the actual production prediction being graded. No reliable zero-live-writer claim is made from a search absence. Several old categories, extraction kinds and action labels coexist; use the requested action semantics as the authoritative user-facing meaning instead of asking the owner to choose between internal taxonomies.

### Runtime interpretation settled

No runtime dotenv loading was found in current server source. The actual startup environment lacks `HMS_QUOTE_PREPARE` on remote-http, and a prepared-quote HTTP route checks it. This is a source-backed parity gap. `PARTY_MATCH_V2` is worker-side, so its absence on remote-http is not the same defect. Older build-stamp values still do not prove stale loaded code.

Both independent reports returned. One redundant auto-resume was stopped after its report arrived because queued instructions were being delivered late. No required evidence was discarded.

## 7. Delivery plan, conditional timing and owner touchpoints

### ROI and sequencing

| Order | Work | Why this order | Completion evidence |
|---|---|---|---|
| 1 | Existing folder/mail path fed by one action triage, with explicit owner correction reflected consistently | Makes labeling useful and reveals no-extraction/misrouted mail; no new UI components | Correct label, folder and pane on reopen; all-inbound visibility; real router and both relevant layouts |
| 2 | Replay and score actual routing against request-linked owner/staff labels | A new classifier is useless if the score grades a different stored artifact | Held-out all-inbound agreement/recall and failure rates; no silently skipped real asks |
| 3 | Date/year guard, quote stock-vs-bookability, prepared-quote webmail parity | Prevents high-trust quote errors before more visual polish | Received-time date regressions, full-stay restriction test, last-fix prepared-quote use |
| 4 | Finish party/rate authority and room-night quote card, documents and unsent reply | Closes the first complete staff workflow | Supported price/rate plan, correct contact/dates/counts, real staff completes a quote without developer guidance |
| 5 | Create, then amend, then cancellation | Existing components are not approved, reconciled production workflows | Authorized request, correct actual HMS result, screenshot, duplicate/unknown-outcome handling |
| 6 | Payment/voucher/billing, grouped rooms, next-hotel onboarding | Preserve eventual completeness without parallelizing every write policy | Separate financial evidence, partial success, property-specific config and real new-hotel proof |

The full roadmap is retained. Sequencing is not deleting features. Grouped create remains explicitly parked by the earlier owner decision until reprioritized. A per-feature case-mix check can change sequencing, not erase the promised roadmap silently.

### Conditional planning budgets, not guaranteed delivery dates

These are whole-chain budgets including implementation, local tests/review, deployment and live proof. They assume reuse of existing components and no new integration platform. Global orchestration median is 1.04 from the ledger; raw ranges include integration allowance. Recent comparable overruns justify broad ranges rather than blindly applying fast code-only or lab-proof medians.

| Milestone | Raw whole-chain budget, min | Ledger-scaled budget, min | Precision / external holds |
|---|---|---|---|
| Familiar folders + different triage + correction loop | 150–240 | 156–250, displayed roughly 160–250 | Highest confidence; not merely the owner-label join by itself |
| Complete quote convenience and initial proof set | 450–900 | 468–936, displayed roughly 470–940 | Rate-authority validation, current HMS availability, accuracy may require iteration |
| Quote/create/amend/cancel core | 1,500–3,000 | 1,560–3,120, displayed roughly 1,600–3,100 | Coarse; write authorization, cancellation policy, authorized test cases and staff availability excluded |
| Full stated email roadmap including voucher/payment-proof/billing, grouped rooms and next hotel | 3,000–6,000 | 3,120–6,240, displayed roughly 3,100–6,200 | Lowest confidence; assumes evidence capture/approved attach/billing tasks, not a new settlement/refund platform; next-hotel access/policies can dominate elapsed time |
| A repeatable, adopted, commercially successful company | No fixed software-only deadline | Not estimable from this code audit | Requires observed adoption, time saved, retention, viable costs and repeatable onboarding |

Milestones are cumulative alternatives, not values to add. The budgets are planning estimates, not commitments to make the product 10/10 tonight. Accuracy gates may fail and require another iteration. Live-user and business-policy holds are outside active engineering minutes and must not be hidden in a optimistic deadline.

The narrow data-only owner-label join is smaller than the first milestone: worker estimated 30–45 code/test minutes. That does not include replacing the custom route with existing normal folder behavior, covering no-extraction mail, review, deployment or actual proof. Do not sell a code-only estimate as user-visible completion.

### Better session and worker discipline

Read the entry brief and mandatory rules, refresh relevant deltas, then discuss the slice immediately. Bulk transcript/corpus reading goes to Luna. Haiku max is for bounded review, not a broad entire-product source sweep. No hard context or spend cap is invented. Use a measurable stopping condition, wait on completion notifications, and keep future handoffs small.

This assessment repeated part of the delivery problem: the two cheap Haiku reads took over forty minutes and returned mixed current/stale claims. They were cheap, but slow. The lead should have bounded their scope more sharply, used Luna for bulk reading, and discussed settled product direction while verification finished. The owner clarified their status question was not impatience; the research cutoff was the lead's scope decision, not the owner's approval to shrink the deliverable.

## 8. Practical test and evaluation plan

| Layer | Smallest useful test | Completion evidence |
|---|---|---|
| Routing and labels | Real router adapter: folder select, second-email select, save label, reopen, mailbox switch, pagination | Same normal inbox and pane; correct persisted label and source message; no selection race |
| Front door | Human agency request vs automated vendor notice; own-mail pre-stay vs new booking | No human quote/create request silently skipped; no false create from pre-stay |
| Extraction | Relative dates anchored to received time; year-boundary examples; follow-ups and PDFs; occupancy/count unknowns | Source-grounded fields, explicit uncertainty, no fabricated rooms/year/company |
| Party matching | Hidden HMS answer-key rows with aliases, names, no-match and ambiguity | Zero observed wrong auto-binds; separately measured coverage and candidate recall |
| Quote | Room type × occupied night × occupancy × chosen party/rate authority × meal/tax/currency | Stock is not confused with bookability; restrictions honored; supported price/PDF/reply match |
| Queue | Concurrent mail arrival, staff-priority work, retries, failed jobs, stale facts, browser lock | No duplicate or lost work, no stale approval reuse, no silent stuck state |
| Reservation writes | Disposable fixture/test guest with explicit authority; duplicate create; amend diff; penalty decline; uncertain outcome | Correct reservation, approval boundary, actual HMS post-state and screenshot; no blind retry |
| Both surfaces | Real browser plus Outlook-hosted pane, last deployed bundle loaded | Shared features behave identically; host-specific insert/save and auth paths also work |
| Staff outcome | Staff runs representative live work without developer guidance | Actual adoption, less handling time and no extra cleanup hidden outside Nava |

Existing PRODUCT.md bars are proposed targets, not population-level guarantees. Do not use one overall action score as a proxy for every layer. A system can classify Quote correctly while producing an unusable or unsafe quote.

A development set should be split by conversation and period from the hidden test set. Fix known errors on development cases. Measure generalization on withheld all-inbound cases. Replays of the same messages assess stochastic stability, not broader case coverage. Prefer deterministic graders for dates, numbers, authorization and final HMS state; validate judgment-based graders against human labels.

Native Outlook is not an optional afterthought: webmail browser tests cannot prove add-in authentication, selection messaging or attachment insertion. A correct reusable web component still needs host-level proof.

The company metric is saved staff time per correctly completed eligible request, not number of PRs, classifier agreement alone, or a vendor's advertised resolution rate. Track eligibility, correct preparation, successful staff completion and time saved separately.

### Where the owner is needed

| Stage | Agent can do autonomously | Owner/staff contribution |
|---|---|---|
| Intake and scope | Read context, parse voice notes, inspect runtime, propose the acceptance check | State the intended result and resolve genuine goal conflicts |
| Label/eval setup | Assemble request-linked evidence, sample all inbound, mask/organize cases, propose labels, calculate disagreement | Mark ambiguous cases and calibrate the definition of a correct result |
| Engineering | Diagnose, code, local tests, independent review, allowed merge gates | No code-management work required |
| UI completion | Restore familiar folder behavior and existing options; run real-browser checks | Brief taste/task-completion check, not design every component |
| Quote grounding | Read HMS, show trace, compare fact versions, check prices and restrictions | Staff resolves missing requirements and actual rate exceptions |
| Create/amend/cancel | Build preparation and guarded deterministic tools; prove with authorized test cases | Hotel-approved write authority, cancellation/fee rules, real request approval |
| Operational rollout | Batch allowed changes, record last-good revision, verify processes and both surfaces | Warn before live-user changes; owner approves outside existing authority |
| Adoption and next hotel | Gather event/timing evidence, package repeatable onboarding, expose failures | Real staff uses it; hotel supplies access and confirms local policies |

The owner is not the missing project manager for every code slice. They are the quality/policy authority. The agent owes them complete options, a recommendation and the cost of waiting only when a decision is actually theirs. "I don't know" on an Infor implementation detail sends the agent back to evidence, not into another quiz.

## 9. Sources

- Requested handoff: `git show 3584d1592:docs/context/HANDOFF-2026-10-14-fresh.md`.
- Product: [pinned specification](https://github.com/kufupa/Zero/blob/15e5bb63b/PRODUCT.md).
- Delivery rules: [pinned agent contract](https://github.com/kufupa/Zero/blob/15e5bb63b/AGENTS.md).
- [Five-day retrospective](/home/orca/retros/2026-10-13-five-day-retro.md).
- [Overnight retrospective](/home/orca/retros/2026-10-14-overnight-retro.md).
- [Original evening chat extract](/home/orca/nava-research/reports/retro-20261014/w1-evening.md).
- [Historical scoreboard](/home/orca/nava-research/reports/SCOREBOARD-2026-10-14.md).
- [Small batches, DORA](https://dora.dev/capabilities/working-in-small-batches/).
- [2026 productivity study limitations, METR](https://metr.org/blog/2026-02-24-uplift-update/).
- [Agent evals, Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
- [Evaluation best practices, OpenAI](https://developers.openai.com/api/docs/guides/evaluation-best-practices).
- [Human error analysis, Hamel Husain and Shreya Shankar](https://hamel.dev/blog/posts/evals-faq/).
- [Multi-agent research tradeoffs, Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system).
- [Binary performance threshold testing, NIST](https://www.nist.gov/publications/confirming-performance-threshold-binary-experimental-response).
- [Release governance, Sierra](https://sierra.ai/blog/release-governance-guardrails-for-agents-at-scale).
- [Structured human handoff, Intercom](https://www.intercom.com/learning-center/ai-human-collaboration-procedures-handoffs).

Research route: local source/history/runtime plus Exa basic and bounded Haiku/Luna subagents. Vendor sources describe practices, not independent proof of Nava ROI. No new tools or memory platforms were installed.

## 10. Legacy asks still not marked done at the recovered handoff

These are ledger statuses, not a fresh proof of each item's current implementation. The assessment resolves teaching and scoping questions separately from building features. Duplicated or stale statuses must not quietly disappear.

| # | Original ask | Recorded status | Prior answer | Recorded next step |
|---|---|---|---|---|
| 7 | Full TODO | 🟡 | retro §12 | This file replaces it as the live list |
| 9 | How do I become a 10x / 100x dev? | 🟡 | retro §10 was generic | §4 below is owner-specific |
| 12 | `/95-exa-agent` on that message | 🟡 | Missed at first; ran later on the memory question | Treat any `/95…` as "run it now" (memory saved) |
| 14 | Hindsight vs gbrain / mem0 / Zep / Tencent | 🟡 | Researched (`plan-20261014/r-meta.out`) but **never put to you as a decision** | §5 below: decision proposed |
| 19 | Plan the full one-click product (quote, create, amend, cancel, payment) | 🟡 | `docs/plans/2026-10-14-002-one-click-case-card-plan.md` | C1/C3/I1 building; see #34 |
| 20 | Teach me AI coding: sessions, handoffs, parallelism, agent teams, Sol, Wayfinder | 🟡 | Sol price and Wayfinder (skip) noted in chat only | §4 below |
| 23 | Local CI/CD with shared state, no GitHub Actions | 🟡 | PR #230 (Greptile P1s fixed) | Merge; status posting needs owner OK (#25) |
| 24 | Is "use exa and research" enough? What access can I give you? | 🟡 | r-meta: a prompt alone isn't enforcement | §4 habit 8 |
| 25 | Why is the merge gate slow? Speed it up | 🟡 | r-meta: local status + `gate.sh` → auto-merge | **Decision needed:** required status `local-ci/presubmit` (it's a GitHub check) |
| 26 | Save the research for future sessions | 🟡 | Private: `/home/orca/nava-research/reports/plan-20261014/`. Repo: this file | — |
| 27 | One-click = hierarchical: party/rates before stay, prices + availability per room type; replace Infor | 🟡 | Plan §1 decision order | Validate the order with staff (#34) |
| 28 | No budget cap, but track spend; cheapest and fastest | 🟡 | Cost in the retro only | Add a per-run $ line to every handoff |
| 29 | Outbound + no-reply are strong label signals; I'll label manually too | 🟡 | Same-thread outbound: 401/5,371 threads. No-reply isn't a safe label: no reply headers in the snapshot, and recent mail may still get a reply | You label in nava-admin once F3 ships (#229 merged) |
| 35 | Find + install forward-deployed / product-design / UX skills (proven, high stars) | 🟡 | Impeccable installed 2026-10-14; gstack + superpowers already installed; no proven FDE skill exists | Optional: ui-ux-pro-max (135k★) |
| 36 | Which skills are installed vs actually used? | 🟡 | §6 | — |
| 38 | C7 decision (grouped create, partial failure) | ⏸ | §2 | Deferred: low ROI now |
| 41 | Highest ROI: classifier coverage + quote UI | ⬜ | — | After the demo: classifier labels (F3) + C1/C5 |
| 42 | Use the ~2 h HMS-down window well | 🟡 | Offline slices C1, C3, I1 running | — |
| 46 | Use Stagehand to diagnose failed creates | ⏸ | Parked with C7 | Revisit when C7 is unparked |
| 48 | Staff feedback: less repetition (quote documents), merge Stay + Rates, raw availability not "Free", full room-type dropdown, make clickable things obvious | 🟡 | Demo v8 on hermes | Build into the live pane (C5 + C1 follow-up) |
| 49 | Never remove options staff have in Infor; pre-fill, don't restrict | ⬜ | Principle | Add to PRODUCT.md hard rules |
| 50 | Owner unsure the party lookup actually ran | 🟡 | Demo shows the HMS search trace | Show the lookup trace (query, matches, pick) in the live pane |
| 51 | nava-admin = production version of the hermes demo design | ⬜ | — | Plan slices after the retro |
| 56 | Owner will share the client-call recording | ⬜ | — | Waiting on owner (transcript or audio file) |
| 57 | Owner can give classification feedback now | ⬜ | Review set live in nava-admin (#233/#234) | Owner labels; agent scores classifier on labels |

### Proposed single-slice prompt

```text
Outcome: existing folders keep their normal mail behavior, with the new action triage feeding them.
Preserve the same mail list, reader, reply actions and Nava pane with Save as gold.
Read PRODUCT.md, the current asks ledger and latest deployed revision first.
Baseline the current behavior and write the acceptance check before editing.
One writer owns the mail routing and shared list files. Independent review owns tests.
Do not add another review UI, classifier, memory tool or agent framework.
Do not treat unlabeled rows as gold. Preserve false-negative sampling outside Quotes.
Finish with local checks, adjudicated review and real-browser proof after deployment.
Report baseline, changed behavior, actual proof, remaining failures, ETA drift and $ by model.
Escalate only missing business policy, write authorization or a genuine scope trade.
```

This is a prompt example, not authorization to execute or deploy this slice in the assessment turn.

### Avoid repeating startup research

Enough context now to establish product direction and the next slice. Current source-backed readiness for every workflow is a separate question; the two remaining verification workers do not need to block product discussion. This was a requested deep retro plus stale-checkout recovery, not the recommended ordinary startup.

A compact [session-entry brief](../context/SESSION-ENTRY-2026-10-14.md) captures settled scope, owner corrections, exact source references, last checked runtime state and unresolved gaps. At startup, batch-read required rules and that brief, inspect changes since its revision, and investigate only gaps that change the current action. Raw transcripts are for a contradiction or newly requested retro, not routine rediscovery. Price/inventory facts and policy authorization must still be refreshed.

The brief is local and uncommitted. Passing its absolute path works for this workspace; guaranteed automatic discovery across fresh worktrees requires a canonical repository placement and proper startup instructions. No hooks, settings or memory platform were added in this assessment.

## 11. Final evidence threshold

The process diagnosis, familiar-folder requirement, gold-routing disconnect, extraction-only visibility, amendment stub, disabled pane cancellation and prepared-quote parity gap are supported by current source/runtime and contradiction checks. The complete-product readiness threshold is not met: prices across representative requests, authorized writes, current adoption and next-hotel readiness remain unproven. This assessment is complete; those product gates are not. No tests or production writes were run for this audit.

## 12. Cost and completion record

Gateway same-time-window estimates, not a provider invoice or exact session attribution. Lead transcript declares Fable; configured/logged Fable-slot route is Sol. No actual Sonnet or expensive lead-model subagents were used.

| Routed model | API-rate estimate, $ | Role in this investigation |
|---|---:|---|
| azure_ai/claude-haiku-5-5 | 0.82 | Two staff/code evidence workers |
| openai/gpt-6.1-sol | 3.54 | Gateway lead-slot route |
| openai/gpt-6-luna | 0.11 | Original-chat/retro worker |

Exa cost was not exposed by search tool responses, so no dollar total including web research is invented. Full reports and the short session-entry brief remain local/uncommitted. No commit, push, deploy, feature edit, email send, HMS write, new check/workflow, hook or memory platform was performed.
