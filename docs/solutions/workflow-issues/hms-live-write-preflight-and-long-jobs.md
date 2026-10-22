---
title: Live HMS writes need a read-only preflight, a background runner and the right deploy tree
date: 2026-10-22
category: workflow-issues
module: server-pilot-hms / pane-write-tools
problem_type: workflow_issue
component: development_workflow
severity: high
tags: [hms, labtest, create, amend, preflight, ssm, deploy]
applies_when:
  - "First Labtest Save on a property or write type (create, amend, cancel)"
  - "Any HMS job that can run longer than a few minutes (field dumps, amend preview)"
  - "An orchestrator or lane runs ops-deploy.sh"
symptoms:
  - "Save attempts fail one by one before Save is clicked: vanished JS dialog, 'no rooms or openings' box, Guest Stay node off-screen, message box during fill, refused_save_pre_save_search_unavailable, refused_save_blank_required"
  - "Da Vinci only: 'Page contains errors' because Reservation Note is required"
  - "Synchronous SSM command times out at 10-15 min while HMS is still working"
  - "Deploy runs from a lane worktree instead of .worktrees/recover-parse-failure"
---

# Live HMS writes: preflight, background runner, deploy tree

## Problem

Live HMS write proofs ran far over plan two runs in a row:

| Run | Planned | Actual | Cause |
|---|---|---|---|
| SR3 (HRCEN create) | 35 min | 140 min to first Save click, 184 min to first confirmation number | 8 pre-Save failures, each found one at a time |
| DV install (HRDAV create) | in 150 min run | 73 min, 7 runs, 2 Saves, 0 bookings | availability → off-screen nav → required Reservation Note → Save hang |
| SR3 amend | 35 min | 0/2 | synchronous SSM timed out at 10 and 15 min |

The code was not the problem. Each attempt found the next blocker, because no step reported every blocker at once.

## What works

1. **Read-only preflight before the first Save** on a property or write type. One run reports every blocker:
   - fresh page (navigate home or re-login, no leftover screen)
   - exact-date room + rate availability shop, including restrictions
   - required fields on the commit screen (property-specific, e.g. DV Reservation Note)
   - duplicate/pre-save search in the same browser context
   - nav node visible in the viewport

   SR3: the first clean Save came 3 min after a fresh page + availability shop (06:33 → 06:36Z).
2. **Long HMS jobs never run through synchronous SSM.** Start them with `systemd-run` on EC2 and poll a result file.
3. **Deploy only from `.worktrees/recover-parse-failure`.** SR3 completed one deploy from a lane tree and started a second. A text rule failed twice, so a code guard in `ops-deploy.sh` is the fix.
4. **Readback is a pass bar.** `committed_unverified` with a number on screen is a bug, not a by-spec result.
5. **Budget from measured proof times**, not code medians: ≥120 min to first click and ≥180 min to first confirmed number for a new property or write type, until 3 clean nights.

## Evidence

- [SR3 retro](../../context/ledger/2026-10-22-sr3-overnight-retro.md), [SR3 proofs](../../research/2026-10-22-sr3-proofs.md)
- [DV install retro](../../context/ledger/2026-10-22-dv-install-retro.md), [Stagehand decision](../../research/2026-10-22-stagehand-hms-decision.md)
- `docs/context/MISTAKES.md` rows dated 2026-10-21 and 2026-10-22
