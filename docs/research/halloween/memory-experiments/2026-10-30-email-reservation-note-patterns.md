# E-Mail reservation-note and billing-instruction patterns

> Historical findings from 30 October 2026; implementation status may have changed since this analysis.

Local analysis, 30 October 2026. Scope: the 492 successful HRCEN snapshots with Record View Source of Business `E-Mail`, linked to the existing outbound confirmation corpus. This is a later PMS snapshot, not an independent record of each inbound request or original booking-time instruction.

## How similar is the main note field?

The `Reservation Note / Billing Instructions` field is nonempty on 491/492 stays. After normalizing case and whitespace, there are 265 distinct strings: 59 strings occur more than once, covering 285 stays, and 206 occur once. Of those 206 singletons, 131 have a different note with character-level `SequenceMatcher` similarity of at least 0.85; numbers remain in the comparison. Thus 416/491 notes have an exact or near-text neighbor by this heuristic. Similar wording does not establish equivalent instructions: a different amount or a short negation can be material.

These priority-ordered bins are mutually exclusive; they count literal phrases, so variants and typos can fall into a different bin. They are not verified accounting classifications.

| Phrase bin | Stays |
| --- | ---: |
| `to agent` and `extras direct` | 284 |
| `to company` and `extras direct` | 51 |
| `extras direct`, without the preceding two patterns | 32 |
| `settle direct` | 81 |
| `to agent` without the exact extras phrase | 18 |
| `to company` without the exact extras phrase | 10 |
| No recognized phrase above | 15 |
| Field blank | 1 |
| Total | 492 |

Examples of the most frequent exact normalized strings or truncated safe excerpts: an agency/DBB/extras/government-dinner note appears 35 times; `settle direct` appears 28; `BB to agent extras direct` appears 21; the agency/DBB/government-dinner wording prefixed with `awaiting payment` appears 18; and `settle direct on arrival` appears 14.

## Overlapping topics and cross-field observations

- Literal phrases: `extras direct` 367, `to agent` 302, `to company` 61, `settle direct` 81, `DBB` 262, `BB` 132, `dinner` 258, `on arrival` 130, `awaiting payment` 59, `prepaid` 39, and `awaiting voucher` 11. Topic counts overlap.
- 127 notes contain `DBB`, `to agent`, `extras direct`, and a government-dinner phrase followed by R210. All 127 have rate plan `NGOVDB` and recorded meal plan `Dinner, Bed, Breakfast & Beverage R`. Their guarantee types vary: Guaranteed By Deposit 47, Deposit Requested 41, Guaranteed By Agent 37, Guaranteed By Company 1 and Guaranteed By Credit Card 1.
- Of 258 notes mentioning dinner, 256 have a detectable first rand amount after the word `dinner`: R210 on 186, R350 on 27, R300 on 14, R250 on eight, R600 on seven, R400 on six, R330 on five and R200 on three. These are text mentions; the script does not prove that each amount means the same kind of allowance. Of 171 notes with `GOV` between `dinner` and that first amount, all first mention R210. None of these amounts establishes current policy.
- Every one of the 13 observed rate codes has one recorded meal-plan value within this sample. All 204 `NGOVDB` stays show `Dinner, Bed, Breakfast & Beverage R`; the 95 `NCOR1B`, 63 `NGOVB`, 52 `NCOR2B` and 45 `BAR` stays show `Bed & Breakfast R`. This is an observed association, not proof of an immutable rule.
- 65 notes contain `DBB` while the structured meal plan reads `Bed & Breakfast R`. This can reflect an add-on, terminology, subsequent changes, or something else; the data does not establish an error.
- Of the 302 `to agent` notes, 22 snapshots have no primary booking agency populated and 181 have no A/R account populated. Text and structured fields do not necessarily mean the same thing.
- Of the 59 `awaiting payment` notes, 45 stays were Cancelled, six Checked Out, four Reserved and four No Show when captured. The note may be historical; status does not establish what happened to payment.
- Rarer explicit phrases include `lunch` 10, `transfer` seven, `airport` six and `wheelchair` one. Text may be truncated or use different wording, so these are lower bounds on mentions, not prevalence estimates for every related request.

## Separate Notes popups

39 stays have a captured Notes popup. Record View captured 40 popup instances across those stays; 38 stays also had the same popup text captured in 1a. These are separate from the main note field. The popup text contains UI wrapper text and guest-specific details, so automatic word counts are exploratory. Examples include `no payment no check in` (two instances), a late-cancellation charge instruction, an extra-person/breakfast note and same-room wording. The saved reader did not comprehensively inspect the separate Notes tab.

## Product implications

Keep the raw source private and treat notes as observations. A useful agent-facing representation could separately capture payer, covered items, extras, payment state, meal limits and request-specific instructions, with source and observation time. Do not automatically turn a historical amount or a guest-specific request into a permanent hotel rule. Resolve apparent conflicts with the live record, current request and staff.

The private derived file `centurion-email-note-bins-2026-10-30.json` under the shared Halloween analysis directory contains confirmation IDs, literal phrase flags and bins, not raw note text or guest names. It is mode 0600 and is not committed. This analysis did not change HMS or the existing memory module.
