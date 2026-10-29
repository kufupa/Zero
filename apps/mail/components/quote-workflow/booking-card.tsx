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
import { HmsShotsViewer, visibleStayShots, type HmsShotRecord } from './hms-shots-viewer';
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
  PANE_CMS_MISMATCH_COPY,
  PANE_COMMIT_UNREACHABLE_COPY,
  PANE_PARTY_NAME_MAX,
  PANE_PREVIEW_FAILED_COPY,
  PANE_RESERVATION_NOTE_MAX,
  PANE_SAVE_UNCONFIRMED_REASON,
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
  confirmationScopeKey,
  ConfirmationRecipient,
  resolveConfirmationRecipient,
  useConfirmationSources,
  type ConfirmationMode,
  type ConfirmationRecipientPayload,
  type ConfirmationSetting,
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
const PRICE_INPUT_CHANGED_COPY =
  'Booking details changed from the quote, so the price check no longer applies. Quote again to check the price.';

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
const CHILD_AGE_FIELDS = Array.from({ length: 16 }, (_, index) => `child-age-${index + 1}`);
const CMS_FALLBACK = [
  { code: '01', label: 'Guest booking – payment link' },
  { code: '03', label: 'Agency/company booking – payment link + proforma' },
  { code: '08', label: 'Agency booking – no rate' },
];
type BookingOptions = BookingDraftReady['options'] & {
  cmsMessageIds?: Array<{ code: string; label: string }>;
  cmsDefaults?: { agency: string; guest: string };
  ratePlans?: string[];
};
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
      shots?: HmsShotRecord[];
      unverified?: boolean;
      cmsMismatch?: boolean;
    }
  | {
      status: 'refused';
      key: string;
      message: string;
      runId?: string;
      screenshots?: string[];
      shots?: HmsShotRecord[];
      statusChip?: 'check';
      clearedClaim?: { snapshot?: SavedStayCommit };
    };

type RoomSaveState = { preview?: PreviewView; commit?: CommitView };

function isUncertainCommit(commit: CommitView | undefined): boolean {
  return (commit?.status === 'booked' && commit.unverified === true) ||
    (commit?.status === 'refused' && commit.statusChip === 'check');
}

function recentCanReplaceUnknown(stored: CommitView | undefined, recent: CommitView | undefined, saved?: SavedStayCommit): boolean {
  if (!isUncertainCommit(stored)) return false;
  if (recent?.status === 'refused') return Boolean(recent.clearedClaim && stored?.status === 'refused' &&
    (!saved || saved === recent.clearedClaim.snapshot));
  return Boolean(
    recent?.status === 'booked' && recent.confirmationNumber &&
    (stored?.status !== 'booked' || !stored.confirmationNumber || stored.confirmationNumber === recent.confirmationNumber),
  );
}

