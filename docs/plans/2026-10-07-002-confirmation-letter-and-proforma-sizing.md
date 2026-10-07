# Confirmation letter and pro forma sizing (v2 S5)

Aggregates only. No names, addresses, or confirmation numbers.

**Date:** 2026-10-07. **Sources:** 116 HMS confirmation-letter PDFs (S3, outbound Sep 28–Oct 6), corpus A outbound threads, census-v2 (1,189 rows), gap audit `[G]`.

## What staff send

Confirmation letters are **HMS-generated PDFs** (`HRCEN_Confirmation_Letter_<conf>.pdf`), not a Zero composer. Fields on the letter (guest, confirmation, arrival/departure, room type, persons, ADR, rate includes, stay total, deposit) all come from the reservation header. Deposit received was **0/116** on this slice: booking is saved before payment.

Letter mix (n=116): Standard Queen/Twin 78%; B&B 80%; DBB 20%; 1-adult rooms dominate.

Pro formas are a separate outbound ask (invoice/banking details), often on the same thread as a create request. They are not the confirmation letter.

## Volume

| Item | Count | Note |
|---|---:|---|
| Confirmation-letter PDFs in this slice | 116 | ~13/day in the earlier fortnight estimate `[G]` / S9 (106–111 staff threads) |
| Census `create_booking` | 47 | luna labels; not all become letters |
| Gap audit S9 confirmation/proforma staff threads | 106–111 / fortnight | |

## Product implication

Do **not** build a Zero letter generator. After a lab or staff save, the next step is “open/send the HMS confirmation letter” (and later a pro forma if the client asked). Wiring = post-save HMS document, not PDF synthesis.

## Next build (after pane Save is proven on lab stays)

1. Read-only: fetch the HMS confirmation PDF for a lab confirmation and attach it to an unsent draft.
2. Pro forma: only when the inbound thread asked for invoice/banking; reuse existing PDF/convert path if HMS already prints one, else staff-typed.
3. Do not auto-send.
