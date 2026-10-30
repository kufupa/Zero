// Read Guest Details from the already-open Guest Stay record, without editing it.
import { dismissNotesOrThrow, installStay360NotesHandler, takeHandledNotes } from './stay360-notes.mjs';
import { installReadOnlyGuard } from './hms-read-only-guard.mjs';

export async function readGuestDetailsFromStay360(page, confirmation) {
  const wanted = typeof confirmation === 'string' ? confirmation.trim() : '';
  if (!wanted) throw new Error('INVALID_CONFIRMATION');
  await installReadOnlyGuard(page.context());
  await installStay360NotesHandler(page);

  const headers = page.locator('h1.recordcode:visible');
  if (await headers.count() !== 1 || (await headers.innerText()).trim() !== wanted) {
    throw new Error('CONFIRMATION_HEADER_MISMATCH');
  }
  const notes = await dismissNotesOrThrow(page, { allowRecordFrame: true });
  const frames = page.locator('.x-window:visible:not(.x-menu) iframe:visible');
  if (await frames.count() !== 1) throw new Error('RECORD_FRAME_NOT_UNIQUE');
  const handle = await frames.elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('RECORD_FRAME_NOT_LOADED');
  const isRecordFrame = await frames.evaluate((element) => {
    const url = new URL(element.src, location.href);
    return url.origin === location.origin && url.searchParams.get('initpath') === 'OSRESV';
  });
  if (!isRecordFrame) throw new Error('RECORD_FRAME_MISMATCH');
  notes.push(...await dismissNotesOrThrow(frame));

  const recordTab = frame.locator('.x-tab-active:visible').filter({ hasText: /^Record View$/ });
  const recordConfirmation = frame.locator('input[name="confirmationnumber"]:visible');
  if (await recordTab.count() !== 1 || await recordConfirmation.count() !== 1 ||
      (await recordConfirmation.inputValue()).trim() !== wanted) {
    throw new Error('RECORD_CONFIRMATION_MISMATCH');
  }
  const guestTab = frame.locator('.x-tab:visible').filter({ hasText: /^Guest Details$/ });
  if (await guestTab.count() !== 1) throw new Error('GUEST_DETAILS_TAB_NOT_UNIQUE');
  await guestTab.click();

  const deadline = Date.now() + 30_000;
  let readySince = null;
  while (Date.now() < deadline) {
    const newNotes = [
      ...await dismissNotesOrThrow(page, { allowRecordFrame: true }),
      ...await dismissNotesOrThrow(frame),
    ];
    notes.push(...newNotes);
    const ready = await frame.evaluate(() => {
      const shown = (element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      return [...document.querySelectorAll('.x-tab-active')].some((tab) => shown(tab) && tab.innerText.trim() === 'Guest Details') &&
        [...document.querySelectorAll('.x-panel-header-text')].some((title) => shown(title) && title.innerText.trim() === 'Guest Details') &&
        ![...document.querySelectorAll('.x-mask, .x-mask-msg, .x-loadmask')].some(shown);
    });
    if (ready && !newNotes.length) {
      readySince ??= Date.now();
      if (Date.now() - readySince >= 300) break;
    } else {
      readySince = null;
    }
    await page.waitForTimeout(100);
  }
  if (!readySince || Date.now() - readySince < 300) throw new Error('GUEST_DETAILS_NOT_LOADED');

  // Only panel expand tools and scrolling are used; never operate form controls.
  const collapsed = frame.locator('.x-panel.x-panel-collapsed:visible');
  for (let count = 0; await collapsed.count(); count += 1) {
    if (count >= 20) throw new Error('GUEST_DETAILS_PANELS_NOT_EXPANDED');
    const expand = collapsed.first().locator(':scope > .x-panel-header .x-tool').filter({
      has: frame.locator('img[class*="x-tool-expand-"]'),
    });
    if (await expand.count() !== 1) throw new Error('GUEST_DETAILS_EXPAND_NOT_UNIQUE');
    await expand.click();
    await page.waitForTimeout(150);
    notes.push(...await dismissNotesOrThrow(page, { allowRecordFrame: true }));
    notes.push(...await dismissNotesOrThrow(frame));
  }

  const scrollables = frame.locator('.x-panel-body:visible');
  for (let index = 0, count = await scrollables.count(); index < count; index += 1) {
    const scroller = scrollables.nth(index);
    const canScroll = await scroller.evaluate((element) => {
      const style = getComputedStyle(element);
      return !element.closest('.x-grid') && /auto|scroll/.test(style.overflowY) &&
        element.clientHeight > 0 && element.scrollHeight > element.clientHeight;
    });
    if (!canScroll) continue;
    await scroller.evaluate((element) => { element.scrollTop = 0; });
    for (let step = 0; ; step += 1) {
      if (step >= 200) throw new Error('GUEST_DETAILS_SCROLL_INCOMPLETE');
      const atEnd = await scroller.evaluate((element) => {
        if (element.scrollTop + element.clientHeight >= element.scrollHeight - 1) return true;
        element.scrollTop += Math.max(1, Math.floor(element.clientHeight * 0.8));
        return false;
      });
      if (atEnd) break;
      await page.waitForTimeout(50);
    }
  }

  notes.push(...await dismissNotesOrThrow(page, { allowRecordFrame: true }));
  notes.push(...await dismissNotesOrThrow(frame));
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
      .map((element) => {
        let item = element.closest('.x-form-item');
        let label = '';
        while (item && !label) {
          const ownLabel = [...item.querySelectorAll('.x-form-item-label, label')]
            .find((candidate) => candidate.closest('.x-form-item') === item && shown(candidate));
          label = normalize(ownLabel?.innerText);
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
        const title = panel && [...panel.querySelectorAll('.x-panel-header-text')]
          .find((candidate) => candidate.closest('.x-panel') === panel && shown(candidate));
        return {
          section: normalize(title?.innerText) || null,
          label: label || element.getAttribute('aria-label') || element.name || null,
          name: element.name || null,
          type,
          value,
        };
      });
    const grids = [...document.querySelectorAll('.x-grid')].filter(shown)
      .filter((grid, _, all) => !all.some((outer) => outer !== grid && outer.contains(grid)));
    const gridContents = grids.map((grid) => ({
      columns: [...grid.querySelectorAll('.x-column-header-text')].filter(shown)
        .map((header) => normalize(header.innerText)),
      rows: [...grid.querySelectorAll('.x-grid-row')].filter(shown).map((row) =>
        [...row.querySelectorAll('.x-grid-cell')].filter((cell) => cell.closest('.x-grid-row') === row && shown(cell))
          .map((cell) => (cell.innerText || '').trim())),
    }));
    return {
      activeTab: [...document.querySelectorAll('.x-tab-active')].find(shown)?.innerText.trim() || null,
      fields,
      visibleText: document.body.innerText.trim(),
      grids: grids.map((grid) => grid.innerText.trim()),
      gridContents,
      captureScope: 'Rendered Guest Details, including expanded form sections, off-screen rendered fields and current grid content; other tabs, hidden content and unloaded grid pages excluded.',
    };
  });
  if (details.activeTab !== 'Guest Details') throw new Error('GUEST_DETAILS_NOT_LOADED');
  notes.push(...await takeHandledNotes(page));
  return { notes, details };
}


