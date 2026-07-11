---
title: Cursor Execution Backend Unavailable During Autonomous Agent Runs
date: 2026-07-08
category: workflow-issues
module: cursor-agent-tooling
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Shell, Write, or StrReplace fail with "Execution backend unavailable"
  - Read and Grep still work in the same agent turn
  - Multiple subagents or overnight swarms run in one workspace
  - Cursor auto-update (CodeSetup) is active
symptoms:
  - "Execution backend unavailable. Do not retry tool calls — the execution environment is down."
  - Write and Shell fail with zero output; StrReplace fails the same way
  - Read, Grep, and earlier Shell calls in the same turn may still succeed
tags:
  - cursor
  - agent-tooling
  - autonomous-execution
  - overnight
  - compound-engineering
---

# Cursor Execution Backend Unavailable During Autonomous Agent Runs

## Context

During an autonomous EC2 deploy wave on `EC2-pilot`, the main agent and a `ce-compound` Solution Extractor subagent both lost write/shell access at the same time (~12:19–12:20 UTC+1, 2026-07-08). The failure blocked `git push`, SSM deploy, and scratch-artifact writes under `/tmp/compound-engineering/ce-compound/`. The repo, git history, and local bash were unaffected.

This is a **Cursor agent sandbox outage**, not a bug in the zero mail pilot codebase, AWS, EC2, or RDS.

## Guidance

### Recognize the failure pattern

| Signal | Meaning |
|--------|---------|
| Exact error: `Execution backend unavailable. Do not retry tool calls — the execution environment is down.` | Cursor tool bridge down — not your app |
| Read/Grep work; Write/Shell/StrReplace fail | Lighter tools on one path; sandbox path dead |
| `git status` via Shell worked seconds earlier in same turn | Host shell fine; agent execution backend restarted |
| Multiple agents + `CodeSetup-stable-*.exe` in task list | Likely trigger: update + concurrency |

### What is NOT broken

Do not RCA your repo when you see this error:

- Git branch and commits intact
- Local `pnpm` / tests (run manually in terminal)
- EC2 / RDS / Mailpit (untouched if no SSM ran)
- Disk space (verify anyway, but unrelated to this specific error string)

### Fix (no code change required)

1. **Wait 1–5 minutes** — backend usually self-heals after Cursor restart/update.
2. **Retry the failed agent turn** — same commands; do not amend git or patch repo code for this error.
3. **Reduce concurrency before retry:**
   - Pause `t3mp3st` overnight swarms
   - Avoid parallel `ce-compound` subagents + main deploy agent in same workspace
   - Let `CodeSetup-stable-*.exe` finish before large autonomous runs
4. **Verify recovery:**

   ```bash
   # In agent Shell tool or local terminal
   echo shell_ok
   git status -sb
   ```

5. **Resume autonomous wave** from the step that failed (push, sync, gate) — not from Task 1.

### ce-compound subagent fallback

When a Phase 1 subagent cannot write scratch artifacts to `/tmp/compound-engineering/ce-compound/{run-id}/`:

- Subagent should return **full prose inline** (per ce-compound skill fallback rule).
- Orchestrator must not treat "artifact path returned" as success without `Read` confirming non-empty file.
- On Windows, `/tmp/...` may not map to a durable host path — prefer orchestrator-side `Write` to `docs/solutions/` when scratch writes fail twice.

### Prevention for overnight / EC2 waves

```text
One heavy agent per workspace during deploy
  → commit locally
  → push or bundle sync
  → SSM gates
Avoid: main agent + ce-compound + t3mp3st swarm + Cursor update simultaneously
```

Serialise deploy pushes: finish EC2 sync before starting compound documentation subagents in the same repo.

## Why This Matters

- **False alarm cost:** Agents may report "blocked on repo" or skip EC2 gates when only Cursor infra flaked.
- **Lost work is rare:** Uncommitted edits can land on disk (e.g. `eval:ci` scripts appeared in `package.json` after a failed Write turn). Always `git status` before assuming nothing changed.
- **Compound reliability:** Issue #956 class — subagents that only return inline summaries lose prose; disk-first artifacts exist because this failure mode is real.

## When to Apply

- Any agent turn where **all** mutating tools fail with the same backend message
- After Cursor version update notifications or `CodeSetup` in process list
- When 50+ terminal session files accumulate under the project metadata dir (sign of agent pile-on)
- Before blaming `pnpm`, vitest, SSM, or RDS for a sudden total loss of Write/Shell

## Examples

### Symptom timeline (2026-07-08)

```text
12:19  ce-compound Solution Extractor: 15+ Read OK
12:20  Write(solution.md) → Execution backend unavailable
12:20  Shell(mkdir)       → same error
12:20  Main agent StrReplace(package.json) → same error
12:25  New turn: Shell → shell_ok, pnpm eval:ci → PASS
```

Contributing factors observed:

- `CodeSetup-stable-3.10.20.exe` running (Cursor self-update)
- `ce-compound` subagent + main autonomous agent concurrent
- 70+ Cursor terminal session files for the workspace
- `overnight-swarm` security CLI swarm in recent logs

### Wrong response

```text
❌ "EC2 is down" — no AWS calls were made
❌ "eval:ci bug crashed Cursor" — missing script is separate; doesn't produce this error
❌ Patch repo code to "fix backend"
❌ Stop overnight mandate for a 5-minute infra flake
```

### Correct response

```text
✓ Diagnose as Cursor execution backend transient outage
✓ git status — confirm repo safe
✓ Retry push / SSM / gates when Shell works
✓ Lower agent concurrency on retry
```

### Recovery verification

```bash
cd /path/to/zero
NODE_ENV=test pnpm eval:ci   # example: confirms tool + node path healthy
git push -u origin EC2-pilot # resume blocked deploy step
```

## Related docs

- [EC2 Pilot Autonomous Deploy and SSM Gotchas](./ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) — real infra gates after agent tooling recovers
- [Autonomous Agent File Truncation Patch Fragment](./autonomous-agent-file-truncation-patch-fragment.md) — different agent failure mode (partial writes, not total backend down)
