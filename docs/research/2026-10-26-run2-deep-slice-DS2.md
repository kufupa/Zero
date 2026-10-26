Five slices; each estimated below 200 changed product lines [U]. No tests or HMS canary run. CodeGraph warned its index targets another checkout; source findings below use the requested worktree. No `-o` path was supplied, and the workspace is read-only, so this report is inline.

### DS2-S1 — Party prefetch and durable readback

| Field | Value |
|---|---|
| What is missing | Party selection remains quote-only ([hms-jobs.ts:489](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/hms-jobs.ts:489>), [hms-jobs.ts:514](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/hms-jobs.ts:514), [hms-jobs.ts:2287](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/hms-jobs.ts:2287>)); party readback expires after 24h ([hms-jobs.ts:208](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/hms-jobs.ts:208), [hms-jobs.ts:4143](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/hms-jobs.ts:4143>)). Prior evidence reports no background quote result for the 07:42 DV mail ([pane evidence:14](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/docs/research/2026-10-25-pane-prefetch-and-ui-evidence.md:14>)); whether it lacked an admission snapshot is [U] ([L2:12](/tmp/shape1025/L2.md:12)). Scheduler returns when snapshot is absent ([hms-jobs.ts:2664](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/hms-jobs.ts:2664)). |
| What it needs | Eligible, live-admitted actionable mail gets a property-scoped party read; old result stays readable with its timestamp. |
| Exact steps | Use `NEEDS_YOU_KINDS` as the kind baseline ([work-items.ts:1953](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/work-items.ts:1953>)); broaden both quote-only gates; retain inbound, spam/history, self-mail, queue/cap, and admission guards. Surface skip reasons; do not silently bypass missing admission. Remove the party age filter; preserve `createdAt`/`asOf`. Replace the hard-coded cross-property refusal copy ([hms-jobs.ts:2810](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/hms-jobs.ts:2810>)). |
| Depends on / waits on | None; S2 waits for this readback contract. |
| Files owned | `apps/server-pilot/src/ai/hms-jobs.ts`; `apps/server-pilot/tests/hms-jobs.test.ts`. |
| LOC range | 90–190 product LOC [U]. |
| Test | One table-driven queue/readback behavior in `hms-jobs.test.ts`; extend the current age and prefetch seams ([test:2173](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/tests/hms-jobs.test.ts:2173>), [test:3055](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/tests/hms-jobs.test.ts:3055>)). |
| Live canary | [U] Not run. Read-only Labtest for every active registry property ([hms-read-target.ts:96](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/hms/hms-read-target.ts:96>)); pass = admitted test mail yields a result for its resolved property, no writes. |
| Risk + fallback | Keep the snapshot guard; missing snapshot means no backfill HMS read. No candidate or disabled queue stays an explicit skip, not a guessed party. Exact 07:42 cause remains [U]. |
| Architecture pushback | `system_notice` is excluded from the Needs-you list ([work-items.ts:1970](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/work-items.ts:1970>)), yet a direct-agent quote prefetch is tested ([hms-jobs.test.ts:3043](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/tests/hms-jobs.test.ts:3043>)); preserve or change that exception deliberately. No third hotel `if` branch: current browser-slot type supports only two slots ([hms-read-target.ts:18](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/hms/hms-read-target.ts:18>)); next property needs registry/slot setup. |
| Coder | grok — HMS/job path. |

### DS2-S2 — Party recommendation, age, and profile confirmation

