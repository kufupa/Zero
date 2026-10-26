## Shuttle/transfer corpus

**Bottom line:** Faith/Ayanda are very likely HRDAV; one staff request to Jarat Tours is verified. HRCEN has shuttle/transfer traffic, but its provider and billing workflow remain unknown. The Add-On removal timing comes from one staff account, not verified HMS history.

Read: PRODUCT hard rules, AGENTS VPS rules, FACTS.md, CATALOG.md; `origin/main` was `1299a046e`.

Sources: [F](</home/orca/nava-research/triage-20261019/raw/threads-transport-faith.jsonl.gz>), [A](</home/orca/nava-research/triage-20261019/raw/threads-transport-ayanda.jsonl.gz>), [C](</home/orca/nava-research/triage-20261019/raw/threads-transport-centurion.jsonl.gz>), [D0](</home/orca/nava-research/triage-20261019/d0-augsep-20261019/threads-transport-centurion.jsonl.gz>), [M](</home/orca/nava-research/corpus/2026-10-13/messages.jsonl.gz>). `L#` means line in the decompressed JSONL.

**Property mapping:** Faith/Ayanda are likely HRDAV: their sender domain is shared, while Da Vinci text/closings appear in 27/62 and 15/61 threads respectively; historical mailbox mapping agrees ([F:L10], [A:L36], [FACTS.md:129-133](/home/orca/orca/workspaces/zero/addons-ux-plan-1026/docs/context/FACTS.md:129)). Not every thread is property-verified. Centurion source is HRCEN ([C:L2]). M is mixed-property.

**1. Candidate counts.** Full-file stream; denominator is distinct `thread_id`, not message rows. Screen is keyword-based, not manually adjudicated: shuttle/Jarat/taxi/cab, or transport/airport/driver/transfer terms with a service cue.

| Source / attribution | Candidates / all threads | Share |
|---|---:|---:|
| F / likely HRDAV | 5/62 | 8.1% |
| A / likely HRDAV | 3/61 | 4.9% |
| F+A / HRDAV, disjoint IDs | 8/123 | 6.5% |
| C / HRCEN | 46/3,599 | 1.3% |
| D0 / HRCEN | 64/3,083 | 2.1% |
| M / CEN signature | 104/8,890 | 1.2% |
| M / Da Vinci signature | 26/8,890 | 0.3% |
| M / no or conflicting signature | 66/8,890 | 0.7% |

F/A and C/D0/M are overlapping export sets; do not add their counts. M’s 66 candidates cannot be safely assigned to either property.

**2. Provider emails.**

| Property | Verified staff-to-provider evidence |
|---|---|
| HRDAV | Jarat Tours, `jarattours.co.za`: 1 outbound message in 1 thread ([F:L36-L37]). |
| HRCEN | No provider/domain verified. No Jarat token in C or D0 full scans. External recipients cannot safely be separated into providers vs guests; provider count is unknown, not proof of none. |

M has 6 Jarat threads: 5 with Da Vinci signatures, none with Centurion signature; 1 unassigned.

**3. Who invoices whom?** Exact short phrases from the corpus or sanitized call summary; route remains unresolved.

| Route / question | Evidence |
|---|---|
| Provider → hotel | Call summary: “confirmation and/or invoice”; C has one “Invoice attached” thread. Issuer and recipient not established ([staff call:L20](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-26-staff-call-ui-rates-shuttle-confirmation.md:20), [C:L1105]). |
| Hotel → guest | Call summary says “charge information to the guest”; that is not proof of a hotel invoice ([staff call:L20](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-26-staff-call-ui-rates-shuttle-confirmation.md:20)). |
| Provider → guest | No direct evidence found; unknown. |
| Payer | ASR summary suggests “guest pays the hotel” and “hotel pays transport”; staff says accounting mechanics are unknown ([staff call:L24](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-26-staff-call-ui-rates-shuttle-confirmation.md:24)). |

**4. Fields in the verified provider request.** One message/thread only ([F:L36]); not a proven standard.

| Requested field | Present |
|---|---:|
| Flight | 1/1 |
| Pickup time | 0/1; a drop-off time appears, 1/1 |
| Pax | 1/1 mention; numeric count uncertain |
| Guest name | 0/1 detected as a field |
| Confirmation number | 0/1 |
| Price | 0/1 |

**5. Price evidence.** HRDAV: no clear per-trip/person/way rate; the related thread has untyped totals, excluded as fare evidence ([F:L28, L36]). HRCEN: observed phrases include “R100.00 per trip” (3 threads), “R600.00 per trip” (2), and “R300 return” (1) ([C:L2406, L3379, L3603]). M adds one CEN-signature thread with “R800.00 per trip” alongside “R600.00 per trip” ([M:L2617]). Observed per-trip mentions span ZAR 100–800; not a verified rate card, invoice, or normalized route price.

**6–7. Centurion comparison and Add-On removal.** HRCEN is not “none”: transfer candidates exist, but no provider or comparable workflow is verified, so same/different remains unknown. Add-On mentions: F/A 0; C 17 rows/8 threads (1 candidate); D0 9/4 (2 candidates); M 19/11 (5 candidates). One CEN thread co-mentions Add-On and remove/delete, but does not link removal to provider confirmation ([D0:L3299], [M:L5601]). The Da Vinci staff-call summary says removal happens after confirmation to avoid duplicate posting ([staff call:L21](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-26-staff-call-ui-rates-shuttle-confirmation.md:21)); corpus does not prove that trigger.

**Example thread IDs (five per property):**

- HRDAV: F:L10 `0cdf1d2e-556b-45fb-8d3e-873b965b1379`; F:L28 `3a23118e-4118-4dc1-ba12-c7568650135d`; F:L36 `46eaf790-32a3-404e-9864-8913d3a6ff8d`; A:L35 `697d7c36-4b6f-48ee-9c46-8139d173fc42`; A:L51 `92d94591-7d5d-4094-b98c-b6c4310db95c`.
- HRCEN: C:L2406 `5e3a2d4f-9fbc-4b2f-b1c6-20464fc791ac`; C:L3379 `8983cc61-b226-4aa3-b9f2-b616e5d2d705`; C:L3603 `93edb8f7-f91c-49c4-a36e-da63f1fd01aa`; C:L3754 `9950d33e-7caa-4999-836d-0a8d878c8fad`; C:L5335 `dfecc876-662b-4508-a4ea-31496b83f716`.

**Limits:** No live HMS, visual UI, or event-history check. The call summary itself says exact saved fields and accounting sequence are not independently verified ([staff call:L22, L38, L62-L66](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-26-staff-call-ui-rates-shuttle-confirmation.md:22)). Candidate counts are keyword-screened; invoice direction, provider attribution at HRCEN, and fare validity remain unknown. Research/model cost not measured.