# Grok review: Stagehand Labtest booking plan

- Reviewer: Grok 4.7, xhigh requested through Grok Build CLI.
- Scope: supplied sanitized draft only; no repository, package, ledger or HMS access.
- Reviewed draft SHA-256: `3d375256cc452f3c39021ad66ff3af86014af44ae8d44241d82a4b0414cc9103`.
- Reviewed draft retained privately at `.private/stagehand-labtest-f777f33d/2026-10-28-grok-reviewed-draft.md`.
- Review is unedited model output below. Assertions are review claims, not independently verified facts.

---

**REVISE. Do not mark this implementation-ready, and do not run it.** The trial shape is right: one real HRCEN Labtest booking, Stagehand does the booking actions, Playwright may log in and read back, second displayed CMS option, delivery as its own fact, no synthetic campaign, no platform rewrite. The execution contract still lets a hybrid click pass as a booking, and the Save rules contradict each other. The 120/160 figures are optimistic conditionals.

Reviewed only the supplied draft. No repo, ledger, package, or HMS check. Draft timings and LOC are estimates.

## 1. End-to-end Stagehand booking and comparison

Intent matches the ask. The success gate does not.

What holds:
- Real HRCEN Labtest create, fake profile, future eligible stay.
- High-level path is login, then Stagehand, then one Save, then independent readback.
- Hybrid Save is named as hybrid in an acceptance example.
- Provider switch is forbidden. Synthetic page is not a prerequisite. Explicit go is still required.
- Comparison is a second checkpoint on the same lease, serial with the booking.

What fails the ask:

| Gap | Impact | Anchor | Minimal fix |
|---|---|---|---|
| Playwright may do “setup” | Same split as the old trial: Playwright opens the stay, Stagehand only arrives later. Owner asked Stagehand to navigate and book. | R1 allowance: “login, setup, native identity checks and independent readback.” Evidence row: “Playwright found and opened the stay first. No Stagehand booking, navigation.” | Playwright may log in, read identity, read the CMS list, read back, and look up the fake profile. Stagehand must open the create flow, reach the profile, choose the stay, fill booking fields, select CMS, set send, and Save. |
| Readback is the booking proof | A native Save still produces “one successful independent HMS readback.” | U2 verification. Acceptance example covers only “Playwright clicks Save.” | Booking checkpoint passes only with an actor ledger: each booking action above attributed to Stagehand. Any other actor is a hybrid failure. |
| “Prefer” / “using existing native patterns” | `create-lab-stay.mjs` already selects CMS and Saves. Copying that pattern steals the booking action. | K2 “Prefer Stagehand.” U2 “native patterns before one Stagehand Save.” Evidence: create runner “has pre-save checks, CMS selection, one Save.” | Native code may read and abort. It may not click booking controls. CMS selection in the old runner is not the implementation path. |

No synthetic-page gate is smuggled in. U1’s full test matrix must not block the first live attempt. Necessary stops are wrong property, wrong profile, lock loss, and a second Save. Azure shape can fail on the first real `act` and end the checkpoint.

Comparison intent is met. Add a page reset so both arms share a start state. Keep login out of the timed segment, as the draft already says.

## 2. One Save and instance-level `selfHeal`

**Viable only as a single non-healing writer that never sees a second action.** As written, it is not viable: R3 leaves a retry, K4 forbids another action, and the acceptance example allows a new Save after reconcile.

Instance-level `selfHeal` means the create instance cannot turn healing off for Save and on for search. Healing on while Save is visible can re-infer a missed field into a Save or penalty click. Healing off for the whole create is the right write control. Navigation fragility is the cost. Report that as navigation failure. Do not “fix” it by enabling heal on the create page.

| Rule | Says | Conflict |
|---|---|---|
| R3 | At most one Save per attempt; reconcile “before considering a retry.” | Retry remains in the contract. |
| K4 | Ambiguous response: reconcile, do not trigger another action. | Closes the retry. |
| Acceptance | Timeout: reconcile “before any new Save.” | Opens a second Save. |
| K4 lifecycle | Later `selfHeal:true` instance; fresh browser if reattachment fails. | Unsafe if that instance attaches to an open create form. |

Minimal sequence:

1. Hold the current HRCEN lock set for the whole serial session. Lock loss stops acts. A read-only lookup of the fake profile and chosen dates still runs.
2. Playwright logs in. Read property. Abort if it is not HRCEN.
3. One Stagehand instance, `selfHeal:false`, on that browser. This is the only writer.
4. Stagehand booking acts only. After profile open, native-read the identity before any field entry. After CMS selection, native-read the selected code. Mismatch stops before Save.
5. Exactly one Stagehand Save `act`. Record the raw result. Do not call `act` again on this page. Do not construct another Stagehand on this page.
6. Playwright readback, then exact-profile lookup if the result is unclear. Classify saved, not saved, or ambiguous. Stop the write trial.
7. A further Save needs a new owner go. This plan does not pre-authorize it.
8. Leave the create page. Then construct compare and heal instances.
9. Fresh browser only if reattachment fails, only after the first browser is closed, only under the same lease, only on a non-create URL.

