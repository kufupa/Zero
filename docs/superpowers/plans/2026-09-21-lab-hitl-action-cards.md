---
todos:
  - id: merge-plan
    content: Copy this plan into docs/superpowers/plans/2026-09-21-lab-hitl-action-cards.md. Single canonical file.
    status: pending
  - id: bootstrap-extract-ui
    content: PDF harvest, ProposedAction type, first Proposed rail, Luna seed all 1069. Case 1/2 are fixtures among many, not the product.
    status: pending
  - id: discovery-loops
    content: At most 5 loops. Explore the whole product (UI, features add/remove, process, extract, schema, skips). Hunt for what the human missed. 20-read every folder. Stop early only on real 10/10. Do not stop because CIDB is green.
    status: pending
  - id: holistic-handoff
    content: Come back with add/remove features, schema, process, show, extract, backtest, PMS-shaped responses. Counts in git. Examples private.
    status: pending
isProject: false
---

# Lab HITL proposed-action cards Implementation Plan

Canonical on execute: copy into [`docs/superpowers/plans/2026-09-21-lab-hitl-action-cards.md`](docs/superpowers/plans/2026-09-21-lab-hitl-action-cards.md). One file. No sibling.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Ship a **10/10** reservationist HITL from this corpus. Take initiative. **A loop = explore the whole product**, not a schema keep/drop pass. Hunt features, UI, process, extract, skips, and anything the human did not name. Ceiling **5** loops — stop when 10/10 is real; keep going if not. Pretty-wrong = fail. Right-ugly = fail. CIDB-green-only = fail.

**Architecture:** Process unit = inbound. Product unit = Proposed action. Outer clock = **≤5** whole-product discovery loops (20 inbounds per freeze folder **and** a pass over every lab surface: list, reading pane, gold, Proposed rail, empty, PDF, folders). Inner Luna max 7 concurrent / 100 waves. Staff-did = gold `usedResult`. Overlay only. Freeze **tool ids** and `neededCount` stay. Lab **features**, UI, schema **fields**, and process may add/remove when packs prove it.

**Tech Stack:** Lab SPA, private index, Luna `gpt-5.6-luna`, Poppler, Vitest, overlay via S3 git-bundles.

## What you come back with (the actual product)

One handoff when 10/10 **or** at loop 5. Counts in git. Examples in `.private`. Cover:

0. **Features to add and remove** — the point. UI, process, extract, skip rules, colors, gold, PDF, folder nav, empty states, keyboard, anything packs reveal. Include features the **human did not mention**. Ship the adds that make 10/10; kill the ones that lie (stay chips, schema dump, one-pink-for-all, thread-as-row, fake occupancy).
1. **PMS tool schema** — Input/Output fields per freeze tool vs [`LAB_REVIEW_SCHEMAS`](apps/mail/lib/lab/centurion-eval-schemas.ts). One slice of (0), not the whole review. New **tool ids** → `future_tools.jsonl` only.
2. **How we process emails** — inbound → PDF → Luna → coerce → skip/live/done/superseded.
3. **How we show them** — whole chrome, not only the right rail. Invent 10/10. Change it when a later loop notices a miss.
4. **What we pull out** — request fields + PDF pax only when the file has pax.
5. **Backtest look** — overlay on this Sep window. Cite packs.
6. **PMS-shaped responses** — Staff did = gold `usedResult`. Not live Playwright. No fake payload if gold missing.

Case 1 (one inbound, two asks) and Case 2 (thread amendment) are **seed examples of the method**. They stay as regression fixtures. They are not the goal and not the only splits to handle.

## Global Constraints

