// Read-only commercial fields from the currently opened Guest Stay record. The DOM snapshot is self-contained because
// Playwright serializes it into the HMS page. Field names follow the older DOM and HTTP readers.
import { hmsDateToIso, squash } from './cancel-stay-rules.mjs';

const NON_VALUE_INPUT = /^(hidden|button|submit|reset|image|file|checkbox|radio)$/i;

export function snapshotCommercialFields(doc = document) {
  const names = [
    'status', 'arrivaldate', 'departuredate', 'roomtype', 'rateplan', 'mealplan', 'averagerate', 'track',
    'guaranteetype', 'sourceofbusiness', 'sourceofbusinessdesc', 'marketsegment', 'company', 'companyname',
    'araccountname', 'bookingagency', 'bookingagencyname', 'ta1',
  ];
  const fields = {};
  const controlsFor = (selector) => doc.querySelectorAll
    ? [...doc.querySelectorAll(selector)]
    : [doc.querySelector(selector)].filter(Boolean);
  const shown = (control) => {
    if (control.tagName === 'INPUT' && NON_VALUE_INPUT.test(control.type || '')) {
      return false;
    }
    const box = control.getBoundingClientRect?.();
    return !box || (box.width > 0 && box.height > 0);
  };
  for (const name of names) {
    const controls = ['select', 'input', 'textarea']
      .flatMap((tag) => controlsFor(`${tag}[name="${name}"]`))
      .filter((control) => !(control.tagName === 'INPUT' && NON_VALUE_INPUT.test(control.type || '')));
    // Visible duplicate wins; a populated field in a collapsed record section remains a valid fallback.
    const control = controls.find(shown) ?? controls[0];
    if (!control) continue;
    const kind = control.tagName === 'SELECT' ? 'select' : 'input';
    const value = String(control.value ?? '').trim();
    const selected = kind === 'select'
      ? control.querySelector('option:checked') ?? control.querySelector('option[selected]')
      : null;
    const text = String((selected && (selected.innerText || selected.textContent)) || value)
      .replace(/\s+/g, ' ')
      .trim();
    if (value || text) fields[name] = { value, text, kind };
  }
  return fields;
}

function fieldValue(fields, name) {
  const raw = fields?.[name];
  if (typeof raw === 'string' || typeof raw === 'number') {
    const value = squash(raw);
    return { value, text: value, kind: 'input' };
  }
  if (!raw || typeof raw !== 'object') return { value: '', text: '', kind: '' };
  const value = squash(raw.value);
  return {
    value,
    text: squash(raw.text),
    kind: raw.kind === 'select' ? 'select' : 'input',
  };
}

function firstText(fields, ...names) {
  for (const name of names) {
    const candidate = fieldValue(fields, name);
    const text = candidate.text || candidate.value;
    if (text) return text;
  }
  return undefined;
}

function firstPartyName(fields, ...names) {
  for (const name of names) {
    const candidate = fieldValue(fields, name);
    const text = candidate.kind === 'select' ? candidate.text : candidate.text || candidate.value;
    if (text) return text;
  }
  return undefined;
}

function firstStayText(stay, field, fields, ...names) {
  const text = squash(stay?.[field]);
  return text || firstText(fields, ...names);
}

function numericPartyId(value) {
  return /^\d+$/.test(value);
}

function party(fields, { nameFields, idFields, fallbackName }) {
  const name = firstPartyName(fields, ...nameFields) || squash(fallbackName) || undefined;
  let nativeId;
  for (const field of idFields) {
    const candidate = fieldValue(fields, field);
    if (!candidate.value) continue;
    // Keep a numeric id even when HMS shows it as the name. Otherwise the select's value is the id.
    if (candidate.value !== name || numericPartyId(candidate.value)) {
      nativeId = candidate.value;
      break;
    }
  }
  if (!name && !nativeId) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(nativeId ? { nativeId } : {}),
  };
}

// Existing labeled values win for the fields already shown in the card. Named controls fill gaps and provide the
// selected option's text/native id, so a missing optional control never makes a successful find fail.
/** Named field entries from snapshotRecordForm ({ kind: 'field', name, value }) → the shape parseCommercialFields reads. */
export function commercialFieldsFromFormEntries(entries = []) {
  const fields = {};
  for (const entry of entries) {
    if (entry?.kind !== 'field' || typeof entry.name !== 'string') continue;
    const value = String(entry.value ?? '').replace(/\s+/g, ' ').trim();
    if (value && !fields[entry.name]) fields[entry.name] = { value, text: value, kind: 'input' };
  }
  return fields;
}

export function parseCommercialFields(fields, stay = {}) {
  const commercial = {};
  const company = party(fields, {
    nameFields: ['companyname', 'araccountname', 'company'],
    idFields: ['company'],
    fallbackName: stay.organization,
  });
  const agency = party(fields, {
    nameFields: ['bookingagencyname', 'bookingagency', 'ta1'],
    idFields: ['bookingagency', 'ta1'],
    fallbackName: stay.bookingAgency,
  });
  if (company) commercial.company = company;
  if (agency) commercial.agency = agency;

  const scalar = {
    ratePlan: firstStayText(stay, 'ratePlan', fields, 'rateplan'),
    mealPlan: firstStayText(stay, 'mealPlan', fields, 'mealplan'),
    roomType: firstStayText(stay, 'roomType', fields, 'roomtype'),
    marketSegment: firstText(fields, 'marketsegment', 'track'),
    sourceOfBusiness: firstText(fields, 'sourceofbusinessdesc')
      || firstStayText(stay, 'sourceOfBusiness', fields, 'sourceofbusiness'),
    averageRate: firstStayText(stay, 'averageRate', fields, 'averagerate'),
    status: firstStayText(stay, 'status', fields, 'status'),
  };
  for (const [key, value] of Object.entries(scalar)) {
    if (value) commercial[key] = value;
  }

  const arrival = hmsDateToIso(firstStayText(stay, 'arrival', fields, 'arrivaldate') ?? '');
  const departure = hmsDateToIso(firstStayText(stay, 'departure', fields, 'departuredate') ?? '');
  if (arrival) commercial.arrival = arrival;
  if (departure) commercial.departure = departure;
  return Object.keys(commercial).length > 0 ? commercial : null;
}
