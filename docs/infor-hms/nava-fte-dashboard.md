# Nava FTE dashboard

## Loaded

- Mailboxes: 2
- Messages: 3268 (all directions)
- Threads: 2403
- asOf: 2026-08-25T22:24:55.657Z

## First-response latency

- nEligibleFirstResponse: 26
- medianFirstResponseMinutes: 48.95
- p90FirstResponseMinutes: 712
- inbound-only: 2102 / 2403 (87.5%)
- caveat: Inbound-only is a retained-outbound gap, not proof of no reply elsewhere.

## Attention mix (inbound messages)

| Class | Count | Share |
| --- | ---: | ---: |
| stay-human-other | 1069 | 36.2% |
| stay-human-at-risk | 841 | 28.4% |
| stay-human-groups | 446 | 15.1% |
| stay-human-new-bookings | 419 | 14.2% |
| unknown | 99 | 3.3% |
| file-spam | 78 | 2.6% |
| file-ops | 5 | 0.2% |
| **Total** | **2957** | **100.0%** |

Mix is inbound messages (n=2957). Loaded 3268 is all messages. Unknown 99 is inbound messages, not Luna 152 unknown-route threads.

## Source family (harmonized exclusive)

| Family | Threads | Share |
| --- | ---: | ---: |
| security_quarantine | 526 | 21.9% |
| payment_gateway_pop | 506 | 21.1% |
| confirmation_document | 329 | 13.7% |
| ota_channel | 309 | 12.9% |
| synxis_integration | 155 | 6.5% |
| night_audit_internal | 154 | 6.4% |
| reservation_pms_notice | 152 | 6.3% |
| unknown | 88 | 3.7% |
| vendor_newsletter | 86 | 3.6% |
| human_external_request | 63 | 2.6% |
| bounce_delivery | 35 | 1.5% |

## Luna full-thread routes

| Route | Threads | Share |
| --- | ---: | ---: |
| ops | 1097 | 45.7% |
| resolved | 647 | 26.9% |
| spam | 397 | 16.5% |
| unknown | 152 | 6.3% |
| at-risk | 110 | 4.6% |

## HITL locks

- failure
- payment
- policy
- cancellation-fee
- complaint
- security
- VIP/privacy
- documents
- low-confidence
- SLA/unpaid

- Luna human-lock: 1134 / 2403
- security quarantine ≠ spam

## Ranked existing reads

| Rank | Tool | Evidence | Flags |
| --- | --- | --- | --- |
| 1 | `hms_find_reservation` | confirmation_number 1094 threads | live=false shadow=false |
| 2 | `hms_list_documents` | document_delivery 1015 threads | live=false shadow=false |
| 3 | `hms_find_reservation (status)` | reservation_status 947 threads | live=false shadow=false |
| 4 | `hms_read_folio` | payment_deposit 892 threads | live=false shadow=false |
| 5 | `hms_quote_stay` | rate_quote 849 threads; bookable=false | live=false shadow=false |
