const REQUESTED_SCOPES = new Set(['whole_stay', 'specific_room', 'unspecified']);
const DISPLAY_CURRENCY_CODES = new Set([
  'AED', 'AUD', 'BHD', 'BWP', 'CAD', 'CHF', 'CNY', 'EGP', 'EUR', 'GBP', 'GHS', 'INR',
  'JPY', 'KES', 'KWD', 'LSL', 'MAD', 'MWK', 'MZN', 'NAD', 'NGN', 'NOK', 'NZD', 'OMR',
  'QAR', 'RWF', 'SAR', 'SEK', 'SGD', 'SZL', 'TZS', 'UGX', 'USD', 'XAF', 'XOF', 'ZAR',
  'ZMW',
]);
const CURRENCY_SYMBOL_CODES = new Map([
  ['R', ['ZAR']], ['£', ['GBP']], ['€', ['EUR']], ['₹', ['INR']], ['₦', ['NGN']],
  ['₵', ['GHS']], ['$', ['AUD', 'CAD', 'NZD', 'SGD', 'USD']],
  ['¥', ['CNY', 'JPY']],
]);
const DISPLAY_CURRENCY_SYMBOLS = new Set([
  '£', '$', '€', '¥', '₹', '₦', '₱', '₫', '₩', '₺', '₽', '₴', '₪', '฿', '₡', '₲',
  '₵', '₭', '₮', '₼', '₾', '៛',
]);
const MONTHS = new Map([
  ['JAN', 1], ['FEB', 2], ['MAR', 3], ['APR', 4], ['MAY', 5], ['JUN', 6],
  ['JUL', 7], ['AUG', 8], ['SEP', 9], ['OCT', 10], ['NOV', 11], ['DEC', 12],
]);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function unverified(issue) {
  return { outcome: 'target_unverified', issue };
}

function displayString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

function currencyCandidates(token) {
  const trimmed = token.trim();
  const symbol = CURRENCY_SYMBOL_CODES.get(trimmed);
  if (symbol) return symbol;
  const code = trimmed.toUpperCase();
  return DISPLAY_CURRENCY_CODES.has(code) ? [code] : null;
}

function parseNumericAmount(value) {
  const parsed = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!parsed) return null;
  const whole = parsed[2].replace(/,/g, '').replace(/^0+(?=\d)/, '');
  const fraction = (parsed[3] ?? '').replace(/0+$/, '');
  const zero = whole === '0' && fraction === '';
  const sign = parsed[1] === '-' && !zero ? '-' : '';
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

function parseMoneyDisplay(value) {
  let numeric = value.trim();
  let currencies = null;
  const prefix = /^([^\d.,+-]+)\s*(.+)$/.exec(numeric);
  const suffix = /^(.+?)\s*([^\d.,+-]+)$/.exec(numeric);
  if (prefix) {
    currencies = currencyCandidates(prefix[1]);
    if (currencies) numeric = prefix[2];
  }
  if (!currencies && suffix) {
    currencies = currencyCandidates(suffix[2]);
    if (currencies) numeric = suffix[1];
  }

  const amount = parseNumericAmount(numeric);
  return amount === null ? null : { amount, currencies };
}

function explicitZero(value) {
  const parsed = parseMoneyDisplay(value);
  if (parsed) return parsed.amount === '0';

  let numeric = value.trim();
  const prefix = /^([^\d.,+-]+)\s*(.+)$/.exec(numeric);
  const suffix = /^(.+?)\s*([^\d.,+-]+)$/.exec(numeric);
  if (prefix && DISPLAY_CURRENCY_SYMBOLS.has(prefix[1].trim())) numeric = prefix[2];
  else if (suffix && DISPLAY_CURRENCY_SYMBOLS.has(suffix[2].trim())) numeric = suffix[1];
  return parseNumericAmount(numeric) === '0';
}

function basicComparable(value) {
  return value.replace(/\s+/g, ' ').toLocaleLowerCase();
}

function canonicalCount(value) {
  if (value.length > 8 || !/^\d+$/.test(value)) return null;
  return BigInt(value).toString();
}

