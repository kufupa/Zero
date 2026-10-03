---
title: Restore Orca Native Copy in Codex and Hermes CLIs
date: 2026-09-28
category: integration-issues
module: Orca ADE terminal input across Codex and Hermes
problem_type: integration_issue
component: tooling
symptoms:
  - "Selecting Codex transcript text and pressing Orca's configured Ctrl+Shift+9 did not copy it."
  - "Hermes selection was captured or cleared by its TUI before Orca could copy it."
root_cause: config_error
resolution_type: config_change
severity: low
tags:
  - orca-ade
  - terminal-copy
  - codex-cli
  - hermes-cli
  - mouse-capture
---

# Restore Orca Native Copy in Codex and Hermes CLIs

## Problem

Orca's configured native copy shortcut, Ctrl+Shift+9, worked in Cursor and other CLIs but not reliably in Codex or Hermes. Each CLI's terminal UI could claim fullscreen or mouse input, preventing Orca from copying a native text selection. The Orca binding itself did not need to change.

## Symptoms

- In Codex fullscreen transcript mode, selecting text and invoking Orca's Ctrl+Shift+9 copy binding did not copy the selection.
- In Hermes, mouse selection was captured or cleared by the TUI instead of remaining available to the host.
- The same Orca binding worked in Cursor and other CLIs, isolating the issue to per-CLI terminal behavior.

## What Didn't Work

- Rebinding Orca's shortcut or switching to Ctrl+Shift+C was unnecessary; the existing Ctrl+Shift+9 binding was confirmed working in other applications and after the Codex setting change.
- Hermes's generic config command warned that display.mouse_tracking was an unknown key. The Hermes TUI-specific config reader supports the setting; use its /mouse off command or set it in the active profile directly.

## Solution

Keep Orca's copy binding at Ctrl+Shift+9 and configure each CLI separately.

For this Codex installation, set this in /home/orca/.codex/config.toml, merging the key into an existing [tui] section if one is already present:

~~~toml
[tui]
fullscreen_transcript = false
~~~

This gives up Codex's fullscreen transcript mode in favor of scrollback behavior. The user confirmed native selection followed by Ctrl+Shift+9 copying works with this setting. Restart or reopen Codex if the running process has not picked up the change.

For the active Hermes zero profile, either run /mouse off in the Hermes TUI or set /home/ubuntu/.hermes/profiles/zero/config.yaml to:

~~~yaml
display:
  mouse_tracking: false
~~~

This disables Hermes mouse capture while preserving fullscreen mode. The user confirmed it restores Orca selection and copy. The Hermes TUI polls the profile modification time; if it has not reloaded the change, restart the TUI. For another Hermes profile, apply the setting to that profile instead.

These are per-user/per-profile configuration changes, not source-code patches. Ordinary CLI upgrades should preserve them when the configuration is retained, but resetting or replacing the relevant config/profile can remove them.

## Why This Works

Native selection and copy depend on the host terminal receiving the relevant mouse and keyboard interaction. Codex fullscreen transcript mode and Hermes mouse tracking are separate TUI controls that can take ownership of that input. Disabling Codex fullscreen transcript mode restores the confirmed host-copy workflow; disabling Hermes mouse tracking yields mouse selection back to Orca without leaving fullscreen. The two settings solve the same visible symptom through different CLI-specific controls.

## Verification

Both settings were manually verified by selecting CLI text and copying with the existing Ctrl+Shift+9 binding in the Orca-hosted session. No application source was changed. A focused Hermes TUI test could not be started because the checkout lacked the generated ui-tui/packages/hermes-ink/dist/entry-exports.js file.

## Prevention

- When native selection works in other applications but fails in one CLI, inspect that TUI's fullscreen and mouse-capture settings before changing Orca's host shortcut.
- Keep the Codex and Hermes settings in their respective user/profile configuration, and recheck them when changing profiles or rebuilding configuration.
- After applying a setting, verify selection plus the existing Ctrl+Shift+9 binding in each affected CLI; restart or reopen the CLI if needed.
- Do not assume a generic Hermes config command's unknown-key warning means the TUI-specific setting is unsupported.

## Related Issues

- [Codex: allow disabling mouse capture independently of alternate-screen mode](https://github.com/openai/codex/issues/48664) tracks the closely related fullscreen/mouse-capture boundary.
- [Hermes: make TUI mouse interactivity reliable](https://github.com/NousResearch/hermes-agent/issues/30536) documents the /mouse modes and display.mouse_tracking setting used here.

These upstream issues provide context for the CLI behavior; this solution is a local configuration workaround, not an upstream source fix.
