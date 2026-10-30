// Read prices and inventory from cloud Hotel Availability on the caller's page.
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';

const busyPages = new WeakSet();
const clean = (value) => String(value ?? '').trim();
const codes = (value) => Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
const sameCodes = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const dayMs = 24 * 60 * 60 * 1000;

function calendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed;
}

function validate(input) {
  const arrival = calendarDay(input?.arrivalDate);
  const departure = calendarDay(input?.departureDate);
  const nights = arrival && departure ? (departure - arrival) / dayMs : 0;
  if (!arrival || !departure || nights < 1) throw new Error('INVALID_DATE_RANGE');
  if (!Number.isInteger(input.adults) || input.adults < 1 || !Array.isArray(input.childAges) ||
      input.childAges.some((age) => !Number.isInteger(age) || age < 0 || age > 99)) {
    throw new Error('OCCUPANCY_REQUIRED');
  }
  if (!clean(input.propertyCode)) throw new Error('PROPERTY_REQUIRED');
  for (const key of ['roomTypes', 'ratePlans']) {
    const value = input[key];
    if (value !== 'all' && (!Array.isArray(value) || !value.length ||
        value.some((code) => typeof code !== 'string' || !clean(code) || /[,\r\n]/.test(clean(code))) ||
        new Set(codes(value)).size !== value.length)) throw new Error('CODES_REQUIRED');
  }
  return { nights };
}

/** Open standalone Hotel Availability from Stay 360, or reuse it when already open. */
export async function openHotelAvailability(page) {
  await installReadOnlyGuard(page.context());
  const title = page.locator('h1.pagetitle:visible').filter({ hasText: /^Hotel Availability$/ });
  if (await title.count() === 1 && await page.locator('input[name="dates"]:visible').count() === 1 &&
      await page.locator('input[name="rateplans"]:visible').count() === 1) return;
  // The Stay 360 bootstrap returns during navigation; wait for it to settle first.
  await page.locator('input[name="search"]:visible').first().waitFor({ timeout: 25000 });
  const node = (name) => page.locator('span.x-tree-node-text:visible')
    .filter({ hasText: new RegExp(`^${name}$`) });
  await page.locator('a.app-menu-trigger:visible').click();
  if (!await node('Availability').isVisible()) {
    await node('Front Desk').click();
    await page.waitForTimeout(900);
  }
  if (!await node('Hotel Availability').isVisible()) await node('Availability').click();
  await page.waitForTimeout(1200);
  await node('Hotel Availability').click();
  await title.waitFor({ timeout: 25000 });
  await page.locator('input[name="dates"]:visible').first().waitFor({ timeout: 25000 });
}

async function openPicker(page, name) {
  const input = page.locator(`input[name="${name}"]:visible`).first();
  await input.locator('xpath=ancestor::table[1]').locator('.x-form-trigger:visible').first().click();
  return input;
}

async function chooseDate(page, iso) {
  const picker = page.locator('.x-daterange:visible').last();
  const title = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'long', day: '2-digit', year: 'numeric',
  }).format(calendarDay(iso));
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const exact = picker.locator(`td.x-datepicker-active[title="${title}"] a`);
    if (await exact.count() === 1) { await exact.click(); return; }
    const calendars = await picker.locator('.x-datepicker:visible').evaluateAll((elements) => elements.map((element) => {
      const anchor = [...element.querySelectorAll('td.x-datepicker-active[title]')]
        .find((cell) => cell.title !== 'Today');
      const date = anchor ? new Date(anchor.title) : null;
      const today = element.querySelector('td.x-datepicker-today');
      return { month: date && !Number.isNaN(date.getTime())
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : null,
      today: today ? Number.parseInt(today.innerText, 10) : null };
    }));
    const index = calendars.findIndex((calendar) => calendar.month === iso.slice(0, 7));
    if (index >= 0) {
      if (calendars[index].today !== Number(iso.slice(8))) throw new Error('DATE_NOT_SELECTABLE');
      await picker.locator('.x-datepicker:visible').nth(index).locator('td.x-datepicker-today a').click();
      return;
    }
    if (!calendars.length || calendars.some((calendar) => !calendar.month)) throw new Error('DATE_PICKER_UNAVAILABLE');
    const direction = iso.slice(0, 7) < calendars[0].month ? 'prev' : 'next';
    await picker.locator(`.x-daterange-${direction}:visible`).click();
    await page.waitForTimeout(100);
  }
  throw new Error('DATE_OUTSIDE_PICKER_RANGE');
}

