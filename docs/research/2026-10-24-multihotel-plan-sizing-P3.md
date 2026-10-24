---
date: 2026-10-24
lane: P3 sizing (multi-hotel ce-plan)
model: GPT-6 Luna max (Sonnet slot)
method: read-only code read; no tests, prod or HMS
base: origin/main 1656bca50
---

# P3 — Multi-hotel sizing: S5/S6/S7/S9/S10

**Answer:** S6 needs one shop per allowed strategy, not one strategy per quote. S5(c) must share sender trust across same-property mailboxes while keeping to-dos mailbox-local.
**Scope/evidence:** read-only. Target `docs/multihotel-shape`, HEAD `451761827`, `origin/main=1656bca50`; no repo edits, tests, typecheck, prod or HMS access. `.codegraph/` absent; used targeted reads/searches.
**Read:** requested plan, A1, S5 §§1–2, S1, relevant source; `PRODUCT.md`, `ACTIVE.md`, `OWNER-ASKS.md`, research README, `FACTS.md`, `CATALOG.md`, `AGENT.md`.
**Legend:** [V] verified in checkout/docs; [I] LOC/time estimate. LOC excludes tests. Slices assume S1 registry + S3 resolver/target; S4/S6 quote-pane edits must be serialized because they share UI/type files.

## S5 — Context, deduped reads, mailbox-local to-dos

- [V] Relevant source: `apps/server-pilot/src/ai/hms-jobs.ts`, `ai/quote-ready.ts`, `ai/work-items.ts`. No `PropertyContext` exists. Use S1 registry + S3 target resolver; do not create second resolver.
- [V] HMS jobs/results live in `ai_workflow_run` (`read_result`, expiry, trigger message). Quote-ready is re-evaluated from extraction; no separate quote-plan table. Current lookups and idempotency are transport/per-copy scoped. Message has partial `(transport_id,message_id_header)` index; runs have trigger-message and unique idempotency-key indexes. S3 counted 1,121 DV inbound copies of repeated Message-IDs in 30 days; each copy can currently enqueue its own preparation.
- **Dedup shape [I]:** canonical identity = property + normalized non-null Message-ID + read kind. Probe each mapped transport via existing index; store/reuse receipt across copies. Null/missing header stays per-copy. Literal owner ask says one HMS read per property+Message-ID, but party search and quote-rate shop do different work; current code gives no one-call combined result. S5 must define whether one logical read means one per kind or add a combined runner. Query plan/perf unmeasured.
- **Modify:** `apps/server-pilot/src/ai/{hms-jobs,quote-ready,work-items}.ts`. **New:** none if S1 context supports property-wide transport list. **Product LOC:** 130–220 [I] (draft 80–150 looks low for shared receipt lookup + cross-mailbox trust). **Tests:** `tests/hms-jobs.test.ts`, `tests/quote-ready.test.ts`, `tests/work-items.test.ts`, `tests/work-items-hms-todo.test.ts`. **Migration:** no. **Depends:** S1 + S3.
- **S5(c), exact rule:** “When an inbound reply from any mailbox arrives in another mailbox, trust its sender only if that exact address appears in an outbound `From` from any mailbox mapped to the same property; then close the matching to-do in the receiving mailbox. Keep one to-do per mailbox.” Change `knownSenders` from current-transport-only lookup to same-property transports; keep `planThreadWork` and work-item state mailbox-scoped.

## S6 — Shop all allowed strategies and show each HMS price

- [V] `tooling/playwright-quote/fetch-quote.mjs` selects one `salesStrategy` per Hotel Availability grid search; one date range can page up to 3 grid windows. `staff-quote-workflow.ts` accepts only BAR/Government; `quote-ready.ts` currently picks one (all DBB → Government, else BAR). No strategy fan-out now.
- [V] `#441` tags returned BAR/BARRO rows public and `isNegotiatedRate=true` rows contextual; GOV label handling applies to results of selected shop. `reservationist-rate-policy-source.ts` handles selected-rate evidence, not strategy discovery/fan-out. `staff-quote-installation.ts` chooses installation, not allowed-strategy list.
- **Required N:** plan G9/owner answer requires BAR + WS + NC/contract + GOV + AIR + STO = **6 shops**, each price shown from HMS. HRDAV profile lists 9 values (PROMO/BAR/PRESET/WS/NC/GOV/AIR/DOML/OTHER), but that dropdown set is not proof all are permitted; STO is absent there. Registry must define confirmed hotel-allowed list. Do not omit required STO or expose unconfirmed values.
- **Execution:** one queued job/session under one property browser lock; reuse login; run one grid per configured strategy serially; aggregate tagged prices into existing quote review. Not N jobs/logins. S4 quote UI/config lands first; S6 then adds strategy comparison in same shared pane/types. Do not auto-select “best” strategy; prediction is later.
- **Extra seconds:** observed 187 s price-only quote is end-to-end, not isolated HMS shop; mixed HMS read jobs were 12–413 s. No measured per-strategy `T`. Formula: extra serialized time ≈ `(N−1) × T(strategy grid)`. Scenario only, if each repeated path took 187 s: N=6 → **935 s / 15.6 min extra**; N=9 → **1,496 s / 24.9 min extra**. Not forecast or upper bound. Measure shop phase per strategy on authorized canary.
- **Modify:** `apps/server-pilot/src/ai/{staff-quote-workflow,quote-ready}.ts`, `tooling/playwright-quote/{fetch-quote.mjs,quote-tool.schema.json}`; `apps/mail/lib/quote-workflow/{types.ts,session.ts}`, `apps/mail/components/nava-pane/quote-workflow/quote-workflow-panel.tsx`. Coordinate S4 edits to `types.ts`, `nava-pane.tsx`, panel. **New:** none. **Product LOC:** 250–400 [I], larger than draft 150–250 because pane shows all strategy prices. **Tests:** `tooling/playwright-quote/{fetch-quote.test.mjs,fetch-quote-phases.test.mjs}`; server `tests/{staff-quote-job,quote-ready}.test.ts`; mail `apps/mail/tests/quote-workflow-panel.test.tsx`. **Migration:** no. **Depends:** S1 + S3 + S4 quote config/UI.
- **Acceptance gap:** G9 needs all six strategy prices on live shops for 3 future S4 stays, matching HMS grid. S4 has 27 validated DV BAR facts but **0 validated non-BAR priced rows**; strategy parity needs read-only HMS evidence and later live canary, not outbound word counts.

