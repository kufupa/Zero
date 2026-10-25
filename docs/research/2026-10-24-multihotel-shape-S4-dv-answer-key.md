# HRDAV outbound quote answer key — S4

**Result:** 38 PDF rows pass explicit-field + total checks; all are BAR/B&B. No HMS; read-only prod DB/S3 via SSM, no writes. Remote `/tmp/s4-dv/` is deleted.

## 1. Scan
- 150/150 attachments scanned: 140 PDF, 10 XLSX; 0 download/parse failures.
- 97 heuristic quote candidates (quote marker + price + room/board cue); 38 complete rows; 27 distinct answer facts.
- Single-night total-only candidates excluded unless explicit unit-rate evidence also present.
- 141 unique binaries; 9 exact repeat copies in the 150-file scope.
- PDF issue dates not reliable; `Sent*` below (all 2026) is outbound email date proxy, not verified quote date.

## 2. Rate evidence
- BAR only: 38 attachment rows, 27 distinct facts; B&B only; rooms Standard King, Suite, Deluxe King.
- Across the 27 distinct facts: ZAR 2,700 min / 4,071 median / 22,813 max. No company/agency in these rows.

## 3. Company/agency → nearby rate label
| Explicit field | Docs | Nearby rate label |
|---|---:|---|
| Mocha Travel | 1 | none explicit |
| Silverdoor | 1 | none explicit |
| International Federation of Red Cross and Red Crescent Societies (institution) | 1 | none explicit |
No named entity links to a validated answer-key row.

## 4. XLSX exceptions
10 XLSX scanned; 0 pass the complete-row gate. Two sheets have date, Single/B&B, and ZAR 3,280 cues, but both `Contract/NC` and `STO/net` appear without a unique same-row rate binding; excluded from the answer key.

## 5. Template/layout
140 PDFs (93.3%) vs 10 XLSX (6.7%); all answer rows are PDF. PDF Creator: wkhtmltopdf 47, Office 1, PDFium 1, other/unknown 91; Producer unknown on 138/140. Letterheads: Da Vinci Hotel 88, Legacy Hotels 56, both 39, The Da Vinci 1; not one uniform template.

## 6. Verified vs inference — rate source
- **Verified:** all 38 rows show an explicit unit/nightly-rate cue; displayed total equals nightly rate × nights. BAR is the only validated label.
- **Inference:** route WS/NC/GOV/AIR and date-dependent BAR to the live HMS sales-strategy shop; do not hard-code from old PDFs.
- **Inference:** use fixed contract sheets only when named company/agency, effective dates, room and board bind explicitly. No such priced row validated here.
- `STO/net` and `Contract/NC` remain ambiguous in XLSX. No live HMS shop inspected; mapping is provisional, not HMS-verified.
- **95 threshold not met** for a general rate-source map: only BAR validated; this is not a Nava price-accuracy replay.

