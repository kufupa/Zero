# AGENTS.md

Read by Cursor CLI, Codex CLI, and any agent that looks for `AGENTS.md`. Claude Code loads `CLAUDE.md`, which points here.

**Read in this order, every session:**

1. `PRODUCT.md` — owner product spec. Do not invent requirements.
2. `docs/context/ACTIVE.md` — current run, models, deploy path.
3. `docs/research/2026-10-13/README.md` — research already done; do not redo.
4. `AGENT.md` — repo layout and commands.

Done = score on the golden set in `PRODUCT.md`, not a merge.

Do not copy this file into other worktrees by hand. It lives on `main`. A worktree sees it when that worktree’s HEAD contains this commit (`git merge origin/main` on an **idle** tree). Never merge into a live Luna/Codex lane.