- Overlay SPA + private `/var/lib/nava-pilot/lab-centurion-index.json`. Live git stays `feat/outlook-setup-download-button`.
- No ops-deploy of `feat/centurion-dashboard-tools`. No public lab index.
- `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest. No `neededCount` rewrite. No freeze **id** add/remove.
- No PII in SSM/Git/logs/Exa. Bodies OK in local files and Luna shards.
- Commit + push + Greptile at **end of each discovery loop** if diff is real. Never `--no-verify`. Never force-push.
- Luna max 7 concurrent. 100 waves across ≤5 loops.
- No reservation mutation. CRS Check Availability forbidden as quote.
- FurtherAI = quality bar only. Clone = fail.

## Overnight Autonomous Execution Mandate

Own the 10/10. Explore more than the human did. No "which feature?" pause. A loop that only keep/drops schema fields is a failed loop.

Orchestrator + subagents: caveman ultra. Copy: Proposed, never stay chip.

Infra: EC2 `i-008f737974a9ba9b3`, RDS read-only never Vitest, overlay via git-bundles not ops-deploy.

Forbidden: force-push, `--no-verify`, Vitest against pilot RDS, HMS mutation.

Decision authority: pick best safe reversible option. Better path to the six-bullet handoff → take it. Log what changed.

RCA: FAIL → reproduce → root cause → smallest fix → test → resume.

### Done criteria

- 1069 inbounds have `proposedActions[]` (empty = skip).
- Discovery loops **≤5**. Whole-product explore each loop. Stop early only with 10/10 **feature** brief plus green overlay/tests. Quote-only / schema-only pass = fail.
- Holistic handoff written (six bullets). Git = counts + schema-field table. Private = inboundIds. No bodies in git.
- Seed fixtures still green: CIDB FW two colored Quote tools; CIDB RE live 3+6 only. These do not replace other folders.
- Staff-did Output bound to gold `usedResult` where gold exists. Unanswered = no fake PMS payload.
- PDF never `%PDF` soup. Occupancy only from file/body pax.
- Dual-plane 401/1069. Vitest green. Greptile on last loop commit addressed or waived.

True blockers: credentials, human-only, destructive ambiguity, safety, execution-backend down after retries.

## Execution Mode

Autonomous overnight. subagent-driven-development. User-facing artifact = holistic 10/10 handoff, as soon as it is real, else at loop 5.

## Units

- Left row = inbound (`inboundId`).
- Right card = Proposed action = one PMS tool for **this** inbound.
- StayAsk = hidden quote/create geometry.
- Thread id = context only.

## Explore everything (this is what a loop is)

Human named two cases. You hunt the rest. Each loop, walk **every surface**, not just schema fields:

- Left list, folder nav, outcome filters, unread/unanswered, other-desk, channel-auto
- Reading pane, gold split, quoted history, attachment/PDF, highlights
- Proposed rail, multi-tool, empty, already-quoted, needs-human, Input, Staff-did
- Extract quality, coerce, occupancy, dates, qty, names, amounts, docs
- Schema fields **and** missing verbs **and** UI affordances **and** process bugs

Ask of each inbound: what would I have missed if I only did quote-split and field keep/drop? If you notice it on loop 3, still ship it. Later notice > original prompt.

Feature add/remove is first-class. Examples of the kind of call (not a closed list): kill stay chips; add per-action colors; add Staff-did; drop schema-first dump; add skip empty; add PDF occupancy; add future-tool notes; change gold so it cannot bury the inbound; whatever the packs prove.

Ponytail still bars live HMS, `/mail` swap, freeze **id** add/remove, `neededCount` rewrite. Everything else in the lab product is in play.

Seed patterns (human-named, still required, **not sufficient**):

- Multi-ask one inbound → N color-matched tools, marks all on.
- Amendment inbound → tools for that inbound only; priors folded.
- Skip / other-desk / channel-auto → empty Proposed.
- Find+Read always-in-stack with quote/amend.
- PDF rooming list vs body-only quote.
- Folio/cancel/group/event/company/notes/send — each folder is a first-class pattern source.

Colors: per live action on this inbound (amber/teal/violet/lime). Gold/Staff-did = calm blue. Ban one-pink-for-all. Ban selected-only marks.

## Outer clock (max 5, stop early if 10/10)

```
bootstrap: PDF + type + first pane + Luna seed 1069
for L in 1..5:
  overlay
  walk every lab surface (list, gold, PDF, rail, empty, folders)
  for each freeze tool:
    read min(20, n)  (neededCount=0 → 20 false-fire suspects)
    score extract + UX + **features add/remove** + schema-field fit + Staff-did
    catalog NEW patterns including ones nobody named yet
  Luna refill on extract fail (counts toward 100)
  ship feature adds/kills + handling for every catalog row
  tests + overlay + design-review
  commit/push/Greptile if diff real
  if whole product is 10/10 (features+UI+extract+all folders): write handoff; break
if still not 10/10 after L=5: write honest handoff of remaining holes; do not pretend
```

## File map

- [`apps/mail/components/lab/centurion-eval-lab.tsx`](apps/mail/components/lab/centurion-eval-lab.tsx)
- [`apps/mail/lib/lab/centurion-eval.ts`](apps/mail/lib/lab/centurion-eval.ts)
- [`apps/mail/lib/lab/centurion-eval-schemas.ts`](apps/mail/lib/lab/centurion-eval-schemas.ts) — field lists may change; ids frozen
- [`apps/server-pilot/scripts/centurion-eval-pass6-s3-harvest.py`](apps/server-pilot/scripts/centurion-eval-pass6-s3-harvest.py)
- [`apps/server-pilot/scripts/centurion-eval-sanitize-lab.ts`](apps/server-pilot/scripts/centurion-eval-sanitize-lab.ts)
- Luna PROPOSED_ACTIONS.txt + shuffle/collate
- Tests: [`apps/mail/tests/centurion-eval-lab.test.tsx`](apps/mail/tests/centurion-eval-lab.test.tsx)
- Handoff: `docs/superpowers/plans/handoff-reports/` counts-only + `.private` packs
- Language: [`docs/infor-hms/CONTEXT.md`](docs/infor-hms/CONTEXT.md)

## Ponytail ceiling

No live PMS. No `/mail` swap. No new booking table. No NLP library. No freeze id add/remove. Schema **fields** may move. Duplicate tiny validators mail↔pilot OK.

## Tasks

### Task 1: Real PDF into Luna

Harvest layout text. `%PDF` dump → empty. `pdfPath` on shard. Empty → ≤4 page PNGs.

### Task 2: ProposedAction type (RED/GREEN)

```ts
type ProposedAction = {
  tool: string;
  title: string;
  status: 'live' | 'done' | 'superseded' | 'needs_human';
  colorIndex: number;
  request: Record<string, unknown>;
};
```

Include seed fixtures (CIDB FW/RE) plus empty skip. Body painter uses all live colors.

### Task 3: Proposed rail v1 (bootstrap UI, not final)

Outlook-shaped rail. Input fold + Staff did from `usedResult`. Quiet empty. You own making this 10/10 across loops — invent layout, split rules, empty states, colors. Do not wait for another screenshot.

### Task 4: Luna seed all 1069

Inbound + gold + prior + pdfPath. No drop.

### Task 5: Discovery loops (max 5)

The clock, not the quota. Walk **every surface**. 20 per folder. Feature add/remove first. Hunt what the prompt missed. Overlay. Commit at loop end. Stop early only on real 10/10. After 5, honest holes.

### Task 6: Holistic handoff (come back)

Write the final product: **features add/remove**, then schema, process, show, extract, backtest, Staff-did. Include later-loop notices the original prompt never named. `future_tools.jsonl` for missing verbs.

### Task 7: Final overlay proof

401/1069. Overlay still usable as the backtest of "if this had been running on that window."

## Commit / Greptile

Loop end only. No `.private` bodies, credentials, or lab index in git.
