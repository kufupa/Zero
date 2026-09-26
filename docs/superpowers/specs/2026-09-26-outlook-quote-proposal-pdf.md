# Outlook Quote Proposal PDF

**Date:** 2026-09-26  
**Status:** freeze (grill + nine-day and 18–25 corpus)  
**Not code.** Implementation plan: `docs/superpowers/plans/2026-09-26-outlook-quote-proposal-pdf.md`.

## Problem

Centurion staff send a legal quotation as an Excel **Proposal** PDF attached to an Outlook reply. Infor HMS has no Quote PDF. The Outlook pane today pastes an HTML rate table into `CREATE_REPLY_DRAFT`. That is not staff practice.

## Who

Hotel reservationists in Classic Outlook 2016 VSTO pane (380px), including a **cross-user pilot**: `centurion@`, `marthamthembu@`, `kdouglas@` (Kamala), later other mailboxes.

## Freeze

| Id | Decision |
| --- | --- |
| D1 | Excel Proposal PDF only. Print area `A1:H69`, A4, scale 79%. Not HMS confirmation/proforma. |
| D2 | Patch the real `.xlsx`, convert with Gotenberg LibreOffice. Not HTML clone, Graph `format=pdf`, or Excel COM. |
| D3 | Attach into the Outlook reply only. Wrapper HTML, then `ADD_ATTACHMENT_TO_DRAFT`. No download. HTML rate table dies. |
| D4 | Footer Full Name + Email from the current **matched** user (`session.user.name` + matched address). |
| D5 | Refuse PDF if Nava email ≠ Outlook `workstationInfo.outlookEmail` (case-insensitive). |
| D6 | Telephone = `0126433600`. Later: per-mailbox from prior Sent quotes. Not Better Auth OTP `phoneNumber`. |
| D8 | DESCRIPTION = `{Class} room {Meal}` from native HMS code + meal. |
| D9 | Gold wrapper copy. No ZAR in the body. |
| D10 | Attention / Company / Email / Telephone from inbound thread. Blank > invent. |

Also locked: filename `Quote - {agency} {dates}.pdf`; VAT cell `Included`; `LINE TOTAL = QTY × Nights × RATE`; keep T&Cs “subjected”; one row per (dates × class × meal × rate).

## DESCRIPTION map

Meal: `Dinner Bed & Breakfast` | `Bed & Breakfast` | `Room Only`.

| HMS code | Class |
| --- | --- |
| `DLXKNG` `DLXQN` `DLXTWN` | Deluxe |
| `LUXKNG` | Luxury |
| `SUITE` `SKNG` | Suite |
| `EXKNG` `STQN` | Single |
| `STWN` | Twin |

Pane demo without a live code: single occupancy → `STQN`, twin → `STWN`. When quote stay returns codes, pass those.

## Identity

Compare `session.user.email` to `workstationInfo.outlookEmail`. Mismatch → toast, no convert, no draft. Server repeats the check: `outlookEmail` must equal session email; stamp `session.user.name` and that email. Kamala needs Nava user `kdouglas@legacyhotels.co.za`.

## Wrapper (D9)

```
Good day {name},
Thank you for Choosing The Centurion Hotel.
Please see attached quotation.
Should you wish to proceed, please sign and return the attached quotation so
that we can confirm and secure your reservation. Please note that no rooms
are currently being held, and bookings will only be confirmed once we have
received the signed quotation.
Please feel free to contact me should you require any further information
Kind regards,
```

## Attach sequence

1. Identity match.  
2. `workstation.quoteProposalPdf` → `{ fileName, pdfBase64 }`.  
3. `CREATE_REPLY_DRAFT` with wrapper `htmlBody`.  
4. `ADD_ATTACHMENT_TO_DRAFT` with draft `entryId` / `storeId`, `fileName`, `base64Data`.

## Non-goals (V1)

Pro-Forma Invoice Excel, HMS confirmation PDFs, contracts, function sheets, COM scrape of prior quotes for personal DDI, download button.

## Evidence

Private aggregates: `.private/quote-pdf-template-vs-sent-2026-09-25.json`. Do not commit raw PDFs or PII.
