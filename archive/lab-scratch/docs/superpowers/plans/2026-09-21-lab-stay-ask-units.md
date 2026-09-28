# Lab stay-ask units + typed highlights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centurion lab shows PMS stay-asks (one Hotel Availability / create write each), paints the actual tokens in the mail body, never puts a year in `roomQty`, and keeps gold visible on long threads.

**Architecture:** Keep mailbox `threadId`. Lab unit of discrepancy is a **StayAsk** (arrival+departure+roomQty+roomType), not one flattened `request` object. Deterministic Arrive/Depart/Rooms parser first; Luna only fills leftover messy bodies. Schema pane is one card per StayAsk. Inbound highlights from stay-ask values, not only stored span offsets. Gold pane is always on screen.

**Tech Stack:** Existing mail lab SPA (`apps/mail/lib/lab`, `apps/mail/components/lab`), sanitize script, private lab index overlay. No RDS. No HMS cutover.

## Global Constraints

- Overlay mail SPA + private `/var/lib/nava-pilot/lab-centurion-index.json` only. Live git branch stays `feat/outlook-setup-download-button`.
- No ops-deploy of `feat/centurion-dashboard-tools`. No public `lab-centurion-index.json` on nginx.
- `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before every Vitest. No freeze `neededCount` rewrite.
- No PII in SSM/Git/logs. Client-authorized bodies OK in local files.
- No commit unless the user later asks. Overlay is the live proof.
- Standard (non-fast) subagents only.

## Autonomous Execution Mandate

**User granted autonomous execution for this plan.** Continue until the plan goal and done criteria are verified or a true blocker is reached. Do not pause for routine choices.

### Decision authority

- Choose best safe reversible option without asking.
- Better route to accepted goal may be taken; log what changed and why.
- Preserve requirements. Do not silently cut scope.
- Use standard non-fast subagents only; otherwise work inline.
- Grill answers are settled in this plan (user sleeping). Do not re-ask.

### RCA loop

FAIL → reproduce minimally → identify root cause and mechanism → research unfamiliar behavior when useful → choose smallest correct fix → test → resume plan.

### Safety

- Follow repository rules and project overlays.
- Never force-push protected branches, bypass hooks, use destructive git, expose secrets/PII, or weaken safety guards.
- Tests requiring databases use disposable non-production databases only.
- Irreversible or production-data-affecting ambiguity is a true blocker.

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Overlay | S3 `git-bundles/` + private index; not `ops-deploy.sh` for this lab SPA |

**Forbidden:** force-push main, `--no-verify`, destructive git, Vitest against pilot RDS, `VITEST_ALLOW_PILOT_RDS=1`, sourcing `.env.production` into tests, HMS reservation mutation.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### Done criteria

- [x] CIDB urgent quote: two StayAsk cards (2 singles 15–17 Sep; 7 singles 15–18 Sep); `roomQty` never `2026`; departure never a JSON array
- [x] Those date/qty/roomType tokens marked in the inbound body (`data-field`)
- [x] Maruleng: gold staff reply visible without scrolling past an 8k inbound (split/sticky gold); prior inbound visible; multiple stay-asks if the thread contains multiple date ranges
- [x] Schema Input uses current StayAsk only; Output still gold/HMS only (no inbound echo)
- [x] Illegal span fields stay gone; interesting enum-only
- [x] Dual-plane overlay: unauth 401 / auth 1069; no public index JSON
- [x] Vitest green (`apps/mail/tests/centurion-eval-lab.test.tsx`, `apps/server-pilot/tests/centurion-eval-lab.test.ts`)
- [x] No unresolved blocker affecting plan goal

### True blockers

Stop only for missing credentials/access, human-only interaction, destructive ambiguity, safety-policy conflict, or execution-backend down after retries.

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?"

---

## Settled grill (answered without user)

1. **Lab unit** = StayAsk (PMS write), not mail pair. Thread stays the conversation.
2. **One inbound, N StayAsks** when the body has multiple Arrive/Depart/Rooms (or multiple date ranges).
3. **Pink body marks** = exact value tokens for the selected StayAsk (plus other asks dimmer or all asks marked). Schema fill is not a substitute for body marks.
4. **Gold always visible** on `gold_human` — split pane, inbound cannot bury it.
5. **roomQty** = integer 1–40. Years (`19xx`/`20xx`) and JSON arrays are invalid.
6. **No mailbox schema change.** `stayAsks[]` on lab row only.
7. **Deterministic parser first**, Luna leftover only.
8. **Overlay not ops-deploy.** Same as prior lab chrome work.

## Critique of previous extract loop (do not repeat)

| Miss | Why | Fix now |
|------|-----|---------|
| One `request` object | Forced two CIDB stays into `departure: [17,18]` + stolen year `roomQty: 2026` | StayAsk[] |
| Schema pink ≠ body pink | Inbound `highlightedHtml` used stored spans only; CIDB had 1 gold span | Paint from stay-ask values |
| Harvest dates, not qty | `2026` from `15 September 2026` matched `roomQty` | Typed coerce |
| Gold under 8k inbound | Single scroll stack | Sticky/split gold |
| Thread = one inbound row | Maruleng prior ask + later ask look like one tool | StayAsks from inbound+prior; timeline still mail |

**Better prompt would have been:** “Show every PMS stay I would type, mark those tokens in the body, never flatten two bookings, never use years as qty, never hide gold.” Not “pink vs blue fields.”

## File map

- Modify: `apps/mail/lib/lab/centurion-eval.ts` — StayAsk type, coerce, split, locate, projectLabFills(askIndex)
- Modify: `apps/mail/components/lab/centurion-eval-lab.tsx` — ask tabs, inbound value highlights, gold split
- Modify: `apps/server-pilot/src/ops/centurion-eval-lab.ts` — same parser (shared logic duplicated small or imported via copy of pure fns)
- Modify: `apps/server-pilot/scripts/centurion-eval-sanitize-lab.ts` — write stayAsks, coerce request
- Test: `apps/mail/tests/centurion-eval-lab.test.tsx`
- Test: `apps/server-pilot/tests/centurion-eval-lab.test.ts`
- Docs: `docs/infor-hms/CONTEXT.md` — StayAsk glossary

## Ponytail ceiling

- No booking table, no new route, no thread-id rewrite.
- Parser is regex on Arrive/Depart/Rooms + existing harvestStayDates. No NLP library.
- Duplicate tiny pure functions mail↔pilot OK; do not extract a package.

## Eng-review edges

- Two Arrive blocks same arrival different departure → two asks
- “9 SINGLES” in subject but body 2+7 → body wins, subject is total
- Gold usedResult still empty unless gold quotes HMS — Output ∅ is correct
- Maruleng officials list: occupancy may stay empty if no count; do not invent 2026

---

### Task 1: StayAsk parser + typed coerce (RED then GREEN)

**Files:**
- Modify: `apps/mail/lib/lab/centurion-eval.ts`
- Modify: `apps/server-pilot/src/ops/centurion-eval-lab.ts`
- Test: `apps/mail/tests/centurion-eval-lab.test.tsx`
- Test: `apps/server-pilot/tests/centurion-eval-lab.test.ts`

**Interfaces:**
- `StayAsk { arrival?: string; departure?: string; roomQty?: number; roomType?: string }`
- `splitStayAsks(text: string): StayAsk[]`
- `coerceLabValue(field: string, value: unknown): unknown | undefined`
- `coerceRoomQty(value): number | undefined` — 1–40 only

- [x] RED: CIDB fixture body → two asks; roomQty 2 and 7; reject 2026; array departure not a fill
- [x] GREEN parser + coerce
- [x] `projectLabFills(row, tool, askIndex)` uses ask[i] for Input

### Task 2: Inbound highlights from values + gold split pane

**Files:**
- Modify: `apps/mail/components/lab/centurion-eval-lab.tsx`
- Test: `apps/mail/tests/centurion-eval-lab.test.tsx`

- [x] RED: inbound `data-field="arrival"` for `15 September 2026`; `data-field="roomQty"` for `2` in Rooms line not year
- [x] GREEN: `highlightedHtml` merges spans + `valuesToSpans` for selected ask (and other asks)
- [x] Gold `lab-gold-body` visible in split layout (`data-testid="lab-gold-split"`)

### Task 3: Sanitize index + overlay

**Files:**
- Modify: `apps/server-pilot/scripts/centurion-eval-sanitize-lab.ts`

- [x] Every row: stayAsks from inbound+prior+attach; coerce request; drop year qty; scalar dates
- [x] Counts-only: stayAskRows, roomQtyYearsDropped, arrayDeparturesDropped
- [x] Overlay private index + mail SPA; dual-plane 401/1069; no public index

### Task 4: Luna leftovers (only if parser coverage < cited threads)

- [x] If CIDB+Maruleng parser-complete, skip Luna
- [ ] Else GOLD_STAY_ASK prompt, ≤7 Luna, QA, merge
