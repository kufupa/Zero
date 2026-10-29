// Pane bindings for saved availability reads and the HMS stay-save path. Save calls require the pane-save mode;
// availability reads only return an already-stored admission result and never start an HMS read.

import type { StayGroupRequirement } from './types';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const PANE_SAVE_LAB_GUARD_COPY =
  'Saving is only switched on for test bookings right now. Book this one by hand in HMS.';

export const PANE_CHILDREN_COPY = 'Bookings with children: enter in HMS for now';

// Shown on the write card while the pane save flag is off. Not the lab guard above, which is the server refusal copy.
export const PANE_SAVE_OFF_COPY = 'Saving to HMS from this pane is off for now. Book this one by hand in HMS.';

// HMS field limits. They mirror the server caps (pane-stay-save.ts) so an over-long value shows here, not as a refusal.
export const PANE_RESERVATION_NOTE_MAX = 2000;
export const PANE_PARTY_NAME_MAX = 100;
export const PANE_BOOKER_NAME_MAX = 50;
export const PANE_BOOKER_EMAIL_MAX = 80;

export const PANE_PREVIEW_FAILED_COPY =
  'Nava could not finish the preview in HMS. Nothing was saved. Press Preview in HMS again.';

export const PANE_COMMIT_UNREACHABLE_COPY =
  'Nava lost contact with HMS while booking. This booking may have been saved and is unconfirmed.';

const REFUSAL_COPY: Record<string, string> = {
  pane_save_flag_off: 'Saving in HMS is switched off for now. Copy each field into HMS by hand.',
  pane_save_labtest_required: PANE_SAVE_LAB_GUARD_COPY,
  pane_save_arrival_2027_required: PANE_SAVE_LAB_GUARD_COPY,
  pane_save_children_unsupported: PANE_CHILDREN_COPY,
  pane_save_adults_required:
    'This booking needs at least one adult. Enter it in HMS for now.',
  pane_save_property_mismatch:
    'This booking is for a different hotel than this HMS session. Book it by hand in HMS.',
  osress_reader_parked:
    "Nava couldn't confirm there's no existing booking for this guest, so it didn't save. Check HMS, then book by hand.",
  pane_save_parent_not_booked:
    "The first room of this booking isn't confirmed in HMS yet, so Nava didn't add this room. Check HMS, then try again.",
  pane_save_dependency_unconfirmed:
    'Another booking is still being checked. Nava did not save this room. Preview again when the check finishes.',
  pane_save_identity_required:
    "Nava couldn't connect this booking to the request, so nothing was saved. Reopen the request and try again.",
  pane_save_work_item_unavailable:
    "Nava couldn't check the saved booking state, so nothing was saved. Reopen the request and try again.",
  pane_save_parent_invalid: "Nava couldn't tell which booking to add this room to. Nothing was saved.",
  refused_parent_not_found:
    "Nava couldn't open the first room's booking in HMS, so it didn't add this room. Check HMS, then try again.",
  refused_parent_dates:
    "The first room's booking has different dates in HMS, so Nava didn't add this room. Check HMS, then book by hand.",
  refused_child_band_unsupported:
    'HMS adds extra rooms with child bands 0-2 and 3-12 only. Add this room by hand in HMS.',
  refused_form_mismatch: "HMS didn't take every value for this room, so Nava didn't save it. Check HMS, then book by hand.",
  osress_duplicate:
    'HMS already has a booking for this guest on these dates, so Nava did not save. Check HMS, then book by hand.',
  pane_save_preview_required:
    'This preview has expired or was already used. Press Preview in HMS again.',
  pane_save_digest_mismatch: 'The booking changed after the preview. Press Preview in HMS again.',
  pane_save_lock_unavailable: "Nava can't reach HMS right now. Nothing was saved. Tell the Nava team.",
  refused_lock_busy:
    'HMS is busy with another quote or lookup. Nothing was saved. Try again in a minute.',
  refused_save_blank_required:
    'HMS still has a blank required field. Nothing was saved. Fill in every field, then preview again.',
  refused_save:
    "Nava couldn't check for an existing booking in HMS. Nothing was saved. Preview again later.",
};

