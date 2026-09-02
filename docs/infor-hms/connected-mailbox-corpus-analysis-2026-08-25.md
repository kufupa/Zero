# Connected-mailbox corpus analysis

Analysis date: 2026-08-25  
Corpus `asOf`: `2026-08-25T22:24:55.657Z`  
Status: product analysis only. No triage labels, folder visibility, HMS action, or customer-facing send was changed.

## 1. Snapshot

Scope is all active connected mailboxes, both connected transports, and full retained history through `asOf`. This is not a Centurion-only slice and is not a recent-window sample.

| Measure | Count | Share or note |
| --- | ---: | --- |
| Active mailboxes | 2 | Full active-mailbox scope |
| Messages | 3,268 | Corpus denominator |
| Inbound messages | 2,957 | 90.5% of messages |
| Outbound messages | 311 | 9.5% of messages |
| Threads | 2,403 | Thread denominator |
| Multi-message threads | 328 | 13.6% of threads |
| Threads with outbound | 301 | 12.5% of threads |
| Inbound-only threads | 2,102 | 87.5% of threads |

Transport mix is **3,246 messages vs 22 messages**. Counts only are shown because the smaller connected source is useful as a coverage check, not as a basis for tenant or operational conclusions.

### Inbound by UTC day

| UTC day | Inbound | UTC day | Inbound | UTC day | Inbound |
| --- | ---: | --- | ---: | --- | ---: |
| 2026-07-22 | 2 | 2026-08-03 | 125 | 2026-08-15 | 29 |
| 2026-07-23 | 11 | 2026-08-04 | 140 | 2026-08-16 | 39 |
| 2026-07-26 | 1 | 2026-08-05 | 127 | 2026-08-17 | 125 |
| 2026-07-27 | 50 | 2026-08-06 | 91 | 2026-08-18 | 139 |
| 2026-07-28 | 93 | 2026-08-07 | 118 | 2026-08-19 | 135 |
| 2026-07-29 | 91 | 2026-08-08 | 31 | 2026-08-20 | 147 |
| 2026-07-30 | 100 | 2026-08-09 | 41 | 2026-08-21 | 166 |
| 2026-07-31 | 129 | 2026-08-10 | 47 | 2026-08-22 | 35 |
| 2026-08-01 | 27 | 2026-08-11 | 130 | 2026-08-23 | 56 |
| 2026-08-02 | 30 | 2026-08-12 | 138 | 2026-08-24 | 184 |
|  |  | 2026-08-13 | 126 | 2026-08-25 | 153 |
|  |  | 2026-08-14 | 101 |  |  |

### Honest baseline comparison

| Measure | Current full active corpus | 2026-08-04 Centurion-only baseline |
| --- | ---: | ---: |
| Messages | 3,268 | 812 |
| Threads | 2,403 | 668 |
| Outbound messages | 311 | 88 |

Current corpus has 2,456 more messages and 1,735 more threads than Aug-4 baseline, but this is not a time-series growth claim. Current scope includes both active transports and retained history through Aug-25; baseline covered one transport and an Aug-4 snapshot. Date coverage, mailbox scope, retention, and transport mix differ.

## 2. Method and limitations

1. **Deterministic census first.** The census counted every retained message, direction, thread, transport, UTC inbound day, first-match pattern class, regex intent hit, regex fact hit, attachment marker, and tool-coverage relationship.
2. **Full Luna thread review second.** Azure `gpt-5.6-luna` reviewed every one of the 2,403 complete threads, not only the 108 residual references. Results were processed in 18 private size-packed batches and coverage-checked against the manifest: 2,403 unique thread IDs, no missing or duplicate IDs.
3. **Reconciliation is aggregate-only.** The original regex census retained aggregate thread-intent counts, not per-thread labels. Therefore this report compares full-review distributions and separately reports how the former residual set was newly classified; it does not invent a per-thread regex-vs-Luna agreement rate.
4. **No old subject-writing analyser rerun.** This report does not reuse that analyser as a product or quality oracle.
5. Regex hits are recall-oriented demand signals. Intent and fact counts overlap; overlapping counts do not sum to total volume.
6. Pattern classes are first-match classes and therefore mutually exclusive within their own class table. Intent and fact hits are not mutually exclusive.
7. Attachment count is a marker proxy, not proof that MIME bytes or an attachment object remain available.
8. No MIME availability, attachment retrieval, sender identity, or gold-label precision proof is asserted.
9. No runtime triage output was generated for this report. Proposed attention buckets are a conservative shadow-planning projection, not measured production labels.
10. Raw corpus content remains private. This tracked document contains aggregates, generalized marker classes, rule IDs, tool IDs, and fact or intent IDs only.

### Residual judgment

| Residual outcome | Inbound trigger messages | Judgment |
| --- | ---: | --- |
| Generalized new-booking route | 4 | Body markers support booking, greeting, or contact-like work; remain human-visible |
| Generalized group route | 3 | Body markers support group or event work; remain human-visible |
| Generalized other route | 5 | Body markers support security or guest-service handling; remain human-visible |
| Unknown and abstain | 99 | No stable safe route after residual inspection |
| **Total residual triggers** | **111** | Source: deterministic census plus Luna residual judgment |

Residual review did not authorize file-ops, file-spam, or at-risk automation. Unknown is an abstention state, not evidence that messages are irrelevant.

### Full-thread Luna review

The full-thread pass is the primary semantic review for this report. It reviewed all 2,403 threads using the compact private projections, with the raw dump retained locally for flagged HTML/text divergence and spot checks. The result is a planning analysis, not a production classifier or an authorization to change folders.

| Full-review measure | Count | Boundary |
| --- | ---: | --- |
| Threads reviewed | 2,403 | Exact manifest coverage; one result per thread |
| Human-lock threads | 1,134 | Money, promises, cancellations, complaints, security, documents, ambiguity, or other staff-owned risk |
| Low-confidence threads | 68 | Abstain/manual review pressure; not spam |
| `ops` route | 1,097 | Proposed visible operational route |
| `resolved` route | 647 | Historical or routine-looking route; not permission to hide |
| `spam` route | 397 | Candidate only; still subject to lock and shadow precision gates |
| `at-risk` route | 110 | Visible risk route |
| `unknown` route | 152 | Abstention; no forced automation |

Full-review intent counts are mutually exclusive judge assignments, unlike the overlapping regex intent hits above: `booking_new` 574, `payment_finance` 278, `staff_internal` 331, `spam_noise` 374, `vendor_b2b` 165, `booking_modify` 123, `quote_request` 100, `booking_cancel` 64, `group_event` 73, `document_request` 44, `internal_test` 82, and `other` 195.

The full review recorded 1,409 tool-demand rows: 686 read, 244 modify, 180 create, 135 send, 36 cancel, 32 attach, and 27 no-op/none. Dispositions were 605 improve-existing, 375 unlisted gaps, 237 retain-existing, 102 extend-existing, 7 split-or-replace, and 14 defer/no-build. Every non-read operation remains human-gated in this analysis.

