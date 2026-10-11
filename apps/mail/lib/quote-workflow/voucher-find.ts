import { formatStayDate } from './amend-find';

/**
 * The "Find the booking" card for voucher and proof-of-payment mail. The server reads the guest surname and arrival
 * from the email and its voucher text (quoteWorkflow.voucherFind). The card resumes a matching HMS guest search or
 * starts one on open when both values are unambiguous, and saves the voucher file. It never books, changes or invents a
 * confirmation number.
 */

/** The values a voucher gives in more than one form. Present only when two or more differ. */
export type VoucherConflicts = { lastNames: string[]; arrivals: string[] };

/** What the voucher says. Each field is null when it is missing or ambiguous in the email. */
export type VoucherGuest = {
  lastName: string | null;
  arrival: string | null;
  conflicts?: VoucherConflicts;
};

export type VoucherFile = { id: string; filename: string; mimeType: string; sizeBytes: number };

export type VoucherFindReply =
  | { status: 'unsynced' }
  | { status: 'not_voucher' }
  | {
      status: 'voucher';
      messageId: string;
      /** The mail's thread, which the guest-name search job is anchored to. Optional so older replies still type-check. */
      threadId?: string;
      guest: VoucherGuest;
      file: VoucherFile | null;
      /** Voucher PDFs whose text was not read. Optional so older replies still type-check. The quote panel names each file. */
      unreadPdfs?: number;
    };

export type VoucherFindClient = {
  check: (input: { internetMessageId: string }) => Promise<VoucherFindReply>;
};

type TrpcVoucherRoutes = {
  quoteWorkflow?: {
    voucherFind?: { query: (input: { internetMessageId: string }) => Promise<VoucherFindReply> };
  };
};

/** Binds quoteWorkflow.voucherFind off a tRPC client. Null when the route is missing. */
export function voucherFindClientFromTrpc(trpc: unknown): VoucherFindClient | null {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const route = (trpc as TrpcVoucherRoutes).quoteWorkflow?.voucherFind;
  if (!route) return null;
  return { check: (input) => route.query(input) };
}

export const VOUCHER_COPY = {
  heading: 'Find the booking',
  caption:
    'Read from this voucher or proof of payment. Nava only searches HMS and saves the file. It books and changes nothing.',
  missingGuest:
    'Nava could not read the guest surname from this email. Find the booking by name in HMS.',
  missingArrival:
    'Nava could not read the arrival date from this email. Find the booking by name in HMS.',
  conflictLastNames: 'More than one guest name is on this voucher. Nava did not pick one:',
  conflictArrivals: 'More than one arrival date is on this voucher. Nava did not pick one:',
  waitingForSync: 'Waiting for this email to sync. Nava checks it again when the sync lands.',
  search: 'Find the booking in HMS',
  matchedBooking: 'Matched booking',
  searching: 'Nava is searching HMS by guest name… (about 1 minute)',
  pickRow: 'Open a booking in HMS with the buttons beside it.',
  save: 'Save attachment',
  saving: 'Saving…',
  saved: 'Saved. Upload it in HMS Documents.',
  saveFailed: "Nava couldn't save the attachment. Try again, or save it from the email by hand.",
  noFile: 'No file to save from this email.',
} as const;

/** One line naming the guest and arrival Luna read, or null when it read neither. */
export function voucherGuestLine(guest: VoucherGuest): string | null {
  const parts = [
    guest.lastName ? `Guest ${guest.lastName}` : null,
    guest.arrival ? `arriving ${formatStayDate(guest.arrival)}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Notes for the values that disagree. Each one lists the candidates, so staff choose; nothing is picked. */
export function voucherConflictLines(guest: VoucherGuest): string[] {
  const lines: string[] = [];
  const names = guest.conflicts?.lastNames ?? [];
  if (names.length > 1) lines.push(`${VOUCHER_COPY.conflictLastNames} ${names.join(', ')}.`);
  const days = guest.conflicts?.arrivals ?? [];
  if (days.length > 1) {
    lines.push(`${VOUCHER_COPY.conflictArrivals} ${days.map((day) => formatStayDate(day)).join(', ')}.`);
  }
  return lines;
}

/** The search can run only with a surname and an arrival day read from the email. */
export function canSearchVoucher(
  guest: VoucherGuest,
): guest is { lastName: string; arrival: string } {
  return (
    guest.lastName !== null &&
    guest.arrival !== null &&
    (guest.conflicts?.lastNames.length ?? 0) < 2 &&
    (guest.conflicts?.arrivals.length ?? 0) < 2
  );
}
