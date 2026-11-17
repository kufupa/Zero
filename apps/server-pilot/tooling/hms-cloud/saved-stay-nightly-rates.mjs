import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withCloudReadSession, cloudSessionIdentity } from './cloud-session.mjs';
import { readQuote } from './quote-read.mjs';
import { searchHotelAvailabilityParty, selectHotelAvailabilityParty } from './hotel-availability.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';
import { cleanLabtestRecord, snapshotLabtestRecord } from './labtest-record.mjs';
import { createSavedStayRateReadCapability, installSavedStayRateReadRouteChain } from './saved-stay-save-route-chain.mjs';
import { getPropertyRegistration } from './property-registry.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const ratePath = propertyCode => `/api/internalBooking/${propertyCode}/rateshop/rateDetails`;
const object = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
// HMS omits childAges for an explicitly child-free availability inquiry.
const sameQuoteChildren = (applied, ages) => applied.childCount === ages.length &&
  (same(applied.childAges, ages) || (ages.length === 0 && !Object.hasOwn(applied, 'childAges')));
const unique = (value) => object(value) && new Set(Object.keys(value).map((key) => key.toLowerCase())).size === Object.keys(value).length;

export function nativeMoneyTenThousandths(raw) {
  if (!['string', 'number'].includes(typeof raw)) return null;
  const text = String(raw).trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,4})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.replaceAll(',', '').split('.');
  if (whole.length > 12) return null;
  return (BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'))).toString();
}

export function nativeMoneyCents(raw) {
  const exact = nativeMoneyTenThousandths(raw);
  return exact === null || BigInt(exact) % 100n !== 0n ? null : (BigInt(exact) / 100n).toString();
}

// Native averages have four decimal places. Round only their currency display;
// actual dated charges still require exact integer cents above.
export function nativeAverageCents(raw) {
  const exact = nativeMoneyTenThousandths(raw);
  return exact === null ? null : ((BigInt(exact) + 50n) / 100n).toString();
}

export function nativeNightDates(arrival, departure) {
  const day = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date.getTime() : null;
  };
  const start = day(arrival), end = day(departure);
  if (start === null || end === null || end <= start) return null;
  return Array.from({ length: (end - start) / 86400000 }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10));
}