## S7 — Party index and learned sender history by property

- [V] `party-index.ts` already separates HRCEN/HRDAV files, but property set is hard-coded. `party-sender-map` uses global `host` primary key; cache/lookup lack property argument. `party-aliases.ts` and `party-match-v2.ts` read history globally. `hms-jobs.ts:isCenturionPartyHistoryTarget` gates current history path to CEN.
- **Modify:** `apps/server-pilot/src/ai/{party-index,party-index-sweep,party-sender-map,party-aliases,party-match-v2,hms-jobs}.ts`; `src/db/schema/party-sender-map.ts`. **New:** SQL migration. **Product LOC:** 120–200 [I]. **Tests:** `tests/{party-index,party-index-sweep,party-sender-map,party-aliases,party-match-v2,hms-jobs}.test.ts`. **Migration:** yes; add `property_code`, backfill existing rows to HRCEN (current writer is CEN-gated), PK `(property_code,host)`, scope cache/reads/writes. **Depends:** S1 + S3.

## S9 — Amend/cancel/attach consume registry fields and target

- [V] Write paths: `src/ai/{pane-stay-save,pane-stay-amend,pane-stay-cancel,pane-hms-write}.ts`; create preflight special-cases HRDAV `reservationnote`; profile/parser/secret checks in `tooling/playwright-quote/{property-profile.mjs,create-preflight.mjs,amend-stay-rules.mjs,amend-stay.mjs,cancel-stay.mjs}`. Attach runs through `pane-hms-write.ts` → `attach-document.mjs`, target passed in spawn env; `ATTACH_VERIFIED` remains mandatory.
- **Modify:** above target/profile consumers; replace two-hotel branches with registry target, field requirements and option lists. Preserve explicit CLI-only omitted-`--property` HRCEN default; never use it as mailbox fallback. **New:** none if S1/S3 contracts exist. **Product LOC:** 220–350 [I]. **Tests:** `tests/{pane-stay-save,pane-stay-amend,pane-stay-cancel,create-preflight,pane-stay-spawn-env}.test.ts`; `tooling/playwright-quote/{create-preflight.test.mjs,attach-document.test.mjs}`; add profile/unknown-property assertions where absent. **Migration:** no. **Depends:** S1 + S3. S4 owns create field UI; S9 only write-path validation/target plumbing.

## S10 — HRFAKE no-HRCEN-fallback contract

- **Add:** test-only fake registry entry + `property-registry-contract.test.ts`; extend property-keyed eval identity. Assert unknown mailbox refuses before HMS call; fake property gets its own room/rate/required-field/slot values; no HRCEN constants leak into target, args or outputs.
- **Modify:** registry/consumers only if test seam fails. **New:** contract test/fixture only. **Product LOC:** 0–20 [I]; whole slice incl. test/eval changes 60–120 [I]. **Migration:** no. **Depends:** S1–S9.

## Risks / bounds

- **Write safety:** S9 touches real-HMS write target/fields. Unknown hotel must refuse; mailbox context, not caller property, controls target. Keep per-property lock, Labtest/write guards, screenshot review, cancellation-penalty refusal, attach opt-in.
- **Migration:** S7 host-only key can merge same agency across hotels. Backfill to HRCEN based on current CEN-gated writer; reconcile existing rows before apply.
- **Lock/latency:** S6 serial N shops can hit quote TTL or delay staff; reuse S3 lock identity. `property-read-lock.ts` already keys tenant+property; if properties share a browser slot, key by actual shared slot. One session only. S5 idempotency includes property + read kind; null headers must not collide. Exact-address proof only, never whole-domain trust. Keep to-dos per mailbox.
- **Proof limit:** LOC and performance are [I]. No tests, query plans, prod/HMS reads, live canaries or permissions checked.
