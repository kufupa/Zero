import type { QuoteAmendment } from './types';

/**
 * HMS lookup for amend and cancel mail (Phase 1). It uses only the read-only find tool,
 * which takes an exact confirmation or external reference. Nothing here changes HMS.
 */

export const AMEND_FIND_INTERVAL_MS = 2_000;
export const AMEND_FIND_TIMEOUT_MS = 90_000;

export const AMEND_FIND_COPY = {
  looking: 'Luna is looking up the booking in HMS… (usually under a minute)',
  noNumber: "Luna couldn't find a booking number in the email. Search HMS by name instead.",
  waitingThread: 'Waiting for this email to sync before the HMS lookup can start.',
  notFound:
    'No booking with that number in HMS. Check the number in the email or search HMS by guest name.',
  notExact:
    'HMS needs one exact booking number from the latest email. Check the email or search HMS by guest name.',
  ambiguous: 'HMS matched more than one booking for that number. Check HMS directly.',
  unconfirmed: 'Luna could not confirm this booking in HMS. Search HMS by guest name.',
  busy: 'HMS is busy. Try again in a minute.',
  readFailed: 'Luna could not read the HMS result. Try again in a minute.',
  startFailed: 'Luna could not start the HMS lookup. Try again in a minute.',
  unavailable: 'The HMS lookup is not connected in this session. Search HMS by hand.',
  footer: 'Luna only looks the booking up. Make the change in HMS yourself.',
} as const;

type WireFact<T> = { state: string; value: T | null };

/** One reservation match in an hms_find_reservation receipt. Only the fields the panel shows. */
export type HmsFindMatchWire = {
  reservationRef: string | null;
  label: WireFact<string>;
  referenceKind: WireFact<'confirmation' | 'external'>;
  status: WireFact<string>;
  arrival: WireFact<string>;
  departure: WireFact<string>;
  roomType: WireFact<string>;
};

export type HmsFindReceiptWire = {
  readResultRef: string;
  result: {
    status: 'ok' | 'partial' | 'not_found' | 'unverified_negative' | 'ambiguous' | 'manual_required';
    issues: Array<{ code: string }>;
    data: { matches: HmsFindMatchWire[]; matchCount: number } | null;
  };
};

export type EnqueueHmsFindInput = { threadId: string; toolId: 'hms_find_reservation' };
export type ReadHmsReceiptInput = { threadId: string; readResultRef: string };

export type AmendFindClient = {
  enqueueHmsRead: (input: EnqueueHmsFindInput) => Promise<{ readResultRef: string }>;
  readHmsReceipt: (input: ReadHmsReceiptInput) => Promise<HmsFindReceiptWire>;
};

type TrpcAiRoutes = {
  ai?: {
    enqueueHmsRead?: { mutate: (input: EnqueueHmsFindInput) => Promise<{ readResultRef: string }> };
    readHmsReceipt?: { query: (input: ReadHmsReceiptInput) => Promise<HmsFindReceiptWire> };
  };
};

/** Binds ai.enqueueHmsRead and ai.readHmsReceipt off a tRPC client. Null when either route is missing. */
export function amendFindClientFromTrpc(trpc: unknown): AmendFindClient | null {
  if (!trpc || typeof trpc !== 'object') return null;
  const ai = (trpc as TrpcAiRoutes).ai;
  const enqueue = ai?.enqueueHmsRead;
  const receipt = ai?.readHmsReceipt;
  if (!enqueue || !receipt) return null;
  return {
    enqueueHmsRead: (input) => enqueue.mutate(input),
    readHmsReceipt: (input) => receipt.query(input),
  };
}

export type PollOutcome =
  | { kind: 'receipt'; receipt: HmsFindReceiptWire }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string }
  | { kind: 'stopped' };

export type PollOptions = {
  readHmsReceipt: (input: ReadHmsReceiptInput) => Promise<HmsFindReceiptWire>;
  threadId: string;
  readResultRef: string;
  /** False once the panel unmounts or a newer lookup supersedes this one. */
  isCurrent: () => boolean;
  intervalMs?: number;
  timeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** Poll ai.readHmsReceipt until a receipt arrives, the window closes, or the lookup is superseded. */
export async function pollHmsFindReceipt(options: PollOptions): Promise<PollOutcome> {
  const intervalMs = options.intervalMs ?? AMEND_FIND_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? AMEND_FIND_TIMEOUT_MS;
  const wait = options.wait ?? sleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  for (;;) {
    await wait(intervalMs);
    if (!options.isCurrent()) return { kind: 'stopped' };
    try {
      const receipt = await options.readHmsReceipt({
        threadId: options.threadId,
        readResultRef: options.readResultRef,
      });
      return { kind: 'receipt', receipt };
    } catch (error) {
      if (!isReceiptPending(error)) return { kind: 'error', message: errorText(error) };
    }
    if (!options.isCurrent()) return { kind: 'stopped' };
    if (now() - startedAt >= timeoutMs) return { kind: 'timeout' };
  }
}

export type HmsFindRun =
  | { kind: 'receipt'; receipt: HmsFindReceiptWire }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string }
  | { kind: 'stopped' };

export type RunHmsFindOptions = {
  /** Null when the ai routes are not bound. The run then fails with the unavailable copy. */
  client: AmendFindClient | null;
  threadId: string;
  intervalMs?: number;
  timeoutMs?: number;
  /** False once the panel unmounts or a newer lookup supersedes this one. */
  isCurrent: () => boolean;
};

