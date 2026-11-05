# Centurion opportunity run — 2 November 2026

## Frame and results

| SAST window, end exclusive | Raw → deduplicated inbound | Raw → deduplicated outbound | Actionable reservation inbound | Potential Nava help | Actionable group emails |
|---|---:|---:|---:|---:|---:|
| 26 Sep 00:00–30 Oct 17:00 | 4,719 → 4,516 | 2,099 → 2,067 | 1,361 | 1,007 (74.0%) | 82 |
| 27 Jul 00:00–26 Sep 00:00 | 6,637 → 6,635 | 2,809 → 2,497 | 2,109 | 1,420 (67.3%) | 178 |

The earlier window is the available archive, not proof that no older mail exists. Each row is a deduplicated **email**, not a guest, thread, reservation or staff hour. Actionable work can include internal instructions; it is not limited to customer-sent emails or emails with a found reply. OTA/channel work is excluded. Group means one shared request for **more than 10 rooms**; group-only work is excluded from help but retained in the denominator and group count. A separate individual task may count. Human approval and partial assistance count. Potential assumes the planned Nava workflows work; it is not actual usage.

Helpable workflow tags overlap:

| Workflow | 26 Sep–30 Oct | Earlier |
|---|---:|---:|
| Supplied voucher filing | 371 | 424 |
| Reservation invoice | 230 | 324 |
| Booking/create | 188 | 281 |
| Quote | 139 | 271 |
| Amendment | 96 | 134 |
| Supplied proof of payment | 88 | 115 |
| Cancellation | 41 | 71 |

Requesting or collecting payment is distinct from filing supplied proof; no payment-taking capability is assumed. `payment_request` occurs in 112 main and 185 earlier actionable emails; 42 and 63 respectively also contain a supported opportunity. `other` and `payment_request` do not independently establish helpability. Automated PMS confirmations that satisfy an invoice request are counted as potential invoice help, subject to the matching limits below. Of 250 main invoice emails, 15 linked to a staff-sent invoice, 49 to a PMS confirmation candidate, and 186 had no linked invoice reply; the corresponding earlier counts were 63, 14 and 286 of 363.

## Outbound and reply estimates

| Window | Staff-written outbound | PMS confirmation template candidates | Actionable inbound with ≥1 linked reply | Distinct external staff replies linked to reservation inbound | Of those, linked to a potentially helpable inbound |
|---|---:|---:|---:|---:|---:|
| 26 Sep–30 Oct | 1,074 | 886 | 753 | 648 | 511 (78.9%) |
| Earlier | 1,663 | 613 | 630 | 447 | 314 (70.2%) |

Reply links are model-reviewed candidates: one outbound can link to multiple inbound emails, and an inbound can have multiple replies. A linked reply is not proof that Nava could send that particular reply. The recipient column means an external To/Cc was observed; missing recipient fields and Bcc prevent complete audience classification. PMS templates are candidates, not proof of unattended sending. The earlier run did not receive the main window's reverse reply search or reply-edge audit, so its reply figures are less complete and are not directly comparable.

Main-period actionable sender domains: `legacyhotels.co.za` 138, `gmail.com` 124, `nexustravel.co.za` 110, `travelit.co.za` 102, `atlantiscorporate.co.za` 59. All-inbound domains include `legacyhotels.co.za` 1,135, `synxis.com` 478, `gmail.com` 207, `grfeedback-b.com` 202 and `booking.com` 172. Domain counts can include internal instructions and automated mail; do not infer opportunity from domain alone.

## How the run was made

- Read-only Centurion snapshots: `centurion-nine-day-bfcd9949-591f-4c9a-b061-3679ec793b51` and `centurion-nine-day-8774dd09-e874-46f8-bed7-a24e4c282711`. The owner confirmed the start date and the configured Azure route. The main bulk finished within two hours, enabling the requested earlier-archive extension.
- [Method](METHOD.md): property/time frame → deduplicate and preserve source mapping → clean HTML, quotes and credentials → inventory MIME and extract bounded relevant document text → find candidate replies → classify each message with Luna → review groups, attachments and reply links → create action rows and metrics. The sources, prompts, model, hashes, corrections and failed cases are retained privately.
- Main run: Luna medium initial v17/v18/v22 layers, v23 envelope, v24 semantic and reply review, available document evidence, source-bound v30 corrections. Earlier: Luna medium v24 plus v26 available-document review and source-bound v4 corrections. [Action prompts v6/v7](2026-11-02-luna-action-details-prompt-v7.md) guide reasonable scope/document inference. Calls used `store:false` and explicit selections; provider-blocked/sensitive cases were preserved and not resubmitted.
- The group-context selector retrieves subject-related, group-tagged messages, but never labels from subject alone. Luna max reviewed 15/17 selected main cases and 49/49 earlier cases; two main review calls timed out. Source-bound evidence supported corrections including 10 main and 21 earlier helpable-to-group-only flips. After correction the selector found 7 main and 27 earlier possible group-context conflicts, with no newly selected cases. This is convergence only for that subject-prefix heuristic. Its search stayed within each window; future runs should search the property's full available history before slicing dates.

