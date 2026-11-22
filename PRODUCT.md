# PRODUCT.md — Nava reservationist (Centurion)

The owner's latest message wins over this file. Staff-facing name: **Nava**; never show the model name to staff.

Nava is an AI reservationist for Legacy Hotels Centurion (HRCEN; Da Vinci later). Staff stay in classic Outlook: a VSTO pane (`apps/mail` `/outlook-pane`), with the same `NavaPane` in nava-admin webmail. Nava reads the selected email, prefills, and runs deterministic Infor HMS Cloud tools. HMS is the system of record; staff approve every write. Never make staff run scripts or see raw technical errors.

**Every write workflow:** Nava prefills from the email → staff can edit every field → **Prepare** stages it in HMS unsaved and shows HMS's result (price, policy) → staff **Go** → Save → fresh readback.

1. **Triage**: classify inbound mail; keep per-stay actions and genuine second asks.
2. **Quote**: contract/BAR rates → cover email + PDF + Excel; fully booked → one-line decline.
3. **Create**: existing or new guest profile; stay, room, rate plan, meal plan, agency/organization, A/R / billing ref, guarantee, note, CMS; HMS prices it before Go; multi-room = sequential creates under one Go.
4. **Amend**: find the confirmation, change what was asked; HMS reprices before Go.
5. **Cancel**: find the confirmation, cancel with a reason; show HMS policy/fee; Nava never posts fees.
6. **Filing**: file the voucher/POP PDF into the stay's Documents; staff can pick the stay.

CMS confirmation is a staff tick box (default on). Nava never sends email itself. HMS supplies rates and availability; Nava prefills deterministically from HMS directories and memory and never invents rate math.

**Front door:** skip mail by **sender domain only** from OTA/channel systems (Booking.com, Expedia, SynXis, Travelit, TBO, Profitroom, WebBeds, Trip.com, Tiket, LekkeSlaap, RateTiger/eRevMax, TvlInc, H-Pay, HotelPlanner…; list lives in code). Never filter on body text. Hotel self-mail "Pre Stay … Confirmation No <conf>" is about an existing booking: never offer Create.

**Writes:** real-guest writes only on staff Go; agents never press Go on a real guest. HMS reads, unsaved staging and Labtest writes (Proof Labtest guest, 2027+ stays, CMS off) are always allowed. Uncertain Save: never blind-retry; re-read HMS first.

**Done:** staff can run all six workflows from the pane on deployed main, measured by the scoreboard (real emails replayed through the pane API path: e2e completion, field accuracy vs what staff did in HMS). How to work lives in `AGENTS.md`.
