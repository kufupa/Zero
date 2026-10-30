# Unsaved Guest Stay controls

`guest-stay-form.mjs` acts on a caller-owned, authenticated page with a **blank
confirmation**. Install the existing read-only guard before opening Guest Stay;
`withBookingLookupSession` already does this. Pass the expected `propertyCode`
to every call and serialize all actions on the page. The live checks used
HRCEN at `https://hmsweb.hms.eu1.inforcloudsuite.com`. Other properties,
configurations and origins are unverified; other origins are rejected.

The live draft covered both dates, adults, reason for stay, first and last name,
child ages, CMS recipient, CMS message ID, and the send checkbox. Other listed
text fields and guarantee type were observed on the form but not individually
exercised. The child-age editor is an `.x-window.x-menu` on this property.

| Function | Explicit input |
| --- | --- |
| `readGuestStayForm` | `propertyCode` |
| `setGuestStayDate` | `field`: `arrivalDate` or `departureDate`; `date`: `YYYY-MM-DD` |
| `setGuestStayText` | `field`: `firstName`, `lastName`, `bookerName`, `bookerContact`, `reservationNote`, `guestEmail`, or `cmsRecipient`; `value`: string |
| `listGuestStayDropdown` | `field`: `adults`, `reasonForStay`, or `guaranteeType` |
| `selectGuestStayDropdown` | Same `field` and an explicit current option `value`; adults must be an integer |
| `setGuestStayChildAges` | `childAges`: explicit array of integer ages 0–17; `[]` explicitly clears children |
| `listCmsMessageIds` | `propertyCode`; leaves the current CMS picker open |
| `selectCmsMessageId` | `searchId` and an explicit `code` from that picker on the same page |
| `closeCmsMessageIdPicker` | `propertyCode`; close the current CMS picker without choosing a code |
| `setCmsSendCheckbox` | `checked`: explicit boolean |

All inputs are objects passed after `page`. For example:

```js
import { withBookingLookupSession } from './booking-lookup-session.mjs';
import { setGuestStayDate, setGuestStayChildAges } from './guest-stay-form.mjs';

await withBookingLookupSession(async ({ page }) => {
  const propertyCode = 'HRCEN';
  const arrival = await setGuestStayDate(page, { propertyCode, field: 'arrivalDate', date: '2027-09-14' });
  if (arrival.outcome !== 'updated_unsaved') return arrival;
  const departure = await setGuestStayDate(page, { propertyCode, field: 'departureDate', date: '2027-09-16' });
  if (departure.outcome !== 'updated_unsaved') return departure;
  return setGuestStayChildAges(page, { propertyCode, childAges: [8] });
}, { memory: null });
```

Each action checks origin, property and blank confirmation, reads back the form
and returns observed `changedFields`. Arrival changed departure and day-of-week on
the observed screen, so check the returned changes and set departure explicitly.
Names are individual text fields; room quantity is a separate fact and is not
inferred here. Guest email and CMS recipient are separate fields.

The child-age editor validates actual numbers with HMS and returns those
numbers plus the visible age-band counts. An omitted list, `null`, and unknown
ages are rejected; zero is accepted only when explicitly supplied. The blank
initial spinner is interpreted as zero only when HMS returned an explicit empty
age list. HMS can omit zero bands or the entire count object for an empty
selection; returned band counts come from the visible form. The native count
object and its presence are returned separately. A Guest Stay age selection
does not apply criteria to Hotel Availability; set and verify that screen separately.

Dropdowns and CMS codes come from current UI stores, not historical choices.
Option coverage is unknown when HMS does not supply a reliable total. CMS
selection checks the picker, search ID, grid and code again before clicking.
Callers choose the code; this module does not infer one.
Closing the CMS picker verifies the unsaved form remained unchanged; an
`action_uncertain` result means the close may have happened without verified
readback. Unexpected dialogs are left untouched.

Results use `ok`, `updated_unsaved`, `input_gap`, `unsupported`,
`execution_failure`, or `action_uncertain`. An uncertain action may have
changed the form: read it before retrying. Unexpected requests are blocked and
unexpected dialogs are left untouched. During each action an additional route
permits only query-free blank-stay age reads/validation and CMS lookup POSTs;
age requests must also include `ONLY_DATA_REQUIRED=true`. The existing read-only
guard must remain installed throughout the session.
These actions do not save or send. A checked CMS box can affect a later save,
so treat it as draft state. Form fields, picker results and readbacks can contain
private data and must remain in approved private storage.