function parseDateDisplay(value) {
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?$/.exec(text);
  const displayed = /^(?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+)?(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2}))?$/i.exec(text);
  let year;
  let month;
  let day;
  let weekday;
  let hour;
  let minute;
  if (iso) {
    [, year, month, day, hour, minute] = iso;
    year = Number(year);
    month = Number(month);
    day = Number(day);
  } else if (displayed) {
    [, weekday, day, month, year, hour, minute] = displayed;
    year = Number(year);
    month = MONTHS.get(month.toUpperCase());
    day = Number(day);
  } else {
    return null;
  }
  if (
    !month || !Number.isInteger(year) || year < 1 || year > 9999 ||
    !Number.isInteger(day) || day < 1 || (hour !== undefined && (+hour > 23 || +minute > 59))
  ) return null;

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const actualWeekday = WEEKDAYS[date.getUTCDay()];
  if (weekday && (!actualWeekday || actualWeekday.toLowerCase() !== weekday.toLowerCase())) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseOccupancyDisplay(value) {
  const text = value.trim().replace(/\s+/g, ' ');
  const plain = canonicalCount(text);
  if (plain !== null) return { adults: plain, children: null };
  const labelled = /^(\d{1,8})\s+Adults?(?:\s*(\d{1,8})\s+Child(?:ren)?)?$/i.exec(text);
  if (!labelled) return null;
  return {
    adults: canonicalCount(labelled[1]),
    children: labelled[2] === undefined ? null : canonicalCount(labelled[2]),
  };
}

function normalizeField(name, value) {
  if (name === 'arrivaldate' || name === 'departuredate') return parseDateDisplay(value);
  if (name === 'nights') {
    const nights = /^(\d{1,8})(?:\s+Nights?)?$/i.exec(value.trim());
    return nights ? canonicalCount(nights[1]) : null;
  }
  if (name === 'adults') return parseOccupancyDisplay(value)?.adults ?? null;
  if (name === 'children') {
    const children = /^(\d{1,8})(?:\s+Child(?:ren)?)?$/i.exec(value.trim());
    return children ? canonicalCount(children[1]) : null;
  }
  return basicComparable(value);
}

function compareMoney(left, right, currencyCode) {
  const a = parseMoneyDisplay(left);
  const b = parseMoneyDisplay(right);
  if (!a || !b) return basicComparable(left) === basicComparable(right) ? 'same' : 'ambiguous_format';
  if (a.amount !== b.amount) return 'different';
  const code = typeof currencyCode === 'string' ? currencyCode.trim().toUpperCase() : '';
  const knownCode = DISPLAY_CURRENCY_CODES.has(code) ? code : null;
  if (knownCode && [a.currencies, b.currencies].some((candidates) => candidates && !candidates.includes(knownCode))) {
    return 'different';
  }
  if (a.currencies && b.currencies) {
    if (!a.currencies.some((candidate) => b.currencies.includes(candidate))) return 'different';
    if (knownCode && a.currencies.includes(knownCode) && b.currencies.includes(knownCode)) return 'same';
    if (a.currencies.length === 1 && b.currencies.length === 1) return 'same';
    if (a.currencies.length === b.currencies.length && a.currencies.every((candidate) => b.currencies.includes(candidate))) {
      return 'same';
    }
    return 'ambiguous_currency';
  }
  const candidates = a.currencies ?? b.currencies;
  if (!candidates) return 'same';
  return knownCode
    ? (candidates.includes(knownCode) ? 'same' : 'different')
    : 'ambiguous_currency';
}

function compareDisplayed(left, right, { name, money = false, currencyCode } = {}) {
  const a = displayString(left);
  const b = displayString(right);
  if (a === null || b === null) return 'different';
  if (a === '' || b === '') return a === b ? 'same' : 'different';
  if (money) return compareMoney(a, b, currencyCode);
  const normalizedA = normalizeField(name, a);
  const normalizedB = normalizeField(name, b);
  if (normalizedA === null || normalizedB === null) {
    return basicComparable(a) === basicComparable(b) ? 'same' : 'ambiguous_format';
  }
  return normalizedA === normalizedB ? 'same' : 'different';
}

function ambiguityReason(relation, money) {
  if (relation === 'ambiguous_currency') return 'currency_not_reconciled';
  return money ? 'money_format_not_reconciled' : 'display_format_not_reconciled';
}

function classified(value, source, money = false) {
  const display = displayString(value);
  if (display === null) {
    return { state: 'unavailable', reason: 'unsupported_value', sources: [source] };
  }
  if (display === '') return { state: 'blank', value: '', sources: [source] };
  return {
    state: money && explicitZero(display) ? 'observed_zero' : 'observed',
    value: display,
    sources: [source],
  };
}

