# TMC voucher notices: new booking or existing stay? (2026-10-19)

**Answer: automated travel-agent/TMC voucher emails at Centurion mostly refer to a booking that already exists in Infor. Staff work is find the stay → check company/billing → attach the voucher, not create a reservation.** Routing for owner ask #118: `origin=system_notice` + action `new_booking` → **Payments** (voucher/POP folder), not New bookings.

## 1. What these mails are

TMC = travel management company (corporate travel agency): Rennies BCD, FCM, Travelit (Tourvest), Travel With Flair (TWF), Nexus, Thompsons, CRC. They book for business travellers and email the hotel an "accommodation voucher" / "travel voucher" (often a PDF; body near-empty).

## 2. Local evidence (prod, Centurion, last 30 days, counts only)

| Check | Result |
|---|---|
| Automated mail the v4 classifier labels `new_booking` | 15 (Travelit 3, Rennies 3, TWF 3, Nexus 2, Thompsons, NexCT, FCM, CRC 1 each) |
| Carries a machine-matchable booking reference (subject or extraction) | 6/15: CRS-format `5940SH…` (TWF ×2, FCM, CRC), Infor-format `NNNNNNNN-N` (Nexus, Travelit). Rennies/TWF bodies mention supplier/reservation numbers the extraction did not keep |
| That reference seen earlier in other mail | 5/6: `5940SH…` in **SynXis/Profitroom** mail 15 min to 2 days **before** the voucher; Infor-format in hotel staff mail 4 h to 2 days before. CRC's ref was not seen earlier |
| No reference matched | 10/15 (one is a duplicate of a matched TWF voucher). Owner is spot-checking these in HMS |
| Body asks the hotel to book/confirm | 0/15 |
| Staff replied in the thread | 1/15 |

Prior research agrees: R3 (`docs/research/2026-10-13/r3-workflow-truth.md` L4–L6, L57–L59) found 0/35 sampled agent vouchers had a same-thread staff Confirmation Letter, and 0/35 carried payment proof. Da Vinci staff interview (FACTS.md §voucher field evidence; transcript 05:06–06:08): GDS/SynXis bookings download into Infor without the company name; staff add company, check details and attach vouchers by hand.

Owner, 2026-10-13: agency vouchers are "both proof of payments and booking requests"; "vouchers parked, find first later".

## 3. External evidence (Exa Agent, high effort, run `agent_run_02f826e3d88e455fa87769cac795243d`, $0.50)

- No public rule says TMC vouchers always auto-populate the PMS or always need keying. It depends on whether the booking came through a connected CRS/GDS path.
- Infor HMS documents external CRS/HTNG connectivity, notably SynXis ([Infor HMS 3.8.4 release notes](https://docs.infor.com/hms/3.8.x/en-us/useradminlist/HMS%203.8.4%20Release%20Notes_70176.pdf)); SynXis delivers create/modify/cancel to the PMS ([SynXis PMS reservation delivery](https://developer.synxis.com/pms/htng/reservation_delivery)).
- The TMCs book through online booking tools and GDS/aggregators ([Rennies BCD](https://www.bcdtravel.com/rennies/do-you-have-the-right-travel-tech/), [FCM HotelHub](https://www.fcmtravel.com/en-za/resources/news-hub/hotelhub-partnership-extension), [Travelit "Is the property GDS bookable?"](https://forms.travel.co.za/TravelIT/)). A voucher confirms arrangements and/or guarantees billing ([BCD glossary](https://www.bcdtravel.com/glossary/voucher/), [City Lodge](https://www.citylodge.co.za/legal-hub/residence)).
- Contradiction check: hotels **without** a GDS/CRS→PMS link key agency bookings by hand ([Reconline/SmartHotel](https://helpguide.smarthotel.nl/en/gds-after-live-the-gds-connector-explained-in-5-steps), [SiteMinder Lagoon Beach case](https://www.siteminder.com/case-studies/lagoon-beach-hotel-sees-100-growth-in-online-bookings-with-siteminder-technology/)). Centurion has the SynXis→Infor link (§2), so that case applies only to vouchers whose booking never came through it.

## 4. Gaps

- 10/15 vouchers had no reference matched to earlier mail; some could be email-only bookings that staff do key in. A read-only HMS find per voucher would settle it; the pane's existing Find covers that case (no match → staff create).
- Whether the Rennies supplier confirmation equals the Infor confirmation number was not checked in HMS.
- Background HMS prefetch skips `system_notice` (`hms-jobs.ts` ~2052). Pre-running Find for vouchers is a separate follow-up.

## 5. Second pass: match by guest surname (counts only)

Surname from the subject, searched in SynXis/Profitroom mail (−10 days to +1 day) and hotel staff mail (−10 to +3 days). Of the 10 vouchers with no matched reference, 6 have the same guest in CRS or staff mail. **4/15 have no trace**: CRC (no name in subject), Rennies Oct 19 12:55, Travelit Oct 19 14:05 and 14:36 (subject names the company, not the guest). Staff mail after the voucher may be staff creating the booking, so the staff column is weaker evidence than the CRS column.

## 6. Da Vinci keyframes (interview 2026-10-14, 04:55–07:03)

`keyframes/crop_0076`, `crop_0079`, `crop_0080`: Ayanda's inbox interleaves **"SynXis Res Confirmed (5943SH…)"** mails (Source of Res **GDS:Sabre**, rate "Goldfields – 2nd Tier Corporate Rate") with **"Rennies BCD Travel Goldfields — Travel voucher for [traveller]"** mails (PDF, body: Customer = Goldfields Group Services, traveller, vendor, dossier no.). Same booking arrives twice: once through SynXis into Infor, once as the agent's voucher email.

Her workflow (transcript 05:06–06:56), every GDS booking:
1. Check it downloaded into Infor; if not, push it from Profitroom.
2. Add the **company name** (the download omits it; they use it to track which companies book).
3. Read the booking notes (e.g. "late arrival" = arrives next day).
4. Voucher present → attach it to the booking. No voucher and arriving today → email the agent for prepayment.
Credit cards from agents go to a POPIA shared folder, never onto the booking.

Product implication (future workflow, not built): "GDS booking check" = match voucher ↔ SynXis booking ↔ Infor stay, fill company from the voucher's Customer line, flag no-voucher same-day arrivals.
