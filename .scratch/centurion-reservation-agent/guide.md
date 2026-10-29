# Using this map for speed

This map charts decisions and the evidence needed for them; it is not a list of 16 PRs. The owner has already chosen Centurion first, complete supported workflows and one approval for all displayed actions. Do not spend sessions asking those questions again.

**Canonical tracker:** [Centurion end-to-end reservation agent](https://github.com/kufupa/Zero/issues/670) on GitHub. The files beside this guide are the original local snapshot and do not update automatically; claim and resolve the GitHub issues, not the snapshot.

**GitHub copy of this guide:** https://github.com/kufupa/Zero/issues/670#issuecomment-6483616853

## What we are building

Selected email → extract and link the reservation case → look up stay, agency/company, current rates and hotel options → staff sees complete editable fields and all proposed changes → one approval → ordered HMS actions and independent readback → confirmed, partial or uncertain result and an unsent reply.

Use Mastra where it already helps understand mail; use existing database/work-item/job infrastructure to remember the approved plan and the outcome of each step. The model can propose data and next actions; the runner uses verified native records and executes the approved actions. This is a proposed direction, not a claim that the current pane agent already does it.

A single click does not make several HMS saves one transaction. If a room is saved and an Add-On fails, retain the room confirmation and report the unfinished Add-On. If a save may have happened, re-read HMS before retrying. Changed dates, party or rate invalidate dependent prefetch and may require a fresh review.

## How to build the agent

The following is the starting design to test against the open tickets, not a claim that it is implemented or an instruction to bypass the product rules.

1. **Understand the case.** Reuse mail classification and extraction to produce typed guest, dates, rooms, occupancy, agency, payment evidence and requested actions. Link a selected message to a case and any known HMS stays; one message can describe multiple stays. Keep unknown values unknown and preserve the evidence for each suggestion.
2. **Gather choices.** Search for existing stays and actual HMS party records. Once the agency or company is known, retrieve its eligible room/rate options and nightly prices for the real dates and occupancy; retrieve the property's native Add-Ons and other needed choices. Independent reads can run in parallel only where property locks and browser ownership permit. Flag ambiguity rather than choosing a plausible record.
3. **Make a proposed action plan.** Store the property, case, plan revision, staff-editable fields, lookup freshness and an ordered list of typed HMS operations with dependencies. For example: create the first stay, add its linked room, then add a selected native shuttle to the correct stay. An HMS confirmation email, if applicable, is a separate visible side effect with its actual recipient. Do not invent missing IDs, prices or child ages.
4. **Review once.** Show the complete fields, rates, recipients and all intended writes in the pane. Staff can correct them, and background results must not overwrite their edits. Approval binds to that specific plan revision. A material change or stale lookup needs an explicit refresh/review policy; the related ticket decides the details.
5. **Execute on the server.** Reuse the existing work-item/job/approval machinery where suitable. Save the approved plan before acting. Execute its dependent HMS operations under the correct property lock, record each step and independently read back what HMS saved. Persist confirmed, failed and uncertain outcomes so the pane can close without losing the case.
6. **Recover and respond.** If a save may have succeeded, reconcile against HMS before any retry; if identity remains ambiguous, ask staff to resolve it. Retain earlier confirmations when a later action fails. Generate the reply as an unsent draft. A single plan approval does not by itself authorize an HMS-native send or other guest action that the current product rules forbid.

Mastra is suitable for extraction and proposing tool use; the existing HMS runners and a durable server-side executor perform the approved actions. A unique operation ID helps track work but cannot guarantee exactly-once writes unless HMS itself supports it. Do not use a model response as proof that a write happened.

Current code matters: the [optional pane agent](../../apps/server-pilot/src/ai/pane-brain.ts) does not currently run HMS tools, and its [adapter](../../apps/server-pilot/src/ai/agent-pane-adapter.ts) discards party details and uses zero as each child's age. The [existing multi-room loop](../../apps/mail/components/quote-workflow/booking-card.tsx) already stops on failure, while [direct create](../../apps/server-pilot/src/trpc/routes/quote-workflow.ts) and the separate [queued approval](../../apps/server-pilot/src/ai/hms-approval.ts) have different persistence/recovery behavior. Inspect and reuse these seams before adding a new framework.

## Current chats (29 October)

The owner asked to focus the work and remove parked worktrees. The Add-Ons and prefill Codex terminals have been attached in Orca. Expand Zero's `main` workspace (checkout `recover-parse-failure`) and open the worktree's existing Codex tab; a plain shell tab may also be present. Each chat uses GPT-6.1 Terra, max reasoning and the owner's requested bypass setting.

| Orca workspace | Ticket or current work |
|---|---|
| `cen-native-addons-20261029` | [Native Add-Ons](https://github.com/kufupa/Zero/issues/687); next HRCEN scheduling turn, subject to a real property-wide lock |
| `cen-intake-prefill-20261029` | [Email/case linking and prefill](https://github.com/kufupa/Zero/issues/676) |
| `cen-pane-review-20261029` | [Staff pane prototype](https://github.com/kufupa/Zero/issues/682); owner feedback in progress |
| `cen-approval-20261029` | [Approval and confirmation](https://github.com/kufupa/Zero/issues/678); owner conversation in progress |

The finished execution worktree was removed; [its recorded decision](https://github.com/kufupa/Zero/issues/677#issuecomment-6484643064) remains. The parked SaaS-read worktree was removed; [its findings](https://github.com/kufupa/Zero/issues/671#issuecomment-6484453561) remain and its open issue is unassigned. The completed recovery worktree was removed; [its evidence and saved branch](https://github.com/kufupa/Zero/issues/674#issuecomment-6484464584) remain. Older worktrees were left alone.

If a Codex chat reports that the conversation is open elsewhere, select its original terminal instead of launching another copy. The Add-On handoff and correction to the earlier overly broad private-config restriction are [recorded here](https://github.com/kufupa/Zero/issues/687#issuecomment-6484712931); an actual property-wide lock is still required.

Use separate sessions for separate tickets. Each session reads the map, claims one open unblocked ticket before working, examines only the linked context it needs, and records its resolution where the tracker specifies. A human-in-the-loop ticket is resolved with the owner, not by an agent inventing the owner's answer. Each session resolves at most one non-research ticket.

GitHub issue assignment is the claim. One coordinator should assign and name each ticket before launching its session; sessions sharing one GitHub account must not independently pick the same assigned ticket. On completion, post the answer as a resolution comment, close the ticket, and add a named one-line pointer in the map's Decisions so far. Coordinate edits to the parent issue so concurrent sessions do not overwrite each other's pointers.

## Read the map

1. **Map:** the destination and standing owner decisions. Open questions live in child tickets, not in a giant map body.
2. **Frontier:** a child is ready if it is open, unassigned and every native blocker is closed. Multiple frontier tickets can run in separate sessions; otherwise take the first by number.
3. **Ticket type:** task collects a concrete missing fact or completes a prerequisite; grilling makes a product/engineering decision with the owner; prototype shows the owner a cheap working representation. Research is for genuinely missing information outside the current workspace, not a reason to repeat existing studies.
4. **Resolution:** post the answer and evidence as a ticket comment, close it, and add a one-line link on the map. Re-query the frontier: a closed decision can unblock other tickets or reveal a new question.
5. **Execution:** when enough decisions for a specific slice are resolved, write a focused implementation plan and start that slice; do not wait for unrelated payment/cancel decisions to implement a well-defined booking prefetch fix. Follow the current user's parallel-work direction, property safety and repository checks.

Open the GitHub parent issue and inspect its sub-issues and blocked-by relationships. Ask a fresh session to work a named child issue. The upstream local Markdown tracker is still available for a different effort, but the local copy of this map is not its source of truth.

## After decisions: parallel implementation

Use isolated worktrees and a single integration owner. Candidate lanes are intake/prefill, cloud HMS read/rates, native Add-Ons/Guest Details, server-side one-click execution/recovery, pane review, payment/amend/cancel, and evaluation. The shared booking card, bind/create files and a single HRCEN browser are not independently writable just because agents have separate worktrees. Verify current ownership and applicable lock keys before live work. Coordinate the approved remote test route.

The first integration checkpoint should exercise one synthetic Centurion email through the real pane: two rooms, a child, selected agency and live rate, a native Add-On, one staff approval and independently read-back per-step results. This is a timeboxed goal, not proof that every workflow is production-ready.

| Delivery lane | Starting seam | Coordination |
|---|---|---|
| Intake and prefill | Email extraction, party lookup and availability job eligibility; booking requests currently miss the quote-only prefetch query | Own extraction/prefetch files; agree a typed case contract |
| Centurion SaaS | Existing quote reader and the recorded cloud WIP; independently validate returned dates, party context and nightly rate | One HRCEN browser operator; inspect existing work first |
| Native Add-Ons | Native catalog/read/write/readback and Guest Details after screen evidence | Develop isolated helpers; integration owner wires shared create code |
| Action and recovery | Existing pane commits, work items, approval and job code; persist the reviewed plan and each result | One owner for shared route/approval/create files |
| Staff pane | Existing booking card and Outlook/webmail surfaces; prefill, edits, complete options and clear partial state | One owner for shared booking-card files; other lanes use stable props/contracts |
| Payment, amend, cancel | Existing corpus, voucher/document and change runners; map actual payment and fee behavior | Research and isolated files in parallel; cancel remains lab-only |
| Evaluation | Existing party and booking truth, synthetic failure cases, independent HMS readback | Run approved checks without competing for the hotel browser |

Do not copy untracked evidence into a new worktree and assume it is committed. Pass the shared workspace path to research sessions; keep guest data out of Git and issue bodies. Each code lane should use the correct base revision and declare the files it owns before editing.

## Suggested session prompt

> Work the named Wayfinder ticket. Read the map, current product rules and linked existing evidence first. Claim the ticket; use the current code and known owner decisions. Recommend a concrete answer and identify only genuine gaps. Do not repeat corpus research, touch another session's files/browser, or infer live-write or send authority. Close only this ticket when its actual resolution requirements are met.

For a fresh session, invoke `$wayfinder https://github.com/kufupa/Zero/issues/670`. For a parallel lane, also provide the URL of its assigned child and say that the coordinator already claimed it for that session. The local copy of this guide and some linked research remain untracked files, so a separate worktree will not receive them through Git automatically; pass their absolute shared-workspace paths when needed.

The repository has no permanent Wayfinder tracker configuration. The skill says to run `/setup-matt-pocock-skills` for setup; that setup skill is not installed in this session. Pass the GitHub map URL explicitly until the configuration is installed.
