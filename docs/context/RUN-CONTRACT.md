# Run contract (overnight or daytime autonomous run)

Written in the 2026-10-14 retro: none of the 10 autonomous runs from Oct 6 to Oct 14 finished every planned item with live proof (best: 4 of 6 on Oct 14; the Oct 13 quote pilot: 0 of 7 at its target). Every run starts from this contract. The owner approves it; the agent may not widen it.

## 1. Pick the right kind of run

| Work | Run it | Why |
|---|---|---|
| Measurable grind: eval sweeps, prompt iterations against a scored set, golden-set growth, scorer fixes, research | **Overnight**, unattended | a script decides pass/fail; no human taste or live staff needed |
| Integration that ends in a deploy + live proof, flag flips, pane UX | **Daytime**, owner reachable | proof needs prod, staff traffic, owner taste; failures at 07:00 cost the client demo |
| New feature | Never overnight unless its pass/fail check and data already exist | quote-ready (2026-10-14) was the only new feature that night and the only item still unproven at 09:00 |

## 2. Contract (fill all fields; ≤ 15 lines)

```
Outcome (staff terms): <what a reservationist no longer does>
Workflow (WIP = 1): <one PRODUCT.md workflow>
Pass bar: <metric ≥ target on <versioned set>>, from PRODUCT.md "Pass bars"
Baseline: <score of the current prod build on the same set, measured before coding>
Items (max 3, dependency order): <item → check → owner/lane>
Not this run: <list>
Critical path ETA: <ledger-scaled; longest chain incl. review + deploy + proof>
Stop: pass bar met | <time> | score flat 2 rounds | blocked-with-file:line
Deploy window: <times>; stable mark (last-good SHA + rollback) before the first deploy
Budget: $<n> by model; report actuals at the end
```

## 3. `/goal`, `/loop`, Stop hook, workflow: which one

Sources: [goal](https://code.claude.com/docs/en/goal), [scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks), [workflows](https://code.claude.com/docs/en/workflows), [hooks](https://code.claude.com/docs/en/hooks-guide) (checked 2026-10-14, Claude Code 2.1.299).

| Need | Use | Note |
|---|---|---|
| Keep working until a provable done-state | **`/goal <condition>`** | A small model judges the **transcript only**: print the proof (command + exit code + score line). Add "or stop after N turns". Run in auto mode. Judging pauses while background work runs |
| A deterministic gate that must pass before stopping | Stop hook of type `command` | Runs the scorer/tests itself; a model cannot talk past it |
| Check something on a clock (deploy up? PR checks?) | `/loop <interval> <prompt>` | `/loop` is clock-based, not "until done"; session must stay open |
| Fan out many independent items with a verify step | Workflow (`ultracode`) | Watch cost: 16 concurrent agents by default |

`/goal` template:

```
/goal <outcome>. Done when the last message prints, for the current prod SHA: `<score cmd>` → <metric> ≥ <target> on <set vN>, and each item is PASS (deployed SHA + live check after the last fix) or BLOCKED (file:line + reason). Or stop after 120 turns. Scope: only the items in docs/context/RUN-CONTRACT.md §2 of this run.
```

## 4. During the run

- Scoreboard after every step: measured numbers, PASS/BLOCKED with evidence, `$(date -u +%H:%M)` stamps.
- Checkpoint at ~40% of the window: re-estimate the critical path; **cut** to fit; never add.
- One DB-backed test suite per test DB at a time; never pipe long runs into `head`.
- Kill a lane silent > 20 min; resume it (`codex exec resume <id> "write the report now"`) instead of restarting from zero.

## 5. Closing the run

- Close every ledger row (`end`, `actual_min`, `ratio`, `outcome`, `mistake_class`).
- Update `docs/context/ACTIVE.md`; add `MISTAKES.md` rows for owner corrections and failed fixes.
- Report: pass bars before/after (same set), what is live, what is blocked (file:line), $ by model vs budget.
