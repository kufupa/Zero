import type {
  PaneStayCommercial,
  PaneStayFields,
  PaneStayFindInput,
  PaneStayFindResult,
} from './pane-stay-lookup.js';
import type { HmsReadTarget } from '../hms/hms-read-target.js';

export type CloudStayRunInput = {
  request: PaneStayFindInput;
  target: HmsReadTarget;
  signal?: AbortSignal;
};

export type HmsCloudFieldObservation = { state: 'observed' | 'blank' | 'unknown'; value: string | null };
export type HmsCloudMoneyObservation = { amount: HmsCloudFieldObservation; currency: HmsCloudFieldObservation };
export type HmsCloudFinancialObservations = {
  averageRate: HmsCloudMoneyObservation;
  grandTotal: HmsCloudMoneyObservation;
  balance: HmsCloudMoneyObservation;
  depositReceived: HmsCloudMoneyObservation;
  depositDueAmount: HmsCloudMoneyObservation;
  addOnTotal: HmsCloudMoneyObservation;
  totalRate: HmsCloudMoneyObservation;
  resortFee: HmsCloudMoneyObservation;
  totalResortFee: HmsCloudMoneyObservation;
};
export type HmsCloudReservationObservations = {
  groupName: HmsCloudFieldObservation;
  promotionCode: HmsCloudFieldObservation;
  arAccountName: HmsCloudFieldObservation;
  bookerName: HmsCloudFieldObservation;
  bookerContact: HmsCloudFieldObservation;
};

export type HmsCloudFindResult = PaneStayFindResult & {
  source: 'hms_cloud_saved_stay';
  /** Full name is kept intact; no heuristic split into first/last name. */
  guestName: string | null;
  /** Record View exposes party display names here, but does not expose native party IDs. */
  commercial?: PaneStayCommercial;
  /** Known stay-level amounts and their displayed currencies; blank differs from unread. */
  financialObservations?: HmsCloudFinancialObservations;
  /** Narrow allowlist of reservation context controls; no broad Record View dump. */
  reservationObservations?: HmsCloudReservationObservations;
  observedAt: string | null;
};

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, 300) : null;
}

function observationTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const source = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(source) ||
      !realDay(source.slice(0, 10))) return null;
  const time = Date.parse(source);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function realDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function parseDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const iso = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:\s+\d{2}:\d{2})?$/);
  if (iso && realDay(iso[1])) return iso[1];
  const display = value.trim().match(/^(?:[A-Za-z]{3}\s+)?(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+\d{2}:\d{2})?$/);
  if (!display) return null;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(display[2]!.toLowerCase());
  if (month < 0) return null;
  const date = new Date(Date.UTC(Number(display[3]), month, Number(display[1])));
  return date.getUTCFullYear() === Number(display[3]) && date.getUTCMonth() === month && date.getUTCDate() === Number(display[1])
    ? date.toISOString().slice(0, 10)
    : null;
}

function parseCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function recordFields(raw: unknown): Array<RecordValue> {
  const root = record(raw);
  const details = record(root?.details);
  if (!Array.isArray(details?.fields)) return [];
  return details.fields.map(record).filter((field): field is RecordValue => field !== null);
}

function matchingField(
  fields: Array<RecordValue>,
  names: readonly string[],
  labels: readonly string[] = [],
): RecordValue | null {
  const byName = fields.filter((field) => {
    const name = text(field.name)?.toLowerCase();
    return Boolean(name && names.includes(name));
  });
  const matches = byName.length ? byName : fields.filter((field) => {
    const label = text(field.label)?.toLowerCase();
    return Boolean(label && labels.some((expected) => label === expected.toLowerCase()));
  });
  return matches.length === 1 ? matches[0]! : null;
}

function fieldText(fields: Array<RecordValue>, names: readonly string[], labels: readonly string[] = []): string | null {
  const field = matchingField(fields, names, labels);
  return typeof field?.value === 'string' ? field.value.replace(/\s+/g, ' ').trim() : null;
}

function fieldObservation(fields: Array<RecordValue>, names: readonly string[]): HmsCloudFieldObservation {
  const field = matchingField(fields, names);
  if (!field || typeof field.value !== 'string') return { state: 'unknown', value: null };
  const value = field.value.replace(/\s+/g, ' ').trim();
  if (value.length > 300) return { state: 'unknown', value: null };
  return value ? { state: 'observed', value } : { state: 'blank', value: '' };
}

function moneyAmountObservation(fields: Array<RecordValue>, name: string): HmsCloudFieldObservation {
  const observed = fieldObservation(fields, [name]);
  if (observed.state !== 'observed' || observed.value === null) return observed;
  const value = observed.value;
  const numeric = value.replace(/^(?:(?:[A-Z]{3}|[$£€R])\s*)/i, '').trim();
  return value.length <= 60 && /^(?=.*\d)[+-]?\d[\d,. ]*$/.test(numeric)
    ? observed
    : { state: 'unknown', value: null };
}

