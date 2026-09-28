# Centurion branch merge inventory — 2026-09-24

Worktree: `feat/centurion-dashboard-tools`  
Policy: Phase **B** (inventory only) while Tool AI Pipeline ACTIVE. No commit/push for merge-prep unless user overrides.

## Distance from main

| Metric | Value |
|--------|-------|
| Ahead of `origin/main` | ~208 commits |
| Behind `origin/main` | ~113 commits |
| Open PR | none |
| Local unpushed on feature remote | 2 commits |
| Diff size (committed range) | ~379 files, +115k / −7k |

**Rebase risk:** High if merging whole tip. Prefer path-filtered / cherry-pick slices onto fresh `main`.

## Pipeline lock

- ACTIVE: `party-lookup` @ conversation `75ca050d-…`
- Hook harden (uncommitted in this worktree): no first-claim; foreign stops → `{}`
- Do-not-touch: see plan `docs/superpowers/plans/2026-09-24-centurion-branch-merge-ready.md`

## Already archived

- `archive/stagehand/` — superseded Stagehand quote spike
- `archive/wave-a-probes/` — one-off HMS discovery scripts

## Committed themes vs main (high level)

1. Centurion dashboard / read-tools / drafting execution trail
2. HMS live read expansion (folio, notes, guest stay, hotel availability / quote)
3. Centurion nine-day corpus / gold / quarantine tooling
4. Lab HITL Proposed stack / rails
5. Outlook onboarding + quote tool demo (recent tip commits)
6. Flow C shotgun design docs/gallery
7. Docs/solutions for live proof packaging, negative gates

## Dirty / untracked clusters (working tree)

| Cluster | Disposition |
|---------|-------------|
| `.private/**` | never commit |
| `tooling/pms-pipeline/**`, `.cursor/skills/pms-tool-pipeline/**`, hooks | pipeline — leave until DONE |
| `tooling/playwright-quote/**` contested | leave until pipeline quiet |
| `scripts/centurion-eval-*`, gold/probe scripts | research; archive or omit from PRs |
| `apps/server-pilot/src/hms/connected-*` + tests | product later; after pipeline DONE |
| `apps/mail` outlook/lab deltas | Phase A slice candidates |
| `__pycache__/` | ignore |

## Search outage (“Unable to load search results. Please retry.”)

- UI: `apps/mail/components/mail/mail-list.tsx` when `threadsQuery.isError`
- **2026-09-24 live EC2:** git `main` @ `b36a007f`; RDS **has** `message_reaction`. Empty inbox ≠ missing reactions.
- **Live http logs:** `TRPCError: no session` (auth) — strongest current inbox-list lead.
- **This branch:** reactions restored in `7ce78765` via `0028_message_reaction` (merge parity; avoid `0023` clash with read_tool). **Do not** ops-deploy whole feature branch over `main`.
- Historical noise: some ai-worker logs `column read_request does not exist` (feature-branch schema vs DB) — workers, not `listThreads`.
- Next: fix session/auth for mailboxProcedures; confirm Network `mail.listThreads` returns UNAUTHORIZED/no session.

## Phase A slice order (after ACTIVE clear)

1. Outlook onboarding / settings download (mail-only)
2. Lab HITL Proposed (if still disjoint from pipeline)
3. HMS read product + quote schemas (only post-pipeline)
4. Keep-worthy docs/solutions

## Status

- [x] Strategy locked: B now → A later
- [x] Plan written
- [ ] Search live RCA (needs pilot access / user repro)
- [ ] ACTIVE cleared → start Task 4+