## 3. Taxonomy and coverage

### 3.1 Deterministic pattern classes

| Pattern class | Inbound messages | All messages | Share of inbound | Product reading | Source |
| --- | ---: | ---: | ---: | --- | --- |
| `human-rfq` | 1,057 | 1,068 | 35.7% | Human booking, quote, or reservation-shaped demand | deterministic |
| `other` | 786 | 811 | 26.6% | Uncovered or mixed operational language | deterministic |
| `confirmation-letter` | 471 | 732 | 15.9% | Confirmation or document-shaped traffic | deterministic |
| `mail-security` | 266 | 267 | 9.0% | Security gateway or threat-shaped traffic | deterministic |
| `system-sla` | 160 | 168 | 5.4% | Deadline, unpaid, escalation, or urgent risk | deterministic |
| `guest-feedback` | 106 | 106 | 3.6% | Review, complaint, or guest-feedback traffic | deterministic |
| `web-form` | 75 | 80 | 2.5% | Website or form-originated enquiry | deterministic |
| `system-failure-no-sla` | 31 | 31 | 1.0% | Integration or delivery failure without explicit SLA | deterministic |
| `system-routine` | 5 | 5 | 0.2% | Routine system notice candidate | deterministic |
| **Total** | **2,957** | **3,268** | **100.0%** |  | deterministic |

### 3.2 Intent demand

Counts below use all-message hits and thread hits from deterministic census. They are overlapping signals, not an additive workload distribution.

| Intent ID | Message hits | Thread hits | Template or staff implication | Source |
| --- | ---: | ---: | --- | --- |
| `confirmation_status` | 1,287 | 916 | Verify current reservation state and document trail | deterministic |
| `group_event` | 1,197 | 632 | Group block or event handling; retain staff ownership | deterministic |
| `new_booking` | 1,085 | 658 | Quote or reservation request; no autonomous commit | deterministic |
| `invoice_docs` | 922 | 541 | Verify invoice or tax-document state; document lock | deterministic |
| `confirmation_delivery` | 602 | 380 | Confirm delivery evidence; do not infer attachment availability | deterministic |
| `guest_service` | 516 | 300 | Guest-service or complaint handling; human review | deterministic |
| `cancellation` | 453 | 340 | Fee, policy, and status review; human approval | deterministic |
| `payment_ops` | 454 | 240 | Finance or proof-of-payment handling; human approval | deterministic |
| `channel_ota` | 199 | 186 | Resolve external reference and channel context | deterministic |
| `spam_noise` | 185 | 176 | Candidate pure-noise route only after lock checks | deterministic |
| `internal_ops` | 170 | 159 | Staff operational handling; no HMS tool required | deterministic |
| `quote_request` | 154 | 117 | Read-only rate and availability evidence | deterministic |
| `amendment` | 211 | 157 | Find first; later human-gated edit | deterministic |

Inbound trigger population is 2,957 messages. Each inbound message is one trigger even when it produces multiple intent or fact hits.

### 3.3 Required HMS facts

| Required HMS fact ID | Message hits | Thread hits | Staff action | HITL advisory | Source |
| --- | ---: | ---: | --- | --- | --- |
| `confirmation_number` | 1,574 | 1,094 | Exact reservation lookup; state unresolved when absent | yes before customer-facing use | deterministic |
| `document_delivery` | 1,558 | 1,015 | Verify document metadata and attachment evidence separately | yes | deterministic |
| `reservation_status` | 1,310 | 947 | Read authoritative status; do not mutate | yes | deterministic |
| `stay_dates` | 1,328 | 882 | Compare requested dates with authoritative dates | yes | deterministic |
| `payment_deposit` | 1,288 | 892 | Finance reconciliation; never handle credentials | yes | deterministic |
| `rate_quote` | 1,202 | 849 | Read nightly rates and restrictions; no guarantee | yes | deterministic |
| `group_block` | 1,200 | 631 | Read exact block status and counts; staff owns allocation | yes | deterministic |
| `room_type` | 989 | 642 | Compare requested and booked room class | yes | deterministic |
| `invoice_tax` | 982 | 581 | Verify final or sent-document class; do not infer finality | yes | deterministic |
| `availability` | 576 | 418 | Show read-only inventory and restrictions; no hold | yes | deterministic |
| `event_f_and_b` | 545 | 291 | Read event summary; staff owns commercial response | yes | deterministic |
| `loyalty_membership` | 502 | 289 | Manual profile or membership review | yes | deterministic |
| `company_bill` | 719 | 610 | Resolve linked billing account and terms | yes | deterministic |
| `external_ref` | 421 | 381 | Use exact external reference as alternate lookup key | yes | deterministic |
| `guest_name` | 375 | 304 | Use only for bounded disambiguation; do not disclose unnecessarily | yes | deterministic |
| `special_requests` | 164 | 85 | Manual preference review; no automatic promise | yes | deterministic |
| `transport_airport` | 181 | 78 | Manual transfer or airport response | yes | deterministic |
| `folio_balance` | 159 | 66 | Finance read and escalation; no ledger mutation | yes | deterministic |
| `sent_email_audit` | 75 | 27 | Check historical handling; never hide solely on prior send | yes | deterministic |
| `room_assignment` | 2 | 1 | Manual check; current reservation read does not prove assignment coverage | yes | deterministic |

### 3.4 Proposed category and template-family projection

This is a mutually exclusive inbound-message planning projection. Precedence is conservative: explicit risk locks, security or guest-service or document locks, pure spam markers, group or event markers, new-booking markers, then residual judgment. It is not a runtime triage result and carries no precision claim.

| Proposed attention class | Existing primary or overlay slug | Inbound messages | Share | Template family and staff action | Source split |
| --- | --- | ---: | ---: | --- | --- |
| `file-ops` | `ops` | 5 | 0.2% | Routine system notice; candidate file only after shadow proof | 5 deterministic |
| `file-spam` | `spam` | 78 | 2.6% | Pure marketing or irrelevant noise with no lock; candidate file only after shadow proof | 78 deterministic |
| `stay-human-at-risk` | `at-risk` | 841 | 28.4% | Failure, payment, cancellation, policy, SLA, or unpaid risk; staff-visible | 841 deterministic |
| `stay-human-new-bookings` | `new-bookings` | 419 | 14.2% | Individual stay, quote, form, or residual booking work; draft plus HITL | 415 deterministic + 4 Luna residual |
| `stay-human-groups` | `groups-events` | 446 | 15.1% | Group, event, block, or residual group work; staff-owned | 443 deterministic + 3 Luna residual |
| `stay-human-other` | `ops` only as existing visible route | 1,069 | 36.2% | Security, guest, document, and mixed operational work; no file permission | 1,064 deterministic + 5 Luna residual |
| `unknown` | no automated slug | 99 | 3.3% | Abstain, keep visible, ask staff to resolve | 99 Luna residual |
| **Total** |  | **2,957** | **100.0%** |  |  |

