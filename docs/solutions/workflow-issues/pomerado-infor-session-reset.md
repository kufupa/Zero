---
title: "Pomerado host resets can lose an Infor session"
date: 2026-10-28
category: workflow-issues
module: "Pomerado Infor HMS mint and execution"
problem_type: workflow_issue
component: authentication
severity: high
applies_when:
  - "Planning Pomerado mints or generated tools for Infor HMS"
tags:
  - pomerado
  - infor
  - hms
  - browser-session
  - authentication
---

# Pomerado host resets can lose an Infor session

## Context

In one Centurion session, native sign-in and a Stay 360 record were reached,
but the mint ended incomplete. Separate observations showed a login form after
a root reset and after reload. This does not prove server-side logout or the
underlying Infor mechanism.

## Guidance

Inspect the Pomerado host's mint reset and fresh-operation start, not only the
generated prompt. The installed version resets before its root-navigation hook;
the fresh run also starts its page after sign-in. The host already attempts
bounded sign-in recovery, whose exact behavior in the failed run is unknown.
For Infor, characterize it using a synthetic document-bound session; then, if
needed, change the actual host start so it retains its own verified page and
navigates via the HMS UI in both phases. Verify tenant and property, test
isolation and expiry, preserve sign-in tracking and review the artifact.

## Why this matters

A click-only prompt cannot suppress a navigation the host performs separately.
Restoring cookies or changing a post-reset hook does not establish the original
authenticated page is preserved. Infor is the target; a general site framework
is unnecessary.

## When to apply

Use this guidance for additional Infor mints or tool calls that must keep a
session. This is a plan, not a verified fix: no integration was published and a
fresh reusable-tool replay has not succeeded.

## Related

- [Evidence and limits](../../research/2026-10-28-pomerado-hms-session-continuity.md)
- [Infor session plan](../../plans/2026-10-28-004-feat-pomerado-hms-session-continuity.md)
- [Clean executor diagnostic forwarding](../runtime-errors/clean-executor-diagnostic-environment-forwarding.md)
