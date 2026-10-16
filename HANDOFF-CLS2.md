# HANDOFF-CLS2 — classifier at ingest

Updated: 2026-10-16T03:29Z

## Done

PR https://github.com/kufupa/Zero/pull/351 (`feat/g-CLS2-10160258`)

Staff open stored read → type is classifier (high/medium), not kind-map Other.

| Input | Stored `luna.workflow` |
|---|---|
| other + billing/high | `send_document` |
| other + billing/low | `other` |
| voucher_pop, no classifier | `payment_ack` (F5 Post payment card) |
| booking + new_booking/medium | `create_booking` |

Store: `mail_extraction.usage.classifier`. No migration. No UI copy.

## Proof

Focused tests 14 passed. Remote typecheck `--baseline` 0 new. Greptile pass after 1 fix round (3 P1s: abort+8s, try/catch, jsonb merge). Pane-gap P1 withdrawn (extract must commit first).

Live 10-mail + 2 pane screenshots: **after deploy**. Lane: no deploy.

## Not doing

Deploy, env, inbound-run.ts, PANE_PRECLASSIFY gate on ingest.