export type SavedStayCommit = {
  confirmationNumber: string | null;
  status: 'booked' | 'unknown';
  screenshotRef: { runId: string; name: string } | null;
  /** Durable before/saved shots from the work-item stay record. */
  runId?: string;
  shots?: HmsShotRecord[];
  cmsReason?: string;
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

/** Only apply a stored save when exactly one visible room claims its id. */
export function appliedSavedStayIds(
  draft: BookingDraftReady,
  groups: StayGroupRequirement[],
  savedStays: Record<string, SavedStayCommit> | undefined,
): string[] {
  if (!savedStays) return [];
  const claims = new Map<string, number>();
  for (const room of draft.draft.rooms) {
    const id = stayIdForRoom(room, groups);
    claims.set(id, (claims.get(id) ?? 0) + 1);
  }
  return [...claims.entries()].filter(([id, count]) => count === 1 && savedStays[id]).map(([id]) => id);
}

function paneStayPreviewKey(workItemId: string | undefined, stayId: string, inputKey: string): string {
  return JSON.stringify([workItemId?.trim() || null, stayId.trim(), inputKey]);
}

function commitViewFromSaved(
  saved: SavedStayCommit,
  stay: { firstName?: string; lastName?: string; arrival?: string; departure?: string },
): CommitView {
  const runId = saved.runId ?? saved.screenshotRef?.runId;
  const screenshots = saved.screenshotRef ? [saved.screenshotRef.name] : [];
  const shots = visibleStayShots(saved.shots ?? []);
  const shotFields = shots.length > 0 ? { shots } : {};
  if (saved.confirmationNumber) {
    return {
      status: 'booked',
      key: '',
      confirmationNumber: saved.confirmationNumber,
      runId,
      screenshots,
      ...shotFields,
      ...(saved.status === 'unknown' ? { unverified: true } : {}),
      ...(saved.cmsReason === 'saved_cms_mismatch' ? { cmsMismatch: true } : {}),
    };
  }
  return {
    status: 'refused',
    key: '',
    message: saved.cmsReason === 'saved_cms_mismatch' ? PANE_CMS_MISMATCH_COPY : paneUnconfirmedMessage({
      firstName: textValue(stay.firstName) || 'this guest',
      lastName: textValue(stay.lastName),
      arrival: textValue(stay.arrival),
      departure: textValue(stay.departure),
    }),
    runId,
    screenshots,
    ...shotFields,
    statusChip: 'check',
  };
}

function savesFromSavedStays(
  draft: BookingDraftReady,
  groups: StayGroupRequirement[],
  savedStays: Record<string, SavedStayCommit> | undefined,
): Record<string, RoomSaveState> {
  if (!savedStays) return {};
  const shown = new Set(appliedSavedStayIds(draft, groups, savedStays));
  const saves: Record<string, RoomSaveState> = {};
  for (const room of draft.draft.rooms) {
    const id = stayIdForRoom(room, groups);
    if (!shown.has(id)) continue;
    const saved = savedStays[id];
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
  bookBlocked = false,
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
  bookBlocked?: boolean;
  onPreview: (stay: PaneStayInput) => void;
  onBook: (stay: PaneStayInput, previewDigest: string) => void;
}) {
  const { preview, commit } = save;
  const noRetry = commit?.status === 'refused' && commit.statusChip === 'check';
  const busy = frozen || preview?.status === 'running' || commit?.status === 'running';
  const fresh = stay && preview?.status === 'ready' && preview.key === previewKey ? preview : null;
  const changed =
    preview?.status === 'stale' ||
    ((preview?.status === 'running' || preview?.status === 'ready') && preview.key !== previewKey);

  if (commit?.status === 'booked') {
    const savedShot = commit.screenshots.includes(SAVED_SHOT) ? SAVED_SHOT : null;
    const durableShots = commit.shots ?? [];
    return (
      <div className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
        <span
          className={
            commit.unverified
              ? 'w-fit rounded-xs bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-950'
              : 'w-fit rounded-xs bg-emerald-100 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-900'
          }
        >
          {commit.unverified ? 'Unconfirmed' : 'Booked'}
        </span>
        <p data-pii className="text-[12.5px] font-semibold text-emerald-800">
          {commit.cmsMismatch
            ? PANE_CMS_MISMATCH_COPY
            : commit.unverified
            ? PANE_SAVE_UNVERIFIED_COPY
            : `Booked in HMS – confirmation ${commit.confirmationNumber}`}
        </p>
        {commit.unverified && commit.confirmationNumber ? (
          <p data-pii className="text-[12px] text-amber-900">{`Possible confirmation: ${commit.confirmationNumber} (not verified)`}</p>
        ) : null}
        {commit.confirmationNumber ? (
          <HmsLinkActions
            confirmation={commit.confirmationNumber}
            guestSurname={stay?.lastName}
            arrival={stay?.arrival}
          />
        ) : null}
        {commit.runId && durableShots.length > 0 ? (
          <HmsShotsViewer key={commit.runId} runId={commit.runId} shots={durableShots} screenshot={screenshot} />
        ) : commit.runId && savedShot ? (
          <PaneScreenshot
            caption={commit.unverified ? 'View HMS screenshot' : 'See what Nava saved in HMS'}
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
          {commit.statusChip === 'check' ? (
            <span className="w-fit rounded-xs bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-950">
              Unconfirmed
            </span>
          ) : null}
          <p role="alert" className="text-[11.5px] text-amber-900">
            {commit.message}
          </p>
          {commit.runId && (commit.shots?.length ?? 0) > 0 ? (
            <HmsShotsViewer key={commit.runId} runId={commit.runId} shots={commit.shots ?? []} screenshot={screenshot} />
          ) : commit.runId && refusedShot ? (
            <PaneScreenshot
              caption="View HMS screenshot"
              runId={commit.runId}
              name={refusedShot}
              screenshot={screenshot}
            />
          ) : null}
        </>
      ) : null}
      {!noRetry && <div className="grid grid-cols-2 gap-2">
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
          disabled={!fresh || busy || bookBlocked}
          disabledReason={!stay || busy ? null : bookBlocked ? 'A booking is still unconfirmed' : 'Preview in HMS first'}
          onClick={() => {
            if (stay && fresh) onBook(stay, fresh.digest);
          }}
        >
          {bookLabel}
        </PrimaryButton>
      </div>}
      {!noRetry && <p className="text-[11px] text-[#64748b]">
        {stay
          ? 'Nava fills the booking in HMS and checks availability. Nothing is saved.'
          : `Set ${missing.join(', ')} before you preview.`}
      </p>}
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
  /** The exact note Nava generated, so staff-authored text is never discarded. */
  generatedReservationNote?: string;
  roomType?: string;
  ratePlan?: string;
  adults?: string;
  childAges?: string[];
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
  choice?: RoomChoice,
): Record<string, unknown> {
  return {
    ...room.request,
    arrival: group?.arrivalDate ?? room.request.arrival,
    departure: group?.departureDate ?? room.request.departure,
    adults: choice?.adults ?? group?.adults ?? room.request.adults,
    childAges: choice?.childAges
      ? choice.childAges.map((age) => age.trim() === '' ? Number.NaN : Number(age))
      : group?.childrenAges ?? room.request.childAges,
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
    roomType: choice.roomType ?? roomTypeFor(room, group),
    ratePlan: choice.ratePlan ?? (textValue(group?.rateCode) || textValue(group?.quotedRateCode) || textValue(room.request.ratePlan)),
    bookerName: contact ? textValue(contact.name) : textValue(room.request.bookerName),
    bookerEmail: contact ? textValue(contact.email) : textValue(room.request.bookerEmail),
    ...(confirmationRecipient ? { confirmationRecipient } : {}),
  };
}

/** Never reuse quote prices for a different room, rate or occupancy. */
function generatedNoteForChoice(
  session: QuoteSession | undefined,
  propertyCode: string | null | undefined,
  room: BookingDraftReady['draft']['rooms'][number],
  group: StayGroupRequirement | undefined,
  choice: RoomChoice,
): string | null {
  const quoted = session?.groups.find((item) => item.id === room.groupId);
  if (!session || !quoted || quoted.roomCodes?.length !== 1 || !quoted.rateCode) return null;
  const request = roomRequestFor(room, group, choice);
  const selectedRoom = choice.roomType ?? roomTypeFor(room, group);
  const selectedRate = choice.ratePlan ?? (textValue(group?.rateCode) || textValue(group?.quotedRateCode) || textValue(room.request.ratePlan));
  if (
    selectedRoom !== quoted.roomCodes[0] || selectedRate !== quoted.rateCode ||
    request.arrival !== quoted.arrivalDate || request.departure !== quoted.departureDate ||
    Number(request.adults) !== quoted.adults ||
    JSON.stringify(request.childAges ?? []) !== JSON.stringify(quoted.childrenAges ?? [])
  ) return null;
  return reservationNoteForGroup(session, propertyCode, room.groupId);
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
  for (const field of requiredFields) {
    if (field === 'reservationnote' && !textValue(choice.reservationNote).trim()) missing.push('reservation note');
    else if (field === 'marketsegment' && !textValue(choice.marketSegment).trim()) missing.push('Market segment');
    else if (field === 'guestoptin4' && choice.guestoptin4 !== true) missing.push('Terms');
    else if (!['reservationnote', 'marketsegment', 'guestoptin4'].includes(field)) missing.push('required hotel field');
  }
  return { stay: missing.length ? null : built.stay, missing };
}

/** Book state from the work item when this mail has no booking draft to hang it on. */
export function SavedStayReceipt({
  saved,
  screenshot,
}: {
  saved: SavedStayCommit;
  screenshot?: PaneStayClient['screenshot'] | null;
}) {
  const runId = saved.runId ?? saved.screenshotRef?.runId;
  const shots = visibleStayShots(saved.shots ?? []);
  const confirmed = Boolean(saved.confirmationNumber) && saved.status !== 'unknown';
  return (
    <div className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
      <span
        className={
          confirmed
            ? 'w-fit rounded-xs bg-emerald-100 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-900'
            : 'w-fit rounded-xs bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-950'
        }
      >
        {confirmed ? 'Booked' : 'Unconfirmed'}
      </span>
      {saved.confirmationNumber && saved.status !== 'unknown' ? (
        <p className="text-[12.5px] font-semibold text-emerald-800">
          {`Booked in HMS – confirmation ${saved.confirmationNumber}`}
        </p>
      ) : (
        <p role="alert" className="text-[11.5px] text-amber-900">
          {saved.cmsReason === 'saved_cms_mismatch'
            ? PANE_CMS_MISMATCH_COPY
            : saved.status === 'unknown' && saved.confirmationNumber
            ? PANE_SAVE_UNVERIFIED_COPY
            : 'HMS may have saved this booking, but Nava could not verify it.'}
        </p>
      )}
      {saved.status === 'unknown' && saved.confirmationNumber ? (
        <p data-pii className="text-[11.5px] text-amber-900">{`Possible confirmation: ${saved.confirmationNumber} (not verified)`}</p>
      ) : null}
      {saved.confirmationNumber ? <HmsLinkActions confirmation={saved.confirmationNumber} /> : null}
      {runId && shots.length > 0 && screenshot ? (
        <HmsShotsViewer key={runId} runId={runId} shots={shots} screenshot={screenshot} />
      ) : null}
    </div>
  );
}

export function BookingCards({
  draft,
  groups = [],
  paneSave = null,
  parties,
  contact = null,
  workItemId,
  savedStays,
  screenshot: shotReader,
  guestName,
  guestEditorKey,
  session,
  propertyCode,
  confirmation,
  onSaveDefault,
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
  /** Loads a stored HMS screenshot when Book writes are off and paneSave is absent. */
  screenshot?: PaneStayClient['screenshot'] | null;
  /** Selected staying Guest from People. Prefills first/last; never the Contact/booker. */
  guestName?: string;
  /** People-step cache key so a Guest edit updates Book first/last while both stay mounted. */
  guestEditorKey?: string;
  /** Current quote session. Used to build the generated Reservation note; omitted leaves the field manual. */
  session?: QuoteSession;
  /** Active mailbox property. Unknown or missing codes fail closed (no generated note). */
  propertyCode?: string | null;
  /**
   * Signed-in user and saved confirmation default. Without it, confirmation defaults to an
   * unresolved staff address until staff choose a recipient.
   */
  confirmation?: ConfirmationSources | null;
  /** Persists the current choice as this user's default. Omitted in card-only tests. */
  onSaveDefault?: (setting: ConfirmationSetting) => Promise<void>;
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
          const existingNote = textValue(room.request.reservationNote);
          const choice: RoomChoice = {
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
            bookingAgency: '',
            organization: textValue(room.request.organization) || pickedName(parties?.company),
            reservationNote: existingNote,
          };
          const generated = generatedNoteForChoice(session, propertyCode, room, roomGroupFor(room, groups), choice);
          choice.reservationNote = prefillReservationNote(existingNote, generated, false);
          if (!existingNote.trim() && generated) choice.generatedReservationNote = generated;
          return [key, choice];
        }),
      ),
  );

  const [localSaves, setSaves] = useState<Record<string, RoomSaveState>>(() =>
    savesFromSavedStays(draft, groups, savedStays),
  );
  const recentCommitsRef = useRef<Record<string, {
    workItemId: string | undefined; stayId: string | null; commit: CommitView;
  }>>({});
  function recentCommitForRoom(roomKey: string): CommitView | undefined {
    const recent = recentCommitsRef.current[roomKey];
    const room = draft.draft.rooms.find((item) => roomKeyOf(item) === roomKey);
    return recent && room && recent.workItemId === workItemId && recent.stayId === stayIdForRoom(room, groups)
      ? recent.commit : undefined;
  }
  // A work item can finish loading after this card mounts. Apply its saved outcomes immediately,
  // then retain them locally even if a later refresh temporarily omits savedStays.
  const storedSaves = savesFromSavedStays(draft, groups, savedStays);
  const saves = { ...localSaves };
  for (const [key, stored] of Object.entries(storedSaves)) {
    saves[key] = { ...saves[key], commit: stored.commit };
  }
  const savesRef = useRef(saves);
  savesRef.current = saves;
  const bookedInRunRef = useRef<Record<string, CommitView>>({});
  const committingRef = useRef(false);
  const savedStaysRef = useRef(savedStays);
  savedStaysRef.current = savedStays;
  const savedStayForRoom = (roomKey: string): SavedStayCommit | undefined =>
    savedStaysRef.current?.[recentCommitsRef.current[roomKey]?.stayId ?? ''];
  for (const key of Object.keys(recentCommitsRef.current)) {
    const recent = recentCommitForRoom(key);
    if (recentCanReplaceUnknown(saves[key]?.commit, recent, savedStayForRoom(key))) saves[key] = { ...saves[key], commit: recent };
  }
  useEffect(() => {
    const restored = Object.entries(savesFromSavedStays(draft, groups, savedStays));
    for (const [key, stored] of restored) {
      if (stored.commit?.status === 'booked' && !stored.commit.unverified) delete recentCommitsRef.current[key];
    }
    setSaves((current) => {
      let next: typeof current | undefined;
      for (const [key, stored] of restored) {
        if (JSON.stringify(current[key]?.commit) === JSON.stringify(stored.commit)) continue;
        next ??= { ...current };
        next[key] = { ...current[key], commit: stored.commit };
      }
      return next ?? current;
    });
  }, [draft, groups, savedStays]);
  const previewReceipt = usePaneStayPreview();
  const previewInputsRef = useRef<Record<string, PreviewInput>>({});
  const [stayBooking, setStayBooking] = useState(false);
  const stayBookingRef = useRef(false);
  const options = draft.options as BookingOptions;
  const cmsOptions = options.cmsMessageIds?.length ? options.cmsMessageIds : CMS_FALLBACK;
  const [sendConfirmation, setSendConfirmation] = useState(true);
  const [chosenCmsMessage, setChosenCmsMessage] = useState<string | null>(null);
  const hasBoundParty = Boolean(pickedName(parties?.agency) || pickedName(parties?.company));
  const defaultCmsMessage = hasBoundParty ? (options.cmsDefaults?.agency ?? '03') : (options.cmsDefaults?.guest ?? '01');
  const cmsMessage = chosenCmsMessage ?? defaultCmsMessage;
  const contextConfirmation = useConfirmationSources();
  const sources = confirmation === undefined ? contextConfirmation : confirmation;
  const [recipientMode, setRecipientMode] = useState<ConfirmationMode>(sources?.setting?.mode ?? 'self');
  const [customAddress, setCustomAddress] = useState(
    sources?.setting?.mode === 'custom' ? (sources.setting.address ?? '') : '',
  );
  const [staffChose, setStaffChose] = useState(false);
  const [defaultSaved, setDefaultSaved] = useState(false);
  const [defaultError, setDefaultError] = useState<string | null>(null);
  const [savingDefault, setSavingDefault] = useState(false);
  const saveGeneration = useRef(0);
  const staffChoseRef = useRef(false);
  const signedInUserId = sources?.userId ?? '';
  const signedInMailbox = sources?.mailbox ?? '';
  const scopeKey = confirmationScopeKey(signedInUserId, signedInMailbox);
  const scopeRef = useRef({ userId: signedInUserId, mailbox: signedInMailbox });
  scopeRef.current = { userId: signedInUserId, mailbox: signedInMailbox };
  const [seenScope, setSeenScope] = useState(`${scopeKey}\0${sources?.userEmail ?? ''}`);
  if (sources && seenScope !== `${scopeKey}\0${sources.userEmail}`) {
    setSeenScope(`${scopeKey}\0${sources.userEmail}`);
    staffChoseRef.current = false;
    setStaffChose(false);
    setDefaultSaved(false);
    setDefaultError(null);
    setSavingDefault(false);
    setRecipientMode(sources.setting?.mode ?? 'self');
    setCustomAddress(sources.setting?.mode === 'custom' ? (sources.setting.address ?? '') : '');
  }
  useEffect(() => {
    if (staffChoseRef.current || !sources?.setting) return;
    setRecipientMode(sources.setting.mode);
    if (sources.setting.mode === 'custom') setCustomAddress(sources.setting.address ?? '');
  }, [sources]);
  const effectiveRecipientMode = !sources && !staffChose ? 'self' : recipientMode;
  const clientEmail = contact ? textValue(contact.email) :
    staffChose && effectiveRecipientMode === 'client' ? textValue(draft.draft.rooms[0]?.request.bookerEmail) : '';
  const holdMessage = !sources || staffChose
    ? null
    : sources.load === 'pending'
      ? 'Nava is still reading the saved confirmation choice.'
      : sources.load === 'failed'
        ? 'Could not load your default (not set up). Pick who should get the HMS confirmation.'
        : sources.invalidSetting
          ? 'The saved confirmation choice is not set up. Pick who should get the HMS confirmation.'
          : null;
  const resolvedRecipient = holdMessage
    ? { ok: false as const, message: holdMessage }
    : resolveConfirmationRecipient({
        mode: effectiveRecipientMode,
        customAddress,
        userEmail: sources?.userEmail ?? '',
        clientEmail,
        invalidSetting: sources?.invalidSetting,
        staffChose,
      });
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
    setChoices((current) => {
      let changed = false;
      const next = { ...current };
      for (const room of draft.draft.rooms) {
        const key = `${room.groupId}:${room.roomIndex}`;
        const choice = current[key];
        if (!choice) continue;
        const generated = generatedNoteForChoice(session, propertyCode, room, roomGroupFor(room, groups), choice);
        const dirty = reservationNoteDirty.current[key] === true;
        const wasGenerated = !dirty && choice.generatedReservationNote !== undefined &&
          choice.reservationNote === choice.generatedReservationNote;
        const bound = wasGenerated ? (generated ?? '') : prefillReservationNote(choice.reservationNote, generated, dirty);
        const generatedReservationNote = wasGenerated || (!dirty && !choice.reservationNote.trim() && generated)
          ? (generated ?? undefined) : choice.generatedReservationNote;
        if (bound === choice.reservationNote && generatedReservationNote === choice.generatedReservationNote) continue;
        next[key] = { ...choice, reservationNote: bound, generatedReservationNote };
        changed = true;
      }
      return changed ? next : current;
    });
  }, [draft.draft.rooms, groups, propertyCode, session]);
  // The price check compared the quoted room. Once staff pick another room type, it no longer describes the booking.
  const roomTypeChanged = draft.draft.rooms.some((room) => {
    const requested = textValue(room.request.roomType);
    const selected = choices[roomKeyOf(room)]?.roomType ?? roomTypeFor(room, roomGroupFor(room, groups));
    return Boolean(requested && selected && requested !== selected);
  });

  // An edited rate or occupancy no longer describes the price comparison made for the original quote.
  const priceInputChanged = draft.draft.rooms.some((room) => {
    const choice = choices[roomKeyOf(room)];
    if (!choice) return false;
    const group = roomGroupFor(room, groups);
    const originalRate = textValue(group?.rateCode) || textValue(group?.quotedRateCode) || textValue(room.request.ratePlan);
    const originalAdults = String(group?.adults ?? room.request.adults ?? '');
    const originalAges = group?.childrenAges ?? room.request.childAges;
    return (choice.ratePlan !== undefined && choice.ratePlan !== originalRate) ||
      (choice.adults !== undefined && choice.adults !== originalAdults) ||
      (choice.childAges !== undefined && JSON.stringify(choice.childAges) !==
        JSON.stringify(Array.isArray(originalAges) ? originalAges.map(String) : []));
  });

  function savedOutcomeBlocksRoom(roomKey: string): boolean {
    const commit = savesRef.current[roomKey]?.commit;
    return commit?.status === 'booked' || (commit?.status === 'refused' && commit.statusChip === 'check');
  }

  function hasUncertainOutcome(): boolean {
    const verifiedAfterClaim = (roomKey: string, stored: CommitView | undefined) => {
      const recent = recentCommitForRoom(roomKey);
      return recentCanReplaceUnknown(stored, recent, savedStayForRoom(roomKey)) &&
        (recent?.status === 'refused' || (recent?.status === 'booked' && !recent.unverified));
    };
    return Object.entries(savedStaysRef.current ?? {}).some(([stayId, saved]) => {
      if (saved.status !== 'unknown') return false;
      const rooms = draft.draft.rooms.filter((room) => stayIdForRoom(room, groups) === stayId);
      if (rooms.length !== 1) return rooms.length > 1; // Other drafts are held by the server.
      const room = rooms[0]!;
      return !verifiedAfterClaim(roomKeyOf(room), commitViewFromSaved(saved, room.request));
    }) ||
      Object.entries(savesRef.current).some(([key, save]) =>
        isUncertainCommit(save.commit) && !verifiedAfterClaim(key, save.commit)) ||
      Object.values(recentCommitsRef.current).some((recent) => {
        const saved = savedStaysRef.current?.[recent.stayId ?? ''];
        return recent.workItemId === workItemId && isUncertainCommit(recent.commit) && !(saved?.status === 'booked' &&
          saved.confirmationNumber && (recent.commit.status !== 'booked' || saved.confirmationNumber === recent.commit.confirmationNumber));
      });
  }

  function patchSave(roomKey: string, patch: RoomSaveState, finishClaim = false) {
    setSaves((current) => {
      if (savedOutcomeBlocksRoom(roomKey) &&
          !(finishClaim && recentCanReplaceUnknown(savesRef.current[roomKey]?.commit, patch.commit, savedStayForRoom(roomKey)))) return current;
      return { ...current, [roomKey]: { ...current[roomKey], ...patch } };
    });
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
    if (!workItemId || savedOutcomeBlocksRoom(roomKey)) return;
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
    return draft.draft.rooms;
  }

  function roomBuilt(
    room: BookingDraftReady['draft']['rooms'][number],
    currentContact: StoredContact | null = contact,
  ) {
    const group = roomGroupFor(room, groups);
    const choice = choices[roomKeyOf(room)] ?? NO_CHOICE;
    const boundAgency = parties?.agency?.nativeId ? parties.agency : undefined;
    const unboundName = textValue(room.request.agency).trim();
    const agencyUnresolved = choice.bookingAgency !== '__none__' && !boundAgency && Boolean(unboundName);
    const currentEmail = currentContact ? textValue(currentContact.email) :
      staffChose && effectiveRecipientMode === 'client' ? textValue(draft.draft.rooms[0]?.request.bookerEmail) : '';
    const recipient = holdMessage ? { ok: false as const, message: holdMessage } : resolveConfirmationRecipient({
      mode: effectiveRecipientMode, customAddress, userEmail: sources?.userEmail ?? '', clientEmail: currentEmail,
      invalidSetting: sources?.invalidSetting, staffChose,
    });
    const roomChoice = roomChoiceFor(room, group, choice, currentContact, sendConfirmation && recipient.ok ? recipient.recipient : null);
    if (!reservationNoteDirty.current[roomKeyOf(room)] && choice.generatedReservationNote !== undefined &&
      choice.reservationNote === choice.generatedReservationNote) {
      roomChoice.reservationNote = generatedNoteForChoice(session, propertyCode, room, group, choice) ?? '';
    }
    roomChoice.bookingAgency = choice.bookingAgency === '__none__' || !boundAgency
      ? undefined : { name: boundAgency.name, nativeId: boundAgency.nativeId };
    roomChoice.confirmationSendMail = sendConfirmation;
    roomChoice.cmsMessageId = cmsMessage;
    const built = paneStayInputForConfiguredRoom(roomRequestFor(room, group, choice), roomChoice, requiredCreateFields);
    const missing = [...built.missing];
    if (agencyUnresolved) missing.push('booking agency');
    if (sendConfirmation && !recipient.ok) missing.push('confirmation recipient');
    if (!cmsOptions.some((option) => option.code === cmsMessage)) missing.push('Confirmation type');
    const selectedRoom = roomChoice.roomType ?? '';
    if (propertyCode && propertyCode !== 'HRCEN' && !draft.options.roomType.includes(selectedRoom)) missing.push('room type');
    return { stay: missing.length ? null : built.stay, missing: [...new Set(missing)] };
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
      let next: typeof current | undefined;
      for (const [roomKey, input] of inputs) {
        const existing = current[roomKey]?.preview;
        const cached = restored[roomKey];
        const preview = cached ?? (
          existing && existing.status !== 'stale' && existing.status !== 'running' && existing.key !== input.key
            ? { status: 'stale' as const, key: existing.key }
            : existing
        );
        if (preview !== existing) {
          next ??= { ...current };
          next[roomKey] = { ...current[roomKey], preview };
        }
      }
      return next ?? current;
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
    if (!workItemId || committingRef.current || hasUncertainOutcome()) return;
    const snapshot = bookableRooms()
      .filter((room) => {
        const commit = saves[roomKeyOf(room)]?.commit;
        return commit?.status !== 'booked' && !(commit?.status === 'refused' && commit.statusChip === 'check');
      })
      .map((room) => {
        const ready = roomPreviewReady(room);
        return ready ? { roomKey: roomKeyOf(room), stay: ready.stay, digest: ready.digest } : null;
      });
    if (snapshot.some((item) => item == null)) return;
    stayBookingRef.current = true;
    bookedInRunRef.current = {};
    setStayBooking(true);
    try {
      for (const item of snapshot) {
        if (!item || !stayBookingRef.current || savedOutcomeBlocksRoom(item.roomKey)) return;
        const room = draft.draft.rooms.find((candidate) => roomKeyOf(candidate) === item.roomKey);
        if (!room) return;
        const currentStay = roomBuilt(room, contactRef.current).stay;
        if (!currentStay || paneStayKey(currentStay) !== paneStayKey(item.stay) ||
            previewInputsRef.current[item.roomKey]?.inputKey !== paneStayKey(item.stay)) return;
        if (!(await bookRoom(item.roomKey, pane, item.stay, item.digest))) return;
      }
    } finally {
      stayBookingRef.current = false;
      bookedInRunRef.current = {};
      setStayBooking(false);
    }
  }

  // Rooms 2+ join the first room already booked for the same guest and dates, so HMS holds one booking with
  // several rooms (Associated Reservations) instead of separate bookings the duplicate check would refuse.
  function bookedParentStayId(room: BookingDraftReady['draft']['rooms'][number], stay: PaneStayInput): string | null {
    for (const other of draft.draft.rooms) {
      if (other === room) continue;
      const commit = bookedInRunRef.current[roomKeyOf(other)] ?? savesRef.current[roomKeyOf(other)]?.commit;
      if (commit?.status !== 'booked' || commit.unverified || !commit.confirmationNumber) continue;
      const otherStay = roomBuilt(other, contactRef.current).stay;
      // Add Record keeps room 1's guest profile, so only a room for the same guest joins it.
      if (otherStay && otherStay.lastName === stay.lastName && otherStay.firstName === stay.firstName &&
        otherStay.arrival === stay.arrival && otherStay.departure === stay.departure &&
        inheritedFieldsMatch(other, otherStay, room, stay)) return stayIdForRoom(other, groups);
    }
    return null;
  }

  // The added room copies room 1's booking-level fields, so a room staff set up differently stays its own booking.
  // Nava's generated notes differ per room by design; a note staff typed must match.
  function inheritedFieldsMatch(
    parentRoom: BookingDraftReady['draft']['rooms'][number],
    parent: PaneStayInput,
    room: BookingDraftReady['draft']['rooms'][number],
    stay: PaneStayInput,
  ): boolean {
    const shared = (value: PaneStayInput) => JSON.stringify([
      value.guaranteeType, value.track, value.marketSegment ?? '', value.sourceOfBusiness, value.guestoptin4,
      value.bookingAgency ?? null, value.organization ?? null, value.cmsMessageId ?? '', value.confirmationSendMail ?? false,
      value.bookerName ?? '', value.bookerEmail ?? '', value.confirmationRecipient ?? null,
    ]);
    if (shared(parent) !== shared(stay)) return false;
    const generated = (item: BookingDraftReady['draft']['rooms'][number]) => {
      const choice = choices[roomKeyOf(item)];
      return !reservationNoteDirty.current[roomKeyOf(item)] && choice?.generatedReservationNote !== undefined &&
        choice.reservationNote === choice.generatedReservationNote;
    };
    return (parent.reservationNote ?? '') === (stay.reservationNote ?? '') || (generated(parentRoom) && generated(room));
  }

  async function bookRoom(roomKey: string, pane: PaneStayClient, stay: PaneStayInput, previewDigest: string) {
    if (!workItemId || committingRef.current || hasUncertainOutcome() || savedOutcomeBlocksRoom(roomKey)) return false;
    delete recentCommitsRef.current[roomKey];
    committingRef.current = true;
    return performRoomCommit(roomKey, pane, stay, previewDigest).finally(() => { committingRef.current = false; });
  }

  async function performRoomCommit(roomKey: string, pane: PaneStayClient, stay: PaneStayInput, previewDigest: string) {
    const key = paneStayKey(stay);
    const room = draft.draft.rooms.find((item) => `${item.groupId}:${item.roomIndex}` === roomKey);
    if (room) previewReceipt.clear(workItemId, stayIdForRoom(room, groups));
    patchSave(roomKey, { commit: { status: 'running', key } });
    let commit: CommitView;
    try {
      const parentStayId = room && workItemId ? bookedParentStayId(room, stay) : null;
      const persist =
        workItemId && room
          ? { stayId: stayIdForRoom(room, groups), workItemId, ...(parentStayId ? { parentStayId } : {}) }
          : {};
      const result = await pane.commit({ ...stay, ...persist } as PaneStayInput, previewDigest);
      const outcome = commitOutcome(result, stay);
      commit = outcome.ok
        ? {
            status: 'booked',
            key,
            confirmationNumber: outcome.confirmationNumber,
            runId: outcome.runId,
            screenshots: outcome.screenshots,
            ...(outcome.unverified ? { unverified: true } : {}),
            ...(outcome.cmsMismatch ? { cmsMismatch: true } : {}),
          }
        : {
            status: 'refused',
            key,
            message: outcome.message,
            runId: outcome.runId,
            screenshots: outcome.screenshots,
            ...(result.status === 'ok' || result.reason === PANE_SAVE_UNCONFIRMED_REASON
              ? { statusChip: 'check' as const } : {}),
            ...(result.status === 'refused' && result.clickedSave === false && result.reason !== PANE_SAVE_UNCONFIRMED_REASON
              ? { clearedClaim: { snapshot: room ? savedStaysRef.current?.[stayIdForRoom(room, groups)] : undefined } } : {}),
          };
    } catch {
      commit = { status: 'refused', key, message: PANE_COMMIT_UNREACHABLE_COPY, statusChip: 'check' };
    }
    recentCommitsRef.current[roomKey] = {
      workItemId, stayId: room ? stayIdForRoom(room, groups) : null, commit,
    };
    // The next room in a Book this stay run can start before React re-renders this result.
    if (commit.status === 'booked' && !commit.unverified && stayBookingRef.current) bookedInRunRef.current[roomKey] = commit;
    // Definite refusals can be previewed again; uncertain saves stay locked for an HMS check.
    patchSave(roomKey, commit.status === 'booked' ? { commit } : { commit, preview: undefined }, true);
    return commit.status === 'booked' && !commit.unverified;
  }

  const unconfirmed = hasUncertainOutcome();
  const commitInFlight = Object.values(saves).some((save) => save.commit?.status === 'running');

  return (
    <section aria-label="Booking details" className="flex flex-col gap-2">
      <p className="text-[11px] text-[#64748b]">
        {savesOn
          ? 'Preview each room using the Stay details above, then create it in HMS.'
          : 'Saving to HMS from this pane is off for now. Stay details are above; enter the booking-only fields in HMS Guest Stay.'}
      </p>
      {client && savesOn && !workItemId ? (
        <p role="status">Nava could not connect this booking to the request. Reopen the request to continue.</p>
      ) : null}
      <div className="flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3">
        <label className="flex items-center gap-2 text-xs font-semibold text-[#475569]">
          <input type="checkbox" aria-label="Send confirmation from HMS" checked={sendConfirmation}
            disabled={stayBooking} onChange={(event) => setSendConfirmation(event.target.checked)} />
          Send confirmation from HMS
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
          Message Id
          <select aria-label="Message Id" className={paneFieldClass} disabled={stayBooking}
            value={cmsMessage} onChange={(event) => setChosenCmsMessage(event.target.value)}>
            <option value="">Select confirmation type</option>
            {cmsOptions.map((option) => <option key={option.code} value={option.code}>{option.code} – {option.label}</option>)}
          </select>
        </label>
      {sendConfirmation ? (
        <div data-pii>
        <ConfirmationRecipient
          mode={effectiveRecipientMode}
          customAddress={customAddress}
          userEmail={sources?.userEmail ?? ''}
          clientEmail={clientEmail}
          disabled={stayBooking}
          unconfirmed={Boolean(holdMessage) && sources?.load !== 'pending'}
          error={resolvedRecipient && !resolvedRecipient.ok ? resolvedRecipient.message : null}
          onMode={(next) => {
            staffChoseRef.current = true;
            saveGeneration.current += 1;
            setStaffChose(true);
            setRecipientMode(next);
            setDefaultSaved(false);
          }}
          onCustomAddress={(value) => {
            staffChoseRef.current = true;
            saveGeneration.current += 1;
            setStaffChose(true);
            setCustomAddress(value);
            setDefaultSaved(false);
          }}
          onMakeDefault={
            onSaveDefault
              ? () => {
                  if (savingDefault || !resolvedRecipient?.ok) return;
                  const { mode, address } = resolvedRecipient.recipient;
                  const setting: ConfirmationSetting =
                    mode === 'custom' ? { mode, address } : { mode };
                  const generation = ++saveGeneration.current;
                  const startedUserId = scopeRef.current.userId;
                  const startedMailbox = scopeRef.current.mailbox;
                  setDefaultError(null);
                  setSavingDefault(true);
                  void onSaveDefault(setting)
                    .then(() => {
                      if (saveGeneration.current !== generation) return;
                      if (
                        scopeRef.current.userId !== startedUserId ||
                        scopeRef.current.mailbox !== startedMailbox
                      ) {
                        return;
                      }
                      setDefaultSaved(true);
                    })
                    .catch(() => {
                      if (saveGeneration.current !== generation) return;
                      if (
                        scopeRef.current.userId !== startedUserId ||
                        scopeRef.current.mailbox !== startedMailbox
                      ) {
                        return;
                      }
                      setDefaultError('Could not save your default (not set up).');
                    })
                    .finally(() => {
                      setSavingDefault(false);
                    });
                }
              : undefined
          }
          saving={savingDefault}
          defaultSaved={defaultSaved}
          defaultError={defaultError}
        />
        </div>
      ) : null}
      </div>
      {mode === 'lab' ? (
        <p role="note" className="text-[11.5px] text-amber-900">
          {LAB_WRITE_NOTE}
        </p>
      ) : null}
      {(roomTypeChanged || priceInputChanged) && draft.draft.rateCheck.length > 0 ? (
        <Notice tone="warn">{roomTypeChanged ? ROOM_TYPE_CHANGED_COPY : PRICE_INPUT_CHANGED_COPY}</Notice>
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
            const nextChoice: RoomChoice = {
              ...currentChoice,
              ...patch,
              ...(guestChanged ? { guestoptin4: false } : {}),
            };
            if (!reservationNoteDirty.current[key]) {
              const wasGenerated = currentChoice.generatedReservationNote !== undefined &&
                currentChoice.reservationNote === currentChoice.generatedReservationNote;
              const generated = generatedNoteForChoice(session, propertyCode, room, roomGroupFor(room, groups), nextChoice);
              if (wasGenerated || (!nextChoice.reservationNote.trim() && generated)) {
                nextChoice.reservationNote = generated ?? '';
                nextChoice.generatedReservationNote = generated ?? undefined;
              }
            }
            return { ...current, [key]: nextChoice };
          });
        // Once create is running or saved, freeze its create-only fields until staff checks the result.
        const commitStatus = saves[key]?.commit?.status;
        const locked = stayBooking || commitStatus === 'running' || savedOutcomeBlocksRoom(key);
        const request = room.request;
        const group = roomGroupFor(room, groups);
        const generatedNote = generatedNoteForChoice(session, propertyCode, room, group, choice);
        const built = roomBuilt(room);
        const price = group?.rowPrice;
        const override = price?.source === 'override' ? price : null;
        const commit = saves[key]?.commit;
        const bookedCommit = commit?.status === 'booked' && !commit.unverified ? commit : null;
        const roomCount = group?.quantity ?? Math.max(
          1,
          draft.draft.rooms.filter((candidate) => candidate.groupId === room.groupId).length,
        );
        const selectedRoom = choice.roomType ?? roomTypeFor(room, group);
        const selectedRate = choice.ratePlan ?? (textValue(group?.rateCode) || textValue(group?.quotedRateCode) || textValue(request.ratePlan));
        const propertyRooms = [...draft.options.roomType];
        if ((!propertyCode || propertyCode === 'HRCEN') && selectedRoom && !propertyRooms.includes(selectedRoom)) propertyRooms.push(selectedRoom);
        const rateCodes = [...new Set([
          ...(options.ratePlans ?? []),
          ...(session?.rateOptions ?? []).filter((rate) => rate.groupId === room.groupId && rate.roomCode === selectedRoom).map((rate) => rate.rateCode),
          ...(choice.ratePlan === undefined && selectedRate ? [selectedRate] : []),
        ].filter(Boolean))];
        const ages = choice.childAges ?? (Array.isArray(group?.childrenAges ?? request.childAges)
          ? (group?.childrenAges ?? request.childAges as number[]).map(String) : []);
        const boundAgency = parties?.agency?.nativeId ? parties.agency : undefined;
        const agencyValue = choice.bookingAgency === '__none__' ? '__none__' : boundAgency ? '__bound__' : '';
        const roomLabel = rowRoomLabel({
          roomPreference: selectedRoom || textValue(request.roomType),
          quantity: roomCount,
        });
        return (
          <article
            key={key}
            className="shadow-xs flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3"
          >
            <div className="flex items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-[#475569]">
                Booking agency
                <select aria-label="Booking agency" className={paneFieldClass} disabled={locked} value={agencyValue}
                  onChange={(event) => setChoice({ bookingAgency: event.target.value })}>
                  <option value="">Select agency above</option>
                  <option value="__none__">No agency</option>
                  {boundAgency ? <option value="__bound__">{boundAgency.name}</option> : null}
                </select>
              </label>
              <CopyButton label="Booking agency" roomLabel={roomLabel} value={agencyValue === '__bound__' ? boundAgency?.name ?? '' : ''} />
            </div>
            {!boundAgency && textValue(request.agency).trim() && agencyValue !== '__none__' ? (
              <p className="text-[11px] text-[#64748b]">{textValue(request.agency)}: select this agency in Agency &amp; company above, or choose No agency.</p>
            ) : null}
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
            <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
              Room type
              <select aria-label="Room type" className={paneFieldClass} disabled={locked}
                value={propertyRooms.includes(selectedRoom) ? selectedRoom : ''}
                onChange={(event) => setChoice({ roomType: event.target.value, ratePlan: '' })}>
                <option value="">Select room type</option>
                {propertyRooms.map((code) => <option key={code} value={code}>{code}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
              Rate plan
              <select aria-label="Rate plan" className={paneFieldClass} disabled={locked} value={selectedRate}
                onChange={(event) => setChoice({ ratePlan: event.target.value })}>
                <option value="">Select rate plan</option>
                {rateCodes.map((code) => <option key={code} value={code}>{code}</option>)}
              </select>
            </label>
            {!selectedRate ? <p className="text-[11px] text-[#64748b]">Rates loading. Select a rate when available.</p> : null}
            <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
              Adults
              <input type="number" min={1} max={16} step={1} aria-label="Adults" className={paneFieldClass} disabled={locked}
                value={choice.adults ?? String(group?.adults ?? request.adults ?? '')}
                onChange={(event) => setChoice({ adults: event.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
              Children
              <input type="number" min={0} max={16} step={1} aria-label="Children" className={paneFieldClass} disabled={locked}
                value={ages.length} onChange={(event) => {
                  if (event.target.value.trim() === '') return;
                  const count = Number(event.target.value);
                  if (Number.isInteger(count) && count >= 0 && count <= 16) {
                    setChoice({ childAges: Array.from({ length: count }, (_, index) => ages[index] ?? '') });
                  }
                }} />
            </label>
            {CHILD_AGE_FIELDS.slice(0, ages.length).map((field, index) => (
              <label key={field} className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
                Child age {index + 1}
                <input type="number" min={0} max={17} step={1} aria-label={`Child age ${index + 1}`}
                  className={paneFieldClass} disabled={locked} value={ages[index] ?? ''}
                  onChange={(event) => setChoice({ childAges: ages.map((item, i) => i === index ? event.target.value : item) })} />
              </label>
            ))}
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
            {selectedGuestName.trim() && guestSplit.ambiguous ? (
              <p role="status" className="text-[11px] text-[#64748b]">
                {AMBIGUOUS_GUEST_NAME_COPY}
              </p>
            ) : null}
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
                <span>Terms</span>
              </label>
              <p className="text-[11px] text-[#64748b]">Select only if the guest explicitly opted in.</p>
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
                  setChoice({ reservationNote: generatedNote, generatedReservationNote: generatedNote });
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
            {client && savesOn ? (
              <RoomSave
                stay={built.stay}
                previewKey={previewKeyForRoom(room, built.stay)}
                missing={built.missing}
                save={saves[key] ?? {}}
                screenshot={client.screenshot}
                bookLabel={CREATE_PROVISIONAL_LABEL}
                frozen={stayBooking || !workItemId}
                bookBlocked={unconfirmed || commitInFlight}
                onPreview={(stay) => void previewRoom(key, client, stay)}
                onBook={(stay, previewDigest) => void bookRoom(key, client, stay, previewDigest)}
              />
            ) : saves[key]?.commit ? (
              <RoomSave
                stay={built.stay}
                previewKey={previewKeyForRoom(room, built.stay)}
                missing={built.missing}
                save={saves[key] ?? {}}
                screenshot={client?.screenshot ?? shotReader ?? (async () => null)}
                bookLabel={CREATE_PROVISIONAL_LABEL}
                frozen
                onPreview={() => undefined}
                onBook={() => undefined}
              />
            ) : (
              <div className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
                <PrimaryButton disabled>{WRITES_OFF_LABEL}</PrimaryButton>
              </div>
            )}
          </article>
        );
      })}
      {client && savesOn ? (
        <StayBookBar
          rooms={draft.draft.rooms}
          saves={saves}
          isPreviewReady={(room) => roomPreviewReady(room) !== null}
          pane={client}
          stayBooking={stayBooking || !workItemId}
          unconfirmed={unconfirmed}
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
  pane,
  stayBooking,
  unconfirmed,
  onBookStay,
}: {
  rooms: BookingDraftReady['draft']['rooms'];
  saves: Record<string, RoomSaveState>;
  isPreviewReady: (room: BookingDraftReady['draft']['rooms'][number]) => boolean;
  pane: PaneStayClient;
  stayBooking: boolean;
  unconfirmed: boolean;
  onBookStay: (pane: PaneStayClient) => Promise<void>;
}) {
  const bookable = rooms;
  if (!bookable.length) return null;
  const numbers = bookable.flatMap((room) => {
    const commit = saves[`${room.groupId}:${room.roomIndex}`]?.commit;
    return commit?.status === 'booked' && !commit.unverified && commit.confirmationNumber ? [commit.confirmationNumber] : [];
  });
  const pending = bookable.filter((room) => {
    const commit = saves[`${room.groupId}:${room.roomIndex}`]?.commit;
    return commit?.status !== 'booked' && !(commit?.status === 'refused' && commit.statusChip === 'check');
  });
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
          {`Booked ${numbers.length} of ${bookable.length} – ${numbers.join(', ')}`}
        </p>
      ) : null}
      {unconfirmed ? (
        <p role="status" className="text-[11.5px] text-amber-900">A booking is still unconfirmed. Nava paused the remaining rooms.</p>
      ) : null}
      {pending.length > 0 ? (
        <PrimaryButton
          disabled={!allPreviewed || busy || unconfirmed}
          disabledReason={unconfirmed ? 'A booking is still unconfirmed' : !allPreviewed && !busy ? 'Preview in HMS first' : null}
          onClick={() => void onBookStay(pane)}
        >
          {BOOK_THIS_STAY_LABEL}
        </PrimaryButton>
      ) : null}
    </div>
  );
}
