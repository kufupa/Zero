# Fresh Stagehand HRCEN read-only trial

**Owner request:** Ask 395 authorizes the fresh Stagehand-led HRCEN form and rate-grid run, including screenshots, Labtest and no property lock. No Save, booking or email. This is a live read-only trial, not a product pass.

## Recorded sequence

- Initial attempt stopped before login because the new Azure callback shadowed its endpoint variable. The script was corrected.
- Next attempt found the login inputs but no sign-in action passed the script's method filter. It did not log candidate details, so the exact reason is unknown. No login was submitted.
- Following attempt showed Stagehand found the password input but suggested `hover`; the script rejected that method. No login was submitted.
- The next attempt used the AI-discovered field targets and a click on the AI-discovered login link. Stagehand signed in and confirmed the Centurion Start Center in 20.509 seconds from run start. The time from the first attempt to that verification was 179.810 seconds, including fixes and retries but excluding initial coding. The click-to-response time was not separately recorded.
- Stagehand opened Stay 360. For the new booking goal it repeatedly clicked the Front Desk navigation entry without reaching a booking form. The operator stopped only that trial process. Its browser exited and its temporary browser profile was subsequently removed. No Save or booking action was performed.
- A follow-up with action history and per-action screenshots was still running at the last checkpoint. It had hovered several toolbar controls, including the Save Record tooltip without clicking it, and searched navigation; no booking form had been reached.

## DOM diagnosis before further retries

The actual Stagehand snapshot of Stay 360 contains several toolbar links with empty accessible names. The screenshot shows a toolbar with icon-only controls, including a plus-shaped icon, but the captured accessibility tree does not identify that icon's function. During the follow-up, one hover exposed `Save Record (Ctrl+S)`; its click remained prohibited. Stagehand's model then cycled between hover, navigation and search without identifying a new booking control. These observations establish a labeling/navigation obstacle, not the cause of the earlier unrelated profile-frame failure.

Source evidence is private at `.private/stagehand-fresh-f777f33d/evidence-stagehand-fresh-f777f33d-run-20261028-r4/` and on the EC2 trial output directories. The trial script is `.private/stagehand-fresh-f777f33d/run.mjs`. A separate, generic local accessibility-label aid has been prepared to copy any existing tooltips into empty accessible labels; it does not preselect HMS controls. It is not yet verified. Any assisted result must be reported separately from unassisted Stagehand discovery.

## Holds and remaining work

The owner directed continuing autonomously through every requested form field, Labtest selection, future dates, full Rate Shop and screenshots. The current run has not yet established complete fields or any rates. Do not claim a pass until actual data and coverage are independently checked. Record any further interaction and outcomes here.

## Action-history retry outcome

The action-history retry completed without reaching the booking form. It made 46 model calls across login, state checks and navigation, tried 12 booking-navigation actions, captured per-action evidence, and closed its browser and profile. It did not click Save or submit a booking. The next run will separately test a generic local accessibility-label aid against the captured unlabeled controls; it remains a Stagehand-directed attempt but will not be reported as the original unassisted baseline.

## Assisted retry: contradictory state check

The generic-label-assisted retry signed in, but Stagehand's model returned `complete: true` while its own evidence explicitly said the current screen was Start Center and Stay 360 was only a link. The original script incorrectly accepted that contradiction and captured Start Center under a Stay 360 filename. The operator stopped that trial for correction; that screenshot is not evidence of reaching Stay 360. The only generic label exposed at that checkpoint was `Launch the messenger`, so this did not establish a fix for the toolbar. The next retry rejects explicitly negative evidence instead of accepting it as completion. The prior, genuinely opened Stay 360 screenshot remains valid.

**Correction:** The stop decision above used a stale status. Before the stop reached it, the assisted run had in fact opened Stay 360, exposed 46 existing tooltip labels, and Stagehand had selected and clicked `New Record`. Its subsequent snapshot said `Processing request`; the form finishing loading was not confirmed. The operator stopped the process before rechecking those newer actions. This was an operator mistake, not evidence that Stagehand failed to click the control. The next run must wait for the form and separately verify it. The generic label aid is deterministic and model-free, but the HMS flow itself has not yet been replayed deterministically.

