---
title: "eval: Past-week Centurion email triage evaluation (Aug 31 - Sep 7) and classification metrics"
date: 2026-09-07
type: eval
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
origin: "User request 2026-09-07: Analyze current classification numbers vs expectations on RDS, explain bookings volume (1,049) and urgent count (24), extract the 7-day past-week inbound corpus (2026-08-31 to 2026-09-07, 836 threads), perform thread-by-thread ground truth evaluation across all threads (subject, recipients, body), evaluate AI triage vs expert ground truth, compute precision/recall/F1/confusion matrix, and output comprehensive evaluation report."
---

# eval: Past-week Centurion email triage evaluation (Aug 31 - Sep 7) and classification metrics

## Goal Capsule

Perform an exhaustive, empirical ground-truth evaluation of the AI email triage system on the Centurion Hotel production mailbox (`transport-centurion`) on RDS. Analyze the overall classification distribution across the entire database (4,125 threads) and specifically evaluate the 836 inbound threads received during the 7-day window from **Monday, August 31, 2026 to Monday, September 7, 2026**. Inspect subject, recipients, and complete message bodies for every thread, compare AI triage classifications against expert ground truth, compute standard evaluation metrics (Precision, Recall, F1-score, and Confusion Matrix), and provide root-cause analyses explaining why `bookings` is 1,049 and `urgent` is 24.

## Product Contract

### Requirements

- **REQ-1 (Corpus Extraction).** Extract 100% of the inbound threads received between `2026-08-31T00:00:00Z` and `2026-09-07T23:59:59.999Z` on RDS (`nava-zero-mail-pilot`, `transport-centurion`). Capture complete metadata: thread ID, latest message ID, sender, to/cc recipients, subject, clean body text/HTML, timestamps, live category slugs, spam status, and the latest AI workflow triage output (`primaryFolder`, `urgent`, `priority`, `rationale`, `policyFlags`).
- **REQ-2 (Live Number Critical Analysis).** Critically analyze the live distribution on RDS:
  - Why `bookings` is 1,049 total (855 unread) all-time, and 219 threads in the past week.
  - Why `urgent` has only 24 total (18 unread) all-time, and 7 threads in the past week out of 836 threads.
  - Provide evidence-backed findings on whether these match hotel operational expectations.
- **REQ-3 (Thread-by-Thread Ground Truth Evaluation).** Systematically evaluate every thread in the 836-thread past-week corpus by inspecting:
  - Sender address and domain (OTA channel vs travel agency vs corporate client vs guest vs internal staff).
  - To / CC recipients (direct reservations vs staff forwarding chains).
  - Subject line and thread context.
  - Full email body content (booking details, check-in dates, quotes requested, payment slips, travel vouchers, cancellation requests, recruitment CVs, marketing blasts, channel manager integration alerts).
  - Assign expert ground truth: `groundTruthCategory`, `groundTruthUrgent` (true/false), and `groundTruthSpam` (true/false).
- **REQ-4 (Quantitative Evaluation Metrics).** Compute and report:
  - Overall accuracy.
  - Per-category Precision, Recall, and F1-score for all 12 operational categories + spam.
  - Multi-class Confusion Matrix comparing AI triage vs Ground Truth.
  - Binary Urgency metrics: Precision, Recall, F1, True Positives (TP), False Positives (FP), False Negatives (FN).
  - Binary Spam metrics: Precision, Recall, F1, TP, FP, FN.
- **REQ-5 (Discrepancy Taxonomy & Synthesis).** Document specific error patterns:
  - OTA notifications swallowed by bookings vs automated-channel.
  - Financial records (POPs, vouchers, invoices) misrouted to bookings vs money-billing / documents-delivery.
  - Staff forwards (Penny Mbobo, Bongi, reception) unwrapping quality.
  - Near-term arrival / time-boxed reply urgency misses.
  - Recruitment / job application handling.
- **REQ-6 (Durable Markdown Artifact).** Store complete findings in `<appDataDir>/brain/<conversation-id>/past-week-triage-evaluation.md` so the evaluation is permanently accessible and inspectable.

### Scope Boundaries

- **In Scope:**
  - Complete data export of the 836 threads from RDS via EC2 SSM.
  - Full ground-truth evaluation across all 836 threads with zero sampling shortcuts.
  - Exact metric computation (Precision, Recall, F1, Confusion Matrix).
  - Analysis of `bookings` and `urgent` volume.
  - Architectural and heuristic recommendations for future triage iterations.
