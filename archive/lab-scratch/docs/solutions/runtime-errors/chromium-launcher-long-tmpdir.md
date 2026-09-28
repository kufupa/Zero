---
title: "Keep Chromium launch scratch paths short"
date: 2026-09-17
category: runtime-errors
module: "HMS proof launcher"
problem_type: runtime_error
component: tooling
severity: high
symptoms:
  - "Chromium exits before page creation under a long per-run TMPDIR."
  - "The wrapper reports chromium_failed with a redacted_error message."
root_cause: config_error
resolution_type: environment_setup
tags: ["chromium", "playwright", "tmpdir", "headless", "proof-launcher"]
---

# Keep Chromium launch scratch paths short

## Problem

An isolated HMS proof runner could fail before creating a browser page when its
temporary directory inherited the long artifact/run path. This was a launcher
failure, not evidence of PMS access denial or missing reservation data.

## Symptoms

- Playwright 1.52 / Chromium revision 1169 reported that the target page,
  context, or browser had closed during launch.
- The runtime preserved `chromium_failed`, but redacted the command-bearing
  message because it contained the constant flag `--password-store=basic`.
- A credential-free, blank-browser control failed with the long temporary path
  and passed with a short private directory under `/tmp`.

## What Didn't Work

An inherited-environment launch passed, initially suggesting a missing OS
environment setting. Preserving the actual `HOME` alone while keeping the long
temporary path still failed. The decisive control kept the same reduced
environment and changed only `TMPDIR` to a short directory; launch succeeded.

The exact low-level crash mechanism was not established from stderr. Profile
and IPC path limits are plausible; do not claim a verified byte threshold.

## Solution

Keep durable evidence paths separate from Chromium's temporary root:

```bash
trial_artifact_dir="/opt/private/proof-artifacts/example-long-run/artifact"
trial_tmpdir=$(mktemp -d /tmp/hms-read.XXXXXX)

env -i PATH="$PATH" TMPDIR="$trial_tmpdir" \
  node "$trial_artifact_dir/entry.mjs"
```

This illustrates environment isolation, not a complete live invocation: add
only the explicitly reviewed settings required by the runner. Do not copy
model or database credentials into the browser environment. Do not remap
`HOME` to a scratch directory.

The private trial's `run-final-connected.sh` and
`run-single-context-diagnostic.sh` recipes use short `mktemp` roots while
retaining their separate evidence directories. Scratch remains owner-only;
any later cleanup must target the verified owned directory after browser
teardown, without deleting evidence or an active profile.

## Why This Works

Chromium constructs additional launch/profile paths beneath its temporary
root. Shortening that root removed the observed launch failure without
changing credentials, browser version, PMS requests, or the read firewall.
The corrected diagnostic created and closed its browser context; a subsequent
PMS-header failure remained a separate, unresolved layer.

## Prevention

- Run a blank, credential-free browser preflight with the actual reduced
  environment and temporary-path policy before live verification.
- Use a short private `mktemp` root, not a deeply nested run/artifact path.
- Retain safe error codes even when messages need redaction. Inspect native
  launch diagnostics only in a credential-free control, not a live login log.
- Treat launch, authentication, payload correctness, and visual evidence as
  separate checks. A repaired launcher does not complete a read tool.

## Related Issues

- [HMS packaging versus payload completeness](../workflow-issues/hms-live-proof-packaging-vs-payload-completeness.md).
- [Playwright EC2 UI gate failures](../test-failures/playwright-e2e-ec2-pilot-ui-gate.md) covers different browser/revision and environment failures.

No duplicate long-`TMPDIR` solution was found. Existing proof-gate guidance is
not superseded. The repository's GitHub Issues feature was disabled, so no
issue cross-reference was available.
