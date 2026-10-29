import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as quote from './fetch-quote.mjs';
import { multipleSource } from './fetch-quote-fixtures.mjs';

const origin = 'https://hms.example.test';
const oldPath = '/api/internalBooking/hotelAvail/inquiryForGrid';
const cloudPath = '/api/internalBooking/rateshop/inquiryForGrid';
const request = {
  propertyCode: 'HRCEN', arrivalDate: '2026-09-24', departureDate: '2026-09-27',
  rooms: [{ quantity: 2, adults: 1, children: 0, childAges: [] }],
};
const dateParts = (date) => [date.getFullYear(), date.getMonth() + 1, date.getDate()];

// A small page model: selectors apply visibility, and Ext callbacks run as the driver supplies them.
function availabilityPage({ oldVisible = false, cloudVisible = false, currentRange, endpoint = oldPath,
  fixture = multipleSource(), criteriaOverride = {} } = {}) {
  const actions = [];
  const fields = Object.fromEntries([
    'startdate', 'dates', 'groupname', 'organization', 'travelagency', 'roomtypes', 'rateplans',
    'currency', 'salesstrategy', 'convertcurrency', 'includemultirateoptions', 'guests', 'adults', 'children', 'propertycodes',
  ].map((name) => [name, { name, id: `cmp-${name}-inputEl`, visible: true, value: '' }]));
  fields.startdate.visible = oldVisible;
  fields.dates.visible = cloudVisible;
  fields.dates.value = currentRange === undefined
    ? { startDate: new Date(2026, 0, 1), endDate: new Date(2026, 0, 15) }
    : currentRange;
  fields.salesstrategy.value = 'BAR';
  fields.convertcurrency.value = false;
  fields.includemultirateoptions.value = false;
  fields.propertycodes.value = request.propertyCode;

  const ext = { getCmp(id) {
    const field = Object.values(fields).find((item) => item.id.replace(/-inputEl$/, '') === id);
    assert.ok(field, `unknown component ${id}`);
    return {
      getValue: () => field.value,
      setValue: (value) => { field.value = value; actions.push(['setValue', field.name]); },
      getStore: () => ({ getRange: () => [{ data: { value: 'BAR', display: 'BAR' } }] }),
    };
  } };
  const input = (name, visibleOnly) => {
    const matches = fields[name] && (!visibleOnly || fields[name].visible) ? [fields[name]] : [];
    const single = () => {
      if (matches.length !== 1 || !matches[0].visible) throw new Error(`visible field unavailable: ${name}`);
      return matches[0];
    };
    return {
      count: async () => matches.length,
      isVisible: async () => matches.length === 1 && matches[0].visible,
      inputValue: async () => single().value,
      fill: async (value) => { single().value = value; actions.push(['fill', name, value]); },
      press: async (key) => { single(); actions.push(['press', name, key]); },
      click: async () => {
        const field = single();
        if (typeof field.value === 'boolean') field.value = !field.value;
        actions.push(['click', name]);
      },
      locator: () => ({ locator: () => ({ click: async () => { single(); } }) }),
      evaluate: async (fn, value) => vm.runInNewContext(`(${fn.toString()})(element, value)`,
        { element: single(), value, Ext: ext, Date }),
    };
  };
  const response = (url, method, marker) => ({
    url: () => url,
    request: () => ({
      method: () => method,
      postDataJSON: () => ({
        propertyCodes: fields.propertycodes.value, startDate: `${request.arrivalDate}T00:00:00`,
        adultCount: Number(fields.adults.value), childCount: Number(fields.children.value), childAges: [],
        salesStrategy: fields.salesstrategy.value, lengthOfStay: 'DY', shopByDay: false,
        roomTypeCodes: fields.roomtypes.value, ratePlanCodes: fields.rateplans.value,
        groupID: '', organizationID: '', travelAgencyID: '', currency: null,
        convertFromPropertyCurrency: fields.convertcurrency.value,
        showRestrictedSellOptions: fields.includemultirateoptions.value,
        bookingSessionID: 'private-token', ...criteriaOverride,
      }),
    }),
    ok: () => true,
    json: async () => ({ availabilitydata: { ...fixture.data, marker } }),
  });
  const page = {
    url: () => `${origin}/app`,
    locator(selector) {
      if (selector === 'input[role="combobox"][name^="uxcombobox-"]:visible' || selector === 'input[type="password"]:visible')
        return { count: async () => 0 };
      if (selector === 'a[id$="-applyBtn"]:visible') return { click: async () => { actions.push(['applyGuests']); } };
      if (selector === 'a.x-btn:visible') return { filter: () => ({ click: async () => { actions.push(['search']); } }) };
      const match = /^input\[name="([^"]+)"\](:visible)?$/.exec(selector);
      if (match) return input(match[1], Boolean(match[2]));
      throw new Error(`unexpected selector: ${selector}`);
    },
    getByText: () => ({ isVisible: async () => false }),
    getByRole: (role, { name }) => ({ click: async () => {
      assert.equal(role, 'option');
      fields.salesstrategy.value = name;
    } }),
    waitForResponse: async (predicate) => {
      const candidates = [
        response(`https://other.example.test${endpoint}`, 'POST', 'wrong-origin'),
        response(`${origin}${endpoint}/save`, 'POST', 'wrong-path'),
        response(`${origin}${endpoint}`, 'PUT', 'wrong-method'),
        response(`${origin}${endpoint}?page=1`, 'POST', 'accepted'),
      ];
      const selected = candidates.find(predicate);
      if (!selected) throw new Error('expected inquiry response not matched');
      return selected;
    },
    waitForFunction: async () => {},
    evaluate: async () => structuredClone(fixture.calendar),
    keyboard: { press: async () => {} },
  };
  return { page, fields, actions };
}