`urgent` is an overlay, not a primary category. Same-day or explicit time-bound evidence can add it to a human-visible primary. High volume does not turn a signal into an automated action.

## 4. SAFE-ATTENTION TRIAGE SPEC

### 4.1 Attention volume and slug boundary

The planning volume is repeated here because this section is load-bearing. `file-ops` and `file-spam` are analysis labels; they map only to existing `ops` and `spam` slugs. Human classes map only to existing `at-risk`, `new-bookings`, `groups-events`, or visible `ops`. `unknown` has no automated folder slug.

| Attention class | Existing slug | File permission in shadow spec | Volume |
| --- | --- | --- | ---: |
| `file-ops` | `ops` | candidate yes, only after audited precision and zero lock leakage | 5 inbound messages |
| `file-spam` | `spam` | candidate yes, only pure no-action noise after audited precision | 78 inbound messages |
| `stay-human-at-risk` | `at-risk` | no | 841 inbound messages |
| `stay-human-new-bookings` | `new-bookings` | no | 419 inbound messages |
| `stay-human-groups` | `groups-events` | no | 446 inbound messages |
| `stay-human-other` | `ops` as visible route only | no | 1,069 inbound messages |
| `unknown` | none | no | 99 inbound messages |

### 4.2 Shadow-evaluation candidate rules

`current refineTriageOutput flag` means current implementation flag when known. A missing flag means proposed shadow rule, not live behavior. `file_ok=yes` means only candidate eligibility for a future shadow-approved file operation; it is not permission to backfill or change visibility now.

| rule_id | Generalized source and markers | Current `refineTriageOutput` flag | Proposed category / slug | file_ok | Expected false-positive mode | Source |
| --- | --- | --- | --- | --- | --- | --- |
| `shadow.ops.routine-system` | Reservation-system or delivery-receipt source class; routine notice; no action, deadline, payment, or cancellation-fee marker | none | `file-ops` / `ops` | yes after shadow | Routine notice may contain a real booking exception or omitted action request | deterministic |
| `shadow.spam.pure-marketing` | Vendor or marketing source class; unsubscribe, promotion, newsletter, or outreach marker; no hotel action, document, payment, or security marker | none | `file-spam` / `spam` | yes after shadow | Commercial language can mention a live stay or service request | deterministic |
| `refine:never-spam-allowlist` | Trusted hotel-domain or pilot-sender source class; model proposes spam | known | `stay-human-new-bookings` / `new-bookings` | no | Trusted source can still carry cancellation, payment, policy, or security risk | deterministic |
| `refine:empty-body-not-spam` | Empty body; short subject; no sales marker | known | `stay-human-new-bookings` / `new-bookings` | no | Empty body may be an operational alert or malformed message | deterministic |
| `refine:day-visitor-not-spam` | Day-visitor, contact-form, walk-in, or table-booking marker without sales opt-out | known | `stay-human-new-bookings` / `new-bookings` | no | Form marker may be a vendor lead or a service complaint | deterministic |
| `refine:property-subject-prefer-work` | Property-leading subject from an allowlisted source; no opt-out marker | known | `stay-human-new-bookings` / `new-bookings` | no | Property name can appear in marketing or security mail | deterministic |
| `refine:short-personal-not-spam` | Short greeting or test-like personal note; no sales link | known | `stay-human-new-bookings` / `new-bookings` | no | Short note may be an internal or security probe | deterministic |
| `refine:series-release-at-risk` | Held series, allocation, or block release marker | known | `stay-human-at-risk` / `at-risk` | no | “Release” may be routine system wording rather than authorized inventory action | deterministic |
| `refine:fortimail-spam` | Security gateway quarantine or digest marker | known | `stay-human-other` / `ops` visible | no | Quarantine can represent a security incident or legitimate blocked mail | deterministic |
| `refine:guestrevu-ops` | Review-platform digest or summary marker without revenue SLA | known | `stay-human-other` / `ops` visible | no | Digest can contain complaint, privacy, or guest escalation | deterministic |
| `refine:system-mail-ops` | Reservation or channel system confirmation or cancellation marker; no positive action deadline or revenue risk | known | `file-ops` / `ops` candidate | no until shadow | System notice can conceal a real reservation consequence or action request | deterministic |
| `refine:one-room-ack-not-at-risk` | One-room booking acknowledgement; no cancellation, unpaid, or SLA marker | known | `stay-human-new-bookings` / `new-bookings` | no | One-room message can carry policy, payment, or identity ambiguity | deterministic |
| `refine:ops-handover-not-urgent` | Handover, room-readiness, or VIP-arrival marker without same-day evidence | known | `stay-human-other` / `ops` visible | no | Operational timing can be implicit or property-specific | deterministic |
| `refine:subject-urgent-not-sla` | Urgent subject plus invoice or commission marker; no body-level deadline | known | `stay-human-other` / `ops` visible | no | Deadline can be in an attachment or implied by arrival timing | deterministic |
| `refine:ops-invoice-not-urgent` | Invoice or tax-invoice marker; no same-day or hard-SLA evidence | known | `stay-human-other` / `ops` visible | no | Document lock still requires staff ownership and correct recipient | deterministic |
| `refine:same-day-ci-urgent` | Same-day check-in or arrival marker relative to `asOf` | known | human primary plus `urgent` overlay | no | Date parsing can confuse message date, stay date, or timezone | deterministic |
| `refine:subject-urgent-no-sla-signal` | Urgent subject without same-day, arrival, or hard-SLA marker | known | human primary; no new slug | no | Body, attachment, or local operating rule may carry urgency | deterministic |
| `residual.booking-like` | Residual body has generalized booking, room, stay, or quote marker | none | `stay-human-new-bookings` / `new-bookings` | no | Generic booking language can be vendor noise or incomplete request | Luna residual |
| `residual.group-like` | Residual body has generalized group, event, block, or conference marker | none | `stay-human-groups` / `groups-events` | no | Group word can refer to marketing, a prior record, or unrelated context | Luna residual |
| `residual.no-safe-route` | No stable source or body marker after local inspection | none | `unknown` / none | no | Any forced route creates false confidence | Luna residual |

### 4.3 Must-stay-human locks

Locks apply after initial classification and across the full thread. They prevent file permission and prevent hiding. High volume never overrides these locks.

