> 🧠 **From Hindsight memory (Da Vinci HRDAV make-quote flag)** — It recorded HRDAV reads as default-off and Make Quote absent. The off-state is stale: [ACTIVE.md:7](docs/context/ACTIVE.md:7) says `HMS_DAVINCI_READS=on`.

Startup: read `PRODUCT.md`, `ACTIVE.md`, `OWNER-ASKS.md`, research `README.md`, `FACTS.md`, `CATALOG.md`, `AGENT.md`; `git rev-parse --short origin/main` = `db4abaca4` (= HEAD), worktree clean. CodeGraph was a stale main-checkout locator; verified in this worktree with `rg`/`sed`. No edits, tests, tsc, Vitest, prod, or HMS access.

### 1. Current state

| Exists | Evidence |
|---|---|
| HRDAV pane reads, not quote permission. One HRDAV read slot/secret; five DV transports. | [hms-read-target.ts:24](apps/server-pilot/src/hms/hms-read-target.ts:24), [hms-read-target.ts:37](apps/server-pilot/src/hms/hms-read-target.ts:37) |
| Quote blocked: manual route and background prefetch use Centurion-origin guards; draft source pins `HRCEN`. | [workstation.ts:826](apps/server-pilot/src/trpc/routes/workstation.ts:826), [hms-jobs.ts:2220](apps/server-pilot/src/ai/hms-jobs.ts:2220), [reservationist-draft-source.ts:13](apps/server-pilot/src/ai/reservationist-draft-source.ts:13) |
| `fetch-quote.mjs` registry has one DV transport; verified room profile only has HRCEN. | [property-registry.mjs:15](apps/server-pilot/tooling/playwright-quote/property-registry.mjs:15), [property-profile.mjs:5](apps/server-pilot/tooling/playwright-quote/property-profile.mjs:5) |
| Rate catalogue, room codes, and pane wording assume Centurion. Pane party lookup refuses DV; party-index schema has no property/login key. | [rate-catalogue.ts:24](apps/server-pilot/src/hms/rate-catalogue.ts:24), [party-lookup.ts:107](apps/mail/lib/quote-workflow/party-lookup.ts:107), [party-index.ts:20](apps/server-pilot/src/ai/party-index.ts:20) |
| Quote revision already stores `propertyCode`; PDF HTML, Excel template, room descriptions, and reply copy still brand Centurion. | [quote-revision.ts:118](apps/server-pilot/src/quote-proposal/quote-revision.ts:118), [proposal-pdf.ts:118](apps/server-pilot/src/quote-proposal/proposal-pdf.ts:118), [quote-workbook.ts:8](apps/server-pilot/src/quote-proposal/quote-workbook.ts:8) |
| Main has a separate 3-business-day unsent follow-up; #461’s 66h expiry draft is not on this baseline. DV quote runs: 0 ok / 0 failed / 6 refused in the readiness report’s 7-day window. | [quote-followup.ts:60](apps/server-pilot/src/ai/quote-followup.ts:60), [client-readiness.md:15](docs/research/2026-10-22-client-readiness.md:15) |

### 2. Gap to “fully built”

1. Probe HRDAV read-only: tenant/property identity; rate and sales-strategy codes; board meanings; room codes, labels and occupancy; availability/party-search DOM and selectors. One browser lock; no Save/commit.
2. Add a quote-only mailbox→property resolver for all five transports. Gate route, queue, worker, prefetch and pane capability. Recommend `HMS_DAVINCI_MAKE_QUOTE`, exact `on` enables, default off; do not loosen the shared Centurion guard.
3. Add evidence-backed HRDAV rate/board/room policy and property profile. No Centurion code, label, dinner add-on or policy fallback.
4. Scope party lookup, verification and typeahead/index by HRDAV property **and HMS login**. Never share Centurion party IDs/profile.
5. Select approved HRDAV identity for PDF, Excel, letterhead, room wording and unsent reply. Reject mixed-property output; retain existing same-property multi-stay behavior.
6. After #461 lands, make its expiry draft property-aware; don’t reimplement its clock/sweep or send mail.
7. Replay/reprice all eligible post-cutover gold threads. Enable only after acceptance; DV create/amend/cancel stays OFF.

### 3. Per-change estimate

