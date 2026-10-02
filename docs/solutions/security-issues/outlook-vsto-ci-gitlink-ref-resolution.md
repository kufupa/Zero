---
module: server-pilot / Outlook VSTO private-source CI
date: 2026-09-29
problem_type: security_issue
component: development_workflow
severity: high
symptoms:
  - The draft root PR gate read a VSTO submodule path instead of its pinned commit SHA.
  - A security-path PR would fail before verifying the matching private add-in source.
root_cause: logic_error
resolution_type: config_change
tags: [outlook, vsto, ci, gitlink, private-source, source-verification]
---

# Resolve the Outlook VSTO gitlink by its commit ID in root CI

## Problem

The first root PR CI gate for Outlook security changes parsed the private VSTO gitlink with `git ls-tree HEAD apps/server-pilot/vsto | cut -f2 | cut -d' ' -f2`. That pipeline extracts the *path*, not the pinned commit ID, so a relevant PR would fail before CI could inspect the exact native source. It was a fail-closed CI defect, not evidence that the add-in had been bypassed.

## Symptoms

- `git ls-tree HEAD apps/server-pilot/vsto` shows a `160000 commit` entry, but the original pipeline returns `apps/server-pilot/vsto`; the SHA check then rejects it.
- Separate native Windows CI success does not prove that the root PR gate checks the root repository's exact gitlink.

## What didn't work

- `cut -f2` selects the path after the tab in `ls-tree` output; a second split on spaces cannot recover the SHA that was already discarded.
- Earlier source-contract checks looked for the checkout and warning policy as strings. They did not execute the extraction, so they missed the incorrect column.

## Solution

Read the tree object's ID directly in `.github/workflows/ci.yml`:

```bash
gitlink_sha=$(git rev-parse HEAD:apps/server-pilot/vsto)
if [[ ! "$gitlink_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo '::error::Missing exact private Outlook add-in gitlink'
  exit 1
fi
```

For changes to the native gitlink, bridge, Outlook authorization, pane, relevant deployment files, or the CI workflow itself, the workflow now requires read-only access to the private VSTO repository. It checks out the exact pinned SHA, checks its `HEAD` and native source, and runs source and installer contracts. Missing or mismatched private source fails the job; only PRs outside the watched paths skip those native checks.

The updated source-contract tests check the `rev-parse` expression, exact checkout, and representative watched paths. The new extraction assertion failed against the faulty pipeline before the fix and passed afterward (18/18 targeted tests). Local shell checks also confirmed the old pipeline returns a path while `git rev-parse HEAD:apps/server-pilot/vsto` returns a 40-character object ID. Root PR CI has **not** yet run with the required read-only token; that remains a release gate.

## Why this works

`git rev-parse HEAD:<path>` returns the commit object ID stored in the root tree's gitlink without depending on a checked-out submodule or human-readable output columns. For watched paths, an invalid gitlink, missing private-source token, failed checkout, or SHA mismatch prevents the source check from being reported as passing.

## Prevention

- Resolve gitlinks with `git rev-parse HEAD:<path>` and verify a 40-character SHA; do not split `git ls-tree` columns.
- Update the path watchlist and its contract tests whenever an Outlook security entry point changes; never accept warning-only missing-source fallbacks on security-path PRs.
- Run root PR CI with private read access before treating this gate as release-ready. Local contracts and separate Windows CI are necessary but not sufficient.

## Related issues

- [Outlook WebView2 must not auto-authenticate a self-reported email](outlook-webview2-no-autoauth.md) describes another native trust-boundary risk.
- [False-green gate from unpersisted TypeScript fixes](../workflow-issues/false-green-gate-unpersisted-tsc-fixes.md) covers verifying gates against real artifacts.
