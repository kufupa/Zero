import type { QuoteAmendment } from './types';

/**
 * HMS lookup for amend and cancel mail. Luna reads one booking by its exact confirmation number through
 * paneStayLookup.findStay: a read-only browser run under the session hotel's lock, about 1-2 minutes.
 * The panel calls runHmsFind and nothing else, so the transport can change here. Nothing here changes HMS.
 */

export const AMEND_FIND_COPY = {
  looking: 'Nava is looking up the booking in HMS… (about 1–2 minutes)',
  noNumber: "Nava couldn't find a booking number in the email. Find the booking by guest name below.",
  waitingThread: 'Waiting for this email to sync before the HMS lookup can start.',
  notFound:
    'No booking with that number in HMS. Check the number in the email or find the booking by guest name below.',
  notExact:
    'HMS needs one exact booking number from the latest email. Check the email or find the booking by guest name below.',
  ambiguous: 'HMS matched more than one booking for that number. Check HMS directly.',
  arrivalDiffers: 'HMS shows this booking on another arrival date from the email. Check the dates in HMS directly.',
  busy: 'HMS is busy with another quote or lookup. Try again in a minute.',
  readFailed: 'Nava could not read the HMS result. Try again in a minute.',
  lookupFailed: "Nava couldn't look this up. Search HMS yourself.",
  noHmsNumber: 'No HMS booking number found in the email.',
  unavailable: 'The HMS lookup is not connected in this session. Search HMS by hand.',
  unreachable: "Nava can't reach HMS right now. Tell the Nava team.",
  seeBooking: 'See the booking in HMS',
  footer: 'Nava only looks the booking up. Make the change in HMS yourself.',
  searchIntro: 'The email has no HMS booking number, so find the booking by surname and arrival day.',
  searchButton: 'Search HMS (about 1 minute)',
  searching: 'Nava is searching HMS by guest name… (about 1 minute)',
  searchCapped: 'Many matches — add the departure date.',
  searchInvalid: 'Check the surname and dates, then search again.',
  searchFailed: 'Nava could not read the HMS search. Try again in a minute.',
  searchPick: 'Pick a booking to see it in HMS above.',
} as const;

/**
 * A real HMS confirmation: 6 to 10 digits, a dash, then the stay's 1 or 2 digits (57291630-1). findStay takes no other
 * form, and the pane never sends one.
 */
const HMS_CONFIRMATION = /^\d{6,10}-\d{1,2}$/;

export function isHmsConfirmation(value: string): boolean {
  return HMS_CONFIRMATION.test(value);
}

/**
 * The HMS confirmation for an email number, or null. Only a dash confirmation is taken, exactly as written. A bare
 * number is not a confirmation: it may be a billing or voucher reference, and adding -1 could match a different stay.
 * So a bare number gets no -1 here, and the pane searches by guest name instead.
 */
export function hmsNumberFor(value: string | null | undefined): string | null {
  const number = value?.trim() ?? '';
  return isHmsConfirmation(number) ? number : null;
}

/** The note for an email number HMS cannot take: an agency or voucher reference, say. It names the number. */
export function notHmsNumberNote(value: string): string {
  return `The number in the email (${value}) looks like the agent's own reference, not an HMS booking number. Find the booking by guest name below.`;
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
  /** The arrival is a hint: HMS may hold another day. The record is still returned, with both dates. */
  arrivalMismatch?: boolean;
  requestedArrival?: string | null;
  hmsArrival?: string | null;
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
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const routes = (trpc as TrpcPaneStayLookupRoutes).paneStayLookup;
  const find = routes?.findStay;
  const shot = routes?.screenshot;
  if (!find || !shot) return null;
  return {
    findStay: (input) => find.mutate(input),
    screenshot: (input) => shot.query(input),
  };
}

/** The email's arrival and the arrival HMS holds, when they differ. */
export type ArrivalMismatch = { requested: string; hms: string };

/** One sentence for the pane: what the guest mentioned, and when HMS holds the booking. */
export function arrivalMismatchNote(mismatch: ArrivalMismatch): string {
  return `The guest mentioned ${formatStayDate(mismatch.requested)}; the booking in HMS arrives ${formatStayDate(mismatch.hms)}.`;
}

