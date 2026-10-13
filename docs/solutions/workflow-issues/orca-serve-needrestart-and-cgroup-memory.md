---
title: Orca Agents Die Overnight from needrestart Restarts and the orca-serve Memory Cap
date: 2026-10-13
category: workflow-issues
module: Orca VPS host / orca-serve.service
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Agent chats or Codex/Claude workers on the Orca VPS stop overnight without a reboot
  - Orca terminals come back empty after reconnecting
  - Worker transcripts stop mid-tool-call at the same second
symptoms:
  - "systemd: Stopping orca-serve.service" seconds after "Starting apt-daily-upgrade.service"
  - "orca-serve.service: State 'final-sigterm' timed out. Killing." then SIGKILL of node/claude/bash
  - uptime shows no reboot; Orca daemon log jumps to a new pid with no shutdown event
  - "Memory cgroup out of memory: Killed process ... (node|chrome|orca-ide)" with oom_memcg=/system.slice/orca-serve.service
tags:
  - orca
  - vps
  - needrestart
  - unattended-upgrades
  - systemd
  - cgroup-oom
  - overnight
  - agents
---

# Orca Agents Die Overnight from needrestart Restarts and the orca-serve Memory Cap

## Problem

All agents run inside `orca-serve.service`. Two host mechanisms kill them without a reboot:

1. **needrestart after unattended upgrades.** On 2026-10-13 at 06:05 UTC, `apt-daily-upgrade` installed a `libx11` security update. Orca (Electron) maps libX11, so Ubuntu's `needrestart` restarted `orca-serve.service` 10 s later. The 30 s stop timeout expired and systemd SIGKILLed every process in the unit, including two Codex workers mid-task and the Orca PTY daemon.
2. **cgroup memory cap.** `orca-serve.service` has `MemoryMax=10G`, `MemorySwapMax=2G`, `OOMPolicy=continue`. When parallel workers each run a heavy typecheck, the kernel OOM-kills the largest processes in the unit (usually tsc/node, sometimes Chrome or Orca helpers). The host itself still had 5+ GB available.

## Diagnosis

Agent user `orca` has passwordless sudo; the system journal is the source of truth:

```bash
uptime; last -x | head                       # rule out reboot
sudo journalctl --since "<window>" -o short-iso | grep -E "orca-serve|apt-daily|unattended"
sudo grep -A4 "<date>" /var/log/apt/history.log
cat /sys/fs/cgroup/system.slice/orca-serve.service/memory.events   # oom / oom_kill since unit start
sudo journalctl -k --since "<window>" | grep -E "Killed process|oom_memcg"
```

A quiet orchestrator is not necessarily dead: check its transcript for a turn that ended waiting on the user.

## Solution (host config, not in Git)

- `/etc/needrestart/conf.d/orca.conf`: `$nrconf{override_rc}{qr(^orca-serve)} = 0;` so security updates leave the restart pending.
- `/usr/local/sbin/orca-safe-restart` + `orca-safe-restart.timer` (every 15 min): restart only when an Orca process maps a deleted `.so`, no agent transcript (`~/.claude/projects`, `~/.codex/sessions`, `~/.cursor/projects`) changed in 20 min, and no headless `codex exec` / `claude -p` / `cursor-agent --print` runs in the unit. `--dry-run` and `--force` available; decisions in `journalctl -u orca-safe-restart`.
- `/etc/systemd/system/orca-serve.service.d/stop-timeout.conf`: `TimeoutStopSec=90`.

For the memory cap, reduce demand rather than raising it first: see `mail-tsc-heap-sigabrt-hidden-type-errors.md` (the dominant consumer was repeated 2+ GB `apps/mail` typechecks). Per-session MCP servers add ~250 MB per agent; Cursor sessions with the AWS MCP set add ~1 GB more.

## Prevention

- Do not remove the needrestart override; restart Orca with `sudo orca-safe-restart` (or `--force` deliberately).
- Treat `SIGKILL` of tools inside Orca as a host memory signal and check `memory.events` before debugging code.

## Related

- `docs/solutions/workflow-issues/mail-tsc-heap-sigabrt-hidden-type-errors.md`
- `docs/solutions/workflow-issues/cursor-execution-backend-unavailable.md`