function unavailable(reason = 'field_not_rendered') {
  return { state: 'unavailable', reason, sources: [] };
}

function ambiguous(source) {
  return { state: 'ambiguous', reason: 'duplicate_field', sources: [source] };
}

function namedCard(shallow, title) {
  const cards = shallow?.details?.cards;
  const normalizedTitle = title.trim().toLowerCase();
  if (!Array.isArray(cards)) return { state: 'unavailable', reason: `${normalizedTitle}_card_unavailable` };
  const matches = cards.filter((card) => String(card?.title ?? '').trim().toLowerCase() === normalizedTitle);
  if (matches.length > 1) return { state: 'ambiguous' };
  if (matches.length === 0) return { state: 'unavailable', reason: `${normalizedTitle}_card_unavailable` };
  return { state: 'available', card: matches[0] };
}

function readShallowField(shallow, name, money = false, cardTitle = 'Stay', currencyCode, cardOnly = false) {
  const cardResult = namedCard(shallow, cardTitle);
  const cardKey = cardTitle.trim().toLowerCase().replace(/\s+/g, '_');
  if (cardResult.state === 'ambiguous') return ambiguous(`1a_${cardKey}_card`);

  const cardFields = cardResult.state === 'available' && Array.isArray(cardResult.card.fields)
    ? cardResult.card.fields
    : [];
  const visibleFields = !cardOnly && Array.isArray(shallow.details.visibleFormFields)
    ? shallow.details.visibleFormFields
    : [];
  const cardMatches = cardFields.filter((field) => field?.name === name);
  const visibleMatches = visibleFields.filter((field) => field?.name === name);
  if (cardMatches.length > 1 || visibleMatches.length > 1) {
    return {
      state: 'ambiguous',
      reason: 'duplicate_field',
      sources: [
        ...(cardMatches.length > 1 ? [`1a_${cardKey}_card`] : []),
        ...(visibleMatches.length > 1 ? ['1a_visible_form'] : []),
      ],
    };
  }
  if (cardMatches.length === 0 && visibleMatches.length === 0 && name === 'children' && cardTitle === 'Stay') {
    return readCombinedChildCount(shallow);
  }
  if (cardMatches.length === 0 && visibleMatches.length === 0) {
    return unavailable(cardResult.reason || 'field_not_rendered');
  }

  if (cardMatches.length === 1 && visibleMatches.length === 1) {
    const relation = compareDisplayed(cardMatches[0].value, visibleMatches[0].value, {
      name, money, currencyCode,
    });
    if (relation !== 'same') {
      return {
        state: 'ambiguous',
        reason: relation === 'different' ? '1a_field_views_disagree' : ambiguityReason(relation, money),
        sources: [`1a_${cardKey}_card`, '1a_visible_form'],
      };
    }
    return {
      ...classified(cardMatches[0].value, `1a_${cardKey}_card`, money),
      sources: [`1a_${cardKey}_card`, '1a_visible_form'],
    };
  }
  if (cardMatches.length === 1) return classified(cardMatches[0].value, `1a_${cardKey}_card`, money);
  return classified(visibleMatches[0].value, '1a_visible_form', money);
}

function readCombinedChildCount(shallow) {
  const adults = readShallowField(shallow, 'adults');
  if (adults.state === 'ambiguous') {
    return { ...adults, reason: 'combined_occupancy_source_ambiguous' };
  }
  if (adults.state !== 'observed') return unavailable();
  const occupancy = parseOccupancyDisplay(adults.value);
  if (occupancy?.children !== null && occupancy?.children !== undefined) {
    return {
      state: 'observed',
      value: occupancy.children,
      sources: adults.sources,
      derivedFrom: 'combined_adult_child_display',
    };
  }
  if (/\bChild(?:ren)?\b/i.test(adults.value)) {
    return {
      state: 'ambiguous',
      reason: 'combined_occupancy_format_unrecognized',
      sources: adults.sources,
    };
  }
  return unavailable();
}

function readRecordField(record, name, money = false) {
  const fields = record?.details?.fields;
  if (!Array.isArray(fields)) return unavailable('record_fields_unavailable');
  const matches = fields.filter((field) => field?.name === name);
  if (matches.length > 1) return ambiguous('1b_record_view');
  if (matches.length === 0) return unavailable();
  return classified(matches[0].value, '1b_record_view', money);
}

