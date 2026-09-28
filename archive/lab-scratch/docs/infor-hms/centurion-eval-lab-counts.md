# Centurion neededCount (one integer per tool)

Denominator: **980 candidate inbounds** (1069 − skip). Window Sep 9–18 16:50 JHB.
Metric: inbound requires this verb (stack OK).

| neededCount | tool | 95 |
| ---: | --- | --- |
| 16 | `hms_find_reservation` | met |
| 17 | `hms_read_reservation` | met |
| 3 | `hms_read_notes_traces` | met |
| 73 | `mail.send_with_attachments` | met |
| 3 | `hms_attach_guest_stay_document` | met |
| 43 | `hms_list_documents` | met |
| 279 | `mail_read_artifact` | met |
| 50 | `documents_read_existing` | met |
| 43 | `documents_list_existing` | met |
| 78 | `hms_send_reservation_confirmation` | met |
| 184 | `hms_quote_stay` | met |
| 124 | `hms_generate_confirmation_proforma` | met |
| 0 | `hms_generate_quote_document` | met |
| 170 | `hms_group_block_read` | met |
| 70 | `hms_amend_reservation` | met |
| 41 | `hms_create_reservation` | met |
| 75 | `hms_cancel_reservation` | met |
| 93 | `hms_read_folio` | met |
| 61 | `hms_post_payment` | met |
| 108 | `hms_generate_invoice` | met |
| 0 | `hms_email_folio` | met |
| 16 | `hms_refund` | met |
| 8 | `hms_company_account_read` | met |
| 51 | `hms_event_read` | met |
| 3 | `property_read_knowledge` | met |
| 39 | `mail_parse_channel_payload` | met |
| 0 | `hms_sent_email_audit` | met |

## Staff-used (gold oracle)

Denom paired: **285**. Denom outbound_only: **124**. Not added to 980.
Metric: staff reply used this verb. `hms_list_documents` ≡ `documents_list_existing` (alias, no id merge).
Call-graph: find+read `alwaysInStack` on existing-stay work even when ask is 16/17.

| staffUsed | ask | alwaysInStack | tool |
| ---: | ---: | --- | --- |
| 166 | 73 |  | `mail.send_with_attachments` |
| 143 | 184 |  | `hms_quote_stay` |
| 94 | 78 |  | `hms_send_reservation_confirmation` |
| 91 | 3 |  | `hms_attach_guest_stay_document` |
| 89 | 17 | yes | `hms_read_reservation` |
| 84 | 61 |  | `hms_post_payment` |
| 75 | 16 | yes | `hms_find_reservation` |
| 57 | 0 |  | `hms_generate_quote_document` |
| 56 | 3 |  | `hms_read_notes_traces` |
| 51 | 108 |  | `hms_generate_invoice` |
| 47 | 8 |  | `hms_company_account_read` |
| 44 | 70 |  | `hms_amend_reservation` |
| 43 | 170 |  | `hms_group_block_read` |
| 41 | 41 |  | `hms_create_reservation` |
| 30 | 279 |  | `mail_read_artifact` |
| 29 | 75 |  | `hms_cancel_reservation` |
| 25 | 124 |  | `hms_generate_confirmation_proforma` |
| 19 | 0 |  | `hms_email_folio` |
| 19 | 43 |  | `hms_list_documents` |
| 19 | 3 |  | `property_read_knowledge` |
| 18 | 51 |  | `hms_event_read` |
| 17 | 50 |  | `documents_read_existing` |
| 14 | 93 |  | `hms_read_folio` |
| 13 | 43 |  | `documents_list_existing` |
| 9 | 16 |  | `hms_refund` |
| 5 | 39 |  | `mail_parse_channel_payload` |
| 4 | 0 |  | `hms_sent_email_audit` |
