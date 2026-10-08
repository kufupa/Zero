import type { QuoteAmendment } from './types';

/**
 * HMS lookup for amend and cancel mail. Luna reads one booking by its exact confirmation number through
 * paneStayLookup.findStay: a read-only browser run under the session hotel's lock, about 1-2 minutes.
 * The panel calls runHmsFind and nothing else, so the transport can change here. Nothing here changes HMS.
 */

export const AMEND_FIND_COPY = {
  looking: 'Luna is looking up the booking in HMS… (about 1–2 minutes)',
  noNumber: "Luna couldn't find a booking number in the email. Search HMS by name instead.",
  waitingThread: 'Waiting for this email to sync before the HMS lookup can start.',
  notFound:
    'No booking with that number in HMS. Check the number in the email or search HMS by guest name.',
  notExact:
    'HMS needs one exact booking number from the latest email. Check the email or search HMS by guest name.',
  ambiguous: 'HMS matched more than one booking for that number. Check HMS directly.',
  arrivalDiffers: 'HMS shows this booking on another arrival date from the email. Check the dates in HMS directly.',
  busy: 'HMS is busy. Try again in a minute.',
  readFailed: 'Luna could not read the HMS result. Try again in a minute.',
  unavailable: 'The HMS lookup is not connected in this session. Search HMS by hand.',
  seeBooking: 'See the booking in HMS',
  footer: 'Luna only looks the booking up. Make the change in HMS yourself.',
} as const;

/** HMS confirmation numbers look like 57291630-1. findStay takes no other form. */
export function isHmsConfirmation(value: string): boolean {
  return /^\d+-\d+$/.test(value);
}

/** One Guest Stay as findStay returns it. Each field is null when HMS does not show it. Dates are ISO days. */
export type StayRecordWire = {
  status: string | null;
  confirmation: string | null;
  lastName: string | null;
  firstName: string | null;
  arrival: string | null;
  departure: string | null;
  nights: number | null;
  adults: number | null;
  children: number | null;
  roomType: string | null;
  ratePlan: string | null;
  mealPlan: string | null;
  averageRate: string | null;
  grandTotal: string | null;
  balance: string | null;
  sourceOfBusiness: string | null;
  guaranteeType: string | null;
  bookingAgency: string | null;
  organization: string | null;
};

/** The email's arrival, when it is a real ISO day, moves HMS quick search to cover that day. */
export type FindStayInput = { confirmation: string; arrival?: string };

/**
 * paneStayLookup.findStay. Refusals and failures carry no stay. With an arrival sent, HMS refuses a record that
 * starts on another day: outcome ambiguous with reason arrival_mismatch.
 */
export type FindStayReply = {
  outcome: string;
  reason: string | null;
  stay: StayRecordWire | null;
  /** PNG file names. record.png is the booking itself. */
  screenshots: string[];
  runId: string | null;
};

export type ScreenshotInput = { runId: string; name: string };
export type ScreenshotReply = { status: 'ok'; dataUrl: string } | { status: 'unavailable'; reason: string };

export type AmendFindClient = {
  findStay: (input: FindStayInput) => Promise<FindStayReply>;
  screenshot: (input: ScreenshotInput) => Promise<ScreenshotReply>;
};

type TrpcPaneStayLookupRoutes = {
  paneStayLookup?: {
    findStay?: { mutate: (input: FindStayInput) => Promise<FindStayReply> };
    screenshot?: { query: (input: ScreenshotInput) => Promise<ScreenshotReply> };
  };
};

/** Binds paneStayLookup.findStay and paneStayLookup.screenshot off a tRPC client. Null when either is missing. */
export function amendFindClientFromTrpc(trpc: unknown): AmendFindClient | null {
  if (!trpc || typeof trpc !== 'object') return null;
  const routes = (trpc as TrpcPaneStayLookupRoutes).paneStayLookup;
  const find = routes?.findStay;
  const shot = routes?.screenshot;
  if (!find || !shot) return null;
  return {
    findStay: (input) => find.mutate(input),
    screenshot: (input) => shot.query(input),
  };
}

