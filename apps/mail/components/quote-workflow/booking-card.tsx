'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  BookingDraftReady,
  BookingRateCheck,
  QuoteSession,
  StaffQuoteParties,
  StaffQuoteParty,
  StayGroupRequirement,
} from '@/lib/quote-workflow/types';
import { prefillReservationNote, reservationNoteForGroup } from '@/lib/quote-workflow/reservation-note';
import { HmsLinkActions } from './hms-link-actions';
import { CopyHmsNotesButton, hmsNotesBlock } from './rate-controls';
import { rowRoomLabel } from '@/lib/quote-workflow/room-types';
import type { StoredContact } from '@/lib/quote-workflow/backend-bind';
import { recalledGuestName } from '@/lib/quote-workflow/guest-name-cache';
import { trackPaneAction } from '@/lib/quote-workflow/pane-telemetry';
import { subscribeStayingGuestName } from './quote-people-step';
import { usePaneStayPreview } from './use-pane-stay-preview';
import {
  commitOutcome,
  PANE_BOOKER_NAME_MAX,
  PANE_CHILDREN_COPY,
  PANE_COMMIT_UNREACHABLE_COPY,
  PANE_PARTY_NAME_MAX,
  PANE_PREVIEW_FAILED_COPY,
  PANE_RESERVATION_NOTE_MAX,
  PANE_SAVE_UNVERIFIED_COPY,
  paneStayInputForRoom,
  paneStayKey,
  paneUnconfirmedMessage,
  previewOutcome,
  type PaneSaveMode,
  type PaneStayChoice,
  type PaneStayClient,
  type PaneStayInput,
} from '@/lib/quote-workflow/pane-stay-bind';
import { Notice, paneFieldClass, PrimaryButton, SecondaryButton } from '@/components/nava-pane/pane-ui';
import {
  ConfirmationRecipient,
  resolveConfirmationRecipient,
  useConfirmationSources,
  type ConfirmationMode,
  type ConfirmationRecipientPayload,
  type ConfirmationSources,
} from './confirmation-recipient';

const COPIED_MS = 1500;
const COPY_FAILED_MS = 3000;

export const BOARD_LABELS: Record<string, string | undefined> = {
  room_only: 'Room only',
  bb: 'Bed & breakfast',
  dinner_bb: 'Dinner, bed & breakfast',
};

const BOOKING_FLAG_COPY: Record<string, string | undefined> = {
  party_rate_not_applied:
    'Company rate not applied: the booking has no company attached. Check the rate in HMS before booking.',
  joint_inventory_unproven:
    'Rooms for all stays are not proven to be free together. Check availability in HMS before booking.',
  manual_rate_change:
    'This quote used a saved, one-off or override rate. HMS books at its own rate: change the room rate in HMS to the quoted rate.',
};

const RATE_CHECK_REASON_COPY: Record<string, string | undefined> = {
  ambiguous_stay: 'the email has more than one stay',
  ambiguous_basis: 'it is unclear whether the rate is per room or for the whole stay',
  amount_precision: 'the amount format is unclear',
  amount_overflow: 'the amount is too large to compare',
  incompatible_scope_currency_or_tax: 'the rate is in a different currency or tax basis',
  invalid_contract: 'the rate agreement could not be read',
  invalid_target: 'the quoted total could not be matched',
  nightly_target_unavailable: 'no nightly rate is available to compare',
  not_a_price_agreement: 'the email gives a budget, not a price',
  rounding_boundary_unknown: 'the rounding is too close to call',
  source_missing: 'the email does not show where the rate came from',
};

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function initialSourceOfBusiness(requestSource: unknown, options: string[]): string {
  const source = textValue(requestSource);
  if (source) return source;

  return (
    options.find((option) => {
      const normalized = option.trim().toLowerCase();
      return normalized === 'email' || normalized.startsWith('e-mail') || normalized.startsWith('email');
    }) ?? ''
  );
}

// A company or agency picked for the quote fills an empty field with its HMS name. Only a pick with an HMS id counts.
function pickedName(party: StaffQuoteParty | undefined): string {
  return party?.nativeId ? party.name : '';
}

// Fallback for webviews without the async clipboard API, or where it rejects: select a
// hidden textarea and use the legacy copy command, which still works in those hosts.
function copyViaSelection(value: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

async function writeClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return copyViaSelection(value);
  }
}

export const ROOM_TYPE_CHANGED_COPY =
  'Room type changed from the quote, so the price check no longer applies. Quote again to check the price for this room.';

export const AMBIGUOUS_GUEST_NAME_COPY = 'Enter first and last name for the staying guest.';

// Exactly two tokens is a first + last split. One token or three-plus is ambiguous, so staff type the fields.
function splitStayingGuestName(name: string): { firstName: string; lastName: string; ambiguous: boolean } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 2) {
    return { firstName: parts[0]!, lastName: parts[1]!, ambiguous: false };
  }
  return { firstName: '', lastName: '', ambiguous: true };
}

function namesFromSelectedGuest(
  selectedGuestName: string,
  request: { firstName?: unknown; lastName?: unknown },
): { firstName: string; lastName: string } {
  const split = splitStayingGuestName(selectedGuestName);
  if (!split.ambiguous) {
    return { firstName: split.firstName, lastName: split.lastName };
  }
  return { firstName: textValue(request.firstName), lastName: textValue(request.lastName) };
}

function readSelectedGuestName(guestEditorKey?: string, guestName?: string): string {
  const recalled = guestEditorKey ? recalledGuestName(guestEditorKey) : null;
  return recalled ?? guestName ?? '';
}

function missingFactLabel(question: string): string {
  return question.replace(/\s+for this booking\??$/i, '').replace(/\?$/, '');
}

function RateCheckChip({ check }: { check: BookingRateCheck }) {
  if (check.status === 'match') {
    return (
      <Notice tone="success">
        Price matches the email
        {check.assumedTaxBasis ? ' · assumes the price includes VAT' : ''}
      </Notice>
    );
  }
  if (check.status === 'mismatch') {
    return (
      <Notice tone="warn">
        Price differs from the email: {check.claimQuote}
        {check.assumedTaxBasis ? ' · assumes the price includes VAT' : ''}
      </Notice>
    );
  }
  const why = check.reason ? RATE_CHECK_REASON_COPY[check.reason] : undefined;
  return (
    <Notice>
      Could not compare with the email{why ? `: ${why}` : ''}
      {check.assumedTaxBasis ? ' · assumes the price includes VAT' : ''}
    </Notice>
  );
}

