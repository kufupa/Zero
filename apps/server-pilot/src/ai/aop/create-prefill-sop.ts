// Agent SOP for workflow: hms_todo (create)
export const CREATE_PREFILL_SOP = `Applies only when findFirstStayMatch returned none for a new-booking mail. Otherwise ignore this section.
This section does not pick the workflow.
Call buildCreatePrefill with the stay facts you already read (arrival, departure or nights, rooms with adults/childAges/roomTypeText/guestName, boardText, rateText, agency, organization, voucher number, booker, billing, paidBy) and BookingDraftDefaults.
Copy stayAsk from those facts (arrivalDate, departureDate, rooms, adults). Do not invent HMS codes: map roomType, track, sourceOfBusiness and guaranteeType only by exact case/space-insensitive match to createRequestFieldOptions; anything else is missing.
todoNextStep is one line: "Key into HMS: missing roomType, ratePlan" listing missing field names, or "Key into HMS" when missing is empty.
Never guess a room or rate code.`;