LOC are source-based ranges; binary templates/logos excluded. HRDAV mappings remain unknown until probe.

| Change | Repo-relative files touched | Product LOC; test LOC; tests changed/new | P1-likely spot |
|---|---|---|---|
| 1 Probe | None | 0; 0; none | Wrong DOM/code assumptions block all later steps |
| 2 Gate | `apps/server-pilot/src/{env.ts,hms/hms-quote-target.ts(new),trpc/routes/{workstation.ts,quote-workflow.ts},ai/{hms-jobs.ts,reservationist-draft-source.ts}}`; `apps/mail/{lib/quote-workflow/party-lookup.ts,components/quote-workflow/quote-workflow-panel.tsx}` | +120–180/−15–30; ~150–220; change `staff-quote-route.test.ts`, `reservationist-draft-source.test.ts`; new `hms-quote-target.test.ts` | Wrong transport→tenant; queued worker bypasses default-off |
| 3 Rates | `apps/server-pilot/src/{hms/rate-catalogue.ts,ai/staff-quote-installation.ts,quote-proposal/description.ts,tooling/playwright-quote/{property-registry.mjs,property-profile.mjs,property-profiles/HRDAV.json(new),fetch-quote.mjs}}`; `apps/mail/{config/room-types.ts,lib/quote-workflow/{staff-quote-bind.ts,types.ts}}` | +150–250/−20–40; ~180–260; change `quote-rate-catalogue.test.ts`, `hms-property-registry.test.mjs`, `property-profile.test.mjs`, `fetch-quote.test.mjs`, `quote-workflow-panel.test.tsx` | Wrong rate/board/room binding or price |
| 4 Party | `apps/server-pilot/src/{ai/{staff-quote-installation.ts,pane-party-lookup.ts,party-index.ts,party-index-sweep.ts},trpc/routes/pane-party-lookup.ts,tooling/playwright-quote/party-lookup.mjs}`; `apps/mail/lib/quote-workflow/party-lookup.ts` | +100–170/−10–25; ~140–220; change `pane-party-lookup.test.ts`, `party-index.test.ts`, `staff-quote-installation.test.ts` | Cross-property/login party ID leakage |
| 5 Output | `apps/server-pilot/src/{ai/reservationist-agent.ts,trpc/routes/workstation.ts,quote-proposal/{proposal-pdf.ts,quote-workbook.ts,description.ts,filename.ts}}`; new approved HRDAV `.xlsx`; `apps/mail/lib/quote-proposal/copy.ts` | +120–220/−25–50; ~170–250; change `quote-proposal-pdf.test.ts`, `quote-proposal-render.test.ts`, `quote-workbook.test.ts`, `quote-proposal-multistay.test.ts`, `apps/mail/tests/quote-proposal.test.ts` | Wrong hotel/contact/terms on guest-facing artifact |
| 6 Expiry | Current `apps/server-pilot/src/ai/quote-followup.ts`; actual #461 landing files unknown | **Unknown** until #461 lands; change its tests plus `quote-followup.test.ts` as applicable | Wrong-property or duplicate draft; staff still reviews/sends |

### 4. PR split, dependencies, collisions

| Slice | Behavior / dependency |
|---|---|
| Probe | Read-only factsheet; no PR. Prerequisite for rate/profile and branded output. |
| PR1 | Quote-only resolver + off-by-default gate + server-backed pane capability; ≤500 product LOC. |
| PR2 → PR3 | HRDAV rate/room/board policy, then party lookup per login; each ≤500. Sequence: both touch quote config/pane files. |
| PR4 | HRDAV identity across quote PDF/Excel/reply; ≤500. Depends on property identity and approved assets. |
| PR5 | Expiry-draft compatibility only, after #461 lands; ≤500. Do not re-plan #461. |
| Collisions | `workstation.ts` / `hms-jobs.ts` / `mailbox-hms-origin-bind.ts`: create/amend/cancel; edit quote blocks only, keep write guards. `quote-workflow-panel.tsx` / `nava-pane.tsx`: overlay/CHECK and U9 UI; queue changes. `proposal-pdf.ts` / `quote-workbook.ts`: multi-stay; preserve HRCEN tests, reject mixed-property output. |
| Enable | After gates, set `HMS_DAVINCI_MAKE_QUOTE=on` on `http`, `worker`, `ai-worker`, `remote-http` wherever read; verify each `/proc/<pid>/environ` before enqueue. Keep `HMS_DAVINCI_READS=on`; keep `RESERVATIONIST_PANE_SAVE=lab`; don’t flip global `HMS_QUOTE_PREPARE`. Backend capability controls pane; server rechecks flag. |

