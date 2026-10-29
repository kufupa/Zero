# Stagehand fresh trial handoff — 2026-10-28

The owner asked for a fresh Stagehand-led, read-only HRCEN Proof Labtest trial, field inventory, Rate Shop prices and screenshots. They requested stop and retro; the final in-flight retry finished. Do not launch another live run without a new decision. No booking save, send, deploy or flag change was recorded.

- Trial record: `docs/research/2026-10-28-stagehand-fresh-trial-f777f33d.md`.
- Last experimental script: `.private/stagehand-fresh-f777f33d/run-r12.mjs`. It is not a complete working rate-grid solution.
- Screenshot index: `.private/stagehand-fresh-f777f33d/screenshots-inventory.md`. It lists 113 fresh-trial screenshots on Product EC2, 22 verified local copies, and four additional earlier profile screenshots in EC2 temporary directories.
- Form label list: `.private/stagehand-fresh-f777f33d/guest-stay-field-list.md`. It contains 100 distinct Record View label texts, 101 occurrences. Other tabs, unlabeled controls, requiredness and values are not covered.

## Result and limitations

Stagehand 4.3, using GPT-6.1 Terra via Azure, logged in and navigated to Stay 360. Unnamed HMS toolbar controls required a generic browser-local tooltip accessibility-label aid before Stagehand found New Record. The script found profile 47170, Proof Labtest, and entered names separately. The screenshot confirms visible values, not a persisted profile binding. It entered future date text, but captured form Nights and weekday labels were inconsistent, with cause unproven.

A second generic browser-local aid exposed unnamed Ext lookup triggers. Stagehand opened Rate Shop. The `Preset` search returned `Selected criteria is not available for these dates`; retrying after an attempt to enable restricted sell options gave the same message. Other strategies and dates remain untested. The script then rejected Stagehand's unblocked `press` suggestion because the action allowlist omitted it. No nightly rate rows were obtained. The resulting path was assisted and is not a proven end-to-end deterministic replay. The script did not provide a comprehensive network-level write block.

The r6 file `02-stay360.png` is mislabeled: it shows Start Center. Initial r11 Rate Shop values were not identified as nightly prices. Do not present either as evidence of a completed price grid.

## If work resumes after a new owner decision

Investigate the actual Stagehand keypress action, verify dates and derived form state together, test an identified strategy without assuming availability, independently verify all grid rows and nightly prices, then separately benchmark replay. Preserve browser checkpoints where safe instead of restarting on every fault. These are untested next steps, not claims of success or authorization to run.