/*
1c return (reader): { notes, details }. notes[] has title, text, fields
  and privateCapture. details: { activeTab, fields, visibleText, grids,
  gridContents, captureScope }. fields[]: { section, label, name, type,
  value }; gridContents[]: { columns, rows }.

Partial observed field inventory from 892 HRCEN reads (2026-10-29/30), including blank
rendered controls. The guest row was not selected; hidden content and
unloaded grid pages are excluded. This is not a write schema.
Below: label [DOM name; type if not text]; no name means name is null.

No section:
  dataspylist [dataspylist] | ff_arrivaltimenew [ff_arrivaltimenew]
  ff_arrivaltype_display [ff_arrivaltype_display] | ff_departuretimenew [ff_departuretimenew]
  ff_departuretype_display [ff_departuretype_display] | ff_firstname [ff_firstname] | ff_lastname [ff_lastname]
  filterfields [filterfields] | selfiltervaluectrl [selfiltervaluectrl]
  Show Filter Row: [showfilter; checkbox]

Guest Details:
  Add/Update Profile: [addupdateprofile; checkbox] | Address Type: [addresstype]
  Address: [streetaddress; textarea] | Birth City: [birthcity] | City: [city]
  Control Segment: [controlsegment] | Country of Residence: [countryofresidencedesc] | Country: [countrydesc]
  Date of Birth: [dateofbirth] | Email Address: [emailaddress]
  Email Marketing Opt In: [emailmarketingoptin; checkbox] | Email Type: [emailtype] | First Name: [firstname]
  Guest Category: [guestcategory] | Guest Nationality: [nationality]
  Guest Relationship: [guestrelationshipdesc] | ID Expiration Date : [idexpirationdate] | ID Number: [idnumber]
  Last Name: [lastname] | Mobile Number: [mobilenumber] | No Post: [nopost; checkbox]
  Passport Expiration Date: [passportexpirationdate] | Passport Issued Date: [passportissueddate]
  Passport Name: [passportname] | Passport Nationality: [passportnationalitydesc]
  Passport Number: [passportnumber] | Passport Type: [passporttype] | Phone Number: [phonenumber]
  Phone Type: [phonetype] | Postal Code: [postalcode] | Primary Guest: [primaryguest; checkbox]
  Profile ID: [guestid] | Reason for Stay: [reasonforstay] | State/Province: [statedesc] | Title: [prefix]
  VIP Level: [viplevel]

*/