type CopyStatus = 'idle' | 'copied' | 'failed';

function CopyButton({ label, roomLabel, value }: { label: string; roomLabel: string; value: string }) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  useEffect(() => {
    if (status === 'idle') return;
    const timer = window.setTimeout(
      () => setStatus('idle'),
      status === 'copied' ? COPIED_MS : COPY_FAILED_MS,
    );
    return () => window.clearTimeout(timer);
  }, [status]);
  const copied = status === 'copied';
  return (
    <>
      <button
        type="button"
        disabled={!value}
        aria-label={`${copied ? 'Copied' : 'Copy'} ${label} for ${roomLabel}`}
        onClick={() => {
          void writeClipboard(value).then((ok) => {
            setStatus(ok ? 'copied' : 'failed');
            if (ok) trackPaneAction({ type: 'copy.hms_line', kind: 'booking' });
          });
        }}
        className="h-6 shrink-0 rounded-xs border border-[#cbd5e1] bg-white px-2 text-[11px] font-semibold text-[#0066cc] disabled:text-[#94a3b8]"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      {status === 'failed' ? (
        <span role="status" className="shrink-0 text-[11px] text-amber-800">
          Copy failed – select the text
        </span>
      ) : null}
    </>
  );
}

const PREVIEW_SHOT = 'filled.png';
const SAVED_SHOT = 'saved.png';
const CREATE_PROVISIONAL_LABEL = 'Create provisional booking';
const BOOK_THIS_STAY_LABEL = 'Book this stay';
const WRITES_OFF_LABEL = 'Booking writes are off — create in HMS';
const LAB_WRITE_NOTE = 'This write is test-only. Book a real guest in HMS.';
const textareaClass =
  'outline-hidden w-full rounded-xs border border-[#cbd5e1] bg-white px-2 py-1 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]';

type PreviewView =
  | { status: 'running'; key: string; requestId: symbol }
  | { status: 'ready'; key: string; digest: string; runId?: string; screenshots: string[] }
  | { status: 'refused'; key: string; message: string }
  | { status: 'stale'; key: string };

type PreviewInput = { key: string | null; inputKey: string | null; stayId: string };

type CommitView =
  | { status: 'running'; key: string }
  | {
      status: 'booked';
      key: string;
      confirmationNumber: string;
      runId?: string;
      screenshots: string[];
      unverified?: boolean;
    }
  | { status: 'refused'; key: string; message: string; runId?: string; screenshots?: string[] };

type RoomSaveState = { preview?: PreviewView; commit?: CommitView };

export type SavedStayCommit = {
  confirmationNumber: string | null;
  status: 'booked' | 'unknown';
  screenshotRef: { runId: string; name: string } | null;
};

function stayIdForRoom(
  room: { groupId: string; roomIndex: number },
  groups: StayGroupRequirement[],
): string {
  const group =
    groups.find((item) => item.id === room.groupId) ??
    groups.find((item) => `${item.arrivalDate ?? ''}:${item.departureDate ?? ''}` === room.groupId);
  const stay = group?.stayId ?? room.groupId;
  return `${stay}_${room.roomIndex}`;
}

function paneStayPreviewKey(workItemId: string | undefined, stayId: string, inputKey: string): string {
  return JSON.stringify([workItemId?.trim() || null, stayId.trim(), inputKey]);
}

function commitViewFromSaved(
  saved: SavedStayCommit,
  stay: { firstName?: string; lastName?: string; arrival?: string; departure?: string },
): CommitView {
  const runId = saved.screenshotRef?.runId;
  const screenshots = saved.screenshotRef ? [saved.screenshotRef.name] : [];
  if (saved.confirmationNumber) {
    return {
      status: 'booked',
      key: '',
      confirmationNumber: saved.confirmationNumber,
      runId,
      screenshots,
      ...(saved.status === 'unknown' ? { unverified: true } : {}),
    };
  }
  return {
    status: 'refused',
    key: '',
    message: paneUnconfirmedMessage({
      firstName: textValue(stay.firstName) || 'this guest',
      lastName: textValue(stay.lastName),
      arrival: textValue(stay.arrival),
      departure: textValue(stay.departure),
    }),
    runId,
    screenshots,
  };
}

function savesFromSavedStays(
  draft: BookingDraftReady,
  groups: StayGroupRequirement[],
  savedStays: Record<string, SavedStayCommit> | undefined,
): Record<string, RoomSaveState> {
  if (!savedStays) return {};
  const saves: Record<string, RoomSaveState> = {};
  for (const room of draft.draft.rooms) {
    const saved = savedStays[stayIdForRoom(room, groups)];
    if (!saved) continue;
    saves[`${room.groupId}:${room.roomIndex}`] = { commit: commitViewFromSaved(saved, room.request) };
  }
  return saves;
}

function pickScreenshot(names: string[], preferred: string): string | null {
  if (names.includes(preferred)) return preferred;
  return names.length ? names[names.length - 1]! : null;
}