function moneyCurrencyObservation(fields: Array<RecordValue>, name?: string): HmsCloudFieldObservation {
  if (!name) return { state: 'unknown', value: null };
  const observed = fieldObservation(fields, [name]);
  if (observed.state !== 'observed' || observed.value === null) return observed;
  return /^[A-Za-z]{3}$/.test(observed.value)
    ? { state: 'observed', value: observed.value.toUpperCase() }
    : { state: 'unknown', value: null };
}

function moneyObservation(
  fields: Array<RecordValue>,
  amountName: string,
  currencyName?: string,
): HmsCloudMoneyObservation {
  return {
    amount: moneyAmountObservation(fields, amountName),
    currency: moneyCurrencyObservation(fields, currencyName),
  };
}

function amountText(fields: Array<RecordValue>, name: string): string | null {
  const amount = moneyAmountObservation(fields, name);
  return amount.state === 'unknown' ? null : amount.value;
}

function financialObservations(fields: Array<RecordValue>): HmsCloudFinancialObservations {
  return {
    averageRate: moneyObservation(fields, 'averagerate', 'averageratecurr'),
    grandTotal: moneyObservation(fields, 'grandtotal', 'grandtotalcurr'),
    balance: moneyObservation(fields, 'balance', 'balancecurr'),
    depositReceived: moneyObservation(fields, 'depositreceived', 'depositreceivedcurrency'),
    depositDueAmount: moneyObservation(fields, 'udfchar02'),
    addOnTotal: moneyObservation(fields, 'enhancedexptotal', 'enhancedexptotalcurr'),
    totalRate: moneyObservation(fields, 'totalrate', 'totalratecurr'),
    resortFee: moneyObservation(fields, 'resortfee'),
    totalResortFee: moneyObservation(fields, 'totalresortfee'),
  };
}

function reservationObservations(fields: Array<RecordValue>): HmsCloudReservationObservations {
  return {
    groupName: fieldObservation(fields, ['groupname']),
    promotionCode: fieldObservation(fields, ['promotioncode']),
    arAccountName: fieldObservation(fields, ['araccountname']),
    bookerName: fieldObservation(fields, ['caller']),
    bookerContact: fieldObservation(fields, ['udfchar06']),
  };
}

function paneStayFields(confirmation: string, fields: Array<RecordValue>): PaneStayFields {
  return {
    status: fieldText(fields, ['status', 'reservationstaystatus'], ['status', 'reservation status']),
    confirmation,
    lastName: fieldText(fields, ['lastname', 'guestlastname'], ['last name']),
    firstName: fieldText(fields, ['firstname', 'guestfirstname'], ['first name']),
    arrival: parseDate(fieldText(fields, ['arrivaldate'], ['arrival date'])),
    departure: parseDate(fieldText(fields, ['departuredate'], ['departure date'])),
    nights: parseCount(fieldText(fields, ['nights'], ['nights'])),
    adults: parseCount(fieldText(fields, ['adults'], ['adults'])),
    children: parseCount(fieldText(fields, ['children', 'childcount'], ['children'])),
    roomType: fieldText(fields, ['roomtype', 'roomtypecode'], ['room type']),
    ratePlan: fieldText(fields, ['rateplan', 'rateplancode'], ['rate plan']),
    mealPlan: fieldText(fields, ['mealplan'], ['meal plan']),
    averageRate: amountText(fields, 'averagerate'),
    grandTotal: amountText(fields, 'grandtotal'),
    balance: amountText(fields, 'balance'),
    sourceOfBusiness: fieldText(fields, ['sourceofbusinessdesc'], ['source of business']),
    guaranteeType: fieldText(fields, ['guaranteetype'], ['guarantee type']),
    depositReceived: amountText(fields, 'depositreceived'),
    bookingAgency: fieldText(fields, ['ta1', 'bookingagency'], ['primary booking agency', 'booking agency']),
    organization: fieldText(fields, ['company', 'organization'], ['organization', 'company']),
  };
}

function paneStayCommercial(stay: PaneStayFields): PaneStayCommercial | undefined {
  const company = stay.organization?.trim();
  const agency = stay.bookingAgency?.trim();
  const commercial: PaneStayCommercial = {};
  if (company) commercial.company = { name: company };
  if (agency) commercial.agency = { name: agency };
  return Object.keys(commercial).length ? commercial : undefined;
}

