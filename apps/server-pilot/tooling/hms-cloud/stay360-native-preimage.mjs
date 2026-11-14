// Bounded, read-only observation of the Ext model behind the selected Record View.
// This is not an approval, a write grant, or proof that an ID is stable across sessions.
const KEYS = ['propertycode', 'confirmationnumber', 'guestid', 'status', 'firstname', 'lastname',
  'arrivaldate', 'departuredate', 'roomtype', 'rateplan', 'adults', 'children',
  'childages', 'sourceofbus', 'reservationstayid', 'reservationid', 'recordid', 'guaranteetype', 'marketsegment', 'companyid', 'company', 'taid1', 'ta1'];
const FORM_KEYS = ['confirmationnumber', 'guestid', 'status', 'firstname', 'lastname', 'arrivaldate',
  'departuredate', 'roomtype', 'rateplan', 'adults', 'children'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const value = (source, key) => {
  if (!object(source) || !Object.hasOwn(source, key) ||
      Object.keys(source).filter((name) => name.toLowerCase() === key.toLowerCase()).length !== 1) return null;
  const raw = source[key];
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  return text.length <= 200 ? text : null;
};
const day = (input, kind) => {
  if (typeof input !== 'string') return null;
  const match = kind === 'model' ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input) : /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(input);
  if (!match) return null;
  const month = kind === 'model' ? Number(match[1]) : MONTHS.indexOf(match[2].toUpperCase()) + 1;
  const date = kind === 'model' ? Number(match[2]) : Number(match[1]);
  const iso = `${match[3]}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
};
const count = (input, max) => /^(0|[1-9]\d*)$/.test(input ?? '') && Number(input) <= max ? Number(input) : null;
const partyName = (source, key) => {
  if (typeof source?.[key] !== 'string' || source[key].length > 200 || /\p{Cc}/u.test(source[key])) return null;
  return value(source, key)?.replace(/\s+/g, ' ') || null;
};
const verifiedParty = (data, controls, idKey, nameKey) => {
  const rawId = data?.[idKey];
  if (typeof rawId === 'number' && !Number.isSafeInteger(rawId)) return null;
  const nativeId = value(data, idKey), name = partyName(data, nameKey);
  if (!nativeId || !/^\d{1,100}$/.test(nativeId) || /^0+$/.test(nativeId) || !name ||
      name !== partyName(controls, nameKey)) return null;
  return { name, nativeId };
};

/** Validates bounded observations from one clean, uniquely selected form. */
export function projectNativeSavedStayPreimage(snapshot, expected, { identityOnly = false } = {}) {
  if (!object(snapshot) || !object(expected) || snapshot.formDirty !== false || snapshot.recordDirty !== false ||
      !Array.isArray(snapshot.dirtyFields) || snapshot.dirtyFields.length ||
      !Array.isArray(snapshot.modifiedFields) || snapshot.modifiedFields.length) return null;
  const data = snapshot.data, form = snapshot.values;
  if (!object(data) || !object(form)) return null;
  const field = (key) => value(data, key);
  if (!expected.confirmation || !expected.propertyCode || field('confirmationnumber') !== expected.confirmation ||
      field('propertycode') !== expected.propertyCode || !/^\d+$/.test(field('guestid') ?? '') ||
      !['reservationstayid', 'reservationid', 'recordid'].every((key) => /^\d+$/.test(field(key) ?? ''))) return null;
  const identityFields = ['confirmationnumber', 'guestid', 'status', 'firstname', 'lastname'];
  if (identityFields.some((key) => !field(key) || field(key) !== value(form, key))) return null;
  const arrival = day(field('arrivaldate'), 'model'), departure = day(field('departuredate'), 'model');
  if (!arrival || !departure || arrival >= departure || day(value(form, 'arrivaldate'), 'form') !== arrival ||
      day(value(form, 'departuredate'), 'form') !== departure) return null;
  const identity = { source: 'record_view_ext_model', propertyCode: expected.propertyCode, confirmation: expected.confirmation,
    reservationStayId: field('reservationstayid'), reservationId: field('reservationid'), recordId: field('recordid'),
    guestId: field('guestid'), status: field('status'), firstName: field('firstname'), lastName: field('lastname'),
    arrival, departure };
  if (identityOnly === true) return identity;
  const paired = ['roomtype', 'rateplan', 'adults', 'children'];
  if (paired.some((key) => !field(key) || field(key) !== value(form, key))) return null;
  const adults = count(field('adults'), 16), children = count(field('children'), 9);
  const bucketKeys = Object.keys(data).filter(key => /^child[1-9]\d*$/.test(key));
  const statusKeys = Object.keys(data).filter(key => /^child[1-9]\d*status$/.test(key));
  if (statusKeys.some(key => !bucketKeys.includes(key.slice(0, -6)))) return null;
  const activeKeys = bucketKeys.filter(key => !statusKeys.length || value(data, `${key}status`) === 'ACTIVE');
  // Infor HMS properties such as HRCEN return the 6-char status `'INACTV'` for disabled child age buckets.
  if (statusKeys.length && bucketKeys.some(key => !['ACTIVE', 'INACTIVE', 'INACTV'].includes(value(data, `${key}status`)))) return null;
  if (activeKeys.some(key => value(form, key) !== null && field(key) !== value(form, key))) return null;
  const bands = activeKeys.map(key => count(field(key), 9));
  if (adults === null || adults < 1 || children === null || bands.some((band) => band === null) ||
      bands.reduce((sum, band) => sum + band, 0) !== children) return null;
  let childAges = 'unknown';
  const ageKeys = Object.keys(data).filter((name) => name.toLowerCase() === 'childages');
  const rawAges = ageKeys.length === 1 && ageKeys[0] === 'childages' ? data.childages : null;
  const ages = Array.isArray(rawAges) ? rawAges : typeof rawAges === 'string' && /^(?:0|[1-9]\d?)(?:,(?:0|[1-9]\d?))*$/.test(rawAges)
    ? rawAges.split(',').map(Number) : null;
  if (ages && Array.from(ages).every((age) => Number.isInteger(age) && age >= 0 && age <= 17) && ages.length === children) childAges = [...ages];
  else if (rawAges === '' && children === 0) childAges = [];
  // Report a guarantee code only when the selected visible control and model agree.
  const guaranteeCode = field('guaranteetype');
  const controlGuarantee = value(snapshot.controls, 'guaranteetype');
  const verifiedGuarantee = guaranteeCode && /^[A-Z0-9]{1,40}$/.test(guaranteeCode) &&
    guaranteeCode === controlGuarantee ? guaranteeCode : null;
  const marketSegmentCode = field('marketsegment');
  const verifiedMarketSegment = marketSegmentCode && /^[A-Z0-9]{1,20}$/.test(marketSegmentCode) &&
    marketSegmentCode === value(snapshot.controls, 'marketsegment') ? marketSegmentCode : null;
  // Party IDs are useful only when the clean model and the unique visible control name agree.
  const company = verifiedParty(data, snapshot.controls, 'companyid', 'company');
  const agency = verifiedParty(data, snapshot.controls, 'taid1', 'ta1');
  const commercial = { ...(company ? { company } : {}), ...(agency ? { agency } : {}) };
  const sourceBusinessCode = field('sourceofbus');
  return { ...identity, roomType: field('roomtype'), ratePlan: field('rateplan'), adults, children, childAges,
    childBands: Object.fromEntries(activeKeys.map((key, index) => [key, bands[index]])),
    ...(rawAges === '' && children === 0 ? { childAgesWire: '' } : {}),
    ...(sourceBusinessCode !== null ? { sourceBusinessCode } : {}),
    ...(verifiedGuarantee ? { guaranteeCode: verifiedGuarantee } : {}),
    ...(verifiedMarketSegment ? { marketSegmentCode: verifiedMarketSegment } : {}),
    ...(company || agency ? { commercial } : {}) };
}

/** Observe only allowlisted fields, not the full model, which can contain credentials and card data. */
export async function readNativeSavedStayPreimage(frame, expected, options = {}) {
  const snapshot = await frame.evaluate(({ keys, formKeys }) => {
    const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) &&
      getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const guests = [...document.querySelectorAll('input[name="guestid"]')].filter(visible);
    if (guests.length !== 1) return null;
    const panel = globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form');
    const form = panel?.getForm?.(), record = panel?.getRecord?.(), fields = form?.getFields?.()?.items;
    const values = form?.getValues?.(), data = record?.data;
    if (!panel?.el?.dom || !panel.el.dom.contains(guests[0]) || !values || !data || !Array.isArray(fields) ||
        !fields.length || typeof form.isDirty !== 'function' || typeof record.dirty !== 'boolean' ||
        fields.some((field) => typeof field.isDirty !== 'function' || !(field.getName?.() || field.name))) return null;
    const pick = (source, wanted) => {
      const result = {};
      const dynamic = Object.keys(source).filter(key => /^child[1-9]\d*(?:status|label)?$/.test(key));
      for (const key of new Set([...wanted, ...dynamic])) {
        const matches = Object.keys(source).filter((name) => name.toLowerCase() === key.toLowerCase());
        if (matches.length !== 1 || matches[0] !== key) continue;
        const item = source[key];
        if (typeof item === 'string' || typeof item === 'number' ||
            (key === 'childages' && Array.isArray(item) && item.every((n) => typeof n === 'number'))) result[key] = item;
      }
      return result;
    };
    let guarantee = null;
    try {
      const inputs = [...document.querySelectorAll('input,textarea,select')]
        .filter((el) => typeof el.name === 'string' && el.name.toLowerCase() === 'guaranteetype' && visible(el));
      if (inputs.length === 1 && inputs[0].name === 'guaranteetype' && panel.el.dom.contains(inputs[0])) {
        const control = globalThis.Ext?.getCmp?.(inputs[0].id.replace(/-inputEl$/, ''));
        const selected = control?.getValue?.();
        if (fields.includes(control) && (control.getName?.() || control.name) === 'guaranteetype' &&
            (typeof selected === 'string' || typeof selected === 'number')) guarantee = selected;
      }
    } catch { /* Missing or ambiguous guarantee evidence stays unknown. */ }
    let marketSegment = null;
    try {
      const inputs = [...document.querySelectorAll('input,textarea,select')]
        .filter(el => typeof el.name === 'string' && el.name.toLowerCase() === 'marketsegment' && visible(el));
      if (inputs.length === 1 && inputs[0].name === 'marketsegment' && panel.el.dom.contains(inputs[0])) {
        const control = globalThis.Ext?.getCmp?.(inputs[0].id.replace(/-inputEl$/, ''));
        const selected = control?.getValue?.();
        if (fields.includes(control) && (control.getName?.() || control.name) === 'marketsegment' &&
            (typeof selected === 'string' || typeof selected === 'number')) marketSegment = selected;
      }
    } catch { /* Missing or ambiguous evidence remains unknown. */ }
    const partyControl = (name) => {
      const inputs = [...document.querySelectorAll('input,textarea,select')]
        .filter((el) => typeof el.name === 'string' && el.name.toLowerCase() === name && visible(el));
      return inputs.length === 1 && inputs[0].name === name && panel.el.dom.contains(inputs[0]) &&
        typeof inputs[0].value === 'string' ? inputs[0].value : null;
    };
    return { data: pick(data, keys), values: pick(values, formKeys),
      controls: { guaranteetype: guarantee, marketsegment: marketSegment, company: partyControl('company'), ta1: partyControl('ta1') },
      formDirty: form.isDirty(), recordDirty: record.dirty,
      dirtyFields: fields.filter((field) => field.isDirty()).map((field) => field.getName?.() || field.name),
      modifiedFields: Object.keys(record.modified || {}) };
  }, { keys: KEYS, formKeys: FORM_KEYS });
  return projectNativeSavedStayPreimage(snapshot, expected, options);
}