function reconcileCancellationStatus(shallow, record) {
  const shallowStatus = readShallowField(shallow, 'status');
  const decoration = shallowStatus.state === 'observed' && shallowStatus.sources.includes('1a_stay_card')
    ? /^Cancelled\r?\n(\d{7})$/.exec(shallowStatus.value)
    : null;
  if (!decoration) return reconcileField(shallow, record, 'status');

  const recordStatus = readRecordField(record, 'status');
  const recordCancellationNumber = readRecordField(record, 'cancelnumber');
  const sources = [...new Set([
    ...shallowStatus.sources, ...recordStatus.sources, ...recordCancellationNumber.sources,
  ])];
  if (recordStatus.state === 'ambiguous' || recordCancellationNumber.state === 'ambiguous') {
    return { state: 'ambiguous', reason: 'duplicate_field', sources };
  }

  const statusMatches = recordStatus.state === 'observed' && recordStatus.value === 'Cancelled';
  const numberMatches = recordCancellationNumber.state === 'observed' &&
    recordCancellationNumber.value === decoration[1];
  if (statusMatches && numberMatches) {
    return { state: 'observed', value: 'Cancelled', sources, normalization: 'verified_1b_status_and_cancelnumber' };
  }

  const disagrees = (recordStatus.state !== 'unavailable' && !statusMatches) ||
    (recordCancellationNumber.state !== 'unavailable' && !numberMatches);
  return disagrees
    ? { state: 'conflict', reason: 'reader_values_disagree', values: [shallowStatus.value, recordStatus.value ?? null], sources }
    : { state: 'ambiguous', reason: 'cancellation_status_decoration_not_reconciled', sources };
}

function reconcileCancellationNumber(shallow, record) {
  const status = readShallowField(shallow, 'status');
  const number = readRecordField(record, 'cancelnumber');
  const match = status.state === 'observed' && status.sources.includes('1a_stay_card')
    ? /^Cancelled\r?\n(\d{7})$/.exec(status.value)
    : null;
  if (!match || number.state === 'unavailable' || number.state === 'ambiguous') return number;
  const sources = [...new Set([...status.sources, ...number.sources])];
  return number.value === match[1] ? { ...number, sources } : {
    state: 'conflict', reason: 'reader_values_disagree', values: [match[1], number.value], sources,
  };
}

function reconcileField(shallow, record, name, { money = false, cardTitle = 'Stay', currencyCode } = {}) {
  const first = readShallowField(shallow, name, money, cardTitle, currencyCode);
  const second = readRecordField(record, name, money);
  if (first.state === 'ambiguous' || second.state === 'ambiguous') {
    return {
      state: 'ambiguous',
      reason: first.state === 'ambiguous' ? first.reason : second.reason,
      sources: [...new Set([...first.sources, ...second.sources])],
    };
  }

  const hasFirst = first.state !== 'unavailable';
  const hasSecond = second.state !== 'unavailable';
  if (hasFirst && hasSecond) {
    const relation = compareDisplayed(first.value, second.value, { name, money, currencyCode });
    if (relation === 'different') {
      return {
        state: 'conflict',
        reason: 'reader_values_disagree',
        values: [first.value, second.value],
        sources: [...new Set([...first.sources, ...second.sources])],
      };
    }
    if (relation !== 'same') {
      return {
        state: 'ambiguous',
        reason: ambiguityReason(relation, money),
        values: [first.value, second.value],
        sources: [...new Set([...first.sources, ...second.sources])],
      };
    }
    const chosen = second;
    return { ...chosen, sources: [...new Set([...first.sources, ...second.sources])] };
  }
  if (hasSecond) return second;
  if (hasFirst) return first;
  return unavailable(first.reason === 'field_not_rendered' && second.reason === 'field_not_rendered'
    ? 'field_not_rendered'
    : first.reason || second.reason || 'field_not_rendered');
}

function moneyDisplay(shallow, record, amountName, currencyName = null) {
  const currency = currencyName
    ? readRecordField(record, currencyName)
    : unavailable('currency_not_exposed');
  return {
    amount: reconcileField(shallow, record, amountName, {
      money: true,
      ...(currency.state === 'observed' ? { currencyCode: currency.value } : {}),
    }),
    currency,
    basis: 'stay360_display_only_not_ledger',
  };
}

/**
 * Project existing 1A + 1B reader results for human review. This function is
 * deliberately pure: it never opens a cancellation form or contacts HMS.
 */
