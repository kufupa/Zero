# Evidence: HMS guest add-ons and shuttle workflow

**Snapshot:** 2026-10-26. Planning/research only. No code, flags, HMS records, deployments, or emails changed.

## Verdict

- Deterministic Playwright HMS tools exist for reservation reads and guarded create flows. Current `origin/main` does **not** contain a structured Infor Guest Stay → Add-Ons writer.
- Current quote extras and generated reservation notes are not Add-On rows. The note path can include a priced shuttle line, so it must not be mistaken for a non-billable provider-coordination note.
- Da Vinci evidence supports third-party transport coordination, but does not prove a universal shuttle billing rule. A new 2026-10-26 Centurion staff-call transcript reports a temporary HMS Add-On, transport-desk request, removal after confirmation, then a guest/reception note; payer/accounting mechanics and exact note field remain unresolved. See [supplemental staff-call report](2026-10-26-staff-call-ui-rates-shuttle-confirmation.md). Group transport charges may be combined with dinner in an Excel quote and paid on one folio.
- Recommendation: scope a property-aware Add-On writer separately from shuttle fulfillment. Keep shuttle provider requests staff-reviewed and unsent; default to non-billable HMS status text only when property policy confirms it. Do not add a charge line by inference.

## Evidence ledger

| Claim | Evidence | Counterevidence / limit | Status |
|---|---|---|---|
| Nava uses deterministic HMS tools | `PRODUCT.md:9` describes deterministic Playwright tools. `pane-stay-save.ts:77-84` exposes explicit preview/commit and guarded create/amend/cancel modes. | A deterministic create path does not prove every HMS screen or workflow is automated. Current runtime was not freshly probed for this scope. | Supported for existing paths |
| Structured Guest Stay Add-Ons are not wired | Current `origin/main` `PaneStay` input has `reservationNote?: string` (`apps/server-pilot/src/ai/pane-stay-save.ts:66-75`), but no typed Add-On row list. A targeted `origin/main` search for `Non-Room Item`, Guest Stay Add-On fields, item IDs, visit counts, and transport provider writer found no writer path. | Absence search is not proof about Infor’s own UI; client description/screenshots establish the HMS UI exists, not that Nava writes it. | Supported from current source; live HMS shape unresolved |
| Quote extras are not structured HMS lines | `StaffStayExtras` supports shuttle, lunch, dinner, and other, but not breakfast or tea (`apps/mail/lib/quote-workflow/types.ts:471-488`). Dinner can be configured for quote pricing (`apps/server-pilot/src/ai/staff-quote-installation.ts:61-79`). | These are quote/PDF concepts; they do not establish Infor item IDs, taxes, units, or folio behavior. | Supported |
| Reservation note can contain priced extras | `noteExtras()` adds a shuttle label, amount, and trip count to free text (`apps/mail/lib/quote-workflow/reservation-note.ts:73-90`); the pane create payload passes a `reservationNote` string (`apps/mail/lib/quote-workflow/pane-stay-bind.ts:88-95`). | A note is not a billable HMS Add-On row and does not book a provider. Its current priced shuttle text may be wrong for direct-provider billing. | Supported |
| Meal requests have quote demand | Historic paired quote report found meal/dinner requests in 58/93 pairs (62.4%) (`/home/orca/nava-research/reports/r1-quote-gold.md:149`). | This is quote-demand evidence from one corpus snapshot—not Add-On row frequency, staff workflow, or property-specific item availability. | Supported, limited |
| Ask #136 is quote-extra UI, not provider integration | `docs/context/OWNER-ASKS.md:265` asks for shuttle trips by date/count and minimal room-builder-style editing; lunch/dinner allowances and “Other” are also named. | It does not establish who fulfills or bills shuttle service, nor request sending provider email. | Supported |
| Da Vinci uses an external transport process | Interview synthesis says passenger count determines vehicle; a third-party provider is strict about matching them; a transport-desk request template and guest pickup instructions exist (`docs/research/2026-10-20-arch-lanes/l5-reservationist-workflow.md:31-34,53-60`). | Interview is not a live inbound→Infor→provider trace; no Infor screen/order was shown (`:4,8,47`). Rates and workflow are Da Vinci-specific. | Supported for described Da Vinci practice |
| Shuttle must never be hotel-billed | No supporting Da Vinci proof found. Interview says transport and dinner may be separate services and group charges can be added to Excel quote and paid together on one folio (`l5-reservationist-workflow.md:31`). | That group example does not prove every shuttle is hotel-billed; it does contradict a universal “provider always charges directly” assumption. | Unresolved; do not encode universal rule |
| Centurion shuttle policy | L5 explicitly says Centurion shuttle/pickup/package rules were not found (`l5-reservationist-workflow.md:71,103`); a 2026-10-26 staff call now reports a temporary Add-On → provider request → remove Add-On → guest/reception note sequence. | One AI-generated transcript; payer/accounting mechanics, exact note field, and hotel-wide policy remain unverified. See [staff-call report](2026-10-26-staff-call-ui-rates-shuttle-confirmation.md). | Partially described; policy unresolved |

