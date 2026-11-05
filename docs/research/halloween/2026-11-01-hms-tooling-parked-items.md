# HMS multi-room and PDF intake decisions

**Current owner direction, 2026-11-01:** include a bounded multi-room pilot and a generic Cloud attachment capability in the new HMS tool plan. The multi-room section below records the earlier deferral and evidence, not the current planning decision. OCR, proof-of-payment extraction, intake triage, and group/XLSX remain parked. Planning approval does not authorize an implementation run, deployment, mail queries, or the previously held probes.

## Multi-room booking

- The owner initially deferred multi-room create/link workflows, then called the Centurion clusters below a strong pilot signal. On 2026-11-01 they accepted a bounded multi-room pilot in the new plan. This is not authorization to build or deploy now. Preserve existing capabilities and held-probe boundaries.
- The selected 892 Centurion records include **24 same-guest, same-date clusters / 61 records with differing assigned rooms**. Independently recomputed from the private Record View capture by grouping nonblank guest profile ID, arrival and departure, then requiring at least two distinct nonblank assigned rooms; no guest values were printed. The broader group with multiple records, regardless of room assignment, contains 40 clusters / 97 records. This is useful evidence of likely simultaneous multi-room needs, not proof that each cluster was an HMS-linked booking or a population-wide incidence estimate. [Capture provenance](2026-11-01-hms-field-scope-audit.md#2-evidence-and-limits).
- HRDAV has an observed Labtest example: two rooms linked through Associated Reservations each received a separate confirmation. The [legacy Add Record runner](../../../apps/server-pilot/tooling/playwright-quote/add-room-stay.mjs) is historical reference: it handles room, rate, adults and child bands, with several fields inherited from the parent, and refuses children aged 13–17 on the added-room form. Do not edit or build on the legacy tool; use its evidence as inspiration for a new modular Cloud capability designed for the Centurion SaaS UI. HRCEN Cloud support remains to be checked.
- The 892 snapshots did not capture linked-reservation grids. A separate 60-stay grid capture found no other linked confirmation, but all 24 self-only results had questionable completeness. Do not treat missing associations as zero usage.
- When reviewing scope, examine linked-booking needs, per-room versus shared fields, existing Add Record behavior, independent readback, and the staff workflow. Preserve property-specific and guest-write safety boundaries; do not repeat any previously held probe.

## OCR, POP extraction and intake triage

- Defer OCR/scanned-PDF extraction, proof-of-payment document interpretation, and related intake/triage field wiring from this HMS-tooling scope. They have a different input, workflow and evaluation path. This does not remove general-purpose HMS document or finance reads from consideration.
- Existing voucher code includes an opt-in scanned-PDF vision path; its effective runtime and full POP workflow are unverified. Later, inventory existing PDF extraction and OCR options (including Poppler and Firecrawl where applicable), input formats, authorizations, triage fields, and current integration before designing changes.
- Validate later against representative, privacy-safe document cases and staff workflow outcomes. A document's claim is not proof that funds cleared; treat mismatches and unknowns explicitly.

### Voucher versus payment proof: practical HMS overlap

- A travel-agent voucher can be a booking or billing instruction, not evidence that the guest has paid. It can arrive before a reservation exists. A proof of payment instead claims that money was transferred, usually for an existing stay; the claim and a posted/cleared transaction are different facts.
- Both workflows may need the same general HMS capabilities: find the correct stay when one exists, read reservation/billing context, list document metadata, and attach an approved PDF to that stay. A future payment-reconciliation workflow may also need folio transactions; do not assume every voucher needs them.
- Current `voucher_review` is staff review/acknowledgement, not automatic matching, upload or payment posting. POP extraction, OCR and intake/triage remain parked. This note does not authorize live mail or HMS work.
- Existing references: [voucher/POP extraction rules](../../../apps/server-pilot/src/ai/extraction/extract.ts), [payment-proof SOP](../../../apps/server-pilot/src/ai/aop/payment-proof-sop.ts), [Cloud document reader](../../../apps/server-pilot/tooling/hms-cloud/stay360-documents.mjs), [legacy Playwright PDF uploader](../../../apps/server-pilot/tooling/playwright-quote/attach-document.mjs) and [Cloud finance projection](../../../apps/server-pilot/tooling/hms-cloud/guest-stay-finance-preflight.mjs). The uploader is historical reference only: do not edit or build on it; design a new modular Cloud uploader for the Centurion SaaS UI if upload is in scope. Current Cloud runtime and end-to-end proof must be checked separately.

Related parked item: [Centurion group-PDF discovery](2026-11-01-group-pdf-discovery-todo.md).
