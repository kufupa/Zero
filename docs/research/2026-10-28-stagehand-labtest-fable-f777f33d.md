# HRCEN Labtest Stagehand comparison

2026-10-28. Owner asked: “u r the fresh llm, pls run this”, referring to the direct HRCEN Labtest profile/count lookup plus synthetic Stagehand/Azure preparation and same-reservation comparison in [the preceding handoff](2026-10-28-centurion-saas-stagehand-parity-codex-93f4b8e2.md#faster-path--owner-correction). Read-only, HRCEN only. No booking writes, sends, deployments or slot restarts.

## Deterministic baseline

At approximately 19:08–19:11 UTC, the deployed `00d814ca3` reader ran against HRCEN on Product EC2 using an isolated browser context and private credential source. It found confirmation `67907179-1`, Proof Labtest, 2027-03-15 through 2027-03-16, status **Cancelled**. Reader timing: 23,705 ms. SSM invocation `4dcb2d39-8074-435b-bf15-a6b54a1a2f92` returned Success; the child returned exit 0 and `outcome: found`.

The guard derived HRCEN lock inputs from the running application roots and acquired both currently observed advisory keys in a dedicated PostgreSQL session. It checked session, lock ownership and configuration while the child ran and stopped the child on loss. This does not establish coverage for arbitrary, unknown tenant overrides. The native result is a single reservation, not a profile booking count.

An EC2 synthetic check of the guard's signed advisory-key encoding passed both acquired-key and missing-key cases. This is not proof against every possible connection or process failure.

## Profile navigation

A separate guarded observer reopened the verified Labtest reservation and recorded a visible `lifetimestays` field and `Guest Profile` control. It did not read the field value. After producing its observation and screenshot, that disposable Node process remained alive. The operator stopped only its verified PID; its parent guard exited and the HRCEN slot remained active. The SSM result was Failed because the observer was intentionally terminated. A second read uses an explicit process exit. A lifetime-stays value, if present, must not be equated with all reservation records without checking HMS semantics.

A separate database audit while the subsequent profile read was active found one session for this trial holding two advisory locks. This is a point-in-time check, not proof of coverage of unknown override keys.

At approximately 19:14 UTC, a second two-lock read verified reservation identity and showed profile ID `47170` and the visible HMS field `Lifetime Stays: 0`. The selected cancelled reservation exists, so the field is not a demonstrated count of all reservations. The read-only Guest Profile control was clicked; the captured same-page controls did not establish that reservation history opened. SSM invocation `916b2cb3-983b-44e7-90b4-ec1e3dc0eebd` returned Success and the child exited 0. All-time reservation count and filters remain unverified.

Independent cleanup audit after the second read found zero sessions and zero advisory locks for this trial, and the HRCEN slot was active. The private screenshot taken 1.5 seconds after Guest Profile showed a blank overlay; it is not evidence of a loaded profile or reservation history. A subsequent guarded read waits for the overlay and inspects browser frames.

A subsequent guarded read waited 12 seconds and found a loaded nested HMS frame with `profileid=47170`. This establishes the Guest Profile opened for the same profile ID, but the captured controls did not expose reservation history or its count. SSM `4aeafe88-b356-48b4-86df-a039e64be793` returned Success, child exit 0, with both known locks held. The `Lifetime Stays: 0` field remained unchanged.

The loaded private profile screenshot shows a `Stay Details` tab. A next guarded read will inspect that profile-specific tab and its pagination; the screenshot alone does not establish the booking count.

## Synthetic Stagehand/Azure check

The synthetic-only lane reports that Stagehand 4.1.0 and the configured Azure Terra route extracted the expected fake reservation fields. The lane reports 5.312 seconds total to result, 3.954 seconds extraction, two model calls and four telemetry posts received by its loopback discard sink. The enclosing SSM command later timed out because the Node process remained alive; cleanup and final source verification are still in progress. This is not a live HMS comparison and does not establish self-healing.

The synthetic result must not be used as evidence for the live property: model input, browser attachment, live record isolation and Azure output still need a same-record run. Stagehand 4.1 has an exporter even with local redirection; the loopback sink prevents the default destination from receiving its traces only if configured before the session starts.

At approximately 19:18 UTC, profile `47170` → Stay Details showed `Records: 1 of 1`: HRCEN confirmation `67907179-1`, 15–16 March 2027, `CANCELED`. The profile summary showed `totalstays=0` and `totalcancelledstays=1`; this explains why `Lifetime Stays: 0` is not the reservation-record count. The visible status filter was blank and the property-filter input was blank; the data source's complete date coverage is not established. SSM `064f6eaa-78eb-4e07-a772-194adf88fc7c` returned Success and child exit 0 with both observed keys held. This establishes one displayed reservation record, not a verified all-time total.

The synthetic lane reran after fixing cleanup: SSM exit 0, own Chromium absent, 5.483 seconds from secret fetch to result, 4.226 seconds extraction, two Azure calls, four telemetry posts discarded locally. The checked script SHA-256 is `23ff10ea3bbff248308bd1918b4d75c45d40cde2b341173e6609e3ff23d1042e`. Model price and dollar cost are unavailable. Structured extraction alone is proven; live use, action and self-healing are not.

The private Stay Details screenshot shows the grid's selector set to **All Records**, blank visible Arrival, Departure and Status filter fields, and the cancelled HRCEN row. The screen labels the summary `Past Stay Summary`. `Records: 1 of 1` came from the page DOM. These visible settings are not a proof that the HMS backend applies no undocumented date or other restriction.

The synthetic source was independently hashed locally and matched the worker's report. It only accepts structured extraction model requests, validates the Azure HTTPS v1 host, and rejects image/tool-call content. This check does not prove data minimization or live read-only safety.

The private `Stay Details` screen shows `All Records` selected, the HRCEN cancelled row, and no visible arrival, departure or status filter values. The screen count is one displayed reservation record; undocumented backend filtering remains unknown. An independent post-read audit found zero sessions and zero granted advisory locks belonging to this trial; the HRCEN slot remained active.

The next Stagehand step uses a fresh Stagehand-owned Chromium because the existing hotel slot does not load its extension. A synthetic bridge check is in progress to verify that deterministic Playwright login and Stagehand address the same browser page. The existing slot will not be restarted or closed.

A synthetic bridge then launched its own Stagehand browser and attached Playwright to its loopback debugging port. The Stagehand page ID matched the Playwright CDP target, and Stagehand read a synthetic DOM change made by Playwright. No model call or HMS access occurred. The bridge exited 0, its CDP port closed, and no Chrome process remained for its unique profile. This does not prove attachment to the existing slot.

The live-comparison runner's synthetic preflight refused missing Labtest arguments and refused missing guard token. A separate synthetic process-group test confirmed its emergency cleanup targeted the matching owned browser profile and left an unrelated profile alive. These checks do not prove the live extraction, complete read-only interception, or the guard's behavior under every failure.

The private same-record Stagehand comparison was submitted as SSM `e5afa333-808b-431e-b40d-804aa0439bf9`. A separate point-in-time audit found one trial-named database session holding two advisory locks. The runner uses a Stagehand-owned fresh browser, deterministic login and target verification, local trace sink, and scoped extraction; the existing HRCEN slot is not closed. The run's outcome was pending at submission.

The reusable experimental source and guard are saved privately at `.private/stagehand-labtest-f777f33d/`; they are gitignored, Labtest-only and not a production integration. The token check in the child is not a substitute for the parent guard's live PostgreSQL locks.

## Live Stagehand result

The first guarded Stagehand-owned browser run independently reopened the exact HRCEN Labtest stay. Stagehand extracted confirmation, first and last name, arrival, departure and cancelled status; all six matched the deterministic read. Extraction took 4.130 seconds and two model calls. On the same profile's Stay Details iframe, an iframe-locator extraction returned empty values and no confirmation; it did not match the native count. The run reported `STAGEHAND_PROFILE_MISMATCH`, so this is a successful same-stay extraction but **not** a successful Stagehand profile-count comparison. The two extraction operations reported four model calls total and 54.675 seconds through browser cleanup. The loopback sink received 35 trace posts. Formal SSM and independent lock/browser cleanup verification are pending.

The guarded live command ended Failed with child exit 1 solely after the reported profile mismatch. Its own browser profile was removed. An independent audit found zero trial-named database sessions and zero granted advisory locks; the HRCEN slot remained active. The synthetic iframe lane is investigating whether a different Stagehand extraction scope can read the profile, without accessing HMS.

## Synthetic iframe diagnosis

A same-origin fake profile reproduced the live symptom. Scoping extraction to the iframe element returned empty fields. Omitting that locator correctly extracted all six fake profile fields and confirmation from the overall page snapshot. The scoped and unscoped extractions took 4.864 and 4.593 seconds respectively, with two Azure model calls each. SSM exited 0, the owned browser closed, and six trace requests reached the loopback sink. The one fake page does not prove an unscoped HMS extraction is safe: other frames could contain unrelated guest data. No unscoped live retry was performed on this basis.
