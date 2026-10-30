// Project a private Hotel Availability snapshot without making booking decisions.
const DAY_MS = 86_400_000;
const conditionFields = [
  'closedToArrival', 'closedToDeparture', 'combClosedToArrival', 'combClosedToDeparture',
  'minLOS', 'maxLOS', 'maxNights', 'minLeadTime', 'maxLeadTime', 'availableLimitNightCount',
  'limitedRatePlanRestriction', 'minLOSToArrival', 'minLOSToDeparture', 'maxLOSToArrival',
  'maxLOSToDeparture', 'minLOSToThrough', 'maxLOSToThrough', 'combMinLOSToArrival',
  'combMinLOSToDeparture', 'combMaxLOSToArrival', 'combMaxLOSToDeparture',
  'combMinLOSToThrough', 'combMaxLOSToThrough', 'externalSellOptionNotAvailableReason',
  'externalSellOptionNotAvailableReasonQualifier', 'isArrivalDateEqualsClosedToArrivalStayDate',
];
const booleanFlags = ['restricted', 'closed', 'combClosed', 'isRestrictedByRevenueManagement',
  'israteavailable', 'closedToArrival', 'closedToDeparture', 'combClosedToArrival',
  'combClosedToDeparture', 'isArrivalDateEqualsClosedToArrivalStayDate'];
const appliedFields = new Set(['propertyCodes', 'startDate', 'numberOfDays', 'lengthOfStay', 'adultCount', 'childCount',
  'childAges', 'salesStrategy', 'roomTypeCodes', 'ratePlanCodes', 'groupID', 'organizationID', 'travelAgencyID',
  'currency', 'convertFromPropertyCurrency', 'shopByDay', 'showCollapsedByProperty', 'showCollapsedByRoomType',
  'excludeOverbookingLimits', 'showRestrictedSellOptions', 'showExclusiveRates', 'launchedFrom',
  'showCollapsedByBuilding', 'buildingCodes', 'showArrivalDepartureCount', 'showSubGroupView']);

const clone = (value) => value == null ? null : structuredClone(value);
const omit = (object, keys) => Object.fromEntries(
  Object.entries(object).filter(([key]) => !keys.includes(key)),
);

function pageNumber(value, fallback, minimum, maximum) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new RangeError('INVALID_AVAILABILITY_VIEW_PAGE');
  }
  return number;
}

