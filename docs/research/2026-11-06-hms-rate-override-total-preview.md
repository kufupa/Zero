# Saved-stay rate override: pre-Save total

**Investigated:** 2026-11-06, HRCEN, same-currency ZAR.

**Code:** main `13a1a17bdb1874b60ac8fed9500c88b77b8602cb`, including [PR #1056](https://github.com/kufupa/Zero/pull/1056).

**Conclusion:** no reliable native total before Save was found in the inspected workflow. Keep `proposedTotals: null`. This does not establish that no alternative preview exists anywhere in HMS.

## Question and scope

For an existing saved stay, can HMS calculate the total—including the staged single-night numeric override—before Submit? This is separate from numeric overrides on a new stay, multiple-night changes, and the saved reason-code readback.

The investigation used the existing guarded raw tools and native Stay Wizard. It staged changes only: no Submit, Save, or real-guest write. Private guest identities and HMS response bodies are omitted here.

## Observations

| Evidence | Result |
| --- | --- |
| Labtest baseline | Four saved nights: R2,640, R2,620, R2,620, R2,620. Native saved total: R10,500; tax, fee and add-on values: zero. |
| Labtest unsaved change | First night staged from R2,640 to R2,690, reason `COR`. Wizard nightly grid still showed saved amounts; subtotal, tax, fee and total fields still matched the saved baseline, including total R10,500. |
| Real-email stay | Separately selected real stay; staged one night by R50 without saving. Wizard's subtotal, tax, fee and total again matched its saved baseline. |
| Controls | Observed wizard exposed **Submit** and **Close**; no preview or recalculation button was visible. |
| Public raw tool | On the real-email stay, `prepareRateOverride` returned `outcome: "prepared"`, `proposedTotals: null`, `totalsSource: "saved_stay"` and a populated `reviewedBaseline.totals`. |

These are two observations, not proof for all properties, packages, tax rules, currency combinations, or versions. The Labtest zero tax, fee and add-on values do not establish their behavior elsewhere.

## How it was checked

1. Selected and verified the exact saved Labtest stay. Read native nightly rates and totals through guarded Rate Details, then staged one date with `prepareSavedStayRateOverride`; checked the native form and grid and revalidated the stage. Captured visible controls and correlated native request paths.
2. Repeated the guarded read and unsaved staging on a real-email-referenced stay, then inspected the wizard fields, buttons, network activity and current native controller methods. Ran the public `read` → `readSavedStayRates` → `prepareRateOverride` sequence separately and checked its result. No write authority or Submit was used.
3. During same-currency staging, observed the saved Rate Details read (`OSRATD` and `rateshop/rateDetails`), wizard open (`OSSTWZ`) and `OSSTWZ.RateInstructionChange`. The instruction-change request was sent before the new amount was entered and contained a blank `rateamount`; no repricing request followed amount entry in the observed sequence.
4. Inspected the loaded native `osstwz_onRateAmountChange` controller: when guest and rate currencies match, it returns without a request. Its other mapping is `OSSTWZ.GetConvertedCurrency`. The Submit handler maps to `OSSTWZ.UpdateStayWizard`, which can write the saved stay; it was not called in this investigation.
5. Checked [Infor's Stay Wizard instructions](https://docs.infor.com/hms/2026.09/en-us/hmsolh/s_t1424428573998.html): they describe choosing **Override**, entering the rate and reason, then saving. They do not describe an override-total preview. Infor's **Re-Quote** is a different instruction, so its quote is not evidence of the requested override total.

The one-off Playwright probes and their private fixtures were kept outside the repository; their output was observed during this investigation and is not a durable log. Steps above describe the method and results without depending on those temporary files.

## Existing contract and decision

- [`readSavedStayNightlyRates`](../../apps/server-pilot/tooling/hms-cloud/saved-stay-nightly-rates.mjs) reads the verified **saved** stay's native rates and totals. They are the baseline, not an override preview.
- [`prepareSavedStayRateOverride`](../../apps/server-pilot/tooling/hms-cloud/saved-stay-rate-override.mjs) validates and stages the change, keeps Submit blocked, and compares wizard totals against that baseline. Its `nativePreview.proposedTotals` stays `null`; `totalsSource` is `saved_stay` if those totals match, otherwise `unverified_pre_submit`.
- The public [`prepareRateOverride`](../../apps/server-pilot/tooling/hms-cloud/saved-stay-agent-session.mjs) returns the baseline separately as `reviewedBaseline`, the staged `change`, `proposedTotals: null`, and `totalsSource`. Full inputs and write boundaries are in [native-price-overrides.md](../../apps/server-pilot/tooling/hms-cloud/native-price-overrides.md).
- An authorized Labtest commit can independently reopen the stay and read the actual native totals after Save. Real-guest numeric override commits remain restricted. An HTTP response alone is not proof of persistence.

Do not label saved totals, a Rate Shop quote, or arithmetic from the nightly delta as the HMS proposed total. Tax, fees, package allocations and other native rules may affect the final result.

## Reopen when evidence changes

Revisit if a documented or observed unsaved HMS action/API accepts the exact staged override and returns its recalculated total. Correlate target, date, amount, currency and reason; establish whether its output includes taxes, fees and relevant package charges; and compare it with an independently reopened Labtest stay after an authorized Save. Preserve unknowns and provenance. Do not call `UpdateStayWizard` as a preview: it is a write boundary.
