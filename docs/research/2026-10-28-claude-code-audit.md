# Claude Code audit evidence

Research and planning only. Full assessment, counterevidence, proposed edits, rollout checks and holds: [simplification plan](../plans/2026-10-28-claude-code-simplification-plan.md).

## Method and coverage

- On 2026-10-28, inspect the effective Zero and user-global instruction stack, auto-memory index and relevant linked entries, skill and hook sources, and current research and handoff documents. Record revision `origin/main` `3a5b3f315`.
- Examine 31 distinct discoverable headline retrospectives across 36 paths; five paths were identical copies. Sample supporting reports. One referenced temporary directory was absent, so its former contents cannot be counted.
- Snapshot accessible Claude Code archives from 00:00 to 01:13 UTC. Structurally stream 857 JSONL files for event timestamps; 32 had events in the window. Excluding five audit archives leaves 27 other archives, including five main sessions. Read all 110 assistant-visible and 41 human/coordinator/interruption text blocks in those main sessions; sample tool outputs and subagent archives. Six image attachments were not inspected. Running sessions can advance after the snapshot.
- Other-user Claude directories were inaccessible and two observed live process session IDs did not match an examined archive. The coverage is not all chats or every retrospective on the host. No session was interrupted.

## Decision evidence

| Finding | Evidence | Limit |
|---|---|---|
| Same-head review caught real defects, and rejecting a fee dialog did not guarantee cancellation was prevented. | `docs/context/ledger/2026-10-26-or2-retro.md:75`; `docs/research/2026-10-27-next-run/amend-cancel.md:12` | Retain meaningful safety and readback; do not infer every added control is useful. |
| Global versus Zero test guidance conflicts; repo guidance also both mandates and bans the same broad check. | `~/.claude/CLAUDE.md:23`; `AGENTS.md:54`; `AGENT.md:97` and `:112` | Correct by scope; do not disable remote-check restrictions. |
| Historical mistake guidance conflicts with later lane-supervision and context-handoff decisions. | `docs/context/MISTAKES.md:7` and `:29`; `AGENTS.md:39` and `:41`; `docs/context/OWNER-ASKS.md:345` | Preserve incidents and original decisions; label superseded prescriptions. |
| The CodeGraph prompt hook returned unrelated, wrong-worktree results during this audit, including on an agent message. | `~/.claude/hooks/codegraph-prompt-hook.sh:19`; captured hook output | No measured latency or dollar effect; on-demand navigation may still help. |
| Planning-only authority was crossed in one session: lane direction and a worktree were created before correction. | `~/.claude/projects/-home-ubuntu-projects-zero--worktrees-recover-parse-failure/83d64b3b-f14a-4163-9af8-1319b21f8174.jsonl:2278` through `:2339` | A later briefing was denied and the census batch did not start. |
| A private-looking page historically returned without credentials from one session's network path. Local source matches the historical served hash. | `~/.claude/projects/-home-orca-orca-workspaces-zero-triage-pane-shape-20261027/72e3a61e-02b8-40e1-aa4b-08b8ecc919ee.jsonl:15869` and `:15942`; `~/.gstack/projects/zero/designs/current-ui-showcase/outlook-side-pane-demo.html:532` | Current access, internet-wide reachability, a new disclosure and third-party access are unknown. No page URL or guest data is reproduced. |

No privacy-sensitive page, configuration, permission, hook, memory, skill, product code, deployment or live HMS action was changed. File sizes are not cost or timing measurements. Actual provider billing and routed model were not established.

The initial official-guidance brief was too broad, and the worker needed repeated direction to narrow it and return the most decision-relevant sources. This is an example from the audit itself, not proof of a specific avoidable dollar cost or a failure by the underlying documentation tools.
