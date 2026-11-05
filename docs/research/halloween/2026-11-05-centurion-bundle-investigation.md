# Centurion native bundle investigation

Centurion has two configured conference bundles, but neither appeared in this
confirmation cohort. The 891 complete current Add-On reads contained 18 saved
individual items across 18 stays, with no bundle IDs, parent IDs or package
flags set. Defer PACK writes for the observed reservation workload.

## Where bundles live

The native Add-Ons window's Type selector separates three categories. Breakfast
and dinner meal-plan labels on the Stay card are separate evidence from saved
MEAL or PACK rows in the Add-Ons grid.

| Native type | Catalogue entries | Saved rows in complete cohort reads |
| --- | ---: | ---: |
| ITEM — Non-Room Item | 33 | 18 |
| PACK — Non-Room Bundle | 2 | 0 |
| MEAL — Meal Plan | 12 | 0 |

The PACK definitions are `DCPF` (Full Day Conference Package, native ID 9) and
`DCPH` (Half Day Conference Package, native ID 8). Both the existing Labtest
catalogue inspection and a real email-linked Reserved stay returned complete,
matching catalogues for all three types.

| Saved ITEM code | Native catalogue name | Rows / stays |
| --- | --- | ---: |
| ADDINA | Adults Dinner | 7 |
| ADDLNA | Adults Lunch | 4 |
| ADDBFC | Childs Breakfast | 3 |
| TRNSOT | Transport - Third Party | 3 |
| SUNDV | Sundry Vatable | 1 |

Codes were joined by native type and item ID, not inferred from descriptions.
Five distinct item/relationship structures received independent detailed reads;
all passed. The already-populated Labtest's five detailed items also passed and
are excluded from usage counts.

## Coverage and limits

- All 894 distinct candidates were attempted: 951 attempts, 52 confirmations
  retried, 891 complete reads, 873 complete empty grids, no partial reads.
- Three outcomes remain unknown: two confirmations not found in their dated
  search windows, and one ambiguous exact confirmation. Unknowns are excluded
  from the usage denominator.
- Reads ran 2026-11-05, 18:18–20:12 UTC. This is a collection over time, not an
  atomic snapshot or booking-time history. Every attempt retains its timestamp.
- The source is an outbound confirmation-PDF cohort, not a random sample or a
  complete hotel census. Conference events or day-use business may fall outside
  it. Zero observed PACK rows does not establish that Centurion never uses them.
- The old snapshot had 892 verified records and unexpanded Add-Ons cards. Its
  885 breakfast/dinner-inclusive meal-plan labels did not establish bundle usage.
  Current complete reads show 884 such labels; one meal-plan field is unknown.
- The current default Guest Stay Rate Shop catalogue returned 68 entries, all
  with raw `nonroombundle=0`. Its meal-plan flags are `-1` or `0`; these are raw
  configuration flags, not bundle IDs or proof of automatic attachment.

## Tools and next step

`readStay360AddOns` already retained saved native types, relationship fields and
coverage. Added `listStay360AddOnCatalogue(page, confirmation, {itemType})` for
ITEM, PACK and MEAL. The existing JSON session now accepts `itemType` on `list`
and `detailIds` on `read`; those fields are refused on write operations.
Existing insertion support remains ITEM only.

The batch reader uses fresh guarded sessions, bounded retries, per-attempt
private JSON and resumable input hashes. Verified historical HMS names resolve
ambiguous PDF hints only when exactly one current name matches; the existing
exact name/date reader still verifies the selection. No HMS writes were made.

Keep these readers. Before implementing conference bundle writes, find an
actual conferencing/day-use example and inspect its native parent/components,
preparation, submission and independent readback. Those write semantics remain
unproven; this investigation created no fake bundle.

## Reusable artifacts

Private run directory:
`/home/orca/.local/share/zero/research/halloween/bundle-investigation-20261105/run-20261105T1805`.
Directories are 0700 and JSON files 0600; guest snapshots stay outside Git.

- `source-snapshot.json`, `candidates.json`, `historical-analysis.json`: frozen
  full source, provenance and historical analysis.
- `catalogues.json`, `rate-catalogue-attempt-2.json`, `json-read-tools.json`:
  native configuration and backend contract proofs.
- `scan/records/*/attempt-*.json`, `scan/progress.json`, `scan/reads.json`:
  every attempted lookup/Add-On result, including original failures and retries.
- `details.json`, `analysis.json`, `manifest.json`: selected full detail reads,
  reproducible aggregates, source/tool hashes and coverage.

Source SHA-256:
`85e6891ce4bdda359b4ca01092467573797b4914b915974fd9b62b2e4257a085`.
The saved plan is `docs/plans/2026-11-05-centurion-bundle-investigation.md`;
analysis and collection scripts live in `tooling/hms-cloud/diagnostics/`.

Existing focused lookup/session/read-guard checks passed 11/11. Live proofs
covered empty and populated grids, exact saved-row details, all three typed
catalogues and refusal of a write request containing `itemType`.
