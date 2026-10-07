# Case coverage + gap audit (Oct 6 2026, 22:40 UTC)

Companion to `2026-10-06-002-reservationist-mvp-retro-and-sprint-plan.md`. Counts only; no PII.

## Sources

| Code | Source | Quality |
|---|---|---|
| QW | `.private/reservationist-recovery-20261004/reusable-product-20261005/delivery-week-quote-selection.json` — 846 inbound Sep 26–Oct 2 → 28 genuine quote asks (21 accommodation + 7 conference) | AI-reviewed per row; small n |
| PR | `.private/gold-proposals-analysis.txt` — 45 staff proposal PDFs | human-authored; excludes events desk |
| BL | Cursor chat 74b47470 — 149 HMS confirmation letters Sep 19–Oct 2, classified by party | letter parse + hand reclass |
| CLI | `.private/cli-coverage/` — 355 Sep 9–18 inbounds, Luna labels + extracts; census script `/tmp/retro/extract_census.py` | LLM; "quote" tag over-inclusive (only 41% had both dates) |
| S9 | `.private/centurion-corpus/centurion-tool-demand-20260919/STATUS.md` | LLM tool-demand ranks |
| LAB | `.private/create-screen/lab-save.md` | live lab proof |
| Subagent F | `/tmp/retro/out-F-case-taxonomy.md` | merged taxonomy |

## Measured (CLI create cohort n=91, field not stated in mail/PDF)

track 97% · ratePlan 93% · roomType 90% · guaranteeType 87% · adults 75% · sourceOfBusiness 69% · party lookup needed 45–63% · PDF text present 40% · voucher 43% · price stated 38% · amend/extend/cancel wording 32% · card details 14%.

## Code facts

- Create types any rate-plan code (`create-lab-stay.mjs:279`); rate shop lists BAR only (`create-request.mjs:205`). Gap = which code, not tool.
- Confirmation letters print no rate code (Cursor 74b47470 L1461). Quote results return HMS `rate.code` and mark negotiated rates `contextual` (`fetch-quote.mjs:488`) → party_lookup → quote(rateContext) → create can carry the contract code.
- Quote: one date range per run (`staff-quote-workflow.ts:115`, `staff-quote-bind.ts:201`); 30-night cap (`quote-contract.mjs:3`).
- Create: one reservation per run, no rooms/notes/payment fields (`create-tool.schema.json`).
- No tool generates/sends confirmation letter or pro forma (S9: 111 / 106 staff threads).
- Lab cancel stall cause: cancellation-penalty dialog (R2,060) left unanswered by stop rule; folio posting unverified (`lab-save.md:46-62`, `astra-penalty-last.md`).

## Existing infra found 22:45 (re-estimates)

- `rate-check.ts` (153 + 145 test lines) is already on main (`0a924c0c`), wired in the agent path (`reservationist-execution.ts:217`). Earlier claim "parked branch only" was wrong. Rate check = wiring only.
- Multi-date: groups already carry per-group dates; agent path loops ≤5 quote requests into separate revisions (`reservationist-execution.ts:330`); attestation has `revisionIds[]`; PDF prints per-line dates. Blockers: two guards (`staff-quote-bind.ts:201`, `staff-quote-workflow.ts:115`), `executeStaffQuote` rejects alternatives, renderer takes one revision, draft takes one `revisionRef`.
- Extras: `deriveAuthorizedExtraLines` + PDF support person_service / trip / item lines with provenance hash; staff path passes `proposalFacts: []` (`workstation.ts:433`).
- Reservation search exposes company, booking agency, channel, market segment, source of business, group, rate plan, room type (`live-company-account-read-driver.ts:3-6`); no date-range listing mode yet; track/guarantee unproven.

## Plan corrections

1. Plan §3.4 "static defaults table" for ratePlan/roomType is wrong for 77% of bookings (contract parties). Use quote-derived codes; static rules only for track/source/guarantee.
2. Plan §4 `inReplyTo` outcome join fails for bookings: confirmation letters are new threads (2/133 joined).
3. Plan §4 "~8 local PDFs" is wrong: Sep shards carry pdftotext for 67 messages / 77 files.

## Coverage estimates (95 threshold not met — no human census)

| Lane | Plan as written | Plan + top fixes |
|---|---|---|
| Quote full / partial / manual | 30–35 / 25–30 / 35–40% | ~45–50 / ~15 / ~35% (manual = conference/events/groups) |
| Booking (excl. OTA) full / partial / manual | ≤20 / ~50 / ~30% | ~50–60 / ~15–20 / ~25–30% |

## Research to close

R1 case census backtest (analyse extraction over 846 + 355, user checks 30) · R2 track/source/guarantee rules (ask client; verify 10 read-only reservation reads) · R3 one live contract-context quote · R4 multi-room share from R1 · R5 read lab folio for penalty; pick no-penalty lab rate · R6 time one create `--stop-before` · R7 proposal PDF manual line support · R8 confirmation/pro forma: HMS auto vs staff click · R9 mask card numbers before Luna.