## Quality and limits

- A fresh blind review compared the frozen main v28 classifications with Luna max: help decisions agreed on **138/150 random cases**, and exact workflow sets on **123/150**. Among the **40** random cases either run called helpable, both agreed on **30**. Targeted help decisions agreed on **91/99**; one of 100 timed out. The final v30 corrections came later. Another fresh sample against v25 agreed on 141/150 random and 94/100 targeted help decisions. These are model agreements, not human-labelled accuracy, and share a model family.
- Action-detail calls succeeded for all 1,361 and 2,109 actionable cases. Nevertheless, 21 main and 50 earlier helpable cases have no proposed step. Group classification/action-detail disagreements and 7/27 subject-related group candidates are flagged in the datasets. Classification and action passes can see linked later replies, which may influence interpretation; 111 main and 143 earlier action states may reflect later completion. These rows and estimates are retrospective, **not** a leak-free live-triage evaluation; hypothetical steps refer to the time the inbound arrived, not instructions to act now.
- Main MIME: 4,514/4,516 originals inventoried; 1,411 had attachments. Of 452 cases selected for document inspection, 354 yielded useful bounded text; legacy XLS scans were separately bounded. Earlier MIME: only 214/6,635 originals were retrievable; of 67 selected cases, 44 yielded useful text. Missing/unreadable is not the same as no attachment. Older voucher, payment-proof and group-size findings are less certain. The [B2B guide](../b2b-dashboard/README.md) records the later audit of voucher-specific extraction coverage.
- Main: one inbound provider content-filter rejection remains unclassified. Earlier: one credential-sensitive email was locally withheld and one call had a generic HTTP failure; both remain unclassified. No independent human-labelled set establishes pilot accuracy or 100% success. Reply review found both missed and incorrectly matched edges; see the [case index](2026-11-02-case-evidence-index.md).

## Artifacts and replay

- Final per-email candidate datasets: [main](../../../../.private/centurion-opportunity-october-20261101/bulk-v22-effective/dataset-final-v32.jsonl), [earlier](../../../../.private/centurion-opportunity-october-20261101/pre-sep26-v24/dataset-final-v5.jsonl). Each row keeps the source, LLM classification, hypothetical action, observed replies, provenance and review flags.
- Metrics/audience: `.private/centurion-opportunity-october-20261101/bulk-v22-effective/{metrics-final-v30,outbound-audience-final-v30}.json` and `.private/centurion-opportunity-october-20261101/pre-sep26-v24/{metrics-final-v4,outbound-audience-final-v4}.json`. Corrections and group supporting packet hashes are `audit-corrections-v30.json` and `audit-corrections-v4.json` in the corresponding folders.
- [Early-run record](2026-11-02-centurion-early-run.md) preserves earlier pilots and superseded estimates. For DaVinci, build a new property-specific frame, source mappings and credentials; do not reuse Centurion's counts or assume its schema.

Replay without model calls, from the repository root; outputs go to a new private directory:

```bash
CORPUS_DOC=docs/research/halloween/corpus-analysis
CORPUS_ROOT=.private/centurion-opportunity-october-20261101
CORPUS_REPLAY_DIR="$(mktemp -d .private/corpus-replay-XXXXXX)"
bash "$CORPUS_DOC/centurion-20261102-final-replay.sh" --audit-corrections "$CORPUS_ROOT/bulk-v22-effective/audit-corrections-v30.json" --output "$CORPUS_REPLAY_DIR/main-metrics.json" --export-labeled "$CORPUS_REPLAY_DIR/main-labeled.jsonl" --export-action-input "$CORPUS_REPLAY_DIR/main-action-input.jsonl"
bash "$CORPUS_DOC/centurion-20261102-historical-replay.sh" --audit-corrections "$CORPUS_ROOT/pre-sep26-v24/audit-corrections-v4.json" --output "$CORPUS_REPLAY_DIR/earlier-metrics.json" --export-labeled "$CORPUS_REPLAY_DIR/earlier-labeled.jsonl" --export-action-input "$CORPUS_REPLAY_DIR/earlier-action-input.jsonl"
bash "$CORPUS_DOC/centurion-20261102-datasets.sh" main "$CORPUS_REPLAY_DIR/main-dataset.jsonl"
bash "$CORPUS_DOC/centurion-20261102-datasets.sh" earlier "$CORPUS_REPLAY_DIR/earlier-dataset.jsonl"
```

The main aggregate wrapper defaults to historical v29 corrections; the explicit v30 argument above is required for the final results. These scripts consume the saved layers; [the method](METHOD.md) explains how to build new layers for a different mailbox.
