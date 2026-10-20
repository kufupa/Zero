# Labtest booking-state field table (U4)

Placeholder for the orchestrator after the one Proof Labtest Save. This lane did not drive HMS and did not invent live values.

Reader keys come from `read-reservation-fields.mjs` `BOOKING_STATE_KEYS`. A missing DOM/HDR field is `null`. Never infer paid/unpaid from absence.

| HMS name | Reader key | Observed value | Notes |
|---|---|---|---|
| `guaranteetype` | `guaranteeType` | _pending live probe_ | Combo options logged by `chooseCombo` before click |
| `depositreceived` | `depositReceived` | _pending live probe_ | Missing → null. Do not guess payment |
| `araccountname` | `arAccount` | _pending live probe_ | A/R account |
| `ta1` | `agency` | _pending live probe_ | Primary booking agency |
| `company` | `company` | _pending live probe_ | Organization |

Screenshots: orchestrator captures after the live Save (`/tmp/pane-stay-*/`). `send_on_save` stays unknown until the mailbox watch.