| Lock | Generalized markers | Forced handling |
| --- | --- | --- |
| failure | Integration, delivery, system, or processing failure | Visible `at-risk` when consequential; otherwise visible `ops`; no file |
| payment | Deposit, payment, proof of payment, paid, refund, or card language | Visible `at-risk` or `ops`; finance review; no file |
| policy | Terms, conditions, guarantee, penalty, or policy language | Visible human route; no file |
| cancellation-fee | Cancellation plus fee, penalty, deadline, or conditional consequence | Visible `at-risk`; explicit staff decision |
| complaint | Complaint, dissatisfaction, review escalation, or guest harm | Visible `ops`; staff response |
| security | Quarantine, malware, phishing, suspicious activity, or security gateway | Visible `ops`; security review |
| VIP/privacy | VIP, privacy, confidential, identity, or sensitive-person marker | Visible `ops`; restricted staff handling |
| documents | Invoice, receipt, tax document, confirmation, voucher, attachment, or resend marker | Visible `ops`; verify document and recipient |
| low-confidence | Model uncertainty, residual unknown, ambiguity, or unresolved identity | Visible inbox/manual; no automated slug |
| SLA/unpaid | SLA, hard deadline, unpaid balance, escalation, or cancellation threat | Visible `at-risk`; add `urgent` only with actual time-bound evidence |

### 4.4 Already-replied versus inbound-only

Outbound is historical handling evidence, never permission to hide.

| Thread state | Threads | Share of threads | Interpretation | Triage treatment |
| --- | ---: | ---: | --- | --- |
| Has at least one outbound message | 301 | 12.5% | Historical staff handling exists; 311 outbound messages are retained | Keep visible; re-check current state and unresolved locks |
| Inbound-only | 2,102 | 87.5% | No retained outbound message in thread | Keep visible; candidate for evidence-backed draft and HITL |
| **Total** | **2,403** | **100.0%** |  |  |

An outbound message does not prove delivery, correctness, completion, or authorization to file future inbound mail.

### 4.5 Shadow design and false-positive controls

1. Run shadow evaluation only. Store proposed category, urgent bit, confidence, rationale class, policy flags, source class, and lock outcomes without applying a category or spam state.
2. Stratify review by pattern class, source class, both connected transports, outbound state, and lock presence. Fully enumerate the smaller transport rather than letting the dominant transport hide a coverage gap.
3. Evaluate full-thread context. A single message may look routine while another message carries payment, policy, complaint, security, document, or SLA evidence.
4. Treat `file_ok` as a gated result. A file candidate needs an adjudicated sample, zero lock leakage, explicit false-positive review, and manual override behavior before any visibility change.
5. Capture confusion pairs: routine notice versus action request, marketing versus booking, security quarantine versus spam, document delivery versus missing document, one-room acknowledgement versus payment or policy risk, and group marker versus ordinary stay.
6. Record current refine flags separately from proposed rules. A flag proves only that code path ran; it does not prove category correctness, source precision, or safe filing.
7. Use precision and recall only after a gold review sample exists. Census counts alone cannot prove either metric.

### 4.6 No-live-change boundary

This analysis performs **no backfill**, **no product folder visibility flip**, **no `spam_at` mutation**, **no automated folder slug**, and **no runtime triage change**. No candidate rule is promoted from shadow planning.

## 5. PMS/PLAYWRIGHT TOOL PORTFOLIO SPEC

### 5.1 Coverage and evolution matrix

`coverage_status` describes contract and workflow coverage, not live availability. `existing_covered` means a current contract can represent a narrow fact under its stated gates. It does not mean tool is production-active or shadow-enabled. Existing tool ID does not prove adequate field coverage, identity resolution, failure handling, auditability, or workflow completion.

#### Intent coverage

| Intent ID | Message hits | Thread hits | coverage_status | Existing tool ID | Disposition |
| --- | ---: | ---: | --- | --- | --- |
| `confirmation_status` | 1,287 | 916 | existing_insufficient | `hms_find_reservation`; `hms_list_documents`; `hms_sent_email_audit`; `mail_read_artifact` | improve_existing lookup-to-document proof chain |
| `new_booking` | 1,085 | 658 | existing_insufficient | `hms_quote_stay`; `hms_group_block_read`; `hms_company_account_read`; `hms_guest_preferences_read` | extend reads; add human-gated create later |
| `group_event` | 1,197 | 632 | existing_insufficient | `hms_group_block_read`; `hms_event_read`; `hms_company_account_read` | improve_existing group and event read gates |
| `invoice_docs` | 922 | 541 | existing_insufficient | `hms_list_documents`; `hms_read_folio`; `hms_company_account_read`; `mail_read_artifact` | extend_existing metadata to claim-safe document workflow |
| `confirmation_delivery` | 602 | 380 | existing_insufficient | `hms_find_reservation`; `hms_list_documents` | improve_existing delivery evidence; later document send |
| `cancellation` | 453 | 340 | existing_insufficient | `hms_find_reservation`; `hms_read_folio` | net_new human-gated cancel; read policy first |
| `guest_service` | 516 | 300 | gap_unlisted | `hms_guest_preferences_read` is not in current `READ_TOOLS` | improve_existing or defer to manual service handling |
| `payment_ops` | 454 | 240 | existing_insufficient | `hms_read_folio`; `hms_company_account_read`; `mail_read_artifact` | improve_existing finance reads; reject autonomous mutation |
| `channel_ota` | 199 | 186 | existing_insufficient | `hms_find_reservation`; `mail_read_artifact` | improve_existing external-reference resolution |
| `spam_noise` | 185 | 176 | existing_covered | none | no HMS tool gap; shadow triage only |
| `internal_ops` | 170 | 159 | existing_covered | none | no HMS tool gap; visible `ops` handling |
| `amendment` | 211 | 157 | existing_insufficient | `hms_find_reservation`; `hms_guest_preferences_read` | net_new human-gated edit after exact lookup |
| `quote_request` | 154 | 117 | existing_covered | `hms_quote_stay` | retain narrow read-only quote; no booking claim |

#### Fact coverage

