'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type {
  BookingDraftReady,
  BookingRateCheck,
  QuoteSession,
  RatePlanCatalogueEntry,
  QuotePaneConfig,
  StaffQuoteParties,
  StaffQuoteParty,
  StayGroupRequirement,
} from '@/lib/quote-workflow/types';
import { prefillReservationNote, reservationNoteForGroup } from '@/lib/quote-workflow/reservation-note';
import { HmsLinkActions } from './hms-link-actions';
import { HmsShotsViewer, visibleStayShots, type HmsShotRecord } from './hms-shots-viewer';
import { CopyHmsNotesButton, hmsNotesBlock } from './rate-controls';
import { rowRoomLabel } from '@/lib/quote-workflow/room-types';
import type { RecordFieldEventInput, StoredContact, StoredStayCommit } from '@/lib/quote-workflow/backend-bind';
import type { WorkItemPaneControls } from '@/lib/quote-workflow/use-work-item';
import { ContextualRateCheck, type PartyEvidence } from './contextual-rate-check';
import { recalledGuestName } from '@/lib/quote-workflow/guest-name-cache';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import { trackPaneAction } from '@/lib/quote-workflow/pane-telemetry';
import { subscribeStayingGuestName } from './quote-people-step';
import { usePaneStayPreview } from './use-pane-stay-preview';
import {
  commitOutcome,
  PANE_BOOKER_EMAIL_MAX,
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
  type PaneGuestCandidate,
  type PaneStayChoice,
  type PaneStayClient,
  type PaneStayBatch,
  type PaneStayInput,
  type PaneStayResult,
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

/** Search labels locally; only an explicit code selection becomes the booking rate. */
function CloudRatePicker({ value, plans, disabled, onChange, label = 'Rate plan', maxLength = 12, hint = 'HMS checks price and eligibility during review.' }: {
  value: string; plans: { code: string; name: string }[]; disabled: boolean; onChange: (code: string) => void;
  label?: string; maxLength?: number; hint?: string;
}) {
  const id = useId();
  const [search, setSearch] = useState(value);
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => { if (!openRef.current) setSearch(value); }, [value]);
  const input = search.trim();
  const code = input.toUpperCase();
  const validCode = /^[A-Z0-9]+$/.test(code) && code.length <= maxLength;
  const exact = plans.find((plan) => plan.code.toUpperCase() === code);
  const matches = plans.filter((plan) => `${plan.code} ${plan.name}`.toLocaleLowerCase().includes(input.toLocaleLowerCase()));
  const select = (selected: string) => { setSearch(selected); setOpen(false); onChange(selected); };
  return <div className="flex flex-col gap-1" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      const byName = plans.filter(plan => plan.name.toLocaleLowerCase() === input.toLocaleLowerCase());
      if (exact) select(exact.code);
      else if (byName.length === 1) select(byName[0]!.code);
      else if (validCode) select(code);
      else setOpen(false);
    }
  }}>
    <label htmlFor={id} className="text-xs font-semibold text-[#475569]">{label}</label>
    <input id={id} aria-label={label} aria-expanded={open} aria-controls={`${id}-rates`}
      className={paneFieldClass} disabled={disabled} value={search} placeholder="Search code or name"
      onFocus={() => setOpen(true)} onChange={(event) => {
        const next = event.target.value;
        const found = plans.find((plan) => plan.code.toUpperCase() === next.trim().toUpperCase());
        setSearch(next); setOpen(true); onChange(found?.code ?? '');
      }} onKeyDown={(event) => {
        if (event.key === 'Enter' && validCode) {
          event.preventDefault(); select(exact?.code ?? code);
        }
      }} />
    {open ? <ul id={`${id}-rates`} aria-label={label === 'Rate plan' ? 'Matching rate plans' : `Matching ${label.toLowerCase()} choices`} className="max-h-36 overflow-y-auto rounded-sm border border-[#cbd5e1] bg-white">
      {matches.map((plan) => <li key={plan.code}><button type="button" className="w-full px-2 py-1 text-left text-xs hover:bg-[#f1f5f9]"
        onClick={() => select(plan.code)}>{plan.code}{plan.name && plan.name !== plan.code ? ` · ${plan.name}` : ''}</button></li>)}
      {!exact && validCode ? <li><button type="button"
        className="w-full px-2 py-1 text-left text-xs hover:bg-[#f1f5f9]" onClick={() => select(code)}>Use {code} as a code</button></li> : null}
      {!matches.length && !validCode ? <li className="px-2 py-1 text-xs text-[#64748b]">No matching {label.toLowerCase()} choices</li> : null}
    </ul> : null}
    <span className="text-[11px] text-[#64748b]">{!open && exact && exact.name !== exact.code ? `${exact.name} · ` : ''}{hint}</span>
  </div>;
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
  cmsDefaults?: { bookingAgency: string; guest: string };
  ratePlans?: string[];
};
const WRITES_OFF_LABEL = 'Booking writes are off — create in HMS';
const LAB_WRITE_NOTE = 'This write is test-only. Book a real guest in HMS.';
const textareaClass =
  'outline-hidden w-full rounded-xs border border-[#cbd5e1] bg-white px-2 py-1 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]';

type CreateGuard = { expectedSeq: number; expectedExtractionId: string };
type PreviewView =
  | { status: 'running'; key: string; requestId: symbol }
  | { status: 'ready'; key: string; digest: string; runId?: string; screenshots: string[]; hmsPrice?: PaneStayResult['hmsPrice']; createGuard?: CreateGuard; editGeneration?: number }
  | { status: 'view_only'; key: string; runId?: string; screenshots: string[]; hmsPrice?: PaneStayResult['hmsPrice'] }
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
      hmsPrice?: PaneStayResult['hmsPrice'];
    }
  | {
      status: 'refused';
      key: string;
      message: string;
      runId?: string;
      screenshots?: string[];
      shots?: HmsShotRecord[];
      statusChip?: 'check';
      ambiguousStored?: boolean;
    };

type RoomSaveState = { preview?: PreviewView; commit?: CommitView };

type CloudCreateStop = {
  unknownStayId: string;
  targetKey: string;
  batchId?: string;
  members: Array<{ stayId: string; targetKey: string }>;
};
type RoomSnapshot = { roomKey: string; stayId: string; stay: PaneStayInput; digest: string; targetKey: string | null };

function uncertainCommit(commit: CommitView | undefined): boolean {
  return (commit?.status === 'refused' && commit.statusChip === 'check') ||
    (commit?.status === 'booked' && Boolean(commit.unverified));
}