/**
 * The only HMS call the amend pane makes for a look-up: enqueue the read-only find, then poll its receipt.
 * The panel calls this and nothing else, so the transport can change here without touching the panel.
 */
export async function runHmsFind(options: RunHmsFindOptions): Promise<HmsFindRun> {
  const client = options.client;
  if (!client) return { kind: 'error', message: AMEND_FIND_COPY.unavailable };
  let started: { readResultRef: string } | undefined;
  try {
    started = await client.enqueueHmsRead({ threadId: options.threadId, toolId: 'hms_find_reservation' });
  } catch (error) {
    return { kind: 'error', message: enqueueFailureCopy(error) };
  }
  if (!started?.readResultRef) return { kind: 'error', message: AMEND_FIND_COPY.startFailed };
  const poll = await pollHmsFindReceipt({
    readHmsReceipt: client.readHmsReceipt,
    threadId: options.threadId,
    readResultRef: started.readResultRef,
    intervalMs: options.intervalMs,
    timeoutMs: options.timeoutMs,
    isCurrent: options.isCurrent,
  });
  if (poll.kind === 'receipt') return { kind: 'receipt', receipt: poll.receipt };
  if (poll.kind === 'timeout') return { kind: 'timeout' };
  if (poll.kind === 'error') return { kind: 'error', message: AMEND_FIND_COPY.readFailed };
  return { kind: 'stopped' };
}

/** Plain-English copy for a failed enqueueHmsRead. The client sees the server message text. */
export function enqueueFailureCopy(error: unknown): string {
  const text = errorText(error);
  if (text.includes('READ_CANDIDATE_NOT_EXACT') || text.includes('exact trigger candidate')) {
    return AMEND_FIND_COPY.notExact;
  }
  if (text.includes('HMS_READ_RELEASE_UNAVAILABLE')) return AMEND_FIND_COPY.busy;
  return AMEND_FIND_COPY.startFailed;
}

export type AmendFindOutcome =
  | { kind: 'found'; match: HmsFindMatchWire }
  | { kind: 'not_found' }
  | { kind: 'ambiguous' }
  | { kind: 'unconfirmed' }
  | { kind: 'busy' };

const BUSY_ISSUE_CODES = new Set(['TIMEOUT', 'SOURCE_UNAVAILABLE', 'ROLE_UNAVAILABLE']);

export function amendFindOutcome(receipt: HmsFindReceiptWire): AmendFindOutcome {
  const { result } = receipt;
  if (result.issues.some((issue) => BUSY_ISSUE_CODES.has(issue.code))) return { kind: 'busy' };
  if (result.status === 'not_found') return { kind: 'not_found' };
  if (result.status === 'ambiguous') return { kind: 'ambiguous' };
  if (result.status !== 'ok' && result.status !== 'partial') return { kind: 'unconfirmed' };
  const data = result.data;
  const [first] = data?.matches ?? [];
  if (!data || !first) return { kind: 'not_found' };
  if (data.matchCount > 1) return { kind: 'ambiguous' };
  return { kind: 'found', match: first };
}

/** The outcome note for the status area, or null when the found booking is shown instead. */
export function outcomeNote(outcome: AmendFindOutcome): string | null {
  switch (outcome.kind) {
    case 'found':
      return null;
    case 'not_found':
      return AMEND_FIND_COPY.notFound;
    case 'ambiguous':
      return AMEND_FIND_COPY.ambiguous;
    case 'unconfirmed':
      return AMEND_FIND_COPY.unconfirmed;
    case 'busy':
      return AMEND_FIND_COPY.busy;
  }
}

/** A fact's value when HMS knows it, else null. */
export function knownFactValue(fact: WireFact<string>): string | null {
  if (fact.state !== 'known' || typeof fact.value !== 'string') return null;
  const value = fact.value.trim();
  return value || null;
}

export function matchedOnLabel(match: HmsFindMatchWire): string {
  return match.referenceKind.value === 'external' ? 'external reference' : 'confirmation number';
}

export type AmendDiff = { guest?: string; arrival?: string; departure?: string };

/** Fields where the guest's email and HMS disagree. Values are display-ready. */
export function amendDiffs(amendment: QuoteAmendment, match: HmsFindMatchWire): AmendDiff {
  const diff: AmendDiff = {};
  const hmsArrival = knownFactValue(match.arrival);
  if (amendment.arrival && hmsArrival && isoDay(amendment.arrival) !== isoDay(hmsArrival)) {
    diff.arrival = formatStayDate(amendment.arrival);
  }
  const hmsDeparture = knownFactValue(match.departure);
  if (amendment.departure && hmsDeparture && isoDay(amendment.departure) !== isoDay(hmsDeparture)) {
    diff.departure = formatStayDate(amendment.departure);
  }
  const lastName = amendment.guestLastName?.trim() ?? '';
  const hmsName = knownFactValue(match.label);
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

function nameWords(name: string): string[] {
  return name.toLowerCase().split(/[\s,.]+/).filter(Boolean);
}

function isReceiptPending(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { message, data } = error as { message?: unknown; data?: { code?: unknown } | null };
  return message === 'READ_RECEIPT_NOT_FOUND' || data?.code === 'NOT_FOUND';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