| Field | Value |
|---|---|
| What is missing | Party UI drops the V2 reason ([party-picker.tsx:299](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/party-picker.tsx:299>)) and auto-applies a bound stored result ([party-picker.tsx:695](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/party-picker.tsx:695>)). An age helper already exists ([hms-queue-status.tsx:229](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/hms-queue-status.tsx:229>)); current alternatives and editable search also exist ([party-picker.tsx:1121](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/party-picker.tsx:1121>), [party-picker.tsx:904](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/party-picker.tsx:904>)). |
| What it needs | Show “Recommended: X — because …” with age; no-match says “No match found. Closest:” and keeps type-your-own. Stored candidate is a recommendation, not a silent bind. |
| Exact steps | Carry V2 `reason` and `asOf ?? createdAt` into the view ([hms-jobs.ts:2689](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/hms-jobs.ts:2689>), [hms-jobs.ts:3870](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/hms-jobs.ts:3870>)). Replace auto-pick with explicit confirm; re-search via the existing thread/message-scoped `findParty` route ([pane-party-lookup.ts:24](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/trpc/routes/pane-party-lookup.ts:24>)) and accept only the same native ID. Reuse the existing alternatives and text input. |
| Depends on / waits on | S1. |
| Files owned | `apps/mail/components/quote-workflow/party-picker.tsx`; `apps/mail/tests/party-picker-results.test.tsx`. |
| LOC range | 45–135 product LOC [U]. |
| Test | One stored-V2-result behavior in `party-picker-results.test.tsx`: aged match shows reason/age, requires same-ID live confirmation; no-match retains closest and typed value. |
| Live canary | [U] Not run. Read-only Labtest per active registry property; pass = current profile confirms same ID, changed/missing ID stays unbound. |
| Risk + fallback | If live verification is unavailable, keep historical result visibly aged; allow manual text, but do not bind it. |
| Architecture pushback | Interactive lookup already resolves by thread/message origin ([pane-party-lookup.ts:27](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/trpc/routes/pane-party-lookup.ts:27>)); reuse it, no hotel-name default or new special case. |
| Coder | grok — current HMS-profile verification. |

### DS2-S3 — Stored read versus live read

| Field | Value |
|---|---|
| What is missing | Normal ready stored reads skip live analysis ([nava-pane.tsx:774](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/nava-pane/nava-pane.tsx:774>), [nava-pane.tsx:775](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/nava-pane/nava-pane.tsx:775>)). But the pane dispatches `analysis_started` before checking `wait` ([nava-pane.tsx:771](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/nava-pane/nava-pane.tsx:771>)); that phase renders “Nava is reading…” ([quote-workflow-panel.tsx:98](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:98>), [quote-workflow-panel.tsx:1763](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/quote-workflow/quote-workflow-panel.tsx:1763>)). A 4s timeout settles as unavailable and ignores the late result ([use-work-item.ts:361](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/lib/quote-workflow/use-work-item.ts:361>), [use-work-item.ts:368](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/lib/quote-workflow/use-work-item.ts:368>)); that path can become live analysis ([nava-pane.tsx:799](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/nava-pane/nava-pane.tsx:799>)). |
| What it needs | “None found” distinct from “lookup pending/unknown”; no automatic live reread on timeout or transport failure. |
| Exact steps | Only confirmed `StoredWork.status === 'none'`, explicit retry, or override may start live analysis. Keep late `ready` results; represent timeout/error separately. Decide before `analysis_started`; show “Checking saved read…” while waiting. |
| Depends on / waits on | None. |
| Files owned | `use-work-item.ts`, `nava-pane.tsx`, `quote-workflow-panel.tsx`; new `apps/mail/tests/nava-stored-read.test.tsx`. |
| LOC range | 40–130 product LOC [U]. |
| Test | One pane integration behavior: stored result arriving after timeout causes zero live calls and no live-read copy; confirmed none causes one live call. |
| Live canary | [U] Not run. Dev/test mailbox on Outlook and webmail with stored work; pass = stored values render, no model call; no HMS. |
| Risk + fallback | Slow/unavailable work-item route may delay first read; offer explicit “Read live anyway”/retry rather than silently rerunning. |
| Architecture pushback | Timeout is not proof of absence; keep model invocation behind a known decision. |
| Coder | luna — small explicit state fix. |

### DS2-S4 — Expose message locators to Needs-you

