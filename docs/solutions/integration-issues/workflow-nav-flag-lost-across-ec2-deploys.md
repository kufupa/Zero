---
title: Workflow navigation rollout flag lost across EC2 deploys
date: 2026-09-02
category: integration-issues
module: server-pilot deployment / mail SPA workflow navigation
problem_type: integration_issue
component: development_workflow
symptoms:
  - "A later full EC2 deploy reverted the mail SPA from the completed Urgent-first workflow-folder navigation to the earlier legacy folder presentation."
  - "The customer-facing navigation depended on the build-time VITE_WORKFLOW_NAV_V6/WORKFLOW_NAV_V6 value, so an ordinary deploy could silently rebuild the SPA with the rollout disabled."
  - "Demo and live navigation retained flag-dependent branches and mode parameters, allowing legacy and workflow folder maps and alias resolution to diverge; the bookings slug was an intentional collision."
  - "The server parser and deploy scripts retained stale navigation-flag plumbing even though WORKFLOW_TRIAGE_V6 was the only durable triage capability that still needed to remain."
root_cause: config_error
resolution_type: code_fix
severity: high
related_components:
  - email_processing
  - tooling
  - testing_framework
tags:
  - workflow-nav
  - vite-env
  - ec2-deploy
  - build-time-config
  - mail-spa
  - feature-flag
  - deploy-contract
  - workflow-folders
---

# Workflow navigation rollout flag lost across EC2 deploys

## Problem

The completed Centurion workflow-folder navigation disappeared from a later deployment because the SPA, server environment parser, and deployment scripts still treated `VITE_WORKFLOW_NAV_V6` / `WORKFLOW_NAV_V6` as a rollout gate. When that temporary setting was not carried into the deployment, the built mail UI could fall back to the earlier navigation contract instead of showing the completed workflow taxonomy.

The fix was landed in commit `31d3e39069a07737bef30f35cec0dfb57f2eb074` (`fix(mail): remove workflow navigation rollout flag`).

## Symptoms

- A later deploy no longer exposed the completed workflow folders in the mail navigation.
- The old frontend code selected legacy or workflow navigation through `WORKFLOW_NAV_V6`, so the result depended on build/deploy environment state rather than the completed product contract.
- Demo and live paths still accepted a mode argument and could use different folder maps. The `bookings` slug was a deliberate collision that required workflow-first resolution.
- `spam` needed to remain in Management, while Folders needed Urgent first followed by the eleven workflow IDs: `bookings`, `groups-events`, `manage-stay`, `confirm-reconcile`, `money-billing`, `documents-delivery`, `exceptions-recovery`, `guest-experience`, `internal-partner`, `automated-channel`, and `unknown-review`.

## What Didn't Work

- Keeping a temporary environment-controlled rollout gate after the workflow cutover was complete. An omitted build or server variable silently changed the customer-facing navigation.
- Retaining separate legacy/workflow branches and boolean parameters made the final navigation conditional even though the workflow taxonomy was already the intended state.
- Leaving the flag parser, build helper, and deployment writer in place preserved multiple ways for a future deployment to reintroduce the regression.

No authenticated UI gate result is claimed for this incident: the gate was not run because its fixtures were unset.

## Solution

The final implementation makes the completed workflow navigation unconditional and removes only the navigation rollout control:

- `apps/mail/config/navigation.ts` no longer defines or reads `WorkflowNavEnv`, `isWorkflowNavV6Enabled`, or `WORKFLOW_NAV_V6`. Live navigation always filters to the workflow primary slugs plus Urgent, uses the fixed Urgent-first order, ignores API `sortOrder`, and excludes Spam from Folders. Spam remains a Management item.
- Demo navigation always uses `WORKFLOW_MAIL_FOLDER_DEFINITIONS`, excludes Spam, and emits Urgent followed by the same eleven workflow IDs. The Urgent presentation, including its red stripe, remains part of the normal navigation output.
- `apps/mail/lib/demo/folder-map.ts` is mode-free and resolves workflow definitions before legacy definitions. This intentionally makes `bookings` resolve to the workflow `bookings` route while preserving readable non-colliding legacy aliases:

  ```text
  bookings       -> bookings
  new-booking    -> new-bookings
  at_risk, risk  -> at-risk
  groups, events, mice -> groups-events
  operations, handover -> ops
  ```

