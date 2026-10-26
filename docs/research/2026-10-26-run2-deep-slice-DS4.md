DS4 deep-slice check. Read requested docs and reused L2–L5. HEAD `2141e6979`; `origin/main` `230f5f7e4`; worktree delta is instruction/docs files. Prior size bands exceed the 200-line cap ([speed analysis:45](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/docs/research/2026-10-26-dev-speed-analysis.md:45), [shape plan:55](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/docs/plans/2026-10-26-001-overnight-run2-shape.md:55)). LOC ranges below are `[U]` estimates, changed product lines only. No tests, canaries, prod, or HMS touched; current prod flag state `[U]` ([dated evidence:12](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/docs/research/2026-10-25-pane-prefetch-and-ui-evidence.md:12)). Read-only workspace; no `-o` destination supplied.

| Field | Value |
|---|---|
| S0-Q1 · gap / need / steps | `RatePlanSelect` inline [panel:782](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:782); mechanically move it, unchanged, to new `rate-plan-select.tsx` `[U]`. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | Start T0; Q2 waits. Own `quote-workflow-panel.tsx`, new `rate-plan-select.tsx`; LOC `[U]` 95–145. Test unchanged render in `apps/mail/tests/quote-workflow-panel.test.tsx` `[U]`. Canary N/A; pass same UI, not run. Pure move; revert move. No behavior in S0. `luna`. |

| Field | Value |
|---|---|
| S0-Q2 · gap / need / steps | Read-only `RatesBarGrid` is inline [panel:831](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:831), rendered at [panel:2165](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:2165); move to new `rates-bar-grid.tsx` `[U]`, add typed plan/cell callback seams, preserve rendering. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | Q1 first; G waits. Own `quote-workflow-panel.tsx`, new `rates-bar-grid.tsx`; LOC `[U]` 120–175. Test unchanged table in `apps/mail/tests/quote-workflow-panel.test.tsx` `[U]`. Canary N/A; pass same rows, not run. Revert move if changed. Seam stays inert. `luna`. |

| Field | Value |
|---|---|
| S0-N1 · gap / need / steps | Combined PDF branch sits in root [pane:1977](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/nava-pane/nava-pane.tsx:1977); move branch unchanged to new `use-quote-pdf-job.ts` `[U]`. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | Start T0; N2 waits. Own `nava-pane.tsx`, new hook; LOC `[U]` 90–145. Test unchanged combined-PDF flow in `apps/mail/tests/outlook-pane-quote-pdf.test.tsx` `[U]`. Canary N/A; no HMS. Revert move; no behavior in S0. `luna`. |

| Field | Value |
|---|---|
| S0-N2 · gap / need / steps | Single-stay PDF branch also lives in root [pane:2024](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/nava-pane/nava-pane.tsx:2024); move into same hook, keep root callback seam. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | N1 first; Q3, B1, K2 wait. Own `nava-pane.tsx`, `use-quote-pdf-job.ts`; LOC `[U]` 145–195. Test unchanged single-stay PDF flow in `apps/mail/tests/outlook-pane-quote-pdf.test.tsx` `[U]`. Canary N/A; no HMS. Revert move. Hook gets work-item ID seam, behavior unchanged. `luna`. |

| Field | Value |
|---|---|
| S0-Q3 · gap / need / steps | BookingCards caller omits its persistence props [panel:2359](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:2359); mechanically extract caller to `quote-booking-host.tsx` `[U]` and plumb optional work-item context without forwarding it yet. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | Q2 and N2 first; B1 waits. Own `quote-workflow-panel.tsx`, `nava-pane.tsx`, new host; LOC `[U]` 60–130. Test unchanged card render in `apps/mail/tests/booking-card.test.tsx` `[U]`. Canary N/A; same view, not run. Revert extraction. Keep S0 mechanical. `luna`. |

| Field | Value |
|---|---|
| F · gap / need / steps | Existing prefetch already queues per complete stay [jobs:2171](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/hms-jobs.ts:2171) and requests all room types [availability:106](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/hms-availability.ts:106); missing gate checks flag/run kind, not live admission. Add live hotel-read admission check before enqueue; preserve cap and stay idempotency. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | T0; G waits. Own `apps/server-pilot/src/ai/hms-jobs.ts`; LOC `[U]` 35–90. Test denied admission creates zero jobs in [probe test:718](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/tests/hms-availability-probe.test.ts:718). Canary HRDAV read, one complete stay; pass admitted all-room snapshot, none without admission; not run. Keep flag off absent canary; don’t equate flag-on with feature. `grok`. |