## Aggregate-only corpus screen

Source files were private local mailbox snapshots under `/home/orca/nava-research/triage-20261019/raw/threads-transport-*.jsonl.gz`. The screen matched subject and `text_body`; it did not inspect attachments, adjudicate threads, or establish a complete workflow. No raw mail or identity data is copied here.

| Mailbox snapshot | Snapshot size | Expanded transport terms | Tight shuttle phrases | What can be inferred |
|---|---:|---:|---:|---|
| Centurion | 6,183 messages; 3,599 threads | 537 messages; 283 threads | 108 messages; 23 threads (69 inbound, 39 outbound; 14 threads contain both directions) | 23/3,599 = 0.64% are lexical candidates in this snapshot only—not true shuttle prevalence. Tight screen had 9 provider-cue messages, 0 `double-book` phrase matches, and 9 “do not/add/book/charge” cue matches. Cues overlap and are unreviewed. |
| Da Vinci — Ayanda | 75 messages; 61 threads | 6 messages; 5 threads | 0 messages/threads | Incomplete alias sample; absence is not evidence of no workflow. |
| Da Vinci — Faith | 100 messages; 62 threads | 13 messages; 7 threads | 1 inbound message; 1 thread | One lexical hit cannot establish provider, HMS-note, or payment steps. |

- Only two of five known Da Vinci mailbox aliases were screened here. The Da Vinci sample is too small for case-mix or hotel-wide conclusions.
- A prior exploratory transport-term query returned 210 Centurion messages/59 threads and 6/5 plus 8/4 for the two Da Vinci snapshots. Its term set differs from the later expanded/tight screens; counts are not directly comparable. Do not use it as a denominator or claim of a trend.
- Zero exact `double-book` matches does not disprove the staff recollection. The 9 negation-pattern matches need human review; keyword cues are not labels.

## Scope implications

1. **Keep four concepts separate:** quote extra/price; free-text reservation note; structured, potentially billable Guest Stay Add-On row; external shuttle request/confirmation.
2. **Add-On writer:** exact property-specific item code, label, charge basis, date/time, quantity/visits, currency/folio behavior, and inclusion rules must come from the live HMS catalogue and staff policy. Breakfast must not be added when already included in the selected board; dinner pricing must remain the hotel-approved amount/unit; tea must not inherit another item’s code or rate.
3. **Shuttle:** model request, provider response, and completion separately from HMS billing. A staff-approved provider email remains an unsent draft for staff to send. Record a non-billable HMS status only after the hotel’s policy and note wording are confirmed. Keep a separate explicit hotel-billed/group path if staff evidence supports it.
4. **No auto-send and no automatic financial inference.** Nava never sends independently (`origin/main:PRODUCT.md:42`). Real-guest writes remain gated; current `origin/main:PRODUCT.md:48-50` says writes only on Labtest and that Labtest writes are always allowed. No live Add-On canary was run here.
5. **Commercial scope check:** prior Phase 1 proposal review indicated scope centered on standard individual room reservations and excluded custom workflows. The source-copy path was not captured in this scoped pass; reopen the signed proposal before making any fee or inclusion claim. Treat shuttle-provider automation as separately scoped until confirmed.

## Remaining evidence needed

- Read-only DOM/catalog capture for HRCEN and HRDAV: exact Add-On item IDs, required fields, prices/units, whether meal plans already include the service, and post-save readback.
- Property-specific approval and billing rules for breakfast, dinner, tea/high tea, and shuttle (including group/folio exception).
- Centurion provider contact/template and whether the provider or hotel charges for each service mode.
- Da Vinci corpus expansion to all five approved aliases and a human-adjudicated, outbound-grounded sample; Centurion candidate adjudication including attachments.
- A deterministic Add-On canary on a Labtest stay at each hotel. No such canary is in the evidence examined here.

## Provenance and limits

- Code audit base: `origin/main` `02b7d595d`; active worktree `HEAD` `a9435e6a3` is behind. The current-main delta since earlier audit `2ede96d03` adds durable create-preview persistence and property outage handling, not Add-On row writes; targeted current-main search remains empty. Do not use the parked checkout as runtime proof.
- Latest available operational handoff (`/tmp/or2/HANDOFF.md`, 2026-10-26 12:00Z) reports production at `02ef8cc` after quote-note changes, with a later lease change queued. This is a dated report, not a fresh runtime check. The current source audit still finds no structured Add-On writer.
- Research route: local files and read-only code review. No web/Exa used. Per-model $ usage was not exposed by the session tools; no cost is represented as an invoice.
- **95 threshold:** met for the source-level distinction (deterministic create/note paths exist; structured Add-On writer absent in audited `origin/main`). Not met for shuttle billing policy, hotel-wide workflow, or Add-On field mapping. Safest conclusion: no structured Add-On automation today; shuttle billing must remain staff/property-configured.
