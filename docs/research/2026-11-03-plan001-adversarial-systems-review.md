# Plan001 adversarial systems review

**Verdict: preserve rewritten Cloud tools; change the delivery contract around them. Plan001 produced useful code, but its delivery forecast outran connected-path evidence. The next critical milestone should be one general Cloud Create through selected email → staff Go → native Save → fresh readback.**

Reviewed 2026-11-03. This is an engineering review and proposed execution budget, not an implementation launch or live-write authorization.

## 1. Evidence, versions and confidence

| Claim | Status | Evidence | Counterevidence / limit |
|---|---|---|---|
| Plan001 missed its complete pilot outcome | **Supported** | [Cutoff record](../research/halloween/2026-11-02-llm-retro/2026-11-03-next-pilot-planning-notes.md#1229-utc-cutoff-handoff): 550 wall minutes, three write-lane merges, no deployed pane-Go write/readback | Useful native reads, standalone Create and deployment did happen. This was partial delivery. |
| Removing test/review gates alone would have finished it | **Unsupported** | Missing connected proof, native Track/party defects, lost-lock race and Amend second-Save defect persisted | Gates caused documented holds. Exact time attributable to each cause is unmeasured. |
| All concerns refer to legacy HMS tools | **False** | Amend defect is in new `hms-cloud/pane-amend-session.mjs`, PR #987 at `19c0cf18` | Some current quote and fallback operation paths still use the earlier adapter set. Keep these categories separate. |
| New Cloud tools are generally reusable today | **Partly supported** | Native lookup, staging, picker and request-fence mechanics exist | Several new Cloud Save/readback contracts still enforce Labtest identity and no-send assumptions. |
| Quote preparation becomes universally ready by enabling one flag | **False as a readiness claim** | Shared scheduler also depends on queue/admission/config/capacity; installed quote provider remains the earlier native adapter | Background preparation already exists. Its presence is valuable; it is not a measured readiness guarantee. |
| A confident whole-pilot completion ETA can be inferred | **Unresolved** | No successful comparable general Create/Filing/full-Amend delivery cycle with complete integration/proof timing | PR lifetimes and LOC cannot supply the missing upper bound. Section 10 gives a finite execution budget and calibration rules. |

**Method.** Read the recovered review transcript in full across the research team, the latest handoff, plans 001/002, current instructions, relevant source and saved runtime artifacts. Three independent `gpt-6-luna` max agents audited execution drift, Create/Filing/Multi-room, and harness/locks. Coordinator independently checked decisive source paths, installed quote-provider selection, #987 metadata/comments, native second-Save matching, background scheduling and saved deployment evidence.

**Pinned versions.** Shared root is `6bb282ae7f40359d07e4f4fef14068dae78f1a17`, behind the inspected `origin/main` at `0da451edd5cbc6188d45fb05e619d5e2e12c97e0`. Relevant Cloud source findings use the latter. New Cloud Amend #987 remains open at `19c0cf1860bc11fadc138f779a1fe5dc20c2d156`. Root contains unrelated dirty/untracked work; it was preserved. The generic plan and isolated process patch are proposals, not shipped implementation.

**Primary inputs.** [Recovered transcript](/tmp/zero-plan001-review-audit/plan001-review-extracted.md:1) contains 18 prompts, 24 saved assistant messages and 10 CLI commands. Its header explicitly excludes reasoning/tool traces. Recovered the named Claude chat `plan001 retro n speed plan`, session `d1a2e868-b49a-44f6-95e8-9ae3776dce65`; [visible-message extraction](/tmp/zero-plan001-review-audit/latest-claude-extracted.md:1) retains raw-line locators. Its last extracted owner request asks for a grounded critical-path range; no completed response to that request appeared in that extraction.

**Proof limits.** No new HMS browser operation, production write, flag change, deployment, database-backed test, typecheck or app test ran in this review. Saved runtime evidence is a dated observation around 12:29 UTC, not a fresh live-runtime inspection. GitHub metadata was read during this review. Compliance/storage/LLM permissions are accepted as supplied operating premises; credentials were not needed for the analysis.

**95 threshold:** met for schedule failure, code-supported second-Save defect, installed-provider distinction and proof boundaries. Not met for exact causal time allocation, current live readiness, complete Outlook behavior, whole-pilot ETA or ROI. Missing evidence is named rather than converted into confidence percentages.

## 2. Separate the rewritten Cloud set from earlier operations

| Layer | Actual inspected path | Meaning |
|---|---|---|
| **New modular Cloud Create** | `hms-cloud/create-reservation.mjs` → booking/saved-stay sessions → native guarded Save/readback | Audit its own contract. Do not substitute an old `create-lab-stay.mjs` finding. |
| **New connected Cloud Create** | Shared booking pane → Cloud preview/approval/runner modules → new modular Create | Connection and durable authority introduce work beyond a standalone native tool. |
| **New connected Cloud Filing** | Filing source/approval → `pane-hms-write.ts` Cloud runner → `hms-cloud/pane-attach-session.mjs` | Earlier attach CLI also exists in the same backend file; selecting the actual branch matters. |
| **New Cloud Amend candidate** | #987 `pane-cloud-amend.ts` / runner → `hms-cloud/pane-amend-session.mjs` | Second-Save P1 belongs here. It is not on the inspected deployed main. |
| **Installed Quote provider** | `workstation.executeStaffQuote` → `staff-quote-run.ts` → `staff-quote-installation.ts` → `createExistingOwnerNativeQuoteReader` → `playwright-quote/fetch-quote.mjs` | Current mounted quote integration uses the earlier native adapter. |
| **New modular Cloud Quote** | `hms-cloud/quote-read.mjs` → `hotel-availability.mjs` → bounded quote view | Exists separately. Its presence does not prove mounted quote uses it. |
| **Shared infrastructure** | Mail/extraction/work-item identity, queue, approvals, events, PM2, checks | These remain relevant whichever native adapter runs. They are not defects inside every new Cloud tool. |

Quote caller evidence: [installed service factory](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/src/ai/staff-quote-installation.ts#L501), [native factory binding](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/src/ai/staff-quote-installation.ts#L535), [selected executable](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/src/ai/reservationist-evaluation-composition.ts#L240), [new Cloud quote](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/tooling/hms-cloud/quote-read.mjs#L8).

**Owner's rewrite rationale holds:** general deterministic Cloud tools avoid repeated integration into an oversized earlier operation stack. The remaining architecture task is a thin, verified adapter into the existing pane and business contracts. Rebuilding the pane, mail ingestion or quote document generation would add another migration.

An import from `tooling/playwright-quote/` is not sufficient to classify an operation as legacy: new Cloud tools reuse browser/session helpers from that directory. Classify by entry point, executed operation and native endpoint. Preserve a working installed quote while explicitly deciding its Cloud cutover; avoid claiming the cutover already happened.

## 3. Execution drift: the forecast failed before the code did

| Plan001 checkpoint, from 03:20 UTC | Evidence-backed outcome |
|---|---|
| 60 min / 04:20 | Source/Filing read-preview progress; no complete write workflow |
| 120 min / 05:20 | No complete deployed workflow or connected Labtest write proof |
| 180 min / 06:20 | Amend remained read-only; no connected Save proof |
| 240 min / 07:20 | Create remained oversized/unmerged; original completion target missed |
| 360 min / 09:20 | Standalone native Create had succeeded at 08:20; selected email → staff Go had not |
| 550 min / 12:30 | Create/Filing/Multi-room merged; Amend held; write workers off; no deployed pane-write canaries |

Sources and individual checkpoint locators: [independent run audit](/tmp/zero-plan001-review-audit/adversarial-run-drift.md:1). The elapsed 550 minutes is **2.29× the 240-minute target** and **1.53× the original 360-minute cap**. The owner extended the deadline; this is not evidence of unauthorized execution beyond an unchanged stop.

There are two different failure histories:

- **K-chain:** historical baseline criticism concerns bottom-up helpers, small PRs, stacked branches and old mounted operation paths. The reported 76% dormant share was not reproduced here and has inconsistent numerators in the recovered review. Do not carry it into a claim about current Cloud tools.
- **Plan001:** its revised plan explicitly adopted outside-in Cloud slices and local targeted tests. It still discovered major authority, source, native-request, lock-loss, drain and proof requirements during delivery. Saying “wire the existing tools” did not price those seams or supply a ready driver.

The prior reviewer promised roughly 705 product lines and 3.5–4.5 hours, later asserted an ~85% chance of completion, and described a genuine pre-claim lock-loss issue as theoretical. These were uncalibrated claims. The [new handoff](../context/HANDOFF-2026-11-03-general-cloud-pilot.md) appropriately withdraws optimistic sizing, separates source from live evidence, and preserves valid P1s. Its remaining weakness is incomplete executable calibration, particularly quote/provider integration and final proof.

### Real debt versus low-value churn

| Work | Classification | Action |
|---|---|---|
| Exact selected message/attachment/guest binding | Necessary cross-system contract | Keep; use one canonical representation |
| Native Track selection, parties, prices and Save payload matching | Real operational defects | Reproduce on new Cloud adapter; fix |
| Lost-lock preimage race, one-use approval, uncertain outcome | Real write correctness | Keep a minimal durable protocol; include every writer |
| Labtest literals inside generic Save/readback/claim schemas | Product limitation and duplication | Move test identity/date/no-send values to fixtures and trusted execution policy |
| Uncalled historical helpers, alternate dead UI state machines | Deferred cleanup | Do not make deletion a pilot-critical lane |
| Intermediate-head review/testing repeatedly invalidated by edits | Avoidable process churn | Freeze final review head; change it only for an actual finding |
| Tests that model unsupported cases while supported native sequence is untested | Evidence mismatch | Replace with representative contract/transition coverage |

Review was useful. Four sampled final hosted checks lasted **1m57s–3m26s**, not a universal 15-minute tax. Six sampled P1 comments had code support; five had visible fixes. Four PRs cannot establish Greptile accuracy or model tier. Create/Filing PR open-to-merge intervals overlapped coding, fixes and checks; they cannot be summed as review delay. [Review evidence](../plans/2026-11-03-002-feat-general-cloud-real-pilot-plan.md#evidence-and-retrospective).

## 4. Workflow scope: first prove the revenue-bearing transaction

The request names seven rows: six operational workflows plus cross-cutting Shared Source. Cancellation is an additional roadmap lane.

| Area | Smallest useful next slice | Required proof | Scope adjustment proposed |
|---|---|---|---|
| **Shared Source** | Preserve exact selected message and staff edits through prepare/Go/reopen | Rapid switch between two messages; old response cannot replace current form or authorize wrong action | Promote to shared foundation; one integrator owns contracts |
| **Triage** | Preserve per-stay actions, genuine second asks, travel-agent mail and pre-stay self-mail exclusion | Representative versioned source rows, independent expected actions | Keep; do not open another classifier rewrite |
| **Quote** | Complete mounted source → existing rate/business result → PDF/Excel/unsent draft; make Cloud-provider choice explicit | One BAR and one company/agency request, native rates and emitted artifacts, exact source | Parallel read-only lane; preserve working document generation |
| **Create** | General existing-profile single-room Create, no-send Labtest fixture through the same general tool | Source → Go → exactly approved native request → confirmation and fresh readback | First critical write; no separate fake-only production contract |
| **Filing** | Chosen source PDF → chosen stay → Go → one upload → fresh listing | Upstream bytes/hash binding, native upload target, exact observed document metadata | Parallel implementation; source parity resolved before native Outlook claim |
| **Amend** | Fix second-Save approval violation; then supported dates/occupancy/rate-plan/retain semantics | Both Saves bound to one approved operation, per-night prices where relevant | Keep full roadmap scope; do not make full expansion block first Create proof |
| **Multi-room** | Compose proven general single-room Create serially; retain each result | Two rooms, second refused/uncertain, first confirmation retained after reload | Follow Create; defer automatic resume and native linking |
| **Cancellation** | Generic read/preflight/guard contract in an independent lane | Prospective fee/scope evidence and truthful post-Save state | Keep planned work; fee discovery and real enablement outside first-Create completion condition |

These are proposed release stages, not silent removal of the owner's full scope. New-profile creation remains an explicit later capability until a genuine native profile-create path is scoped/proved. Code supports the narrower statement that unresolved-name staging **does not create a profile**; it does not prove a vendor-wide impossibility. [New Cloud staging](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/tooling/hms-cloud/create-reservation.mjs#L286).

### Filing: uploading is one native effect, not one integration step

The rewritten upload mechanic already exists. What remains around it is source provenance, selected-stay binding, native intent authorization, one-use dispatch, uncertain outcomes and visible completion. Current [connected source reader](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/src/ai/pane-filing-source.ts#L27) specifically reads a POP3 PDF artifact. A native Outlook `READ_ATTACHMENT_BASE64` capability exists, but that does not prove this Filing path consumes its bytes or that a mirror always represents the selected native attachment.

Fast path: retain source receipt/hash and target checks; make authorization server-derived; call the new Cloud upload tool; persist verified/refused/uncertain outcomes. If a mirrored attachment is used, prove its mapping against the selected native email/attachment. Do not add a second attachment pipeline until the existing mapping fails that check.

Fresh HMS Documents listing proves observed code/name metadata. It does **not** prove stored PDF byte equality or every node in the Documents tree. State that evidence level. A download/hash comparison is useful if available, but is not an invented mandatory pilot gate. Filing to the wrong stay can disclose/corrupt guest documentation; “near-zero risk because inventory is unchanged” is not a sound authorization rationale.

The saved [Filing next-run seal](/tmp/nava-u6-live-0da451e-20261103/NEXT-RUN.txt:1) explicitly says no upload was attempted, an exact-final-SHA abort rehearsal remained, and synthetic Go was not deployed-UI proof. A new 45-minute completion promise would repeat the same unsupported inference.

### Create: the native operation exists; the general contract is incomplete

The [Cloud mapper](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/src/ai/pane-create-cloud-input.ts#L48) has real lookup/staging inputs, but commit rejects non-Labtest names, restricts supported guarantees, and refuses confirmation sending. More narrowly, the [connected Cloud preview wrapper](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/src/ai/pane-cloud-preview.ts#L334) rejects non-Labtest before invoking that mapper/tool. Generic low-level lookup support is therefore not proof real guests can use this connected preview. The [new native Create](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/tooling/hms-cloud/create-reservation.mjs#L363) independently limits Save/readback behavior. Removing one refusal does not generalize the duplicate census, approval digest, durable claim or recovery target.

Use generic selected native guest/property/dates/parties/rate/guarantee/recipient/message/send inputs. Test them with Proof Labtest and send off. Authorization remains a trusted server decision. Staff Go selects an approved operation; the browser cannot grant itself real-write authority.

CMS recipient plumbing partly exists; the missing capability is deliberate send authority plus native/readback semantics. A no-send fake success does not establish real CMS confirmation sending. Nava itself saves unsent Outlook drafts. Never prepare a “confirmed” reply from HTTP 200 alone; use the positively verified reservation result.

### Amend: the blocking P1 is inside rewritten Cloud code

At [#987](https://github.com/kufupa/Zero/pull/987), `19c0cf18`, [first Save matching](https://github.com/kufupa/Zero/blob/19c0cf1860bc11fadc138f779a1fe5dc20c2d156/apps/server-pilot/tooling/hms-cloud/pane-amend-session.mjs#L324) uses checked `postAvailability`. The retain continuation at lines 329–332 takes a fresh snapshot and matches its own values without proving equality to the approved post-availability prices/fields. HMS can therefore change a price or saved field, and the second Save can authorize that changed body. Later readback only detects the already-saved difference.

Fix as one compound operation: same stay, approval, expected prompt and retain choice; allow only the explicitly intended continuation delta. Refuse changed price/party/date/occupancy or duplicate continuation. Preserve uncertain state if the first Save may have dispatched. [Original supported P1 comment](https://github.com/kufupa/Zero/pull/987#discussion_r4454626912).

The current candidate additionally admits only an unpaid one-night Labtest stay, unchanged plan and retain=yes, with supported date/adult changes. [Scope predicate](https://github.com/kufupa/Zero/blob/19c0cf1860bc11fadc138f779a1fe5dc20c2d156/apps/server-pilot/src/ai/pane-cloud-amend.ts#L103). Full Amend needs per-night pricing, rate eligibility, retain=no, occupancy/children and paid-stay semantics. It is substantial new native behavior, not a flag flip.

## 5. Architecture: one approved operation, one durable outcome

```mermaid
flowchart LR
    A[Inbound email + attachments] --> B[Extract + automatic HMS reads]
    B --> C[Source-bound prepared result]
    C --> D[Shared Nava pane: staff review + Go]
    D --> E[Server authority + immutable approved intent]
    E --> F[Durable claim + native request guard]
    F --> G[General Cloud tool: Save or upload]
    G --> H[Fresh native readback]
    H --> I[Persist verified / refused / uncertain / partial]
    I --> J[Pane result + unsent Outlook reply]
```

Keep these responsibilities small and distinct:

1. **LLM proposes facts and intent.** It does not authorize a mutation or change approved fields during dispatch.
2. **Server binds source and approval.** Recheck mailbox/property, message/extraction revision, selected guest/stay, material values, attachment hash where relevant, and actor authority.
3. **Durable claim precedes native continuation.** Losing a lease/connection must not let a stale browser keep writing after a replacement worker starts.
4. **Native guard checks the actual request.** A staged form, screenshot or HTTP success does not substitute for matching the dispatched payload.
5. **Readback resolves the result.** Losing a response becomes uncertain until a fresh positive read proves the intended effect. No inferred absence from an incomplete search.
6. **UI resumes durable status.** Reload/source switch must not erase the hold or require a new Go to discover the previous action.

Browser-level one-use fencing cannot guarantee distributed exactly-once behavior. Use a one-use durable admission/intent plus truthful resolution. Multi-room is a serial set of these operations with partial outcomes, not an atomic booking transaction or invented rollback.

Existing `workItem.state` and `workEvent` already support a [shared dispatch protocol](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/src/ai/hms-labtest-dispatch.ts#L129). Reuse/generalize it before proposing a new table. Its current history scan reads the whole dispatch field; its claim is HRCEN/Labtest-scoped and admits one active intent. Confirm retention, indexing and all-writer coverage before scaling it. The [committed migration](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/drizzle/0047_nava_work_items.sql#L8) protects UPDATE/DELETE, explicitly permits TRUNCATE, and is not proof of effective production trigger state.

### Background readiness is a separate product contract

Current shared code already schedules reads after admitted inbound extraction. [Confirmation prefetch](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/src/ai/hms-jobs.ts#L2164) and [party/quote scheduling](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/src/ai/hms-jobs.ts#L2812) precede pane open. Preserve this design.

But flags are only admission controls. [Quote enablement](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/src/ai/hms-jobs.ts#L174) also requires the job queue; its default hourly budget is six. [Capacity code](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/src/ai/prefetch-capacity.ts#L38) accounts for strategy/stay fan-out, allows an oversized first batch in an empty window, and can defer overflow until capacity returns. This concerns shared mounted orchestration, not a flaw inside `hms-cloud/quote-read.mjs`.

Measure eligible mail/hour × stays/mail × strategies/stay against actual service capacity; do not prescribe a flag/cap increase without measurement. Record extraction time, queued/started/finished times, source identity, result age, ready-at-open and skipped/deferred reasons. Show incomplete or stale preparation clearly; refresh/revalidate approved values before writes. No current evidence supports “all emails ready in 20 seconds.”

## 6. Parallelism: four different resources need different ownership

| Resource | Actual constraint | Safe execution shape |
|---|---|---|
| Coding/worktrees | Shared files and changing branch bases | Independent workflow files; one integrator for shared pane/DTO/approval modules |
| Local targeted tests | Current workspace allows at most three across harnesses, with ≥20% CPU/RAM headroom | Check active runs/resources; use narrow workers; separate disposable DB/socket per suite |
| Remote typecheck/Vitest | Shared EC2 checkout and `.lock` | Queue exact final heads; one typecheck per affected app; verified same-head `SKIP_TYPECHECK=1` prevents repetition |
| Browser reads/staging | Session/tab/storage ownership; existing route locks | Separate verified contexts/sessions; prove property and read-only guard; preserve existing checks |
| Native writes | Same stay/guest conflicts, duplicate scope and durable intent | Serialize conflicts; current shared Labtest claim is broader than a confirmation-level lock |
| Release/proof | One final integrated SHA, effective process flags and deployed assets | Integrator owns deployment and evidence; no arbitrary worker deployments |

The remote mutex protects a mutable shared checkout. Removing it while jobs checkout/clean the same tree would invalidate tests. Parallel EC2 slots require isolated checkouts, correct dependencies/generated artifacts, slot-specific locks and demonstrated CPU/RAM capacity. They are a possible infrastructure project, not a zero-minute fix.

One saved exact-head sample for `19c0cf18` records **77 Node tests in 3.064 s**, **234 mail tests in 14.94 s**, and **64 mocked-server tests in 20.89 s**, all with saved exit 0/head receipts. Remote typecheck receipts for both apps also record exit 0. These are prior run results inspected now, not tests rerun in this review. The CLI Apex receipt records exit **143**, not a passing result. [Node log](/tmp/nava-u7-19c0cf18-node.log:1), [mail log](/tmp/nava-u7-19c0cf18-mail.log:1), [server log](/tmp/nava-u7-19c0cf18-server.log:1), [Apex exit](/tmp/nava-u7-19c0cf18-apex.exit:1). Inner test durations exclude queue/SSM/rework; this sample neither supports a 10× test tax nor proves tests covered the native P1.

Likewise, successful parallel Chromium logins prove session coexistence for those probes. They do not prove safe concurrent writes to one guest, completeness of duplicate searches, or shared-cookie/tab isolation. Reads can proceed independently; the protected preimage/duplicate check and Save must stay connected.

Current [dispatch history/epoch](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/src/ai/hms-labtest-dispatch.ts#L65) serializes HRCEN Labtest writers. A held unresolved intent blocks another write. Narrowing that protocol requires proof of conflict-domain coverage and stale-preimage protection. Fake fixture identity remains Proof Labtest under current product policy, so inventing a different fake guest per lane is not the available isolation mechanism.

**New Cloud session isolation is real.** The inspected bootstrap launches a fresh Chromium context per call; its picker queue serializes commands within that page. It does not inherit the earlier `createHmsRuntime` one-session semaphore. Connected Create/Filing still take a property-wide PG lock and participate in the shared durable claim. Thus separate Cloud sessions remove browser-storage contention while current host locking can still serialize writes/preparation. [Cloud bootstrap](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/tooling/playwright-quote/centurion-stay360.mjs#L297), [connected Create lock](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/src/ai/pane-cloud-preview.ts#L431).

**Concrete cutover coverage gap:** the new [booking-session CLI](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/tooling/hms-cloud/booking-lookup-session.mjs#L584) exposes `saveNewLabtestStay` without host claim callbacks. The [new native Save](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/tooling/hms-cloud/guest-stay-save.mjs#L655) accepts both callbacks absent, although its native one-use/Labtest checks remain. This is a new-tool alternate writer surface, not an old-operation accusation or proof of unauthorized real writes. Its activity is unverified. Include/hold it when proving writer coverage; do not generalize identities and assume every entry point joins the pane's durable fence.

**Proposed team:** one Sol/Terra integrator; one general Create worker, using Sol/Terra for authority/native-boundary decisions; one Luna max Filing/source worker; remaining slot for a bounded Luna max read/quote audit or final independent review. Multi-room waits for Create's contract. Cancellation discovery stays outside the first-proof critical chain. No Astra. More agents are useful only when their files, runtime resources and evidence are independent.

## 7. Give agents a state harness; reserve humans for authority and truth

| Layer | Agent-suitable work | Required scaffold or human input |
|---|---|---|
| New HMS Cloud tools | Native DOM/state readers, deterministic staging, guarded requests, truthful outcomes | Verified session/property; representative native before/request/after captures |
| Shared pane/routes | DTO mapping, source binding, form edits, Go/status/reopen behavior | One agreed approved-intent contract and canonical fixture |
| Outlook integration | Bridge schema, source mapping, attachment/draft adapters and client fixes | Enrolled Windows Outlook host or accessible Windows harness; tenant/device authority |
| Auth delegation | Implement enrollment/ticket checks and scope enforcement | Owner/tenant-admin authority; agent cannot manufacture consent |
| Recovery | Persist holds, positively reconcile fresh readback, retain partial batch outcomes | Known native state semantics; explicit retry/refusal policy |
| Extraction/ROI evaluation | Replay versioned representative input; compare scored outputs | Independent truth from staff outbound/native records; staff task timings |

Direct code-driven calls are efficient for native and route diagnosis. They must use the actual production DTO and function/route. A direct `.mjs` success proves the tool; a disposable-DB connected test proves integration under its fixture; a mocked bridge proves interface behavior; deployed pane proof establishes the release path; enrolled Outlook proof establishes the native host. Label each separately.

The existing [preview driver](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/server-pilot/scripts/nava-preview-run.ts#L103) intentionally blocks approval and Create preview/commit. It cannot prove Go. Preserve that read-only viewer and add a narrow fixture-bound connected driver. Also choose an eligible actionable Filing email: the ordinary booking/voucher card mounts approval, while a separate non-actionable payment branch mounts a read-only Filing card. A disabled action in that branch is not evidence every Cloud Filing route is unwired. [Actionable card](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/apps/mail/components/nava-pane/blocks/booking-voucher-card.tsx#L93).

Classify driver effects by procedure. Legitimate tRPC reads can use POST, and opening/preparing a work item can mutate application state even while HMS activity is read-only. The previous quote guard rejected legitimate reads and left application-side mutations unresolved. Fix the procedure allowlist and record accepted calls/run IDs; do not remove every guard or call the whole probe read-only by inference.

Do not build another synthetic UI universe. Reuse existing fixtures, override infrastructure at explicit seams, and assert a small set of meaningful invariants: wrong source/target refuses, double Go does not duplicate, changed native payload refuses, lost response holds uncertainty, reload preserves status, supported retain continuation preserves prices, and partial batch retains successes. Native live fake proof complements these checks; it does not replace concurrency and lost-response coverage.

## 8. Concrete integration backlog and lane ownership

These are investigation/implementation units inside coherent workflow PRs, not a PR for every helper. Existing plan R1–R10 and U1–U8 remain unchanged; the identifiers below describe this review's proposed first-proof tranche.

| ID / owner | Concrete work and seams | Dependency | Verifiable artifact / failure exit |
|---|---|---|---|
| **P1 Integrator** | Pin root/main/candidate/deployed identities; inspect owners and pending policy patch; record actual active write/read paths | None | One source/route/tool/flag map. Any unresolved target/ownership stays explicit. |
| **P2 Integrator** | Bind one representative selected email/extraction to approved fields; define source revision, actor, property, native target, action ID and result states | P1 | Production-shaped request/approval fixture plus two-message switch refusal |
| **P3 Create worker** | Generalize Cloud Create input/save/readback and existing durable claim; move Labtest values into trusted fixture policy; keep complete target/intent/native checks | P2 | Same generic function accepts fixture values; wrong identity/field/authority refused |
| **P4 Integrator + Create worker** | Enumerate all participating writers; prove claim before native continuation, lock-loss epoch check and positive-only uncertain recovery | P3 | Disposable-DB concurrency/abort receipt; no old/direct writer bypass |
| **P5 Integrator** | Adapt existing code-driven proof driver to actual selected-source route/DTO and legitimate tRPC methods; retain real auth on deployed proof | P2, then P3/P4 | One trace through source → approval → intercepted native boundary; no blanket POST prohibition |
| **P6 Filing worker** | Prove selected attachment mirror/native mapping; generalize source/target authorization; keep native upload/readback | P2 | Exact source hash + target receipt; fresh metadata readback; parity gap explicit |
| **P7 Read/quote lane** | Confirm installed provider; map one new Cloud quote result to existing business result if cutover is selected; preserve contract/BAR/dinner/doc behavior | P1/P2 | BAR/company native-result comparison; mounted rate request and unsent artifact proof |
| **P8 Amend lane** | Bind second Save to checked post-availability intent; verify supported native sequence before expanding dates/rates/paid cases | Current #987 head | Changed continuation refused; allowed continuation matches approved values; new-head review |
| **P9 Integrator/reviewer** | Integrate/freeze final head; focused applicable tests, affected-app remote typechecks, Apex and P0/P1 adjudication under current/adopted policy | Critical P3–P5 | Actual same-SHA check receipts with skipped suites named |
| **P10 Integrator** | Approved main-bundle deployment; durable/effective flag audit for all four PM2 processes; safe cutover and property readiness | P9 + execution-session authority | Exact released asset/runtime SHA and effective flags; unresolved worker quiescence holds writes |
| **P11 Integrator** | Execute final permitted fake booking on deployed pane; fresh readback; display result and unsent reply; preserve state on reload | P10 | One complete source→Go→native Save→readback trace; no send; final-source/result equality |
| **P12 Outlook lane** | Walk same action on enrolled classic Outlook; verify selection/attachment/draft behavior against actual host | P2/P11 | Native host receipt. Mocked bridge stays separately labeled. |

P6/P7/P8 may progress independently after P2; they are not all prerequisites for first Create proof. Multi-room then composes P3/P4/P11. Full pilot release adds the remaining workflow and native-host proofs. The first working path earns integration evidence without redefining the full requested product as complete.

## 9. Process changes that improve speed without losing evidence

- **Prefer one connected behavior per PR.** Pure safety/shared-source fixes can remain separate. The 500-line gate caused real holds; the prepared policy patch addresses that mechanically. Avoid a full rewrite merely to fit a line cap.
- **Review final heads.** Start review/checks when the slice is stable; parallelize independent review and resource-safe checks. Any changed code head needs applicable new evidence. A green hosted status is not “no P1 comments”: #987 is the counterexample.
- **Make release review concrete.** The isolated patch removes mechanical merge blockers but its release-review rule is policy, not a new enforced deployment gate. Integrator must prevent unreviewed merged code shipping. Existing [deploy train](https://github.com/kufupa/Zero/blob/0da451edd5cbc6188d45fb05e619d5e2e12c97e0/scripts/orch/deploy-train.sh#L57) polls main every 30 s by default and calls deployment without checking review/test receipts. Train activity was not established. If active, merge-before-review creates a release window; establish a coordinated deploy hold or exact-SHA release approval before adopting the relaxation. A tiny SHA/app/command/exit/skips receipt can replace an empty `.ok`; no new evidence service is needed.
- **Use completion events and bounded work updates.** Worker delivers changed seam, exact head, failing/passing artifact and hold. Coordinator does not repeatedly dump every PR/thread/history into context.
- **Keep a compact resumable state.** Current scope, head, ownership, last proven boundary, next failed boundary and active uncertain holds. On compaction, reload it and relevant source instead of importing archives.
- **Measure before blaming prompt bloat.** Current startup files `AGENTS.md`, `PRODUCT.md`, `AGENT.md`, `START-HERE.md` total 215 lines / 2,517 whitespace-delimited words. They are not the giant instruction corpus implied by historical complaints. Historical skill/turn injection and actual context loss require separate traces. Fix stale command/provider pointers where relevant; do not spend a pilot lane shaving these files blindly.

Existing workspace guidance already permits resource-safe targeted local Vitest/Node tests, same-head typecheck reuse and independent read sessions. Those should not be presented as restrictions still needing removal. No policy patch was adopted by this review.

## 10. A finite autonomous budget and artifact-driven pivots

**Completion estimate:** no calibrated completion range is supported yet. Plan001's 550 minutes ended without the same successful connected outcome, so it is a censored failure observation, not a successful timing comparable. The latest generic plan omits measured quote/integration/proof durations. Inventing a confident upper bound would repeat the reviewed failure.

**Operational recommendation:** authorize a **360-minute first-critical-path attempt**, with **60 minutes of calibration**, one general existing-profile Create as its completion target, and independent Filing/read work. This is a finite spend/run envelope, not a promise that all six workflows ship in six hours. “Simulated booking” must be distinguished: offline simulated HMS readback is useful integration evidence; Product Done requires a permitted real HMS fake booking on deployed code.

| Elapsed budget | Hard checkpoint | Failure-recovery trigger |
|---|---|---|
| **0–30 min** | P1 route/version/ownership map, target fixture, effective write-mode requirements | Missing target or competing owner: hold dependent writes; continue independent source/contract work |
| **30–60 min** | P2/P5 exact-source driver reaches prepare and abort-only native boundary; one measured read/prepare and check-queue sample | No reproducible boundary: switch lane to driver/contract diagnosis. Withdraw any delivery forecast; do not add features |
| **60–120 min** | P3/P4 generic contract and durable admission proved in disposable fixture; stable candidate trace | Same failing boundary after two bounded hypotheses: independent challenger reviews evidence; fix underlying contract instead of repeating attempts |
| **120–180 min** | First permitted connected fake Save/readback where authorization/cutover are ready | No native dispatch: locate exact failed source/auth/flag/native check. Dispatch uncertain: quarantine owned session, preserve hold, reread; no new Go |
| **180–240 min** | Result persists on reopen; double-Go/source-switch/lost-response invariants verified; first-path candidate frozen | Failure expands scope: stop adding workflows, retain original goal, report specific unresolved prerequisite |
| **240–300 min** | Final-head review/checks plus authorized deploy/cutover readiness | P0/P1 or head change: fix/recheck. External queue/deploy wait: record actual wait; continue independent work |
| **300–360 min** | Deployed selected email → Go → fake Save → fresh readback → pane result/unsent reply | Missing artifact at 360 min: end attempt with exact boundary, head, evidence and holds. No automatic deadline extension or completion label |

Budget checkpoints are pass/pivot conditions. They do not promise a merge or live write at a clock time, and they never override authorization or unresolved native effects. Inspect a quiet lane's work before replacing it; preserve changes and stop only owned processes safely.

### How the first hour produces an actual forecast

Record service and queue time separately for the same app/head. Time source/approval preparation, native prepare/readback, focused tests, remote typecheck, review, deployment and artifact inspection. Identify code still required in P3/P4/P5; use successful comparable subunits from the actual Cloud set. Do not apply LOC/minute.

Compute the feasible critical path as:

`source contract + generic Create/native guard + connected driver + required checks/review + deploy/cutover + deployed proof + observed rework/waits`.

Count P6/P7/P8 only if the selected release target requires them; do not sum parallel lane durations. Keep shared EC2 queues and write slots serialized in the schedule. If the first hour cannot produce meaningful comparable measurements, the upper bound remains unresolved and the 360-minute attempt is still the spending limit. A repeated native-contract discovery means a different run class, requiring a revised plan rather than another “nearly done” extension.

**Resource/cost envelope proposed:** normally coordinator + two active workers; fourth slot only for an independent bounded audit/review. Existing infrastructure and approved remote checks; no unmeasured EC2 parallel build fleet. Dollar ceiling should be set from provider metering before an unattended launch, with separate Sol/Terra and Luna pools. This review's API exposes no per-agent billed usage: **Luna max, three agents — $ unknown; coordinating model — $ unknown; Exa — $0, unused.** No raw tokens are presented as cost and no invented billed total is reported.

## 11. Pilot value and release acceptance

The recovered assistant invented a 55%/20%/15%/10% desk-time mix and claimed 4–6 hours saved per reservationist/day. No timing dataset or staff sample accompanies those claims. They must not prioritize the roadmap as measured ROI. Writes do deliver obvious operational value, but real savings also depend on eligible case coverage, correction time and rework.

Proposed measurements, not owner-approved pass bars:

- Versioned representative eligible mail rows; report counts per workflow and independent truth source.
- Ready-before-open fraction and arrival→ready/read/write latency distributions; show denominator and skipped/deferred reasons.
- Staff active minutes for comparable manual and Nava-assisted tasks, including corrections and exceptions.
- Native verified outcomes, wrong-source/target refusals, uncertain holds and duplicate effects; sample size explicit.
- Installed Outlook coverage separately from webmail/mock bridge; one canary establishes that path only, not population-level reliability.

**First critical path accepted:** generic Cloud tool, exact selected source and approved native target/values, one durable admission, fresh positive HMS readback, persisted visible result, unsent reply, deployed final SHA and correct effective process modes. Proof Labtest/2027+/no-send are fixture values, not the production tool's identity schema.

**Full pilot accepted:** specified Triage/Quote/Create/Filing/Amend/Multi-room workflows on both pane surfaces, property-specific readiness, appropriate deployed canaries and final fake booking. Real guest use still requires owner authority in the executing session and staff Go. Native Outlook, real CMS send and cancellation fee/scope gaps remain named until tested/resolved. No credential or privacy obstacle should be invented from the supplied compliance premises.

## 12. Evidence pointers and unresolved questions

| Evidence | Use / limit |
|---|---|
| [General Cloud handoff](../context/HANDOFF-2026-11-03-general-cloud-pilot.md) | Latest prepared scope, review findings and pending policy patch; snapshot |
| [General plan 002](../plans/2026-11-03-002-feat-general-cloud-real-pilot-plan.md) | Requirements-only roadmap, source seams, unresolved pricing/source/cancellation scope |
| [Plan001](../plans/2026-11-03-001-feat-connected-pilot-next-tranche-plan.md) | Revised run contract; earlier estimate hypotheses and outside-in intent |
| [Run notes](halloween/2026-11-02-llm-retro/2026-11-03-next-pilot-planning-notes.md) | Timestamped checkpoints and cutoff; distinguish reports from direct artifacts |
| [Saved deploy result](/tmp/nava-u9-final-0da451e-deploy.log:36) / [safe flags](/tmp/nava-u9-flags-0da-after.json:1) | 12:29 deployed 0da/READY with write workers off; not current runtime |
| [Filing proof checklist](/tmp/nava-u6-live-0da451e-20261103/NEXT-RUN.txt:1) | No upload; exact-SHA rehearsal/cutover still needed |
| [New Cloud second-Save P1](https://github.com/kufupa/Zero/pull/987#discussion_r4454626912) | Code-supported unapproved continuation at inspected head |
| [Independent run audit](/tmp/zero-plan001-review-audit/adversarial-run-drift.md:1) | Full-corpus timing/claim reconciliation |
| [Independent Create/Filing audit](/tmp/zero-plan001-review-audit/adversarial-create-filing.md:1) | New Cloud caller chains, attachment provenance, preview/driver and batch boundaries |
| [Independent harness audit](/tmp/zero-plan001-review-audit/adversarial-harness.md:1) | Distinct runtime locks, actual check sample, alternate new Cloud writer and conditional release window |

Remaining discriminating checks: actual current runtime/flags and writer participation; deployed selected-source driver; native Outlook byte/source/draft parity; generic duplicate/preimage and durable event retention; full Amend price/paid/retain semantics; prospective cancellation fee/linked scope; successful comparable timing and provider billing. These limit launch/readiness claims, not the ability to finish this review.