| Field | Value |
|---|---|
| G · gap / need / steps | Step 4 still has separate plan selector and read-only grid [panel:1888](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:1888), [panel:2165](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:2165); combine into Stay grid with room/rate/board cells, price/rooms-left, click sets all three. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | Q1/Q2 and F first; B1 waits on G’s panel edit. Own `rate-plan-select.tsx`, `rates-bar-grid.tsx`, `quote-workflow-panel.tsx`, quote-workflow types; LOC `[U]` 140–195. Test one click updates exact tuple in `apps/mail/tests/quote-workflow-panel.test.tsx` `[U]`. Canary HRDAV read; pass selected tuple matches Stay draft, no write; not run. Stale availability is not quote authority; keep Other/overrides. `luna`. |

| Field | Value |
|---|---|
| B1 · gap / need / steps | Client contract lacks Market Segment and `guestoptin4`; Track/SOB already exist [bind:75](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/lib/quote-workflow/pane-stay-bind.ts:75), [card:939](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/booking-card.tsx:939). Add generic controls and pass work-item/saved-stay props through extracted host. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | G and Q3 first; B2 waits. Own `booking-card.tsx`, `pane-stay-bind.ts`, `quote-booking-host.tsx`; LOC `[U]` 80–150. Test fields and caller props in [booking test:367](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/tests/booking-card.test.tsx:367). Canary synthetic HRDAV Labtest preview only; pass no consent unless staff opts in; not run. Never pre-check legal consent; don’t duplicate Track/SOB. `luna`. |

| Field | Value |
|---|---|
| B2 · gap / need / steps | Server create input lacks the requested fields [route:70](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/trpc/routes/quote-workflow.ts:70); schema request keys omit them [schema:101](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/tooling/playwright-quote/create-tool.schema.json:101). Validate/map Market Segment and `guestoptin4`; derive options/requirements from property profile, not hotel branches. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | B1 first; L1 and Lease-W wait. Own `quote-workflow.ts`, `pane-stay-save.ts`, `create-lab-stay.mjs`, `create-request.mjs`, `create-tool.schema.json`, property profiles; LOC `[U]` 100–180. Test missing-field refusal before spawn in `apps/server-pilot/tests/pane-stay-save.test.ts` `[U]`. Canary HRDAV Labtest preview only; pass fields survive serialization, no save; not run. Keep guest opt-in explicit and property-configured. `grok`. |

| Field | Value |
|---|---|
| H1 · gap / need / steps | `work_event` already stores AI value/source and staff value [work schema:175](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/db/schema/work.ts:175); add mailbox-scoped latest-per-field provenance query; no new table. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | Start T0; H2 waits. Own `work-items.ts`, `routes/work-items.ts`; LOC `[U]` 80–150. Test latest source/value in [work-items test:1051](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/tests/work-items.test.ts:1051). Canary N/A HMS; synthetic work item, pass source labels match events; not run. Hide unknown provenance, don’t infer AI from current value. `luna`. |

| Field | Value |
|---|---|
| H2 · gap / need / steps | Pane evidence records no per-field provenance UI [evidence:58](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/docs/research/2026-10-25-pane-prefetch-and-ui-evidence.md:58); add sparkle/source label beside each editable to-do field, driven only by H1 response. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | H1 first; I waits on shared screen component. Own new `work-item-field-provenance.tsx`, `screens/needs-you.tsx`; LOC `[U]` 70–120. Test source marker by AI/edit/reset state in new `apps/mail/tests/needs-you.test.tsx` `[U]`. Canary N/A HMS; synthetic work item, pass labels persist across reopen; not run. Unknown source shows no sparkle. `luna`. |

| Field | Value |
|---|---|
| I · gap / need / steps | Existing `acceptUneditedFields` only records untouched fields [work-items:1838](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/work-items.ts:1838); add atomic section reset to extraction values, update state, append reset events for changed fields. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | H2 first; J1 waits. Own `work-items.ts`, `routes/work-items.ts`, `schema/work.ts`, `screens/needs-you.tsx`; LOC `[U]` 100–180. Test reset changes only selected section and appends events in `apps/server-pilot/tests/work-items.test.ts` `[U]`. Canary N/A HMS; synthetic work item, pass edited fields revert; not run. Reuse same event table; skip fields with no AI value. `luna`. |