// Match the server's Create target identity. This only controls the card; the server rechecks authority.
function cloudCreateTargetKey(stay: { firstName?: unknown; lastName?: unknown; arrival?: unknown; propertyCode?: unknown }, scope?: { propertyCode?: string | null; tenantId?: string }): string | null {
  const propertyCode = typeof stay.propertyCode === 'string' ? stay.propertyCode : scope?.propertyCode;
  if (!propertyCode || (scope?.propertyCode && propertyCode !== scope.propertyCode)) return null;
  if (typeof stay.firstName !== 'string' || typeof stay.lastName !== 'string' || typeof stay.arrival !== 'string') return null;
  const name = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  const first = name(stay.firstName), last = name(stay.lastName), arrival = stay.arrival;
  if (!first || !last || first.length > 256 || last.length > 256 || /[\p{Cc}]/u.test(first + last) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(arrival)) return null;
  const date = new Date(`${arrival}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== arrival) return null;
  return JSON.stringify([scope?.tenantId ?? null, propertyCode, 'create', first, last, arrival]);
}

function cloudStopsFromSaved(savedStays: Record<string, SavedStayCommit> | undefined, scope: { propertyCode?: string | null; tenantId?: string }): CloudCreateStop[] {
  return Object.entries(savedStays ?? {}).flatMap(([stayId, saved]) => {
    const hold = saved.status === 'unknown' || (saved.status === 'booked' && saved.confirmationNumber)
      ? saved.cloudCreateHold : undefined;
    if (!hold || hold.target?.propertyCode !== scope.propertyCode || hold.target.kind !== 'create') return [];
    const targetKey = cloudCreateTargetKey(hold.target, scope);
    if (!targetKey) return [];
    if (!hold.batch) return [{ unknownStayId: stayId, targetKey, members: [{ stayId, targetKey }] }];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(hold.batch.id) ||
        !Array.isArray(hold.batch.rooms) || hold.batch.rooms.length < 2 || hold.batch.rooms.length > 8) return [];
    const members: CloudCreateStop['members'] = [];
    for (const room of hold.batch.rooms) {
      if (!room || !/^[A-Za-z0-9_-]{1,120}$/.test(room.stayId) ||
          room.target?.propertyCode !== scope.propertyCode || room.target.kind !== 'create') return [];
      const memberTarget = cloudCreateTargetKey(room.target, scope);
      if (!memberTarget || members.some((member) => member.stayId === room.stayId)) return [];
      members.push({ stayId: room.stayId, targetKey: memberTarget });
    }
    if (!members.some((member) => member.stayId === stayId && member.targetKey === targetKey)) return [];
    return [{ unknownStayId: stayId, targetKey, batchId: hold.batch.id, members }];
  });
}

const cloudStopIdentity = (stop: CloudCreateStop) => JSON.stringify([stop.unknownStayId, stop.batchId ?? null]);

export type SavedStayCommit = {
  confirmationNumber: string | null;
  status: 'booked' | 'unknown';
  screenshotRef: { runId: string; name: string } | null;
  /** Durable before/saved shots from the work-item stay record. */
  runId?: string;
  shots?: HmsShotRecord[];
  cmsReason?: string;
  cloudCreateHold?: StoredStayCommit['cloudCreateHold'];
  cloudCreateTarget?: StoredStayCommit['cloudCreateTarget'];
};

function stayIdForRoom(
  room: { groupId: string; roomIndex: number },
  groups: StayGroupRequirement[],
): string {
  const group =
    groups.find((item) => item.id === room.groupId) ??
    groups.find((item) => `${item.arrivalDate ?? ''}:${item.departureDate ?? ''}` === room.groupId);
  return `room_${group?.id ?? room.groupId}_${room.roomIndex}`;
}

function legacyStayIdForRoom(room: { groupId: string; roomIndex: number }, groups: StayGroupRequirement[]): string {
  const group =
    groups.find((item) => item.id === room.groupId) ??
    groups.find((item) => `${item.arrivalDate ?? ''}:${item.departureDate ?? ''}` === room.groupId);
  const stay = group?.stayId ?? room.groupId;
  return `${stay}_${room.roomIndex}`;
}

function roomIds(room: { groupId: string; roomIndex: number }, groups: StayGroupRequirement[]): string[] {
  const group = groups.find((item) => item.id === room.groupId) ??
    groups.find((item) => `${item.arrivalDate ?? ''}:${item.departureDate ?? ''}` === room.groupId);
  const row = group?.id ?? room.groupId, stay = group?.stayId ?? room.groupId;
  const ids = [stayIdForRoom(room, groups), legacyStayIdForRoom(room, groups)];
  if (row === stay || row === `${stay}_row`) ids.push(`room_${stay}_${room.roomIndex}`, `room_${stay}_row_${room.roomIndex}`);
  return [...new Set(ids)];
}

function savedRoomMatch(
  room: BookingDraftReady['draft']['rooms'][number], draft: BookingDraftReady,
  groups: StayGroupRequirement[], savedStays: Record<string, SavedStayCommit> | undefined,
): { id: string | null; ambiguous: boolean } {
  const matches = roomIds(room, groups).filter((id) => savedStays && Object.hasOwn(savedStays, id));
  if (!matches.length) return { id: null, ambiguous: false };
  const ambiguous = matches.length !== 1 || matches.some((id) => {
    const claimants = new Set<string>();
    let duplicate = false;
    for (const candidate of draft.draft.rooms) {
      if (roomIds(candidate, groups).includes(id)) {
        const key = JSON.stringify([roomGroupFor(candidate, groups)?.id ?? candidate.groupId, candidate.roomIndex]);
        if (claimants.has(key)) duplicate = true;
        claimants.add(key);
      }
    }
    // Include other visible groups too, even if their draft belongs to another date card.
    const groupClaims = new Set<string>();
    for (const group of groups) {
      if (Number.isInteger(group.quantity) && (group.quantity as number) < room.roomIndex) continue;
      const candidate = { groupId: group.id, roomIndex: room.roomIndex };
      if (roomIds(candidate, groups).includes(id)) {
        const key = JSON.stringify([group.id, room.roomIndex]);
        if (groupClaims.has(key)) duplicate = true;
        groupClaims.add(key);
        claimants.add(key);
      }
    }
    return duplicate || claimants.size !== 1;
  });
  return { id: ambiguous ? null : matches[0]!, ambiguous };
}

/** Only apply a stored save when exactly one visible room claims its id. */
export function appliedSavedStayIds(
  draft: BookingDraftReady,
  groups: StayGroupRequirement[],
  savedStays: Record<string, SavedStayCommit> | undefined,
): string[] {
  if (!savedStays) return [];
  return draft.draft.rooms.flatMap((room) => {
    const { id } = savedRoomMatch(room, draft, groups, savedStays);
    return id ? [id] : [];
  });
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
  const saves: Record<string, RoomSaveState> = {};
  for (const room of draft.draft.rooms) {
    const { id, ambiguous } = savedRoomMatch(room, draft, groups, savedStays);
    const saved = id ? savedStays[id] : undefined;
    if (saved) saves[`${room.groupId}:${room.roomIndex}`] = { commit: commitViewFromSaved(saved, room.request) };
    else if (ambiguous) saves[`${room.groupId}:${room.roomIndex}`] = { commit: {
      status: 'refused', key: '', statusChip: 'check', ambiguousStored: true,
      message: 'A previous booking could match this room. Check HMS before booking.',
    } };
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
  previewOnly = false,
  batchOnly = false,
  frozen = false,
  approvalRequired = false,
  onPreview,
  onBook,
}: {
  stay: PaneStayInput | null;
  previewKey: string | null;
  missing: string[];
  save: RoomSaveState;
  screenshot: PaneStayClient['screenshot'];
  bookLabel: string;
  previewOnly?: boolean;
  batchOnly?: boolean;
  frozen?: boolean;
  approvalRequired?: boolean;
  onPreview: (stay: PaneStayInput) => void;
  onBook: (stay: PaneStayInput, previewDigest: string) => void;
}) {
  const { preview, commit } = save;
  const noRetry = commit?.status === 'refused' && commit.statusChip === 'check';
  const busy = frozen || preview?.status === 'running' || commit?.status === 'running';
  const fresh = stay && preview?.status === 'ready' && preview.key === previewKey && !approvalRequired ? preview : null;
  const viewOnly = stay && preview?.status === 'view_only' && preview.key === previewKey ? preview : null;
  const changed =
    preview?.status === 'stale' || (approvalRequired && preview?.status === 'ready') ||
    ((preview?.status === 'running' || preview?.status === 'ready' || preview?.status === 'view_only') && preview.key !== previewKey);

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
          {commit.unverified ? 'Check HMS' : 'Booked'}
        </span>
        <p data-pii className="text-[12.5px] font-semibold text-emerald-800">
          {commit.cmsMismatch
            ? PANE_CMS_MISMATCH_COPY
            : commit.unverified
            ? PANE_SAVE_UNVERIFIED_COPY
            : `Booked in HMS – confirmation ${commit.confirmationNumber}`}
        </p>
        {commit.hmsPrice ? (
          <p className="text-[12px] font-semibold text-[#1e293b]">
            Saved HMS average: {commit.hmsPrice.averageRate} · total: {commit.hmsPrice.totalRate} · {commit.hmsPrice.currency ?? 'Currency unavailable'}
          </p>
        ) : stay?.createSelection ? <p className="text-[11px] text-[#64748b]">Saved price unavailable. Check HMS.</p> : null}
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
            caption="See what Nava saved in HMS"
            runId={commit.runId}
            name={savedShot}
            screenshot={screenshot}
          />
        ) : null}
      </div>
    );
  }

  const displayed = viewOnly ?? fresh;
  const previewShot = displayed?.runId ? pickScreenshot(displayed.screenshots, PREVIEW_SHOT) : null;
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
      {displayed && stay && displayed.runId && previewShot ? (
        <PaneScreenshot
          caption="See what Nava filled in HMS"
          runId={displayed.runId}
          name={previewShot}
          screenshot={screenshot}
        />
      ) : null}
      {displayed && stay ? (
        <p data-pii className="text-[12px] text-[#1e293b]">
          {viewOnly
            ? `Preview only: ${stay.firstName} ${stay.lastName}, ${stay.arrival} – ${stay.departure}, 1 room, rate ${stay.ratePlan}. Nothing was saved. Booking from Nava is not available yet.`
            : `Nava will book ${stay.firstName} ${stay.lastName} for ${stay.arrival} – ${stay.departure}, 1 room, rate ${stay.ratePlan}. Nothing is saved until you press ${bookLabel}.`}
        </p>
      ) : null}
      {displayed?.hmsPrice ? (
        <p className="text-[12px] font-semibold text-[#1e293b]">
          HMS average: {displayed.hmsPrice.averageRate} · total: {displayed.hmsPrice.totalRate} · {displayed.hmsPrice.currency ?? 'Currency unavailable'}
        </p>
      ) : null}
      {displayed && stay?.createSelection?.nativeGuestId ? (
        <dl aria-label="Reviewed booking details" data-pii className="grid grid-cols-2 gap-x-3 text-[11px] text-[#475569]">
          {[
            ['Guest profile', `${stay.firstName} ${stay.lastName} · #${stay.createSelection.nativeGuestId}`],
            ['Guests', `${stay.adults} adult(s); child ages: ${stay.childAges?.join(', ') || 'none'}`],
            ['Room and rate', `${stay.roomType} · ${stay.ratePlan} · ${stay.track}`],
            ['Source and guarantee', `${stay.sourceOfBusiness} · ${stay.guaranteeType}`],
            ['Agency', stay.bookingAgency ? `${stay.bookingAgency.name} · #${stay.bookingAgency.nativeId}` : 'None'],
            ['Company', stay.organization ? `${stay.organization.name} · #${stay.organization.nativeId}` : 'None'],
            ['Booker', [stay.bookerName, stay.bookerEmail].filter(Boolean).join(' · ') || 'None'],
            ['Confirmation', `${stay.cmsMessageId ?? 'None'} · ${stay.confirmationRecipient?.address ?? 'No recipient'} · Send ${stay.confirmationSendMail ? 'on' : 'off'}`],
            ['Reservation note', stay.reservationNote ?? 'None'],
          ].map(([label, value]) => <div key={label}><dt className="font-semibold">{label}</dt><dd>{value}</dd></div>)}
        </dl>
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
              Check HMS
            </span>
          ) : null}
          <p role="alert" className="text-[11.5px] text-amber-900">
            {commit.message}
          </p>
          {commit.runId && (commit.shots?.length ?? 0) > 0 ? (
            <HmsShotsViewer key={commit.runId} runId={commit.runId} shots={commit.shots ?? []} screenshot={screenshot} />
          ) : commit.runId && refusedShot ? (
            <PaneScreenshot
              caption="See what Nava saved in HMS"
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
          disabled={previewOnly || batchOnly || !fresh || busy}
          disabledReason={previewOnly || viewOnly ? 'Booking from Nava is not available yet' : batchOnly ? 'Use Book this stay below' : !stay || busy ? null : 'Preview in HMS first'}
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
  nativeGuestId?: string;
  bookerName?: string;
  bookerEmail?: string;
};

type CreateRoomProjection = {
  rowId: string; roomIndex: number; firstName: string | null; lastName: string | null;
  guestProfile: { nativeId: string; firstName: string; lastName: string } | null;
  adults: number | null; childAges: number[] | null; roomType: string | null; ratePlan: string | null;
  bookingAgency: { nativeId: string; name: string } | null; organization: { nativeId: string; name: string } | null;
  sourceAgencyName?: string | null; sourceOrganizationName?: string | null;
  sourceOfBusiness: string | null; track: string | null; guaranteeType: string | null; reservationNote: string | null;
  bookerName: string | null; bookerEmail: string | null;
  cms: { send: boolean | null; messageId: string | null; recipient: { mode: 'self' | 'client' | 'custom'; address: string } | null };
};

function createRoomBinding(room: BookingDraftReady['draft']['rooms'][number], groups: StayGroupRequirement[],
  pane: WorkItemPaneControls | null | undefined, session: QuoteSession | undefined) {
  const snapshot = pane?.requestDraft?.snapshot;
  const source = snapshot?.source;
  const group = roomGroupFor(room, groups);
  const ref = pane?.refs[room.groupId] ?? (group?.stayId ? { stayId: group.stayId, rowId: group.id } : undefined);
  const rowId = ref?.rowId ?? (ref?.stayId ? `${ref.stayId}_row` : null);
  if (!snapshot || !source || !session?.staffSource || source.threadId !== session.staffSource.threadId ||
      source.messageId !== session.staffSource.messageId || source.sourceHash !== session.staffSource.sourceHash ||
      !ref || !rowId || (group?.stayId && group.stayId !== ref.stayId) || room.roomIndex < 1 || room.roomIndex > 8) return null;
  const requests = snapshot.requests.filter((request) => request.stayId === ref.stayId && request.action === 'new_booking' &&
    request.workflow === 'create' && request.status === 'pending' && request.fields?.kind === 'create');
  const request = requests[0];
  const rooms = request?.fields?.value;
  const index = room.roomIndex - 1;
  if (!requests.length) {
    // Booking from an existing quote still uses the deterministic Create route and its source/revision guard.
    const quotes = snapshot.requests.filter((item) => item.stayId === ref.stayId && item.action === 'quote_availability' &&
      item.workflow === 'quote' && item.status === 'pending' && item.fields?.kind === 'quote');
    const quote = quotes[0];
    const quoteFields = quote?.fields?.value as { rows?: Array<{ rowId?: string }> } | undefined;
    if (quotes.length !== 1 || !quote || !quoteFields?.rows?.some((row) => row.rowId === rowId)) return null;
    const value: CreateRoomProjection = { rowId, roomIndex: index, firstName: null, lastName: null, guestProfile: null,
      adults: null, childAges: null, roomType: null, ratePlan: null, bookingAgency: null, organization: null,
      sourceOfBusiness: null, track: null, guaranteeType: null, reservationNote: null, bookerName: null,
      bookerEmail: null, cms: { send: null, messageId: null, recipient: null } };
    return { requestId: quote.requestId, rowId, roomIndex: index, prefix: `rows[${rowId}].rooms[${index}]`, value, writable: false };
  }
  if (requests.length !== 1 || !request || !Array.isArray(rooms)) return null;
  const values = rooms.filter((value: unknown) => value && typeof value === 'object' &&
    (value as { rowId?: unknown }).rowId === rowId && (value as { roomIndex?: unknown }).roomIndex === index);
  if (values.length !== 1) return null;
  return { requestId: request.requestId, rowId, roomIndex: index,
    prefix: `rows[${rowId}].rooms[${index}]`, value: values[0] as CreateRoomProjection, writable: true };
}

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

function inheritedChildAges(room: BookingDraftReady['draft']['rooms'][number], group?: StayGroupRequirement): unknown {
  const ages = group?.childrenAges ?? room.request.childAges;
  if (group?.fields.childAges === 'missing') return null;
  return ages;
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
      : inheritedChildAges(room, group),
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
    bookerName: choice.bookerName ?? (contact ? textValue(contact.name) : textValue(room.request.bookerName)),
    bookerEmail: choice.bookerEmail ?? (contact ? textValue(contact.email) : textValue(room.request.bookerEmail)),
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
    else if (field === 'guestoptin4' && typeof choice.guestoptin4 !== 'boolean') missing.push('Terms');
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
        {confirmed ? 'Booked' : 'Check HMS'}
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
            : 'HMS may have saved this booking. Check HMS before trying again.'}
        </p>
      )}
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
  configuration,
  rateCatalogue = [],
  workItemPane,
  rateEvidence,
  partyFieldEdited,
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
  configuration?: QuotePaneConfig | null;
  rateCatalogue?: RatePlanCatalogueEntry[];
  workItemPane?: WorkItemPaneControls | null;
  rateEvidence?: PartyEvidence;
  partyFieldEdited?: { bookingAgency: boolean; organization: boolean };
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
  const requiredCreateFields = [...(draft.options.requiredCreateFields ?? []),
    ...(configuration?.formPolicy?.guestOptIn === 'required' ? ['guestoptin4'] : [])];
  // off keeps the card copy-only. A client whose mode is not read yet is labelled as lab, the narrower mode.
  const reportedMode = client?.mode?.() ?? null;
  const mode: PaneSaveMode = client ? (reportedMode ?? 'lab') : 'off';
  const capability = configuration && configuration.propertyCode === propertyCode ? configuration.capabilities?.create : undefined;
  const backendLegacyEnabled = reportedMode === 'lab' || reportedMode === 'on';
  const legacyScoped = propertyCode === 'HRCEN' && configuration === undefined &&
    (backendLegacyEnabled || Boolean(client?.canPreview?.()));
  const prepareAllowed = capability ? ['prepare-only', 'lab', 'staff-enabled'].includes(capability.status) : legacyScoped;
  const saveAllowed = capability ? capability.status === 'lab' || capability.status === 'staff-enabled' :
    legacyScoped && backendLegacyEnabled;
  const legacyUnscoped = propertyCode == null && configuration === undefined && backendLegacyEnabled && !client?.canPreview?.();
  const savesOn = mode !== 'off' && (saveAllowed || legacyUnscoped);
  const cloudPreview = Boolean(client?.canPreview?.() && prepareAllowed);
  const cloudCreate = cloudPreview || propertyCode === 'HRCEN';
  const createScope = { propertyCode, tenantId: configuration?.tenantId };
  const scopedPreviewInputKey = (stay: PaneStayInput) => JSON.stringify([
    configuration?.transportId ?? session?.binding?.transportId ?? null, createScope.tenantId ?? null,
    propertyCode ?? null, session?.binding?.scopeEpoch ?? null, session?.binding?.selectionEpoch ?? null, paneStayKey(stay),
  ]);
  const requireDurableCreate = cloudCreate && workItemPane !== undefined;
  const rateReadProperty = configuration
    ? configuration.propertyCode === propertyCode && configuration.transportId === workItemPane?.rateDraft?.transportId
      ? configuration.propertyCode : null
    : configuration === undefined && propertyCode === 'HRCEN' ? 'HRCEN' : null;
  const previewsOn = cloudPreview || savesOn;
  const selectedGuestName = useSyncExternalStore(
    subscribeStayingGuestName,
    () => readSelectedGuestName(guestEditorKey, guestName),
    () => readSelectedGuestName(guestEditorKey, guestName),
  );
  const guestSplit = splitStayingGuestName(selectedGuestName);
  const previousSelectedGuestName = useRef(selectedGuestName);
  const guestNamesEdited = useRef<Record<string, boolean>>({});
  const reservationNoteDirty = useRef<Record<string, boolean>>({});
  const organizationEdited = useRef<Record<string, boolean>>({});
  const [choices, setChoices] = useState<Record<string, RoomChoice>>(
    () =>
      Object.fromEntries(
        draft.draft.rooms.map((room) => {
          const key = `${room.groupId}:${room.roomIndex}`;
          const binding = createRoomBinding(room, groups, workItemPane, session);
          const fieldStaff = (field: string) => binding && (
            workItemPane?.requestDraft?.snapshot?.fieldMeta[`requests[${binding.requestId}].${binding.prefix}.${field}`]?.origin === 'staff' ||
            workItemPane?.requestDraft?.snapshot?.fieldMeta[`requests[${binding.requestId}].${field}`]?.origin === 'staff');
          const savedField = (field: string, projected: unknown, fallback: unknown) => {
            if (!binding) return fallback;
            const suffix = `${binding.prefix}.${field}`;
            const held = workItemPane?.requestDraft?.held(binding.requestId, suffix);
            if (held) return held.value;
            return projected !== null && projected !== undefined || fieldStaff(field)
              ? projected : fallback;
          };
          const names = namesFromSelectedGuest(
            readSelectedGuestName(guestEditorKey, guestName),
            room.request,
          );
          const savedId = savedRoomMatch(room, draft, groups, savedStays).id;
          const saved = savedId ? savedStays?.[savedId] : undefined;
          const savedTarget = saved?.status === 'booked' ? saved.cloudCreateTarget : undefined;
          const existingNote = textValue(room.request.reservationNote);
          const projected = binding?.value;
          const firstName = textValue(savedField('firstName', projected?.firstName, savedTarget?.firstName ?? names.firstName));
          const lastName = textValue(savedField('lastName', projected?.lastName, savedTarget?.lastName ?? names.lastName));
          if (binding && (fieldStaff('firstName') || fieldStaff('lastName') ||
            workItemPane?.requestDraft?.held(binding.requestId, `${binding.prefix}.firstName`) ||
            workItemPane?.requestDraft?.held(binding.requestId, `${binding.prefix}.lastName`))) guestNamesEdited.current[key] = true;
          if (binding && (fieldStaff('reservationNote') ||
            workItemPane?.requestDraft?.held(binding.requestId, `${binding.prefix}.reservationNote`))) reservationNoteDirty.current[key] = true;
          const agency = savedField('parties.bookingAgency', projected?.bookingAgency, null);
          const agencyWasChosen = binding && (fieldStaff('parties.bookingAgency') ||
            workItemPane?.requestDraft?.held(binding.requestId, `${binding.prefix}.parties.bookingAgency`));
          if (binding && (fieldStaff('parties.organization') ||
            workItemPane?.requestDraft?.held(binding.requestId, `${binding.prefix}.parties.organization`))) organizationEdited.current[key] = true;
          const choice: RoomChoice = {
            track: textValue(savedField('track', projected?.track, room.request.track)),
            sourceOfBusiness: textValue(savedField('sourceOfBusiness', projected?.sourceOfBusiness, initialSourceOfBusiness(
              room.request.sourceOfBusiness,
              draft.options.sourceOfBusiness,
            ))),
            marketSegment: '',
            // Guest consent must come from an explicit staff action, never from mail or a hotel default.
            guestoptin4: false,
            guaranteeType: textValue(savedField('guaranteeType', projected?.guaranteeType, room.request.guaranteeType)),
            firstName,
            lastName,
            bookingAgency: agency && typeof agency === 'object' && 'nativeId' in agency
              ? !parties?.bookingAgency || agency.nativeId === parties.bookingAgency.nativeId ? '__bound__' : '__unresolved__'
              : agencyWasChosen ? '__none__' : '',
            organization: textValue((() => {
              const value = savedField('parties.organization', projected?.organization,
                textValue(projected?.sourceOrganizationName) || textValue(room.request.organization) || pickedName(parties?.organization));
              return value && typeof value === 'object' && 'name' in value ? value.name : value;
            })()),
            reservationNote: textValue(savedField('reservationNote', projected?.reservationNote, existingNote)),
          };
          const roomType = savedField('roomTypeCode', projected?.roomType, undefined);
          const ratePlan = savedField('ratePlan', projected?.ratePlan, undefined);
          const adults = savedField('adults', projected?.adults, undefined);
          const childAges = savedField('childAges', projected?.childAges, undefined);
          if (typeof roomType === 'string' || roomType === null) choice.roomType = textValue(roomType);
          if (typeof ratePlan === 'string' || ratePlan === null) choice.ratePlan = textValue(ratePlan);
          if (typeof adults === 'number') choice.adults = String(adults);
          if (typeof adults === 'string' || adults === null) choice.adults = textValue(adults);
          if (Array.isArray(childAges)) choice.childAges = childAges.map(String);
          if (typeof childAges === 'string') choice.childAges = childAges.split('|');
          if (projected?.guestProfile?.nativeId) choice.nativeGuestId = projected.guestProfile.nativeId;
          for (const field of ['bookerName', 'bookerEmail'] as const) {
            const value = savedField(field, projected?.[field], undefined);
            if (value !== undefined) choice[field] = textValue(value);
          }
          const generated = generatedNoteForChoice(session, propertyCode, room, roomGroupFor(room, groups), choice);
          const hadNote = Boolean(choice.reservationNote.trim());
          choice.reservationNote = prefillReservationNote(choice.reservationNote, generated, reservationNoteDirty.current[key] === true);
          if (!hadNote && generated && !reservationNoteDirty.current[key]) choice.generatedReservationNote = generated;
          return [key, choice];
        }),
      ),
  );
  const [guestCandidates, setGuestCandidates] = useState<Record<string, PaneGuestCandidate[]>>({});
  const [guestSearch, setGuestSearch] = useState<Record<string, { key: string; status: 'running' | 'ready' | 'unavailable'; partial?: boolean }>>({});
  const guestSearchContext = useRef<Record<string, string>>({});
  const guestSearchGeneration = useRef<Record<string, number>>({});
  const guestSearchMounted = useRef(true);
  useEffect(() => { guestSearchMounted.current = true; return () => { guestSearchMounted.current = false; }; }, []);
  useEffect(() => {
    setChoices((current) => {
      let next: typeof current | undefined;
      for (const room of draft.draft.rooms) {
        const key = `${room.groupId}:${room.roomIndex}`;
        const existing = current[key];
        if (organizationEdited.current[key] || !existing) continue;
        const projected = createRoomBinding(room, groups, workItemPane, session)?.value;
        const label = pickedName(parties?.organization) || projected?.organization?.name || projected?.sourceOrganizationName;
        if (label && existing.organization !== label) {
          next ??= { ...current };
          next[key] = { ...existing, organization: label };
        }
      }
      return next ?? current;
    });
  }, [draft, groups, workItemPane, session, parties?.organization]);

  const [localSaves, setSaves] = useState<Record<string, RoomSaveState>>(() =>
    savesFromSavedStays(draft, groups, savedStays),
  );
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
  useEffect(() => {
    setSaves((current) => {
      let next: typeof current | undefined;
      for (const [key, stored] of Object.entries(savesFromSavedStays(draft, groups, savedStays))) {
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
  // These snapshots belong to the original Go, not to the editable room form.
  const [localCloudStops, setCloudStops] = useState<CloudCreateStop[]>([]);
  const seenCloudStops = useRef(new Set<string>());
  const partialCloudRoomsRef = useRef(new Set<string>());
  const cloudApprovalEpoch = useRef<Record<string, number>>({});
  const cloudFreshPreviews = useRef<Record<string, { key: string; epoch: number }>>({});
  const createRevision = { cursor: workItemPane?.bindingCursor ?? null, editGeneration: workItemPane?.editGeneration ?? 0,
    pending: Boolean(workItemPane?.requestDraft?.pending || workItemPane?.bindingPending) };
  const createRevisionRef = useRef(createRevision);
  createRevisionRef.current = createRevision;
  const options = draft.options as BookingOptions;
  const cmsOptions = options.cmsMessageIds?.length ? options.cmsMessageIds : CMS_FALLBACK;
  const cmsBindings = draft.draft.rooms.map((room) => createRoomBinding(room, groups, workItemPane, session));
  const allCmsBound = cmsBindings.length > 0 && cmsBindings.every(Boolean);
  const cmsValues = (field: 'send' | 'messageId' | 'recipient') => cmsBindings.map((binding) => {
    if (!binding) return null;
    const held = workItemPane?.requestDraft?.held(binding.requestId, `${binding.prefix}.cms.${field}`);
    return held ? held.value : binding.value.cms?.[field] ?? null;
  });
  const initialCmsValues = { send: cmsValues('send'), messageId: cmsValues('messageId'), recipient: cmsValues('recipient') };
  const commonCms = (values: unknown[]) => values.length && values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]))
    ? values[0] : null;
  const mixedCms = (values: unknown[]) => allCmsBound && new Set(values.map((value) => JSON.stringify(value))).size > 1;
  const savedCmsSend = commonCms(initialCmsValues.send);
  const savedCmsMessage = commonCms(initialCmsValues.messageId);
  const rawCmsRecipient = commonCms(initialCmsValues.recipient);
  const savedCmsRecipient = rawCmsRecipient && typeof rawCmsRecipient === 'object' && 'mode' in rawCmsRecipient &&
    (rawCmsRecipient.mode === 'self' || rawCmsRecipient.mode === 'client' || rawCmsRecipient.mode === 'custom') &&
    'address' in rawCmsRecipient && typeof rawCmsRecipient.address === 'string'
    ? rawCmsRecipient as { mode: ConfirmationMode; address: string } : null;
  const [cmsMixed, setCmsMixed] = useState(() => ({ send: mixedCms(initialCmsValues.send),
    messageId: mixedCms(initialCmsValues.messageId), recipient: mixedCms(initialCmsValues.recipient) }));
  const [sendConfirmation, setSendConfirmation] = useState(typeof savedCmsSend === 'boolean' ? savedCmsSend : true);
  const labtestOnly = draft.draft.rooms.length > 0 && draft.draft.rooms.every((room) => {
    const choice = choices[`${room.groupId}:${room.roomIndex}`];
    return textValue(choice?.firstName).trim().toLowerCase() === 'proof' && textValue(choice?.lastName).trim().toLowerCase() === 'labtest';
  });
  const sendHmsConfirmation = labtestOnly ? false : sendConfirmation;
  const [chosenCmsMessage, setChosenCmsMessage] = useState<string | null>(typeof savedCmsMessage === 'string' ? savedCmsMessage : null);
  const hasBoundParty = Boolean(pickedName(parties?.bookingAgency) || pickedName(parties?.organization));
  const defaultCmsMessage = hasBoundParty ? (options.cmsDefaults?.bookingAgency ?? '03') : (options.cmsDefaults?.guest ?? '01');
  const cmsMessage = chosenCmsMessage ?? defaultCmsMessage;
  const contextConfirmation = useConfirmationSources();
  const sources = confirmation === undefined ? contextConfirmation : confirmation;
  const [recipientMode, setRecipientMode] = useState<ConfirmationMode>(savedCmsRecipient?.mode ?? sources?.setting?.mode ?? 'self');
  const [customAddress, setCustomAddress] = useState(
    savedCmsRecipient?.mode === 'custom' ? savedCmsRecipient.address :
      sources?.setting?.mode === 'custom' ? (sources.setting.address ?? '') : '',
  );
  const [staffChose, setStaffChose] = useState(Boolean(savedCmsRecipient));
  const [defaultSaved, setDefaultSaved] = useState(false);
  const [defaultError, setDefaultError] = useState<string | null>(null);
  const [savingDefault, setSavingDefault] = useState(false);
  const saveGeneration = useRef(0);
  const staffChoseRef = useRef(Boolean(savedCmsRecipient));
  const signedInUserId = sources?.userId ?? '';
  const signedInMailbox = sources?.mailbox ?? '';
  const scopeKey = confirmationScopeKey(signedInUserId, signedInMailbox);
  const scopeRef = useRef({ userId: signedInUserId, mailbox: signedInMailbox });
  scopeRef.current = { userId: signedInUserId, mailbox: signedInMailbox };
  const lastConfirmationIdentity = useRef({ userId: signedInUserId, mailbox: signedInMailbox });
  const [seenScope, setSeenScope] = useState(`${scopeKey}\0${sources?.userEmail ?? ''}`);
  if (sources && seenScope !== `${scopeKey}\0${sources.userEmail}`) {
    setSeenScope(`${scopeKey}\0${sources.userEmail}`);
    const prior = lastConfirmationIdentity.current;
    const sameIdentity = (!prior.userId || !signedInUserId || prior.userId === signedInUserId) &&
      (!prior.mailbox || !signedInMailbox || prior.mailbox === signedInMailbox);
    lastConfirmationIdentity.current = { userId: signedInUserId, mailbox: signedInMailbox };
    setDefaultSaved(false);
    setDefaultError(null);
    setSavingDefault(false);
    if (!sameIdentity || !staffChoseRef.current) {
      staffChoseRef.current = false;
      setStaffChose(false);
      setRecipientMode(sources.setting?.mode ?? 'self');
      setCustomAddress(sources.setting?.mode === 'custom' ? (sources.setting.address ?? '') : '');
    }
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
  const recordCms = (field: 'send' | 'messageId' | 'recipient', value: Parameters<NonNullable<WorkItemPaneControls['requestDraft']>['record']>[2], valid = true) => {
    if (!requireDurableCreate || !workItemPane?.requestDraft) return;
    for (const binding of cmsBindings) if (binding) {
      const previous = binding.value.cms?.[field] ?? null;
      if (!workItemPane.requestDraft.held(binding.requestId, `${binding.prefix}.cms.${field}`) &&
          JSON.stringify(previous) === JSON.stringify(value) && valid) continue;
      workItemPane.requestDraft.record(binding.requestId, `${binding.prefix}.cms.${field}`, value, valid);
    }
  };
  const recordRecipient = (mode: ConfirmationMode, address: string) => {
    const selectedClientEmail = contact ? textValue(contact.email) : textValue(draft.draft.rooms[0]?.request.bookerEmail);
    const result = resolveConfirmationRecipient({ mode, customAddress: address, userEmail: sources?.userEmail ?? '',
      clientEmail: selectedClientEmail, invalidSetting: sources?.invalidSetting, staffChose: true });
    const pendingAddress = mode === 'custom' ? address : mode === 'self' ? sources?.userEmail ?? '' : selectedClientEmail;
    recordCms('recipient', result.ok ? result.recipient : { mode, address: pendingAddress }, result.ok);
  };
  const recipientSync = useRef('');
  useEffect(() => {
    if (!requireDurableCreate || !staffChose || !allCmsBound) return;
    const key = JSON.stringify([workItemId, session?.staffSource, effectiveRecipientMode, customAddress, clientEmail, sources?.userEmail]);
    if (recipientSync.current === key) return;
    recipientSync.current = key;
    recordRecipient(effectiveRecipientMode, customAddress);
  }, [requireDurableCreate, staffChose, allCmsBound, workItemId, session?.staffSource,
    effectiveRecipientMode, customAddress, clientEmail, sources?.userEmail]);
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
        if (!selectedGuestChanged || guestNamesEdited.current[key] || !selectedGuestName.trim()) continue;
        const projected = createRoomBinding(room, groups, workItemPane, session)?.value;
        if ((!guestEditorKey || recalledGuestName(guestEditorKey) === null) &&
            (projected?.firstName != null || projected?.lastName != null)) continue;
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
          nativeGuestId: undefined,
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

  function patchSave(roomKey: string, patch: RoomSaveState) {
    setSaves((current) => {
      if (savedOutcomeBlocksRoom(roomKey)) return current;
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
    if (savedOutcomeBlocksRoom(roomKey)) return;
    const inputKey = scopedPreviewInputKey(stay);
    const input = previewInputsRef.current[roomKey];
    if (!input?.key || input.inputKey !== inputKey) return;
    const { stayId } = input;
    const key = input.key;
    const approvalEpoch = cloudApprovalEpoch.current[roomKey] ?? 0;
    const editGeneration = createRevisionRef.current.editGeneration;
    delete cloudFreshPreviews.current[roomKey];
    const requestId = Symbol();
    const generation = previewReceipt.begin(workItemId, stayId, inputKey);
    patchSave(roomKey, { preview: { status: 'running', key, requestId }, commit: undefined });
    let createGuard: CreateGuard | undefined;
    if (requireDurableCreate) {
      const queue = workItemPane?.requestDraft;
      // Every room shares the WorkItem cursor. Save all of their defaults before
      // issuing any preview, so preparing a later room does not invalidate an earlier grant.
      const rooms = draft.draft.rooms.filter((room) => !savedOutcomeBlocksRoom(roomKeyOf(room)));
      const inputs = rooms.map((room) => ({ room, stay: roomBuilt(room).stay,
        binding: createRoomBinding(room, groups, workItemPane, session), input: previewInputsRef.current[roomKeyOf(room)] }));
      // A profile choice also advances that shared cursor. Allow an unselected room
      // to search through Preview, but do not grant another room until all are chosen.
      if (stay.createSelection?.nativeGuestId && inputs.some((item) => item.binding?.writable &&
          !item.stay?.createSelection?.nativeGuestId)) {
        previewReceipt.finish(workItemId, stayId, inputKey, generation);
        finishPreviewIfRunning(roomKey, requestId, { status: 'refused', key,
          message: 'Choose an existing guest profile for every room before previewing.' });
        return;
      }
      const currentInputs = inputs.every(({ room, input }) => input?.key &&
        previewInputsRef.current[roomKeyOf(room)]?.key === input.key);
      let accepted = Boolean(queue && currentInputs && inputs.length && inputs.every(({ stay, binding }) => stay && binding));
      const party = (value: PaneStayInput['bookingAgency']) => value?.nativeId ? { nativeId: value.nativeId, name: value.name } : null;
      if (accepted && queue) for (const item of inputs) {
        const binding = item.binding!, roomStay = item.stay!;
        if (!binding.writable) continue;
        const profile = roomStay.createSelection?.nativeGuestId ? { nativeId: roomStay.createSelection.nativeGuestId,
          firstName: roomStay.firstName, lastName: roomStay.lastName } : null;
        const values: Array<[string, unknown, RecordFieldEventInput['value'], boolean?]> = [
          ['firstName', binding.value.firstName, roomStay.firstName], ['lastName', binding.value.lastName, roomStay.lastName],
          ['guest.profile', binding.value.guestProfile, profile], ['adults', binding.value.adults, roomStay.adults, roomStay.adults >= 1 && roomStay.adults <= 9],
          ['childAges', binding.value.childAges, roomStay.childAges ?? [], (roomStay.childAges ?? []).length <= 9],
          ['roomTypeCode', binding.value.roomType, roomStay.roomType, /^[A-Z0-9]{1,12}$/.test(roomStay.roomType)],
          ['ratePlan', binding.value.ratePlan, roomStay.ratePlan, /^[A-Z0-9]{1,12}$/.test(roomStay.ratePlan)],
          ['parties.bookingAgency', binding.value.bookingAgency, party(roomStay.bookingAgency)],
          ['parties.organization', binding.value.organization, party(roomStay.organization)],
          ['sourceOfBusiness', binding.value.sourceOfBusiness, roomStay.sourceOfBusiness || null],
          ['track', binding.value.track, roomStay.track || null], ['guaranteeType', binding.value.guaranteeType, roomStay.guaranteeType || null],
          ['reservationNote', binding.value.reservationNote, roomStay.reservationNote || null],
          ['bookerName', binding.value.bookerName, roomStay.bookerName || null], ['bookerEmail', binding.value.bookerEmail, roomStay.bookerEmail || null],
          ['cms.send', binding.value.cms?.send, Boolean(roomStay.confirmationSendMail)],
          ...(roomStay.confirmationSendMail ? [
            ['cms.messageId', binding.value.cms?.messageId, roomStay.cmsMessageId || null] as [string, unknown, RecordFieldEventInput['value']],
            ['cms.recipient', binding.value.cms?.recipient, roomStay.confirmationRecipient ?? null] as [string, unknown, RecordFieldEventInput['value']],
          ] : []),
        ];
        for (const [field, prior, value, valid = true] of values) {
          const suffix = `${binding.prefix}.${field}`;
          if (queue.held(binding.requestId, suffix) || JSON.stringify(prior ?? null) !== JSON.stringify(value ?? null)) {
            accepted = queue.record(binding.requestId, suffix, value, valid) && accepted;
          }
        }
      }
      const cursor = accepted && queue ? await queue.flush().catch(() => null) : null;
      if (!cursor || inputs.some(({ room, input }) => previewInputsRef.current[roomKeyOf(room)]?.key !== input?.key) ||
          previewInputsRef.current[roomKey]?.key !== key || createRevisionRef.current.editGeneration !== editGeneration) {
        previewReceipt.finish(workItemId, stayId, inputKey, generation);
        finishPreviewIfRunning(roomKey, requestId, { status: 'refused', key,
          message: 'Complete and save the booking details for every room before previewing.' });
        return;
      }
      createGuard = { expectedSeq: cursor.seq, expectedExtractionId: queue!.snapshot!.source.extractionId };
    }
    let preview: Exclude<PreviewView, { status: 'running' }>;
    try {
      const selected = createGuard && stay.createSelection ? { ...stay,
        createSelection: { ...stay.createSelection, ...createGuard } } : stay;
      const previewInput = workItemId ? { ...selected, stayId, workItemId } : selected;
      const result = await pane.preview(previewInput);
      if ((result.reason === 'guest_choice_required' || result.reason === 'guest_not_found') &&
          Array.isArray(result.guestCandidates) &&
          previewInputsRef.current[roomKey]?.key === key) {
        setGuestCandidates((current) => ({ ...current, [roomKey]: result.guestCandidates! }));
      }
      const outcome = previewOutcome(result);
      const noMatchingGuestProfile =
        result.reason === 'guest_not_found' &&
        Array.isArray(result.guestCandidates) &&
        result.guestCandidates.length === 0;
      preview = outcome.ok
        ? 'previewOnly' in outcome
          ? { status: 'view_only', key, runId: outcome.runId, screenshots: outcome.screenshots, hmsPrice: outcome.hmsPrice }
          : { status: 'ready', key, digest: outcome.digest, runId: outcome.runId, screenshots: outcome.screenshots,
            hmsPrice: outcome.hmsPrice, createGuard, editGeneration }
        : {
            status: 'refused',
            key,
            message: noMatchingGuestProfile
              ? 'HMS found no matching existing guest profile. Create the profile by hand in HMS, then preview again to choose it.'
              : outcome.message,
          };
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
            hmsPrice: preview.hmsPrice,
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
    if (cloudPreview && preview.status === 'ready' && approvalEpoch === (cloudApprovalEpoch.current[roomKey] ?? 0)) {
      cloudFreshPreviews.current[roomKey] = { key, epoch: approvalEpoch };
    }
    finishPreviewIfRunning(roomKey, requestId, preview);
  }

  function roomKeyOf(room: BookingDraftReady['draft']['rooms'][number]): string {
    return `${room.groupId}:${room.roomIndex}`;
  }

  function allocationIdForRoom(room: BookingDraftReady['draft']['rooms'][number]): string {
    return cloudPreview ? stayIdForRoom(room, groups) : legacyStayIdForRoom(room, groups);
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
    const roomBinding = createRoomBinding(room, groups, workItemPane, session);
    const boundAgency = parties?.bookingAgency?.nativeId ? parties.bookingAgency :
      !partyFieldEdited?.bookingAgency ? roomBinding?.value.bookingAgency ?? undefined : undefined;
    const boundCompany = parties?.organization?.nativeId ? parties.organization :
      !partyFieldEdited?.organization ? roomBinding?.value.organization ?? undefined : undefined;
    const savedAgency = roomBinding?.value.bookingAgency?.name;
    const unboundName = textValue(savedAgency).trim() || textValue(roomBinding?.value.sourceAgencyName).trim() || textValue(room.request.bookingAgency).trim();
    const agencyUnresolved = choice.bookingAgency !== '__none__' &&
      (!boundAgency || choice.bookingAgency === '__unresolved__') && Boolean(unboundName);
    const currentEmail = currentContact ? textValue(currentContact.email) :
      staffChose && effectiveRecipientMode === 'client' ? textValue(draft.draft.rooms[0]?.request.bookerEmail) : '';
    const recipient = holdMessage ? { ok: false as const, message: holdMessage } : resolveConfirmationRecipient({
      mode: effectiveRecipientMode, customAddress, userEmail: sources?.userEmail ?? '', clientEmail: currentEmail,
      invalidSetting: sources?.invalidSetting, staffChose,
    });
    const roomChoice = roomChoiceFor(room, group, choice, currentContact,
      (sendHmsConfirmation || cloudPreview) && recipient.ok ? recipient.recipient : null);
    if (!reservationNoteDirty.current[roomKeyOf(room)] && choice.generatedReservationNote !== undefined &&
      choice.reservationNote === choice.generatedReservationNote) {
      roomChoice.reservationNote = generatedNoteForChoice(session, propertyCode, room, group, choice) ?? '';
    }
    roomChoice.bookingAgency = choice.bookingAgency === '__none__' || choice.bookingAgency === '__unresolved__' || !boundAgency
      ? undefined : { name: boundAgency.name, nativeId: boundAgency.nativeId };
    if (cloudPreview && choice.organization.trim() && boundCompany && choice.organization.trim() === boundCompany.name) {
      roomChoice.organization = { name: boundCompany.name, nativeId: boundCompany.nativeId };
    }
    const labtestRoom = textValue(roomChoice.firstName).trim().toLowerCase() === 'proof' &&
      textValue(roomChoice.lastName).trim().toLowerCase() === 'labtest';
    roomChoice.confirmationSendMail = labtestRoom ? false : sendHmsConfirmation;
    roomChoice.cmsMessageId = cmsMessage;
    const request = roomRequestFor(room, group, choice);
    const built = paneStayInputForConfiguredRoom(request, roomChoice, requiredCreateFields);
    const missing = [...built.missing];
    if (requireDurableCreate && !createRoomBinding(room, groups, workItemPane, session)) missing.push('saved booking request');
    if (requireDurableCreate && ((!labtestOnly && cmsMixed.send) ||
      (sendHmsConfirmation && (cmsMixed.messageId || cmsMixed.recipient)))) missing.push('confirmation choices');
    if (requireDurableCreate && built.stay && (built.stay.adults < 1 || built.stay.adults > 9)) missing.push('1–9 adults');
    if (requireDurableCreate && built.stay && (built.stay.childAges?.length ?? 0) > 9) missing.push('at most 9 children');
    if (cloudCreate && !roomChoice.reservationNote?.trim()) missing.push('reservation note');
    if (agencyUnresolved) missing.push('booking agency');
    if (cloudPreview && choice.organization.trim() && (!boundCompany || choice.organization.trim() !== boundCompany.name)) missing.push('company selected from HMS');
    if (roomChoice.confirmationSendMail && !recipient.ok) missing.push('confirmation recipient');
    if (!cmsOptions.some((option) => option.code === cmsMessage)) missing.push('Confirmation type');
    const selectedRoom = roomChoice.roomType ?? '';
    if (selectedRoom && !/^[A-Z0-9]{1,12}$/.test(selectedRoom)) missing.push('room type');
    if (configuration?.catalogue?.coverage.roomTypes === 'complete' &&
        selectedRoom && !configuration.roomTypes.some(room => room.code === selectedRoom)) missing.push('room type');
    if (choice.guestoptin4 && configuration?.formPolicy &&
        !['optional', 'required'].includes(configuration.formPolicy.guestOptIn)) missing.push('Terms choice');
    if (!cloudPreview) {
      if (propertyCode === 'HRDAV' || propertyCode === 'HRDAVS') missing.push('Create is not available for this hotel');
      return { stay: missing.length ? null : built.stay, missing: [...new Set(missing)] };
    }
    const source = session?.staffSource;
    const stableId = /^[A-Za-z0-9_-]{1,40}$/;
    const selectedId = group?.stayId;
    if (!workItemId || !source || !/^[a-f0-9]{64}$/.test(source.sourceHash) || !source.messageId.trim() ||
        !source.threadId.trim() || !selectedId || !stableId.test(selectedId) || !stableId.test(group?.id ?? '') ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(stayIdForRoom(room, groups))) missing.push('selected email and saved booking request');
    const stay = !missing.length && built.stay && source && selectedId && group
      ? { ...built.stay, childAges: built.stay.childAges ?? [], ...(propertyCode ? { propertyCode } : {}), createSelection: {
          source, identity: { stayId: selectedId, rowId: group.id, roomIndex: room.roomIndex },
          ...(choice.nativeGuestId ? { nativeGuestId: choice.nativeGuestId } : {}),
        } }
      : null;
    return { stay, missing: [...new Set(missing)] };
  }

  function previewKeyForRoom(
    room: BookingDraftReady['draft']['rooms'][number],
    stay: PaneStayInput | null,
  ): string | null {
    return stay
      ? paneStayPreviewKey(workItemId, allocationIdForRoom(room), scopedPreviewInputKey(stay))
      : null;
  }

  const previewInputs = Object.fromEntries(
    draft.draft.rooms.map((room) => {
      const stayId = allocationIdForRoom(room);
      const built = roomBuilt(room);
      const inputKey = built.stay ? scopedPreviewInputKey(built.stay) : null;
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
    const key = paneStayPreviewKey(workItemId, allocationIdForRoom(room), scopedPreviewInputKey(built.stay));
    return preview?.status === 'ready' && preview.key === key && cloudPreviewIsFresh(room, key) &&
      durablePreviewCurrent(preview)
      ? { stay: built.stay, digest: preview.digest }
      : null;
  }

  function durablePreviewCurrent(preview: Extract<PreviewView, { status: 'ready' }>): boolean {
    if (!requireDurableCreate) return true;
    const revision = createRevisionRef.current;
    return Boolean(preview.createGuard && revision.cursor && !revision.pending &&
      preview.createGuard.expectedSeq === revision.cursor.seq &&
      preview.createGuard.expectedExtractionId === revision.cursor.extractionId &&
      preview.editGeneration === revision.editGeneration);
  }

  const storedCloudStops = cloudStopsFromSaved(savedStays, createScope);
  const cloudStops = [...localCloudStops, ...storedCloudStops];
  const unprocessedStoredStop = storedCloudStops.some((stop) => !seenCloudStops.current.has(cloudStopIdentity(stop)));
  const cloudUnknownStays = new Set([
    ...Object.entries(savedStays ?? {}).filter(([, save]) => save.status === 'unknown').map(([id]) => id),
    ...draft.draft.rooms.filter((room) => {
      const commit = saves[roomKeyOf(room)]?.commit;
      return uncertainCommit(commit) && !(commit?.status === 'refused' && commit.ambiguousStored) &&
        !roomIds(room, groups).some((id) => savedStays?.[id]?.status === 'unknown');
    })
      .map((room) => allocationIdForRoom(room)),
  ]);
  const hasCloudStop = cloudStops.length > 0 || cloudUnknownStays.size > 0;
  // A stored UNKNOWN without a captured target remains a global stop until HMS is checked.
  const unknownTargetMissing = [...cloudUnknownStays].some((id) => !cloudStops.some((stop) => stop.unknownStayId === id));

  useEffect(() => {
    const unseen = cloudStopsFromSaved(savedStays, createScope).filter((stop) => !seenCloudStops.current.has(cloudStopIdentity(stop)));
    if (!unseen.length) return;
    for (const stop of unseen) seenCloudStops.current.add(cloudStopIdentity(stop));
    setCloudStops((current) => [...current, ...unseen]);
    const members = new Set(unseen.flatMap((stop) => stop.members.map((member) => member.stayId)));
    for (const id of members) previewReceipt.clear(workItemId, id);
    for (const room of draft.draft.rooms) {
      if (!roomIds(room, groups).some((id) => members.has(id))) continue;
      previewReceipt.clear(workItemId, allocationIdForRoom(room));
      const key = roomKeyOf(room);
      cloudApprovalEpoch.current[key] = (cloudApprovalEpoch.current[key] ?? 0) + 1;
      delete cloudFreshPreviews.current[key];
    }
    setSaves((current) => {
      const next = { ...current };
      for (const room of draft.draft.rooms) {
        if (!roomIds(room, groups).some((id) => members.has(id))) continue;
        const key = roomKeyOf(room), save = current[key], preview = save?.preview;
        if (save && preview) next[key] = { ...save, preview: { status: 'stale', key: preview.key } };
      }
      return next;
    });
  }, [savedStays, draft, groups, previewReceipt, workItemId]);

  function cloudPreviewIsFresh(room: BookingDraftReady['draft']['rooms'][number], key: string | null): boolean {
    if (!cloudPreview || !hasCloudStop) return true;
    const roomKey = roomKeyOf(room), epoch = cloudApprovalEpoch.current[roomKey] ?? 0;
    if (epoch === 0) return true;
    const fresh = cloudFreshPreviews.current[roomKey];
    return Boolean(key && fresh?.key === key && fresh?.epoch === epoch);
  }

  function cloudRoomTarget(room: BookingDraftReady['draft']['rooms'][number]): string | null {
    const choice = choices[roomKeyOf(room)] ?? NO_CHOICE;
    const request = roomRequestFor(room, roomGroupFor(room, groups), choice);
    return cloudCreateTargetKey({ firstName: choice.firstName, lastName: choice.lastName, arrival: textValue(request.arrival) }, createScope);
  }

  function confirmedStay(stayId: string, expectedTarget: string): boolean {
    const stored = savedStays?.[stayId];
    if (stored?.status === 'booked' && Boolean(stored.confirmationNumber)) {
      // Legacy positive rows lack target provenance: retain the conservative
      // sibling stop. New Cloud rows compare their actual authorized target.
      return !stored.cloudCreateTarget || cloudCreateTargetKey(stored.cloudCreateTarget, createScope) === expectedTarget;
    }
    return draft.draft.rooms.some((room) => {
      if (!roomIds(room, groups).includes(stayId)) return false;
      const commit = saves[roomKeyOf(room)]?.commit;
      return commit?.status === 'booked' && !commit.unverified && Boolean(commit.confirmationNumber) &&
        cloudRoomTarget(room) === expectedTarget;
    });
  }

  function hasBookedSibling(room: BookingDraftReady['draft']['rooms'][number]): boolean {
    const ids = roomIds(room, groups);
    return cloudStops.some((stop) => stop.members.some((member) => ids.includes(member.stayId) &&
      stop.members.some((other) => other.stayId !== member.stayId && other.targetKey === member.targetKey &&
        confirmedStay(other.stayId, member.targetKey))));
  }

  function cloudRoomHeld(room: BookingDraftReady['draft']['rooms'][number]): boolean {
    const key = roomKeyOf(room);
    const ids = roomIds(room, groups);
    const target = cloudRoomTarget(room);
    return partialCloudRoomsRef.current.has(key) || hasBookedSibling(room) || cloudStops.some((stop) =>
      stop.members.some((member) => ids.includes(member.stayId) && member.targetKey === stop.targetKey) ||
      (target !== null && (stop.targetKey === target ||
        stop.members.some((member) => member.targetKey === target && confirmedStay(member.stayId, member.targetKey)))));
  }

  function cloudRoomEligible(room: BookingDraftReady['draft']['rooms'][number]): boolean {
    return !cloudPreview || (!unknownTargetMissing && !unprocessedStoredStop && !cloudRoomHeld(room));
  }

  function stopCloudBatch(snapshot: RoomSnapshot[], uncertainIndex: number, batchId?: string) {
    const uncertain = snapshot[uncertainIndex];
    if (!uncertain?.targetKey) return;
    const stop: CloudCreateStop = { unknownStayId: uncertain.stayId, targetKey: uncertain.targetKey,
      ...(batchId ? { batchId } : {}), members: snapshot.flatMap((item) =>
        item.targetKey ? [{ stayId: item.stayId, targetKey: item.targetKey }] : []) };
    seenCloudStops.current.add(cloudStopIdentity(stop));
    for (const member of snapshot) {
      cloudApprovalEpoch.current[member.roomKey] = (cloudApprovalEpoch.current[member.roomKey] ?? 0) + 1;
      delete cloudFreshPreviews.current[member.roomKey];
    }
    setCloudStops((current) => [...current, stop]);
    // A later Go needs newly issued previews, rather than the approvals in the stopped batch.
    const remaining = snapshot.slice(uncertainIndex + 1);
    for (const item of remaining) previewReceipt.clear(workItemId, item.stayId);
    setSaves((current) => {
      const next = { ...current };
      for (const item of remaining) {
        const save = current[item.roomKey], preview = save?.preview;
        if (save && preview) next[item.roomKey] = { ...save, preview: { status: 'stale', key: preview.key } };
      }
      return next;
    });
  }

  async function bookThisStay(pane: PaneStayClient) {
    if (stayBookingRef.current || (cloudPreview && unknownTargetMissing)) return;
    // A prior run's batch ID is not yet resumable after a partial completion.
    // Do not offer a new Go that would lose the verified sibling evidence.
    if (cloudPreview && !hasCloudStop && bookableRooms().length > 1 &&
        bookableRooms().some((room) => savesRef.current[roomKeyOf(room)]?.commit?.status === 'booked') &&
        bookableRooms().some((room) => savesRef.current[roomKeyOf(room)]?.commit?.status !== 'booked')) return;
    const snapshot: RoomSnapshot[] = [];
    for (const room of bookableRooms()) {
      const commit = saves[roomKeyOf(room)]?.commit;
      if (commit?.status === 'booked' || uncertainCommit(commit) || !cloudRoomEligible(room)) continue;
      const ready = roomPreviewReady(room);
      if (!ready) return;
      const targetKey = cloudPreview ? cloudCreateTargetKey(ready.stay, createScope) : null;
      if (cloudPreview && !targetKey) return;
      snapshot.push({ roomKey: roomKeyOf(room), stayId: allocationIdForRoom(room),
        stay: ready.stay, digest: ready.digest, targetKey });
    }
    if (!snapshot.length) return;
    let batchStart: Extract<PaneStayBatch, { kind: 'start' }> | undefined;
    if (cloudPreview && snapshot.length > 1) {
      if (!workItemId || snapshot.length > 8) return;
      const rooms: Extract<PaneStayBatch, { kind: 'start' }>['rooms'] = [];
      for (const item of snapshot) {
        const room = draft.draft.rooms.find((candidate) => roomKeyOf(candidate) === item.roomKey);
        if (!room || !item.stay.createSelection?.nativeGuestId) return;
        const preview = saves[item.roomKey]?.preview;
        const createGuard = preview?.status === 'ready' ? preview.createGuard : undefined;
        if (requireDurableCreate && !createGuard) return;
        rooms.push({ ...item.stay, createSelection: { ...item.stay.createSelection, ...createGuard },
          stayId: allocationIdForRoom(room), workItemId, previewDigest: item.digest });
      }
      batchStart = { kind: 'start', id: crypto.randomUUID(), rooms };
    }
    stayBookingRef.current = true;
    bookedInRunRef.current = {};
    setStayBooking(true);
    const existingUnknown = new Set(Object.entries(savesRef.current)
      .filter(([, save]) => uncertainCommit(save.commit)).map(([key]) => key));
    try {
      for (const [index, item] of snapshot.entries()) {
        if (cloudPreview && Object.entries(savesRef.current).some(([key, save]) =>
          uncertainCommit(save.commit) && !existingUnknown.has(key))) return;
        if (!stayBookingRef.current || savedOutcomeBlocksRoom(item.roomKey)) return;
        const room = draft.draft.rooms.find((candidate) => roomKeyOf(candidate) === item.roomKey);
        if (!room) return;
        const currentStay = roomBuilt(room, contactRef.current).stay;
        if (!currentStay || paneStayKey(currentStay) !== paneStayKey(item.stay) ||
            previewInputsRef.current[item.roomKey]?.inputKey !== scopedPreviewInputKey(item.stay)) return;
        const batch = batchStart ? (index === 0 ? batchStart : { kind: 'continue' as const, id: batchStart.id, index }) : undefined;
        const commit = await bookRoom(item.roomKey, pane, item.stay, item.digest, batch);
        if (commit?.status === 'booked' && !commit.unverified) continue;
        if (cloudPreview && uncertainCommit(commit ?? undefined)) stopCloudBatch(snapshot, index, batchStart?.id);
        else if (cloudPreview && index > 0) {
          for (const remaining of snapshot.slice(index)) partialCloudRoomsRef.current.add(remaining.roomKey);
        }
        return;
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
        inheritedFieldsMatch(other, otherStay, room, stay)) {
        return savedRoomMatch(other, draft, groups, savedStays).id ?? allocationIdForRoom(other);
      }
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

  async function bookRoom(roomKey: string, pane: PaneStayClient, stay: PaneStayInput, previewDigest: string, batch?: PaneStayBatch) {
    if (savedOutcomeBlocksRoom(roomKey)) return null;
    const key = paneStayKey(stay);
    const priorPreview = saves[roomKey]?.preview;
    const createGuard = priorPreview?.status === 'ready' && priorPreview.digest === previewDigest ? priorPreview.createGuard : undefined;
    if (requireDurableCreate && (!createGuard || !stay.createSelection ||
        ((!batch || batch.kind === 'start') && (priorPreview?.status !== 'ready' || !durablePreviewCurrent(priorPreview))))) return null;
    const selected = createGuard && stay.createSelection ? { ...stay,
      createSelection: { ...stay.createSelection, ...createGuard } } : stay;
    const room = draft.draft.rooms.find((item) => `${item.groupId}:${item.roomIndex}` === roomKey);
    if (room) previewReceipt.clear(workItemId, allocationIdForRoom(room));
    patchSave(roomKey, { commit: { status: 'running', key } });
    let commit: CommitView;
    try {
      const parentStayId = !cloudPreview && room && workItemId ? bookedParentStayId(room, stay) : null;
      const persist =
        workItemId && room
          ? { stayId: allocationIdForRoom(room), workItemId, ...(parentStayId ? { parentStayId } : {}) }
          : {};
      const result = batch
        ? await pane.commit({ ...selected, ...persist } as PaneStayInput, previewDigest, batch)
        : await pane.commit({ ...selected, ...persist } as PaneStayInput, previewDigest);
      const outcome = commitOutcome(result, stay);
      commit = outcome.ok
        ? {
            status: 'booked',
            key,
            confirmationNumber: outcome.confirmationNumber,
            runId: outcome.runId,
            screenshots: outcome.screenshots,
            hmsPrice: outcome.hmsPrice,
            ...(outcome.unverified ? { unverified: true } : {}),
            ...(outcome.cmsMismatch ? { cmsMismatch: true } : {}),
          }
        : {
            status: 'refused',
            key,
            message: outcome.message,
            runId: outcome.runId,
            screenshots: outcome.screenshots,
            ...(result.status === 'ok' || result.reason === PANE_SAVE_UNCONFIRMED_REASON ||
              (cloudPreview && typeof result.reason === 'string' &&
                ['cloud_create_recovery_required', 'write_in_flight'].includes(result.reason))
              ? { statusChip: 'check' as const } : {}),
          };
    } catch {
      commit = { status: 'refused', key, message: PANE_COMMIT_UNREACHABLE_COPY, statusChip: 'check' };
    }
    // The next room in a Book this stay run can start before React re-renders this result.
    if (commit.status === 'booked' && stayBookingRef.current) bookedInRunRef.current[roomKey] = commit;
    // Definite refusals can be previewed again; uncertain saves stay locked for an HMS check.
    patchSave(roomKey, commit.status === 'booked' ? { commit } : { commit, preview: undefined });
    return commit;
  }

  async function bookSingleRoom(roomKey: string, pane: PaneStayClient, stay: PaneStayInput, digest: string) {
    if (!cloudPreview) {
      await bookRoom(roomKey, pane, stay, digest);
      return;
    }
    const room = draft.draft.rooms.find((item) => roomKeyOf(item) === roomKey);
    const targetKey = cloudCreateTargetKey(stay, createScope);
    if (!room || !targetKey || stayBookingRef.current || !cloudRoomEligible(room)) return;
    stayBookingRef.current = true;
    setStayBooking(true);
    try {
      const commit = await bookRoom(roomKey, pane, stay, digest);
      if (uncertainCommit(commit ?? undefined)) {
        stopCloudBatch([{ roomKey, stayId: allocationIdForRoom(room), stay, digest, targetKey }], 0);
      }
    } finally {
      stayBookingRef.current = false;
      bookedInRunRef.current = {};
      setStayBooking(false);
    }
  }

  return (
    <section aria-label="Booking details" className="flex flex-col gap-2">
      <p className="text-[11px] text-[#64748b]">
        {cloudPreview
          ? mode === 'on' ? 'Preview each room in HMS, then book when the preview is ready.'
            : mode === 'lab' ? 'Preview any stay. Booking is currently limited to Proof Labtest stays in 2027 or later.'
              : 'Booking from this pane is off.'
          : savesOn ? 'Preview each room using the Stay details above, then create it in HMS.'
          : 'Saving to HMS from this pane is off for now. Stay details are above; enter the booking-only fields in HMS Guest Stay.'}
      </p>
      <div className="flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3">
        <label className="flex items-center gap-2 text-xs font-semibold text-[#475569]">
          <input type="checkbox" aria-label="Send confirmation from HMS" checked={sendHmsConfirmation}
            disabled={stayBooking || labtestOnly || Boolean(requireDurableCreate && (!allCmsBound || workItemPane?.historyBusy))}
            onChange={(event) => {
              setSendConfirmation(event.target.checked);
              setCmsMixed((current) => ({ ...current, send: false }));
              recordCms('send', event.target.checked);
            }} />
          Send confirmation from HMS
        </label>
        {requireDurableCreate && ((!labtestOnly && cmsMixed.send) ||
          (sendHmsConfirmation && (cmsMixed.messageId || cmsMixed.recipient))) ?
          <p role="status" className="text-[11px] text-amber-900">These rooms have different saved confirmation choices. Choose a common option before previewing.</p> : null}
        {labtestOnly ? <p className="text-[11px] text-[#64748b]">Proof Labtest bookings do not send confirmations.</p> : null}
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
          Message Id
          <select aria-label="Message Id" className={paneFieldClass}
            disabled={stayBooking || Boolean(requireDurableCreate && (!allCmsBound || workItemPane?.historyBusy))}
            value={cmsMixed.messageId ? '' : cmsMessage} onChange={(event) => {
              setChosenCmsMessage(event.target.value);
              setCmsMixed((current) => ({ ...current, messageId: false }));
              recordCms('messageId', event.target.value || null);
            }}>
            <option value="">Select confirmation type</option>
            {cmsOptions.map((option) => <option key={option.code} value={option.code}>{option.code} – {option.label}</option>)}
          </select>
        </label>
      {sendConfirmation || cloudPreview ? (
        <div data-pii>
        <ConfirmationRecipient
          mode={effectiveRecipientMode}
          customAddress={customAddress}
          userEmail={sources?.userEmail ?? ''}
          clientEmail={clientEmail}
          disabled={stayBooking || Boolean(requireDurableCreate && (!allCmsBound || workItemPane?.historyBusy))}
          unconfirmed={(Boolean(holdMessage) && sources?.load !== 'pending') || cmsMixed.recipient}
          error={resolvedRecipient && !resolvedRecipient.ok ? resolvedRecipient.message : null}
          onMode={(next) => {
            staffChoseRef.current = true;
            saveGeneration.current += 1;
            setStaffChose(true);
            setRecipientMode(next);
            setCmsMixed((current) => ({ ...current, recipient: false }));
            recordRecipient(next, customAddress);
            setDefaultSaved(false);
          }}
          onCustomAddress={(value) => {
            staffChoseRef.current = true;
            saveGeneration.current += 1;
            setStaffChose(true);
            setCustomAddress(value);
            setCmsMixed((current) => ({ ...current, recipient: false }));
            recordRecipient(effectiveRecipientMode, value);
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
        const binding = createRoomBinding(room, groups, workItemPane, session);
        const queue = workItemPane?.requestDraft;
        const recordPatch = (patch: Partial<RoomChoice>) => {
          if (!binding?.writable || !queue || !cloudCreate) return;
          const record = (field: string, value: Parameters<typeof queue.record>[2], valid = true) =>
            queue.record(binding.requestId, `${binding.prefix}.${field}`, value, valid);
          if (patch.firstName !== undefined) record('firstName', patch.firstName || null);
          if (patch.lastName !== undefined) record('lastName', patch.lastName || null);
          if (patch.nativeGuestId !== undefined) {
            const candidate = (guestCandidates[key] ?? []).find((guest) => guest.nativeId === patch.nativeGuestId);
            record('guest.profile', candidate ? { nativeId: candidate.nativeId, firstName: candidate.firstName, lastName: candidate.lastName } : null);
          } else if ((patch.firstName !== undefined || patch.lastName !== undefined) && choice.nativeGuestId) record('guest.profile', null);
          if (patch.roomType !== undefined) record('roomTypeCode', patch.roomType || null, !patch.roomType || /^[A-Z0-9]{1,12}$/.test(patch.roomType));
          if (patch.ratePlan !== undefined) record('ratePlan', patch.ratePlan || null, !patch.ratePlan || /^[A-Z0-9]{1,12}$/.test(patch.ratePlan));
          if (patch.adults !== undefined) {
            const adults = patch.adults.trim() ? Number(patch.adults) : null;
            record('adults', adults === null || Number.isInteger(adults) ? adults : patch.adults,
              adults === null || (Number.isInteger(adults) && adults >= 1 && adults <= 9));
          }
          if (patch.childAges !== undefined) {
            const ages = patch.childAges.map((age) => age.trim() ? Number(age) : Number.NaN);
            const valid = ages.length <= 9 && ages.every((age) => Number.isInteger(age) && age >= 0 && age <= 17);
            record('childAges', valid ? ages : patch.childAges.join('|'), valid);
          }
          if (patch.bookingAgency !== undefined) {
            const agency = parties?.bookingAgency;
            record('parties.bookingAgency', patch.bookingAgency === '__bound__' && agency?.nativeId
              ? { nativeId: agency.nativeId, name: agency.name } : null,
            patch.bookingAgency === '__none__' || Boolean(patch.bookingAgency === '__bound__' && agency?.nativeId));
          }
          if (patch.organization !== undefined) {
            const company = parties?.organization;
            const name = patch.organization.trim();
            record('parties.organization', name && company?.nativeId && name === company.name
              ? { nativeId: company.nativeId, name: company.name } : name || null,
            !name || Boolean(company?.nativeId && name === company.name));
          }
          if (patch.sourceOfBusiness !== undefined) record('sourceOfBusiness', patch.sourceOfBusiness || null);
          if (patch.track !== undefined) record('track', patch.track || null);
          if (patch.guaranteeType !== undefined) record('guaranteeType', patch.guaranteeType || null);
          if (patch.reservationNote !== undefined) record('reservationNote', patch.reservationNote || null);
          if (patch.bookerName !== undefined) record('bookerName', patch.bookerName || null);
          if (patch.bookerEmail !== undefined) record('bookerEmail', patch.bookerEmail || null);
        };
        const setChoice = (patch: Partial<RoomChoice>) => {
          recordPatch(patch);
          setChoices((current) => {
            const currentChoice = current[key] ?? NO_CHOICE;
            const guestChanged =
              (patch.firstName !== undefined && patch.firstName !== currentChoice.firstName) ||
              (patch.lastName !== undefined && patch.lastName !== currentChoice.lastName);
            const nextChoice: RoomChoice = {
              ...currentChoice,
              ...patch,
              ...(guestChanged ? { guestoptin4: false, nativeGuestId: patch.nativeGuestId } : {}),
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
        };
        // Once create is running or saved, freeze its create-only fields until staff checks the result.
        const commitStatus = saves[key]?.commit?.status;
        const originalHeldRoom = cloudPreview && (partialCloudRoomsRef.current.has(key) ||
          hasBookedSibling(room) ||
          cloudStops.some((stop) => stop.members.some((member) => roomIds(room, groups).includes(member.stayId) &&
            member.targetKey === stop.targetKey)));
        const locked = stayBooking || commitStatus === 'running' || savedOutcomeBlocksRoom(key) || originalHeldRoom ||
          Boolean(requireDurableCreate && (!binding || workItemPane?.historyBusy));
        const request = room.request;
        const group = roomGroupFor(room, groups);
        const generatedNote = generatedNoteForChoice(session, propertyCode, room, group, choice);
        const built = roomBuilt(room);
        const price = group?.rowPrice;
        const override = price?.source === 'override' ? price : null;
        const commit = saves[key]?.commit;
        const roomPreview = saves[key]?.preview;
        const bookedCommit = commit?.status === 'booked' ? commit : null;
        const roomCount = group?.quantity ?? Math.max(
          1,
          draft.draft.rooms.filter((candidate) => candidate.groupId === room.groupId).length,
        );
        const arrival = group?.arrivalDate ?? textValue(request.arrival);
        const departure = group?.departureDate ?? textValue(request.departure);
        const nightsValue = (Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / 86_400_000;
        const nights = Number.isInteger(nightsValue) && nightsValue > 0 ? nightsValue : null;
        const selectedRoom = choice.roomType ?? roomTypeFor(room, group);
        const selectedRate = choice.ratePlan ?? (textValue(group?.rateCode) || textValue(group?.quotedRateCode) || textValue(request.ratePlan));
        const propertyRooms = configuration ? configuration.roomTypes : draft.options.roomType.map(code => ({ code, label: code }));
        const rateCodes = [...new Set([
          ...(options.ratePlans ?? []),
          ...(session?.rateOptions ?? []).filter((rate) => rate.groupId === room.groupId && rate.roomCode === selectedRoom).map((rate) => rate.rateCode),
          ...(choice.ratePlan === undefined && selectedRate ? [selectedRate] : []),
        ].filter(Boolean))];
        const cloudRatePlans = [...new Map([
          ...rateCodes.map((code) => [code, { code, name: (session?.rateOptions ?? []).find((rate) => rate.rateCode === code)?.rateLabel ?? '' }] as const),
          ...rateCatalogue.map((plan) => [plan.code, { code: plan.code, name: plan.name }] as const),
        ]).values()];
        const inheritedAges = inheritedChildAges(room, group);
        const ages = choice.childAges ?? (Array.isArray(inheritedAges) ? inheritedAges.map(String) : []);
        const agesKnown = choice.childAges !== undefined || Array.isArray(inheritedAges);
        const boundAgency = parties?.bookingAgency?.nativeId ? parties.bookingAgency :
          !partyFieldEdited?.bookingAgency ? binding?.value.bookingAgency ?? undefined : undefined;
        const boundCompany = parties?.organization?.nativeId ? parties.organization :
          !partyFieldEdited?.organization ? binding?.value.organization ?? undefined : undefined;
        const matchingGuests = (guestCandidates[key] ?? []).filter((candidate) =>
          candidate.lastName.trim().toLowerCase() === choice.lastName.trim().toLowerCase());
        const searchDraft = workItemPane?.rateDraft;
        const searchStayId = workItemPane?.refs[room.groupId]?.stayId ?? group?.stayId;
        const searchKey = JSON.stringify([searchDraft?.transportId, searchDraft?.snapshot.source, binding?.requestId,
          binding?.rowId, binding?.roomIndex, searchStayId, choice.firstName, choice.lastName, workItemPane?.historyEpoch]);
        guestSearchContext.current[key] = searchKey;
        const searchView = guestSearch[key]?.key === searchKey ? guestSearch[key] : undefined;
        const findGuest = async () => {
          if (!searchDraft || !binding || !searchStayId || !queue || !choice.lastName.trim()) return;
          const mailbox = inMailbox(searchDraft.transportId);
          type GuestRoute = { mutate: (input: { binding: { workItemId: string;
            source: { threadId: string; messageId: string; sourceHash: string };
            request: { requestId: string; stayId: string; rowId: string; roomIndex: number };
            expectedSeq: number; expectedExtractionId: string }; lastName: string }, options: NonNullable<typeof mailbox>) =>
            Promise<{ status: 'ready' | 'unavailable'; candidates: PaneGuestCandidate[]; partial: boolean }> };
          const route = (searchDraft.trpc as { quoteWorkflow?: { searchCreateGuests?: GuestRoute } } | null)?.quoteWorkflow?.searchCreateGuests;
          if (!route || !mailbox) return;
          const generation = (guestSearchGeneration.current[key] ?? 0) + 1;
          guestSearchGeneration.current[key] = generation;
          const active = () => guestSearchMounted.current && guestSearchGeneration.current[key] === generation &&
            guestSearchContext.current[key] === searchKey;
          setGuestSearch((current) => ({ ...current, [key]: { key: searchKey, status: 'running' } }));
          try {
            const cursor = await queue.flush();
            if (!active()) return;
            if (!cursor) throw new Error('Draft not saved');
            const source = searchDraft.snapshot.source;
            const reply = await route.mutate({ binding: { workItemId: searchDraft.snapshot.workItemId,
              source: { threadId: source.threadId, messageId: source.messageId, sourceHash: source.sourceHash },
              request: { requestId: binding.requestId, stayId: searchStayId, rowId: binding.rowId, roomIndex: binding.roomIndex },
              expectedSeq: cursor.seq, expectedExtractionId: source.extractionId }, lastName: choice.lastName.trim() }, mailbox);
            if (!active()) return;
            setGuestCandidates((current) => ({ ...current, [key]: reply.candidates }));
            setGuestSearch((current) => ({ ...current, [key]: { key: searchKey, status: reply.status, partial: reply.partial } }));
          } catch {
            if (active()) setGuestSearch((current) => ({ ...current, [key]: { key: searchKey, status: 'unavailable' } }));
          }
        };
        const observedFields = binding ? Object.entries(workItemPane?.requestDraft?.snapshot?.fieldMeta ?? {})
          .filter(([path, meta]) => path.startsWith(`requests[${binding.requestId}].`) &&
            meta.origin === 'email' && meta.evidence?.source?.reviewRequired)
          .map(([path, meta]) => ({ field: path.endsWith('.sourceAgencyName') ? 'agency' :
            path.endsWith('.sourceOrganizationName') ? 'company' : path.split('.').at(-1) ?? 'detail', role: meta.attributedTo,
            page: meta.evidence?.source?.page })) : [];
        const agencyValue = choice.bookingAgency === '__none__' ? '__none__'
          : choice.bookingAgency === '__unresolved__' ? '' : boundAgency ? '__bound__' : '';
        const roomLabel = rowRoomLabel({
          roomPreference: selectedRoom || textValue(request.roomType),
          quantity: roomCount,
        });
        const guestFields = (<>
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
            {cloudCreate && searchDraft && binding && searchStayId && queue ? (
              <div className="flex flex-col gap-1">
                <SecondaryButton disabled={locked || !choice.lastName.trim() || searchView?.status === 'running'}
                  onClick={() => void findGuest()}>
                  {searchView?.status === 'running' ? 'Searching HMS…' : 'Find guest profile'}
                </SecondaryButton>
                {searchView?.status === 'unavailable' ? <p role="status" className="text-xs text-amber-800">Guest search unavailable. Try again.</p> : null}
                {searchView?.status === 'ready' && !matchingGuests.length ? <p role="status" className="text-xs text-[#64748b]">
                  {searchView.partial ? 'No matching profile in these results. Refine the name in HMS.' : 'No matching guest profile found in HMS.'}
                </p> : null}
                {searchView?.status === 'ready' && searchView.partial && matchingGuests.length ?
                  <p role="status" className="text-xs text-amber-800">HMS returned partial results. Check the guest details before choosing.</p> : null}
              </div>
            ) : null}
            {matchingGuests.length ? (
              <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
                Guest profile
                <select aria-label="Guest profile" className={paneFieldClass} disabled={locked}
                  value={choice.nativeGuestId ?? ''} onChange={(event) => {
                    const candidate = matchingGuests.find((guest) => guest.nativeId === event.target.value);
                    if (candidate) guestNamesEdited.current[key] = true;
                    setChoice({ nativeGuestId: event.target.value,
                      ...(candidate ? { firstName: candidate.firstName, lastName: candidate.lastName } : {}) });
                  }}>
                  <option value="">Select the matching guest</option>
                  {matchingGuests.map((candidate) => (
                    <option key={candidate.nativeId} value={candidate.nativeId}>
                      {[candidate.firstName, candidate.lastName, candidate.city, candidate.country, `#${candidate.nativeId}`].filter(Boolean).join(' · ')}
                    </option>
                  ))}
                </select>
                {matchingGuests.some((guest) => guest.firstName.trim().toLowerCase() !== choice.firstName.trim().toLowerCase()) ? (
                  <span className="font-normal">Names may differ. Check the guest before choosing; the profile name will be used.</span>
                ) : null}
              </label>
            ) : null}
            {selectedGuestName.trim() && guestSplit.ambiguous ? (
              <p role="status" className="text-[11px] text-[#64748b]">
                {AMBIGUOUS_GUEST_NAME_COPY}
              </p>
            ) : null}
        </>);
        const roomTypeField = (<>
            <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
              Room type
              <input aria-label="Room type" className={paneFieldClass} disabled={locked} list={`booking-rooms-${key}`}
                value={selectedRoom} placeholder="Code or choose a room type"
                onChange={(event) => setChoice({ roomType: event.target.value.toUpperCase(), ratePlan: '' })} />
              <datalist id={`booking-rooms-${key}`}>
                {propertyRooms.map((room) => <option key={room.code} value={room.code} label={room.label} />)}
              </datalist>
              <span className="text-[11px] font-normal text-[#64748b]">
                {propertyRooms.find(room => room.code === selectedRoom)?.label || 'Infor checks the room type during review.'}
              </span>
            </label>
        </>);
        const occupancyFields = (<>
            <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
              Adults
              <input type="number" min={1} max={requireDurableCreate ? 9 : 16} step={1} aria-label="Adults" className={paneFieldClass} disabled={locked}
                value={choice.adults ?? String(group?.adults ?? request.adults ?? '')}
                onChange={(event) => setChoice({ adults: event.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
              Children
              <input type="number" min={0} max={requireDurableCreate ? 9 : 16} step={1} aria-label="Children" className={paneFieldClass} disabled={locked}
                value={cloudPreview && !agesKnown ? '' : ages.length} onChange={(event) => {
                  if (event.target.value.trim() === '') return;
                  const count = Number(event.target.value);
                  if (Number.isInteger(count) && count >= 0 && count <= (requireDurableCreate ? 9 : 16)) {
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
            {configuration?.formPolicy?.childCategories?.length ? <p className="text-[11px] text-[#64748b]">
              Infor child categories: {configuration.formPolicy.childCategories.map(category => category.label).join(', ')}.
            </p> : null}
        </>);
        const agencyField = (<>
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
            {(!boundAgency || choice.bookingAgency === '__unresolved__') &&
              (textValue(request.bookingAgency).trim() || binding?.value.bookingAgency?.name || binding?.value.sourceAgencyName) && agencyValue !== '__none__' ? (
              <p className="text-[11px] text-[#64748b]">{binding?.value.bookingAgency?.name || binding?.value.sourceAgencyName || textValue(request.bookingAgency).trim()}: select this agency in Agency &amp; company above, or choose No agency.</p>
            ) : null}
        </>);
        const organizationField = (<>
            <RoomTextField
              roomLabel={roomLabel}
              label="Organization"
              value={choice.organization}
              disabled={locked}
              maxLength={PANE_PARTY_NAME_MAX}
              onChange={(value) => { organizationEdited.current[key] = true; setChoice({ organization: value }); }}
            />
        </>);
        const rateField = (<>
            {cloudCreate ? <CloudRatePicker value={selectedRate} plans={cloudRatePlans} disabled={locked}
              onChange={(ratePlan) => setChoice({ ratePlan })} /> : <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
              Rate plan
              <select aria-label="Rate plan" className={paneFieldClass} disabled={locked} value={selectedRate}
                onChange={(event) => setChoice({ ratePlan: event.target.value })}>
                <option value="">Select rate plan</option>
                {rateCodes.map((code) => <option key={code} value={code}>{code}</option>)}
              </select>
            </label>}
        </>);
        const guaranteeField = (<>
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
        </>);
        return (
          <article
            key={key}
            className="shadow-xs flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3"
          >
            {requireDurableCreate && !binding ? <p role="status" className="text-[11px] text-amber-900">
              This room is not linked to a saved booking request. Reload the email before editing.
            </p> : null}
            {observedFields.length ? <p role="status" className="text-[11px] text-amber-900">
              Check all booking details against the attachment, including dates, room and guests. Review attachment reading: {observedFields.map((item) => `${item.field}${item.role ? ` (${item.role})` : ''}${item.page != null ? `, page ${item.page}` : ''}`).join('; ')}.
            </p> : null}
            {cloudCreate ? guestFields : agencyField}
            {!cloudCreate ? guaranteeField : null}
            {cloudCreate ? <div className="flex flex-wrap items-baseline justify-between gap-1 text-xs text-[#475569]">
              <span data-pii><strong>Dates</strong> {arrival || 'Arrival needed'} → {departure || 'Departure needed'}
                {nights ? ` · ${nights} ${nights === 1 ? 'night' : 'nights'}` : ''}</span>
              {group && session ? <a href="#quote-stay" className="font-semibold text-[#0066cc] underline">Edit stay dates</a> : null}
            </div> : null}
            {roomTypeField}
            {!cloudCreate ? rateField : null}
            {occupancyFields}
            {cloudCreate ? agencyField : guestFields}
            {organizationField}
            {cloudCreate ? rateField : null}
            {requireDurableCreate && rateReadProperty && group && session && rateEvidence && binding && queue ? <ContextualRateCheck
              group={group} session={session} pane={workItemPane ?? null} evidence={rateEvidence} plans={rateCatalogue}
              propertyCode={rateReadProperty}
              onChoose={(ratePlan) => setChoice({ ratePlan })} create={{ roomIndex: binding.roomIndex, rateCode: selectedRate,
                bookingAgency: agencyValue === '__none__' ? 'none' : agencyValue === '__bound__' ? 'selected' : 'unknown',
                organization: !choice.organization.trim() ? 'none' : boundCompany?.nativeId &&
                  choice.organization.trim() === boundCompany.name ? 'selected' : 'unknown',
                contextKey: JSON.stringify([arrival, departure, selectedRoom, choice.adults ?? group.adults,
                  agesKnown ? ages : null, selectedRate, choice.bookingAgency, boundAgency?.nativeId ?? null,
                  choice.organization, boundCompany?.nativeId ?? null,
                  choice.sourceOfBusiness, choice.track, choice.guaranteeType]), locked,
                onContextChange: () => {
                  delete cloudFreshPreviews.current[key];
                  previewReceipt.clear(workItemId, allocationIdForRoom(room));
                  setSaves((current) => {
                    const save = current[key];
                    return save?.preview ? { ...current, [key]: { ...save, preview: { status: 'stale', key: save.preview.key } } } : current;
                  });
                },
                prepare: () => {
                  const adults = Number(choice.adults ?? group.adults ?? request.adults);
                  const childAges = ages.map((age) => age.trim() ? Number(age) : Number.NaN);
                  if (!/^[A-Z0-9]{1,12}$/.test(selectedRoom) || !Number.isInteger(adults) || adults < 1 || adults > 9 ||
                      !agesKnown || childAges.length > 9 || childAges.some((age) => !Number.isInteger(age) || age < 0 || age > 17)) return false;
                  const fields: Array<[string, unknown, RecordFieldEventInput['value']]> = [
                    ['roomTypeCode', binding.value.roomType, selectedRoom], ['adults', binding.value.adults, adults],
                    ['childAges', binding.value.childAges, childAges],
                  ];
                  return fields.every(([field, previous, value]) => {
                    const suffix = `${binding.prefix}.${field}`;
                    return !queue.held(binding.requestId, suffix) && JSON.stringify(previous) === JSON.stringify(value) ||
                      queue.record(binding.requestId, suffix, value);
                  });
                } }} /> : null}
            {!selectedRate && !cloudCreate ? <p className="text-[11px] text-[#64748b]">Rates loading. Select a rate when available.</p> : null}
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
            {cloudCreate ? guaranteeField : null}
            {configuration?.formPolicy?.marketSegmentChoices?.length ? <CloudRatePicker label="Market Segment"
              value={choice.marketSegment} plans={configuration.formPolicy.marketSegmentChoices.map(({ code, meaning }) => ({ code, name: meaning }))}
              disabled={locked} maxLength={20} hint="Infor verifies the market segment during review." onChange={value => setChoice({ marketSegment: value })} /> : <RoomTextField
                roomLabel={roomLabel}
                label="Market Segment"
                value={choice.marketSegment}
                disabled={locked}
                onChange={(value) => setChoice({ marketSegment: value })}
              />}
              {(!configuration?.formPolicy || ['optional', 'required'].includes(configuration.formPolicy.guestOptIn)) ? <div className="flex flex-col gap-1">
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
              </div> : choice.guestoptin4 ? <p className="text-[11px] text-amber-800">Terms cannot be applied for this hotel.{' '}
                <button type="button" disabled={locked} onClick={() => setChoice({ guestoptin4: false })}>Clear choice</button>
              </p> : null}
            <RoomTextField
              multiline
              roomLabel={roomLabel}
              label="Reservation note"
              value={choice.reservationNote}
              disabled={locked}
              maxLength={PANE_RESERVATION_NOTE_MAX}
              required={cloudCreate || requiredCreateFields.some(
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
            {cloudCreate ? <div data-pii className="text-xs text-[#475569]">
              <strong>Booker</strong> {[choice.bookerName ?? (contact ? textValue(contact.name) : textValue(request.bookerName)),
                choice.bookerEmail ?? (contact ? textValue(contact.email) : textValue(request.bookerEmail))].filter(Boolean).join(' · ') || 'Not provided'}
              {session ? <> · <a href="#quote-contact" className="font-semibold text-[#0066cc] underline">Edit contact</a></> : null}
            </div> : null}
            {requireDurableCreate ? <details className="text-xs text-[#475569]">
              <summary className="cursor-pointer font-semibold">More booking details</summary>
              <div className="mt-2 flex flex-col gap-2">
                <RoomTextField roomLabel={roomLabel} label="Booker name for this room" disabled={locked} pii
                  maxLength={PANE_BOOKER_NAME_MAX} value={choice.bookerName ?? (contact ? textValue(contact.name) : textValue(request.bookerName))}
                  onChange={(bookerName) => setChoice({ bookerName })} />
                <RoomTextField roomLabel={roomLabel} label="Booker email for this room" disabled={locked} pii
                  maxLength={PANE_BOOKER_EMAIL_MAX} value={choice.bookerEmail ?? (contact ? textValue(contact.email) : textValue(request.bookerEmail))}
                  onChange={(bookerEmail) => setChoice({ bookerEmail })} />
              </div>
            </details> : null}
            <CopyHmsNotesButton
              block={hmsNotesBlock({
                booker: choice.bookerName ?? (contact ? textValue(contact.name) : textValue(request.bookerName)),
                organization: choice.organization || contact?.bookingAgency,
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
                      mealPlan: room.mealPlan ? BOARD_LABELS[room.mealPlan] : undefined,
                    },
                  },
                ],
              })}
            />
            {client && previewsOn ? (
              <RoomSave
                stay={built.stay}
                previewKey={previewKeyForRoom(room, built.stay)}
                missing={built.missing}
                save={saves[key] ?? {}}
                screenshot={client.screenshot}
                bookLabel={cloudCreate ? 'Create booking' : CREATE_PROVISIONAL_LABEL}
                previewOnly={cloudPreview && !savesOn}
                batchOnly={cloudPreview && draft.draft.rooms.length > 1}
                frozen={stayBooking || (cloudPreview && (!cloudRoomEligible(room) || unknownTargetMissing))}
                approvalRequired={!cloudPreviewIsFresh(room, previewKeyForRoom(room, built.stay)) ||
                  (roomPreview?.status === 'ready' && !durablePreviewCurrent(roomPreview))}
                onPreview={(stay) => void previewRoom(key, client, stay)}
                onBook={(stay, previewDigest) => void bookSingleRoom(key, client, stay, previewDigest)}
              />
            ) : saves[key]?.commit ? (
              <RoomSave
                stay={built.stay}
                previewKey={previewKeyForRoom(room, built.stay)}
                missing={built.missing}
                save={saves[key] ?? {}}
                screenshot={client?.screenshot ?? shotReader ?? (async () => null)}
                bookLabel={cloudCreate ? 'Create booking' : CREATE_PROVISIONAL_LABEL}
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
      {client && savesOn && (!cloudPreview || draft.draft.rooms.length > 1) ? (
        <StayBookBar
          rooms={draft.draft.rooms}
          saves={saves}
          isPreviewReady={(room) => roomPreviewReady(room) !== null}
          isEligible={cloudRoomEligible}
          pane={client}
          stayBooking={stayBooking}
          blockWhenUncertain={cloudPreview}
          hasStop={cloudPreview && hasCloudStop}
          hasUncertain={cloudPreview && cloudUnknownStays.size > 0}
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
  isEligible,
  pane,
  stayBooking,
  blockWhenUncertain,
  hasStop,
  hasUncertain,
  onBookStay,
}: {
  rooms: BookingDraftReady['draft']['rooms'];
  saves: Record<string, RoomSaveState>;
  isPreviewReady: (room: BookingDraftReady['draft']['rooms'][number]) => boolean;
  isEligible: (room: BookingDraftReady['draft']['rooms'][number]) => boolean;
  pane: PaneStayClient;
  stayBooking: boolean;
  blockWhenUncertain: boolean;
  hasStop: boolean;
  hasUncertain: boolean;
  onBookStay: (pane: PaneStayClient) => Promise<void>;
}) {
  const bookable = rooms;
  if (!bookable.length) return null;
  const numbers = bookable.flatMap((room) => {
    const commit = saves[`${room.groupId}:${room.roomIndex}`]?.commit;
    return commit?.status === 'booked' && !commit.unverified && commit.confirmationNumber ? [commit.confirmationNumber] : [];
  });
  const allPending = bookable.filter((room) => {
    const commit = saves[`${room.groupId}:${room.roomIndex}`]?.commit;
    return commit?.status !== 'booked' && !(commit?.status === 'refused' && commit.statusChip === 'check');
  });
  const pending = allPending.filter(isEligible);
  const busy =
    stayBooking ||
    bookable.some((room) => {
      const save = saves[`${room.groupId}:${room.roomIndex}`];
      return save?.preview?.status === 'running' || save?.commit?.status === 'running';
    });
  const allPreviewed = pending.every(isPreviewReady);
  const needsCheck = blockWhenUncertain && hasStop && pending.length === 0;
  const partialBatch = blockWhenUncertain && !hasStop && !stayBooking && numbers.length > 0 && allPending.length > 0;
  return (
    <div className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
      {numbers.length > 0 ? (
        <p data-pii className="text-[12.5px] font-semibold text-emerald-800">
          {`Booked ${numbers.length} of ${bookable.length} – ${numbers.join(', ')}`}
        </p>
      ) : null}
      {hasStop && pending.length > 0 ? (
        <p className="text-[11.5px] text-amber-900">
          {`After previewing, this will book only ${pending.length} other ${pending.length === 1 ? 'room' : 'rooms'}.${hasUncertain ? ' Check the uncertain booking in HMS.' : ''}`}
        </p>
      ) : null}
      {allPending.length > 0 ? (
        <PrimaryButton
          disabled={pending.length === 0 || !allPreviewed || busy || needsCheck || partialBatch}
          disabledReason={needsCheck ? hasUncertain ? 'Check the uncertain booking in HMS first'
            : 'Earlier rooms remain blocked; check them in HMS first.' : partialBatch
            ? 'Some rooms were booked. Check HMS before handling the remaining rooms.'
            : !allPreviewed && !busy ? 'Preview in HMS first' : null}
          onClick={() => void onBookStay(pane)}
        >
          {BOOK_THIS_STAY_LABEL}
        </PrimaryButton>
      ) : null}
    </div>
  );
}