/** Exact-confirmation projection; raw Record View fields never enter the persisted job result. */
export function projectCloudStayFind(request: PaneStayFindInput, raw: unknown): HmsCloudFindResult {
  const root = record(raw);
  const shallow = record(root?.shallow);
  if (root?.outcome === 'ok' && shallow) {
    const confirmation = text(shallow.confirmation);
    const details = record(root.record);
    const fields = recordFields(details);
    const complete = record(shallow.searchResults)?.complete === true;
    if (confirmation !== request.confirmation || !complete || !fields.length) {
      return {
        outcome: 'execution_failure', reason: 'SAVED_STAY_READBACK_UNVERIFIED', stay: null,
        arrivalMismatch: false, requestedArrival: request.arrival ?? null, hmsArrival: null,
        screenshots: [], runId: null, source: 'hms_cloud_saved_stay', guestName: null,
        observedAt: observationTimestamp(root.observedAt),
      };
    }
    const stay = paneStayFields(confirmation, fields);
    const guestName = fieldText(fields, ['guestfullname', 'guestname'], ['guest name', 'name']);
    const commercial = paneStayCommercial(stay);
    return {
      outcome: 'found', reason: null, stay,
      ...(commercial ? { commercial } : {}),
      financialObservations: financialObservations(fields),
      reservationObservations: reservationObservations(fields),
      arrivalMismatch: Boolean(request.arrival && stay.arrival && request.arrival !== stay.arrival),
      requestedArrival: request.arrival ?? null, hmsArrival: stay.arrival,
      screenshots: [], runId: null, source: 'hms_cloud_saved_stay', guestName,
      observedAt: observationTimestamp(root.observedAt),
    };
  }
  const issue = text(root?.issue) ?? 'SAVED_STAY_READ_FAILED';
  if (issue === 'CONFIRMATION_NOT_FOUND') {
    return { outcome: 'not_found', reason: issue, stay: null, arrivalMismatch: false,
      requestedArrival: request.arrival ?? null, hmsArrival: null, screenshots: [], runId: null,
      source: 'hms_cloud_saved_stay', guestName: null, observedAt: observationTimestamp(root?.observedAt) };
  }
  if (['AMBIGUOUS_CONFIRMATION', 'SEARCH_RESULTS_CAPPED', 'CONFIRMATION_HINT_UNVERIFIED', 'SEARCH_RESULTS_CHANGED'].includes(issue)) {
    return { outcome: 'ambiguous', reason: issue, stay: null, arrivalMismatch: false,
      requestedArrival: request.arrival ?? null, hmsArrival: null, screenshots: [], runId: null,
      source: 'hms_cloud_saved_stay', guestName: null, observedAt: observationTimestamp(root?.observedAt) };
  }
  if (root?.outcome === 'input_gap' || issue.startsWith('INVALID_')) {
    return { outcome: 'refused_input_invalid', reason: issue, stay: null, arrivalMismatch: false,
      requestedArrival: request.arrival ?? null, hmsArrival: null, screenshots: [], runId: null,
      source: 'hms_cloud_saved_stay', guestName: null, observedAt: observationTimestamp(root?.observedAt) };
  }
  return { outcome: 'execution_failure', reason: issue, stay: null, arrivalMismatch: false,
    requestedArrival: request.arrival ?? null, hmsArrival: null, screenshots: [], runId: null,
    source: 'hms_cloud_saved_stay', guestName: null, observedAt: observationTimestamp(root?.observedAt) };
}

export function stampCloudStayReadResult(
  raw: unknown,
  fallbackObservedAt = new Date().toISOString(),
): unknown {
  const source = record(raw);
  if (!source) return raw;
  return {
    ...source,
    observedAt: observationTimestamp(source.observedAt) ??
      observationTimestamp(fallbackObservedAt) ?? new Date().toISOString(),
  };
}

export async function runCloudStayFind(input: CloudStayRunInput): Promise<unknown> {
  const sessionUrl = new URL('../../tooling/hms-cloud/saved-stay-agent-session.mjs', import.meta.url);
  const module = await import(sessionUrl.href) as {
    withSavedStayAgentSession: <T>(operation: (session: { runTool: (request: Record<string, unknown>) => Promise<unknown> }) => Promise<T>, options?: { signal?: AbortSignal }) => Promise<T>;
  };
  return module.withSavedStayAgentSession(async (session) => {
    // A fallback timestamp bounds the observation from before the read begins.
    const readStartedAt = new Date().toISOString();
    const result = await session.runTool({
      tool: 'read',
      confirmation: input.request.confirmation,
      ...(input.request.arrival ? { arrivalDate: input.request.arrival } : {}),
      view: 'record',
    });
    return stampCloudStayReadResult(result, readStartedAt);
  }, { signal: input.signal });
}