| Field | Value |
|---|---|
| J1 · gap / need / steps | Events are append-only [immutability test:45](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/tests/work-event-immutability.test.ts:45); add transactional per-work-item revision and server undo/redo events, never mutate history. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | I first; J2 waits. Own `work-items.ts`, `routes/work-items.ts`, `schema/work.ts`, one migration; LOC `[U]` 130–195. Test undo then redo restores values with two appended events in `apps/server-pilot/tests/work-items.test.ts` `[U]`. Canary N/A HMS; synthetic item; not run. One `work_event` table, not a second undo table; no HMS side effects undo. `grok`. |

| Field | Value |
|---|---|
| J2 · gap / need / steps | No per-to-do server history controls; add Undo/Redo affordance using J1 server cursor, no UI-only stack [current event flow:route:137](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/trpc/routes/work-items.ts:137). |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | J1 first; L1 waits on shared server state file. Own `screens/needs-you.tsx`, `use-work-item.ts`, new `work-item-history-controls.tsx`; LOC `[U]` 50–110. Test controls disable at history boundary in new `apps/mail/tests/needs-you.test.tsx` `[U]`. Canary N/A HMS; synthetic item; not run. Keep controls inside to-do component, not root pane. `luna`. |

| Field | Value |
|---|---|
| K1 · gap / need / steps | PDF currently runs as a synchronous mutation [workstation:1407](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/trpc/routes/workstation.ts:1407); add durable job keyed by work item plus quote revision, queryable after client disconnect. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | Start T0; K2 and M1 wait on shared worker. Own new `quote-pdf-jobs.ts`, `routes/workstation.ts`, `ai/worker.ts`; LOC `[U]` 120–190. Test duplicate key returns one persisted result in new `apps/server-pilot/tests/quote-pdf-jobs.test.ts` `[U]`. Canary HRDAV read quote; pass same artifact after restart; not run. Prefer existing durable run ledger if it supports payload/result `[U]`; do not add a one-off queue. PDF only, no send/attach. `grok`. |

| Field | Value |
|---|---|
| K2 · gap / need / steps | `pdfPending` is root-local state [pane:1437](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/nava-pane/nava-pane.tsx:1437); make extracted hook poll/rehydrate K1 job by work-item ID after mail/pane switch. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | K1 and N2 first. Own `use-quote-pdf-job.ts`, `reply-body.tsx`; LOC `[U]` 60–120. Test switch away/back rehydrates original job in [PDF test:194](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/tests/outlook-pane-quote-pdf.test.tsx:194). Canary HRDAV read quote; pass same job/artifact after switch; not run. Preserve revision/owner checks; don’t regenerate on remount. `luna`. |

| Field | Value |
|---|---|
| L1 · gap / need / steps | Preview route discards stay/work-item IDs [route:281](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/trpc/routes/quote-workflow.ts:281); preview grants are process-memory only [save:363](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/pane-stay-save.ts:363). Persist preview result/grant by work item, stay, and digest; expire or invalidate on input change. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | B2 and J2 first; L2/M1 wait. Own `work-items.ts`, `pane-stay-save.ts`, `routes/quote-workflow.ts`; LOC `[U]` 100–180. Test preview survives service restart and digest change invalidates in [save test:399](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/tests/pane-stay-save.test.ts:399). Canary HRDAV Labtest preview, no save; pass restored preview; not run. Persist digest/status, never reusable secret token; stale means fresh preview. `grok`. |

| Field | Value |
|---|---|
| L2 · gap / need / steps | Booking preview state is React-local [card:713](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/booking-card.tsx:713); rehydrate L1 preview when card remounts using work-item/stay identity and digest. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | B1 and L1 first; M2 waits on shared card. Own `booking-card.tsx`, new `use-pane-stay-preview.ts`; LOC `[U]` 60–120. Test preview restores on remount in [booking test:266](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/tests/booking-card.test.tsx:266). Canary HRDAV Labtest preview only; pass preview persists, no Save; not run. Digest mismatch clears preview. `luna`. |

