// Pane side of the HMS save path. Preview fills the stay in HMS and checks availability; Book saves it.
// The server answers only when RESERVATIONIST_PANE_SAVE is lab or on (brain.getCapabilities.paneSave). Every
// refusal the server can return is mapped here to plain words plus the next step.

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
  pane_save_flag_off: 'Saving in HMS is switched off for now. Copy each field into HMS by hand.',
  pane_save_labtest_required: PANE_SAVE_LAB_GUARD_COPY,
  pane_save_arrival_2027_required: PANE_SAVE_LAB_GUARD_COPY,
  pane_save_children_unsupported: PANE_CHILDREN_COPY,
  pane_save_property_mismatch:
    'This booking is for a different hotel than this HMS session. Book it by hand in HMS.',
  osress_reader_parked:
    "Nava couldn't confirm there's no existing booking for this guest, so it didn't save. Check HMS, then book by hand.",
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
  if (reason === PANE_SAVE_UNCONFIRMED_REASON) return paneUnconfirmedMessage(stay);
  return (reason && REFUSAL_COPY[reason]) || REFUSED_FALLBACK;
}

/** lab: only Labtest stays arriving 2027 or later save. on: real guests save too. off: copy-only. */
export type PaneSaveMode = 'off' | 'lab' | 'on';

export type PaneStayParty = { nativeId?: string; name: string };

// The stay as the server takes it (paneStayInput). Key order is fixed so the field key is stable.
export type PaneStayInput = {
  firstName: string;
  lastName: string;
  arrival: string;
  departure: string;
  adults: number;
  childAges?: number[];
  sourceOfBusiness: string;
  roomType: string;
  ratePlan: string;
  track: string;
  guaranteeType: string;
  bookingAgency?: PaneStayParty;
  organization?: PaneStayParty;
  reservationNote?: string;
  bookerName?: string;
  bookerEmail?: string;
};

// Mirrors the server's PaneStayResult from quoteWorkflow.previewStay / commitStay.
export type PaneStayResult = {
  status: 'ok' | 'refused';
  reason?: string;
  outcome?: string;
  confirmationNumber?: string;
  previewDigest?: string | null;
  runId?: string;
  screenshots?: string[];
};

export type PaneStayClient = {
  preview: (stay: PaneStayInput) => Promise<PaneStayResult>;
  commit: (stay: PaneStayInput, previewDigest: string) => Promise<PaneStayResult>;
  /** Screenshot as a PNG data URL, or null when the run is gone or not this owner's. */
  screenshot: (runId: string, name: string) => Promise<string | null>;
  /** The mode the server reported through this client's readPaneSaveFlag. null until that read has answered. */
  mode?: () => PaneSaveMode | null;
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
    getCapabilities: { query: () => Promise<{ paneSave?: boolean; paneSaveMode?: unknown }> };
  };
};

// The mode each tRPC client last reported. The pane page reads the flag and builds its client from one tRPC object.
// The root tRPC client is a Proxy over a function, so typeof is 'function', not 'object'.
const paneSaveModes = new WeakMap<object, PaneSaveMode>();

function isClientKey(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

export function paneSaveModeOf(
  capabilities: { paneSave?: boolean; paneSaveMode?: unknown } | null | undefined,
): PaneSaveMode {
  if (capabilities?.paneSave !== true) return 'off';
  // A server that does not name the mode predates lab/on. Its only open mode was the Labtest guard, which is lab.
  return capabilities.paneSaveMode === 'on' ? 'on' : 'lab';
}

export function paneStayFromTrpc(trpc: unknown): PaneStayClient {
  const row = (trpc ?? {}) as PaneStayTrpc;
  return {
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
  guaranteeType: string;
  /** Typed in the card. A blank value is not sent. */
  bookingAgency?: string;
  organization?: string;
  reservationNote?: string;
  bookerName?: string;
  bookerEmail?: string;
};

// Builds the stay for one room from its draft request and the staff's selects. Returns the names still
// missing when the stay cannot be sent yet.
export function paneStayInputForRoom(
  request: Record<string, unknown>,
  choice: PaneStayChoice,
): { stay: PaneStayInput | null; missing: string[] } {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const firstName = text(request.firstName);
  const lastName = text(request.lastName);
  const arrival = text(request.arrival);
  const departure = text(request.departure);
  const roomType = text(choice.roomType);
  const ratePlan = text(request.ratePlan);
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
  if (!Number.isInteger(adults) || adults < 0 || adults > 16) missing.push('adults');
  if (!roomType) missing.push('room type');
  if (!ratePlan) missing.push('rate code');
  if (!choice.sourceOfBusiness) missing.push('source of business');
  if (!choice.track) missing.push('track');
  if (!choice.guaranteeType) missing.push('guarantee');
  const bookingAgency = text(choice.bookingAgency);
  const organization = text(choice.organization);
  const reservationNote = text(choice.reservationNote);
  const bookerName = text(choice.bookerName);
  const bookerEmail = text(choice.bookerEmail);
  // An over-long value is named here so Preview waits; the server would refuse it at the schema.
  const tooLong: Array<[boolean, string]> = [
    [bookingAgency.length > PANE_PARTY_NAME_MAX, `agency name (${PANE_PARTY_NAME_MAX} characters at most)`],
    [organization.length > PANE_PARTY_NAME_MAX, `organization name (${PANE_PARTY_NAME_MAX} characters at most)`],
    [reservationNote.length > PANE_RESERVATION_NOTE_MAX, `reservation note (${PANE_RESERVATION_NOTE_MAX} characters at most)`],
    [bookerName.length > PANE_BOOKER_NAME_MAX, `booker name (${PANE_BOOKER_NAME_MAX} characters at most)`],
    [bookerEmail.length > PANE_BOOKER_EMAIL_MAX, `booker email (${PANE_BOOKER_EMAIL_MAX} characters at most)`],
  ];
  for (const [over, name] of tooLong) if (over) missing.push(name);
  if (missing.length) return { stay: null, missing };

  const childAges = Array.isArray(request.childAges)
    ? request.childAges.filter((age): age is number => Number.isInteger(age))
    : [];
  return {
    stay: {
      firstName,
      lastName,
      arrival,
      departure,
      adults,
      ...(childAges.length ? { childAges } : {}),
      sourceOfBusiness: choice.sourceOfBusiness,
      roomType,
      ratePlan,
      track: choice.track,
      guaranteeType: choice.guaranteeType,
      ...(bookingAgency ? { bookingAgency: { name: bookingAgency } } : {}),
      ...(organization ? { organization: { name: organization } } : {}),
      ...(reservationNote ? { reservationNote } : {}),
      ...(bookerName ? { bookerName } : {}),
      ...(bookerEmail ? { bookerEmail } : {}),
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
  | { ok: true; confirmationNumber: string; runId?: string; screenshots: string[] }
  | { ok: false; message: string; runId?: string; screenshots: string[] };

export function commitOutcome(result: PaneStayResult, stay?: PaneStayGuest): CommitOutcome {
  const screenshots = result.screenshots ?? [];
  if (result.status === 'refused') {
    return { ok: false, message: paneRefusalMessage(result.reason, stay), runId: result.runId, screenshots };
  }
  if (result.outcome === 'committed' && result.confirmationNumber) {
    return { ok: true, confirmationNumber: result.confirmationNumber, runId: result.runId, screenshots };
  }
  // Any other answer may still mean HMS saved the booking, so it is never a plain failure.
  return { ok: false, message: paneUnconfirmedMessage(stay), runId: result.runId, screenshots };
}
