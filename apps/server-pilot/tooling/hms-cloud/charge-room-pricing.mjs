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
  const actualCurrencies = ['averageratecurr', 'totalratecurr'].map(name => currency(unique(fields, name))).filter(Boolean);
  return {
    averageRate: compare('averagerate', checked?.averageRate),
    totalRate: compare('totalrate', checked?.totalRate),
    currency: !wantedCurrency || !actualCurrencies.length ? 'UNKNOWN' :
      actualCurrencies.every(value => value === wantedCurrency) ? 'MATCHED' : 'CHANGED',
  };
}
