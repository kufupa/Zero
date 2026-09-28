# Centurion Branch Merge-Ready Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get `feat/centurion-dashboard-tools` organized and mergeable into `main` without interrupting the live Tool AI Pipeline chat, then land safe product slices via Greptile-reviewed PRs.

**Architecture:** Two-phase. Phase B (now) is inventory-only while `.private/pms-pipeline/ACTIVE.json` exists — no commit/push that reshuffles contended trees. Phase A (after ACTIVE cleared, or clearly disjoint paths) carves small PRs. Greptile CLI loop gates every pushed slice. Mail search outage is a separate live runtime dig (branch does not change mail search modules vs `main`).

**Tech Stack:** git worktree `feat/centurion-dashboard-tools`, Greptile CLI (`greptile review --json`), optional `greploop`, mail/pilot EC2 for search RCA, Vitest only with `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`.

## Global Constraints

- Highest priority: do not interrupt Tool AI Pipeline. While `ACTIVE.json` exists, never edit do-not-touch globs below.
- Do not commit or push merge-prep work in Phase B unless user explicitly overrides.
- Never Vitest against pilot RDS; never set `VITEST_ALLOW_PILOT_RDS`.
- `.private/` never committed. `archive/` stays historical only.
- Greptile reviews **committed** work only — commit before `greptile review --json`.
- Stop-hook ownership: `ACTIVE.json` must include `conversationId` of the pipeline chat; this merge chat must never reclaim it (hook no longer first-claims).

---

## Do-not-touch (while ACTIVE)

| Path | Why |
|------|-----|
| `.private/pms-pipeline/**` | Live party-lookup evidence + ACTIVE |
| `.cursor/skills/pms-tool-pipeline/**` | Pipeline cards (skill text OK only if user asks; prefer leave) |
| `apps/server-pilot/tooling/pms-pipeline/**` | Gate harness |
| `.cursor/hooks/pms-pipeline-stop.mjs`, `.cursor/hooks.json` | Stop loop (hook harden already landed uncommitted — leave until pipeline quiet or user asks to commit) |
| `apps/server-pilot/tooling/playwright-quote/party-lookup*` | Next pipeline outputs |
| `apps/server-pilot/tooling/playwright-quote/{quote,create}-tool.schema.json` (+ related CLIs) | Contended Stage 9 / sibling chat |
| `.cursor/skills/building-hms-playwright-tools/**` | Astra click rails |
| Shared Chromium / SSM tunnel | Browser owner |

---

## Branch snapshot (lock date 2026-09-24)

- Branch: `feat/centurion-dashboard-tools` (~208 ahead / ~113 behind `origin/main`)
- No open PR; 2 local commits ahead of `origin/feat/centurion-dashboard-tools`
- Huge dirty tree (HMS, lab, eval scripts, untracked tooling)
- Already archived: `archive/stagehand/`, `archive/wave-a-probes/`
- Mail search modules vs `main`: **no diff** — UI string `Unable to load search results. Please retry.` is runtime `listThreads` failure, not a branch code regression

### Mental buckets

1. **Product-ish (later Phase A candidates):** Centurion dashboard / mail / Outlook onboarding / lab HITL (disjoint from pipeline globs)
2. **WIP pipeline:** party-lookup — other chat owns
3. **Research leftover:** eval/probe scripts, private evidence — do not blind-squash into `main`

---

## Phase B — Inventory only (NOW)

### Task 1: Write merge inventory ledger

**Files:**
- Create: `docs/superpowers/plans/handoff-reports/2026-09-24-centurion-branch-merge-inventory.md`

- [ ] List committed themes vs `origin/main` (outlook, lab HITL, HMS read, docs) in 5–10 bullets
- [ ] List dirty/untracked clusters: keep / archive-candidate / never-commit
- [ ] Confirm do-not-touch list still matches ACTIVE tool
- [ ] Record “how far from main”: ahead/behind counts + rebase risk note (113 behind)
- [ ] **No commit**

### Task 2: Search outage RCA (read-only)

**Files (read only unless fix approved):**
- `apps/mail/components/mail/mail-list.tsx` (error UI)
- `apps/mail/hooks/use-threads.ts`
- `apps/server-pilot/src/trpc/routes/mail.ts` (`listThreads`)
- `apps/server-pilot/src/mail/search/*`

- [ ] Confirm `git diff origin/main --` on those paths stays empty (or note intentional delta)
- [ ] Document repro steps for pilot UI: Network tab `mail.listThreads` status/code
- [ ] EC2 read-only: branch tip, SPA overlay stamp vs API SHA (no `ops-deploy.sh`, no overlay)
- [ ] Write findings into inventory ledger section “Search”
- [ ] **No product fix commit in Phase B** unless user escalates and path is non-pipeline

### Task 3: Gate on pipeline quiet

- [ ] Poll only: `test ! -f .private/pms-pipeline/ACTIVE.json` (or `DONE.md` present + ACTIVE deleted)
- [ ] Do not run `pipeline.mjs next`, do not Astra, do not reclaim `conversationId`
- [ ] When quiet → Phase A

---

## Phase A — Safe slices + Greptile (AFTER ACTIVE clear)

### Task 4: Reconcile with main (slice branch)

- [ ] Fetch `origin/main`
- [ ] Create slice branch from updated base, e.g. `feat/outlook-onboarding-slice` **or** cherry-pick agreed commits onto fresh branch from `main`
- [ ] Prefer cherry-pick / path-filtered PR over merging entire 208-commit tip
- [ ] Resolve conflicts only in slice paths

### Task 5: First product slice PR (default: Outlook onboarding)

**Likely paths (adjust from inventory):**
- `apps/mail/components/settings/outlook-setup-download.tsx` (+ test)
- Related mail settings / demo docs already committed on tip
- **Exclude** all do-not-touch + HMS pipeline leftovers

- [ ] Ensure tests for slice pass with DB vars unset
- [ ] Commit slice only
- [ ] Push slice branch
- [ ] `greptile review -b main --json` (or `greploop` until clean)
- [ ] Triage P0/P1; fix; commit; push; re-review
- [ ] Open PR → `main`

### Task 6: Repeat Greptile loop for next safe slices

Order (revisable from inventory):
1. Outlook / mail onboarding
2. Lab HITL Proposed rail (if disjoint)
3. HMS read-tool product (only after pipeline DONE and quote schemas stable)
4. Docs/solutions worth keeping

Each slice: commit → push → Greptile → fix → PR.

### Task 7: Defer / never-merge cleanup

- [ ] Move or document eval/probe scripts under `archive/` or leave untracked
- [ ] Ensure `.private/` gitignored
- [ ] Do not squash research noise into `main`

---

## Greptile loop (every Phase A slice)

```bash
# after commit+push on slice branch
greptile whoami | grep -q '^Not signed in' && echo 'needs login'
greptile review -b main --json
# triage securityIssue → P0 → P1 → P2
# fix → commit → push → review again
# optional: greploop skill until confidence 5 / empty comments
```

---

## Out of scope

- Finishing party-lookup / PMS pipeline stages
- Blind merge of full `feat/centurion-dashboard-tools` tip
- Pilot RDS Vitest
- Lab SPA overlay deploy from this branch while EC2 gate forbids it

---

## Success criteria

- [ ] Inventory ledger exists; team knows buckets + distance from `main`
- [ ] Pipeline chat never stolen again by this worktree’s merge chat
- [ ] At least one Greptile-clean PR merged (or open) for a safe product slice
- [ ] Search RCA documented; fix only if root cause proven outside pipeline trees
- [ ] Remaining HMS/tooling path has an explicit “wait for pipeline DONE” note
