// A deliberately narrow price check for the first fake amend. It is not live
// evidence that HMS applies or persists the retain choice.
const REQUIRED = ['averagenightly', 'averagerate', 'grandtotal', 'totalrate', 'totalratewithtax', 'guesttotal', 'tax', 'guesttax'];
const OTHER = ['ratetax', 'totalcomptaxamount', 'enhancedexptotal', 'guesttotalwithtax', 'guesttotalresortfee',
  'total', 'totalresortfee', 'resortfee', 'totalguestcomptaxamount', 'totalcharges', 'totalpayments',
  'totalcompamount', 'totalguestcompamount', 'totallease', 'totalleasetax', 'activitiestotal'];
const object = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const unique = (value) => object(value) && new Set(Object.keys(value).map((name) => name.toLowerCase())).size === Object.keys(value).length;
const date = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const day = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value ? day : null;
};

/** Only one night before and after, the same rate plan and explicit retain=yes. */
export function isOneNightRetainAmend(selected, changes) {
  if (!object(selected) || !object(changes) ||
      Object.keys(changes).some((key) => !['arrival', 'departure', 'adults', 'ratePlan', 'retainRates'].includes(key)) ||
      !Number.isInteger(selected.adults) || !Number.isInteger(changes.adults ?? selected.adults) ||
      selected.adults < 1 || selected.adults > 16 || (changes.adults ?? selected.adults) < 1 ||
      (changes.adults ?? selected.adults) > 16 || !/^[A-Z0-9]{1,12}$/.test(selected.ratePlan || '') ||
      changes.ratePlan !== selected.ratePlan || changes.retainRates !== 'yes') return false;
  const arrival = date(selected.arrival), departure = date(selected.departure),
    newArrival = date(changes.arrival ?? selected.arrival), newDeparture = date(changes.departure ?? selected.departure);
  return arrival !== null && departure !== null && newArrival !== null && newDeparture !== null &&
    selected.arrival >= '2027-01-01' && (changes.arrival ?? selected.arrival) >= '2027-01-01' &&
    departure - arrival === 86_400_000 && newDeparture - newArrival === 86_400_000 &&
    (newArrival !== arrival || newDeparture !== departure || (changes.adults ?? selected.adults) !== selected.adults);
}

// Normalize decimal amounts without floating-point or guessing a locale. HMS
// model values are plain decimals; its visible values may contain comma groups.
function cents(raw) {
  if (!['string', 'number'].includes(typeof raw)) return null;
  const text = String(raw).trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, decimal = ''] = text.replaceAll(',', '').split('.');
  if (whole.length > 15) return null;
  return (BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'))).toString();
}

function amount(source, key) {
  if (!Object.hasOwn(source, key)) return { state: 'missing' };
  if (source[key] === null) return { state: 'null' };
  if (source[key] === '') return { state: 'blank' };
  const value = cents(source[key]);
  return value === null ? null : { state: 'amount', cents: value };
}
function currency(source, key) {
  if (!Object.hasOwn(source, key)) return { state: 'missing' };
  if (source[key] === null) return { state: 'null' };
  if (source[key] === '') return { state: 'blank' };
  if (typeof source[key] !== 'string' || !/^[A-Z]{3}$/.test(source[key])) return null;
  return { state: 'currency', code: source[key] };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Project only financial fields, retaining absent/blank distinctions. */
export function oneNightRetainPrices(snapshot) {
  if (!unique(snapshot?.data) || !unique(snapshot?.values)) return null;
  const out = { version: 1, currency: null, fields: {} };
  for (const name of [...REQUIRED, ...OTHER]) {
    const data = amount(snapshot.data, name), visible = amount(snapshot.values, name);
    const dataCurrency = currency(snapshot.data, `${name}curr`), visibleCurrency = currency(snapshot.values, `${name}curr`);
    if (!data || !visible || !dataCurrency || !visibleCurrency) return null;
    if (REQUIRED.includes(name)) {
      if (data.state !== 'amount' || !same(data, visible) || dataCurrency.state !== 'currency' ||
          !same(dataCurrency, visibleCurrency) || (out.currency !== null && out.currency !== dataCurrency.code)) return null;
      out.currency = dataCurrency.code;
    } else {
      if (data.state === 'amount' && visible.state === 'amount' && !same(data, visible)) return null;
      if (dataCurrency.state === 'currency' && visibleCurrency.state === 'currency' && !same(dataCurrency, visibleCurrency)) return null;
    }
    out.fields[name] = { data, visible, dataCurrency, visibleCurrency };
  }
  return out;
}

/** The preceding staff lookup and native preimage must describe the same price. */
export function oneNightRetainPricesMatchObservations(approved, financial) {
  if (!object(approved) || !object(approved.fields) || !object(financial) ||
      typeof approved.currency !== 'string' || !/^[A-Z]{3}$/.test(approved.currency)) return false;
  for (const [observedName, nativeName] of [['averageRate', 'averagerate'], ['grandTotal', 'grandtotal'], ['totalRate', 'totalrate']]) {
    const observation = financial[observedName], saved = approved.fields[nativeName]?.data;
    if (observation?.amount?.state !== 'observed' || typeof observation.amount.value !== 'string' ||
        observation?.currency?.state !== 'observed' || observation.currency.value !== approved.currency ||
        saved?.state !== 'amount' || typeof saved.cents !== 'string') return false;
    let value = observation.amount.value.trim();
    const prefix = /^(ZAR|R)\s*/i.exec(value);
    if (prefix) {
      if (approved.currency !== 'ZAR') return false;
      value = value.slice(prefix[0].length);
    }
    if (cents(value) !== saved.cents) return false;
  }
  return true;
}

/** The response and both snapshots must support the exact retained price. */
export function oneNightRetainAvailabilityMatches(response, before, after, selected, changes) {
  const data = response?.pageData;
  if (!isOneNightRetainAmend(selected, changes) || !object(data) || data.success !== true ||
      (data.messages !== undefined && (!Array.isArray(data.messages) || data.messages.length !== 0))) return false;
  const first = oneNightRetainPrices(before), second = oneNightRetainPrices(after);
  return Boolean(first && second && same(first, second));
}

export function oneNightRetainReadbackMatches(approved, readback, selected, changes) {
  const observed = oneNightRetainPrices(readback);
  return Boolean(isOneNightRetainAmend(selected, changes) && object(approved) && observed && same(approved, observed));
}