async function setDates(page, input) {
  await openPicker(page, 'dates');
  await chooseDate(page, input.arrivalDate);
  await chooseDate(page, input.departureDate);
  const picker = page.locator('.x-daterange:visible').last();
  if (await picker.isVisible()) {
    await picker.locator('a.x-btn:visible').filter({ hasText: /^\s*Apply\s*$/ }).click();
  }
}

async function setGuests(page, input) {
  await openPicker(page, 'guests');
  const picker = page.locator('.x-guestpicker:visible').last();
  const adults = picker.locator('input[name="adults"]:visible');
  const children = picker.locator('input[name="children"]:visible');
  await adults.fill(String(input.adults));
  await adults.press('Tab');
  await children.fill(String(input.childAges.length));
  await children.press('Tab');
  const ages = picker.locator('input:visible:not([name="adults"]):not([name="children"])');
  await page.waitForFunction(({ id, count }) => {
    const root = document.getElementById(id);
    return root && [...root.querySelectorAll('input:not([name="adults"]):not([name="children"])')]
      .filter((el) => el.offsetWidth || el.offsetHeight).length === count;
  }, { id: await picker.getAttribute('id'), count: input.childAges.length }, { timeout: 10000 });
  for (const [index, age] of input.childAges.entries()) {
    await ages.nth(index).locator('xpath=ancestor::table[1]').locator('.x-form-trigger:visible').first().click();
    await page.locator('.x-boundlist-item:visible').filter({ hasText: new RegExp(`^\\s*${age}\\s*$`) }).click();
  }
  await picker.locator('a.x-btn:visible').filter({ hasText: /^\s*Apply\s*$/ }).click();
}

async function readCatalog(page, name, propertyCode) {
  await openPicker(page, name);
  const win = page.locator('.x-window:visible:not(.x-menu)').last();
  await win.waitFor({ state: 'visible', timeout: 20000 });
  const state = () => win.evaluate((element) => {
    const store = Ext.getCmp(element.id)?.query('grid,readonlygrid')?.[0]?.getStore?.();
    const match = element.innerText.match(/Records:\s*(\d+)\s+of\s+(\d+)/i);
    return { records: store?.getRange?.().map((record) => ({ ...record.data })) ?? null,
      reportedLoaded: match ? Number(match[1]) : null, reportedTotal: match ? Number(match[2]) : null };
  });
  await page.waitForFunction((id) => Boolean(Ext.getCmp(id)?.query('grid,readonlygrid')?.[0]?.getStore?.()),
    await win.getAttribute('id'), { timeout: 20000 });
  await page.waitForTimeout(700);
  let current = await state();
  for (let pageNumber = 0; current.records && current.reportedTotal > current.records.length && pageNumber < 20; pageNumber += 1) {
    const previous = current.records.length;
    await win.locator('.x-grid-view:visible').last().evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.waitForFunction(({ id, previousCount }) =>
      Ext.getCmp(id)?.query('grid,readonlygrid')?.[0]?.getStore?.()?.getCount?.() > previousCount,
    { id: await win.getAttribute('id'), previousCount: previous }, { timeout: 6000 }).catch(() => {});
    current = await state();
    if (current.records?.length === previous) break;
  }
  const codeField = name === 'roomtypes' ? 'roomtypecode' : 'rateplancode';
  const selectedCodes = (current.records || []).map((row) => clean(row[codeField]));
  const complete = current.reportedTotal !== null && current.reportedTotal === current.records?.length &&
    current.reportedLoaded === current.records?.length;
  if (!complete || !selectedCodes.length || selectedCodes.some((code) => !code || code.includes(',')) ||
      new Set(selectedCodes).size !== selectedCodes.length ||
      current.records.some((row) => clean(row.property).toUpperCase() !== propertyCode.toUpperCase())) {
    throw new Error('CATALOG_INCOMPLETE_OR_AMBIGUOUS');
  }
  await win.locator('a.x-btn:visible').filter({ hasText: /^\s*Cancel\s*$/ }).first().click();
  await win.waitFor({ state: 'hidden', timeout: 10000 });
  return { ...current, complete, codes: selectedCodes };
}

async function setCodes(page, name, selected) {
  const input = page.locator(`input[name="${name}"]:visible`).first();
  await input.fill(selected.join(','));
  await input.press('Tab');
}

function requestMatches(actual, input, selected, nights) {
  return clean(actual.launchedFrom).toLowerCase() === 'hotelavailability' &&
    clean(actual.propertyCodes).toUpperCase() === clean(input.propertyCode).toUpperCase() &&
    clean(actual.startDate).slice(0, 10) === input.arrivalDate && Number(actual.numberOfDays) === nights &&
    Number(actual.adultCount) === input.adults && Number(actual.childCount) === input.childAges.length &&
    JSON.stringify(actual.childAges || []) === JSON.stringify(input.childAges) &&
    sameCodes(clean(actual.roomTypeCodes).split(',').map(clean).filter(Boolean), selected.roomTypes) &&
    sameCodes(clean(actual.ratePlanCodes).split(',').map(clean).filter(Boolean), selected.ratePlans) &&
    !clean(actual.groupID) && !clean(actual.organizationID) && !clean(actual.travelAgencyID);
}