| Fact ID | Message hits | Thread hits | coverage_status | Existing tool ID | Disposition |
| --- | ---: | ---: | --- | --- | --- |
| `confirmation_number` | 1,574 | 1,094 | existing_covered | `hms_find_reservation` | retain_existing; prove live and shadow state |
| `external_ref` | 421 | 381 | existing_covered | `hms_find_reservation`; `mail_read_artifact` | improve_existing source reconciliation |
| `guest_name` | 375 | 304 | existing_covered | `hms_find_reservation` | retain_existing with bounded identity use |
| `stay_dates` | 1,328 | 882 | existing_covered | `hms_find_reservation`; `hms_quote_stay` | retain_existing; preserve requested versus authoritative |
| `room_type` | 989 | 642 | existing_covered | `hms_find_reservation`; `hms_quote_stay` | retain_existing; no room assignment claim |
| `rate_quote` | 1,202 | 849 | existing_covered | `hms_quote_stay` | retain_existing narrow nightly read |
| `availability` | 576 | 418 | existing_covered | `hms_quote_stay` | retain_existing; no hold or bookable claim |
| `reservation_status` | 1,310 | 947 | existing_covered | `hms_find_reservation` | retain_existing; fail closed on ambiguity |
| `folio_balance` | 159 | 66 | existing_insufficient | `hms_read_folio` | retain_existing roadmap read; finance gate |
| `invoice_tax` | 982 | 581 | existing_insufficient | `hms_list_documents`; `hms_read_folio`; `hms_company_account_read` | improve_existing metadata and finance evidence |
| `payment_deposit` | 1,288 | 892 | existing_insufficient | `hms_read_folio`; `hms_company_account_read`; `mail_read_artifact` | improve_existing read; no post, settle, or refund |
| `company_bill` | 719 | 610 | existing_insufficient | `hms_company_account_read` | improve_existing after surface proof |
| `group_block` | 1,200 | 631 | existing_insufficient | `hms_group_block_read` | improve_existing aggregate-count proof |
| `event_f_and_b` | 545 | 291 | existing_insufficient | `hms_event_read` | improve_existing surface proof |
| `room_assignment` | 2 | 1 | gap_unlisted | none | defer_no_build; manual handling is proportionate |
| `special_requests` | 164 | 85 | gap_unlisted | `hms_guest_preferences_read` is not registered | improve_existing only after privacy and field proof |
| `transport_airport` | 181 | 78 | gap_unlisted | none | net_new read only if manual volume justifies it |
| `loyalty_membership` | 502 | 289 | gap_unlisted | none | net_new profile read; privacy and entitlement proof |
| `document_delivery` | 1,558 | 1,015 | existing_insufficient | `hms_list_documents`; `hms_sent_email_audit`; `mail_read_artifact` | extend_existing attachment and delivery evidence |
| `sent_email_audit` | 75 | 27 | existing_insufficient | `hms_sent_email_audit`; `hms_list_documents` | retain_existing audit read; no resend permission |

`spam_noise` and `internal_ops` are explicit no-gap results for HMS: their useful action is safe attention routing and human-visible operations, not PMS lookup.

Capability-matrix mapping is explicit: `login` is the `hms_login_session` prerequisite; `reservation-search` maps to `hms_find_reservation`; `room-type-rate-availability` maps to `hms_quote_stay`; `sent-email-audit` maps to `hms_sent_email_audit`; `folio-read` maps to `hms_read_folio`; `crs-check-availability` is the deferred create-shaped candidate below; and `write-forms` is represented only by row-specific human-gated candidates below. No generic write-form executor is proposed.

### 5.2 Current `READ_TOOLS` assessment

Assessment covers field coverage, precision and ambiguity, identity resolution, safety gates, failure handling, auditability, and workflow completeness.

| Tool ID | Current state | Field coverage and deficiency | Identity and precision | Safety and failure handling | Audit and workflow verdict |
| --- | --- | --- | --- | --- | --- |
| `hms_find_reservation` | Registry derives `discovery_verified`; live and shadow flags are false. Matrix label is ahead of registry proof. | Confirmation, external reference, guest, dates, status, room type, and rate plan; no folio, document, company, or room-assignment fact. | Exact confirmation or external reference; bounded surname-plus-date path remains manual; ambiguity is explicit. | Denies create, amend, cancel, assignment, and wizard paths; partial, ambiguous, and not-found outcomes fail closed. | Evidence includes tool version, source hash, observed and expiry times; lookup is not a complete draft workflow. Retain and promote only after live and shadow proof. |
| `mail_read_artifact` | Fixture verified only; not active in reservation session. | Authorized inbound attachment candidate; current contract denies OCR and attachment fact claims. | Server-only artifact candidate; no model-facing claim kinds. | Mail-server-only scope; no send, OCR, or attachment fact claim. | Retain foundation; extend only after MIME availability, extraction bounds, and gold review are proven. |
| `hms_quote_stay` | Fixture verified only; live and shadow flags are false. | Complete contiguous nightly observations with room, count, plan, amount, currency, basis, and restrictions; deliberately `bookable=false`, no stay total, no occupancy pricing. | Exact authored dates, occupancy, room, rate, and segment candidate; one attempt. | Denies CRS Check Availability, result-row navigation, paging, and all mutations; missing candidate is manual. | Versioned observation and source hash are available; useful read workflow, not a reservation or hold workflow. |
| `hms_list_documents` | Registry derives `discovery_verified`; live and shadow flags are false. | Finalized tax-invoice or sent-attachment metadata; `inventoryComplete=false`, attachment bytes not retrievable. | Exact reservation child or sent-email scope; no broad document search. | Denies open, preview, byte fetch, send, and export; bounds rows, bytes, and duration. | Partial metadata claim is auditable; cannot prove attachment delivery or support resend alone. |
| `hms_sent_email_audit` | Registry derives `discovery_verified`; live and shadow flags are false. | Sent time, type, subject class, attachment presence, report code class, and delivery error; no body or resend. | Exact reservation or account scope with exact redacted recipient match. | Denies resend and attachment opening; bounded rows, bytes, and duration; schema drift fails. | Good historical handling evidence; never converts prior send into hide or resend authority. |
| `hms_read_folio` | Registry derives `discovery_verified`; roadmap only. | Aggregate balance and deposit states; no line items, transaction text, payment credentials, or export. | Exact parent reservation binding; finance role, disclosure class, and source freshness required. | View-only role, surface allowlist, five-minute freshness, total consistency, and unverified-negative states. | Source time and bounded observation are auditable; useful for staff draft facts, never post, settle, refund, or email. |
| `hms_company_account_read` | Fixture verified only; explicitly blocked until surface proof. | Billing mode, payment-term class, contract status, and organization class; no contact, credit, or account identifier. | Exact reservation-linked organization; arbitrary, fuzzy, or multiple organization matches blocked. | View-only role, linked-one organization, surface field semantics, autosave denial, freshness, and bounds. | Contract is safety-forward but workflow unavailable until tenant surface proof; no billing write implication. |
| `hms_group_block_read` | Fixture verified only; explicit aggregate-count blocker. | Status, dates, room-class rows, contracted, blocked, pickup, remaining, and restrictions; no rates, identities, notes, or billing instructions. | Exact group reference plus bounded dates. | Denies edit, release, assignment, rooming list, and direct-entry events; semantics and count consistency required. | Retain roadmap candidate; do not claim aggregate coverage until live surface proof. |
| `hms_event_read` | Fixture verified only; explicit event-surface blocker. | Status, event class, times, layout, attendees, approved item summary, linked group/account, deposit status; no notes or contacts. | Exact event reference. | List-only, exact search, no detail navigation, no mutation events, role and freshness gates. | Retain roadmap candidate; current tenant surface does not prove event coverage. |

### 5.3 Full candidate portfolio

For each candidate, `primary_verb` is exactly one of `read`, `edit`, `create`, `cancel`, `document_send`, or `mail_attach`. Read candidates need no approval for the read itself; any customer-facing draft or action still needs the draft and HITL controls.

#### Read candidates

