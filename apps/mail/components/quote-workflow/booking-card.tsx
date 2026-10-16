'use client';

import { useEffect, useState } from 'react';
import type {
  BookingDraftReady,
  BookingRateCheck,
  StaffQuoteParties,
  StaffQuoteParty,
  StayGroupRequirement,
} from '@/lib/quote-workflow/types';
import { HmsLinkActions } from './hms-link-actions';
import { CopyHmsNotesButton, hmsNotesBlock } from './rate-controls';
import { rowRoomLabel } from '@/lib/quote-workflow/room-types';
import type { StoredContact } from '@/lib/quote-workflow/backend-bind';
import { trackPaneAction } from '@/lib/quote-workflow/pane-telemetry';
import {
  commitOutcome,
  PANE_BOOKER_EMAIL_MAX,
  PANE_BOOKER_NAME_MAX,
  PANE_CHILDREN_COPY,
  PANE_COMMIT_UNREACHABLE_COPY,
  PANE_PARTY_NAME_MAX,
  PANE_PREVIEW_FAILED_COPY,
  PANE_RESERVATION_NOTE_MAX,
  paneStayInputForRoom,
  paneStayKey,
  previewOutcome,
  type PaneSaveMode,
  type PaneStayClient,
  type PaneStayInput,
} from '@/lib/quote-workflow/pane-stay-bind';
import { Notice, paneFieldClass, PrimaryButton, SecondaryButton, Section } from '@/components/nava-pane/pane-ui';

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

// A company or agency picked for the quote fills an empty field with its HMS name. Only a pick with an HMS id counts.
function pickedName(party: StaffQuoteParty | undefined): string {
  return party?.nativeId ? party.name : '';
}

function countValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const count = Number(value);
  return Number.isFinite(count) ? String(count) : '';
}

