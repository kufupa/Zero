# Retro: five-day journey run

## Goal and outcome

The prior run sought an evidence-backed next quote-first product slice from saved Centurion data on 19–23 October 2026. It started at 02:09:52 UTC; its final status commit was recorded at 02:39:15 UTC. The later owner correction was committed at 02:44:19 UTC. These timestamps are recorded events, not an ETA or a calibrated speed claim.

- Reviewed ten deliberately selected confirmation-PDF anchors and three independently selected request-first quote journeys. The sample covers all five stored dates but is not random or representative.
- Verified a supported request, staff reply and customer-addressed PDF trail, a bounded search without the literal word “booked,” ambiguous same-agency candidates, a withdrawn quote and an amendment with different confirmation versions. Later HMS captures matched the selected PDF records. See [journeys](booking-journeys.md), [request-first cases](quote-journeys.md) and [decision](decision.md).
- Checked selected candidate-link aggregates independently, preserved private source pointers and reproducible scripts, and committed sanitized research locally. No live quote, HMS write, email send, deployment or flag change was made.

## What helped and what failed

| Finding | Effect on next run |
|---|---|
| Contrasting request-first and confirmation-first cases exposed non-bookings and misleading links. | Continue both directions; preserve supported, candidate and unknown relationships. |
| The deliberate case selection was useful for failure modes but cannot establish case mix, recall, precision or return on investment. | Use the wider corpus to test specific decision-changing hypotheses and disclose selection and denominators. Do not generalize from examples. |
| The export lacked complete attachment inventory, so a claimed attachment or no selected PDF did not establish a mailbox-wide positive or negative. | Keep document-level and thread-level evidence separate; record unavailable evidence instead of searching indefinitely. |
| The prior recommendation treated old quote source and runtime investigation as the starting point. The owner corrected that HMS tools are being rewritten from scratch. | Map real staff needs to the new tools; do not assume legacy code is the current approach or proof of readiness. |
| Some effort went into incidental overlap counts and process metadata after the product decision was already supported. An extra transcript-count check was stopped and its unfinished draft retained privately. | Require a concrete decision that each new analysis can change; pivot or stop if it cannot. |

No ETA was recorded for the earlier corpus/journey run, so there is no estimate to calibrate. Model cost was not independently measured and is not reported. The prior sample and later HMS captures are research evidence, not an end-to-end live product pass. This retro is an assessment of the run, not an instruction to change product code.
