# Da Vinci Owner-Click Checkpoint
Created: 2026-10-28

## Goal and scope

See whether one fake Da Vinci booking can be previewed and saved through the real hosted Nava pane, with the owner operating it. This is a narrow checkpoint, not full booking readiness or a multi-room proof. The owner asked for this plan after proposing a copied Da Vinci mailbox record, no added lock work, and a new Centurion browser. Original requests: `docs/context/OWNER-ASKS.md`, asks 386 and 387. Planning only; this document does not launch the test.

**Expected time to first pane result: 25 minutes**, conditional on the existing message being visible, dates editable, and the correct Da Vinci session working. This is a forecast, not a measured pane time. The related CLI-driven Labtest saves took 20–34 minutes. The planning assumption was 5 minutes to locate/edit plus 27 minutes for the prior CLI midpoint, or 32 raw minutes, scaled by the overall live-HMS ledger median of 0.79. That mixed ledger includes partial outcomes and does not calibrate this specific manual workflow. The subjective 15–40-minute range is not a percentile. Independent HMS readback has no separate timing measurement and may extend the checkpoint. No new copy, authentication fix, deployment, troubleshooting or approval wait is included.

## Existing evidence and assumptions

- The prior read-only preflight found one inbound booking work item on the Da Vinci-bound Faith transport. The injected subject starts `TEST Nava Labtest`. The pilot account has access to that transport. The owner's current nava-admin login and visible item have not been verified. See `docs/research/2026-10-28-davinci-pane-preflight-d1bc38f9.md`.
- The message describes two rooms. A previous HRDAV Labtest booking used the same guest and the original 20–21 December 2027 dates. Choose a different eligible date range and preserve the `Proof Labtest` identity. Confirm HMS duplicate handling; a new date alone does not prove no duplicate.
- `apps/mail/components/quote-workflow/stay-date-range.tsx` has date-edit controls and `booking-card.tsx` renders per-room Preview and Create provisional booking actions. Source is not proof of the browser's loaded bundle or actual item state. Changing dates invalidates the saved availability snapshot, so select a current room and rate rather than treating old availability or price as current.
- The pane’s build-time Open HMS landing URL can default to Centurion. The actual staff-bundle target is unverified; verify the property before any manual readback.
- Preflight observed Da Vinci create enabled in Labtest mode, a listening Da Vinci debugging endpoint and mismatched build markers. A listening port does not prove authenticated HMS or the loaded staff bundle. These observations were time-specific, not a guarantee at execution time.

## Fast path

| Step | Actor | Action and expected result |
|---|---|---|
| 1. Open test item | Owner | Sign in at `https://nava-admin.trynava.io`, select the Da Vinci-bound mailbox and search `TEST Nava Labtest`. Open the booking pane. Confirm this is the fake guest and Da Vinci property. |
| 2. Prepare one room | Owner | Change arrival and departure to a fresh 2027-or-later stay. Verify the guest, room, occupancy and current rate for the selected room. Turn off **Send confirmation from HMS** and confirm no confirmation recipient will be sent. Do not select whole-stay booking. |
| 3. Preview | Owner | Press **Preview in HMS** on the selected room. Check the displayed guest, dates, room and rate and the available HMS screenshot. Stop if the property or intended details are wrong. |
| 4. Save once | Owner | Press that room's **Create provisional booking** once. Record the visible outcome and confirmation or exact error. Do not press **Book this stay**, which may process multiple rooms. |
| 5. Independently verify | Owner or permitted read-only operator | Search the resulting confirmation in Da Vinci HMS with the matching guest and dates. Compare property, room, dates, occupancy, rate and status. Record any missing evidence. Human-operated HMS access avoids needing an assistant browser or a Pomerado mint. Do not assume the pane’s Open HMS link targets Da Vinci; verify the property. |

A **pane outcome** is success or a specific visible failure. A **saved booking proof** additionally needs independent HMS readback. A screenshot captured by the original save is useful but is not independent readback. No actual email delivery is tested.

## Browser and locks

- Owner explicitly requested ignoring the locks. Do not build the previously proposed custom guard or disable/reconfigure the application's existing lock merely to run this test. The pane's native lock remains in place. Preflight found separate lock keys for paths sharing the HRDAV browser; a new browser or a free-lock snapshot does not prove isolation. Avoid intentionally operating another job in the same Da Vinci browser during this one attempt.
- The owner also requested a **new Centurion browser**. Preserve that request as a separate, noncritical HRCEN task rather than claiming it powers the Da Vinci pane. HRCEN and HRDAV have distinct tenants and configured browser endpoints in `apps/server-pilot/src/ai/pane-stay-spawn-env.ts`. An additional HRCEN browser would need a separate profile and endpoint and may still affect the same server-side login. Starting or signing into one does not make the Da Vinci pane use it. Do not retarget the pane, replace an existing session or restart a service by assumption. Its setup is outside the 25-minute HRDAV forecast; exact login impact and purpose remain unverified.
- If “new Centurion browser” was intended to mean a fresh browser for the Da Vinci operation, that is a different target. Check the intended property before changing a slot or logging in. The one-room HRDAV pane plan itself does not require that change.

## Failure and fallback

| Finding | Response |
|---|---|
| Test email or mailbox not visible | Capture the UI state and inspect mailbox access. If needed, prepare one fresh, fake, single-room message using the real ingest path so it gains the expected thread, extraction and work item. Do not overwrite the existing message. The previous approval covered one earlier insert; a new production database insert needs execution authority. The 25-minute forecast no longer applies until the fallback is scoped. |
| Dates, rate or per-room controls unavailable | Record the blocker and the loaded UI state. Do not silently book original dates or both rooms. Diagnose before deciding whether a code change or a new test item is necessary. |
| Correct Da Vinci session unavailable | Capture the actual failure. A TCP listener alone is not proof of login. Do not use the Centurion tenant as a substitute. |
| Submit may have reached HMS, timeout, or **Check HMS** | Treat it as potentially booked. Do not retry or make another preview/commit until a read-only HRDAV lookup reconciles the guest, dates and outcome. Existing server handling of persisted unknown outcomes is a source-level gap. |
| Definite pre-submit refusal | Capture the error and screenshot, classify the cause, and only consider a new attempt after confirming no submit occurred. No automatic retry loop. |
| HMS independent read unavailable | Report the pane result as unverified. Do not call it a completed booking proof. |

## Boundaries and acceptance

- Fake Labtest guest only, future stay in 2027 or later, one room. No real-guest write, confirmation send, penalty-dialog acceptance, Pomerado run, deployment, flag flip, service restart or broader multi-room/Add-On proof is implied.
- First result: owner sees a real pane preview and a single save outcome, or an attributable blocker. Full narrow pass: one correct saved Da Vinci Labtest reservation independently read back, with no email sent.
- Existing source-level risks around durable uncertain-save recovery and parent/associated rooms remain follow-up work. This single controlled observation does not establish production readiness or accuracy on a representative corpus. The earlier full plan remains at `docs/plans/2026-10-28-007-feat-davinci-booking-parallel-d1bc38f9-plan.md`.
- Record actual elapsed stages and evidence when executed. No trial or fresh browser was launched while preparing this plan.

## Review status

The configured Gemini 4 Argon High plan review was attempted in read-only plan mode but returned `RESOURCE_EXHAUSTED (code 429): Individual quota reached`. It did not review this plan. The older broad Da Vinci draft was independently reviewed by Grok, but that review does not cover this owner-click plan. Local source checks verified the date controls, per-room actions, recipient omission when Send Mail is off, and property-specific browser routing. Live UI state, account access and actual HMS behavior remain unverified.