“Save not dispatched” is still a dispatched attempt if `act` was called. Selector-not-found can be a false negative after a click. Reconcile. Do not re-issue.

## 3. Recorded-action replay and healing

**Honest demo is possible only if installed 4.1 replays a retained Action and re-infers a broken selector when `selfHeal` is on.** The draft already says the docs may be newer than 4.1.0 and that local `cache:true` does not persist actions. That caution is right. The procedure is loose enough to pass without proof.

U3 says: break a selector, fail on the booking instance, recover on a second instance. The booking instance should already be dead by then. A fresh `act("click the control")` or a Playwright click can be written up as recovery. An unscoped snapshot on the create page can heal into Save.

Measure one retained Action on a non-write control. Independent Playwright postcondition, not Stagehand’s success flag.

| Step | Instance `selfHeal` | Model calls | Selector | Independent UI check | Counts as |
|---|---|---|---|---|---|
| Capture | false | ≥1 | recorded | control identified | setup |
| Clean replay of that Action | false | 0 | original | expected replay result | replay |
| Same Action, selector broken, still accepted by the API | false | 0 | no match | UI unchanged | no-heal failure |
| Same broken Action | true | ≥1 | new selector, same control | intended control only | heal |
| Fresh natural-language `act` | either | ≥1 | n/a | n/a | not heal |

Fail the heal checkpoint if model calls are missing, the healed selector hits another control, the UI changed during the no-heal step, or the library cannot replay an Action. That explicit fail is a valid result. Do this only after the create page is gone. No Save replay. No cloud cache.

## 4. LOC and ETA

Draft arithmetic is internally consistent. The inputs are not a midpoint.

| Draft step | Figure | Check |
|---|---|---|
| First checkpoint | 65 raw code × 0.85 + 80 raw live × 0.80 = 119.25 → 120 | Addition is correct |
| Second phase | 25 × 0.85 + 25 × 0.80 = 41.25 | Addition is correct |
| Total | 160 | 119.25 + 41.25 = 160.5, rounded down |
| Old 65 | 25 code + 55 live, scaled | 25 × 0.85 + 55 × 0.80 = 65.25. Reconstructs |
| Old 100 | “then 25 / 20 raw live” | Does not reconstruct cleanly to 100 |

Facts in the draft, versus assumptions:

| Item | Status | Value |
|---|---|---|
| Stagehand trial | Measured, wrong task | 54.675 s total, 4.130 s extraction. Playwright opened the stay. No booking, navigation, or heal |
| HRCEN create + find | Measured, other stack | ~12 min, pre-cloud, deterministic |
| HRCEN first Save / confirmation | Measured tail, n=1, other stack | 140 / 184 min, pre-cloud |
| Stagehand create, Azure `act` acceptance, heal on 4.1 | Unmeasured | Draft says untested |
| Ledger medians 0.85 and 0.80 | Unverified here | Draft says heterogeneous and superseded |
| Runner / adapter / guard / create runner sizes | Claimed, not rechecked | 111 / 104 / 91 / 1,465 |
| Helper importability | Unknown | “Much is internal” |

The 80 raw live minutes are about the average of 12 and 140. Scaling by 0.80 produces 64 live minutes, under that average and under the only long Save evidence, on a harder task than both cited runs. Exclusions remove the risks the draft itself names: API mismatch, contention, rework, email wait. A number with those removed is a lower-bound conditional. It is not a revised midpoint.

LOC versus code minutes: 65 raw code minutes at the 690 high bound is about 10.6 LOC per minute of new orchestration. That fits a sketch. It does not fit the high bound. At 300 LOC, 65 minutes is about 4.6 LOC per minute, which is plausible for a thin script that skips the branches R3 and R7 require.

Prior band in the draft: 270–610 for a narrower hybrid with a product-runner seam and deterministic Save, with a warning that full Stagehand control could be larger. This band is 300–690 for the larger scope. The top moved by 80. That does not absorb the warning.

Composition:

| Piece | Draft | Review |
|---|---|---|
| Guard / lease | 40–150, including 0–60 adapter | 80–160. Adapter contingency 0–120, outside the base |
| Booking script | 200–400 | 200 can exist and miss the actor ledger, CMS oracle, and reconcile. Requirement-meeting script: 350–550 if helpers are callable; higher if internals are copied |
| Compare / heal | 60–140 | 120–220 once call counts, two instance lifetimes, and postconditions are included |
| Implementation | 300–690 | Planning point **650**. Plausible band **450–900**, plus adapter contingency |
| Tests | 140–260 | Most plausible range. About 20 named scenarios. Do not put this LOC on the booking critical path |

Alternative ETA, one implementer, calendar time until a visible result. Ledger ratios not applied. HMS time not shrunk.