// Thumbnail of one HMS run screenshot. Press it for the full-size view.
function PaneScreenshot({
  caption,
  runId,
  name,
  screenshot,
}: {
  caption: string;
  runId: string;
  name: string;
  screenshot: PaneStayClient['screenshot'];
}) {
  // undefined = still loading, null = not available, string = PNG data URL.
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setSrc(undefined);
    screenshot(runId, name).then(
      (url) => {
        if (alive) setSrc(url);
      },
      () => {
        if (alive) setSrc(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [runId, name, screenshot]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (src === undefined) return <p className="text-[11px] text-[#64748b]">Loading the HMS screenshot…</p>;
  if (src === null) {
    return (
      <p className="text-[11px] text-amber-800">The HMS screenshot is no longer available. Check HMS directly.</p>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-fit flex-col items-start gap-1 rounded-xs border border-[#cbd5e1] bg-white p-1"
      >
        <img src={src} alt="" className="max-h-24 w-auto" />
        <span className="text-[11px] font-semibold text-[#0066cc]">{caption}</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={caption}
          className="fixed inset-0 z-50 flex flex-col gap-2 overflow-auto bg-black/80 p-4"
        >
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-8 rounded-xs bg-white px-3 text-[12px] font-semibold text-[#1e293b]"
            >
              Close
            </button>
          </div>
          <img src={src} alt={caption} className="w-full bg-white" />
        </div>
      ) : null}
    </>
  );
}

// Preview and Book for one room. Book unlocks only for the preview of these exact fields.
function RoomSave({
  stay,
  previewKey,
  missing,
  save,
  screenshot,
  bookLabel,
  frozen = false,
  onPreview,
  onBook,
}: {
  stay: PaneStayInput | null;
  previewKey: string | null;
  missing: string[];
  save: RoomSaveState;
  screenshot: PaneStayClient['screenshot'];
  bookLabel: string;
  frozen?: boolean;
  onPreview: (stay: PaneStayInput) => void;
  onBook: (stay: PaneStayInput, previewDigest: string) => void;
}) {
  const { preview, commit } = save;
  const busy = frozen || preview?.status === 'running' || commit?.status === 'running';
  const fresh = stay && preview?.status === 'ready' && preview.key === previewKey ? preview : null;
  const changed =
    preview?.status === 'stale' ||
    ((preview?.status === 'running' || preview?.status === 'ready') && preview.key !== previewKey);

  if (commit?.status === 'booked') {
    const savedShot = commit.screenshots.includes(SAVED_SHOT) ? SAVED_SHOT : null;
    return (
      <div className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
        <p data-pii className="text-[12.5px] font-semibold text-emerald-800">
          {commit.unverified
            ? PANE_SAVE_UNVERIFIED_COPY
            : `Booked in HMS – confirmation ${commit.confirmationNumber}`}
        </p>
        {commit.confirmationNumber ? (
          <HmsLinkActions
            confirmation={commit.confirmationNumber}
            guestSurname={stay?.lastName}
            arrival={stay?.arrival}
          />
        ) : null}
        {commit.runId && savedShot ? (
          <PaneScreenshot
            caption="See what Nava saved in HMS"
            runId={commit.runId}
            name={savedShot}
            screenshot={screenshot}
          />
        ) : null}
      </div>
    );
  }

  const previewShot = fresh?.runId ? pickScreenshot(fresh.screenshots, PREVIEW_SHOT) : null;
  const refusedShot = commit?.status === 'refused' ? pickScreenshot(commit.screenshots ?? [], SAVED_SHOT) : null;
  return (
    <div className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
      {preview?.status === 'running' ? (
        <p role="status" className="text-[11.5px] text-[#334155]">
          Nava is filling the booking in HMS… (about 2 minutes)
        </p>
      ) : null}
      {preview?.status === 'refused' && preview.key === previewKey ? (
        <p role="alert" className="text-[11.5px] text-amber-900">
          {preview.message}
        </p>
      ) : null}
      {changed && preview?.status !== 'running' ? (
        <p role="alert" className="text-[11.5px] text-amber-900">
          You changed the booking – preview again.
        </p>
      ) : null}
      {fresh && stay && fresh.runId && previewShot ? (
        <PaneScreenshot
          caption="See what Nava filled in HMS"
          runId={fresh.runId}
          name={previewShot}
          screenshot={screenshot}
        />
      ) : null}
      {fresh && stay ? (
        <p data-pii className="text-[12px] text-[#1e293b]">
          {`Nava will book ${stay.firstName} ${stay.lastName} for ${stay.arrival} – ${stay.departure}, 1 room, rate ${stay.ratePlan}. Nothing is saved until you press ${bookLabel}.`}
        </p>
      ) : null}
      {commit?.status === 'running' ? (
        <p role="status" className="text-[11.5px] text-[#334155]">
          Nava is booking this in HMS… (about 2 minutes)
        </p>
      ) : null}
      {commit?.status === 'refused' ? (
        <>
          <p role="alert" className="text-[11.5px] text-amber-900">
            {commit.message}
          </p>
          {commit.runId && refusedShot ? (
            <PaneScreenshot
              caption="See what Nava saved in HMS"
              runId={commit.runId}
              name={refusedShot}
              screenshot={screenshot}
            />
          ) : null}
        </>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <SecondaryButton
          disabled={!stay || busy}
          className="w-full"
          onClick={() => {
            if (stay) onPreview(stay);
          }}
        >
          Preview in HMS
        </SecondaryButton>
        <PrimaryButton
          disabled={!fresh || busy}
          disabledReason={!stay || busy ? null : 'Preview in HMS first'}
          onClick={() => {
            if (stay && fresh) onBook(stay, fresh.digest);
          }}
        >
          {bookLabel}
        </PrimaryButton>
      </div>
      <p className="text-[11px] text-[#64748b]">
        {stay
          ? 'Nava fills the booking in HMS and checks availability. Nothing is saved.'
          : `Set ${missing.join(', ')} before you preview.`}
      </p>
    </div>
  );
}

// Editable party and note field for one room, with Copy beside it for pasting into HMS by hand.
function RoomTextField({
  label,
  roomLabel,
  value,
  disabled,
  maxLength,
  multiline = false,
  pii = false,
  required = false,
  onChange,
}: {
  label: string;
  roomLabel: string;
  value: string;
  disabled: boolean;
  maxLength?: number;
  multiline?: boolean;
  pii?: boolean;
  required?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-end gap-2" data-pii={pii || undefined}>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-[#475569]">
        {label}
        {required ? <span className="font-normal text-[#64748b]"> (required)</span> : null}
        {multiline ? (
          <textarea
            rows={3}
            aria-label={label}
            aria-required={required || undefined}
            required={required}
            disabled={disabled}
            maxLength={maxLength}
            value={value}
            className={textareaClass}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <input
            type="text"
            aria-label={label}
            aria-required={required || undefined}
            required={required}
            disabled={disabled}
            maxLength={maxLength}
            value={value}
            className={paneFieldClass}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </label>
      <CopyButton label={label} roomLabel={roomLabel} value={value} />
    </div>
  );
}

type RoomChoice = {
  track: string;
  sourceOfBusiness: string;
  marketSegment: string;
  guestoptin4: boolean;
  guaranteeType: string;
  firstName: string;
  lastName: string;
  bookingAgency: string;
  organization: string;
  reservationNote: string;
};

const NO_CHOICE: RoomChoice = {
  track: '',
  sourceOfBusiness: '',
  marketSegment: '',
  guestoptin4: false,
  guaranteeType: '',
  firstName: '',
  lastName: '',
  bookingAgency: '',
  organization: '',
  reservationNote: '',
};

function roomGroupFor(
  room: BookingDraftReady['draft']['rooms'][number],
  groups: StayGroupRequirement[],
): StayGroupRequirement | undefined {
  return (
    groups.find((item) => item.id === room.groupId) ??
    groups.find((item) => `${item.arrivalDate ?? ''}:${item.departureDate ?? ''}` === room.groupId)
  );
}

function roomTypeFor(room: BookingDraftReady['draft']['rooms'][number], group?: StayGroupRequirement): string {
  const pickedRoomCode =
    group?.fields.roomCodes === 'staff_corrected' && group.roomCodes?.length === 1
      ? group.roomCodes[0]
      : group?.fields.roomPreference === 'staff_corrected'
        ? group.roomTypeCode ?? group.roomPreference
        : undefined;
  return textValue(pickedRoomCode) ||
    textValue(room.request.roomType) ||
    textValue(group?.roomTypeCode) ||
    textValue(group?.roomPreference);
}

function roomRequestFor(
  room: BookingDraftReady['draft']['rooms'][number],
  group?: StayGroupRequirement,
): Record<string, unknown> {
  if (!group) return room.request;
  return {
    ...room.request,
    arrival: group.arrivalDate ?? room.request.arrival,
    departure: group.departureDate ?? room.request.departure,
    adults: group.adults ?? room.request.adults,
    childAges: group.childrenAges,
  };
}

function roomChoiceFor(
  room: BookingDraftReady['draft']['rooms'][number],
  group: StayGroupRequirement | undefined,
  choice: RoomChoice,
  contact: StoredContact | null,
  confirmationRecipient: ConfirmationRecipientPayload | null,
): PaneStayChoice {
  return {
    ...choice,
    roomType: roomTypeFor(room, group),
    ratePlan: textValue(group?.rateCode) || textValue(room.request.ratePlan) || textValue(group?.quotedRateCode),
    bookerName: contact ? textValue(contact.name) : textValue(room.request.bookerName),
    bookerEmail: contact ? textValue(contact.email) : textValue(room.request.bookerEmail),
    ...(confirmationRecipient ? { confirmationRecipient } : {}),
  };
}

function childCountForRoom(
  room: BookingDraftReady['draft']['rooms'][number],
  groups: StayGroupRequirement[],
): number {
  const group = roomGroupFor(room, groups);
  const childAges = group ? group.childrenAges : room.request.childAges;
  return Array.isArray(childAges) ? childAges.length : 0;
}

function paneStayInputForConfiguredRoom(
  request: Record<string, unknown>,
  choice: PaneStayChoice,
  requiredCreateFields: string[],
): ReturnType<typeof paneStayInputForRoom> {
  const built = paneStayInputForRoom(request, choice);
  const requiredFields = requiredCreateFields
    .map((field) => field.trim().toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  const missing = [...built.missing];
  if (requiredFields.includes('reservationnote') && !textValue(choice.reservationNote).trim()) {
    missing.push('reservation note');
  }
  if (requiredFields.some((field) => field !== 'reservationnote')) {
    missing.push('required hotel field');
  }
  return { stay: missing.length ? null : built.stay, missing };
}

export function BookingCards({
  draft,
  groups = [],
  paneSave = null,
  parties,
  contact = null,
  workItemId,
  savedStays,
  guestName,
  guestEditorKey,
  session,
  propertyCode,
  confirmation,
}: {
  draft: BookingDraftReady;
  groups?: StayGroupRequirement[];
  /** Set only when create mode is lab or on (paneSave alias). Without it the card stays copy-only. */
  paneSave?: PaneStayClient | null;
  /** The stored read's contact. Its name and company fill the HMS notes where the room card has none. */
  contact?: StoredContact | null;
  /** The company and agency picked for this quote. They fill only the fields the draft leaves empty. */
  parties?: StaffQuoteParties;
  /** Work item this mail opened. Sent with Book so the confirmation is stored on that stay. */
  workItemId?: string;
  /** Last HMS commit per stay, read back on mount so a reload still shows the confirmation. */
  savedStays?: Record<string, SavedStayCommit>;
  /** Selected staying Guest from People. Prefills first/last; never the Contact/booker. */
  guestName?: string;
  /** People-step cache key so a Guest edit updates Book first/last while both stay mounted. */
  guestEditorKey?: string;
  /** Current quote session. Used to build the generated Reservation note; omitted leaves the field manual. */
  session?: QuoteSession;
  /** Active mailbox property. Unknown or missing codes fail closed (no generated note). */
  propertyCode?: string | null;
  /**
   * Signed-in user and saved confirmation default. Null keeps the card as it was before this control
   * (unit tests that render the card alone). The live pane always passes it.
   */
  confirmation?: ConfirmationSources | null;
}) {
  const client = paneSave;
  const contactRef = useRef(contact);
  contactRef.current = contact;
  const requiredCreateFields = draft.options.requiredCreateFields ?? [];
  // off keeps the card copy-only. A client whose mode is not read yet is labelled as lab, the narrower mode.
  const mode: PaneSaveMode = client ? (client.mode?.() ?? 'lab') : 'off';
  const savesOn = mode !== 'off';
  const selectedGuestName = useSyncExternalStore(
    subscribeStayingGuestName,
    () => readSelectedGuestName(guestEditorKey, guestName),
    () => readSelectedGuestName(guestEditorKey, guestName),
  );
  const guestSplit = splitStayingGuestName(selectedGuestName);
  const previousSelectedGuestName = useRef(selectedGuestName);
  const guestNamesEdited = useRef<Record<string, boolean>>({});
  const reservationNoteDirty = useRef<Record<string, boolean>>({});
  const [choices, setChoices] = useState<Record<string, RoomChoice>>(
    () =>
      Object.fromEntries(
        draft.draft.rooms.map((room) => {
          const key = `${room.groupId}:${room.roomIndex}`;
          const names = namesFromSelectedGuest(
            readSelectedGuestName(guestEditorKey, guestName),
            room.request,
          );
          const generated = session ? reservationNoteForGroup(session, propertyCode, room.groupId) : null;
          return [
            key,
            {
              track: textValue(room.request.track),
              sourceOfBusiness: initialSourceOfBusiness(
                room.request.sourceOfBusiness,
                draft.options.sourceOfBusiness,
              ),
              marketSegment: '',
              // Guest consent must come from an explicit staff action, never from mail or a hotel default.
              guestoptin4: false,
              guaranteeType: textValue(room.request.guaranteeType),
              firstName: names.firstName,
              lastName: names.lastName,
              bookingAgency: textValue(room.request.agency) || pickedName(parties?.agency),
              organization: textValue(room.request.organization) || pickedName(parties?.company),
              reservationNote: prefillReservationNote(
                textValue(room.request.reservationNote),
                generated,
                false,
              ),
            },
          ];
        }),
      ),
  );

  const [saves, setSaves] = useState<Record<string, RoomSaveState>>(() =>
    savesFromSavedStays(draft, groups, savedStays),
  );
  const previewReceipt = usePaneStayPreview();
  const previewInputsRef = useRef<Record<string, PreviewInput>>({});
  const [stayBooking, setStayBooking] = useState(false);
  const stayBookingRef = useRef(false);
  const contextConfirmation = useConfirmationSources();
  const sources = confirmation === undefined ? contextConfirmation : confirmation;
  const [recipientMode, setRecipientMode] = useState<ConfirmationMode>(sources?.setting?.mode ?? 'self');
  const [customAddress, setCustomAddress] = useState(
    sources?.setting?.mode === 'custom' ? (sources.setting.address ?? '') : '',
  );
  const recipientDirty = useRef(false);
  useEffect(() => {
    if (recipientDirty.current || !sources?.setting) return;
    setRecipientMode(sources.setting.mode);
    if (sources.setting.mode === 'custom') setCustomAddress(sources.setting.address ?? '');
  }, [sources]);
  const clientEmail = contact ? textValue(contact.email) : '';
  const resolvedRecipient = sources
    ? resolveConfirmationRecipient({
        mode: recipientMode,
        customAddress,
        userEmail: sources.userEmail,
        clientEmail,
        invalidSetting: sources.invalidSetting,
      })
    : null;
  useEffect(() => () => {
    stayBookingRef.current = false;
  }, []);
  useEffect(() => {
    const selectedGuestChanged = previousSelectedGuestName.current !== selectedGuestName;
    previousSelectedGuestName.current = selectedGuestName;
    setChoices((current) => {
      let changed = false;
      const next = { ...current };
      for (const room of draft.draft.rooms) {
        const key = `${room.groupId}:${room.roomIndex}`;
        const choice = current[key];
        if (!choice) continue;
        let nextChoice = choice;
        if (selectedGuestChanged && choice.guestoptin4) {
          nextChoice = { ...choice, guestoptin4: false };
          next[key] = nextChoice;
          changed = true;
        }
        const commitStatus = saves[key]?.commit?.status;
        if (stayBooking || commitStatus === 'running' || commitStatus === 'booked') continue;
        if (guestNamesEdited.current[key]) continue;
        const names = guestSplit.ambiguous
          ? {
              firstName: textValue(room.request.firstName),
              lastName: textValue(room.request.lastName),
            }
          : { firstName: guestSplit.firstName, lastName: guestSplit.lastName };
        if (
          nextChoice.firstName === names.firstName &&
          nextChoice.lastName === names.lastName &&
          !selectedGuestChanged
        ) continue;
        next[key] = {
          ...nextChoice,
          firstName: names.firstName,
          lastName: names.lastName,
          // Consent is guest-specific; a People change needs a fresh explicit opt-in.
          guestoptin4: false,
        };
        changed = true;
      }
      return changed ? next : current;
    });
  }, [
    draft.draft.rooms,
    guestSplit.ambiguous,
    guestSplit.firstName,
    guestSplit.lastName,
    saves,
    selectedGuestName,
    stayBooking,
  ]);
  useEffect(() => {
    if (!session) return;
    setChoices((current) => {
      let changed = false;
      const next = { ...current };
      for (const room of draft.draft.rooms) {
        const key = `${room.groupId}:${room.roomIndex}`;
        const choice = current[key];
        if (!choice) continue;
        const generated = reservationNoteForGroup(session, propertyCode, room.groupId);
        const bound = prefillReservationNote(
          choice.reservationNote,
          generated,
          reservationNoteDirty.current[key] === true,
        );
        if (bound === choice.reservationNote) continue;
        next[key] = { ...choice, reservationNote: bound };
        changed = true;
      }
      return changed ? next : current;
    });
  }, [draft.draft.rooms, propertyCode, session]);
  // The price check compared the quoted room. Once staff pick another room type, it no longer describes the booking.
  const roomTypeChanged = draft.draft.rooms.some((room) => {
    const requested = textValue(room.request.roomType);
    const selected = roomTypeFor(room, roomGroupFor(room, groups));
    return Boolean(requested && selected && requested !== selected);
  });

  function patchSave(roomKey: string, patch: RoomSaveState) {
    setSaves((current) => ({ ...current, [roomKey]: { ...current[roomKey], ...patch } }));
  }

  function finishPreviewIfRunning(
    roomKey: string,
    requestId: symbol,
    preview: Exclude<PreviewView, { status: 'running' }>,
  ) {
    setSaves((current) => {
      const save = current[roomKey];
      const active = save?.preview;
      if (!save || active?.status !== 'running' || active.requestId !== requestId) return current;
      return { ...current, [roomKey]: { ...save, preview } };
    });
  }

  async function previewRoom(roomKey: string, pane: PaneStayClient, stay: PaneStayInput) {
    const inputKey = paneStayKey(stay);
    const input = previewInputsRef.current[roomKey];
    if (!input?.key || input.inputKey !== inputKey) return;
    const { stayId } = input;
    const key = input.key;
    const requestId = Symbol();
    const generation = previewReceipt.begin(workItemId, stayId, inputKey);
    patchSave(roomKey, { preview: { status: 'running', key, requestId }, commit: undefined });
    let preview: Exclude<PreviewView, { status: 'running' }>;
    try {
      const previewInput = workItemId ? { ...stay, stayId, workItemId } : stay;
      const outcome = previewOutcome(await pane.preview(previewInput));
      preview = outcome.ok
        ? { status: 'ready', key, digest: outcome.digest, runId: outcome.runId, screenshots: outcome.screenshots }
        : { status: 'refused', key, message: outcome.message };
    } catch {
      preview = { status: 'refused', key, message: PANE_PREVIEW_FAILED_COPY };
    }
    const currentInput = previewInputsRef.current[roomKey];
    const isCurrentInput = currentInput?.key === key;
    const receipt =
      isCurrentInput && preview.status === 'ready'
        ? {
            key: inputKey,
            digest: preview.digest,
            runId: preview.runId,
            screenshots: preview.screenshots,
          }
        : undefined;
    const accepted = previewReceipt.finish(workItemId, stayId, inputKey, generation, receipt);
    if (!isCurrentInput) {
      finishPreviewIfRunning(roomKey, requestId, { status: 'stale', key });
      return;
    }
    if (!accepted) {
      finishPreviewIfRunning(roomKey, requestId, { status: 'stale', key });
      return;
    }
    finishPreviewIfRunning(roomKey, requestId, preview);
  }

  function roomKeyOf(room: BookingDraftReady['draft']['rooms'][number]): string {
    return `${room.groupId}:${room.roomIndex}`;
  }

  function bookableRooms() {
    return draft.draft.rooms.filter((room) => childCountForRoom(room, groups) === 0);
  }

  function roomBuilt(
    room: BookingDraftReady['draft']['rooms'][number],
    currentContact: StoredContact | null = contact,
  ) {
    const group = roomGroupFor(room, groups);
    const built = paneStayInputForConfiguredRoom(
      roomRequestFor(room, group),
      roomChoiceFor(
        room,
        group,
        choices[roomKeyOf(room)] ?? NO_CHOICE,
        currentContact,
        resolvedRecipient?.ok ? resolvedRecipient.recipient : null,
      ),
      requiredCreateFields,
    );
    if (resolvedRecipient && !resolvedRecipient.ok) {
      return { stay: null, missing: [...built.missing, 'confirmation recipient'] };
    }
    return built;
  }

  function previewKeyForRoom(
    room: BookingDraftReady['draft']['rooms'][number],
    stay: PaneStayInput | null,
  ): string | null {
    return stay
      ? paneStayPreviewKey(workItemId, stayIdForRoom(room, groups), paneStayKey(stay))
      : null;
  }

  const previewInputs = Object.fromEntries(
    draft.draft.rooms.map((room) => {
      const stayId = stayIdForRoom(room, groups);
      const built = roomBuilt(room);
      const inputKey = built.stay ? paneStayKey(built.stay) : null;
      return [
        roomKeyOf(room),
        {
          key: inputKey ? paneStayPreviewKey(workItemId, stayId, inputKey) : null,
          inputKey,
          stayId,
        },
      ];
    }),
  );
  previewInputsRef.current = previewInputs;
  const previewInputSignature = JSON.stringify(
    Object.entries(previewInputs).map(([roomKey, input]) => [roomKey, input.key, input.stayId]),
  );

  useEffect(() => {
    const inputs = Object.entries(previewInputsRef.current);
    const restored: Record<string, PreviewView> = {};
    for (const [roomKey, input] of inputs) {
      if (!input.key || !input.inputKey) {
        previewReceipt.clear(workItemId, input.stayId);
        continue;
      }
      const cached = previewReceipt.restore(workItemId, input.stayId, input.inputKey);
      if (cached) restored[roomKey] = { ...cached, status: 'ready', key: input.key };
    }
    setSaves((current) => {
      let next = current;
      for (const [roomKey, input] of inputs) {
        const existing = current[roomKey]?.preview;
        const cached = restored[roomKey];
        const preview = cached ?? (
          existing && existing.status !== 'stale' && existing.status !== 'running' && existing.key !== input.key
            ? { status: 'stale' as const, key: existing.key }
            : existing
        );
        if (preview !== existing) next = { ...next, [roomKey]: { ...next[roomKey], preview } };
      }
      return next;
    });
  }, [previewInputSignature, previewReceipt, workItemId]);

  function roomPreviewReady(room: BookingDraftReady['draft']['rooms'][number]): { stay: PaneStayInput; digest: string } | null {
    const built = roomBuilt(room);
    if (!built.stay) return null;
    const preview = saves[roomKeyOf(room)]?.preview;
    const key = paneStayPreviewKey(workItemId, stayIdForRoom(room, groups), paneStayKey(built.stay));
    return preview?.status === 'ready' && preview.key === key
      ? { stay: built.stay, digest: preview.digest }
      : null;
  }

  async function bookThisStay(pane: PaneStayClient) {
    const snapshot = bookableRooms()
      .filter((room) => saves[roomKeyOf(room)]?.commit?.status !== 'booked')
      .map((room) => {
        const ready = roomPreviewReady(room);
        return ready ? { roomKey: roomKeyOf(room), stay: ready.stay, digest: ready.digest } : null;
      });
    if (snapshot.some((item) => item == null)) return;
    stayBookingRef.current = true;
    setStayBooking(true);
    try {
      for (const item of snapshot) {
        if (!item || !stayBookingRef.current) return;
        const room = draft.draft.rooms.find((candidate) => roomKeyOf(candidate) === item.roomKey);
        if (!room) return;
        const currentStay = roomBuilt(room, contactRef.current).stay;
        if (!currentStay || paneStayKey(currentStay) !== paneStayKey(item.stay)) return;
        await bookRoom(item.roomKey, pane, item.stay, item.digest);
      }
    } finally {
      stayBookingRef.current = false;
      setStayBooking(false);
    }
  }

  async function bookRoom(roomKey: string, pane: PaneStayClient, stay: PaneStayInput, previewDigest: string) {
    const key = paneStayKey(stay);
    const room = draft.draft.rooms.find((item) => `${item.groupId}:${item.roomIndex}` === roomKey);
    if (room) previewReceipt.clear(workItemId, stayIdForRoom(room, groups));
    patchSave(roomKey, { commit: { status: 'running', key } });
    let commit: CommitView;
    try {
      const persist =
        workItemId && room
          ? { stayId: stayIdForRoom(room, groups), workItemId }
          : {};
      const outcome = commitOutcome(
        await pane.commit({ ...stay, ...persist } as PaneStayInput, previewDigest),
        stay,
      );
      commit = outcome.ok
        ? {
            status: 'booked',
            key,
            confirmationNumber: outcome.confirmationNumber,
            runId: outcome.runId,
            screenshots: outcome.screenshots,
            ...(outcome.unverified ? { unverified: true } : {}),
          }
        : {
            status: 'refused',
            key,
            message: outcome.message,
            runId: outcome.runId,
            screenshots: outcome.screenshots,
          };
    } catch {
      commit = { status: 'refused', key, message: PANE_COMMIT_UNREACHABLE_COPY };
    }
    // A refused save invalidates the preview, so Book stays locked until the staff preview again.
    patchSave(roomKey, commit.status === 'booked' ? { commit } : { commit, preview: undefined });
  }

  return (
    <section aria-label="Booking details" className="flex flex-col gap-2">
      <p className="text-[11px] text-[#64748b]">
        {savesOn
          ? 'Preview each room using the Stay details above, then create it in HMS.'
          : 'Saving to HMS from this pane is off for now. Stay details are above; enter the booking-only fields in HMS Guest Stay.'}
      </p>
      {sources ? (
        <ConfirmationRecipient
          mode={recipientMode}
          customAddress={customAddress}
          userEmail={sources.userEmail}
          clientEmail={clientEmail}
          disabled={stayBooking}
          error={resolvedRecipient && !resolvedRecipient.ok ? resolvedRecipient.message : null}
          onMode={(next) => {
            recipientDirty.current = true;
            setRecipientMode(next);
          }}
          onCustomAddress={(value) => {
            recipientDirty.current = true;
            setCustomAddress(value);
          }}
        />
      ) : null}
      {mode === 'lab' ? (
        <p role="note" className="text-[11.5px] text-amber-900">
          {LAB_WRITE_NOTE}
        </p>
      ) : null}
      {roomTypeChanged && draft.draft.rateCheck.length > 0 ? (
        <Notice tone="warn">{ROOM_TYPE_CHANGED_COPY}</Notice>
      ) : (
        draft.draft.rateCheck.map((check, index) => (
          <RateCheckChip key={`${check.status}:${check.claimQuote}:${index}`} check={check} />
        ))
      )}
      {draft.draft.flags.length > 0 ? (
        <Notice tone="warn">
          <ul className="flex list-disc flex-col gap-0.5 pl-4">
            {draft.draft.flags.map((flag) => (
              <li key={flag}>{BOOKING_FLAG_COPY[flag] ?? 'Check this booking detail in HMS before booking.'}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {draft.draft.missing.map((item) => (
        <p key={`${item.field}:${item.question}`} className="text-[11px] text-[#64748b]">
          {missingFactLabel(item.question)}
        </p>
      ))}
      {draft.draft.rooms.map((room) => {
        const key = roomKeyOf(room);
        const choice = choices[key] ?? NO_CHOICE;
        const setChoice = (patch: Partial<RoomChoice>) =>
          setChoices((current) => {
            const currentChoice = current[key] ?? NO_CHOICE;
            const guestChanged =
              (patch.firstName !== undefined && patch.firstName !== currentChoice.firstName) ||
              (patch.lastName !== undefined && patch.lastName !== currentChoice.lastName);
            return {
              ...current,
              [key]: {
                ...currentChoice,
                ...patch,
                ...(guestChanged ? { guestoptin4: false } : {}),
              },
            };
          });
        // Once create is running or saved, freeze its create-only fields until staff checks the result.
        const commitStatus = saves[key]?.commit?.status;
        const locked = stayBooking || commitStatus === 'running' || commitStatus === 'booked';
        const request = room.request;
        const group = roomGroupFor(room, groups);
        const generatedNote = session ? reservationNoteForGroup(session, propertyCode, room.groupId) : null;
        const built = roomBuilt(room);
        const price = group?.rowPrice;
        const override = price?.source === 'override' ? price : null;
        const commit = saves[key]?.commit;
        const bookedCommit = commit?.status === 'booked' ? commit : null;
        const childCount = childCountForRoom(room, groups);
        const roomCount = group?.quantity ?? Math.max(
          1,
          draft.draft.rooms.filter((candidate) => candidate.groupId === room.groupId).length,
        );
        const roomLabel = rowRoomLabel({
          roomPreference: roomTypeFor(room, group) || textValue(request.roomType),
          quantity: roomCount,
        });
        return (
          <article
            key={key}
            className="shadow-xs flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3"
          >
            <RoomTextField
              roomLabel={roomLabel}
              label="Last name"
              value={choice.lastName}
              disabled={locked}
              maxLength={PANE_BOOKER_NAME_MAX}
              pii
              onChange={(value) => {
                guestNamesEdited.current[key] = true;
                setChoice({ lastName: value });
              }}
            />
            <RoomTextField
              roomLabel={roomLabel}
              label="First name"
              value={choice.firstName}
              disabled={locked}
              maxLength={PANE_BOOKER_NAME_MAX}
              pii
              onChange={(value) => {
                guestNamesEdited.current[key] = true;
                setChoice({ firstName: value });
              }}
            />
            {selectedGuestName.trim() && guestSplit.ambiguous ? (
              <p role="status" className="text-[11px] text-[#64748b]">
                {AMBIGUOUS_GUEST_NAME_COPY}
              </p>
            ) : null}
            <RoomTextField
              roomLabel={roomLabel}
              label="Booking agency"
              value={choice.bookingAgency}
              disabled={locked}
              maxLength={PANE_PARTY_NAME_MAX}
              onChange={(value) => setChoice({ bookingAgency: value })}
            />
            <RoomTextField
              roomLabel={roomLabel}
              label="Organization"
              value={choice.organization}
              disabled={locked}
              maxLength={PANE_PARTY_NAME_MAX}
              onChange={(value) => setChoice({ organization: value })}
            />
            <div className="flex items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-[#475569]">
                Source of business
                <select
                  disabled={locked}
                  aria-label="Source of business"
                  className={paneFieldClass}
                  value={choice.sourceOfBusiness}
                  onChange={(event) => setChoice({ sourceOfBusiness: event.target.value })}
                >
                  <option value="">Select source</option>
                  {draft.options.sourceOfBusiness.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <CopyButton label="Source of business" roomLabel={roomLabel} value={choice.sourceOfBusiness} />
            </div>
            <div className="flex items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-[#475569]">
                Track
                <select
                  disabled={locked}
                  aria-label="Track"
                  className={paneFieldClass}
                  value={choice.track}
                  onChange={(event) => setChoice({ track: event.target.value })}
                >
                  <option value="">Select track</option>
                  {draft.options.track.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <CopyButton label="Track" roomLabel={roomLabel} value={choice.track} />
            </div>
            <RoomTextField
              roomLabel={roomLabel}
              label="Market Segment"
              value={choice.marketSegment}
              disabled={locked}
              onChange={(value) => setChoice({ marketSegment: value })}
            />
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-xs font-semibold text-[#475569]">
                <input
                  type="checkbox"
                  aria-label="Guest opt-in"
                  checked={choice.guestoptin4}
                  disabled={locked}
                  onChange={(event) => setChoice({ guestoptin4: event.target.checked })}
                />
                <span>Guest opt-in</span>
              </label>
              <p className="text-[11px] text-[#64748b]">Select only if the guest explicitly opted in.</p>
            </div>
            <div className="flex items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-[#475569]">
                Guarantee
                <select
                  disabled={locked}
                  aria-label="Guarantee"
                  className={paneFieldClass}
                  value={choice.guaranteeType}
                  onChange={(event) => setChoice({ guaranteeType: event.target.value })}
                >
                  <option value="">Select guarantee</option>
                  {draft.options.guaranteeType.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <CopyButton label="Guarantee" roomLabel={roomLabel} value={choice.guaranteeType} />
            </div>
            <RoomTextField
              multiline
              roomLabel={roomLabel}
              label="Reservation note"
              value={choice.reservationNote}
              disabled={locked}
              maxLength={PANE_RESERVATION_NOTE_MAX}
              required={requiredCreateFields.some(
                (field) => field.trim().toLowerCase().replace(/[^a-z0-9]/g, '') === 'reservationnote',
              )}
              onChange={(value) => {
                reservationNoteDirty.current[key] = true;
                setChoice({ reservationNote: value });
              }}
            />
            {generatedNote && generatedNote !== choice.reservationNote ? (
              <SecondaryButton
                disabled={locked}
                onClick={() => {
                  reservationNoteDirty.current[key] = false;
                  setChoice({ reservationNote: generatedNote });
                }}
              >
                Regenerate reservation note
              </SecondaryButton>
            ) : null}
            <CopyHmsNotesButton
              block={hmsNotesBlock({
                booker: contact ? textValue(contact.name) : textValue(request.bookerName),
                company: choice.organization || contact?.company,
                confirmations: bookedCommit ? [bookedCommit.confirmationNumber] : [],
                rooms: [
                  {
                    label: roomLabel,
                    specialRequests: group?.specialRequests,
                    authorisedBy: override?.note,
                    rate: {
                      code:
                        override?.rateCode ??
                        (textValue(group?.rateCode) ||
                          textValue(group?.quotedRateCode) ||
                          textValue(request.ratePlan)),
                      nightlyMinor:
                        price ? [price.amountMinor] : group?.quotedAmountMinor != null ? [group.quotedAmountMinor] : undefined,
                      board: room.board ? BOARD_LABELS[room.board] : undefined,
                    },
                  },
                ],
              })}
            />
            {childCount > 0 ? (
              <p role="note" className="text-[11.5px] text-amber-900">
                {PANE_CHILDREN_COPY}
              </p>
            ) : null}
            {childCount === 0 && client && savesOn ? (
              <RoomSave
                stay={built.stay}
                previewKey={previewKeyForRoom(room, built.stay)}
                missing={built.missing}
                save={saves[key] ?? {}}
                screenshot={client.screenshot}
                bookLabel={CREATE_PROVISIONAL_LABEL}
                frozen={stayBooking}
                onPreview={(stay) => void previewRoom(key, client, stay)}
                onBook={(stay, previewDigest) => void bookRoom(key, client, stay, previewDigest)}
              />
            ) : childCount === 0 ? (
              <div className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
                <PrimaryButton disabled>{WRITES_OFF_LABEL}</PrimaryButton>
              </div>
            ) : null}
          </article>
        );
      })}
      {client && savesOn ? (
        <StayBookBar
          rooms={draft.draft.rooms}
          saves={saves}
          isPreviewReady={(room) => roomPreviewReady(room) !== null}
          childCountForRoom={(room) => childCountForRoom(room, groups)}
          pane={client}
          stayBooking={stayBooking}
          onBookStay={bookThisStay}
        />
      ) : null}
    </section>
  );
}

function StayBookBar({
  rooms,
  saves,
  isPreviewReady,
  childCountForRoom,
  pane,
  stayBooking,
  onBookStay,
}: {
  rooms: BookingDraftReady['draft']['rooms'];
  saves: Record<string, RoomSaveState>;
  isPreviewReady: (room: BookingDraftReady['draft']['rooms'][number]) => boolean;
  childCountForRoom: (room: BookingDraftReady['draft']['rooms'][number]) => number;
  pane: PaneStayClient;
  stayBooking: boolean;
  onBookStay: (pane: PaneStayClient) => Promise<void>;
}) {
  const bookable = rooms.filter((room) => childCountForRoom(room) === 0);
  if (!bookable.length) return null;
  const numbers = bookable.flatMap((room) => {
    const commit = saves[`${room.groupId}:${room.roomIndex}`]?.commit;
    return commit?.status === 'booked' && commit.confirmationNumber ? [commit.confirmationNumber] : [];
  });
  const pending = bookable.filter((room) => saves[`${room.groupId}:${room.roomIndex}`]?.commit?.status !== 'booked');
  const busy =
    stayBooking ||
    bookable.some((room) => {
      const save = saves[`${room.groupId}:${room.roomIndex}`];
      return save?.preview?.status === 'running' || save?.commit?.status === 'running';
    });
  const allPreviewed = pending.every(isPreviewReady);
  return (
    <div className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
      {numbers.length > 0 ? (
        <p data-pii className="text-[12.5px] font-semibold text-emerald-800">
          {numbers.length === bookable.length
            ? `Booked this stay – ${numbers.join(', ')}`
            : `Booked ${numbers.length} of ${bookable.length} – ${numbers.join(', ')}`}
        </p>
      ) : null}
      {pending.length > 0 ? (
        <PrimaryButton
          disabled={!allPreviewed || busy}
          disabledReason={!allPreviewed && !busy ? 'Preview in HMS first' : null}
          onClick={() => void onBookStay(pane)}
        >
          {BOOK_THIS_STAY_LABEL}
        </PrimaryButton>
      ) : null}
    </div>
  );
}