export type HmsFindRun =
  | {
      kind: 'found';
      stay: StayRecordWire;
      runId: string | null;
      screenshots: string[];
      arrivalMismatch: ArrivalMismatch | null;
    }
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
  // The server takes only the HMS form. Anything else, such as an agency or voucher reference, is never sent.
  if (!isHmsConfirmation(options.confirmation)) {
    return { kind: 'error', message: notHmsNumberNote(options.confirmation) };
  }
  const arrival = sendableArrival(options.arrival);
  const input: FindStayInput = arrival
    ? { confirmation: options.confirmation, arrival }
    : { confirmation: options.confirmation };
  let reply: FindStayReply | undefined;
  try {
    reply = await client.findStay(input);
  } catch {
    // Any failed call (a tRPC error, a timeout, a dropped socket) reads the same. The raw message is never shown.
    return { kind: 'error', message: AMEND_FIND_COPY.lookupFailed };
  }
  if (!reply) return { kind: 'error', message: AMEND_FIND_COPY.lookupFailed };
  switch (reply.outcome) {
    case 'found':
      if (!reply.stay) return { kind: 'error', message: AMEND_FIND_COPY.readFailed };
      return {
        kind: 'found',
        stay: reply.stay,
        runId: reply.runId,
        screenshots: reply.screenshots,
        arrivalMismatch: arrivalMismatchFrom(reply),
      };
    case 'not_found':
      return { kind: 'not_found' };
    case 'ambiguous':
      if (reply.reason === 'arrival_mismatch') {
        return { kind: 'error', message: AMEND_FIND_COPY.arrivalDiffers };
      }
      return { kind: 'ambiguous' };
    case 'refused_input_invalid':
      return { kind: 'error', message: AMEND_FIND_COPY.notExact };
    case 'refused_lock_busy':
      return { kind: 'error', message: AMEND_FIND_COPY.busy };
    case 'refused_lock_unavailable':
      return { kind: 'error', message: AMEND_FIND_COPY.unreachable };
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

/** The mismatch from a found reply, when the server reports both dates. */
function arrivalMismatchFrom(reply: FindStayReply): ArrivalMismatch | null {
  if (reply.arrivalMismatch !== true) return null;
  if (!reply.requestedArrival || !reply.hmsArrival) return null;
  return { requested: reply.requestedArrival, hms: reply.hmsArrival };
}

/** The arrival as HMS takes it: a real ISO day, else null. Same test as the server's find route. */
export function sendableArrival(value: string | null | undefined): string | null {
  const day = (value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null;
}

/** One row of a guest-name search, as paneStayLookup.searchGuest returns it. Dates are ISO days or null. */
export type GuestSearchRow = {
  confirmation: string;
  lastName: string;
  firstName: string;
  status: string;
  arrival: string | null;
  departure: string | null;
};

export type GuestSearchInput = { lastName: string; arrival: string; departure?: string };

/** paneStayLookup.searchGuest. rows are complete only for outcome ok. */
export type GuestSearchReply = {
  outcome: string;
  rows: GuestSearchRow[];
  screenshots: string[];
  runId: string | null;
};

export type AmendSearchClient = {
  searchGuest: (input: GuestSearchInput) => Promise<GuestSearchReply>;
};

type TrpcPaneStayLookupSearchRoute = {
  paneStayLookup?: { searchGuest?: { mutate: (input: GuestSearchInput) => Promise<GuestSearchReply> } };
};

/** Binds paneStayLookup.searchGuest off a tRPC client. Null when the route is missing. */
export function amendSearchClientFromTrpc(trpc: unknown): AmendSearchClient | null {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const search = (trpc as TrpcPaneStayLookupSearchRoute).paneStayLookup?.searchGuest;
  if (!search) return null;
  return { searchGuest: (input) => search.mutate(input) };
}

/** Same surname rule as the server: 2 to 40 letters, spaces, apostrophes or hyphens, starting and ending on a letter. */
export function isSearchSurname(value: string): boolean {
  return value.length >= 2 && value.length <= 40 && /^\p{L}[\p{L} '-]*\p{L}$/u.test(value);
}

export type HmsSearchRun =
  | { kind: 'rows'; rows: GuestSearchRow[] }
  | { kind: 'none'; lastName: string; arrival: string }
  | { kind: 'capped' }
  | { kind: 'error'; message: string };

/** One plain sentence for a search that matched nothing. The surname and arrival are the ones searched. */
export function noSearchMatchCopy(lastName: string, arrival: string): string {
  return `No booking for ${lastName} arriving ${formatStayDate(arrival)} in HMS. Check the spelling or dates.`;
}

/**
 * The guest-name search. The surname and arrival are required; a departure, when given, must fall after the arrival.
 * Only an ok read with rows is a list. A capped read has no list to pick from, so it says to add the departure.
 */
export async function runHmsSearch(options: {
  /** Null when the paneStayLookup route is not bound. The run then fails with the unavailable copy. */
  client: AmendSearchClient | null;
  lastName: string;
  arrival: string | null | undefined;
  departure?: string | null;
}): Promise<HmsSearchRun> {
  const client = options.client;
  if (!client) return { kind: 'error', message: AMEND_FIND_COPY.unavailable };
  const lastName = options.lastName.trim().replace(/\s+/g, ' ');
  const arrival = sendableArrival(options.arrival);
  const departureText = (options.departure ?? '').trim();
  const departure = departureText ? sendableArrival(departureText) : null;
  if (!isSearchSurname(lastName) || !arrival) return { kind: 'error', message: AMEND_FIND_COPY.searchInvalid };
  if (departureText && (!departure || departure <= arrival)) {
    return { kind: 'error', message: AMEND_FIND_COPY.searchInvalid };
  }
  const input: GuestSearchInput = departure ? { lastName, arrival, departure } : { lastName, arrival };
  let reply: GuestSearchReply | undefined;
  try {
    reply = await client.searchGuest(input);
  } catch {
    // Same rule as the find: a failed call reads the same whatever failed, and its raw message is never shown.
    return { kind: 'error', message: AMEND_FIND_COPY.searchFailed };
  }
  if (!reply) return { kind: 'error', message: AMEND_FIND_COPY.searchFailed };
  switch (reply.outcome) {
    case 'ok':
      return reply.rows.length > 0 ? { kind: 'rows', rows: reply.rows } : { kind: 'none', lastName, arrival };
    case 'ambiguous_capped':
      return { kind: 'capped' };
    case 'refused_input_invalid':
      return { kind: 'error', message: AMEND_FIND_COPY.searchInvalid };
    case 'refused_lock_busy':
      return { kind: 'error', message: AMEND_FIND_COPY.busy };
    case 'refused_lock_unavailable':
      return { kind: 'error', message: AMEND_FIND_COPY.unreachable };
    case 'refused_flag_off':
      return { kind: 'error', message: AMEND_FIND_COPY.unavailable };
    default:
      return { kind: 'error', message: AMEND_FIND_COPY.searchFailed };
  }
}

function nameWords(name: string): string[] {
  return name.toLowerCase().split(/[\s,.]+/).filter(Boolean);
}
