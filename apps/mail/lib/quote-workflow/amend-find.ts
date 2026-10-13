import type { PartyFindReply } from './party-lookup';
import type { QuoteAmendment } from './types';

/**
 * Shared HMS read helpers for quote, amend and cancel mail.
 * Find, guest-search, and party-search may use persisted jobs when enabled.
 * The pane polls by run id and shows a dated snapshot after remount.
 * These helpers never change HMS.
 */

export const AMEND_FIND_COPY = {
  looking: 'Nava is looking up the booking in HMS…',
  lookupWait: 'Takes about 1–2 minutes. Quotes wait while it runs.',
  noNumber:
    "Nava couldn't find a booking number in the email. Find the booking by guest name below.",
  waitingThread: 'Waiting for this email to sync before the HMS lookup can start.',
  notExact:
    'HMS needs one exact booking number from the latest email. Check the email or find the booking by guest name below.',
  ambiguous: 'HMS matched more than one booking for that number. Check HMS directly.',
  arrivalDiffers:
    'HMS shows this booking on another arrival date from the email. Check the dates in HMS directly.',
  bookedMissing: 'Booked dates not in mail. Nava does not use the requested dates for this lookup.',
  busy: 'HMS is busy with another quote or lookup. Try again in a minute.',
  readFailed: 'Nava could not read the HMS result. Try again in a minute.',
  lookupFailed: "Nava couldn't look this up. Search HMS yourself.",
  noHmsNumber: 'No HMS booking number found in the email.',
  unavailable: 'The HMS lookup is not connected in this session. Search HMS by hand.',
  unreachable: "Nava can't reach HMS right now. Tell the Nava team.",
  seeBooking: 'See the booking in HMS',
  footer: 'Nava only looks the booking up. Make the change in HMS yourself.',
  searchIntro: 'Search by surname and arrival day to find the booking in HMS.',
  searchButton: 'Search HMS',
  searching: 'Nava is searching HMS by guest name…',
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

/** One Guest Stay as the find reply carries it. Each field is null when HMS does not show it. Dates are ISO days. */
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

export type StayPartyCommercialWire = { name?: string; nativeId?: string };

/** Commercial attribution returned from the same opened HMS record. Fields are absent when HMS did not show them. */
export type StayCommercialWire = {
  company?: StayPartyCommercialWire;
  agency?: StayPartyCommercialWire;
  ratePlan?: string;
  mealPlan?: string;
  roomType?: string;
  marketSegment?: string;
  sourceOfBusiness?: string;
  averageRate?: string;
  status?: string;
  arrival?: string;
  departure?: string;
};

/** The email's arrival, when it is a real ISO day, moves HMS quick search to cover that day. */
export type FindStayInput = { confirmation: string; arrival?: string };

/**
 * The reply a find job stores. Refusals and failures carry no stay. With an arrival sent, HMS refuses a record that
 * starts on another day: outcome ambiguous with reason arrival_mismatch.
 */
export type FindStayReply = {
  outcome: string;
  reason: string | null;
  stay: StayRecordWire | null;
  commercial?: StayCommercialWire | null;
  /** PNG file names. record.png is the booking itself. */
  screenshots: string[];
  runId: string | null;
  /** The arrival is a hint: HMS may hold another day. The record is still returned, with both dates. */
  arrivalMismatch?: boolean;
  requestedArrival?: string | null;
  hmsArrival?: string | null;
};

export type ScreenshotInput = { runId: string; name: string };
export type ScreenshotReply =
  | { status: 'ok'; dataUrl: string }
  | { status: 'unavailable'; reason: string };

/** One row of a guest-name search, as the search reply carries it. Dates are ISO days or null. */
export type GuestSearchRow = {
  confirmation: string;
  lastName: string;
  firstName: string;
  status: string;
  arrival: string | null;
  departure: string | null;
};

export type GuestSearchInput = { lastName: string; arrival: string; departure?: string };

/** The reply a search job stores. rows are complete only for outcome ok. */
export type GuestSearchReply = {
  outcome: string;
  rows: GuestSearchRow[];
  screenshots: string[];
  runId: string | null;
};

export type HmsJobKind = 'find' | 'search_guest' | 'party';

/** What a job was queued for. paneStayLookup stores it with the job. */
export type HmsJobRequest =
  | { kind: 'find'; confirmation: string; arrival?: string }
  | { kind: 'search_guest'; lastName: string; arrival: string; departure?: string }
  | { kind: 'party'; name: string; partyKind?: 'company' | 'agency'; matchVersion?: 2 };

export type HmsJobQueueOptions = { autoStart?: true; retry?: true };

export type HmsJobStatus = 'queued' | 'running' | 'retrying' | 'done' | 'failed';

/**
 * One job as paneStayLookup.jobStatus returns it.
 * `result` is the stored reply, null until success. `asOf` dates the snapshot.
 * `position` counts the HMS queue ahead while it waits.
 */
export type HmsJobView = {
  runId: string;
  /** Message that produced the job; party prefetch read-back is scoped to the selected message. */
  sourceMessageId?: string | null;
  request: HmsJobRequest | null;
  prefetch: boolean;
  status: HmsJobStatus;
  position: number | null;
  attempts: number;
  failureClass: string | null;
  asOf: string | null;
  createdAt?: string | null;
  outcome?: string | null;
  result: Record<string, unknown> | null;
};

/** runId is null when the server's job queue is off (HMS_JOB_QUEUE): the lookup then runs synchronously instead. */
export type QueuedHmsJob = { runId: string | null };

/**
 * What queueing a request gives the pane: a job to poll, or with the queue off, the settled synchronous answer. An
 * auto-start with the queue off gives neither, because it never runs a live search on its own.
 */
export type HmsJobStart = { runId: string; view?: undefined } | { runId: null; view?: HmsJobView };

/** The paneStayLookup job routes, bound off the pane's tRPC client. */
export type HmsJobClient = {
  queueFind: (input: FindStayInput & { threadId: string; autoStart?: true }) => Promise<QueuedHmsJob>;
  queueSearchGuest: (
    input: GuestSearchInput & { threadId: string; autoStart?: true },
  ) => Promise<QueuedHmsJob>;
  queueParty?: (input: {
    threadId: string;
    name: string;
    partyKind?: 'company' | 'agency';
    retry?: true;
  }) => Promise<QueuedHmsJob>;
  /** The server's exact HMS_JOB_QUEUE switch, used to preserve the queue-off inline party lookup. */
  jobQueueEnabled?: () => Promise<boolean>;
  /** The synchronous find and search, used while the server's job queue is off. */
  findStay?: (input: FindStayInput) => Promise<FindStayReply>;
  searchGuest?: (input: GuestSearchInput) => Promise<GuestSearchReply>;
  findParty?: (input: { name: string; kind?: 'company' | 'agency' }) => Promise<PartyFindReply>;
  jobStatus: (
    input:
      | { runId: string }
      | {
          threadId: string;
          kind: HmsJobKind;
          confirmation?: string;
          lastName?: string;
          name?: string;
          partyKind?: 'company' | 'agency';
          arrival?: string;
          departure?: string | null;
        },
  ) => Promise<HmsJobView | null>;
  screenshot: (input: ScreenshotInput) => Promise<ScreenshotReply>;
};

/** The job calls for one thread: queue a request, and read a job by run id or the latest of a kind on the thread. */
export type HmsJobTransport = {
  queue: (request: HmsJobRequest, options?: HmsJobQueueOptions) => Promise<HmsJobStart>;
  jobQueueEnabled?: () => Promise<boolean>;
  status: (
    input:
      | { runId: string }
      | {
          kind: HmsJobKind;
          confirmation?: string;
          lastName?: string;
          name?: string;
          partyKind?: 'company' | 'agency';
          arrival?: string;
          departure?: string | null;
        },
  ) => Promise<HmsJobView | null>;
};

type TrpcPaneStayLookupRoutes = {
  paneStayLookup?: {
    jobQueueEnabled?: { query: NonNullable<HmsJobClient['jobQueueEnabled']> };
    queueFind?: { mutate: HmsJobClient['queueFind'] };
    queueSearchGuest?: { mutate: HmsJobClient['queueSearchGuest'] };
    queueParty?: { mutate: NonNullable<HmsJobClient['queueParty']> };
    findStay?: { mutate: NonNullable<HmsJobClient['findStay']> };
    searchGuest?: { mutate: NonNullable<HmsJobClient['searchGuest']> };
    jobStatus?: { query: HmsJobClient['jobStatus'] };
    screenshot?: { query: (input: ScreenshotInput) => Promise<ScreenshotReply> };
  };
  panePartyLookup?: {
    findParty?: { mutate: NonNullable<HmsJobClient['findParty']> };
  };
};

/** Binds the paneStayLookup job routes and screenshot off a tRPC client. Null when any of them is missing. */
export function amendFindClientFromTrpc(trpc: unknown): HmsJobClient | null {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const routes = (trpc as TrpcPaneStayLookupRoutes).paneStayLookup;
  const queueFind = routes?.queueFind;
  const queueSearch = routes?.queueSearchGuest;
  const queueParty = routes?.queueParty;
  const status = routes?.jobStatus;
  const shot = routes?.screenshot;
  const find = routes?.findStay;
  const search = routes?.searchGuest;
  const party = (trpc as TrpcPaneStayLookupRoutes).panePartyLookup?.findParty;
  if (!queueFind || !queueSearch || !status || !shot) return null;
  const client: HmsJobClient = {
    queueFind: (input) => queueFind.mutate(input),
    queueSearchGuest: (input) => queueSearch.mutate(input),
    ...(find ? { findStay: (input: FindStayInput) => find.mutate(input) } : {}),
    ...(search ? { searchGuest: (input: GuestSearchInput) => search.mutate(input) } : {}),
    ...(party
      ? { findParty: (input: { name: string; kind?: 'company' | 'agency' }) => party.mutate(input) }
      : {}),
    jobStatus: (input) => status.query(input),
    screenshot: (input) => shot.query(input),
  };
  if (queueParty) client.queueParty = (input) => queueParty.mutate(input);
  if (routes.jobQueueEnabled) client.jobQueueEnabled = () => routes.jobQueueEnabled!.query();
  return client;
}

/** A synchronous reply shown as a settled job, so the panels read it the same way. No as-of stamp: it is live. */
function syncView(
  request: HmsJobRequest,
  reply: FindStayReply | GuestSearchReply | PartyFindReply,
): HmsJobView {
  return {
    runId: 'runId' in reply ? (reply.runId ?? '') : '',
    request,
    prefetch: false,
    status: 'done',
    position: null,
    attempts: 0,
    failureClass: null,
    asOf: null,
    createdAt: null,
    outcome: reply.outcome,
    result: reply as unknown as Record<string, unknown>,
  };
}

/**
 * The job call includes one thread, or returns null if client/thread is missing.
 * With the queue off, manual lookup stays inline. Auto-start does not rerun on each pane open.
 */
export function hmsJobTransport(
  client: HmsJobClient | null,
  threadId: string | null,
): HmsJobTransport | null {
  if (!client || !threadId) return null;
  return {
    ...(client.jobQueueEnabled ? { jobQueueEnabled: client.jobQueueEnabled } : {}),
    queue: async (request, options) => {
      if (request.kind === 'find') {
        const input: FindStayInput = request.arrival
          ? { confirmation: request.confirmation, arrival: request.arrival }
          : { confirmation: request.confirmation };
        const { runId } = await client.queueFind({
          threadId,
          ...input,
          ...(options?.autoStart ? { autoStart: true } : {}),
        });
        if (runId) return { runId };
        if (options?.autoStart) return { runId: null };
        if (!client.findStay) throw new Error('paneStayLookup.findStay unavailable');
        return { runId: null, view: syncView(request, await client.findStay(input)) };
      }
      if (request.kind === 'party') {
        // Party reads are never generated from read-back: only the pane's explicit Find action may queue one.
        if (options?.autoStart) return { runId: null };
        const queued = client.queueParty
          ? await client.queueParty({
              threadId,
              name: request.name,
              ...(request.partyKind ? { partyKind: request.partyKind } : {}),
              ...(options?.retry ? { retry: true } : {}),
            })
          : { runId: null };
        if (queued.runId) return { runId: queued.runId };
        if (!client.findParty) throw new Error('panePartyLookup.findParty unavailable');
        return {
          runId: null,
          view: syncView(
            request,
            await client.findParty({
              name: request.name,
              ...(request.partyKind ? { kind: request.partyKind } : {}),
            }),
          ),
        };
      }
      const input: GuestSearchInput = request.departure
        ? { lastName: request.lastName, arrival: request.arrival, departure: request.departure }
        : { lastName: request.lastName, arrival: request.arrival };
      const { runId } = await client.queueSearchGuest({
        threadId,
        ...input,
        ...(options?.autoStart ? { autoStart: true } : {}),
      });
      if (runId) return { runId };
      // Auto-start with the queue off must not run the live search: it would repeat on every card open.
      if (options?.autoStart) return { runId: null };
      if (!client.searchGuest) throw new Error('paneStayLookup.searchGuest unavailable');
      return { runId: null, view: syncView(request, await client.searchGuest(input)) };
    },
    status: (input) => client.jobStatus('runId' in input ? input : { threadId, ...input }),
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
      commercial?: StayCommercialWire;
      runId: string | null;
      screenshots: string[];
      arrivalMismatch: ArrivalMismatch | null;
    }
  | { kind: 'not_found' }
  | { kind: 'ambiguous' }
  | { kind: 'error'; message: string };

/**
 * The find to queue for an email's number, or the copy to show instead. The server takes only the HMS form, so anything
 * else, such as an agency or voucher reference, is never queued. The email's arrival is sent when it is a real ISO day.
 */
export function findRequestFor(
  confirmation: string,
  arrival?: string | null,
): { request: HmsJobRequest } | { error: string } {
  if (!isHmsConfirmation(confirmation)) return { error: notHmsNumberNote(confirmation) };
  const day = sendableArrival(arrival);
  return {
    request: day ? { kind: 'find', confirmation, arrival: day } : { kind: 'find', confirmation },
  };
}

/** A settled job, done or failed. Other states are still moving. */
export function isSettled(view: HmsJobView): boolean {
  return view.status === 'done' || view.status === 'failed';
}

/** The copy for a failed job, from its failure class. The raw error is never shown. */
function failedCopy(failureClass: string | null, kind: HmsJobKind): string {
  if (failureClass === 'HMS_LOCK_BUSY') return AMEND_FIND_COPY.busy;
  if (failureClass === 'POLICY_BLOCK') return AMEND_FIND_COPY.unavailable;
  if (failureClass === 'SCHEMA_DRIFT') {
    return kind === 'find' ? AMEND_FIND_COPY.notExact : AMEND_FIND_COPY.searchInvalid;
  }
  return kind === 'find' ? AMEND_FIND_COPY.lookupFailed : AMEND_FIND_COPY.searchFailed;
}

/** The panel's find run for a stored find reply. */
export function findRunFromReply(reply: FindStayReply): HmsFindRun {
  switch (reply.outcome) {
    case 'found':
      if (!reply.stay) return { kind: 'error', message: AMEND_FIND_COPY.readFailed };
      return {
        kind: 'found',
        stay: reply.stay,
        ...(reply.commercial ? { commercial: reply.commercial } : {}),
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

/**
 * The find run a job shows. Null while the job is still queued, running or retrying. A queue call that failed is an
 * error here, since no job exists to wait for.
 */
export function findRunFromJob(view: HmsJobView | null, queueFailed: boolean): HmsFindRun | null {
  if (queueFailed) return { kind: 'error', message: AMEND_FIND_COPY.lookupFailed };
  if (!view || !isSettled(view)) return null;
  if (view.status === 'failed')
    return { kind: 'error', message: failedCopy(view.failureClass, 'find') };
  if (!view.result) return { kind: 'error', message: AMEND_FIND_COPY.readFailed };
  return findRunFromReply(view.result as unknown as FindStayReply);
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

/**
 * The dates the guest asked for: the requested stay. A null requested date is unknown and shows as not stated, so the
 * booked date never stands in for it and hides a difference from HMS. The booking dates are used only on an older
 * payload with no requested pair, and for a cancellation, which asks about the stay as booked.
 */
export function askedDates(amendment: QuoteAmendment): {
  arrival: string | null;
  departure: string | null;
} {
  const asked = (requested: string | null | undefined, booked: string | null) =>
    requested === undefined || (requested === null && amendment.kind === 'cancel')
      ? booked
      : requested;
  return {
    arrival: asked(amendment.requestedArrival, amendment.arrival),
    departure: asked(amendment.requestedDeparture, amendment.departure),
  };
}

/** Fields where the guest's email and HMS disagree. Values are display-ready. */
export function amendDiffs(amendment: QuoteAmendment, stay: StayRecordWire): AmendDiff {
  const diff: AmendDiff = {};
  const asked = askedDates(amendment);
  const hmsArrival = stayText(stay.arrival);
  if (asked.arrival && hmsArrival && isoDay(asked.arrival) !== isoDay(hmsArrival)) {
    diff.arrival = formatStayDate(asked.arrival);
  }
  const hmsDeparture = stayText(stay.departure);
  if (asked.departure && hmsDeparture && isoDay(asked.departure) !== isoDay(hmsDeparture)) {
    diff.departure = formatStayDate(asked.departure);
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

/** Same surname rule as the server: 2 to 40 letters, spaces, apostrophes or hyphens, starting and ending on a letter. */
export function isSearchSurname(value: string): boolean {
  return value.length >= 2 && value.length <= 40 && /^\p{L}[\p{L} '-]*\p{L}$/u.test(value);
}

/**
 * The guest-name search to queue. The surname and arrival are required; a departure, when given, must fall after the
 * arrival. Anything else is the copy to show instead.
 */
export function searchRequestFor(form: {
  lastName: string;
  arrival: string | null | undefined;
  departure?: string | null;
}): { request: HmsJobRequest } | { error: string } {
  const lastName = form.lastName.trim().replace(/\s+/g, ' ');
  const arrival = sendableArrival(form.arrival);
  const departureText = (form.departure ?? '').trim();
  const departure = departureText ? sendableArrival(departureText) : null;
  if (!isSearchSurname(lastName) || !arrival) return { error: AMEND_FIND_COPY.searchInvalid };
  if (departureText && (!departure || departure <= arrival))
    return { error: AMEND_FIND_COPY.searchInvalid };
  return {
    request: departure
      ? { kind: 'search_guest', lastName, arrival, departure }
      : { kind: 'search_guest', lastName, arrival },
  };
}

export type HmsSearchRun =
  | { kind: 'rows'; rows: GuestSearchRow[] }
  | { kind: 'none'; lastName: string; arrival: string }
  | { kind: 'capped' }
  | { kind: 'error'; message: string };

/** One plain sentence for a search that matched nothing. The surname and arrival are the ones searched. */
export function noSearchMatchCopy(lastName: string, arrival: string): string {
  return `Not found in HMS by surname ${lastName} and arrival ${formatStayDate(arrival)}.`;
}

/** The exact key shown on the email, so staff can see what HMS was asked to find. */
export function notFoundConfirmationCopy(confirmation: string): string {
  return `Not found in HMS by confirmation number ${confirmation}. Use the surname and arrival search below.`;
}

/** The background lookup's result shown on a later open. It may have run after the email arrived, so it claims no time. */
export function prefetchedNotFoundConfirmationCopy(confirmation: string): string {
  return `Not found in HMS by Nava's earlier lookup (confirmation number ${confirmation}). Find again to check now.`;
}

/**
 * The panel's search run for a stored search reply. Only an ok read with rows is a list. A capped read has no list to
 * pick from, so it says to add the departure.
 */
export function searchRunFromReply(
  reply: GuestSearchReply,
  lastName: string,
  arrival: string,
): HmsSearchRun {
  switch (reply.outcome) {
    case 'ok':
      return reply.rows.length > 0
        ? { kind: 'rows', rows: reply.rows }
        : { kind: 'none', lastName, arrival };
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

/** The search run a job shows. Null while the job is still moving. */
export function searchRunFromJob(
  view: HmsJobView | null,
  queueFailed: boolean,
): HmsSearchRun | null {
  if (queueFailed) return { kind: 'error', message: AMEND_FIND_COPY.searchFailed };
  if (!view || !isSettled(view)) return null;
  if (view.status === 'failed')
    return { kind: 'error', message: failedCopy(view.failureClass, 'search_guest') };
  if (!view.result) return { kind: 'error', message: AMEND_FIND_COPY.searchFailed };
  const request = view.request?.kind === 'search_guest' ? view.request : null;
  return searchRunFromReply(
    view.result as unknown as GuestSearchReply,
    request?.lastName ?? '',
    request?.arrival ?? '',
  );
}

/** The view for a job just queued, before its first status read, so the panel shows it as queued, not idle. */
export function pendingJobView(runId: string, request: HmsJobRequest | null): HmsJobView {
  return {
    runId,
    request,
    prefetch: false,
    status: 'queued',
    position: null,
    attempts: 0,
    failureClass: null,
    asOf: null,
    result: null,
  };
}

/** Poll cadence while a job is queued, running or retrying. */
export const HMS_JOB_POLL_MS = 3_000;
/** Unreadable polls in a row before polling stops: about a minute at the poll cadence. */
export const HMS_JOB_MAX_MISSES = 20;

/**
 * Polls one job by run id until it settles. Each read goes to onView. live() ends the loop when the pane unmounts or a
 * newer request has replaced this one. A read that fails is tried again on the next tick: the job is in the database,
 * so a dropped request loses nothing. After HMS_JOB_MAX_MISSES unreadable reads in a row, polling stops and the job
 * shows as failed (the last view seen, or the bare run when none was), so the staff can retry instead of waiting on a
 * spinner that never ends.
 */
export async function pollHmsJob(
  transport: HmsJobTransport,
  runId: string,
  options: { live: () => boolean; onView: (view: HmsJobView) => void },
): Promise<void> {
  let misses = 0;
  let last: HmsJobView | null = null;
  while (options.live()) {
    const view = await transport.status({ runId }).catch(() => null);
    if (!options.live()) return;
    if (view) {
      misses = 0;
      last = view;
      options.onView(view);
      if (isSettled(view)) return;
    } else {
      misses += 1;
      if (misses >= HMS_JOB_MAX_MISSES) {
        // Shown as failed even when no read ever succeeded, so the panel offers Retry instead of looking idle.
        options.onView({
          ...(last ?? pendingJobView(runId, null)),
          status: 'failed',
          failureClass: 'POLL_LOST',
        });
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, HMS_JOB_POLL_MS));
  }
}

function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[\s,.]+/)
    .filter(Boolean);
}