/** HMS emits two observed bare keys. Quote only those keys; never execute native text. */
export function parseNativePricingJson(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2 * 1024 * 1024) throw new Error('NATIVE_PRICE_RESPONSE_INVALID');
  const stack = [], chunks = [];
  for (let i = 0; i < raw.length;) {
    const ch = raw[i], top = stack[stack.length - 1];
    if (ch === '"') {
      let j = i + 1, escaped = false;
      for (; j < raw.length; j++) {
        if (escaped) { escaped = false; continue; }
        if (raw[j] === '\\') { escaped = true; continue; }
        if (raw[j] === '"') break;
      }
      if (j === raw.length) throw new Error('NATIVE_PRICE_RESPONSE_INVALID');
      const token = raw.slice(i, j + 1);
      if (top?.kind === 'object' && top.key) {
        const key = JSON.parse(token).toLowerCase();
        if (top.keys.has(key)) throw new Error('NATIVE_PRICE_RESPONSE_DUPLICATE');
        top.keys.add(key); top.key = false;
      }
      chunks.push(token); i = j + 1; continue;
    }
    if (top?.kind === 'object' && top.key && /[A-Za-z]/.test(ch)) {
      const match = /^(values|attributes)(\s*:)/.exec(raw.slice(i));
      if (!match || top.keys.has(match[1])) throw new Error('NATIVE_PRICE_RESPONSE_INVALID');
      top.keys.add(match[1]); top.key = false;
      chunks.push(`"${match[1]}"${match[2]}`); i += match[0].length; continue;
    }
    if (ch === '{') stack.push({ kind: 'object', key: true, keys: new Set() });
    else if (ch === '[') stack.push({ kind: 'array' });
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',' && top?.kind === 'object') top.key = true;
    chunks.push(ch); i++;
  }
  try { return JSON.parse(chunks.join('')); }
  catch { throw new Error('NATIVE_PRICE_RESPONSE_INVALID'); }
}

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const nativePriceDigest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** DATE rows contain the nightly total. Their bundle children are allocations, not extra nights. */
export function projectNativeNightlyRates(body, expected) {
  const data = body?.rateDetails, dates = nativeNightDates(expected?.arrival, expected?.departure);
  if (!getPropertyRegistration(expected?.propertyCode)?.active || !unique(body) || !unique(data) || !dates || data.property !== expected.propertyCode ||
      String(data.reservationStayID ?? '') !== expected.nativeStayId ||
      String(data.bookingSessionID ?? '') !== expected.bookingSessionId || data.isDateRange !== false ||
      !Array.isArray(data.egriddata) || data.egriddata.length !== dates.length) return null;
  const currency = data.propertyCurrency;
  if (!/^[A-Z]{3}$/.test(currency || '') || data.guestCurrency !== currency || data.ratePlanCurrency !== currency) return null;
  const totals = {};
  for (const [key, native, guest] of [['subtotalCents', 'subTotal', 'guestCurrSubTotal'], ['taxCents', 'taxes', 'guestCurrTaxes'],
    ['feeCents', 'fees', 'guestCurrFees'], ['totalCents', 'total', 'guestCurrTotal']]) {
    const amount = nativeMoneyCents(data[native]);
    if (amount === null || nativeMoneyCents(data[guest]) !== amount || data[`${native}Currency`] !== currency ||
        data[`${guest}Currency`] !== currency) return null;
    totals[key] = amount;
  }
  if (BigInt(totals.subtotalCents) + BigInt(totals.taxCents) + BigInt(totals.feeCents) !== BigInt(totals.totalCents) ||
      nativeMoneyCents(data.netTotal) !== totals.totalCents || nativeMoneyCents(data.guestNetTotal) !== totals.totalCents ||
      data.netTotalCurrency !== currency || data.guestNetTotalCurrency !== currency ||
      ['taxAdjustments', 'guestTaxAdjustments', 'folioComps'].some((name) => data[name] !== undefined &&
        data[name] !== null && nativeMoneyCents(data[name]) !== '0')) return null;
  const rows = [], seen = new Set();
  for (const row of data.egriddata) {
    if (!unique(row) || row.rowType !== 0 || row.isLeaseExist !== false || seen.has(row.date) || !dates.includes(row.date) ||
        row.startDate !== row.date || row.endDate !== row.date ||
        typeof row.roomTypeName !== 'string' || !row.roomTypeName.trim() ||
        typeof row.ratePlanName !== 'string' || !row.ratePlanName.trim() ||
        (expected.roomTypeName && row.roomTypeName !== expected.roomTypeName) ||
        (expected.ratePlanName && row.ratePlanName !== expected.ratePlanName)) return null;
    const chargeCents = nativeMoneyCents(row.charge), totalChargeCents = nativeMoneyCents(row.totalCharge);
    if (chargeCents === null || totalChargeCents === null || nativeMoneyCents(row.guestCurrCharge) !== chargeCents ||
        nativeMoneyCents(row.guestCurrTotalCharge) !== totalChargeCents || !Array.isArray(row.children)) return null;
    seen.add(row.date);
    rows.push({ date: row.date, chargeCents, totalChargeCents, roomTypeName: row.roomTypeName, ratePlanName: row.ratePlanName });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (!same(rows.map((row) => row.date), dates) || rows.reduce((sum, row) => sum + BigInt(row.totalChargeCents), 0n).toString() !== totals.subtotalCents) return null;
  const result = { version: 1, propertyCode: expected.propertyCode, nativeStayId: expected.nativeStayId, currency, nightly: rows, totals };
  return { ...result, digest: nativePriceDigest(result) };
}

/** Read through the native controller's exact header contract, without a dirty-form Rate Details click. */
export async function readSavedStayNightlyRates(page, state, expected, { mode = 'saved', requestScope = null,
  snapshot = snapshotLabtestRecord, bounded = async (value) => await value } = {}) {
  const frame = state?.frame, before = await bounded(snapshot(frame)), data = before?.data;
  if (!frame || !getPropertyRegistration(expected?.propertyCode)?.active || !unique(data) || data.propertycode !== expected.propertyCode || String(data.reservationstayid) !== expected.nativeStayId ||
      data.confirmationnumber !== expected.confirmation || (mode === 'saved' && !cleanLabtestRecord(before)) ||
      typeof data.bookingsessionid !== 'string' || !data.bookingsessionid) throw new Error('NATIVE_PRICE_TARGET_UNVERIFIED');
  const path = ratePath(expected.propertyCode);
  const fence = await installPageRequestFence(page, ['/web/base/OSRATD', path]);
  if (requestScope && requestScope.fence !== fence) throw new Error('NATIVE_RATE_SCOPE_UNVERIFIED');
  const scope = requestScope?.scope ?? fence.open();
  const capability = createSavedStayRateReadCapability(page, { frame, mode, propertyCode: expected.propertyCode, nativeStayId: expected.nativeStayId,
    bookingSessionId: data.bookingsessionid });
  let chain;
  try {
    chain = await bounded(installSavedStayRateReadRouteChain(page, { frame, fence, scope, capability }));
    const pending = page.waitForResponse((response) => response.request().frame() === frame &&
      new URL(response.url()).origin === ORIGIN && new URL(response.url()).pathname === path, { timeout: 30_000 });
    void pending.catch(() => {});
    if (mode === 'saved') {
      const button = frame.locator('[data-qtip="Rate Details"]:visible');
      if (await bounded(button.count()) !== 1 || await bounded(frame.locator('.x-window:visible:not(.x-menu)').count()) !== 0) {
        throw new Error('NATIVE_RATE_CONTROL_UNVERIFIED');
      }
      await bounded(button.click({ timeout: 5_000, noWaitAfter: true }));
    } else {
      const initiated = await bounded(frame.evaluate(({ propertyCode, bookingSessionId, nativeStayId, confirmation, direct }) => {
        if (typeof globalThis.EAM?.Ajax?.rest !== 'function') return false;
        const guests = [...document.querySelectorAll('input[name=guestid]')].filter(el =>
          (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
        const panel = guests.length === 1 ? globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
        const data = panel?.getRecord?.()?.data;
        if (!data || String(data.reservationstayid) !== nativeStayId || data.confirmationnumber !== confirmation ||
            data.bookingsessionid !== bookingSessionId || data.propertycode !== propertyCode) return false;
        // The native OSRATD controller uses this exact saved-ID GET. Calling
        // the read directly avoids its dirty-form popup click and any Save.
        const query = direct ? `?reservationStayID=${encodeURIComponent(nativeStayId)}` : '';
        globalThis.EAM.Ajax.rest({ restUrl: `internalBooking/${propertyCode}/rateshop/rateDetails${query}`,
          headers: { BookingClientSessionID: bookingSessionId }, onSuccess: () => {} });
        return true;
      }, { propertyCode: expected.propertyCode, bookingSessionId: data.bookingsessionid, nativeStayId: expected.nativeStayId,
        confirmation: expected.confirmation, direct: mode === 'saved_direct' }));
      if (!initiated) throw new Error('NATIVE_RATE_CONTROL_UNVERIFIED');
    }
    const response = await bounded(pending);
    if (response.status() !== 200 || !/json/i.test(response.headers()['content-type'] || '')) throw new Error('NATIVE_PRICE_READ_FAILED');
    const rates = projectNativeNightlyRates(parseNativePricingJson(await bounded(response.text())),
      { ...expected, bookingSessionId: data.bookingsessionid });
    if (!rates) throw new Error('NATIVE_NIGHTLY_PRICE_UNVERIFIED');
    if (mode === 'saved') {
      const dialog = frame.locator('.x-window:visible:not(.x-menu)').filter({ hasText: /Rate Details/ });
      const close = dialog.locator('a.x-btn:visible').filter({ hasText: /^\s*Close\s*$/ });
      if (await bounded(dialog.count()) !== 1 || await bounded(close.count()) !== 1) throw new Error('NATIVE_RATE_CLOSE_UNVERIFIED');
      await bounded(close.click({ timeout: 5_000 }));
      await bounded(dialog.waitFor({ state: 'hidden', timeout: 5_000 }));
    }
    if (!same(before, await bounded(snapshot(frame)))) throw new Error('NATIVE_RATE_READ_CHANGED_FORM');
    return rates;
  } finally {
    await chain?.close();
    if (!requestScope) scope.close();
  }
}

/** The quote is independent read-only evidence. It is never labelled a saved retained rate. */
export function projectAmendNightlyQuote(raw, { selected, changes, partyPreimage }) {
  const dates = nativeNightDates(changes.arrival ?? selected.arrival, changes.departure ?? selected.departure);
  const requested = raw?.requestedCriteria, applied = raw?.appliedCriteria, availability = raw?.response?.availabilitydata;
  const childAges = changes.childAges ?? selected.childAges;
  const roomType = changes.roomType ?? selected.roomType, ratePlan = changes.ratePlan ?? selected.ratePlan;
  if (!getPropertyRegistration(selected?.propertyCode)?.active || !dates || raw.outcome !== 'ok' || !object(requested) || !object(applied) || !Array.isArray(childAges) ||
      requested.propertyCode !== selected.propertyCode || requested.arrivalDate !== dates[0] || requested.departureDate !== (changes.departure ?? selected.departure) ||
      requested.adults !== (changes.adults ?? selected.adults) || !same(requested.childAges, childAges) || requested.roomQuantity !== 1 ||
      !same(requested.roomTypes, [roomType]) || !same(requested.ratePlans, [ratePlan]) ||
      applied.propertyCodes !== selected.propertyCode || applied.startDate !== `${dates[0]}T00:00:00` || String(applied.numberOfDays) !== String(dates.length) ||
      applied.adultCount !== requested.adults || !sameQuoteChildren(applied, childAges) ||
      applied.roomTypeCodes !== roomType || applied.ratePlanCodes !== ratePlan || applied.shopByDay !== false ||
      String(applied.groupID ?? '') !== String(partyPreimage.groupid ?? '') ||
      String(applied.organizationID ?? '') !== String(partyPreimage.companyid ?? '') ||
      String(applied.travelAgencyID ?? '') !== String(partyPreimage.taid1 ?? '') || !Array.isArray(availability?.datesList)) return null;
  const wireDates = dates.map((date) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`);
  if (!same(availability.datesList, wireDates)) return null;
  const properties = availability.children?.filter((row) => row.code === selected.propertyCode && row.isprop === true && row.issummary === false);
  const rooms = properties?.length === 1 ? properties[0].children?.filter((row) => row.code === roomType && row.isroomtype === true) : null;
  const rates = rooms?.length === 1 ? rooms[0].children?.filter((row) => row.code === ratePlan && row.leaf === true) : null;
  const rate = rates?.length === 1 ? rates[0] : null, cells = raw.displayedPrices?.cells;
  if (!rate || !/^[A-Z]{3}$/.test(rate.currency || '') || properties[0].currency !== rate.currency ||
      !Array.isArray(cells) || cells.length !== dates.length || rate.restricted !== false || rate.promotioncode) return null;
  const nightly = [];
  for (const [i, date] of dates.entries()) {
    const column = rate.columns?.[`col${i + 1}`], visible = cells.filter((cell) => cell.date === date &&
      cell.propertyCode === selected.propertyCode && cell.roomTypeCode === roomType && cell.ratePlanCode === ratePlan);
    const amount = nativeMoneyCents(column?.value), text = visible[0]?.displayedText;
    const symbol = rate.currencysymbol;
    const displayed = typeof text === 'string' && typeof symbol === 'string' && text.startsWith(symbol)
      ? nativeMoneyCents(text.slice(symbol.length)) : null;
    if (!column || column.israteavailable !== true || column.restricted !== false || column.closed === true ||
        column.closedToArrival === true || column.closedToDeparture === true || amount === null || visible.length !== 1 ||
        visible[0].currency !== rate.currency || nativeMoneyCents(visible[0].responseValue) !== amount || displayed !== amount ||
        visible[0].promotionCode) return null;
    nightly.push({ date, quoteCents: amount });
  }
  return { currency: rate.currency, roomTypeName: rooms[0].desc, ratePlanName: rate.name,
    nightly, totalCents: nightly.reduce((sum, row) => sum + BigInt(row.quoteCents), 0n).toString() };
}

/** Rate Shop options for the requested room and occupancy, as returned by HMS. */
export function projectAmendRateOptions(raw, { selected, changes, partyPreimage }) {
  const dates = nativeNightDates(changes.arrival ?? selected.arrival, changes.departure ?? selected.departure);
  const childAges = changes.childAges ?? selected.childAges;
  const roomType = changes.roomType ?? selected.roomType;
  const requested = raw?.requestedCriteria, applied = raw?.appliedCriteria, availability = raw?.response?.availabilitydata;
  if (!getPropertyRegistration(selected?.propertyCode)?.active || !dates || raw?.outcome !== 'ok' || !Array.isArray(childAges) || !object(requested) || !object(applied) ||
      requested.propertyCode !== selected.propertyCode || requested.arrivalDate !== dates[0] ||
      requested.departureDate !== (changes.departure ?? selected.departure) ||
      requested.adults !== (changes.adults ?? selected.adults) || !same(requested.childAges, childAges) ||
      requested.roomQuantity !== 1 || !same(requested.roomTypes, [roomType]) || requested.ratePlans !== 'all' ||
      applied.propertyCodes !== selected.propertyCode || applied.roomTypeCodes !== roomType ||
      applied.startDate !== `${dates[0]}T00:00:00` || String(applied.numberOfDays) !== String(dates.length) ||
      applied.adultCount !== requested.adults || !sameQuoteChildren(applied, childAges) ||
      String(applied.groupID ?? '') !== String(partyPreimage.groupid ?? '') ||
      String(applied.organizationID ?? '') !== String(partyPreimage.companyid ?? '') ||
      String(applied.travelAgencyID ?? '') !== String(partyPreimage.taid1 ?? '') ||
      !same(availability?.datesList, dates.map((date) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`))) return null;
  const properties = availability.children?.filter((row) => row.code === selected.propertyCode && row.isprop === true && row.issummary === false);
  const rooms = properties?.length === 1 ? properties[0].children?.filter((row) => row.code === roomType && row.isroomtype === true) : null;
  if (rooms?.length !== 1 || !Array.isArray(rooms[0].children)) return null;
  const options = [];
  for (const rate of rooms[0].children) {
    if (rate?.leaf !== true || !/^[A-Z0-9]{1,12}$/.test(rate.code || '') || !/^[A-Z]{3}$/.test(rate.currency || '') ||
        rate.restricted !== false || rate.promotioncode) continue;
    const nightly = dates.map((date, index) => {
      const column = rate.columns?.[`col${index + 1}`], amountCents = nativeMoneyCents(column?.value);
      return column?.israteavailable === true && column.restricted === false && column.closed !== true &&
        column.closedToArrival !== true && column.closedToDeparture !== true && amountCents !== null
        ? { date, amountCents } : null;
    });
    if (nightly.every(Boolean)) options.push({ roomType, ratePlan: rate.code, currency: rate.currency, nightly });
  }
  return { options: options.slice(0, 100) };
}

export async function readAmendNightlyQuote(input, state, { openSession = withCloudReadSession } = {}) {
  const { selected, changes } = input, party = state.partyPreimage;
  const childAges = changes.childAges ?? selected.childAges;
  if (!Array.isArray(childAges)) throw new Error('NATIVE_QUOTE_OCCUPANCY_UNVERIFIED');
  // This host's /tmp may itself be a worktree. readQuote still verifies that
  // this private directory and every ancestor are outside Git before writing.
  const privateDir = await mkdtemp(join('/var/tmp', 'pane-amend-quote-'));
  try {
    const snapshotPath = join(privateDir, 'quote.json');
    await openSession(async (page) => {
      if (new URL(page.url()).origin !== ORIGIN || cloudSessionIdentity(page)?.propertyCode !== selected.propertyCode) {
        throw new Error('PROPERTY_OR_ORIGIN_MISMATCH');
      }
      const partyContext = {};
      for (const [kind, id, name] of [
        ['group', party.groupid, party.groupname],
        ['organization', party.companyid, party.company || party.companyname],
        ['bookingAgency', party.taid1, party.ta1],
      ]) {
        if (!id && !name) continue;
        if (typeof id !== 'string' || !/^\d{1,100}$/.test(id) || typeof name !== 'string' || !name.trim()) {
          throw new Error('NATIVE_QUOTE_PARTY_UNVERIFIED');
        }
        const found = await searchHotelAvailabilityParty(page, { propertyCode: selected.propertyCode, kind, query: name });
        if (found.outcome !== 'matches' || found.candidates.filter(candidate => candidate.nativeId === id).length !== 1) {
          throw new Error('NATIVE_QUOTE_PARTY_UNVERIFIED');
        }
        const choice = await selectHotelAvailabilityParty(page, { kind, searchId: found.searchId, nativeId: id });
        if (choice.outcome !== 'selected' || choice.nativeId !== id) throw new Error('NATIVE_QUOTE_PARTY_UNVERIFIED');
        partyContext[kind] = id;
      }
      const result = await readQuote(page, { criteria: { propertyCode: selected.propertyCode, arrivalDate: changes.arrival ?? selected.arrival,
        departureDate: changes.departure ?? selected.departure, adults: changes.adults ?? selected.adults, childAges,
        roomTypes: [changes.roomType ?? selected.roomType], ratePlans: 'all', partyContext },
      roomQuantity: 1, snapshotPath, view: { nightLimit: 30 } });
      if (result.outcome !== 'ok') throw new Error(/^[A-Z][A-Z0-9_]{2,100}$/.test(result.issue || '')
        ? result.issue : 'NATIVE_QUOTE_UNVERIFIED');
    }, { propertyCode: selected.propertyCode, transportId: input.transportId, credentialLease: input.credentialLease,
      startScreen: 'OSRESS', signal: input.signal, ...(input.cloudTargetKey ? { cloudTargetKey: input.cloudTargetKey } : {}) });
    const quote = projectAmendRateOptions(JSON.parse(await readFile(snapshotPath, 'utf8')), { selected, changes, partyPreimage: party });
    if (!quote) throw new Error('NATIVE_QUOTE_UNVERIFIED');
    return quote;
  } finally { await rm(privateDir, { recursive: true, force: true }); }
}