| Field | Value |
|---|---|
| M1 · gap / need / steps | Commit is synchronous today [route:289](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/trpc/routes/quote-workflow.ts:289); add persisted idempotent job keyed by property/work-item/stay/digest; ambiguous result becomes readback/needs-check, never blind replay. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | B2, K1, L1 first; M2 waits. Own new `pane-stay-commit-job.ts`, `ai/worker.ts`, `routes/quote-workflow.ts`, `pane-stay-save.ts`, `work-items.ts`; LOC `[U]` 140–195. Test concurrent same-key requests cause one create in `apps/server-pilot/tests/quote-workflow-router.test.ts` `[U]`. Canary HRDAV Labtest create/readback only, owner-approved; pass one confirmation for retries; not run. Keep `hms-jobs.ts` for reads [jobs:2167](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/hms-jobs.ts:2167); dedicated write job means F is its sole DS4 consumer. `grok`. |

| Field | Value |
|---|---|
| M2 · gap / need / steps | Make Book click submit/poll M1 job; repeat click reuses same job, not second create [card:808](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/booking-card.tsx:808). |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | M1 and L2 first. Own `booking-card.tsx`, new `use-pane-stay-job.ts`; LOC `[U]` 60–130. Test repeat click while pending invokes one job in `apps/mail/tests/booking-card.test.tsx` `[U]`. Canary HRDAV Labtest only; pass one confirmation/readback; not run. Keep commit disabled outside Labtest mode. `luna`. |

| Field | Value |
|---|---|
| Lease-0 · gap / need / steps | Slot owner launches persistent context but no authenticated page [owner:79](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/tooling/playwright-quote/slot-owner.mjs:79); build exclusive page lease wrapper, verify shell/property, lock/recovery generation, release safely. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | Start T0; read/write rollouts wait. Own `slot-owner.mjs`, `session-reuse.mjs`, `src/hms/property-read-lock.ts`, new `hms-slot-lease.mjs`; LOC `[U]` 120–195. Test same page + stale-generation refusal using [slot test:56](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/tests/hms-slot-session.test.ts:56). Canary HRCEN+HRDAV read-only; pass authenticated same-property lease; not run. Current code already reuses 0600 storageState [reuse:32](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/tooling/playwright-quote/session-reuse.mjs:32), but creates new page; dated “no reuse” note is stale. Exclusive lock required; fail closed unknown property. `grok`. |

| Field | Value |
|---|---|
| Lease-R · gap / need / steps | Several read CLIs still create pages/login separately [reuse test:178](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/tooling/playwright-quote/session-reuse.test.mjs:178); switch every read caller to Lease-0 and require explicit registered property. |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | Lease-0 first; write rollout can parallel after core. Own `fetch-quote.mjs`, `party-lookup.mjs`, `property-profile.mjs`, `find-batch.mjs`, `stay-lookup.mjs`, `read-reservation-codes.mjs`, `read-reservation-fields.mjs`, `create-preflight.mjs`, `hms-deeplink-probe.mjs`; LOC `[U]` 120–190. Test omitted property rejects and read calls share lease in new `session-lease-read-tools.test.mjs` `[U]`. Canary both properties, read-only; pass correct property and one lease per tool; not run. Remove HRCEN defaults [party:187](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/tooling/playwright-quote/party-lookup.mjs:187), [profile:70](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/tooling/playwright-quote/property-profile.mjs:70); resolve registry. `grok`. |

| Field | Value |
|---|---|
| Lease-W · gap / need / steps | Write tools still create/login their own page; migrate create/amend/cancel/attach callers to same exclusive wrapper; remove create default [create:56](/home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs:56). |
| Depends/waits · files/LOC · test · canary · risk/fallback · pushback · coder | Lease-0 and B2 first; B2 owns create contract, this rollout owns lease callsites. Own `create-lab-stay.mjs`, `amend-stay.mjs`, `cancel-stay.mjs`, `cancel-lab-stay.mjs`, `attach-document.mjs`; LOC `[U]` 110–190. Test missing property refuses before page/write in new `session-lease-write-tools.test.mjs` `[U]`. Canary only preapproved property Labtest; pass one operation/readback through lease; not run. No HRCEN CLI defaults or fallback; unknown property refuses. `grok`. |

DAG: `Q1→Q2→Q3→B1→B2→L1→M1→M2; Q2+F→G→B1; N1→N2→Q3,K2; H1→H2→I→J1→J2→L1; K1→K2,M1; L1→L2→M2; Lease-0→Lease-R,Lease-W; B2→Lease-W.`  
T0: `S0-Q1, S0-N1, F, H1, K1, Lease-0`. Longest chain: 8 slices / 7 edges.