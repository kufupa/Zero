// Open the selected Stay 360 record and read its Record View in the same page.
import { dismissNotesOrThrow, installStay360NotesHandler, takeHandledNotes } from './stay360-notes.mjs';
import { installReadOnlyGuard } from './hms-read-only-guard.mjs';

export async function readRecordViewFromStay360(page, confirmation) {
  const wanted = typeof confirmation === 'string' ? confirmation.trim() : '';
  if (!wanted) throw new Error('INVALID_CONFIRMATION');
  await installReadOnlyGuard(page.context());
  await installStay360NotesHandler(page);
  const headers = page.locator('h1.recordcode:visible');
  if (await headers.count() !== 1 || (await headers.innerText()).trim() !== wanted) {
    throw new Error('CONFIRMATION_HEADER_MISMATCH');
  }

  const notes = await dismissNotesOrThrow(page);
  const stay = page.locator('.gs-panel:visible').filter({
    has: page.locator('.x-panel-header-text').filter({ hasText: /^Stay$/ }),
  });
  const button = stay.locator('a.gs-header-btn:visible').filter({ has: page.locator('.gs-stay-icon') });
  if (await stay.count() !== 1 || await button.count() !== 1) throw new Error('STAY_BUTTON_NOT_UNIQUE');
  await button.click();

  const deadline = Date.now() + 30_000;
  let frame;
  while (Date.now() < deadline) {
    notes.push(...await dismissNotesOrThrow(page, { allowRecordFrame: true }));
    const frames = page.locator('.x-window:visible:not(.x-menu) iframe:visible');
    if (await frames.count() > 1) throw new Error('RECORD_FRAME_NOT_UNIQUE');
    if (await frames.count() === 1) {
      const handle = await frames.elementHandle();
      frame = await handle?.contentFrame();
      if (frame) {
        notes.push(...await dismissNotesOrThrow(frame));
        const state = await frame.evaluate(() => {
          const visible = (element) => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          };
          const active = [...document.querySelectorAll('.x-tab-active')]
            .some((tab) => visible(tab) && tab.innerText.trim() === 'Record View');
          const confirmation = [...document.querySelectorAll('input[name="confirmationnumber"]')]
            .filter(visible).map((input) => input.value.trim());
          const status = [...document.querySelectorAll('input[name="status"]')]
            .some((input) => visible(input) && input.value.trim());
          const masked = [...document.querySelectorAll('.x-mask, .x-mask-msg, .x-loadmask')].some(visible);
          return { active, confirmation, status, masked };
        }).catch(() => null); // A newly opened frame can still be navigating.
        if (state?.confirmation.length > 1) throw new Error('RECORD_CONFIRMATION_NOT_UNIQUE');
        if (state?.confirmation[0] && state.confirmation[0] !== wanted) throw new Error('RECORD_CONFIRMATION_MISMATCH');
        if (state?.active && state.confirmation[0] === wanted && state.status && !state.masked) break;
      }
    }
    frame = null;
    await page.waitForTimeout(100);
  }
  if (!frame) throw new Error('RECORD_VIEW_NOT_LOADED');

  // Expand only the form's collapsed panels, using their expand icons.
  const collapsed = frame.locator('.x-panel.x-panel-collapsed:visible');
  for (let count = 0; await collapsed.count(); count += 1) {
    if (count >= 20) throw new Error('RECORD_PANELS_NOT_EXPANDED');
    const panel = collapsed.first();
    const expand = panel.locator(':scope > .x-panel-header .x-tool').filter({
      has: frame.locator('img[class*="x-tool-expand-"]'),
    });
    if (await expand.count() !== 1) throw new Error('RECORD_EXPAND_NOT_UNIQUE');
    await expand.click();
    await page.waitForTimeout(150);
    notes.push(...await dismissNotesOrThrow(page, { allowRecordFrame: true }));
    notes.push(...await dismissNotesOrThrow(frame));
  }

  const details = await frame.evaluate(() => {
    const shown = (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const normalize = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
    const fields = [...document.querySelectorAll('input, textarea, select, [contenteditable="true"], .x-form-display-field')]
      .filter(shown)
      .filter((element) => !['hidden', 'password'].includes(element.type))
      .filter((element) => element.type !== 'button' || ['checkbox', 'radio'].includes(element.getAttribute('role')))
      .filter((element) => !element.closest('.x-grid'))
      .map((element) => {
        let item = element.closest('.x-form-item');
        let label = '';
        while (item && !label) {
          label = normalize(item.querySelector('.x-form-item-label, label')?.innerText);
          item = item.parentElement?.closest('.x-form-item');
        }
        const role = element.getAttribute('role');
        const type = ['checkbox', 'radio'].includes(role) ? role : (element.type || element.tagName.toLowerCase());
        let value;
        if (type === 'checkbox' || type === 'radio') {
          const aria = element.getAttribute('aria-checked');
          value = aria === 'true' || (aria !== 'false' && (element.checked ||
            Boolean(element.closest('.x-form-cb-checked, .x-form-checkbox-checked')))) || false;
        } else if (element.tagName === 'SELECT') {
          value = [...element.selectedOptions].map((option) => normalize(option.textContent)).join(', ');
        } else {
          value = String(element.value ?? element.innerText ?? element.textContent ?? '').trim();
        }
        const panel = element.closest('.x-panel');
        return {
          section: normalize(panel?.querySelector('.x-panel-header-text')?.innerText) || null,
          label: label || element.getAttribute('aria-label') || element.name || null,
          name: element.name || null,
          type,
          value,
        };
      });
    const grids = [...document.querySelectorAll('.x-grid')].filter(shown)
      .filter((grid, _, all) => !all.some((outer) => outer !== grid && outer.contains(grid)))
      .map((grid) => grid.innerText.trim());
    const confirmationFields = [...document.querySelectorAll('input[name="confirmationnumber"]')].filter(shown);
    return {
      confirmationInRecord: confirmationFields.length === 1 ? confirmationFields[0].value.trim() : null,
      activeTab: [...document.querySelectorAll('.x-tab-active')].find(shown)?.innerText.trim() || null,
      fields,
      visibleText: document.body.innerText.trim(),
      grids,
      captureScope: 'Rendered Record View, including expanded form sections, off-screen rendered fields and current grid pages; other tabs, hidden content and unloaded grid pages excluded.',
    };
  });
  notes.push(...await dismissNotesOrThrow(page, { allowRecordFrame: true }));
  notes.push(...await dismissNotesOrThrow(frame));
  if (details.confirmationInRecord !== wanted || details.activeTab !== 'Record View') {
    throw new Error('RECORD_CONFIRMATION_MISMATCH');
  }
  notes.push(...await takeHandledNotes(page));
  return { notes, details };
}