const REFUSED_FALLBACK = 'Nava stopped before saving anything. Check HMS, then book by hand.';

// The server's refusal for a save that may have booked the stay although no number came back.
export const PANE_SAVE_UNCONFIRMED_REASON = 'pane_save_unconfirmed';

export type PaneStayGuest = Pick<PaneStayInput, 'firstName' | 'lastName' | 'arrival' | 'departure'>;

// HMS may already hold the booking, so this never reads as a plain failure.
export function paneUnconfirmedMessage(stay?: PaneStayGuest): string {
  const guest = stay ? `${stay.firstName} ${stay.lastName}` : 'this guest';
  const dates = stay ? `${stay.arrival} – ${stay.departure}` : 'these dates';
  return `HMS may have saved this booking for ${guest} ${dates}, but Nava could not verify it.`;
}

export function paneRefusalMessage(reason: string | undefined, stay?: PaneStayGuest): string {
  if (reason === PANE_SAVE_UNCONFIRMED_REASON) return paneUnconfirmedMessage(stay);
  return (reason && REFUSAL_COPY[reason]) || REFUSED_FALLBACK;
}

/** lab: only Labtest stays arriving 2027 or later save. on: real guests save too. off: copy-only. */
export type PaneSaveMode = 'off' | 'lab' | 'on';

export type PaneStayParty = { nativeId?: string; name: string };

// The client Book fields. Key order is fixed so edits invalidate the matching preview.
export type PaneStayInput = {
  firstName: string;
  lastName: string;
  arrival: string;
  departure: string;
  adults: number;
  childAges?: number[];
  cmsMessageId?: string;
  confirmationSendMail?: boolean;
  sourceOfBusiness: string;
  roomType: string;
  ratePlan: string;
  track: string;
  marketSegment?: string;
  guestoptin4: boolean;
  guaranteeType: string;
  bookingAgency?: PaneStayParty;
  organization?: PaneStayParty;
  reservationNote?: string;
  bookerName?: string;
  bookerEmail?: string;
  /** HMS confirmation letter recipient. The create route ignores this until the letter field is wired. */
  confirmationRecipient?: { mode: 'self' | 'client' | 'custom'; address: string };
};

// Mirrors the server's PaneStayResult from quoteWorkflow.previewStay / commitStay.
export type PaneStayResult = {
  status: 'ok' | 'refused';
  reason?: string;
  cmsReason?: string;
  outcome?: string;
  confirmationNumber?: string;
  previewDigest?: string | null;
  runId?: string;
  screenshots?: string[];
};

export type PaneStayAvailabilityRequest = {
  threadId: string;
  kind: 'availability';
  arrival: string;
  departure: string;
  rooms: Array<{ roomType: string; quantity: number; adults: number; childAges: number[] }>;
};

export type PaneStayAvailabilityJobView = {
  status: 'queued' | 'running' | 'retrying' | 'done' | 'failed';
  asOf: string | null;
  result: Record<string, unknown> | null;
};

/** Reads the already-stored admission result; it never starts or polls an HMS read. */
export type PaneStayAvailabilityReader = (
  request: PaneStayAvailabilityRequest,
) => Promise<PaneStayAvailabilityJobView | null>;

/** The job route keys an admitted snapshot by thread, dates, and the ordered room groups. */
export function paneStayAvailabilityRequestFor(
  threadId: string | undefined,
  rows: readonly StayGroupRequirement[],
): PaneStayAvailabilityRequest | null {
  const first = rows[0];
  const arrival = first?.arrivalDate;
  const departure = first?.departureDate;
  if (!threadId?.trim() || !arrival || !departure || rows.length === 0 || rows.length > 8) return null;
  if (!DATE_PATTERN.test(arrival) || !DATE_PATTERN.test(departure)) return null;

  const rooms: PaneStayAvailabilityRequest['rooms'] = [];
  for (const row of rows) {
    const { quantity, adults, childrenAges, roomPreference } = row;
    if (
      row.arrivalDate !== arrival ||
      row.departureDate !== departure ||
      !roomPreference?.trim() ||
      typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 ||
      typeof adults !== 'number' || !Number.isInteger(adults) || adults < 1 ||
      !Array.isArray(childrenAges)
    ) return null;
    rooms.push({ roomType: roomPreference, quantity, adults, childAges: childrenAges });
  }

  return { threadId, kind: 'availability', arrival, departure, rooms };
}

