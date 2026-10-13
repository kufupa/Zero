# R4 — Current AI architecture map + gaps

**Answer**

**Inbound is a split, gated pipeline—not one live reservationist.**  
**Direct mail can be triaged and extracted, then separately re-analysed by the selected-message pane.**  
**HMS jobs are deterministic; staff edits feed optional offline evaluation, not automatic learning.**  
**Da Vinci is blocked by HRCEN/origin enforcement plus Centurion rules, rates, aliases and UI fallbacks.**

## Method

Read-only local `qm-l5` source/history/docs + the `75`-day snapshot (`2026-10-13`) [M]; feature branch, upstream `main` unchecked. No production env, DB, HMS or network; no source-code edits. Filter: inbound; exclude `@legacyhotels.co.za` and sender domains containing synxis, expedia, webbeds, hotelbeds, booking.com, get-e, hotels.com, agoda, trip.com, traveloka, airbnb, reviewpro, trustyou, tripadvisor, revinate or medallia. Current label = latest succeeded extraction by `created_at`. Re-run: `python3 /home/orca/nava-research/scripts/r4/corpus_summary.py`; excerpts whitelist generic words, mask others. Server paths abbreviate `apps/server-pilot/src/`; other roots are explicit.

## Findings

### Pipeline and UI

```text
mail -> ingest/store.ts -> live-admission.ts -> mail-source.ts
  ├─ known OTA/system -> deterministic source folder; no triage LLM or extraction
  └─ direct -> inbound_triage (unless retired) -> Mastra mailTriage -> refine/write
       ├─ INBOUND_EXTRACTION=on -> Azure extraction -> mail_extraction/work_item
       │    └─ gated HMS prefetch: party / find / search_guest / availability
       └─ private shadow prediction (approved-local route)
selected message -> pane analyseSelection -> separate quote LLM -> prefill
                                      └─ optional staff_quote HMS job -> staff review/approval
```

`store.ts:663-688,771-830`, `live-admission.ts:283-322,506-546`, `ai/mail-source.ts:258-322`. Sender/trusted-forward evidence determines source; ordinary body mentions do not. Automated mail gets deterministic `mailSourceTriageOutput` (`worker.ts:4466-4509`). Live admission can queue triage and extraction together; legacy ingest queues extraction only when triage is retired (`store.ts:791-830`). Deployment flags were not read.

Triage selects one of 11 folders [M] (`workflows/mail-triage.ts:77-149`, `categories.ts:9-30`): bookings, groups-events, manage-stay, confirm-reconcile, money-billing, documents-delivery, internal-ops, channel-ops, guest-experience, exceptions-recovery, unknown-review; Urgent is an overlay. Webmail renders category pills/filters (`apps/mail/components/mail/centurion-category-pill.tsx:15-70`). Pane shows Needs You / Queued / In HMS / Review and loads saved extraction (`work-items.ts:1252-1278`, `apps/mail/components/nava-pane/screens/needs-you.tsx:9-42,56-141`).

HMS prefetch deterministically selects party, find (confirmation first), or search_guest (explicit surname + unique arrival); `staff_quote` executes a stored request—no LLM pick loop (`hms-jobs.ts:121-151,310-355,1926-1966`). Queue flags gate execution (`hms-jobs.ts:80-91,1330-1379`).

### LLM call register

| Purpose | Route / effort | Input → output | Status |
|---|---|---|---|
| Triage | Bedrock Nova Lite default; optional Bedrock Luna/max (`env.ts:25-35,163,415`; `bedrock/factory.ts:20-50`) | causal thread → `triageResponseSchema` (folder, priority, spam, tool tags, action) | Live Mastra; refinements follow. Tool tags are not calls. |
| Baseline semantics | configured `approved-local`; effort unset | one message → ask/answer + work state (`mail-baseline-extraction.ts:496-525`) | Optional after triage; deterministic fallback. |
| Inbound extraction + translation | Azure Foundry `gpt-6-luna`, medium | mail/thread/attachment text → `mailExtractionSchema`; known non-English adds clean/literal `translationSchema` call (`extract.ts:18-22,151-225`; `translate.ts:13-35,91-126`; `quote-workflow-analyse-selection.ts:234-254`) | Extraction gated by `INBOUND_EXTRACTION=on` (`inbound-run.ts:228-270`). |
| Pane analysis | Azure Foundry `gpt-6-luna`, medium; regex fallback | selected mail/thread, note, text/PDFs → `lunaAnalysisSchema` (intent + prefill fields) | Separate on selection, not approval (`apps/mail/components/nava-pane/nava-pane.tsx:535-608`; `quote-workflow-llm.ts:423-490`). |
| Shadow / draft | configured `approved-local`; effort unset | frozen mail → private outcome; prepared facts → reply; HMS shadow may plan tasks | Auxiliary/gated (`worker.ts:3989-4053,4735-4850`; `candidate-draft-agent.ts:638-657`). |
| Voucher vision | Azure `gpt-6-luna`, medium | scanned voucher pages → guest/stay/confirmation fields | Optional `SCANNED_PDF_VISION=on`; not general OCR (`voucher-find.ts:350-455`). |
| Reservationist Agent | factory Bedrock Luna/max; backtest injects Azure Luna/medium, maxSteps=10 [M] | thread + read tools → `reservationistDecisionSchema` | Backtest-only (`reservationist-agent.ts:150-167`; `apps/server-pilot/scripts/run-reservationist-backtest.ts:191-217`); replay planner is evaluation-only (`reservationist-replay.ts:81`). |

Inventory scope: production inbound/pane and auxiliary live-capable paths; `eval-runner` and reservationist replay calls are offline evaluation.

