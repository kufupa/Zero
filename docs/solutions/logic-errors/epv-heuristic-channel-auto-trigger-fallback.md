---
title: Heuristic EPV Inflated by SynXis Channel Auto Trigger Fallback
date: 2026-09-02
category: logic-errors
module: connected-mailbox / Centurion defensible daily chart / EPV audit
problem_type: logic_error
component: tooling
severity: high
symptoms:
  - "WINDOW uEPV reported R5.13M in defensible daily chart audit"
  - "SynXis channel auto-mails classified as external_enquiry unanswered threads"
  - "Heuristic cohort fell back to first inbound when no external non-channel trigger existed"
  - "Tier-B stay ZAR parsing inflated EPV from confirmation amounts (~R4.3M junk)"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - email_processing
tags:
  - epv
  - heuristic-scoring
  - channel-auto-inbound
  - synxis
  - defensible-daily-chart
  - unanswered-thread
  - connected-mailbox
---

# Heuristic EPV Inflated by SynXis Channel Auto Trigger Fallback

## Problem

The Centurion defensible daily chart ops script inflated WINDOW **uEPV** from ~**R860k** to a false **R5.13M** (~6×) by treating SynXis channel auto-confirms as unanswered guest enquiries. When the heuristic thread cohort had no usable external non-channel trigger, selection fell back to chronologically **first inbound**—including SynXis **Res Confirmed / Modification / Cancelled** notices. `classify_thread_shape` still labeled those threads `external_enquiry`, and tier-B ZAR parsing read stay totals from confirmation bodies as demand EPV.

## Symptoms

- WINDOW uEPV jumped from prior Luna-census baseline ~**R903k** to **R5.13M** after heuristic cohort expansion; user challenged under `/95`.
- Audit JSON isolated **~R4.3M** heuristic junk in tier-B SynXis subjects (each ~R142k–R232k parsed EPV with zero guest room-nights).
- Act / Un / Rsp partition looked plausible; the EPV line was the outlier.
- Real high-EPV unanswered threads (large group/quote RFQs ~R34k–R280k) were drowned out by channel junk.
- Corrected EOD chart restores WINDOW ≈ Act **483**, Un **197**, Rsp **286**, Cent **168**, ext un **127**, **uEPV ~R860k**, rEPV ~R1.87M, audit **PASS**.

## What Didn't Work

- **Silent `inbound[0]` fallback** — SynXis/PMS channel notices often arrive first or alone; using them as the enquiry anchor misstates thread shape and demand.
- **`is_external_sender` without channel gate** — `ota_channel` counts as external; SynXis confirms pass until `is_channel_automated_inbound` is applied.
- **Relying on `classify_thread_shape` alone** — excludes voucher/staff-internal only; channel confirms still become `external_enquiry`.
- **Tier-B ZAR parsing on confirmation bodies** — PMS stay totals parse as valid EPV; booking-ref guards do not reject them.
- **Thread-level SynXis exclusion only** (session history) — Luna **438** actionable set already dropped channel digests at thread filter, but **within-thread** trigger fallback still poisons EPV when heuristic expansion re-selects first inbound.
- **Prior inflation fixes incomplete for this path** (session history) — Sep 1 work fixed booking-ref false positives, tier-D floors, full-thread demand parse, and room-nights-from-trigger-body. Those did not harden trigger *selection* against channel auto on the heuristic cohort → later EOD expansion reproduced a R5.13M-class failure.

## Solution

**1. Hard-exclude channel-automated inbounds from preferred trigger selection** — reuse `is_channel_automated_inbound` from `daily-reservation-analysis-2026-09-01.py` (loaded into the chart script via `exec` of that module’s top half). Obligation classes `channel_notice` / `automated_or_system` / `system_digest` and OTA channel notices must not win the trigger loop.

**Before (buggy preferred selection):**

```python
trigger = inbound[0]
for m in inbound:
    subject = m.get("subject", "")
    if is_external_sender(m.get("From", ""), subject):
        trigger = m
        break
# no match → stays inbound[0] (often SynXis)
```

**After (channel-aware preferred selection):**

```python
trigger = inbound[0]
for m in inbound:
    subject = m.get("subject", "")
    if is_external_sender(m.get("From", ""), subject) and not is_channel_automated_inbound(
        {
            "body_text": m.get("body_text", ""),
            "body_full": m.get("body_full", ""),
            "From": m.get("From", ""),
            "To": m.get("To", ""),
        }
    ):
        trigger = m
        break
```

**2. Do not keep channel auto as residual fallback** — if no external non-channel inbound exists, set `trigger = None` and skip the thread for actionable/EPV scoring (or classify as channel-only), instead of leaving `inbound[0]`. Preferred-loop filter alone is incomplete when every inbound is channel-automated.

**3. Treat channel domains as non-guest for external indexing** — `INTERNAL_DOMAINS` includes `synxis` (with `legacyhotels`, `navaai`, `reservecloud`, `fortimail`) so guest/external sets do not treat channel robots as demand sources.

**4. Regenerate chart + EPV delta audit** — rerun through EOD cut; write corrected MD/JSON with an explicit methodology note (SynXis exclusion). Confirmed corrected WINDOW uEPV **~R860k** vs inflated **R5.13M**.

**5. Keep uEPV scope unchanged** — still Σ tiered EPV on Un ∩ `external_enquiry` only; fix is trigger/classification input, not EPV tier math.

## Why This Works

SynXis Res Confirmed/Modification/Cancelled messages are **downstream channel artifacts**, not inbound sales enquiries. They carry large parsed stay totals (tier B) but not guest-demand room-nights. The ~R4.3M heuristic delta aligns with counting many such threads as unanswered `external_enquiry`. Skipping channel-automated rows in trigger selection (and refusing channel-only fallback) stops confirms from becoming the thread’s “guest ask”; uEPV then reflects real unanswered quote/booking threads in the ~R860k band—consistent with the prior ~R903k Luna census after cohort drift (some Un→Rsp). Post-fix audit: **0 quote leaks** on external unanswered, audit **PASSED**.

## Prevention

- **Never use `inbound[0]` as silent fallback** for EPV-eligible threads when no external non-channel trigger exists; prefer skip / non-actionable.
- **Gate uEPV on trigger pass** — if selected trigger is still channel-automated, set `epv_eligible = False` or exclude from `external_enquiry`.
- **Add audit assertion** — fail chart generation when any unanswered `external_enquiry` trigger subject matches SynXis/OTA channel patterns (same class as quote-leak checks).
- **Run EPV delta audit** whenever heuristic cohort or trigger rules change; inspect tier-B totals and top suspicious subjects before client-facing numbers.
- **Document methodology corrections** on regenerated charts so `/95` reviewers see explicit SynXis exclusion, not silent number changes.
- **When porting detectors** to product TypeScript (centurion thread-matching / conversation-signals), inherit `is_channel_automated_inbound` hard-exclude — do not reintroduce first-inbound fallback.

## Related Issues

- Adjacent plans (not duplicate learnings): `docs/plans/2026-09-02-001-feat-centurion-thread-matching-plan.md`, `docs/superpowers/plans/2026-09-02-centurion-thread-matching-implementation.md` (port of defensible-chart response signals).
- Channel vs human-gold exclusion: `docs/plans/2026-09-01-001-feat-corpus-tool-rediscovery-plan.md`.
- Related audit-trust learning: `docs/solutions/logic-errors/centurion-triage-audit-createdat-vs-finishedat-spam-at.md`.
- Verification skepticism pattern: `docs/solutions/conventions/live-negative-result-verification-gate.md`.