| Field | Value |
|---|---|
| What is missing | Outlook sync contract carries `locator.entryId` ([contracts.ts:45](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/outlook-sync/contracts.ts:45>)); ingestion keeps the evidence under message `sourceProvenance` ([ingest.ts:142](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/outlook-sync/ingest.ts:142>), [outlook-history.ts:173](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/mail/ingest/outlook-history.ts:173>)). So the ID is stored per message as JSON, not a dedicated typed column ([mail.ts:346](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/db/schema/mail.ts:346>)). Needs-you list selects `sourceMessageId` but not the Outlook locator ([work-items.ts:1994](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/server-pilot/src/ai/work-items.ts:1994>)); client row type omits both IDs ([backend-bind.ts:228](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/lib/quote-workflow/backend-bind.ts:228>)). |
| What it needs | Return only `outlookEntryId` and canonical `sourceMessageId`; no full provenance leak. |
| Exact steps | Project `sourceProvenance.evidence.locator.entryId` in `listWorkItems`; type it nullable; expose existing `sourceMessageId`; null for legacy/non-Outlook rows. |
| Depends on / waits on | None; S5 waits on these fields. |
| Files owned | `apps/server-pilot/src/ai/work-items.ts`, `apps/mail/lib/quote-workflow/backend-bind.ts`, `apps/server-pilot/tests/work-items.test.ts`. |
| LOC range | 20–55 product LOC [U]. |
| Test | One list projection behavior: synced Outlook row returns exact entry ID plus canonical message ID; missing locator returns null. |
| Live canary | [U] Not run. Read-only synced test message per configured mailbox/property; pass = locator belongs to that row; no HMS. |
| Risk + fallback | Missing/stale entry ID shows manual-search fallback; never open a nearby message. |
| Architecture pushback | No migration needed for the current JSON path; keep Office EntryID separate from webmail message ID. |
| Coder | luna — small API projection. |

### DS2-S5 — Needs-you flag and exact-message open

| Field | Value |
|---|---|
| What is missing | Controls hide only when route is unavailable, not by feature flag ([needs-you.tsx:453](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/nava-pane/screens/needs-you.tsx:453>), [needs-you.tsx:508](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/nava-pane/screens/needs-you.tsx:508>)). Outlook currently instructs manual search ([needs-you.tsx:421](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/nava-pane/screens/needs-you.tsx:421>)); webmail opens only the thread ([mail.tsx:423](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/mail/mail.tsx:423>)). Existing Office pattern uses `displayMessageForm` ([rates-ready-notice.ts:73](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/lib/quote-workflow/rates-ready-notice.ts:73>)); current tests assert no Outlook open action ([needs-you.test.tsx:272](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/tests/needs-you.test.tsx:272>)). |
| What it needs | One default-off constant for both entries; Outlook opens exact row; webmail selects exact message, not just its thread. |
| Exact steps | Gate `NeedsYouEntry` and `NeedsYouWebControl`. Add keyboard-accessible row action calling `displayMessageForm(outlookEntryId)`. For webmail pass `sourceMessageId` with `threadId`; add exact-message selection/scroll in `ThreadDisplay`, following the existing query-state pattern ([workflow-folder-desk.tsx:30](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/mail/workflow-folder-desk.tsx:30>), [workflow-folder-desk.tsx:61](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/apps/mail/components/mail/workflow-folder-desk.tsx:61>)). Keep dismiss separate. |
| Depends on / waits on | S4. |
| Files owned | `needs-you.tsx`, `mail.tsx`, `thread-display.tsx`, `apps/mail/tests/needs-you.test.tsx`. |
| LOC range | 60–150 product LOC [U]. |
| Test | One host-specific row-navigation behavior in `needs-you.test.tsx`: flag hides entries; enabled Outlook opens EntryID; web callback carries canonical message ID. |
| Live canary | [U] Not run. Read-only test message per supported mailbox; pass = exact row opens on each host; no HMS. |
| Risk + fallback | Office API unavailable or ID missing: show manual search hint; no subject/sender-based guess. |
| Architecture pushback | Keep Outlook EntryID and webmail sourceMessageId distinct; no `nava-pane.tsx` edit needed. |
| Coder | luna — small UI/navigation slice. |

DAG: `S1 → S2`; `S4 → S5`; `S3` independent. T0: S1, S3, S4. Longest chain: two slices. No S0 needed under this ownership: only S1 owns `hms-jobs.ts`; only S3 owns `nava-pane.tsx`/`quote-workflow-panel.tsx` (monolith sizes: [speed analysis:24](</home/ubuntu/projects/zero/.worktrees/mh1024-retro/docs/research/2026-10-26-dev-speed-analysis.md:24>)). If S1 must split, add S0 before parallelizing its `hms-jobs.ts` work.