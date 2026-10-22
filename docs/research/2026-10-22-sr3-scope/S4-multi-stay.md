> 🧠 **From Hindsight memory (C3 all-room nightly availability facts)** — Design calls for one view-only availability probe per complete stay; current code has that path, gated off.

## 1. Current state

Basis: required startup docs + requested plan/R2/L1/L3 read; `HEAD = origin/main = db4abaca4`, tree clean.

| Slice | Verified now |
|---|---|
| Extract | One stay per date set; guests/action are still optional. Stay ID derives from message + array position. [extract.ts:54](<apps/server-pilot/src/ai/extraction/extract.ts:54>) [extract.ts:62](<apps/server-pilot/src/ai/extraction/extract.ts:62>) [schema.ts:254](<apps/server-pilot/src/ai/extraction/schema.ts:254>) |
| Work item | Groups by stay/date; each stay’s confirmation resolves to the first guest’s, and room names are sliced by row/room count. Top-level selection also takes the first confirmation. [work-items.ts:294](<apps/server-pilot/src/ai/work-items.ts:294>) [work-items.ts:388](<apps/server-pilot/src/ai/work-items.ts:388>) [work-items.ts:409](<apps/server-pilot/src/ai/work-items.ts:409>) |
| Pane | Action badge reads Luna task/global workflow, not extracted `stay.action`; action enum lacks `existing`. Find button appears for amend/cancel only. [session.ts:150](<apps/mail/lib/quote-workflow/session.ts:150>) [session.ts:235](<apps/mail/lib/quote-workflow/session.ts:235>) [quote-workflow-panel.tsx:181](<apps/mail/components/quote-workflow/quote-workflow-panel.tsx:181>) |
| Split | UI says one date range = one HMS booking; “Copy stay” clones the whole stay. No per-guest split control. [requirement-card.tsx:145](<apps/mail/components/quote-workflow/requirement-card.tsx:145>) [requirement-card.tsx:152](<apps/mail/components/quote-workflow/requirement-card.tsx:152>) |
| Quote PDF | One combined document is already built through all stay runs. HTML-only PDF mode refuses multi-stay; deployed renderer config unknown. [quote-workbook-download.ts:68](<apps/mail/lib/quote-workflow/quote-workbook-download.ts:68>) [workstation.ts:1401](<apps/server-pilot/src/trpc/routes/workstation.ts:1401>) [proposal-pdf.ts:190](<apps/server-pilot/src/quote-proposal/proposal-pdf.ts:190>) |
| Create | Pane makes a draft per date key, but renders/saves each room separately. `PaneStay`/create-tool request carries one room, not a grouped stay. [quote-workflow-panel.tsx:2198](<apps/mail/components/quote-workflow/quote-workflow-panel.tsx:2198>) [booking-card.tsx:911](<apps/mail/components/quote-workflow/booking-card.tsx:911>) [pane-stay-save.ts:46](<apps/server-pilot/src/ai/pane-stay-save.ts:46>) |
| Prefetch | Availability: one job per complete stay, but gated off. Confirmation prefetch uses the first confirmation. [hms-availability.ts:90](<apps/server-pilot/src/ai/hms-availability.ts:90>) [hms-jobs.ts:1843](<apps/server-pilot/src/ai/hms-jobs.ts:1843>) [work-items.ts:284](<apps/server-pilot/src/ai/work-items.ts:284>) |
| Corpus | R2: 9/164 core multi-case threads, 33 guest/date cases, 34 unique confirmation IDs; separate HRCEN outbound letters. Quote-PDF evidence is unresolved: filename screen 0/10 multi-arrival threads, not content proof. [R2:44](<docs/research/2026-10-20-arch-lanes/r2-multi-ask-truth.md:44>) [R2:52](<docs/research/2026-10-20-arch-lanes/r2-multi-ask-truth.md:52>) |

## 2. Gap to “fully built”

1. Preserve immutable stay identity across re-extraction; ambiguous matches must not inherit edits.
2. Project each stay’s action into its own card: quote/book/amend/cancel/existing; no global-action fallback for mixed stays.
3. Keep every guest↔confirmation pair; Find/CHECK must target that stay’s exact confirmation or stop on ambiguity.
4. Add explicit guest↔room assignment; never infer it from guest-list order.
5. Add staff-only “split per guest” separate from “Copy stay”; enable only for an unambiguous one-guest/one-room mapping.
6. Create one HMS booking per date-set stay, with all rooms and assigned guest names. Current one-room writer cannot prove this behavior.

No new PDF or availability-prefetch behavior proposed. Keep one combined PDF as product default; corpus does not prove staff’s historical PDF pattern.

## 3. Per-change estimate

LOC are static estimates from the current target code. All listed tests are existing files to extend.