Mastra registers `mailTriageWorkflow` and `candidateDraftWorkflow` (`ai/mastra.ts:6-22`); worker fetches only `mailTriage` (`worker.ts:4552`). Candidate draft is registered but not fetched; `candidate-draft-agent.ts` uses Mastra tools in an HMS shadow lane. `reservationist-agent.ts` exports a Mastra `Agent`, used only by backtest; `label-scorers.ts` is eval-only. There are `4` named semantic schemes [I], `3` live-capable [I], `1` backtest-only [I]; source routing and ask/answer baseline add classifiers.

### Measured snapshot and disagreement

| Scope / current extraction kind | Count [M] | Share [M] |
|---|---:|---:|
| Inbound: total / staff / channel excluded / direct scope / latest labels | 8,892 / 2,621 / 1,143 / 5,128 / 1,242 | 100% / — / — / — / 24.2% |
| `other` | 456 | 36.7% |
| `voucher_pop` | 243 | 19.6% |
| `spam` | 233 | 18.8% |
| `booking` | 159 | 12.8% |
| `quote` | 67 | 5.4% |
| `amendment` | 63 | 5.1% |
| `cancellation` | 21 | 1.7% |

Snapshot totals [M]: 12,433 messages; 46,443 attachment rows; 3,697 extraction rows; 178 HMS reads; 23 staff_quote runs; 2,162 PDF text files. Shares describe only 1,242 labelled messages [M], not the full corpus. Confidence: high for counts; medium for label distribution given 24.2% coverage [M].

Disagreements are schema-level [I], not measured: source routing skips known OTA/system mail, but extraction classifies by reservation action; triage separates groups/exceptions, extraction uses `quote`/`other`/`voucher_pop`; quote schema lacks `spam`/`voucher_pop` and maps spam/skip to `other`; folder-to-pill mappings differ (`triage.ts:204-237`, `categories.ts:36-47`). Corpus lacks triage and quote outputs; no confusion rate. Confidence: low for frequency.

### Caps, feedback, multi-hotel gaps

`extract.ts:22,68-95` caps prompt at 60,000 chars [M] and drops scanned PDF bytes because card digits cannot be masked; scan-only PDFs are unread. `git log -S'MAX_PROMPT_CHARS'` finds U3 commits `f3e3e5239` / `ab8896ebf`, with no exact-cap rationale. A payload/latency bound is inference [I; low]. Only explicit context figure is a replay quota of 922,000 processed tokens [M] for Azure Luna (`reservationist-replay.ts:103-114`), not a live cap or verified model limit.

Quote analysis caps thread at 8,000 chars/message, 40,000 total, attachment text at 20,000/file and scanned PDFs at 3 [M] (`quote-workflow-llm.ts:12-15,147-214`). Commit `dc5fb328f` introduced the limits; plan documents bounds/masking, not why 20k/3, and accepts unmaskable PDF bytes (`docs/plans/2026-10-06-002-reservationist-mvp-retro-and-sprint-plan.md:497-505`). Loader selects ≤3 files / 5MB [M] and drops ordinary images; voucher vision is the exception (`quote-workflow-synced-selection.ts:59-114,133-147`). Extracted-message attachment statuses: 332/435 read (76.3%) [M], 85 not-read (19.5%) [M], 18 scan-only PDFs (4.1%) [M]; subset only.

HITL stores run hashes/usage and shown/final fields, edits, overrides, selections and pane actions (`hitl-recorder.ts:267-309`, `db/schema/hitl.ts:73-218`). Append-only `work_event` captures staff actions/notes; work items retain AI/human values and accept/reject (`work-events.ts:9-155`, `work-items.ts:1308-1365`). Opt-in export maps edits/rejections to corrections and accepts to confirmations, optionally writing `eval_label`; manual/offline, not online learning (`apps/server-pilot/scripts/export-work-events-dataset.ts:1-26,417-438`).

Da Vinci blockers: Centurion rules embedded in prompts (`reservationist-decision.ts:3-15`, `extract.ts:91`, `quote-workflow-llm.ts:210`); env rejects non-HRCEN (`env.ts:57,302-324`); HMS proofs pin HRCEN/origin (`browser-artifacts.ts:54`, `production-runtime.ts:249-258,349-358`, manifests); draft source fixes HRCEN (`reservationist-draft-source.ts:13,72-75`); quote API serves Centurion rates (`rate-catalogue.ts:1-47`, `routes/quote-workflow.ts:143-145`); aliases `centurion lake hotel` / `centurion hotel`, special senders and pane fallback are property-specific (`triage.ts:240-247,901-940`; `apps/mail/components/nava-pane/nava-pane.tsx:1725-1750`). Rename alone cannot clear runtime gate.

## Examples

Token-masked excerpts (unknown words/numbers replaced):

- `dc765429-79b6-4677-8ce9-d695252b0689` (`quote`): “hello i would please like to find out [redacted] [redacted] for the [redacted] to [redacted] [redacted] for [redacted].”
- `40aa919c-0db0-4740-882a-67377850c1e4` (`cancellation`): “please cancel the [redacted] group.”

## Implications for the product

Build one property-scoped contract for source/thread/attachments → action → bounded read-tool plan → pane prefill → staff approval; keep execution auditable. Da Vinci needs per-property HMS proofs, rules/rates/aliases, not just branding. Adjudicate edits into eval data before retiring classifiers.

## Open questions

- Which production flags/routes are enabled, and does Da Vinci share the HMS tenant/origin?
- Can labels be adjudicated to measure triage/extraction/pane agreement, including skipped channels?
- Should general image OCR and scan-only PDFs be in the unified intake contract?