## Processing wait diagnosis and retry

The next assisted run signed in, opened Stay 360 and clicked New Record. Its model correctly said to wait because the new screen was processing. The script instead asked for a next action, received no candidate and exited. Its final snapshot, taken just before cleanup, showed the processing text had disappeared and a Guest Stay form with Arrival Date, Departure Date, Rate Plan and Profile ID. The operator therefore did not verify or continue with that form in the live browser. The failed 2-minute checkpoint was closed in the ETA ledger; no completion was claimed.

A further retry is running with a bounded conditional processing wait and stronger forbidden-action terms. This remains an accessibility-assisted Stagehand trial, not unassisted or deterministic end-to-end replay. No Save, booking or email is authorized in this trial.

The saved failure snapshot includes a loaded Guest Stay form, with Status `New`. An independent, model-free scan found 100 distinct accessible label texts in the captured form (`.private/stagehand-fresh-f777f33d/r7-visible-field-labels.txt`). This is a label count, not proof that every field or every tab was inventoried. The live retry has to reach the same screen and continue to the fake profile and rates.

The retry with the bounded wait subsequently captured `03-new-booking.png` and its full snapshot while Guest Stay was open. Stagehand reported Status New and a blank confirmation number. Field extraction and the remaining steps were still in progress at this checkpoint.

The running retry returned 259 model-extracted field entries; independent comparison with the 100 distinct snapshot labels is pending, so the entry count is not an accuracy or completeness claim. It then opened Guest Profile lookup and used a model-selected fill action for its search. Profile selection was not yet verified at that checkpoint. In the preceding assisted run, the first 13 model calls took 39.596 seconds before the New Record click; this is one run and does not measure deterministic replay.

Independent exact normalized-label comparison found all 100 distinct Guest Stay labels from the earlier form snapshot in the 259 extracted entries. This checks names only, not values, required flags, unnamed controls or other tabs. The 259 entries include the underlying Stay 360 page, toolbar links and Guest Stay, so it is not a count of 259 booking fields. The model explicitly reported that required status, checkbox states and dropdown options were not exposed in the supplied DOM.

The profile lookup search returned an on-screen result for profile 47170, Labtest, Proof. Stagehand then clicked its proposed Return Value action. The resulting Guest Stay fields must be inspected before claiming that the profile was selected. The extracted-fields file was copied from EC2 and checked against its SHA-256; it matches the independently downloaded compressed copy.

The retry stopped at the profile checkpoint: the Guest Profile search returned 47170, Labtest, Proof and Stagehand returned that ID to the new Guest Stay form, but first and last name remained blank in the captured snapshot. Stagehand could not identify a further safe action to confirm selection and the script exited. Dates and Rate Shop were not reached. The conditional eight-minute forecast assumed a first-try path and was superseded in the ETA ledger at the profile failure. Diagnose the actual lookup behavior before another retry; do not treat the ID alone as proven binding.

Diagnosis: the profile lookup snapshot shows the exact existing guest in the result row and the lookup heading. Returning it populated Profile ID 47170 but did not populate First Name or Last Name. Current-worktree `create-lab-stay.mjs:1169-1170,1208` fills guest names and profile ID separately; it does not prove the profile bind persisted. The next Stagehand-guided retry instructs the model to enter the known fake name on the unsaved form if those fields stay blank, while retaining the lookup and exact ID check. It reuses the prior Stagehand field extraction after verifying the new form's key labels, rather than repeating the expensive inventory; previous values are not asserted current. Both interventions are assistance and must be disclosed.

The separate field-label check found 101 label instances and 100 distinct labels; `Resort Fee` appears twice. The private field list preserves this repetition. This is still not an audit of unnamed controls, required flags or other tabs.

The independent label scan was repeated on both the r7 and r8 saved Guest Stay snapshots. Each had the same 101 label instances, including the same duplicate Resort Fee, and no difference in distinct labels. This remains a snapshot-only coverage check.