test('arrival date uses the visible older control and tabs to apply it', async () => {
  const { page, fields, actions } = availabilityPage({ oldVisible: true });
  await quote.setArrivalDate(page, '2026-09-24');
  assert.equal(fields.startdate.value, '24-SEP-2026');
  assert.deepEqual(actions, [['fill', 'startdate', '24-SEP-2026'], ['press', 'startdate', 'Tab']]);
});

test('visible cloud range wins over a hidden old input and preserves the calendar span', async () => {
  const currentRange = { startDate: new Date(2026, 9, 25), endDate: new Date(2026, 10, 8) };
  const { page, fields, actions } = availabilityPage({ cloudVisible: true, currentRange });
  await quote.setArrivalDate(page, '2026-12-27');
  assert.equal(fields.startdate.value, '');
  assert.deepEqual(dateParts(fields.dates.value.startDate), [2026, 12, 27]);
  assert.deepEqual(dateParts(fields.dates.value.endDate), [2027, 1, 10]);
  assert.deepEqual(actions, [['setValue', 'dates'], ['press', 'dates', 'Tab']]);
});

test('cloud range defaults to 14 days when there is no current range', async () => {
  const { page, fields } = availabilityPage({ cloudVisible: true, currentRange: null });
  await quote.setArrivalDate(page, '2027-02-22');
  assert.deepEqual(dateParts(fields.dates.value.startDate), [2027, 2, 22]);
  assert.deepEqual(dateParts(fields.dates.value.endDate), [2027, 3, 8]);
});

test('date setting fails when neither control is visible', async () => {
  const { page, actions } = availabilityPage();
  await assert.rejects(quote.setArrivalDate(page, '2026-09-24'), /visible field unavailable/);
  assert.deepEqual(actions, []);
});

for (const form of [
  { name: 'older', oldVisible: true, endpoint: oldPath },
  { name: 'cloud with hidden old input', cloudVisible: true, endpoint: cloudPath },
]) {
  test(`${form.name} search binds the same-origin inquiry, applied occupancy, and each visible night`, async () => {
    const fixture = multipleSource();
    const amounts = [1780, 1795.5, 1820.25, 1870];
    const inventory = [3, 2, 4, 3];
    for (let i = 0; i < amounts.length; i++) {
      fixture.rate.columns[`col${i + 1}`].value = amounts[i];
      fixture.data.children[0].children[0].columns[`col${i + 1}`].value = inventory[i];
      fixture.calendar.options[0].prices[i] = `R${amounts[i].toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
      fixture.calendar.options[0].room.inventory[i] = String(inventory[i]);
    }
    const { page, fields, actions } = availabilityPage({ ...form, fixture });
    const source = await quote.searchCalendar(page, request, request.rooms[0]);
    assert.equal(source.searchCount, 1);
    assert.equal(source.windows[0].data.marker, 'accepted');
    assert.equal(source.windows[0].endpoint, form.endpoint);
    assert.equal(quote.projectWindow(source.windows[0]).endpoint, form.endpoint);
    assert.equal(JSON.stringify(quote.projectWindow(source.windows[0])).includes('private-token'), false);
    assert.equal(source.windows[0].criteria.startDate, '2026-09-24T00:00:00');
    assert.equal(source.windows[0].criteria.adultCount, 1);
    assert.equal(source.windows[0].criteria.childCount, 0);
    const dateField = form.oldVisible ? 'startdate' : 'dates';
    assert.equal(actions.filter((entry) => entry[1] === dateField && ['fill', 'setValue'].includes(entry[0])).length, 2);
    if (form.cloudVisible) assert.deepEqual(dateParts(fields.dates.value.startDate), [2026, 9, 24]);

    const parsed = quote.extractOptions(request, request.rooms[0], source.windows);
    const first = parsed.options.find((option) => option.room.code === 'STQN');
    assert.deepEqual(first.nightly.map((night) => [night.date, night.price.amount, night.inventory]), [
      ['2026-09-24', '1780.00', 3], ['2026-09-25', '1795.50', 2], ['2026-09-26', '1820.25', 4],
    ]);
    assert.equal(first.availability, 'available');
    source.windows[0].calendar.options[0].prices[1] = 'R9,999.00';
    const mismatch = quote.extractOptions(request, request.rooms[0], source.windows);
    const rejected = mismatch.options.find((option) => option.room.code === 'STQN');
    assert.deepEqual(rejected.nightly, []);
    assert.ok(rejected.issues.some((item) => item.code === 'PRICE_OR_INVENTORY_SOURCE_MISMATCH'));
  });

  test(`${form.name} search rejects a different applied date or occupancy`, async () => {
    for (const [criteriaOverride, code] of [
      [{ startDate: '2026-09-25T00:00:00' }, 'startDate'],
      [{ adultCount: 2 }, 'adultCount'],
      [{ childCount: 1 }, 'childCount'],
      [{ childAges: [9] }, 'childAges'],
    ]) {
      const { page } = availabilityPage({ ...form, criteriaOverride });
      await assert.rejects(quote.searchCalendar(page, request, request.rooms[0]),
        new RegExp(`APPLIED_CRITERIA_MISMATCH_${code}`));
    }
  });
}