| Candidate | primary_verb | follow_on_verbs | target_object | disposition | Existing ID | execution phase | in_aug4 | in_matrix | Evidence or deficiency | Mutation risk | HITL required | Thread, intent, fact, or residual evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `hms_login_session` | `read` | none | Authenticated HMS session and property binding | retain_existing | none | active_read | no | yes | Capability-matrix prerequisite; origin, tenant, property, MFA, and session evidence required; no corpus demand signal | Session establish only; no PMS mutation | no | Prerequisite for all HMS facts; no independent intent or fact count |
| `hms_find_reservation` | `read` | none | Guest Stay reservation summary | retain_existing | `hms_find_reservation` | active_read | yes | yes | Strong field shape but no live or shadow proof in registry | Read-only when exact search is enforced | no | `confirmation_status` 916 threads; `reservation_status` 947; `confirmation_number` 1,094 |
| `hms_quote_stay` | `read` | none | Nightly room-rate-availability schedule | retain_existing | `hms_quote_stay` | active_read | yes | yes | Safe shape intentionally excludes booking, hold, total, and occupancy price | Read-only; CRS path forbidden | no | `quote_request` 117 threads; `availability` 418; `rate_quote` 849 |
| `mail_read_artifact` | `read` | none | Authorized inbound attachment evidence | retain_existing | `mail_read_artifact` | active_read | yes | yes | Fixture-only; current contract denies OCR and attachment fact claims | Read-only server scope | no | `document_delivery` 1,015 threads; attachment marker proxy 1,334 inbound |
| `hms_list_documents` | `read` | none | Finalized tax-invoice and sent-attachment metadata | retain_existing | `hms_list_documents` | roadmap_read | yes | yes | Metadata only; no byte retrieval or inventory completeness | Read-only | no | `invoice_docs` 541 threads; `confirmation_delivery` 380 |
| `hms_sent_email_audit` | `read` | none | Sent transactional-email audit | retain_existing | `hms_sent_email_audit` | roadmap_read | yes | yes | Exact scope and delivery error class; no resend | Read-only | no | `sent_email_audit` 27 threads; outbound handling evidence 301 threads |
| `hms_read_folio` | `read` | none | Folio and deposit summary | retain_existing | `hms_read_folio` | roadmap_read | yes | yes | Finance role and freshness gates; no line items or credentials | Read-only | no | `payment_deposit` 892 threads; `folio_balance` 66 |
| `hms_company_account_read` | `read` | none | Linked company or agency billing summary | retain_existing | `hms_company_account_read` | roadmap_read | yes | yes | Surface blocker; exact linked organization only | Read-only | no | `company_bill` 610 threads |
| `hms_group_block_read` | `read` | none | Group block status and aggregate counts | improve_existing | `hms_group_block_read` | roadmap_read | yes | yes | Aggregate count semantics remain unproven on live surface | Read-only | no | `group_block` 631 threads; `group_event` 632 |
| `hms_event_read` | `read` | none | Event reservation summary | improve_existing | `hms_event_read` | roadmap_read | yes | yes | Event surface is blocked for current role; list-only contract retained | Read-only | no | `event_f_and_b` 291 threads; `group_event` 632 |
| `hms_guest_preferences_read` | `read` | none | Guest preferences and special requests | improve_existing | `hms_guest_preferences_read` | roadmap_read | yes | no | Mentioned in prior demand catalog but absent from current `READ_TOOLS` registry | Read-only, privacy-sensitive | no | `special_requests` 85 threads; `guest_service` 300 |
| `hms_attachment_text_extract` | `read` | none | Text extraction from authorized attachment | extend_existing | `mail_read_artifact` | active_read | yes | no | Attachment marker proxy is 1,334 inbound; no MIME availability or extraction gold proof | Read-only; no attachment claim without source proof | no | `document_delivery` 1,015 threads; residual unknowns remain |
| `hms_loyalty_read` | `read` | none | Loyalty or membership class | net_new | none | roadmap_read | no | no | No current tool or capability row; identity and entitlement need proof | Read-only profile disclosure risk | no | `loyalty_membership` 289 threads |
| `hms_transport_read` | `read` | none | Airport transfer or transport request state | net_new | none | roadmap_read | no | no | No current tool; staff manual response remains default | Read-only guest-service privacy risk | no | `transport_airport` 78 threads |
| `reservation_room_assignment_read` | `read` | none | Room assignment | defer_no_build | `hms_find_reservation` | not_planned | no | no | Only 1 thread; current reservation schema does not prove assignment field | Read-only | no | `room_assignment` 1 thread |
| `hms_policy_read` | `read` | none | Reservation policy and cancellation-fee evidence | defer_no_build | none | not_planned | no | no | No validated surface or corpus fact contract; staff policy review remains required | Read-only policy disclosure risk | no | Policy and fee markers are lock conditions, not a safe automation signal |

#### Non-read candidates and mandatory human safety shape

Safety notation below is expanded in every row. `L` means exact identity or scope lookup. `P` means preview or diff. `A` means explicit approval. `I` means idempotency and bounded retry. `V` means authoritative postcondition verification. `U` means audit record. `R` means rollback or irreversibility handling.