Per direction: #451 replay and #461 expiry are dependencies; don’t re-plan #458/#460/#462. Start from main after those PRs land.

### 5. Test plan and current-data proof

| Tests (proposed; not run) | Scenario |
|---|---|
| `staff-quote-route.test.ts`, new `hms-quote-target.test.ts`, `reservationist-draft-source.test.ts` | Default off blocks DV manual/queue/worker; all five transports resolve HRDAV only when on; HRCEN unchanged; no write route gains access. |
| `hms-property-registry.test.mjs`, `property-profile.test.mjs`, `fetch-quote.test.mjs`, `quote-rate-catalogue.test.ts`, `quote-workflow-panel.test.tsx` | Secret/tenant mismatch refuses; HRDAV codes map only from probe; unknown board/room stays unknown; correct pane catalogue/capability. |
| `pane-party-lookup.test.ts`, `party-index.test.ts`, `staff-quote-installation.test.ts` | Index/cache scoped per property+login; selected party rechecked in matching HRDAV account; no Centurion party reuse. |
| `quote-proposal-pdf.test.ts`, `quote-proposal-render.test.ts`, `quote-workbook.test.ts`, `quote-proposal-multistay.test.ts`, `apps/mail/tests/quote-proposal.test.ts`, `quote-followup.test.ts` | Approved HRDAV brand across PDF/Excel/reply/expiry; same-property multi-stay preserved; no auto-send. |

Current-data source: read-only prod `message` + `attachment` rows for the five DV transports, `receivedAt >= 2026-10-21 11:40Z`; fields include direction, `messageIdHeader`, thread and reply references ([mail.ts:329](apps/server-pilot/src/db/schema/mail.ts:329)). Count raw rows, cross-mailbox-deduped inbound quote asks, #451 outbound-gold pairs, plannable future stays, and repriced threads separately. Exclude the 3,363 promoted history rows (AI skipped) [ACTIVE.md:8](docs/context/ACTIVE.md:8).

`N` = every distinct, gold-paired, plannable post-cutover quote thread after dedupe by canonical Message-ID/ingest source—not transport rows or room stays. Use #451 replay with prod-parity body **and attachment** input, then read-only HRDAV reprice for all N, serially under one HMS lock; compare rate plan and nightly price with staff quote. Product bar: every plannable ask matches, at least 10 threads [PRODUCT.md:68](PRODUCT.md:68). **N is unknown**: no prod query/live read in this lane. If N<10, hold flag off and collect more. Writes, if ever authorized, Labtest only; DV create/amend/cancel remain off.

### 6. Open questions (defaults)

1. Approved HRDAV logo, phone, website and terms? Default: no branded output/activation until approved; never reuse Centurion assets.
2. One HRDAV quote login for all five mailboxes, or per-staff logins? Default: one explicitly approved account only; separate index per login.
3. Multi-stay at first enable? Default: same-property stays only; no mixed-property quote; refuse unsupported combinations.
4. Manual Make Quote or background auto-prepare too? Default: manual pane capability only; leave global `HMS_QUOTE_PREPARE` unchanged.

ROI: DV staff get verified quote drafts with less re-keying; fallback remains manual Infor + staff-authored reply. Conditional estimate: ~8–12 active hours code→review→deploy→one read-only proof **after** probe/assets and N≥10; calendar-to-enable unknown until DV ask volume is counted. Basis: SR2 UDV-2 took 220 active min for 569 product LOC; coding ran ~1.44× estimate [retro:28](docs/context/ledger/2026-10-21-sr2-overnight-retro.md:28), with 5–7 min per deploy [retro:31](docs/context/ledger/2026-10-21-sr2-overnight-retro.md:31); HRDAV facts and N add unknown time. Future authority needed: owner-approved read-only HRDAV probe, approved account/brand, then flag deploy. No authority used now.