The next assisted retry searched and clicked the matching 47170 / Labtest / Proof result before returning it, yet Guest Stay again showed only the ID. Even with a compound instruction to fill the blank names, Stagehand chose to scroll and then returned no candidate; the script exited at profile. This is a second profile failure and invalidates the conditional completion forecast. The next repair separates profile-ID selection from individual model-discovered First Name and Last Name fills; the values are supplied by the script from the verified fake profile. This is additional operator assistance, not proof of autonomous profile binding or a saved reservation.

The Stagehand extraction also matched every one of the 101 captured label instances by normalized label count, including both Resort Fee occurrences. This checks occurrence counts against model output across the whole snapshot; it does not prove each field's type, value or requiredness, nor cover other tabs.

The failed profile retry made 41 model calls totaling 196.158 seconds of model-request time, across nine recorded Stagehand actions. This is one assisted run, not a latency distribution or a measured deterministic replay. It supports investigating model-free reuse after the Stagehand-led test, not claiming it already exists.

One observed speed improvement: the initial Stagehand form extraction finished 77.389 seconds after the form screenshot. The following retry reused that extraction 0.862 seconds after its form screenshot. This is one sample of each, not a controlled benchmark. It reuses earlier field values and is not deterministic replay of the HMS workflow.

The complete r9 action log was copied and SHA-256 verified. Its nine recorded action descriptions show navigation, lookup, search, profile return and scroll; none names a Save, send, cancel or other forbidden operation. Action descriptions do not prove network-level write blocking.

A read-only comparison of the r8 and r10 Guest Stay snapshots found identical counts for all 101 label instances. That supports reuse of the r8 label inventory on r10, but does not establish that their field values or other tabs match.

The atomic-action retry reached Guest Stay with Profile ID 47170, and Stagehand reported a successful First Name fill. For Last Name, the model identified the editable field but suggested `scrollTo`; the helper incorrectly rejected that method even though it would override the method with `fill`. The trial exited at profile before dates or rates. This is a script filter mistake, not proof that the HMS field cannot be filled. The next version accepts any safe discovered target and explicitly performs the fill, while retaining the forbidden-action guard. Verify the ID and both names in the captured form; do not claim saved profile binding.

To avoid repeating multiple model state checks for the same known profile lookup, the next retry uses an explicit sequence learned from the prior screenshots: open lookup, enter the fake ID, run search, select the matching result, and return it. Stagehand discovers each target afresh; it does not preload HMS selectors or invoke the old Playwright runner. The two fake name inputs are also model-discovered and filled explicitly. This is guided assistance, not the unassisted baseline; independent form verification remains required.

The next guided retry reached the unsaved Guest Stay form and returned the matching existing profile. After separate model-discovered fills of the known fake first and last names, an independent check of `04-selected-profile.txt` found Profile ID 47170, First Name Proof and Last Name Labtest together. This verifies displayed fields, not persistent profile binding. The prior model extraction was reused, with its values explicitly marked stale.

On the guided retry, Stagehand reported entering 17–20 March 2027 and saved date screenshots and action snapshots. Date values remain subject to an independent snapshot check. It then clicked an availability action while working toward Rate Shop; the requested rate grid and its completeness remain unverified.

An independent check of the post-date action snapshot confirmed Arrival Date 17-MAR-2027 and Departure Date 20-MAR-2027 on the unsaved Guest Stay form. The r11 and r8 new-form snapshots each contained the same 101 label instances; this does not verify requiredness or other tabs.

During r11 Rate Shop navigation, Stagehand chose Check Availability and Rate Plan Availability, after which HMS displayed a validation error. It dismissed the message, clicked a Rate Plan field, then tried Room Type and Rate Availability; the grid was not shown in the captured checkpoints. The Guest Stay accessibility snapshot around Rate Plan contains an unnamed textbox and an alert, but no named lookup link. This is evidence of an accessibility/navigation gap, not proof of the exact DOM trigger or its behavior.

Read-only inspection of the still-open owned Chromium found the Rate Plan lookup trigger as a `DIV` with `role=presentation`, adjacent to the rate-plan input. It did not appear as a named lookup in the captured accessibility snapshot. An operator then applied an additional generic browser-local accessibility annotation through the browser debugging interface: lookup triggers associated with named inputs received button roles and descriptive labels. This annotated 24 lookup fields, including rateplan; no lookup was clicked by that intervention. It is additional non-Stagehand assistance, not proof that the lookup works or an unassisted result. The intervention result is preserved privately in `ssm-lookup-aid-r11.json`.

