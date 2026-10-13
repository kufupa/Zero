# Gold quote anatomy and test cases (research pass, 2026-10-12 23:50 UTC)

Gold sources: `.private/gold-proposals/` (48 quote PDFs) and `.private/reservationist-backtest/corpus/case-digest.md` (126 gold threads), in the centurion-dashboard-tools worktree.

## Gold reply
- **The PDF** is a "Proposal" from the fixed Excel template.
  - Lines: DATE, QTY, DESCRIPTION, Nights, RATE per room per night, LINE TOTAL.
  - Footer: "15% vat Included", "*1% Tourism Levy", the included and optional-spoils lists, the T&Cs, "Valid until: 3 days", and Accepted By/Date.
- **Nava's default PDF** patches that same template (`fixtures/centurion-quotation-template.xlsx`, `patch-sheet.ts`). It matches, but prod env is unverified.
- **The wrapper mail** is 5 lines: "Good day {name}," / "Thank you for Choosing The Centurion Hotel." / "Please see attached quotation." / sign and return, "no rooms are currently being held" / "Kind regards,".
- **Nava gaps:**
  - No server producer of the reply body. The session starts empty, so staff type it (`session.ts:322`). `apps/mail/lib/quote-proposal/copy.ts` has gold wording but only tests use it. **Fix tonight: prefill the reply from the gold wrapper.**
  - Room labels are wrong: SKNG maps to Suite and EXKNG to Single (`apps/mail/lib/quote-proposal/description.ts:10-11`). **Fix tonight.**
  - Stays are capped at 30 nights (`quote-stay-candidate.ts:10`), but 5 of 48 gold PDFs have 18+ nights. Keep the cap and give a clear refusal.

## Case mix (48 sent PDFs)
- Lines per quote: 1 line 69%, 2 lines 19%.
- Meal plan: B&B 53%, DBB 44%.
- Room type: Single 65%, Deluxe 11%, Twin 8%.
- Groups (any line qty 5+): 25%. Extras 10%. Multi-date 10%.
- A party is named in 70% of quote mails: agency 23–38%, company 27%, government 15–20%.

## Generalisation test shapes (pick real threads; candidates in /tmp/qm/test-threads.md)
1. Leisure, 1 room, inline rate
2. Family with child ages
3. Family with no ages (ask back)
4. Government, 1 room, DBB, 5 nights
5. Agency, 4 rooms, DBB, transfers
6. Agency, multi-date, mixed rooms
7. Group of 15–34 rooms
8. Event of 80 rooms (route or refuse)
9. 48 nights (clean refusal)
10. Corporate, no dates (no invented rate)
11. Negative: pro forma or POP produces no quote

No measured "98%" exists. The 126-case backtest (old pipeline) had 70.6% deterministic pass and 34.9% good/acceptable.