function filterCodes(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new TypeError('AVAILABILITY_VIEW_FILTERS_MUST_BE_ARRAYS');
  return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

function isoDate(value) {
  if (typeof value !== 'string') return null;
  const native = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const iso = native ? `${native[3]}-${native[1]}-${native[2]}` : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

const displayKey = (property, room, rate, promotion, date, value, currency) =>
  JSON.stringify([property, room, rate, promotion ?? null, date, value, currency]);

function displayedPriceIndex(snapshot) {
  const capture = snapshot?.displayedPrices;
  const index = new Map();
  if (capture?.outcome !== 'captured' || capture.source !== 'visible_hms_grid' || !Array.isArray(capture.cells)) return index;
  for (const cell of capture.cells) {
    if (!cell || typeof cell.displayedText !== 'string' || !cell.displayedText.trim() || cell.displayedText.length > 200 ||
        !isoDate(cell.date)) continue;
    const key = displayKey(cell.propertyCode, cell.roomTypeCode, cell.ratePlanCode, cell.promotionCode,
      cell.date, cell.responseValue, cell.currency);
    index.set(key, index.has(key) ? null : cell.displayedText);
  }
  return index;
}

function datesMatchApplied(dates, applied) {
  const start = isoDate(typeof applied?.startDate === 'string' ? applied.startDate.slice(0, 10) : null);
  const count = numericInteger(applied?.numberOfDays);
  if (!start || count === null || count < 1) return null;
  const first = Date.parse(`${start}T00:00:00Z`);
  return dates.length === count && dates.every((date, index) =>
    isoDate(date) === new Date(first + index * DAY_MS).toISOString().slice(0, 10));
}

function submittedCodes(value) {
  if (typeof value !== 'string') return null;
  const codes = filterCodes(value.split(','));
  return codes.length ? codes : null;
}

function sameCodes(left, right) {
  if (!left || !right) return null;
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function requestedCodes(value, catalog) {
  if (Array.isArray(value)) return filterCodes(value);
  if (value === 'all' && catalog?.complete === true && Array.isArray(catalog.codes)) {
    return filterCodes(catalog.codes);
  }
  return null;
}

function numericInteger(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function requestedScope(requested) {
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
    return { criteria: null, omittedFields: null, omittedPartyFields: null };
  }
  const criteria = {};
  let omittedFields = 0;
  let omittedPartyFields = 0;
  for (const [key, value] of Object.entries(requested)) {
    if (['propertyCode', 'arrivalDate', 'departureDate'].includes(key) && typeof value === 'string') criteria[key] = value;
    else if (['adults', 'childCount', 'quantity', 'roomQuantity', 'roomCount'].includes(key) && Number.isSafeInteger(value)) criteria[key] = value;
    else if (key === 'childAges' && Array.isArray(value) && value.every(Number.isSafeInteger)) criteria[key] = [...value];
    else if (['roomTypes', 'ratePlans'].includes(key) && (value === 'all' ||
        (Array.isArray(value) && value.every((code) => typeof code === 'string')))) criteria[key] = clone(value);
    else if (key === 'partyContext' && value === null) criteria[key] = null;
    else if (key === 'partyContext' && value && typeof value === 'object' && !Array.isArray(value)) {
      criteria[key] = {};
      for (const [name, id] of Object.entries(value)) {
        if (['group', 'organization', 'bookingAgency'].includes(name) && (typeof id === 'string' || id === null)) {
          criteria[key][name] = id;
        } else omittedPartyFields += 1;
      }
    } else omittedFields += 1;
  }
  return { criteria, omittedFields, omittedPartyFields };
}

function appliedScope(applied) {
  if (!applied || typeof applied !== 'object' || Array.isArray(applied)) return { criteria: null, omittedFields: null };
  const entries = Object.entries(applied).filter(([key]) => appliedFields.has(key));
  return { criteria: clone(Object.fromEntries(entries)),
    omittedFields: Object.keys(applied).filter((key) => key !== 'bookingSessionID' && !appliedFields.has(key)).length };
}

function partyContextMatch(requested, applied) {
  const names = { group: 'groupID', organization: 'organizationID', bookingAgency: 'travelAgencyID' };
  const fields = Object.fromEntries(Object.keys(names).map((name) => [name, null]));
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) return { match: null, fields };
  const context = requested?.partyContext;
  if (context != null && (typeof context !== 'object' || Array.isArray(context))) return { match: null, fields };
  const requestedFields = ['rateContext', 'groupID', 'organizationID', 'travelAgencyID',
    'group', 'organization', 'bookingAgency', 'agency'];
  const populated = (value) => {
    if (value == null || value === false) return false;
    if (typeof value === 'string') return Boolean(value.trim());
    if (Array.isArray(value)) return value.some(populated);
    if (typeof value === 'object') return Object.values(value).some(populated);
    return true;
  };
  if (requestedFields.some((key) => populated(requested[key]))) return { match: null, fields };
  const emptyContext = context == null || Object.keys(context).length === 0;
  let unknown = !emptyContext && Object.keys(context).some((key) => !Object.hasOwn(names, key));
  let mismatch = false;
  let present = 0;
  for (const [name, field] of Object.entries(names)) {
    const actual = applied?.[field];
    if (emptyContext) {
      if (typeof actual !== 'string') unknown = true;
      else fields[name] = !actual.trim();
      continue;
    }
    if (!Object.hasOwn(context, name)) {
      if (typeof actual !== 'string') unknown = true;
      else if (actual.trim()) mismatch = true;
      continue;
    }
    present += 1;
    if (typeof context[name] !== 'string' || typeof actual !== 'string') {
      unknown = true;
    } else {
      fields[name] = context[name].trim() === actual.trim();
    }
  }
  const match = mismatch || Object.values(fields).includes(false) ? false : (emptyContext || present) && !unknown ? true : null;
  return { match, fields };
}

function checkedCriteria(requested, applied, catalogs, partyMatch) {
  const requestProperty = typeof requested?.propertyCode === 'string' ? requested.propertyCode.trim().toUpperCase() : '';
  const appliedProperty = typeof applied?.propertyCodes === 'string' ? applied.propertyCodes.trim().toUpperCase() : '';
  const arrival = isoDate(requested?.arrivalDate);
  const departure = isoDate(requested?.departureDate);
  const appliedStart = isoDate(typeof applied?.startDate === 'string' ? applied.startDate.slice(0, 10) : null);
  const days = numericInteger(applied?.numberOfDays);
  const ages = requested?.childAges;
  const children = numericInteger(applied?.childCount);
  const hasRequestedChildCount = requested != null && typeof requested === 'object' && 'childCount' in requested;
  const requestedChildCount = requested?.childCount;
  const adultCount = numericInteger(applied?.adultCount);
  const actualAges = applied?.childAges;
  const occupancyKnown = Number.isSafeInteger(requested?.adults) && requested.adults > 0 && Array.isArray(ages) &&
    ages.every((age) => Number.isSafeInteger(age) && age >= 0) && children !== null && adultCount !== null &&
    children >= 0 && adultCount > 0 &&
    (!hasRequestedChildCount || (Number.isSafeInteger(requestedChildCount) && requestedChildCount >= 0)) &&
    (children === 0 || Array.isArray(actualAges));
  return {
    property: requestProperty && appliedProperty ? requestProperty === appliedProperty : null,
    dates: arrival && departure && appliedStart && days !== null && days > 0
      ? arrival === appliedStart && (Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / DAY_MS === days
      : null,
    occupancy: occupancyKnown ? requested.adults === adultCount && ages.length === children &&
      JSON.stringify(ages) === JSON.stringify(actualAges ?? []) &&
      (!hasRequestedChildCount || (requestedChildCount === ages.length && requestedChildCount === children)) : null,
    partyContext: partyMatch,
    roomTypes: sameCodes(requestedCodes(requested?.roomTypes, catalogs?.roomTypes), submittedCodes(applied?.roomTypeCodes)),
    ratePlans: sameCodes(requestedCodes(requested?.ratePlans, catalogs?.ratePlans), submittedCodes(applied?.ratePlanCodes)),
  };
}

function catalogCoverage(catalog) {
  if (!catalog || typeof catalog !== 'object') return null;
  return {
    loaded: Array.isArray(catalog.records) ? catalog.records.length : null,
    reportedLoaded: catalog.reportedLoaded ?? null,
    reportedTotal: catalog.reportedTotal ?? null,
    complete: typeof catalog.complete === 'boolean' ? catalog.complete : null,
  };
}

function hasCondition(object) {
  return object && conditionFields.some((key) => {
    const value = object[key];
    return value != null && value !== false && value !== 0 && value !== '';
  });
}

function category(reasons) {
  if (reasons.has('zero_stock')) return 'zero_stock';
  if (reasons.has('negative_stock')) return 'negative_stock';
  if (reasons.has('closed_or_restricted')) return 'closed_or_restricted';
  if (reasons.has('unknown')) return 'unknown';
  if (reasons.has('conditions_present')) return 'conditional';
  return 'positive_stock';
}

function observation(property, room, rate, date, index, contextVerified, includeDetails = false, displayedPrices = null) {
  const key = `col${index + 1}`;
  const propertyCell = property.columns?.[key] ?? null;
  const roomCell = room.columns?.[key] ?? null;
  const rateCell = rate.columns?.[key] ?? null;
  const count = roomCell?.value;
  const price = rateCell?.value;
  const validCount = Number.isSafeInteger(count);
  const validPrice = (typeof price === 'number' && Number.isFinite(price)) ||
    (typeof price === 'string' && price.trim() !== '');
  const nativeNodes = [property, room, rate, propertyCell, roomCell, rateCell];
  const reasons = new Set();
  if (count === 0) reasons.add('zero_stock');
  if (validCount && count < 0) reasons.add('negative_stock');
  if (nativeNodes.some((cell) =>
    cell?.restricted === true || cell?.closed === true || cell?.combClosed === true ||
    cell?.isRestrictedByRevenueManagement === true || cell?.israteavailable === false)) {
    reasons.add('closed_or_restricted');
  }
  if (nativeNodes.some(hasCondition)) reasons.add('conditions_present');
  if (!contextVerified || !isoDate(date) || !validCount || !validPrice ||
      typeof rate.currency !== 'string' || !rate.currency.trim() ||
      typeof rate.restricted !== 'boolean' || typeof propertyCell?.restricted !== 'boolean' ||
      typeof rateCell?.restricted !== 'boolean' || typeof rateCell?.combClosed !== 'boolean' ||
      typeof rateCell?.israteavailable !== 'boolean' || nativeNodes.some((node) =>
        node && booleanFlags.some((key) => node[key] != null && typeof node[key] !== 'boolean'))) reasons.add('unknown');
  if (!includeDetails) return reasons;
  const displayedText = displayedPrices?.get(displayKey(property.code, room.code, rate.code, rate.promotioncode,
    isoDate(date), price, rate.currency)) ?? null;
  return {
    date: isoDate(date), nativeDate: date,
    roomsAvailable: validCount ? count : null,
    price: {
      responseValue: validPrice ? price : null,
      responseText: typeof price === 'string' ? price : null,
      displayedText,
      displayedTextStatus: displayedText === null ? 'unknown' : 'captured',
      displayedTextSource: displayedText === null ? null : 'visible_hms_grid',
      currency: rate.currency ?? null,
      currencySymbol: rate.currencysymbol ?? null,
    },
    category: category(reasons), reasons: [...reasons],
    native: { property: clone(propertyCell), room: clone(roomCell), rate: clone(rateCell) },
  };
}

/** Return a bounded, expandable view of a caller-owned private snapshot. */
export function getAvailabilityView(snapshot, filters = {}) {
  if (!snapshot || typeof snapshot !== 'object' || !filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new TypeError('INVALID_AVAILABILITY_VIEW_INPUT');
  }
  const roomTypes = filterCodes(filters.roomTypes);
  const ratePlans = filterCodes(filters.ratePlans);
  const offset = pageNumber(filters.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = pageNumber(filters.limit, 10, 1, 50);
  const nightOffset = pageNumber(filters.nightOffset, 0, 0, Number.MAX_SAFE_INTEGER);
  const nightLimit = pageNumber(filters.nightLimit, 14, 1, 31);
  const scope = { roomTypes, ratePlans, offset, limit, nightOffset, nightLimit };
  const requested = requestedScope(snapshot.requestedCriteria);
  const applied = appliedScope(snapshot.appliedCriteria);
  const party = partyContextMatch(snapshot.requestedCriteria, snapshot.appliedCriteria);
  const criteriaMatch = checkedCriteria(snapshot.requestedCriteria, snapshot.appliedCriteria, snapshot.catalogs, party.match);
  const result = {
    outcome: snapshot.outcome ?? 'ok', observedAt: snapshot.observedAt ?? null,
    requestedCriteria: requested.criteria,
    appliedCriteria: applied.criteria,
    scope,
    coverage: {
      roomCatalog: catalogCoverage(snapshot.catalogs?.roomTypes),
      rateCatalog: catalogCoverage(snapshot.catalogs?.ratePlans),
      completeForRequestedScope: 'unknown', missingRows: 'unknown',
      checkedCriteriaMatch: criteriaMatch,
      partyContextFieldMatches: party.fields,
      unprojectedRequestedFields: requested.omittedFields,
      unprojectedPartyFields: requested.omittedPartyFields,
      unprojectedAppliedFields: applied.omittedFields,
      checkoutRestrictions: 'unknown',
      observationTimeKnown: typeof snapshot.observedAt === 'string' && Number.isFinite(Date.parse(snapshot.observedAt)),
      displayedPrices: snapshot.displayedPrices?.source === 'visible_hms_grid' ? {
        outcome: ['captured', 'unavailable'].includes(snapshot.displayedPrices.outcome)
          ? snapshot.displayedPrices.outcome : 'unknown',
        visibleRateRows: Number.isSafeInteger(snapshot.displayedPrices.coverage?.visibleRateRows)
          ? snapshot.displayedPrices.coverage.visibleRateRows : null,
        visiblePriceCells: Number.isSafeInteger(snapshot.displayedPrices.coverage?.visiblePriceCells)
          ? snapshot.displayedPrices.coverage.visiblePriceCells : null,
        correlatedCells: Number.isSafeInteger(snapshot.displayedPrices.coverage?.correlatedPriceCells)
          ? snapshot.displayedPrices.coverage.correlatedPriceCells : null,
        exhaustive: false,
      } : null,
    },
    options: [],
  };
  if (result.outcome === 'criteria_unavailable') return result;
  const data = snapshot.response?.availabilitydata;
  if (result.outcome !== 'ok' || !data || !Array.isArray(data.datesList) || !Array.isArray(data.children)) {
    throw new TypeError('INVALID_AVAILABILITY_SNAPSHOT');
  }

  if (data.children.some((item) => !item || item.isprop !== true || typeof item.issummary !== 'boolean')) {
    throw new TypeError('INVALID_AVAILABILITY_SNAPSHOT');
  }
  const propertyRows = data.children.filter((item) => item.isprop && !item.issummary);
  const hasCode = (item) => typeof item?.code === 'string' && Boolean(item.code.trim());
  if (propertyRows.some((property) => !hasCode(property) || !Array.isArray(property.children) || property.children.some((room) =>
    !room || typeof room !== 'object' || !hasCode(room) || !Array.isArray(room.children) ||
    room.children.some((rate) => !rate || typeof rate !== 'object' || !hasCode(rate))))) {
    throw new TypeError('INVALID_AVAILABILITY_SNAPSHOT');
  }
  const submittedProperties = submittedCodes(snapshot.appliedCriteria?.propertyCodes)?.map((code) => code.toUpperCase());
  const properties = submittedProperties ? propertyRows.filter((item) =>
    typeof item.code === 'string' && submittedProperties.includes(item.code.trim().toUpperCase())) : propertyRows;
  const rooms = properties.flatMap((property) => property.children.map((room) => ({ property, room })));
  const allRows = rooms.flatMap(({ property, room }) => room.children.map((rate) => ({ property, room, rate })));
  const identity = ({ property, room, rate }) => JSON.stringify([property.code, room.code, rate.code]);
  const identities = new Map();
  for (const row of allRows) identities.set(identity(row), (identities.get(identity(row)) || 0) + 1);
  const roomSet = roomTypes && new Set(roomTypes);
  const rateSet = ratePlans && new Set(ratePlans);
  const submittedRooms = submittedCodes(snapshot.appliedCriteria?.roomTypeCodes);
  const submittedRates = submittedCodes(snapshot.appliedCriteria?.ratePlanCodes);
  const matched = allRows.filter(({ room, rate }) => (!roomSet || roomSet.has(room.code)) &&
    (!rateSet || rateSet.has(rate.code)));
  const datesAligned = datesMatchApplied(data.datesList, snapshot.appliedCriteria);
  const contextVerified = datesAligned === true && result.coverage.observationTimeKnown &&
    requested.omittedFields === 0 && requested.omittedPartyFields === 0 && applied.omittedFields === 0 &&
    Object.values(criteriaMatch).every((value) => value === true) && submittedProperties?.length === 1 &&
    properties.length === 1 && propertyRows.length === properties.length;
  const counts = {};
  const evaluated = matched.map(({ property, room, rate }) => {
    const rowVerified = contextVerified && submittedRooms?.includes(room.code) && submittedRates?.includes(rate.code) &&
      identities.get(identity({ property, room, rate })) === 1;
    const reasons = new Set();
    data.datesList.forEach((date, index) => {
      for (const reason of observation(property, room, rate, date, index, rowVerified)) reasons.add(reason);
    });
    if (!data.datesList.length) reasons.add('unknown');
    const state = category(reasons);
    counts[state] = (counts[state] || 0) + 1;
    return { property, room, rate, rowVerified, reasons: [...reasons], category: state };
  });
  const selected = evaluated.slice(offset, offset + limit);
  const scopeRooms = roomTypes ?? submittedRooms;
  const scopeRates = ratePlans ?? submittedRates;
  const pairCount = scopeRooms && scopeRates && properties.length === 1
    ? new Set(matched.filter(({ room, rate }) => scopeRooms.includes(room.code) && scopeRates.includes(rate.code))
      .map(({ room, rate }) => JSON.stringify([room.code, rate.code]))).size : null;
  result.coverage = {
    ...result.coverage,
    propertyRows: properties.length, roomRows: rooms.length, rateRows: allRows.length,
    unexpectedPropertyRows: propertyRows.length - properties.length,
    unexpectedRateRows: submittedRooms && submittedRates ? allRows.filter(({ room, rate }) =>
      !submittedRooms.includes(room.code) || !submittedRates.includes(rate.code)).length : null,
    duplicateRateRows: allRows.filter((row) => identities.get(identity(row)) > 1).length,
    matchingRateRows: matched.length,
    filtersOutsideSubmittedScope: {
      roomTypes: roomTypes && submittedRooms ? roomTypes.filter((code) => !submittedRooms.includes(code)) : null,
      ratePlans: ratePlans && submittedRates ? ratePlans.filter((code) => !submittedRates.includes(code)) : null,
    },
    unreturnedRequestedPairs: pairCount === null ? null : scopeRooms.length * scopeRates.length - pairCount,
    categories: counts,
    page: { returned: selected.length, nextOffset: offset + selected.length < matched.length ? offset + selected.length : null },
    nights: { total: data.datesList.length, returned: data.datesList.slice(nightOffset, nightOffset + nightLimit).length,
      nextOffset: nightOffset + nightLimit < data.datesList.length ? nightOffset + nightLimit : null,
      matchesAppliedCriteria: datesAligned },
  };
  const displayedPrices = displayedPriceIndex(snapshot);
  result.options = selected.map(({ property, room, rate, rowVerified, reasons, category: state }) => ({
    property: clone(omit(property, ['children', 'columns'])),
    room: clone(omit(room, ['children', 'columns'])),
    rate: clone(omit(rate, ['children', 'columns'])),
    category: state, reasons,
    nights: data.datesList.slice(nightOffset, nightOffset + nightLimit).map((date, index) =>
      observation(property, room, rate, date, nightOffset + index, rowVerified, true, displayedPrices)),
  }));
  return result;
}
