---
title: Pomerado setup audit and read-stay recovery
date: 2026-10-27
execution: knowledge-work
---

# Pomerado setup audit and read-stay recovery

## Goal and status

The owner asks whether the [setup guide](https://raw.githubusercontent.com/Pomerado/pomerado/main/docs/agent-setup.md) and [how-it-works guide](https://github.com/Pomerado/pomerado/blob/main/docs/how-it-works.md) were followed, and asks to pause and plan if the setup is not already optimal. The live mint is paused. This is a plan, not approval to downgrade safety, change the product or switch model providers. The existing trial authorization and read-only, private-data, Terra and property-lock rules remain in force.

Deliver the original trial, not a smaller substitute: Pomerado mints `hms_read_stay`; run three distinct HRCEN confirmations and compare each returned field and repeated row against the independently inspected, expanded Record View. Report publication, durations, costs, coverage, failures and cleanup. Full booking and Add-Ons are separate, not proved here.

## Current evidence and uncertainty

- The installed release `0.4.0-canary.399` is the npm `latest` tag at the 2026-10-27 check. Node 24.22.1 and an isolated Chromium cache meet its documented prerequisites. The current upstream `main` guides are not asserted to be identical to that release; the release README is [pinned](https://unpkg.com/pomerado@0.4.0-canary.399/README.md).
- The normal local MCP tools were used. The Azure/Terra routing and 30-minute cache compatibility edits are authorized deviations from the vendor's unmodified install. Their provider-level canary passed, but an end-to-end Pomerado mint has not passed. A private diagnostic capture hook also remains installed, with a mode-600 backup.
- The retained `mint9` and `mint10` outcomes record correctable Guardian denials during broad exploration, then unconfirmed sign-in and incomplete publication. The credentials were provided to the MCP client; whether HMS received them is unknown. The controller brief and the actual `mint10` intent contained a contradictory instruction about checking the page before reading its URL or title; its causal effect is unproved.
- Independent Chromium logged into the configured HRCEN tenant and opened the exact three confirmations. That is not a Pomerado login or field-coverage proof. HMS's password-named control is type text; one Pomerado sign-in safeguard checks password-type inputs. Its causal role in the failed mints is unknown.
- No `example_reader` or `example.com` reference appears in the ten retained mint controller logs. The simple Azure request canary is not an end-to-end Pomerado mint. Check any other existing receipt before running another smoke test.
- No publication, three Pomerado calls, or Pomerado-to-HMS field comparisons have occurred. Earlier remaining-time forecasts assumed a successful mint and are superseded. A defensible end-to-end ETA is not established.

## Sequence

1. **Recover the known setup, without reinstalling.** Confirm release, isolated browser, four documented MCP tools, role-by-role approved Azure/Terra routing, and the privately backed-up compatibility edits. Preserve the current outcome-capture hook until its diagnostic purpose is complete. Do not repeat system dependency installation.
2. **Prove the vendor baseline.** If no prior passing receipt exists, run the guide's non-sensitive read-only `example_reader` mint through the same local MCP client and the same patched provider configuration. Follow its one job with `get_job`; answer only questions asked. Verify a published artifact and one documented run. Capture provider and controller cost separately where available. A public-site failure is not evidence about HRCEN: distinguish egress, provider, Guardian and site failures.
3. **Return to the full HMS objective.** If the baseline passes, use one short plain-language request with the configured tenant URL, exact integration name, example confirmation and read authority. Ask for the exact matching Record View, all displayed labels and values, repeated rows and expanded sections. Let Pomerado discover the site and handle sign-in. Remove the contradictory origin instruction. Provide the known password-field detail only if an observed login question or failure makes it necessary. Do not bypass Guardian or hand-code the operation.
4. **Trace a failure at its actual boundary.** Preserve the private job result, Guardian decision and Pomerado execution or sign-in evidence. Distinguish input provided, attempted submission, rejection and authenticated-shell verification. Do not call an unconfirmed sign-in a bad password. If the baseline passes but sign-in fails, use the smallest non-sensitive local login fixture or controlled trace needed to isolate the observed sign-in path, without real credentials or a custom integration harness. Change one variable per hypothesis. Do not patch a guessed cause or count a smaller mint as the original trial.
5. **Publish and run only with independent controls.** Before running any artifact, inspect its source, manifest, login destinations and generated instructions. Pomerado documents that the run does not enforce mint authority. Apply Nava's separate read-only enforcement and property lock. Run the three cases serially and independently inventory all expanded tabs and repeated rows; treat uninspected material as unknown.
6. **Restore and report.** Stop only trial processes, restore interrupted HRCEN and any affected slot, release the named lock, and verify service state. Record setup, mint and call times and model costs with missing usage marked unknown. Restore the isolated diagnostic patch from its private backup when its purpose ends, after checking that it has not changed independently. Update the trial report and active handoff.

## Corrected mint request

> Create a read-only integration named `hms_read_stay` for the supplied HRCEN tenant URL. Given a confirmation number, find the exact reservation, open Record View, expand collapsed sections, and return every displayed field label and value, including repeated rows. If the match or any section is unavailable, say so rather than guessing. Do not create, edit, cancel or send anything.

Pass the actual URL, example input and requested login answers through the private approved flow. Credentials and raw guest data never go in the plan or public prompt. Guardian remains enabled. The request is the goal, not a browser script or a custom harness.

## Acceptance and decision points

| Gate | Pass | Failure response |
|---|---|---|
| Baseline | Published simple example and successful run using our actual approved provider setup | Diagnose that specific non-HMS failure before a new live retry |
| HMS publication | Read-only artifact published after verified HRCEN sign-in | Preserve actual refusal, unknowns and private evidence; stop guessing |
| Three cases | Each exact confirmation opens and all visible fields and repeated rows match independent expanded-screen inventory | Mark incorrect, missing and inaccessible fields separately; no full-coverage claim |
| Safety and cleanup | Private data confined, no writes or sends, lock released, affected services active | Report the specific failed or unverified check |
| Cost | Terra and other allowed model costs separately identified | Report estimates as estimates and internal or interrupted usage as unknown |

## Sources and handoff

- [Trial report and retained evidence](../research/2026-10-27-pomerado-readstay-test.md)
- [Original read-only trial approach](2026-10-27-004-pomerado-readstay-approach.md)
- [Pomerado setup guide](https://raw.githubusercontent.com/Pomerado/pomerado/main/docs/agent-setup.md) and [architecture](https://github.com/Pomerado/pomerado/blob/main/docs/how-it-works.md)
- [Pomerado benchmark](https://pomerado.ai/) covers vendor-reported pre-minted API calls, not the cost of producing this HMS integration or a comparison with Nava's existing deterministic tools.