- The server env parser, SPA build/deploy wiring, and obsolete navigation helper no longer contain the navigation flag. `WORKFLOW_TRIAGE_V6` remains intact as an independent durable triage capability.
- The landed revision was deployed from the immutable ref `deploy/workflow-nav-31d3e39069a0` using a quiesced asset sync. Fresh asset verification returned HTTP 200 for the fetched assets, covered 46 assets, reported `flagPresent=false`, and found all expected workflow IDs. No credential, mail content, or other PII is part of this record.
- The readiness comparison was unchanged: the reported `NOT_READY` state was attributable only to the pre-existing dead-letter backlog. The authenticated UI gate was not run because the required fixtures were unset.

## Why This Works

Navigation is now a code-level product contract, so an omitted environment variable cannot turn the completed workflow folders off in a future SPA build. Demo and live builders share the same allowlist and deterministic order, and ignoring API sort values prevents backend ordering from changing the customer-facing sequence.

Workflow-first lookup makes the `bookings` collision explicit while retaining readable non-colliding legacy aliases. Removing the mode parameters and all active flag plumbing also removes the stale branch that allowed the regression to return. Keeping `WORKFLOW_TRIAGE_V6` separate prevents this UI cutover from changing the unrelated server triage capability.

The fresh deployed-bundle checks support the static-artifact claim (`flagPresent=false`, all IDs present, 46 assets fetched successfully). They do not substitute for the missing authenticated browser proof, which remains an explicitly unrun check because no approved fixtures were available.

## Prevention

- Once a rollout is complete, remove its environment toggle and all parser, build, deploy, and helper wiring; do not leave a second legacy UI branch behind the final state.
- Keep a removal-contract test over active production inputs. It should reject `VITE_WORKFLOW_NAV_V6`, `WORKFLOW_NAV_V6`, the old parser/helper names, generic navigation mode branches, and a reintroduced helper path.
- Keep explicit tests for the exact workflow IDs and order, Urgent’s presentation, section placement (`Core` / `Folders` / `Management`), Spam’s exclusion from Folders, and the workflow-first alias table including the intentional `bookings` collision.
- Make the build/deploy check inspect fresh referenced assets: require the landed SHA, reject any navigation-flag marker, and require every workflow ID before accepting publication.
- Compare readiness and process invariants before and after a static publish; document an unchanged pre-existing blocker rather than attributing it to the UI change.
- Treat authenticated UI verification as fixture-gated and fail closed. If sanitized non-PII fixtures are unavailable, record the gate as not run instead of claiming a browser pass.

## Related Issues

- [Hotel folder UI parity](../ui-bugs/hotel-folder-ui-parity.md) — presentation-layer precedence and Urgent treatment for managed folders.
- [Centurion triage audit semantics](../logic-errors/centurion-triage-audit-createdat-vs-finishedat-spam-at.md) — durable backfill and the boundary between triage state and navigation.
- [EC2 pilot autonomous deploy and SSM gotchas](../workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) — bundle sync, build, and SSM deployment hazards.
- [Playwright pilot UI gate](../test-failures/playwright-e2e-ec2-pilot-ui-gate.md) — authenticated live UI proof and fail-closed fixture handling.
- Plan: `docs/superpowers/plans/2026-09-02-workflow-nav-flag-removal.md`.
- Live proof: `.superpowers/sdd/workflow-nav-flag-removal/live-proof.json` (sanitized, ignored evidence artifact).