- **Out of Scope:**
  - Running Vitest against the live pilot RDS database (violates repo guardrails).
  - Modifying live customer email rows on RDS during this evaluation task (evaluation is strictly non-destructive and read-only).
  - Writing automated drafts to external guests.

## Planning Contract

### Key Technical Decisions

- **KTD-1: Data Export Strategy via EC2 SSM.** Execute `apps/server-pilot/scripts/export-past-week-corpus.mjs` on EC2 (`i-008f737974a9ba9b3`), querying PostgreSQL with `ssl: 'require'`. Export the structured dataset to `/home/ubuntu/triage-eval/past-week-corpus-2026-08-31-to-09-07.json` and sync locally to `scratch/past-week-corpus-aug31-sep07.json`.
- **KTD-2: Batch Processing Architecture for 836 Threads.** Process the 836 threads in structured batches (e.g. 50-100 threads per batch) using an evaluation script that applies our expert classification rubric to body text, sender signatures, and urgency markers, paired with LLM deep-inspection of edge cases.
- **KTD-3: Ground Truth Categorization Taxonomy.** Follow the canonical hotel operational definitions:
  - `bookings`: Genuine guest/corporate booking inquiries, accommodation requests, quote requests, availability checks (under 10 pax).
  - `groups-events`: Conferencing, group blocks (10+ pax or multi-room group RFQs), banqueting, event venue inquiries.
  - `automated-channel`: Routine system notifications from SynXis, Profitroom, Travelit, Booking.com, Expedia with no human quote/book obligation.
  - `manage-stay`: Amendments, date changes, guest requests during stay, dietary requests, early check-in / late check-out.
  - `money-billing`: Invoices, folios, payment receipts, proof of payment (POP), bank notifications, credit card transaction slips.
  - `documents-delivery`: Third-party travel agency accommodation vouchers (Nexus, Rennies BCD, Tourvest), delivery notes, rate sheets.
  - `exceptions-recovery`: Booking cancellations, no-show disputes, chargebacks, customer service complaints, service failures, rate parity issues.
  - `internal-partner`: Internal hotel ops discussions, housekeeping handovers, GM notices, staff rotas (excluding external guest RFQs forwarded by staff).
  - `guest-experience`: Post-stay survey responses, guest reviews (TripAdvisor, Google, GuestRevu).
  - `unknown-review`: Non-operational external inquiries, job applications/CVs (until dedicated careers queue exists).
  - `spam`: Unsolicited commercial promotions, vendor cold pitches, newsletters, FortiMail quarantine digests.
  - `urgent`: Cross-cutting overlay applied when: check-in is today or tomorrow (<=48h), explicit time-boxed reply SLA ("within 12 hours", "reply now"), immediate cancellation fee waiver dispute, or duplicate billing crisis.

## Implementation Units

### U1: Corpus Extraction from RDS
- **Goal:** Extract all 836 inbound threads received between 2026-08-31 and 2026-09-07 from RDS into a structured local JSON file.
- **Files Involved:** `apps/server-pilot/scripts/export-past-week-corpus.mjs`.
- **Execution:** Run script on EC2, verify 836 records with complete subject, sender, recipients, body text, and current category joins.
- **Verification:** Confirm non-empty fields, valid JSON formatting, count = 836.

### U2: Ground Truth Annotation & Evaluation Loop
- **Goal:** Manually evaluate every thread in the corpus against ground truth criteria and assign canonical ground truth classification and urgency.
- **Files Involved:** `apps/server-pilot/scripts/evaluate-past-week-corpus.mjs`, `scratch/past-week-eval-results.json`.
- **Execution:** Evaluate each thread's subject, sender, recipients, and message body against the ground truth taxonomy. Compare AI classification vs Ground Truth.
- **Verification:** Every single thread has an assigned ground truth category, urgency boolean, and discrepancy classification.

### U3: Metric Computation & Final Comprehensive Report
- **Goal:** Calculate macro and micro precision, recall, F1, confusion matrix, analyze `bookings` (1,049) and `urgent` (24), and generate the complete report.
- **Files Involved:** `<appDataDir>/brain/<conversation-id>/past-week-triage-evaluation.md`.
- **Execution:** Compile all data into high-quality tables, charts, and root-cause analyses.
- **Verification:** Report contains full confusion matrix, per-category metrics, and detailed explanations of discrepancies.