| Checkpoint | Planning | Range | Basis |
|---|---|---|---|
| First terminal booking attempt and readback | **210 min** | 150–300 | ~135 min code if helpers are callable (45 guard + 90 script). ~90 min live: above the 12 min deterministic happy path, below the 140 min Save tail. No Stagehand create sample, so this is judgment |
| Heal and comparison as well | **330 min** | 240–420 | Add ~60–90 min U3 code after the booking report, plus ~30 min read arms and ~30–60 min heal protocol. The 54 s trial does not price this |
| Tail | — | 360+ | 184 min confirmation precedent plus schema repair or an ambiguous Save. Analogy, n=1 |

Assumptions behind 210: Azure text/JSON-schema `act` works; a simple rate exists; helpers are callable from the private spike; locks are property-scoped so the HRDAV lane does not block; one browser; no autonomous retry. If helpers must be copied, add 60–90 minutes before the first attempt. If Azure shape fails, the useful result can arrive sooner as a precise failure. That fast failure is not a booking.

Draft 120 sits at the optimistic edge of the booking range. Draft 160 is below the planning total for both checkpoints.

## 5. Locks, guests, CMS, delivery, Save, HRDAV

No new privacy project. Recipient stays in the named private file. No inbox project. No extra guest-data ban beyond the draft’s own rules.

| Check | Result | Anchor | Fix |
|---|---|---|---|
| Two HRCEN keys | Holds, if runtime discovery wins | R7; K3; evidence “two observed HRCEN advisory keys” must be rechecked | Discover the current HRCEN key set at start. A child token is not a lock. On lock loss, stop acts and still reconcile the fake profile |
| Real guests | Partial | R1 exact fake profile; R7 identity before Save; U2 bad profile refuses before Save | Native identity read immediately after profile open, before field entry. Lookup key is the exact fake profile plus the chosen dates. Multi-match stops |
| CMS second row | Partial | R2 second visible option; acceptance example keeps a payment-related label; HRDAV doc “neither current HRCEN order nor the second option’s label is proven” | Record the ordered visible list. Stagehand selects. Native read must match entry 2 of that list before Save. Do not skip rows. Do not match by the old property’s codes. If entry 2 cannot be selected, stop and report the list |
| Delivery | Holds | R2 four facts; K6 inbox not shown accessible; verification does not block booking success on mail | Report checkbox, HMS send ack if any, trace if the approved route exists, and inbox arrival as four fields. Missing access is unknown |
| Ambiguous Save | Partial | R3, K4, acceptance timeout example, R7 penalty rule | One Save `act`, then classify. Visible confirmation without readback stays unverified. Penalty dialog: do not click an accept control; do not ask Stagehand to dismiss it; capture the text; reconcile |
| Parallel HRDAV | Holds with one assertion | R7; serial HRCEN browser; “leave HRDAV untouched” | Acquired keys are the current HRCEN set only. Second HRCEN browser opens only after the first is closed |

“Leave the HRCEN slot untouched” in the verification contract means after release. During the trial the HRCEN locks stay held.

## 6. Fastest simpler architecture

One private script. One HRCEN lease. One browser. No synthetic page. No MCP, pane, upgrade, or product-runner edit.

1. Existing guard discovers and holds the current HRCEN keys.
2. Playwright logs in.
3. Stagehand instance A, `selfHeal:false`, performs every booking action and one Save.
4. Same page, Playwright reads back. Existing lookup runs only if Save is unclear.
5. Report the booking checkpoint here. This is the useful result.
6. Leave the create page.
7. Reset to one start screen. Time the existing reader, then Stagehand navigation, to the same fake record.
8. Retain one observed non-write Action. Clean replay, broken replay with heal off, broken replay on a new `selfHeal:true` instance. Then release the lease.

Speed levers that keep the owner’s test:
- Call existing readback and lookup. Do not reimplement the 1,465-line create runner.
- Let the first real `act` test Azure shape. One small parser fix, then stop if it still fails.
- Write guard fail-closed tests. Skip mocked happy-path booking tests before the run.
- Default to reattachment for the heal instance. A second browser is the failure path.
- No autonomous retry.

Rejected shortcut: Playwright navigates and Stagehand only Saves. Faster, and it repeats the extraction-trial split. It does not answer the question.

## Cannot verify from the supplied draft

- Installed 4.1 source for instance-level `selfHeal`, Action replay, and model-call behavior. K4 asserts it. The evidence table does not quote those lines.
- Ledger medians 0.85 and 0.80, and whether any rows are HRCEN creates.
- Claimed file sizes and whether `save-wait` / `stay-lookup` can be called from the private spike.
- Current HRCEN key count, current CMS order, Azure schema acceptance, inbox or trace access, same-browser reattachment.
- Whether the 12 min and 140/184 min runs share a method with this trial. The draft says they do not.
- Actual recipient, guest identity, and private-file contents. Not reviewed. Do not copy them into tracked docs.