export type PaneStayClient = {
  preview: (stay: PaneStayInput) => Promise<PaneStayResult>;
  commit: (stay: PaneStayInput, previewDigest: string) => Promise<PaneStayResult>;
  /** Screenshot as a PNG data URL, or null when the run is gone or not this owner's. */
  screenshot: (runId: string, name: string) => Promise<string | null>;
  /** The mode the server reported through this client's readPaneSaveFlag. null until that read has answered. */
  mode?: () => PaneSaveMode | null;
  readAvailability?: PaneStayAvailabilityReader;
};

type PaneStayTrpc = {
  quoteWorkflow?: {
    previewStay?: { mutate: (input: PaneStayInput) => Promise<PaneStayResult> };
    commitStay?: {
      mutate: (input: PaneStayInput & { previewDigest: string }) => Promise<PaneStayResult>;
    };
  };
  paneStayCancel?: {
    paneStayScreenshot?: {
      query: (input: {
        runId: string;
        name: string;
      }) => Promise<{ status: string; dataUrl?: string }>;
    };
  };
  brain?: {
    getCapabilities: {
      query: () => Promise<{
        paneSave?: boolean;
        paneSaveMode?: unknown;
        paneWrite?: { create?: unknown };
      }>;
    };
  };
  paneStayLookup?: {
    jobStatus?: { query: PaneStayAvailabilityReader };
  };
};

// The mode each tRPC client last reported. The pane page reads the flag and builds its client from one tRPC object.
// The root tRPC client is a Proxy over a function, so typeof is 'function', not 'object'.
const paneSaveModes = new WeakMap<object, PaneSaveMode>();