| # | Product files | Product / test LOC | Test files | P1-likely risk |
|---|---|---:|---|---|
| 1 | `extraction/schema.ts`, `ai/work-items.ts` | +40–80 / +60–100 | `extraction-schema.test.ts`, `work-items.test.ts` | Reordered extraction attaches saved edits to wrong stay. |
| 2 | `ai/work-items.ts`, `quote-workflow/session.ts`, `quote-workflow-panel.tsx` | +40–80 / +60–110 | `work-items.test.ts`, `quote-workflow-session.test.ts`, `quote-workflow-panel.test.tsx` | Mixed stay gets wrong action/path. |
| 3 | `ai/work-items.ts`, `quote-workflow/session.ts`, `quote-workflow-panel.tsx`, `amend-lookup-panel.tsx` | +50–100 / +70–130 | `work-items.test.ts`, `quote-workflow-session.test.ts`, `amend-find-panel.test.tsx` | Wrong booking opened; ambiguous ID must route to CHECK. |
| 4 | `ai/work-items.ts`, `quote-workflow/session.ts`, `booking-card.tsx` | +80–150 / +100–170 | `work-items.test.ts`, `booking-draft-multistay.test.ts`, `booking-card.test.tsx` | Wrong guest assigned to room. |
| 5 | `quote-workflow/session.ts`, `requirement-card.tsx`, `quote-workflow-panel.tsx`, `ai/booking-draft.ts` | +70–130 / +90–150 | `quote-workflow-session.test.ts`, `requirement-card.test.tsx`, `booking-draft-multistay.test.ts` | Split duplicates stay or loses guest/conf#; manual only. |
| 6 | `ai/booking-draft.ts`, `booking-card.tsx`, `ai/pane-stay-save.ts`, `tooling/playwright-quote/{create-request.mjs,create-tool.schema.json,create-lab-stay.mjs}` | Writer LOC **unknown**; pane slice +80–150 / tests unknown +100–160 | `booking-draft-multistay.test.ts`, `booking-card.test.tsx`, `pane-stay-save.test.ts` | Duplicate/partial booking; multi-room HMS capability unproven. |

## 4. Proposed PR split

| PR | Scope / dependency |
|---|---|
| 1 | Change 1: stable identity/edit reconciliation; standalone; <500 product LOC. |
| 2 | Change 2: per-stay action projection; after PR1; <500. |
| 3 | Change 3: exact confirmation + Find/CHECK target; after PR1; <500. |
| 4 | Change 4: explicit guest-room assignment; after PR1; <500. |
| 5 | Change 5: explicit per-guest split; after PR4; <500. |
| 6a | Change 6 writer contract/tool: **hold** until a deterministic multi-room create path is scoped; then cap/split at 500. |
| 6b | Change 6 pane submits one grouped stay preview/commit; after 6a; estimated <500. |

Collision map: `work-items.ts`/`session.ts` span create, cancel, amend, DV quote, multi-stay, overlay, CHECK. `quote-workflow-panel.tsx` overlaps quote/create/overlay; `amend-lookup-panel.tsx` amend/cancel/CHECK; `booking-draft.ts`/`booking-card.tsx` create/quote/multi-stay; `pane-stay-save.ts` shares the single HMS browser lock. Queue edits to shared files. Assume #451, #458, #460–462 land; do not re-plan them.

## 5. Test plan

| Check | Scenario / proof |
|---|---|
| Unit | `extraction-schema.test.ts` + `work-items.test.ts`: two date sets, same-date guests, per-stay actions/confs, re-extraction reorder, edits stay bound, no positional guest-room assignment. |
| Unit | `quote-workflow-session.test.ts` + `quote-workflow-panel.test.tsx` + `amend-find-panel.test.tsx`: mixed actions, existing vs CHECK, exact per-stay Find; `requirement-card.test.tsx`: split preserves names/confs and blocks count mismatch. |
| Unit | `booking-draft-multistay.test.ts` + `booking-card.test.tsx` + `pane-stay-save.test.ts`: one grouped create per date set, distinct dates stay separate, per-room names, no duplicate/partial save; Labtest guard and one lock. |
| Unit | `quote-workflow-multi-stay.test.ts` + `quote-proposal-multistay.test.ts` + `quote-proposal-pdf.test.ts`: all stay runs in one output; test combined HTML refusal. `hms-availability-probe.test.ts` + `hms-jobs.test.ts`: one prefetch per complete stay, incomplete skipped, cap/dedupe honored. |
| Replay | After #451 lands: run production-parity inputs via `readQuoteAttachments` → `selectionToAgentPrompt` on the saved 2026-10-13 HRCEN corpus. Count `n=9` core multi-case threads / `33` guest-date cases (`34` IDs); also report broad `n=48` / `147`. Count by source thread and guest+full-date+conf# truth, not generated cards. Room-allocation truth is absent; do not score it. |
| Quote corpus | Inspect actual attachment contents, not filenames. Current evidence has no combined-PDF proof (0/10 multi-arrival); retain combined PDF unless content evidence changes the decision. |
| Live/write | No live n available here: prod `b11e5ac52` and HMS were not touched. Later reads: `message` + latest `mail_extraction` rows, count distinct eligible `message.id` and linked stay/guest/conf cases. Writes: Labtest only (2027+), one browser lock; no real guest, no mail send. |
| Boundary | No files edited; no tests/tsc/Vitest run. 95 threshold met for static code scope, not live behavior; route local-only. |

## 6. Open questions

1. Same-date guests historically had separate confirmation IDs. Still one HMS booking per date set? Default: honor owner heuristic, preserve each guest’s conf# separately.
2. Can the deterministic HMS New Record path create multiple rooms in one reservation? Default: block integrated multi-room write until Labtest proves it; otherwise staff completes it in HMS.
3. One combined multi-stay quote PDF or one per stay? Default: keep current one combined PDF; staff-corpus evidence is inconclusive.
4. If mail names guests but not rooms, who maps them? Default: staff explicitly assigns before preview; never infer from order.