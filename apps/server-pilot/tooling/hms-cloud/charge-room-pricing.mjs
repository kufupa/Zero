// Compare displayed native amounts without floating-point rounding.
const amount = value => {
  if (!['string', 'number'].includes(typeof value)) return null;
  const text = String(value).trim().replace(/^(?:ZAR|R)\s*/i, '').replace(/\s*ZAR$/i, '');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,4})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.replaceAll(',', '').split('.');
  if (whole.length > 12) return null;
  return (BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'))).toString();
};
const currency = value => {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return code === 'R' ? 'ZAR' : /^[A-Z]{3}$/.test(code) ? code : null;
};
const unique = (fields, name) => {
  const found = fields.filter(field => field.name === name);
  return found.length === 1 ? found[0].value : null;
};

/** Missing or ambiguous readback never becomes a successful price match. */
export function compareChargeRoomPricing(fields, checked) {
  if (!Array.isArray(fields)) fields = [];
  const compare = (name, expected) => {
    const before = amount(expected), after = amount(unique(fields, name));
    return before === null || after === null ? 'UNKNOWN' : before === after ? 'MATCHED' : 'CHANGED';
  };
  const wantedCurrency = currency(checked?.currency);
  const currencyFields = ['averageratecurr', 'totalratecurr'];
  const ambiguousCurrency = currencyFields.some(name => fields.filter(field => field.name === name).length > 1);
  const actualCurrencies = currencyFields.map(name => currency(unique(fields, name)));
  return {
    averageRate: compare('averagerate', checked?.averageRate),
    totalRate: compare('totalrate', checked?.totalRate),
    currency: wantedCurrency && actualCurrencies.some(value => value && value !== wantedCurrency) ? 'CHANGED' :
      ambiguousCurrency || !wantedCurrency || actualCurrencies.some(value => !value) ? 'UNKNOWN' : 'MATCHED',
  };
}

/** Compare the criteria behind a checked price; absent or ambiguous values stay unknown. */
export function compareChargeRoomCriteria(checked, data) {
  const value = (object, name) => {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
    const keys = Object.keys(object).filter(key => key.toLowerCase() === name);
    if (keys.length !== 1) return null;
    const raw = object[keys[0]];
    if (Array.isArray(raw)) return raw.every(Number.isInteger) ? raw.join(',') : null;
    return ['string', 'number'].includes(typeof raw) ? String(raw).trim() : null;
  };
  const compare = (wanted, actual) => wanted == null || actual == null ? 'UNKNOWN' :
    String(wanted).trim() === actual ? 'MATCHED' : 'CHANGED';
  const occupancy = checked?.occupancy;
  const result = {};
  for (const name of ['adults', 'children', 'childages', ...Object.keys(occupancy || {}).filter(key => /^child[1-9]\d*$/.test(key))]) {
    if (['adults', 'children', 'childages'].includes(name) || Object.hasOwn(occupancy || {}, name)) {
      result[name] = compare(occupancy?.[name], value(data, name));
    }
  }
  result.sourceCode = compare(checked?.sourceCode, value(data, 'sourceofbus'));
  return result;
}