function nightsBetween(arrival: string, departure: string): string {
  const start = Date.parse(`${arrival}T00:00:00Z`);
  const end = Date.parse(`${departure}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const nights = Math.round((end - start) / 86_400_000);
  return nights > 0 ? String(nights) : '';
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

/** `pii`: the value names the guest, so the preview gate masks it (data-pii). */
function CopyRow({
  label,
  roomLabel,
  value,
  pii = false,
}: {
  label: string;
  roomLabel: string;
  value: string;
  pii?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="w-32 shrink-0 text-[11.5px] font-semibold text-[#475569]">{label}</span>
      <span data-pii={pii || undefined} className="min-w-0 flex-1 break-words text-[#1e293b]">
        {value || 'Not set'}
      </span>
      <CopyButton label={label} roomLabel={roomLabel} value={value} />
    </div>
  );
}

const PREVIEW_SHOT = 'filled.png';
const SAVED_SHOT = 'saved.png';
// The Book label names the mode, so a lab-only server never reads as a live save.
const BOOK_LABEL: Record<'lab' | 'on', string> = { lab: 'Book (lab test only)', on: 'Book in HMS' };
const textareaClass =
  'outline-hidden w-full rounded-xs border border-[#cbd5e1] bg-white px-2 py-1 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]';

type PreviewView =
  | { status: 'running'; key: string }
  | { status: 'ready'; key: string; digest: string; runId?: string; screenshots: string[] }
  | { status: 'refused'; key: string; message: string };

type CommitView =
  | { status: 'running'; key: string }
  | { status: 'booked'; key: string; confirmationNumber: string; runId?: string; screenshots: string[] }
  | { status: 'refused'; key: string; message: string; runId?: string; screenshots?: string[] };

type RoomSaveState = { preview?: PreviewView; commit?: CommitView };

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
  missing,
  save,
  screenshot,
  bookLabel,
  onPreview,
  onBook,
}: {
  stay: PaneStayInput | null;
  missing: string[];
  save: RoomSaveState;
  screenshot: PaneStayClient['screenshot'];
  bookLabel: string;
  onPreview: (stay: PaneStayInput) => void;
  onBook: (stay: PaneStayInput, previewDigest: string) => void;
}) {
  const { preview, commit } = save;
  const key = stay ? paneStayKey(stay) : null;
  const busy = preview?.status === 'running' || commit?.status === 'running';
  const fresh = stay && preview?.status === 'ready' && preview.key === key ? preview : null;
  const changed = preview?.status === 'ready' && preview.key !== key;

  if (commit?.status === 'booked') {
    const savedShot = pickScreenshot(commit.screenshots, SAVED_SHOT);
    return (
      <div className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
        <p data-pii className="text-[12.5px] font-semibold text-emerald-800">
          {`Booked in HMS – confirmation ${commit.confirmationNumber}`}
        </p>
        <HmsLinkActions
          confirmation={commit.confirmationNumber}
          guestSurname={stay?.lastName}
          arrival={stay?.arrival}
        />
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
      {preview?.status === 'refused' ? (
        <p role="alert" className="text-[11.5px] text-amber-900">
          {preview.message}
        </p>
      ) : null}
      {changed ? (
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
  onChange,
}: {
  label: string;
  roomLabel: string;
  value: string;
  disabled: boolean;
  maxLength: number;
  multiline?: boolean;
  pii?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-end gap-2" data-pii={pii || undefined}>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-[#475569]">
        {label}
        {multiline ? (
          <textarea
            rows={3}
            aria-label={label}
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
  roomType: string;
  track: string;
  sourceOfBusiness: string;
  guaranteeType: string;
  ratePlan: string;
  firstName: string;
  lastName: string;
  bookingAgency: string;
  organization: string;
  reservationNote: string;
  bookerName: string;
  bookerEmail: string;
};

const NO_CHOICE: RoomChoice = {
  roomType: '',
  track: '',
  sourceOfBusiness: '',
  guaranteeType: '',
  ratePlan: '',
  firstName: '',
  lastName: '',
  bookingAgency: '',
  organization: '',
  reservationNote: '',
  bookerName: '',
  bookerEmail: '',
};

export function BookingCards({
  draft,
  groups = [],
  paneSave = null,
  parties,
  contact = null,
}: {
  draft: BookingDraftReady;
  groups?: StayGroupRequirement[];
  /** Set only when the server pane save flag is lab or on. Without it the card stays copy-only. */
  paneSave?: PaneStayClient | null;
  /** The stored read's contact. Its name and company fill the HMS notes where the room card has none. */
  contact?: StoredContact | null;
  /** The company and agency picked for this quote. They fill only the fields the draft leaves empty. */
  parties?: StaffQuoteParties;
}) {
  const client = paneSave;
  // off keeps the card copy-only. A client whose mode is not read yet is labelled as lab, the narrower mode.
  const mode: PaneSaveMode = client ? (client.mode?.() ?? 'lab') : 'off';
  const savesOn = mode !== 'off';
  const [choices, setChoices] = useState<Record<string, RoomChoice>>(
    () =>
      Object.fromEntries(
        draft.draft.rooms.map((room) => {
          const key = `${room.groupId}:${room.roomIndex}`;
          return [
            key,
            {
              roomType: textValue(room.request.roomType),
              track: textValue(room.request.track),
              sourceOfBusiness: textValue(room.request.sourceOfBusiness),
              guaranteeType: textValue(room.request.guaranteeType),
              ratePlan:
                textValue(room.request.ratePlan) ||
                (() => {
                  const stay =
                    groups.find((item) => item.id === room.groupId) ??
                    groups.find((item) => `${item.arrivalDate ?? ''}:${item.departureDate ?? ''}` === room.groupId);
                  return stay?.rateCode || stay?.quotedRateCode || '';
                })() ||
                '',
              firstName: textValue(room.request.firstName),
              lastName: textValue(room.request.lastName),
              bookingAgency: textValue(room.request.agency) || pickedName(parties?.agency),
              organization: textValue(room.request.organization) || pickedName(parties?.company),
              reservationNote: textValue(room.request.reservationNote),
              bookerName: textValue(room.request.bookerName) || contact?.name || '',
              bookerEmail: textValue(room.request.bookerEmail) || contact?.email || '',
            },
          ];
        }),
      ),
  );

  const [saves, setSaves] = useState<Record<string, RoomSaveState>>({});
  // The price check compared the quoted room. Once staff pick another room type, it no longer describes the booking.
  const roomTypeChanged = draft.draft.rooms.some((room) => {
    const choice = choices[`${room.groupId}:${room.roomIndex}`];
    return choice !== undefined && choice.roomType !== textValue(room.request.roomType);
  });

  function patchSave(roomKey: string, patch: RoomSaveState) {
    setSaves((current) => ({ ...current, [roomKey]: { ...current[roomKey], ...patch } }));
  }

  async function previewRoom(roomKey: string, pane: PaneStayClient, stay: PaneStayInput) {
    const key = paneStayKey(stay);
    patchSave(roomKey, { preview: { status: 'running', key }, commit: undefined });
    let preview: PreviewView;
    try {
      const outcome = previewOutcome(await pane.preview(stay));
      preview = outcome.ok
        ? { status: 'ready', key, digest: outcome.digest, runId: outcome.runId, screenshots: outcome.screenshots }
        : { status: 'refused', key, message: outcome.message };
    } catch {
      preview = { status: 'refused', key, message: PANE_PREVIEW_FAILED_COPY };
    }
    patchSave(roomKey, { preview });
  }

  async function bookRoom(roomKey: string, pane: PaneStayClient, stay: PaneStayInput, previewDigest: string) {
    const key = paneStayKey(stay);
    patchSave(roomKey, { commit: { status: 'running', key } });
    let commit: CommitView;
    try {
      const outcome = commitOutcome(await pane.commit(stay, previewDigest), stay);
      commit = outcome.ok
        ? {
            status: 'booked',
            key,
            confirmationNumber: outcome.confirmationNumber,
            runId: outcome.runId,
            screenshots: outcome.screenshots,
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
    <Section title="Book in HMS">
      <p className="text-[11px] text-[#64748b]">
        {savesOn
          ? 'Preview each room in HMS first, then book it. Click Copy next to any field to paste it by hand instead.'
          : 'Saving to HMS from this pane is off for now. Click Copy next to each field, then paste it into HMS Guest Stay.'}
      </p>
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
        const key = `${room.groupId}:${room.roomIndex}`;
        const choice = choices[key] ?? NO_CHOICE;
        const setChoice = (patch: Partial<RoomChoice>) =>
          setChoices((current) => ({
            ...current,
            [key]: { ...(current[key] ?? NO_CHOICE), ...patch },
          }));
        // Once Book in HMS is running or has booked this room, its choices are frozen so the card cannot show a new value beside the saved one.
        const commitStatus = saves[key]?.commit?.status;
        const locked = commitStatus === 'running' || commitStatus === 'booked';
        const request = room.request;
        const built = paneStayInputForRoom(request, choice);
        const group =
          groups.find((item) => item.id === room.groupId) ??
          groups.find((item) => `${item.arrivalDate ?? ''}:${item.departureDate ?? ''}` === room.groupId);
        // The quoted rate for the room's HMS notes: the row's price choice, its approval note for an override, and the
        // confirmation once Book in HMS has booked the room.
        const price = group?.rowPrice;
        const override = price?.source === 'override' ? price : null;
        const commit = saves[key]?.commit;
        const bookedCommit = commit?.status === 'booked' ? commit : null;
        const arrival = textValue(request.arrival);
        const departure = textValue(request.departure);
        const childCount = Array.isArray(request.childAges) ? request.childAges.length : 0;
        const roomCount = group?.quantity ?? Math.max(
          1,
          draft.draft.rooms.filter((candidate) => candidate.groupId === room.groupId).length,
        );
        const roomLabel = rowRoomLabel({
          roomPreference: choice.roomType || group?.roomPreference || textValue(request.roomType),
          quantity: roomCount,
        });
        return (
          <article
            key={key}
            className="shadow-xs flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3"
          >
            <h4 className="text-[12.5px] font-bold text-[#1e293b]">{roomLabel}</h4>
            <CopyRow roomLabel={roomLabel} label="Arrival" value={arrival} />
            <CopyRow roomLabel={roomLabel} label="Departure" value={departure} />
            <CopyRow roomLabel={roomLabel} label="Nights" value={nightsBetween(arrival, departure)} />
            <CopyRow roomLabel={roomLabel} label="Adults" value={countValue(request.adults)} />
            <CopyRow roomLabel={roomLabel} label="Children" value={String(childCount)} />
            <div className="flex items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-[#475569]">
                Room type
                <select
                  disabled={locked}
                  aria-label="Room type"
                  className={paneFieldClass}
                  value={choice.roomType}
                  onChange={(event) => setChoice({ roomType: event.target.value })}
                >
                  <option value="">Select room type</option>
                  {draft.options.roomType.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <CopyButton label="Room type" roomLabel={roomLabel} value={choice.roomType} />
            </div>
            {textValue(request.ratePlan) ? (
              <CopyRow roomLabel={roomLabel} label="Rate code" value={textValue(request.ratePlan)} />
            ) : (
              <RoomTextField roomLabel={roomLabel} label="Rate code" value={choice.ratePlan} disabled={locked} maxLength={10} onChange={(value) => setChoice({ ratePlan: value.toUpperCase() })} />
            )}
            {typeof group?.quotedAmountMinor === 'number' || group?.rowPrice ? (
              <CopyRow
                roomLabel={roomLabel}
                label="Price"
                value={`R${((group.rowPrice?.amountMinor ?? group.quotedAmountMinor ?? 0) / 100).toFixed(2)}`}
              />
            ) : null}
            <CopyRow roomLabel={roomLabel} label="Meal plan" value={BOARD_LABELS[room.board ?? ''] ?? ''} />
            <RoomTextField
              roomLabel={roomLabel}
              label="Last name"
              value={choice.lastName}
              disabled={locked}
              maxLength={PANE_BOOKER_NAME_MAX}
              pii
              onChange={(value) => setChoice({ lastName: value })}
            />
            <RoomTextField
              roomLabel={roomLabel}
              label="First name"
              value={choice.firstName}
              disabled={locked}
              maxLength={PANE_BOOKER_NAME_MAX}
              pii
              onChange={(value) => setChoice({ firstName: value })}
            />
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
            <CopyRow
              roomLabel={roomLabel}
              label="Special requests"
              value={(group?.specialRequests ?? []).join('; ')}
            />
            <RoomTextField
              multiline
              roomLabel={roomLabel}
              label="Reservation note"
              value={choice.reservationNote}
              disabled={locked}
              maxLength={PANE_RESERVATION_NOTE_MAX}
              onChange={(value) => setChoice({ reservationNote: value })}
            />
            <RoomTextField
              roomLabel={roomLabel}
              label="Booker name"
              value={choice.bookerName}
              disabled={locked}
              maxLength={PANE_BOOKER_NAME_MAX}
              onChange={(value) => setChoice({ bookerName: value })}
            />
            <RoomTextField
              roomLabel={roomLabel}
              label="Booker contact (email)"
              value={choice.bookerEmail}
              disabled={locked}
              maxLength={PANE_BOOKER_EMAIL_MAX}
              onChange={(value) => setChoice({ bookerEmail: value })}
            />
            <CopyHmsNotesButton
              block={hmsNotesBlock({
                booker: choice.bookerName || contact?.name,
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
                        (choice.ratePlan || textValue(request.ratePlan) || group?.rateCode || group?.quotedRateCode),
                      nightlyMinor:
                        price ? [price.amountMinor] : group?.quotedAmountMinor != null ? [group.quotedAmountMinor] : undefined,
                      board: BOARD_LABELS[room.board ?? ''],
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
                missing={built.missing}
                save={saves[key] ?? {}}
                screenshot={client.screenshot}
                bookLabel={mode === 'on' ? BOOK_LABEL.on : BOOK_LABEL.lab}
                onPreview={(stay) => void previewRoom(key, client, stay)}
                onBook={(stay, previewDigest) => void bookRoom(key, client, stay, previewDigest)}
              />
            ) : null}
          </article>
        );
      })}
    </Section>
  );
}
