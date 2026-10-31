const REQUESTED_SCOPES = new Set(['whole_stay', 'specific_room', 'unspecified']);
const DISPLAY_CURRENCY_CODES = new Set([
  'AED', 'AUD', 'BHD', 'BWP', 'CAD', 'CHF', 'CNY', 'EGP', 'EUR', 'GBP', 'GHS', 'INR',
  'JPY', 'KES', 'KWD', 'LSL', 'MAD', 'MWK', 'MZN', 'NAD', 'NGN', 'NOK', 'NZD', 'OMR',
  'QAR', 'RWF', 'SAR', 'SEK', 'SGD', 'SZL', 'TZS', 'UGX', 'USD', 'XAF', 'XOF', 'ZAR',
  'ZMW',
]);
const CURRENCY_SYMBOL = /(?:£|\$|€|¥|₹|₦|₱|₫|₩|₺|₽|₴|₪|฿|₡|₲|₵|₭|₮|₼|₾|៛)/u;

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

function explicitZero(value) {
  let numeric = value.trim();
  const prefixSymbol = new RegExp(`^${CURRENCY_SYMBOL.source}\\s*(.+)$`, 'u').exec(numeric);
  const suffixSymbol = new RegExp(`^(.+?)\\s*${CURRENCY_SYMBOL.source}$`, 'u').exec(numeric);
  if (prefixSymbol) numeric = prefixSymbol[1];
  else if (suffixSymbol) numeric = suffixSymbol[1];

  const prefixCode = /^([A-Za-z]{3})\s+(.+)$/.exec(numeric);
  const suffixCode = /^(.+?)\s+([A-Za-z]{3})$/.exec(numeric);
  if (prefixCode && DISPLAY_CURRENCY_CODES.has(prefixCode[1].toUpperCase())) numeric = prefixCode[2];
  else if (suffixCode && DISPLAY_CURRENCY_CODES.has(suffixCode[2].toUpperCase())) numeric = suffixCode[1];

  return /^[+-]?(?:0+(?:[.,]0*)?|[.,]0+)$/.test(numeric.trim());
}

function comparable(left, right, money) {
  const a = displayString(left);
  const b = displayString(right);
  if (a === null || b === null) return false;
  if (a === '' || b === '') return a === b;
  if (money && explicitZero(a) && explicitZero(b)) return true;
  return a.replace(/\s+/g, ' ').toLocaleLowerCase() === b.replace(/\s+/g, ' ').toLocaleLowerCase();
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

function readShallowField(shallow, name, money = false, cardTitle = 'Stay') {
  const cardResult = namedCard(shallow, cardTitle);
  const cardKey = cardTitle.trim().toLowerCase().replace(/\s+/g, '_');
  if (cardResult.state === 'ambiguous') return ambiguous(`1a_${cardKey}_card`);

  const cardFields = cardResult.state === 'available' && Array.isArray(cardResult.card.fields)
    ? cardResult.card.fields
    : [];
  const visibleFields = Array.isArray(shallow.details.visibleFormFields)
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
  if (cardMatches.length === 0 && visibleMatches.length === 0) {
    return unavailable(cardResult.reason || 'field_not_rendered');
  }

  if (cardMatches.length === 1 && visibleMatches.length === 1) {
    if (!comparable(cardMatches[0].value, visibleMatches[0].value, money)) {
      return {
        state: 'ambiguous',
        reason: '1a_field_views_disagree',
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

function readRecordField(record, name, money = false) {
  const fields = record?.details?.fields;
  if (!Array.isArray(fields)) return unavailable('record_fields_unavailable');
  const matches = fields.filter((field) => field?.name === name);
  if (matches.length > 1) return ambiguous('1b_record_view');
  if (matches.length === 0) return unavailable();
  return classified(matches[0].value, '1b_record_view', money);
}

function reconcileField(shallow, record, name, { money = false, cardTitle = 'Stay' } = {}) {
  const first = readShallowField(shallow, name, money, cardTitle);
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
    if (!comparable(first.value, second.value, money)) {
      return {
        state: 'conflict',
        reason: 'reader_values_disagree',
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
  return {
    amount: reconcileField(shallow, record, amountName, { money: true }),
    currency: currencyName
      ? readRecordField(record, currencyName)
      : unavailable('currency_not_exposed'),
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
      status: reconcileField(shallow, record, 'status'),
      arrivalDate: reconcileField(shallow, record, 'arrivaldate'),
      departureDate: reconcileField(shallow, record, 'departuredate'),
      nights: reconcileField(shallow, record, 'nights'),
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
    policy: { state: 'unknown', reason: 'applicable_policy_not_verified_by_1a_or_1b' },
    fee: { state: 'unknown_precommit', amount: null, currency: null },
    action: { actor: 'human', cancellationStarted: false, commitAvailable: false },
  };
}
