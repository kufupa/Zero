# HMS Tax Invoice blocked: role menu absent (not fn-code guess)

## Symptom

`observeTaxInvoiceMetadata` returns `BLOCKED_TAX_INVOICE_SURFACE_UNPROVEN`. Official Infor docs name Front Desk > Tax Invoice as display-only, but live Centurion view_only session cannot open it.

## Root cause

Tenant **role entitlement**, not unknown transport. Menu-first re-prove (`hms-tax-invoice-reprove.ts`, SHA `8a807c878c`):

1. Front Desk expand + full tree dump: **Tax Invoice label absent**.
2. BSSTRT `MENU_MODULE_KEY` 0–12 sweep: **no Tax Invoice itemLabel**.
3. Stay 360 fallback after list failure: find-open grid row → **no Tax Invoice tile / Guest Stay Tax Invoicing tab**; no tax function codes on network.
4. Prior OSTXI/PSTXI open guesses were invalid as proof (docs ≠ role grant).

Print/Email/Resend/Generate remain denied regardless.

## Fix / next

- Keep fail-closed; do **not** add tax-invoice manifest without observed `preTransmissionEvidence`.
- External: grant view_only **Front Desk > Tax Invoice** (or Stay 360 Tax Invoice tile).
- Re-run: `HMS_DISCOVERY_ALLOW_LIVE=1 pnpm exec tsx scripts/hms-tax-invoice-reprove.ts`

## Prevention

- Prove surfaces via exact menu click + redacted signatures first.
- Function-code guesses never create `preTransmissionEvidence`.
- Docs pages do not imply tenant role entitlement.
