# HANDOFF-CLS2 — classifier at ingest

Updated: 2026-10-16T03:09Z

## Goal

Staff open stored read → type is classifier result (high/medium), not kind-map `other`. Billing/POP show Billing / Payment proof.

## Status

Code green on focused tests. Next: commit, remote-typecheck, PR.

## What landed

| Piece | Where |
|---|---|
| Store `{workflow,confidence}` | `mail_extraction.usage.classifier` (existing jsonb, no migration) |
| Run classifier | `worker.ts` `storeWorkflowClassifierForInbound` after inbound_extraction success |
| Pane type | `storedAnalysis` high/medium → `COARSE_TO_AGENT` (`create`→`create_booking`) |
| Fallback | `voucher_pop` → `payment_ack`; low confidence → `WORKFLOW_BY_KIND` |

## Tests

`apps/server-pilot/tests/stored-analysis-classifier.test.ts` + usage round-trip in `workflow-classifier.test.ts`: **14 passed**.

- other + billing/high → `send_document`
- other + billing/low → `other`
- voucher_pop, no classifier → `payment_ack`
- booking + new_booking/medium → `create_booking`

## Not doing

Deploy, env, PANE_PRECLASSIFY gate on ingest (always on). Live 10-mail pane proof waits for deploy.

## Lines

+93 / −1 production. Under MaxLines 200.
