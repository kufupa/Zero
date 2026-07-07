---
title: Autonomous agent truncates files by writing patch fragment as whole file
date: 2026-07-07
category: workflow-issues
module: autonomous SDD editing
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Running overnight or autonomous multi-file SDD waves with an editing agent
  - Applying plan snippets to large existing files (500+ line TSX / schema modules)
  - Multiple subagents may edit files in parallel
  - No per-file typecheck gate runs between edits
symptoms:
  - "File starts mid-symbol with no imports or export (e.g. thread-display.tsx begins at `aiDraftCandidates,`)"
  - "File has a couple imports then jumps into the middle of a props type (`replyToMessageId?:`)"
  - "Schema module holds enum/table fragments without surrounding pgTable or imports"
  - "tsc reports thousands of missing-symbol errors across many files at once"
  - "Corruption is structural (missing top and bottom of file), not random bad syntax"
root_cause: incomplete_setup
resolution_type: workflow_improvement
tags:
  - autonomous-agent
  - sdd
  - file-truncation
  - editing-tools
  - overnight
  - subagents
---

# Autonomous agent truncates files by writing patch fragment as whole file

## Context

During an autonomous overnight SDD run (contract convergence), roughly 7.5k lines
disappeared across mail UI, ingest, and some server routes. It looked like a
disaster but was **not** git, not a merge conflict, not CRLF corruption. The
editing agent applied plan snippets to large existing files incorrectly, so only
the new hunk survived and the rest of each file was dropped. Restart-from-clean-HEAD
was the correct recovery. This doc captures the failure mechanism and the
guardrails that prevent it, so a future autonomous run does not repeat it.

## Problem

An autonomous editing agent treated "insert this block" as "this block **is** the
file." The patch fragment became the whole file, hollowing out large modules while
downstream waves kept running against already-empty upstream files.

## Symptoms

- `thread-display.tsx` starts mid-hook (`aiDraftCandidates,`) — no imports, no `export function`.
- `email-composer.tsx` has two imports then jumps into `replyToMessageId?:` — middle of a props type.
- `schema/mail.ts` holds enum/table fragments **without** surrounding `pgTable` or imports.
- `tsc` eventually reports thousands of errors across 15+ files simultaneously.
- The corruption is **structural** (top and bottom of file missing), not scattered syntax noise.

## What Didn't Work / What It Wasn't

- **Git reset or force push** — ruled out; history was intact.
- **CRLF / line-ending corruption** — that is an env/bash artifact and produces
  whole-but-mangled files; here files were structurally missing their head and tail.
- **Intentional deletion** — no delete commands were issued.
- **Blaming a single bad logic change** — the pattern was uniform across unrelated
  files, pointing at the editing mechanism, not any one task's logic.

## Why This Works (Root Cause)

The corruption pattern — "only the new hunk survived" — is the fingerprint of an
editing-tool misuse, amplified by scale:

1. **`Write` on an existing file** overwrites the entire file with only the diff
   snippet. `Write` is a full-file replace; handing it a fragment truncates.
2. **`StrReplace` with a bad anchor** — the match string was too small or wrong, so
   the replacement dropped everything outside the (mis)matched region.
3. **Retry after a failed patch** — a retry chain ("split into two smaller patches")
   on a 1000-line TSX file is high-risk for partial application.
4. **Huge blast radius** — the plan touched 15+ files, many 500–1200 lines, and waves
   ran fast with **no `tsc` gate between them**, so the first corruption was never
   caught before more piled on.
5. **Parallel subagents on the same path** — two editors on one file mean last-write-wins
   with partial content.

No hard stop at the first red meant the agent kept patching downstream files while
upstream modules were already hollow.

## Prevention

| Rule | Why |
|------|-----|
| Use `StrReplace` (or a diff-aware edit) on existing files; never `Write` except to create a **new** file | `Write` full-file-replace is the #1 truncation cause |
| Run `tsc` (or a build) after **each** task / file touch, not once per wave | Catch corruption at 1 file, not 15 |
| One file per subagent; never run parallel edits on the same path | Prevents last-write-wins clobber |
| Line-count sanity check (`wc -l` vs `git show HEAD:path`) before the next wave | Cheap, fast corruption detector |
| Edit small files first (types, routers), large TSX last | Shrinks blast radius if something slips |
| Hard-stop the run on the first unexpected red gate | Stops the agent hollowing downstream files |

**Quick corruption sweep** before advancing a wave:

```bash
# Flag files that shrank dramatically vs HEAD (possible truncation)
for f in $(git diff --name-only HEAD); do
  old=$(git show "HEAD:$f" 2>/dev/null | wc -l)
  new=$(wc -l < "$f" 2>/dev/null || echo 0)
  if [ "$old" -gt 200 ] && [ "$new" -lt $((old / 2)) ]; then
    echo "SHRANK $f: $old -> $new"
  fi
done
```

## When to Apply

- Before launching any autonomous/overnight multi-file editing run.
- When a `tsc` run suddenly reports mass missing-symbol errors across many files.
- When deciding recovery: if files are structurally hollow, revert affected paths to
  clean HEAD and restart the wave rather than trying to hand-repair fragments.

## Related

- [false-green-gate-unpersisted-tsc-fixes.md](./false-green-gate-unpersisted-tsc-fixes.md) — sibling autonomous-run failure from the same convergence effort. Same "no `tsc` gate on disk between waves" prevention rule; the failure differs — there the edits were **absent/uncommitted** (a claimed-green gate never run), here they were **corrupted** (truncated). Both are caught by re-running the gate on disk and hard-stopping at the first red.
- [ec2-pilot-autonomous-deploy-and-ssm-gotchas.md](./ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) — autonomous EC2 deploy loop and SSM gate hazards
- [ec2-pilot-post-audit-tier5-execution.md](./ec2-pilot-post-audit-tier5-execution.md) — wave-based autonomous execution pattern
- `docs/superpowers/plans/2026-07-06-server-pilot-contract-convergence-sdd.md` — the plan whose overnight run triggered the truncation and clean-HEAD restart