| Candidate | primary_verb | follow_on_verbs | target_object | disposition | Existing ID | execution phase | in_aug4 | in_matrix | Evidence or deficiency | Mutation risk | HITL required | Thread, intent, fact, or residual evidence | Required safety shape |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `reservation_create` | `create` | `document_send` | New reservation record | net_new | none | future_write | yes | yes | No write proof; read quote is not a reservation or hold | Duplicate or committed reservation | yes | `new_booking` 658 threads; `availability` 418; `rate_quote` 849 | L exact guest, stay, room, rate, requester, and mailbox scope; P rendered create diff; A named approver identity, time, and comment; I operation key with bounded retry and no blind retry; V authoritative record lookup and status; U request, approval, response, and evidence hashes; R duplicate or unknown outcome goes to manual reconciliation, no implicit cancel |
| `reservation_stay_amend` | `edit` | `document_send` | Existing reservation dates, room, or rate | net_new | none | future_write | yes | yes | Find tool supplies lookup only; no edit executor | Stay, price, policy, and inventory consequence | yes | `amendment` 157 threads; `stay_dates` 882; `room_type` 642; `rate_quote` 849 | L exact reservation and requested field scope; P before-and-after diff with policy impact; A named approver identity, time, and comment; I operation key with bounded retry and no blind retry; V authoritative reread of dates, room, rate, and status; U request, approval, response, and evidence hashes; R restore from approved before-state or manual correction, never blind reverse |
| `reservation_cancel_no_show` | `cancel` | `document_send` | Existing reservation cancellation or no-show state | net_new | none | future_write | yes | yes | No cancel executor; fee and policy evidence unresolved | Irreversible status and fee consequence | yes | `cancellation` 340 threads; `reservation_status` 947; payment lock present | L exact reservation, requester, policy, and cancellation scope; P cancellation or no-show diff with fee and status impact; A named approver identity, time, and comment; I operation key, duplicate guard, bounded retry, and no blind retry; V authoritative cancelled or no-show status reread; U request, approval, response, and evidence hashes; R post-commit reversal is separate approved operation or manual reconciliation, never implicit rollback |
| `group_block_hold` | `edit` | none | Group allocation hold | net_new | none | future_write | yes | yes | Current group read does not prove safe allocation semantics | Inventory and allotment commitment | yes | `group_event` 632 threads; `group_block` 631 | L exact group reference, date window, room class, and allocation scope; P before-and-after block diff; A named approver identity, time, and comment; I operation key with bounded retry and no blind retry; V authoritative block and remaining-inventory reread; U request, approval, response, and evidence hashes; R release is separate approved operation, no implicit rollback |
| `group_block_release` | `cancel` | none | Held group or series allocation | net_new | none | future_write | yes | yes | Existing refine rule identifies held-series risk but no release executor exists | Releases inventory and may alter revenue exposure | yes | `group_block` 631 threads; `refine:series-release-at-risk` | L exact group, series, dates, and allocation scope; P release diff showing inventory impact; A named approver identity, time, and comment; I operation key with bounded retry and no blind retry; V authoritative block status and inventory reread; U request, approval, response, and evidence hashes; R re-hold requires separate approval, no blind retry or assumed rollback |
| `group_block_edit` | `edit` | none | Group block dates, room classes, or terms | net_new | none | future_write | yes | yes | Current read contract denies rates, billing, identities, and edits | Broad block and allocation mutation | yes | `group_event` 632 threads; `group_block` 631 | L exact group, date, room-class, and field scope; P field-level diff with allocation and billing impact; A named approver identity, time, and comment; I operation key with bounded retry and no blind retry; V authoritative block reread and count consistency; U request, approval, response, and evidence hashes; R restore from approved before-state or manual correction, never blind reverse |
| `event_fnb_edit` | `edit` | `document_send` | Event reservation and F&B configuration | net_new | none | future_write | yes | yes | Event read surface is blocked; event detail and commercial semantics unproven | Service, timing, and financial commitment | yes | `event_f_and_b` 291 threads; `group_event` 632 | L exact event reference, field scope, linked group or account, and requester; P event and item-level diff; A named approver identity, time, and comment; I operation key with bounded retry and no blind retry; V authoritative event reread including status, time, attendees, and totals; U request, approval, response, and evidence hashes; R restore from approved before-state or manual correction, no automatic reversal |
| `company_profile_edit` | `edit` | none | Company or agency profile billing fields | net_new | none | future_write | yes | yes | Company read surface is blocked and excludes contact or credit fields | Billing terms, account, and privacy mutation | yes | `company_bill` 610 threads; `payment_deposit` 892 | L exact linked organization and permitted field scope; P billing-field diff with eligibility impact; A named approver identity, time, and comment; I operation key with bounded retry and no blind retry; V authoritative profile reread and contract status; U request, approval, response, and evidence hashes; R restore from approved before-state or manual correction, no blind rollback |
| `confirmation_document_send` | `document_send` | `mail_attach` | Finalized reservation confirmation document | net_new | none | future_write | yes | no | Document metadata is partial and attachment bytes are not retrievable | Wrong document or recipient; outbound commitment | yes | `confirmation_delivery` 380 threads; `document_delivery` 1,015 | L exact reservation, document version, recipient, and mailbox scope; P rendered document and recipient diff; A named approver identity, time, and comment; I send key with bounded retry and duplicate guard; V authoritative sent audit and accepted delivery outcome; U document, approval, request, response, and evidence hashes; R cannot unsend, so correction is a separately approved message and manual reconciliation |
| `tax_invoice_document_send` | `document_send` | `mail_attach` | Finalized tax invoice or approved invoice document | net_new | none | future_write | yes | no | Invoice facts are high volume but final document and recipient proof are incomplete | Financial or legal document misdelivery | yes | `invoice_docs` 541 threads; `invoice_tax` 581; `document_delivery` 1,015 | L exact reservation or account, finalized document class, recipient, and scope; P document version, tax fields, and recipient diff; A named approver identity, time, and comment; I send key with bounded retry and duplicate guard; V authoritative sent audit and accepted delivery outcome; U document, approval, request, response, and evidence hashes; R cannot unsend or erase legal history, so correction and reconciliation are manual |
| `confirmation_or_invoice_resend` | `document_send` | `mail_attach` | Previously sent confirmation or tax invoice | net_new | `hms_sent_email_audit` | future_write | yes | no | Audit read proves historical handling only; it does not authorize resend | Duplicate or privacy-sensitive outbound send | yes | `sent_email_audit` 27 threads; `confirmation_delivery` 380; `invoice_docs` 541 | L exact original scope, document identity, recipient, and reason; P resend diff with duplicate and recipient checks; A named approver identity, time, and comment; I resend key with bounded retry and no blind retry; V authoritative sent audit and accepted delivery outcome; U original evidence, approval, request, response, and reason hashes; R cannot unsend, so correction and manual reconciliation are required |
| `mail_attach` | `mail_attach` | `document_send` | Approved document attached to draft mail | net_new | none | future_write | yes | no | 1,334 inbound attachment markers are only a proxy; no object availability proof | Wrong attachment, scope, or recipient | yes | `document_delivery` 1,015 threads; attachment marker proxy 1,334 | L exact draft, document, recipient, and reservation or account scope; P attachment name, type, version, and recipient diff; A named approver identity, time, and comment; I attachment operation key with bounded retry and duplicate guard; V draft or sent audit confirms exact attachment metadata; U attachment, approval, request, response, and evidence hashes; R cannot retract after send, so wrong attachment needs separate correction and manual reconciliation |
| `folio_post_settle_refund` | `edit` | `cancel` | Folio or deposit ledger posting, settlement, or refund | defer_no_build | `hms_read_folio` | not_planned | no | yes | Read facts support demand, but current tool explicitly denies post, settle, and refund | Financial ledger mutation and irreversibility | yes | `payment_deposit` 892 threads; `folio_balance` 66 | L exact reservation, finance requester, ledger scope, and transaction intent; P ledger diff and amount-status impact; A named approver identity, time, and comment; I operation key with bounded retry and no blind retry; V authoritative ledger reread and reconciliation; U request, approval, response, and evidence hashes; R ledger correction is manual and separately governed, with no autonomous rollback |
| `crs_check_availability` | `create` | none | CRS availability flow that creates a reservation record | defer_no_build | none | future_write | yes | yes | Official workflow is create-shaped; it is never a read substitute | Creates a new record even when phrased as availability | yes | `quote_request` 117 threads; `new_booking` 658; `availability` 418 | L exact reservation candidate, requester, dates, room, rate, and scope; P create-shaped record diff and side-effect warning; A named approver identity, time, and comment; I operation key with duplicate guard and no blind retry; V authoritative record lookup and final status; U request, approval, response, and evidence hashes; R unknown outcome requires manual reconciliation, never automatic retry or cancellation |