function isClientKey(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

export function paneSaveModeOf(
  capabilities:
    | {
        paneSave?: boolean;
        paneSaveMode?: unknown;
        paneWrite?: { create?: unknown };
      }
    | null
    | undefined,
): PaneSaveMode {
  const create = capabilities?.paneWrite?.create;
  if (create === 'off' || create === 'lab' || create === 'on') return create;
  if (capabilities?.paneSave !== true) return 'off';
  // A server that does not name the mode predates lab/on. Its only open mode was the Labtest guard, which is lab.
  return capabilities.paneSaveMode === 'on' ? 'on' : 'lab';
}

export function paneStayFromTrpc(trpc: unknown): PaneStayClient {
  const row = (trpc ?? {}) as PaneStayTrpc;
  return {
    readAvailability: async (input) => {
      const status = row.paneStayLookup?.jobStatus;
      return status ? status.query(input) : null;
    },
    preview: async (stay) => {
      const previewStay = row.quoteWorkflow?.previewStay;
      if (!previewStay) throw new Error('pane_save_client_missing');
      return previewStay.mutate(stay);
    },
    commit: async (stay, previewDigest) => {
      const commitStay = row.quoteWorkflow?.commitStay;
      if (!commitStay) throw new Error('pane_save_client_missing');
      return commitStay.mutate({ ...stay, previewDigest });
    },
    screenshot: async (runId, name) => {
      const screenshot = row.paneStayCancel?.paneStayScreenshot;
      if (!screenshot) return null;
      const result = await screenshot.query({ runId, name });
      return result.status === 'ok' && result.dataUrl ? result.dataUrl : null;
    },
    mode: () => (isClientKey(trpc) ? (paneSaveModes.get(trpc) ?? null) : null),
  };
}

// The server mode, read through the tRPC client. Any failure reads as off, so the card stays copy-only.
export async function readPaneSaveFlag(trpc: unknown): Promise<boolean> {
  let mode: PaneSaveMode = 'off';
  try {
    const capabilities = await (trpc as PaneStayTrpc).brain?.getCapabilities.query();
    mode = paneSaveModeOf(capabilities);
  } catch {
    mode = 'off';
  }
  if (isClientKey(trpc)) paneSaveModes.set(trpc, mode);
  return mode !== 'off';
}

export type PaneStayChoice = {
  roomType: string;
  track: string;
  sourceOfBusiness: string;
  marketSegment?: string;
  guestoptin4?: boolean;
  guaranteeType: string;
  ratePlan?: string;
  firstName?: string;
  lastName?: string;
  /** A bound HMS party, or text in legacy callers. A blank value is not sent. */
  bookingAgency?: string | PaneStayParty;
  organization?: string | PaneStayParty;
  reservationNote?: string;
  bookerName?: string;
  bookerEmail?: string;
  cmsMessageId?: string;
  confirmationSendMail?: boolean;
  confirmationRecipient?: { mode: 'self' | 'client' | 'custom'; address: string };
};

// Builds the stay for one room from its draft request and the staff's selects. Returns the names still
// missing when the stay cannot be sent yet.
export function paneStayInputForRoom(
  request: Record<string, unknown>,
  choice: PaneStayChoice,
): { stay: PaneStayInput | null; missing: string[] } {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const firstName = text(choice.firstName ?? request.firstName);
  const lastName = text(choice.lastName ?? request.lastName);
  const arrival = text(request.arrival);
  const departure = text(request.departure);
  const roomType = text(choice.roomType);
  const ratePlan = text(choice.ratePlan ?? request.ratePlan);
  const marketSegment = text(choice.marketSegment);
  const adultsRaw = request.adults;
  const adults =
    typeof adultsRaw === 'number'
      ? adultsRaw
      : typeof adultsRaw === 'string' && adultsRaw.trim() !== ''
        ? Number(adultsRaw)
        : Number.NaN;
  const nights =
    DATE_PATTERN.test(arrival) && DATE_PATTERN.test(departure) ? dayCount(arrival, departure) : 0;

  const missing: string[] = [];
  if (!firstName) missing.push('first name');
  if (!lastName) missing.push('last name');
  if (!DATE_PATTERN.test(arrival)) missing.push('arrival date');
  if (!DATE_PATTERN.test(departure) || nights <= 0) missing.push('departure date after arrival');
  if (!Number.isInteger(adults) || adults < 1 || adults > 16) missing.push('adults');
  if (!roomType) missing.push('room type');
  if (!ratePlan) missing.push('rate code');
  if (!choice.sourceOfBusiness) missing.push('source of business');
  if (!choice.track) missing.push('track');
  if (!choice.guaranteeType) missing.push('guarantee');
  const party = (value: string | PaneStayParty | undefined): PaneStayParty | undefined => {
    const name = text(typeof value === 'string' ? value : value?.name);
    if (!name) return undefined;
    const nativeId = typeof value === 'object' ? text(value.nativeId) : '';
    return { name, ...(nativeId ? { nativeId } : {}) };
  };
  const bookingAgency = party(choice.bookingAgency);
  const organization = party(choice.organization);
  const childAges = Array.isArray(request.childAges) ? request.childAges : [];
  if (childAges.length > 16 || childAges.some((age) =>
    typeof age !== 'number' || !Number.isInteger(age) || age < 0 || age > 17
  )) missing.push('child ages (0–17)');
  const cmsMessageId = text(choice.cmsMessageId);
  if (choice.confirmationSendMail && !cmsMessageId) missing.push('Confirmation type');
  const reservationNote = text(choice.reservationNote);
  const bookerName = text(choice.bookerName);
  const bookerEmail = text(choice.bookerEmail);
  // An over-long value is named here so Preview waits; the server would refuse it at the schema.
  const tooLong: Array<[boolean, string]> = [
    [(bookingAgency?.name.length ?? 0) > PANE_PARTY_NAME_MAX, `agency name (${PANE_PARTY_NAME_MAX} characters at most)`],
    [(organization?.name.length ?? 0) > PANE_PARTY_NAME_MAX, `organization name (${PANE_PARTY_NAME_MAX} characters at most)`],
    [reservationNote.length > PANE_RESERVATION_NOTE_MAX, `reservation note (${PANE_RESERVATION_NOTE_MAX} characters at most)`],
    [bookerName.length > PANE_BOOKER_NAME_MAX, `booker name (${PANE_BOOKER_NAME_MAX} characters at most)`],
    [bookerEmail.length > PANE_BOOKER_EMAIL_MAX, `booker email (${PANE_BOOKER_EMAIL_MAX} characters at most)`],
  ];
  for (const [over, name] of tooLong) if (over) missing.push(name);
  if (missing.length) return { stay: null, missing };

  return {
    stay: {
      firstName,
      lastName,
      arrival,
      departure,
      adults,
      ...(childAges.length ? { childAges: childAges as number[] } : {}),
      ...(cmsMessageId ? { cmsMessageId } : {}),
      ...(choice.confirmationSendMail !== undefined ? { confirmationSendMail: choice.confirmationSendMail } : {}),
      sourceOfBusiness: choice.sourceOfBusiness,
      roomType,
      ratePlan,
      track: choice.track,
      ...(marketSegment ? { marketSegment } : {}),
      guestoptin4: choice.guestoptin4 === true,
      guaranteeType: choice.guaranteeType,
      ...(bookingAgency ? { bookingAgency } : {}),
      ...(organization ? { organization } : {}),
      ...(reservationNote ? { reservationNote } : {}),
      ...(bookerName ? { bookerName } : {}),
      ...(bookerEmail ? { bookerEmail } : {}),
      ...(choice.confirmationRecipient ? { confirmationRecipient: choice.confirmationRecipient } : {}),
    },
    missing: [],
  };
}

function dayCount(arrival: string, departure: string): number {
  const start = Date.parse(`${arrival}T00:00:00Z`);
  const end = Date.parse(`${departure}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

// Two previews or commits match only when every field matches.
export function paneStayKey(stay: PaneStayInput): string {
  return JSON.stringify(stay);
}

export type PreviewOutcome =
  | { ok: true; digest: string; runId?: string; screenshots: string[] }
  | { ok: false; message: string };

export function previewOutcome(result: PaneStayResult): PreviewOutcome {
  if (result.status === 'refused') return { ok: false, message: paneRefusalMessage(result.reason) };
  if (result.outcome === 'previewed' && result.previewDigest) {
    return {
      ok: true,
      digest: result.previewDigest,
      runId: result.runId,
      screenshots: result.screenshots ?? [],
    };
  }
  return { ok: false, message: PANE_PREVIEW_FAILED_COPY };
}

export type CommitOutcome =
  | { ok: true; confirmationNumber: string; runId?: string; screenshots: string[]; unverified?: boolean; cmsMismatch?: boolean }
  | { ok: false; message: string; runId?: string; screenshots: string[] };

export const PANE_SAVE_UNVERIFIED_COPY = 'Booking not verified in HMS.';
export const PANE_CMS_MISMATCH_COPY = 'HMS confirmation settings did not match. Booking is unverified.';

export function commitOutcome(result: PaneStayResult, stay?: PaneStayGuest): CommitOutcome {
  const screenshots = result.screenshots ?? [];
  if (result.status === 'refused') {
    return { ok: false, message: paneRefusalMessage(result.reason, stay), runId: result.runId, screenshots };
  }
  if (result.outcome === 'committed_unverified') {
    return {
      ok: true,
      confirmationNumber: result.confirmationNumber ?? '',
      runId: result.runId,
      screenshots,
      unverified: true,
      ...(result.cmsReason === 'saved_cms_mismatch' ? { cmsMismatch: true } : {}),
    };
  }
  if (result.outcome === 'committed' && result.confirmationNumber) {
    return { ok: true, confirmationNumber: result.confirmationNumber, runId: result.runId, screenshots };
  }
  // Any other answer may still mean HMS saved the booking, so it is never a plain failure.
  return { ok: false, message: paneUnconfirmedMessage(stay), runId: result.runId, screenshots };
}