/*
1b return (reader): { notes, details }. notes[] has title, text, fields
  and privateCapture. details: { confirmationInRecord, activeTab, fields,
  visibleText, grids, captureScope }. fields[]: { section, label, name,
  type, value }; grids[] contains rendered grid text.
The CLI returns { ok, confirmation, stay360, recordView, elapsedMs }.

Observed field inventory from 892 HRCEN reads (2026-10-29/30), including blank
rendered controls. Other tabs, hidden content and unloaded grid pages are
excluded. These are observations, not proof of writable fields.
Below: label [DOM name; type if not text].

No section:
  Balance: [balance] | Balance: [balancecurr] | Booking Agency Contract: [bacontract]
  CMS Booker Email: [udfchar13] | CMS Form Status: [udfchar07] | CMS Message Id: [udfchar09]
  CMS Send Mail: [udfchkbox04; checkbox] | Confirmation Number: [confirmationnumber]
  Deposit Due Amount Required: [udfchar02] | Deposit Due Date.: [udfdate02]
  Deposit Received: [depositreceived] | Deposit Received: [depositreceivedcurrency]
  External Reference 1: [externalreference1] | Group: [groupname] | Last Checkout Date : [lastcheckoutdate]
  Last Property: [lastproperty] | Last Room Occupied: [lastroomoccupied] | Legacy Lifestyle Update: [facebookid]
  Lifetime Nights: [nightsvalue] | Lifetime Revenue: [revenuedesc] | Lifetime Revenue: [revenuevalue]
  Lifetime Stays: [lifetimestays] | Loyalty Number: [playernumber] | Loyalty Points Balance: [twitterid]
  New / Existing Member: [bookingdotcomid] | Status: [status] | Wi-Fi Voucher: [udfchar10]
  WIFI Status: [udfchar11]

Stay:
  A/R Account: [araccountname] | Add-On Total: [enhancedexptotal] | Add-On Total: [enhancedexptotalcurr]
  Adults: [adults] | Arrival Date: [arrivaldate] | Arrival Date: [arrivaldayofweek]
  Average Rate: [averagerate] | Average Rate: [averageratecurr] | Billing Reference: [billingreference]
  Booker Contact: [udfchar06] | Booker Name: [caller] | Child 0 - 02: [child1] | Child 03 - 12: [child2]
  Child 13 - 17: [child3] | Children: [children] | Commission Percent: [ta1commission]
  Confidential Rate: [confidentialratecb; checkbox] | Departure Date: [departuredate]
  Departure Date: [departuredayofweek] | Do Not Move Reason: [donotmovereason]
  Do Not Move: [donotmove; checkbox] | Grand Total: [grandtotal] | Grand Total: [grandtotalcurr]
  Guarantee Type: [guaranteetype] | Ignore All Restrictions: [ignoreallrestrictions; checkbox]
  Market Segment: [marketsegment] | Meal Plan: [mealplan] | Nights: [nights] | Organization: [company]
  Primary Booking Agency: [ta1] | Promotion: [promotioncode] | Rate Plan: [rateplan]
  Reason for Stay: [reasonforstay] | Reservation Note / Billing Instructions: [reservationnote; textarea]
  Resort Fee: [resortfee] | Resort Fee: [totalresortfee] | Room Type for Charge: [roomtypecharge]
  Room Type: [roomtype] | Room: [room] | Scheduled Room: [scheduledroom]
  Source Of Business: [sourceofbusinessdesc] | Total Rate: [totalrate] | Total Rate: [totalratecurr]
  Track / Sub Segment: [track] | Waitlist Priority: [waitlistpriority] | Walk In: [iswalkin; checkbox]

Guest:
  Address Type: [addresstypecode] | Address: [address; textarea] | Auto Email Folio: [autoemailfolio; checkbox]
  City: [city] | Cleaning Time: [cleaningtime] | Country of Residence: [countryofresidencedesc]
  Country: [countrydesc] | Date of Birth: [dateofbirth] | E-mail Address: [emailaddress]
  E-mail Type: [emailtypecode] | First Name: [firstname] | Gender: [gender] | Language: [language]
  Last Name: [lastname] | Legacy Lifestyle Member: [guestoptin3; checkbox]
  Legacy Marketing Opt in: [guestoptin1; checkbox] | Lifestyle Marketing Opt in: [guestoptin2; checkbox]
  Mobile Number: [mobilenumber] | Nationality: [nationalitydesc] | Passport Scan Date: [passportscanneddate]
  Phone Number: [phonenumber] | Phone Type: [phonetypecode] | Postal Code: [postalcode] | Profile ID: [guestid]
  Scanned Passport Reference: [scannedpassportref] | State / Province: [statedesc]
  Terms and Conditions: [guestoptin4; checkbox] | Title: [prefix] | Turndown Time: [turndowntime]
  Vat Id: [taxid] | Vehicle Reg No.: [vehicle] | VIP Level: [viplevel]

Reservation:
  Cancellation Date: [canceldate] | Cancellation Note: [cancellationnote; textarea]
  Cancellation Number: [cancelnumber] | Cancellation Reason: [cancelreasondesc]
  External Cancellation Number: [thirdpartycancellationnumber] | Reservation Date: [reservationdate]

Settlement:
  No Post: [nopost; checkbox] | Settlement Type: [settlementtype]

Record Details:
  Created By: [createdby] | Created On: [created] | Updated By: [updatedby] | Updated On: [updated]
*/