/** Search without saving a booking. `all` loads the picker catalog; arrays request explicit codes. */
export async function searchHotelAvailability(page, input) {
  let validated;
  try { validated = validate(input); }
  catch (error) { return { outcome: 'input_gap', issue: error.message }; }
  if (busyPages.has(page)) return { outcome: 'execution_failure', issue: 'SEARCH_IN_PROGRESS' };
  busyPages.add(page);
  let stage = 'opening_screen';
  try {
    await openHotelAvailability(page);
    const property = await page.locator('input[name="propertycodes"]:visible').first().inputValue();
    if (clean(property).toUpperCase() !== clean(input.propertyCode).toUpperCase()) throw new Error('PROPERTY_MISMATCH');
    stage = 'loading_catalogs';
    const catalogs = {};
    if (input.roomTypes === 'all') catalogs.roomTypes = await readCatalog(page, 'roomtypes', input.propertyCode);
    if (input.ratePlans === 'all') catalogs.ratePlans = await readCatalog(page, 'rateplans', input.propertyCode);
    const selected = {
      roomTypes: catalogs.roomTypes?.codes ?? codes(input.roomTypes),
      ratePlans: catalogs.ratePlans?.codes ?? codes(input.ratePlans),
    };
    stage = 'setting_criteria';
    await setDates(page, input);
    await setGuests(page, input);
    await setCodes(page, 'roomtypes', selected.roomTypes);
    await setCodes(page, 'rateplans', selected.ratePlans);
    stage = 'searching';
    const responsePromise = page.waitForResponse((response) => {
      const request = response.request();
      const url = new URL(response.url());
      return request.method() === 'POST' && url.origin === new URL(page.url()).origin &&
        /\/(?:rateshop|hotelAvail)\/inquiryForGrid$/i.test(url.pathname);
    }, { timeout: 60000 }).catch(() => null);
    await page.locator('a.x-btn:visible').filter({ hasText: /^\s*Search\s*$/ }).first().click();
    const response = await responsePromise;
    if (!response || response.status() !== 200 || await response.finished()) throw new Error('SEARCH_REQUEST_FAILED');
    const applied = JSON.parse(response.request().postData() || '{}');
    if (!requestMatches(applied, input, selected, validated.nights)) throw new Error('SEARCH_CRITERIA_MISMATCH');
    const data = await response.json();
    if (!data?.availabilitydata || !Array.isArray(data.availabilitydata.children) ||
        !Array.isArray(data.availabilitydata.datesList)) throw new Error('SEARCH_RESPONSE_INVALID');
    const { bookingSessionID: _session, ...appliedCriteria } = applied;
    return { outcome: 'ok', snapshot: { observedAt: new Date().toISOString(),
      requestedCriteria: input, appliedCriteria, catalogs, response: data } };
  } catch (error) {
    const message = String(error?.message || error).split('\n')[0];
    return { outcome: 'execution_failure', stage,
      issue: /^[A-Z][A-Z0-9_]{2,100}$/.test(message) ? message : 'HOTEL_AVAILABILITY_FAILED' };
  } finally {
    busyPages.delete(page);
  }
}

/** Return a smaller view while keeping the full snapshot available to the caller. */
export function filterHotelAvailability(snapshot, { roomTypes, ratePlans } = {}) {
  if ((roomTypes != null && !Array.isArray(roomTypes)) || (ratePlans != null && !Array.isArray(ratePlans))) {
    throw new TypeError('Filter roomTypes and ratePlans must be arrays.');
  }
  const roomSet = roomTypes && new Set(codes(roomTypes));
  const rateSet = ratePlans && new Set(codes(ratePlans));
  const original = snapshot.response.availabilitydata;
  const children = original.children.map((property) => {
    if (!property.isprop || property.issummary || !Array.isArray(property.children)) return property;
    return { ...property, children: property.children.filter((room) => !roomSet || roomSet.has(room.code))
      .map((room) => ({ ...room, children: (room.children || []).filter((rate) => !rateSet || rateSet.has(rate.code)) })) };
  });
  return { observedAt: snapshot.observedAt, requestedCriteria: snapshot.requestedCriteria,
    appliedCriteria: snapshot.appliedCriteria, filters: { roomTypes: roomTypes ?? null, ratePlans: ratePlans ?? null },
    availability: { ...original, children } };
}
