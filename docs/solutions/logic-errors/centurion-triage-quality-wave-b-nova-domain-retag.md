---
title: Centurion triage quality Wave B — Nova dialect + domain retag
date: 2026-09-03
problem_type: logic-errors
component: server-pilot / mail-triage / retag
---

# Centurion triage quality Wave B — Nova dialect + domain retag

## Problem

Wave B re-backfill for Automate/spam/Quarantine quality hit three blockers:

1. `--from-domain` skipped `spam_at IS NULL` threads, so SynXis/OTA Bookings misfiles could not be repaired.
2. After enqueue, many runs dead-lettered with `mail triage workflow failed: failed` because Nova emitted non-canonical workflow fields (`humanAction` boolean / `email-verification` / `verify`, `automationState: active`, folder names in `suggestedTools`, stray keys like `read-onlyToolTags`).
3. `--quality` Q11 Un/Rsp/Act band defaulted to WINDOW baselines when `--q11-volume` omitted, making the volume sanity check tautological.

## Solution

1. Add `--include-non-spam` to `retag-centurion-triage.mjs` for quality domain repair (default spam-only gate unchanged).
2. Extend `normalizeNovaWorkflowOutput` observed-dialect mapping: coerce boolean/`verify*` humanAction, map `automationState: active` → `candidate`, drop non-`READ_TOOL_IDS` tool tags + workflow-folder leaks, alias/strip unknown keys before strict Zod.
3. Ops: snapshot → domain dry-run/apply with `KEY_PREFIX=inbound-triage-retag-v6-quality-202609030122` for Automate donors + FortiMail `fortimail-0{1,2}.vox.co.za`.
4. Fail-closed Q11: `createPostgresCenturionTriageQualityDriver` leaves Un/Rsp/Act null without override; `evaluateQ11VolumeBand` errors unless `--q11-volume` supplies live conversation-signals counts. Gold `neverSpamNegatives` re-refine asserts no promo/FortiMail force + allowlist clears forced spam.

## Evidence (pilot spot-check)

- `--quality` audit `ok: true` (Automate recall ~84.6%, spam recall 100%, spam-fp 0, neverSpam/staffOutbound 0) — live Automate/Spam folder SQL real; Un/Rsp/Act WINDOW match must be re-proven with `--q11-volume` after this fail-closed fix.
- Live: Automate 256, Spam 142, Quarantine labels 89, Automate∩Urgent 0; conversation-signals WINDOW 201/282/483 observed separately.
- Residual: ~241 dead_letter under the quality KEY_PREFIX; some FortiMail hits still `spam_at` null (resume with same prefix after further dialect fixes).

## Prevention

- Prefer extending Nova normalize for observed production dialects over prompt-only.
- Quality Automate repair must use `--include-non-spam` (or full bound targets), not spam-gated `--from-domain` alone.
- Discover FortiMail donor domains from subject/body aggregates (`fortimail-*.vox.co.za`), not `fortimail.com`.
- Never default Q11 Un/Rsp/Act to WINDOW constants in the audit driver — require `--q11-volume`.