## 7. Validated attachment rows
`A###` = synthetic inventory slot; `Sent*` = outbound date proxy; amounts in ZAR; `—` = no company field.
| ID | Sent* | Stay | Room | Board | Label | Night | Total | Company/agency |
|---|---|---|---|---|---|---:|---:|---|
| A103 | Oct 09 | 2026-10-11→2026-10-14 | Standard King | B&B | BAR | 2,760 | 8,280 | — |
| A095 | Oct 09 | 2026-11-08→2026-11-12 | Standard King | B&B | BAR | 4,280 | 17,120 | — |
| A120 | Oct 09 | 2027-11-20→2027-11-22 | Deluxe King | B&B | BAR | 4,130 | 8,260 | — |
| A035 | Oct 14 | 2026-11-27→2026-11-30 | Standard King | B&B | BAR | 3,690 | 11,070 | — |
| A055 | Oct 14 | 2026-12-17→2026-12-22 | Suite | B&B | BAR | 4,290 | 21,450 | — |
| A129 | Oct 14 | 2026-12-17→2026-12-22 | Suite | B&B | BAR | 6,200 | 31,000 | — |
| A071 | Oct 14 | 2027-04-26→2027-04-29 | Suite | B&B | BAR | 4,390 | 13,170 | — |
| A027 | Oct 14 | 2027-04-26→2027-04-29 | Suite | B&B | BAR | 22,390 | 67,170 | — |
| A132 | Oct 14 | 2027-04-26→2027-04-29 | Suite | B&B | BAR | 22,390 | 67,170 | — |
| A037 | Oct 14 | 2027-04-26→2027-04-29 | Suite | B&B | BAR | 22,813 | 68,439 | — |
| A139 | Oct 14 | 2027-04-26→2027-04-29 | Suite | B&B | BAR | 22,813 | 68,439 | — |
| A088 | Oct 15 | 2026-10-28→2026-10-30 | Standard King | B&B | BAR | 3,500 | 7,000 | — |
| A016 | Oct 15 | 2027-08-21→2027-08-22 | Standard King | B&B | BAR | 4,071 | 4,071 | — |
| A136 | Oct 15 | 2027-08-21→2027-08-22 | Standard King | B&B | BAR | 4,071 | 4,071 | — |
| A002 | Oct 15 | 2027-08-21→2027-08-22 | Suite | B&B | BAR | 6,582 | 6,582 | — |
| A121 | Oct 15 | 2027-08-21→2027-08-22 | Suite | B&B | BAR | 6,582 | 6,582 | — |
| A105 | Oct 15 | 2027-08-21→2027-08-22 | Suite | B&B | BAR | 6,710 | 6,710 | — |
| A018 | Oct 16 | 2026-10-17→2026-10-24 | Standard King | B&B | BAR | 3,870 | 27,090 | — |
| A111 | Oct 16 | 2027-07-11→2027-07-13 | Suite | B&B | BAR | 4,480 | 8,960 | — |
| A147 | Oct 16 | 2027-07-11→2027-07-13 | Suite | B&B | BAR | 22,493 | 44,986 | — |
| A042 | Oct 17 | 2027-06-21→2027-06-22 | Standard King | B&B | BAR | 3,930 | 3,930 | — |
| A020 | Oct 19 | 2026-10-20→2026-10-22 | Standard King | B&B | BAR | 2,880 | 5,760 | — |
| A149 | Oct 19 | 2026-10-25→2026-10-26 | Standard King | B&B | BAR | 3,870 | 3,870 | — |
| A036 | Oct 19 | 2026-10-26→2026-10-28 | Standard King | B&B | BAR | 3,870 | 7,740 | — |
| A116 | Oct 19 | 2026-10-26→2026-10-28 | Standard King | B&B | BAR | 3,870 | 7,740 | — |
| A127 | Oct 21 | 2026-10-29→2026-11-02 | Standard King | B&B | BAR | 2,880 | 11,520 | — |
| A003 | Oct 21 | 2026-10-30→2026-10-31 | Standard King | B&B | BAR | 3,600 | 3,600 | — |
| A048 | Oct 21 | 2026-10-30→2026-10-31 | Standard King | B&B | BAR | 3,600 | 3,600 | — |
| A064 | Oct 21 | 2026-10-30→2026-10-31 | Standard King | B&B | BAR | 3,600 | 3,600 | — |
| A112 | Oct 21 | 2026-10-30→2026-10-31 | Standard King | B&B | BAR | 3,600 | 3,600 | — |
| A124 | Oct 21 | 2026-10-30→2026-10-31 | Standard King | B&B | BAR | 3,600 | 3,600 | — |
| A005 | Oct 21 | 2026-11-25→2026-12-01 | Standard King | B&B | BAR | 3,870 | 23,220 | — |
| A007 | Oct 21 | 2026-11-25→2026-12-01 | Standard King | B&B | BAR | 3,870 | 23,220 | — |
| A054 | Oct 21 | 2026-11-25→2026-12-01 | Standard King | B&B | BAR | 3,870 | 23,220 | — |
| A059 | Oct 21 | 2027-02-07→2027-02-08 | Standard King | B&B | BAR | 3,520 | 3,520 | — |
| A109 | Oct 22 | 2027-02-06→2027-02-08 | Standard King | B&B | BAR | 2,700 | 5,400 | — |
| A087 | Oct 23 | 2026-10-25→2026-10-29 | Suite | B&B | BAR | 5,220 | 20,880 | — |
| A101 | Oct 23 | 2026-10-26→2026-10-29 | Suite | B&B | BAR | 5,220 | 15,660 | — |