export type HmsFindRun =
  | { kind: 'found'; stay: StayRecordWire; runId: string | null; screenshots: string[] }
  | { kind: 'not_found' }
  | { kind: 'ambiguous' }
  | { kind: 'error'; message: string };

/**
 * The only HMS call the amend pane makes for a look-up: one read-only find by the exact confirmation number.
 * The email's arrival is sent too when it is a real ISO day. HMS quick search covers only about two months from
 * today, so the arrival moves its window to reach later stays. HMS then also needs the record to start that day,
 * so a different arrival comes back as arrival_mismatch rather than as a found stay.
 */
export async function runHmsFind(options: {
  /** Null when the paneStayLookup routes are not bound. The run then fails with the unavailable copy. */
  client: AmendFindClient | null;
  confirmation: string;
  /** The email's arrival. Anything that is not a real ISO day is left out. */
  arrival?: string | null;
}): Promise<HmsFindRun> {
  const client = options.client;
  if (!client) return { kind: 'error', message: AMEND_FIND_COPY.unavailable };
  const arrival = sendableArrival(options.arrival);
  const input: FindStayInput = arrival
    ? { confirmation: options.confirmation, arrival }
    : { confirmation: options.confirmation };
  let reply: FindStayReply;
  try {
    reply = await client.findStay(input);
  } catch {
    return { kind: 'error', message: AMEND_FIND_COPY.readFailed };
  }
  switch (reply.outcome) {
    case 'found':
      if (!reply.stay) return { kind: 'error', message: AMEND_FIND_COPY.readFailed };
      return { kind: 'found', stay: reply.stay, runId: reply.runId, screenshots: reply.screenshots };
    case 'not_found':
      return { kind: 'not_found' };
    case 'ambiguous':
      if (reply.reason === 'arrival_mismatch') {
        return { kind: 'error', message: AMEND_FIND_COPY.arrivalDiffers };
      }
      return { kind: 'ambiguous' };
    case 'refused_input_invalid':
      return { kind: 'error', message: AMEND_FIND_COPY.notExact };
    case 'refused_lock_unavailable':
      return { kind: 'error', message: AMEND_FIND_COPY.busy };
    case 'refused_flag_off':
      return { kind: 'error', message: AMEND_FIND_COPY.unavailable };
    default:
      return { kind: 'error', message: AMEND_FIND_COPY.readFailed };
  }
}

/** A stay field's text when HMS shows it, else null. */
export function stayText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/** The guest's name as HMS shows it: first name, then surname. Null when neither is shown. */
export function stayGuest(stay: StayRecordWire): string | null {
  return [stayText(stay.firstName), stayText(stay.lastName)].filter(Boolean).join(' ') || null;
}

export type AmendDiff = { guest?: string; arrival?: string; departure?: string };

/** Fields where the guest's email and HMS disagree. Values are display-ready. */
export function amendDiffs(amendment: QuoteAmendment, stay: StayRecordWire): AmendDiff {
  const diff: AmendDiff = {};
  const hmsArrival = stayText(stay.arrival);
  if (amendment.arrival && hmsArrival && isoDay(amendment.arrival) !== isoDay(hmsArrival)) {
    diff.arrival = formatStayDate(amendment.arrival);
  }
  const hmsDeparture = stayText(stay.departure);
  if (amendment.departure && hmsDeparture && isoDay(amendment.departure) !== isoDay(hmsDeparture)) {
    diff.departure = formatStayDate(amendment.departure);
  }
  const lastName = amendment.guestLastName?.trim() ?? '';
  const hmsName = stayGuest(stay);
  if (lastName && hmsName && !nameWords(hmsName).includes(lastName.toLowerCase())) {
    diff.guest = lastName;
  }
  return diff;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-10-14 reads as 14 Oct 2026. Anything that is not an ISO day is shown unchanged. */
export function formatStayDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return value;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

function isoDay(value: string): string {
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value.trim());
  return match ? match[0] : value.trim();
}

/** The arrival as HMS takes it: a real ISO day, else null. Same test as the server's find route. */
export function sendableArrival(value: string | null | undefined): string | null {
  const day = (value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null;
}

function nameWords(name: string): string[] {
  return name.toLowerCase().split(/[\s,.]+/).filter(Boolean);
}
