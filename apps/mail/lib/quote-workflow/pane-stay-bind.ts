// Pane bindings for saved availability reads and the HMS stay-save path. Save calls require the pane-save mode;
// availability reads only return an already-stored admission result and never start an HMS read.

import type { StayGroupRequirement } from './types';
import { stayTotalMismatch } from './stay-allocation-validation';

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
  'Nava lost contact with HMS while booking, so it is not clear whether HMS saved it. Check HMS for this guest before booking again.';

const REFUSAL_COPY: Record<string, string> = {
  cloud_create_field_unsupported: 'Nava cannot enter one of these details in HMS yet. Book this stay by hand in HMS.',
  property_mismatch: 'This booking is for a different hotel than this HMS session. Book it by hand in HMS.',
  labtest_guest_required: PANE_SAVE_LAB_GUARD_COPY,
  cloud_create_guarantee_unsupported: 'Nava cannot use this guarantee yet. Book this stay by hand in HMS.',
  adults_required: 'Add at least one adult before previewing this booking.',
  child_ages_required: 'Add an age for each child before previewing this booking.',
  source_of_business_required: 'Choose a source of business before previewing this booking.',
  staff_note_required: 'Add a reservation note of up to 200 characters before previewing.',
  native_room_codes_required: 'Choose a room type and rate plan from HMS before previewing.',
  cms_message_invalid: 'Nava could not confirm the confirmation choice. Check the details and preview again.',
  booking_agency_id_and_name_required: 'Choose the booking agency from HMS before previewing.',
  organization_id_and_name_required: 'Choose the company from HMS before previewing.',
  prepared_guest_identity_required: 'Nava could not confirm the guest profile. Check it and preview again.',
  cloud_create_proof_mismatch: 'The HMS preview does not match this request. Check the details and preview again.',
  cloud_create_party_mismatch: 'The agency or company in HMS does not match this request. Check the details and preview again.',
  cloud_create_proof_invalid: 'Nava could not verify the HMS preview. Check the details and preview again.',
  pane_save_flag_off: 'Saving in HMS is switched off for now. Copy each field into HMS by hand.',
  pane_create_dispatch_unavailable:
    'Nava did not save this booking on this attempt. Check HMS before booking by hand.',
  pane_save_labtest_required: PANE_SAVE_LAB_GUARD_COPY,
  pane_save_arrival_2027_required: PANE_SAVE_LAB_GUARD_COPY,
  trusted_staff_create_authorization_unavailable:
    'Nava cannot confirm approval for this booking yet. Nothing was saved. Book it by hand in HMS.',
  confirmation_email_writer_unavailable:
    'Nava cannot send a confirmation for this test booking. Turn off HMS confirmation and preview again.',
  pane_save_children_unsupported: PANE_CHILDREN_COPY,
  pane_save_adults_required:
    'This booking needs at least one adult. Enter it in HMS for now.',
  pane_save_property_mismatch:
    'This booking is for a different hotel than this HMS session. Book it by hand in HMS.',
  osress_reader_parked:
    "Nava couldn't confirm there's no existing booking for this guest, so it didn't save. Check HMS, then book by hand.",
  pane_save_parent_not_booked:
    "The first room of this booking isn't confirmed in HMS yet, so Nava didn't add this room. Check HMS, then try again.",
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
  pane_preview_persist_failed: PANE_PREVIEW_FAILED_COPY,
  pane_preview_binding_required: 'Nava could not link this preview to the booking. Nothing was saved. Check the booking details and try again.',
  pane_save_digest_mismatch: 'The booking changed after the preview. Press Preview in HMS again.',
  pane_save_lock_unavailable: "Nava can't reach HMS right now. Nothing was saved. Tell the Nava team.",
  refused_lock_busy:
    'HMS is busy with another quote or lookup. Nothing was saved. Try again in a minute.',
  refused_save_blank_required:
    'HMS still has a blank required field. Nothing was saved. Fill in every field, then preview again.',
};

const REFUSED_FALLBACK = 'Nava stopped before saving anything. Check HMS, then book by hand.';

// The server's refusal for a save that may have booked the stay although no number came back.
export const PANE_SAVE_UNCONFIRMED_REASON = 'pane_save_unconfirmed';

export type PaneStayGuest = Pick<PaneStayInput, 'firstName' | 'lastName' | 'arrival' | 'departure'>;

// HMS may already hold the booking, so this never reads as a plain failure. Staff check HMS first.
export function paneUnconfirmedMessage(stay?: PaneStayGuest): string {
  const guest = stay ? `${stay.firstName} ${stay.lastName}` : 'this guest';
  const dates = stay ? `${stay.arrival} – ${stay.departure}` : 'these dates';
  return `HMS may have saved this booking. Check HMS for ${guest} ${dates} before trying again.`;
}

export function paneRefusalMessage(reason: string | undefined, stay?: PaneStayGuest): string {
  if (reason === PANE_SAVE_UNCONFIRMED_REASON || reason === 'write_in_flight') return paneUnconfirmedMessage(stay);
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
      row.fields.adults === 'missing' ||
      row.fields.childAges === 'missing' ||
      typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 ||
      typeof adults !== 'number' || !Number.isInteger(adults) || adults < 1 ||
      !Array.isArray(childrenAges)
    ) return null;
    rooms.push({ roomType: roomPreference, quantity, adults, childAges: childrenAges });
  }
  if (stayTotalMismatch(rows)) return null;

  return { threadId, kind: 'availability', arrival, departure, rooms };
}

export type PaneStayClient = {
  preview: (stay: PaneStayInput) => Promise<PaneStayResult>;
  commit: (stay: PaneStayInput, previewDigest: string) => Promise<PaneStayResult>;
  /** Screenshot as a PNG data URL, or null when the run is gone or not this owner's. */
  screenshot: (runId: string, name: string) => Promise<string | null>;
  /** The held create mode after this client's readPaneSaveFlag. null until that read has answered. */
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
        paneAttach?: unknown;
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
    // A stale server can still expose the legacy writer, so neither operation
    // may reach it while the source-bound create bridge is unavailable.
    preview: async () => ({ status: 'refused', reason: 'pane_create_dispatch_unavailable' }),
    commit: async () => ({ status: 'refused', reason: 'pane_create_dispatch_unavailable' }),
    screenshot: async (runId, name) => {
      const screenshot = row.paneStayCancel?.paneStayScreenshot;
      if (!screenshot) return null;
      const result = await screenshot.query({ runId, name });
      return result.status === 'ok' && result.dataUrl ? result.dataUrl : null;
    },
    mode: () => (isClientKey(trpc) ? (paneSaveModes.get(trpc) ?? null) : null),
  };
}

// Create, legacy filing and shared approval stay off even against an old server.
export async function readPaneSaveCapabilities(trpc: unknown): Promise<{
  saveEnabled: boolean; attachWritesEnabled: boolean;
}> {
  if (isClientKey(trpc)) paneSaveModes.set(trpc, 'off');
  return { saveEnabled: false, attachWritesEnabled: false };
}

export async function readPaneSaveFlag(trpc: unknown): Promise<boolean> {
  return (await readPaneSaveCapabilities(trpc)).saveEnabled;
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

export const PANE_SAVE_UNVERIFIED_COPY = 'Saved — check in Infor';
export const PANE_CMS_MISMATCH_COPY = 'Booked, but HMS confirmation settings did not match — check CMS in HMS';

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
