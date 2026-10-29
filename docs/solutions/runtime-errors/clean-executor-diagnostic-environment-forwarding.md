---
title: "Diagnostic destination lost in clean executor"
date: 2026-10-28
category: runtime-errors
module: "Pomerado clean executor diagnostic instrumentation"
problem_type: runtime_error
component: tooling
symptoms:
  - "The runner exports a diagnostic destination, but child processes lack it."
  - "The affected run produces no intended private diagnostic records."
root_cause: config_error
resolution_type: code_fix
severity: medium
tags:
  - environment-variables
  - process-launch
  - allowlist
  - diagnostics
  - pomerado
---

# Diagnostic destination lost in clean executor

## Problem

An isolated Pomerado diagnostic run could not write its intended private evidence because its clean executor omitted the diagnostic destination from the child environment. This instrumentation defect did not explain why the mint itself was incomplete.

## Symptoms

- The runner exported `NAVA_POMERADO_DIAG_FILE`, but the owned Codex and native runtime processes did not have it in their startup environments.
- The run produced no intended diagnostic records. Configuration or a generated file alone did not prove that the writer ran.

## What Didn't Work

The runner export and MCP forwarding configuration were not enough. The intervening clean executor reconstructed a separate environment from an explicit allowlist, so the variable was lost before the child processes started.

## Solution

In a separate private trial input, add the diagnostic destination to the executor's existing allowlist. A service-user synthetic `execve` interception verified that the test destination reached the child environment. A subsequent trial-scoped process check found the destination in the owned Codex and native runtime processes. Private phase markers and execution receipts then appeared.

This correction applied only to the isolated trial inputs. It did not change production code or prove the Pomerado booking workflow works.

## Why This Works

An explicit clean environment contains only selected variables, even if its parent exported more. Including the required diagnostic key allows the configured writer to find its destination. The synthetic handoff and observed live records establish forwarding and capture for the tested path, not the cause of the mint outcome.

## Prevention

- Check each boundary separately: runner export, clean-executor allowlist, actual child environment and resulting diagnostic record.
- Test the actual handoff with a non-sensitive synthetic destination before a live run. Inspect only the owned process group and keep private paths and records protected.
- Do not inherit the entire parent environment to fix one missing key. Receipt metadata, generated source and successful process launch do not establish a specific browser action or screen.

## Related Issues

- [Trial evidence](../../research/2026-10-28-pomerado-native-codex-trial.md) and [run retrospective](../../context/ledger/2026-10-28-pomerado-run-close-retro.md).
- [EC2 child-environment export gotcha](../workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) covers a related but different cause: shell variables not exported to a child. Export alone does not fix an explicit allowlist.
- [Test environment isolation](../database-issues/vitest-production-pilot-db-wipe.md) explains why required forwarding must not become unrestricted environment inheritance.