export function projectCancellationPreflight({
  confirmation,
  requestedScope = 'unspecified',
  shallow,
  record,
} = {}) {
  const wanted = typeof confirmation === 'string' ? confirmation.trim() : '';
  if (!wanted || wanted.length > 128 || /[\r\n]/.test(wanted)) {
    return { outcome: 'input_gap', issue: 'CONFIRMATION_INVALID' };
  }
  if (!REQUESTED_SCOPES.has(requestedScope)) {
    return { outcome: 'input_gap', issue: 'REQUESTED_SCOPE_INVALID' };
  }

  if (shallow?.ok !== true || shallow.confirmation !== wanted ||
      shallow.details?.confirmationInHeader !== wanted) {
    return unverified('SHALLOW_TARGET_MISMATCH');
  }
  if (shallow.searchResults?.complete !== true) return unverified('SHALLOW_RESULTS_INCOMPLETE');
  if (!Array.isArray(shallow.details.cards) || shallow.details.cards.length === 0) {
    return unverified('SHALLOW_DETAILS_UNVERIFIED');
  }
  if (record?.details?.confirmationInRecord !== wanted) return unverified('RECORD_TARGET_MISMATCH');
  if (record.details.activeTab !== 'Record View' || !Array.isArray(record.details.fields)) {
    return unverified('RECORD_VIEW_UNVERIFIED');
  }

  return {
    outcome: 'prepared_for_human_review',
    target: { confirmation: wanted, verified: true },
    stay: {
      status: reconcileCancellationStatus(shallow, record),
      arrivalDate: reconcileField(shallow, record, 'arrivaldate'),
      departureDate: reconcileField(shallow, record, 'departuredate'),
      nights: reconcileField(shallow, record, 'nights'),
      cancellationNumber: reconcileCancellationNumber(shallow, record),
      guaranteeType: reconcileField(shallow, record, 'guaranteetype'),
      ratePlan: reconcileField(shallow, record, 'rateplan'),
      adults: reconcileField(shallow, record, 'adults'),
      children: reconcileField(shallow, record, 'children'),
    },
    party: {
      bookingAgency: reconcileField(shallow, record, 'ta1', { cardTitle: 'Associations' }),
      organization: reconcileField(shallow, record, 'company', { cardTitle: 'Associations' }),
      group: reconcileField(shallow, record, 'groupname', { cardTitle: 'Associations' }),
    },
    roomScope: {
      requested: requestedScope,
      room: reconcileField(shallow, record, 'room'),
      scheduledRoom: readRecordField(record, 'scheduledroom'),
      roomType: reconcileField(shallow, record, 'roomtype'),
      roomTypeForCharge: reconcileField(shallow, record, 'roomtypecharge'),
      state: 'unresolved',
      complete: false,
      reason: 'reader_does_not_prove_complete_room_or_stay_scope',
    },
    money: {
      balance: moneyDisplay(shallow, record, 'balance', 'balancecurr'),
      grandTotal: moneyDisplay(shallow, record, 'grandtotal', 'grandtotalcurr'),
      totalRate: moneyDisplay(shallow, record, 'totalrate', 'totalratecurr'),
      averageRate: moneyDisplay(shallow, record, 'averagerate', 'averageratecurr'),
      depositReceived: moneyDisplay(shallow, record, 'depositreceived', 'depositreceivedcurrency'),
      depositDue: moneyDisplay(shallow, record, 'udfchar02'),
      depositDueDate: readRecordField(record, 'udfdate02'),
    },
    folio: {
      basis: '1a_folio_card_display_only',
      balance: readShallowField(shallow, 'foliobalance', true, 'Folio', undefined, true),
      depositReceived: readShallowField(shallow, 'depositreceived', true, 'Folio', undefined, true),
      depositAmount: readShallowField(shallow, 'depositamount', true, 'Folio', undefined, true),
      depositDueDate: readShallowField(shallow, 'depositduedate', false, 'Folio', undefined, true),
      interpretation: {
        ledgerBalance: 'not_established',
        depositCleared: 'not_established',
        depositDue: 'not_verified',
      },
    },
    policy: { state: 'unknown', reason: 'applicable_policy_not_verified_by_1a_or_1b' },
    fee: { state: 'unknown_precommit', amount: null, currency: null },
    action: { actor: 'human', cancellationStarted: false, commitAvailable: false },
  };
}