After the additional lookup-label aid, the r11 snapshot exposed `button: Lookup for field rateplan`, and Stagehand clicked it. Rate Shop opened with the selected dates, one adult and the Preset strategy, but only Current Rates and property-level counts were shown initially. Stagehand then clicked Search. The runner immediately failed after the twelfth action without checking the post-Search state; this was an orchestration defect, not proof that Search failed. The browser cleaned up and no `rates.json` was produced. A separate next script incorporates the generic label aid, explicitly asks Stagehand to find the Rate Plan lookup, and checks state after the final allowed action. Post-Search screenshot and snapshot need independent inspection.

The captured r11 snapshot immediately after Search showed the Rate Shop grid with no rows, not nightly prices. The runner shut down without a post-action state check, so the snapshot does not establish whether the inquiry would subsequently have produced results. No prices were captured in r11. The owner requested a stop/retro; one corrected retry was already running, after which no further retry will be launched without a new decision.

Across the completed r2–r11 attempts, the retained usage files report 293 successful GPT-6.1 Terra model calls and 1,408 seconds inside model requests. This excludes the in-flight r12 and any failed requests not present in usage files. The actual dollar cost has not been established. The aggregate is experiment and retry overhead, not a measurement of one working workflow.

Additional form-state caveat: the r11 date screenshot and snapshot show the three-night 17–20 March date range but still display Nights = 1 on Guest Stay. The subsequent Rate Shop screenshot displays Nights = 3 for the same range. Whether this was transient recalculation or another state issue is not established; do not claim the form was internally consistent or ready to save. No booking was saved.

The final in-flight retry repeated the date-state discrepancy: its model state explicitly reported 11–14 March 2027 with Nights = 1, yet the date checkpoint passed because it checked only arrival and departure. The retry then opened Rate Shop after the generic lookup aid. This identifies a missing invariant in the experiment, not a saved booking.

Independent inspection of r12 `trace-dates-01.txt` found another derived-state inconsistency: the form displayed 11-MAR-2027 with Wed and 14-MAR-2027 with Thu. Calendar calculation gives Thursday and Sunday respectively. Along with the one-night value, this means filling the date text alone did not establish a fully updated Guest Stay state at that checkpoint; cause and later form state remain unproved.

In r12, the guided Rate Plan lookup opened Rate Shop for 11–14 March. An initial Search with Sales Strategy `Preset` returned the explicit HMS message, “Selected criteria is not available for these dates.” Independent snapshot inspection confirmed both the selected strategy and message. This is not evidence that all other strategies or all dates have no rates.

In the same final retry, Stagehand enabled Show Restricted Sell Options and searched again. Its recorded state again reported that the selected criteria were unavailable. This is a repeat of the criteria-specific negative result, not a test of every sales strategy and not proof that the property has no rates.

The last already-running retry ended at Rate Shop without a `rates.json`: two searches using the selected Preset criteria returned the unavailable-criteria message, including one after an attempt to show restricted sell options. Stagehand inspected strategy options but then produced no next action accepted by the runner. No further retry was launched after the owner asked for a stop/retro. Across r2–r12, retained usage records show 352 successful GPT-6.1 Terra calls and 1,690.82 seconds in those model requests. At the public OpenAI Standard list rates, recorded usage is approximately $2.68, excluding possible cache-write charges, unrecorded/failed calls, Azure-specific pricing and Claude coordination; this is not an invoice. Pricing source: https://developers.openai.com/api/docs/models/gpt-6.1-terra.

Final-action diagnosis: Stagehand returned an unblocked action, “Move to the next Sales Strategy option for a different read-only search,” with method `press`. The runner rejected it because its method allowlist omitted `press`. This is another orchestration/filter mistake, not evidence that Stagehand produced no safe candidate. Whether the proposed key action would have worked is unknown. The owner requested a stop/retro, so it was not retried.
