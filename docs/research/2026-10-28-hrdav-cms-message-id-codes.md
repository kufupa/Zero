# HRDAV CMS Message Id options (udfchar09)

Date: 2026-10-28 ~00:50Z. Read-only probe on Product EC2 (checkout `92be0e5d2`), HRDAV slot 127.0.0.1:19225, shared read lease + read-only request guard. Guest Stay → New Record → CMS Message Id lookup → read Ext store → Cancel. Nothing saved.

Owner rule (2026-10-28): CMS Message Id must **never** be blank on a Nava create. Faith (HRDAV) uses `03`. Centurion screenshots (owner) show the same six codes.

| Code | Description (HMS) | Use |
|---|---|---|
| 01 | Booking Confirmation for Guest (with Payment link) | guest-direct booking |
| 012 | Confirmation of payment for Guest | payment proof (later workflow) |
| 014 | Confirmation of payment for Agency or Organization | payment proof (later workflow) |
| **03** | Booking Confirmation for Agency or Organization (with Payment link and Proforma) | **agency/company booking; Faith default** |
| 05 | Online check-in | not a booking letter |
| 08 | Booking Confirmation for Agency or Organization - NO RATE | agency booking where rate must not show |

New-record defaults seen: `udfchar09` blank, `udfchar13` blank, `udfchar07` blank, `udfchkbox04` is an Ext button-style checkbox (not `input[type=checkbox]`). The lookup store field is `userdefinedfieldvalue` / `description`.

Probe script (one-off, not committed): `/tmp/cmsprobe/cms-msgid-probe.mjs` on EC2 and VPS.