### 5.4 Build order

**Wave 0 — read correctness and safety**

- Reconcile census scope, residual artifact scope, active transports, and deterministic denominator.
- Reconcile registry state with capability-matrix state; do not treat a matrix label as live proof.
- Prove exact identity binding, tenant and property binding, request firewall behavior, bounded inputs, stale-source behavior, ambiguity, not-found, partial, and unverified-negative outcomes.
- Keep `hms_find_reservation`, `hms_quote_stay`, and `mail_read_artifact` read-only. No CRS Check Availability and no write-form exploration.

**Wave 1 — active reads and net-new reads**

- Shadow `hms_find_reservation` with exact confirmation or external-reference candidates.
- Harden `hms_quote_stay` on complete contiguous nightly output; preserve `bookable=false`, null stay total, and no occupancy-priced claim.
- Decide whether attachment extraction, guest preference, loyalty, or transport reads have sufficient identity, privacy, and source evidence. Unknown remains manual.

**Wave 2 — roadmap reads**

- Release document metadata and sent-email audit reads after exact-scope and live-proof gates.
- Release folio reads only with finance role, disclosure, freshness, consistency, and unverified-negative gates.
- Release company, group, and event reads only after tenant surface, semantics, count, and mutation-inertness proof.
- Keep document bytes, rooming-list identities, contacts, notes, rates, billing instructions, and payment credentials outside model claims unless a separate contract proves them.

**Wave 3 — human-gated writes**

- Consider reservation create, stay amend, cancellation or no-show, group hold/release/edit, event or F&B edit, company profile edit, document send, resend, and mail attach only after read evidence is fresh and exact.
- Keep folio post, settle, refund, and CRS Check Availability out of autonomous execution. CRS Check Availability remains create-shaped even when user intent sounds read-only.
- Every write follows `proposed → approved → revalidated → submitted → authoritative_outcome → reconciled → customer_notified`.
- Do not implement any candidate in this analysis.

## 6. KPI catalog with measured values

All values below are corpus measurements or explicitly labeled planning projections. Overlapping regex hits are not additive shares.

| KPI | Measured value | Formula and denominator | Claim boundary |
| --- | ---: | --- | --- |
| Inbound message mix | 90.5% | 2,957 inbound ÷ 3,268 messages | Volume only; not workload or response-time proof |
| Outbound message mix | 9.5% | 311 outbound ÷ 3,268 messages | Historical handling only; not delivery or completion |
| Multi-message thread share | 13.6% | 328 multi-message threads ÷ 2,403 threads | Conversation shape only |
| Outbound-with-staff thread share | 12.5% | 301 threads with outbound ÷ 2,403 threads | Prior handling evidence; never hide on this basis |
| Inbound-only thread share | 87.5% | 2,102 inbound-only threads ÷ 2,403 threads | No retained outbound in thread; not proof of no response elsewhere |
| Deterministic routine-system share | 0.2% | 5 `system-routine` inbound messages ÷ 2,957 inbound messages | Narrow pattern share only; not total fileable share |
| Conservative file-spam planning share | 2.6% | 78 projected `file-spam` inbound messages ÷ 2,957 inbound messages | Candidate volume, not precision or safe-live permission |
| Residual trigger share | 3.8% | 111 residual inbound triggers ÷ 2,957 inbound messages | Uncovered signal share; 99 remain unknown after residual judgment |
| Fully residual thread share | 4.2% | 100 fully residual threads ÷ 2,403 threads | Thread-level unknown pressure; residual artifact has 108 references due mixed threads |
| Unknown planning share | 3.3% | 99 unknown projected inbound messages ÷ 2,957 inbound messages | Abstention share; not spam or irrelevance |
| Attachment-marker proxy | 45.1% | 1,334 inbound messages with attachment-like marker ÷ 2,957 inbound messages | Marker only; no MIME availability or extraction proof |
| Confirmation-status demand signal | 39.4% | 1,287 message hits ÷ 3,268 messages | Overlaps other intent hits; not additive workload share |
| Group-event demand signal | 36.6% | 1,197 message hits ÷ 3,268 messages | Overlaps booking, payment, document, and status signals |
| New-booking demand signal | 33.2% | 1,085 message hits ÷ 3,268 messages | Demand signal; no booking or revenue outcome |
| Document-delivery fact signal | 47.7% | 1,558 message hits ÷ 3,268 messages | Fact marker; not proof of retrievable document |
| Reservation-status fact signal | 40.1% | 1,310 message hits ÷ 3,268 messages | Fact marker; not proof of current HMS state |

Roadmap claims stop at observed demand, read-contract coverage, reviewed shadow quality, and authorized system outcomes. This report does not claim revenue, ROI, conversion uplift, autonomous booking, autonomous cancellation, or production triage accuracy.

## 7. Next-plan seed

1. **Shadow-evaluate triage rules.**
   - Run local shadow evaluation over all active transports and full retained history.
   - Stratify by deterministic class, source class, outbound state, lock, and residual status.
   - Compare current refine flags with proposed rules.
   - Adjudicate file candidates and lock leakage before any write gate is considered.
   - Persist confusion counts, abstentions, manual overrides, and reviewed examples without exposing identifying values in tracked artifacts.

2. **Claim-safe draft persistence and HITL.**
   - Reuse existing evidence path: server-owned candidate binding, tool ID and version, observed time, expiry, source hash, claim keys, unresolved fields, and authoritative status.
   - Persist draft state separately from action state.
   - Provide approve, edit, take over, dismiss, pause, retry-after-reconciliation, and manual-reconciliation outcomes.
   - Make prior outbound evidence visible as context only. It never grants hide or resend permission.

3. **Playwright HMS reads first.**
   - Wave 0: exact search, tenant/property binding, request firewall, session authorization, bounded reads, and failure or ambiguity handling.
   - Wave 1: `hms_find_reservation` and `hms_quote_stay` shadow reads; then decide attachment, preference, loyalty, and transport read gaps.
   - Wave 2: document, sent-email, folio, company, group, and event reads one surface at a time.
   - Keep CRS Check Availability outside read automation.

4. **Later human-gated writes.**
   - Start only after fresh read evidence and operation-specific safety contracts.
   - Require exact identity and scope lookup, preview or diff, explicit approval, idempotency key, bounded retry, authoritative postcondition, audit record, and rollback or manual reconciliation.
   - Treat rejected, expired, failed, duplicate-prevented, and unknown-outcome states separately.
   - Never retry create or cancel blindly.

5. **Verification gate.**
   - Before any live product change, review this aggregate analysis against a fresh census, repeat the privacy check, and obtain a separate implementation plan. This document itself authorizes no code, folder, database, or HMS change.
