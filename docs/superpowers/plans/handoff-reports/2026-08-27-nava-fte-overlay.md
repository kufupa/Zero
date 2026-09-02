# Nava FTE overlay — name-gate + remaining blockers

Date: 2026-08-27  
Branch: `feat/connected-mailbox-corpus`  
Execution: inline (no SDD review passes)

## Orca name-gate: blocked

Probed this host’s ADE, not a guess.

- Settings keys present: `agentDefaultArgs`, `agentCmdOverrides`, `defaultTuiAgent`, `disabledTuiAgents`.
- `agentDefaultArgs` is a closed codec list (`hermes`, `cursor`, `codex`, …). Values are extra flags such as `"--yolo"`, not a custom argv.
- `agentCmdOverrides` is `Record<string, string>` for **existing** TUI agent ids. Empty here. Overriding `prime-agent` would still label the start control **Prime Agent**.
- AppImage `TUI_AGENT_CONFIG` is a closed map. It includes `prime-agent` (`detectCmd`/`launchCmd` `prime-agent`) and does **not** include `nava`.
- `isTuiAgent` is `Object.hasOwn(TUI_AGENT_CONFIG, value)`. Unknown ids are rejected (`Unknown provider` / `Unknown agent preset`).
- `CUSTOM_AGENT_ID === "custom"` is Git → Source Control AI (`customAgentCommand`), not the agent start picker.
- `orca agent-context` has no “add custom TUI agent” command.

**Do not** put `prime-agent` on the start button. Overlay launcher is `scripts/nava`. Operator runs it in a terminal tab until ADE grows a custom TUI command + display-name field.

## Overlay code (this session)

Done locally, uncommitted unless asked:

- Prime submodule `npm install` + `npm run build`; `./prime-agent.sh --help` smokes.
- `scripts/package.json` `file:` dep `@earendil-works/pi-tui`.
- Hours parser + dashboard builder + view + tests.
- `scripts/nava` + `scripts/nava-dashboard-tui.ts` (`TUI.stop()` default, no `preserveAltScreen`).
- Dump-deny `sitecustomize` + `python -m nava_dump_probe`.
- `.prime/agent/settings.json` (google / gemini-3.7-flash, retry off) + `nava-fte` skill.

## Live demo blockers (this host)

1. **Name-gate** (above).
2. **Dump ACL:** `.private/connected-mailbox-corpus/` is unreadable to `orca` (directory permission denied). Launcher now exits 1 with `missing or unreadable dump`. No stub board, no invented `hours.json`.
3. **Committed dashboard files:** `docs/infor-hms/` ACL mask is `r-x` for `orca` (`user:orca:rwx` ineffective). Cannot write `nava-fte-dashboard.json` / `.md` from this agent. Ubuntu owner can regenerate after hours parse:
   ```bash
   unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
   pnpm exec tsx apps/server-pilot/scripts/nava-fte-hours.ts
   pnpm exec tsx apps/server-pilot/scripts/nava-fte-dashboard.ts
   ```
4. **TTY feel-test** of the dashboard was not run: no readable dump, no dashboard JSON.

## Not done / do not do

- No commit (ask first).
- No `ops-deploy` / EC2.
- No Prime **source** patches. Submodule `models.generated.ts` / lock dirty from `npm run build` was reverted.
- Host `!cat` / Node `fs` can still read the dump if the OS allows. Dump-deny is CPython kernel only.
