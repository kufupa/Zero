import { useEffect, useMemo, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { Section, SecondaryButton, StepState } from '@/components/nava-pane/pane-ui';
import { knownRoomCode } from '@/lib/quote-workflow/room-types';
import {
  paneStayAvailabilityRequestFor,
  type PaneStayAvailabilityJobView,
  type PaneStayAvailabilityReader,
  type PaneStayAvailabilityRequest,
} from '@/lib/quote-workflow/pane-stay-bind';
import {
  newQuoteToken,
  stayAskAction,
  stayAskActionLabel,
  stayAskGuests,
  stayIdOf,
  stayKeyForGroup,
} from '@/lib/quote-workflow/session';
import type {
  QuoteBoard,
  QuotePaneBoard,
  QuotePaneConfig,
  QuotePaneRoomType,
  QuoteSession,
  QuoteStayAction,
  StaffQuoteHeader,
  StaffStayExtras,
  StayGroupRequirement,
} from '@/lib/quote-workflow/types';
import { StayExtrasFields } from './stay-extras-fields';
import { StayCard } from './requirement-card';
import { WorkItemResetButton } from '@/components/nava-pane/screens/work-item-reset-button';
import { sectionHasStaffEdit, type WorkItemPaneControls } from '@/lib/quote-workflow/use-work-item';

/** Guests, action badge, and Find this booking. Quote stays still use StayCard under this; amend/cancel do not. */
export function StayAskChrome({
  session,
  stay,
  onSelectStayKey,
}: {
  session: QuoteSession;
  stay: { id: string; rows: StayGroupRequirement[] };
  onSelectStayKey?: (stayKey: string) => void;
}) {
  const guests = stayAskGuests(session, stay.id);
  const askAction = stayAskAction(session, stay.id);
  const askLabel = stayAskActionLabel(askAction);
  return (
    <div className="flex flex-col gap-2">
      {askLabel ? (
        <span
          aria-label="Stay action"
          className="rounded-full bg-[#eaf4ee] px-2 py-0.5 text-[10.5px] font-semibold text-[#1a4332]"
        >
          {askLabel}
        </span>
      ) : null}
      {guests.length ? (
        <ul aria-label="Stay guests" className="flex flex-col gap-0.5 text-[13px] text-[#1e293b]">
          {guests.map((guest, guestIndex) => (
            <li key={`${stay.id}-guest-${guestIndex}`}>
              {guest.name}
              {guest.confirmationNumber ? ` · ${guest.confirmationNumber}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {(askAction === 'amend' || askAction === 'cancel') && !(session.analysis && 'caseActionsUncertain' in session.analysis && session.analysis.caseActionsUncertain === true) ? (
        <SecondaryButton className="w-auto self-start" onClick={() => onSelectStayKey?.(stay.id)}>
          Find this booking
        </SecondaryButton>
      ) : null}
    </div>
  );
}

type AvailabilityViewState = 'ready' | 'stale' | 'denied' | 'pending' | 'missing';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function currentUtcDay(value: unknown): boolean {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  const today = new Date().toISOString().slice(0, 10);
  return new Date(value).toISOString().slice(0, 10) === today;
}

function availabilityViewState(view: PaneStayAvailabilityJobView | null): AvailabilityViewState {
  if (!view) return 'missing';
  if (view.status === 'queued' || view.status === 'running' || view.status === 'retrying') return 'pending';
  const result = asRecord(view.result);
  if (
    view.status !== 'done' ||
    result?.outcome !== 'read' ||
    result.roomScope !== 'all_room_types' ||
    !Array.isArray(result.groups)
  ) return 'denied';
  return currentUtcDay(view.asOf) && currentUtcDay(result.observedAt) ? 'ready' : 'stale';
}

function availabilityOptions(
  view: PaneStayAvailabilityJobView,
  roomIndex: number,
  roomTypes: QuotePaneRoomType[],
): QuotePaneRoomType[] {
  const result = asRecord(view.result);
  const groups = Array.isArray(result?.groups) ? result.groups : [];
  const group = groups.map(asRecord).find((candidate) => candidate?.id === `group-${roomIndex + 1}`);
  const options = Array.isArray(group?.options) ? group.options : [];
  const configured = new Map<string, QuotePaneRoomType>();
  for (const value of options) {
    const option = asRecord(value);
    const code = option?.room;
    if (option?.availability !== 'available' || typeof code !== 'string') continue;
    const room = roomTypes.find((candidate) => candidate.code === code);
    if (room) configured.set(room.code, room);
  }
  return [...configured.values()];
}

function StayAvailabilityPanel({
  session,
  stay,
  stayNumber,
  paneConfig,
  reader,
  onPatchGroup,
}: {
  session: QuoteSession;
  stay: { id: string; rows: StayGroupRequirement[] };
  stayNumber: number;
  paneConfig?: QuotePaneConfig | null;
  reader?: PaneStayAvailabilityReader | null;
  onPatchGroup?: (groupId: string, patch: Partial<StayGroupRequirement>) => void;
}) {
  const threadId = session.binding?.threadId;
  const requestedAvailability = paneStayAvailabilityRequestFor(threadId, stay.rows, paneConfig?.propertyCode);
  const requestKey = requestedAvailability ? JSON.stringify(requestedAvailability) : null;
  const request = useMemo(
    () => requestKey === null ? null : JSON.parse(requestKey) as PaneStayAvailabilityRequest,
    [requestKey],
  );
  const transportMatches = Boolean(paneConfig && session.binding?.transportId === paneConfig.transportId);
  // Room preference is editable when staff pick an available option; it must not detach the
  // all-room snapshot from the same Stay. Dates and occupancy still invalidate that snapshot.
  const key = JSON.stringify([
    stay.id,
    threadId ?? null,
    paneConfig?.transportId ?? null,
    paneConfig?.propertyCode ?? null,
    request !== null,
    stay.rows.map(({ id, arrivalDate, departureDate, quantity, adults, childrenPerRoom, childrenAges }) => [
      id,
      arrivalDate ?? null,
      departureDate ?? null,
      quantity ?? null,
      adults ?? null,
      childrenPerRoom ?? null,
      childrenAges ?? null,
    ]),
  ]);
  const [boundRequest, setBoundRequest] = useState<{ key: string; request: PaneStayAvailabilityRequest | null }>(
    () => ({ key, request }),
  );
  const stayRequest = boundRequest.key === key ? boundRequest.request : request;
  const canRead = Boolean(reader && stayRequest && paneConfig && paneConfig.roomTypes.length && transportMatches);
  const [load, setLoad] = useState<{ key: string; view: PaneStayAvailabilityJobView | null } | null>(null);

  useEffect(() => {
    if (boundRequest.key === key) return;
    setBoundRequest({ key, request });
  }, [boundRequest.key, key, request]);

  useEffect(() => {
    if (!canRead || !reader || !stayRequest) return;
    let active = true;
    setLoad(null);
    void reader(stayRequest)
      .then((view) => {
        if (active) setLoad({ key, view });
      })
      .catch(() => {
        if (active) setLoad({ key, view: null });
      });
    return () => { active = false; };
  }, [canRead, key, reader, stayRequest]);

  if (paneConfig === undefined) return null;
  if (paneConfig === null || !transportMatches || !paneConfig.roomTypes.length) {
    return <p className="text-[12px] text-[#64748b]">Availability room options are unavailable for this property.</p>;
  }
  if (!stayRequest || !reader) {
    return <p className="text-[12px] text-[#64748b]">No admitted availability snapshot for this stay. Continue with manual room selection.</p>;
  }
  const current = load?.key === key ? load.view : undefined;
  if (current === undefined) {
    return <p role="status" className="text-[12px] text-[#64748b]">Loading saved availability…</p>;
  }

  const state = availabilityViewState(current);
  if (state !== 'ready') {
    const message = state === 'stale'
      ? 'Availability snapshot is out of date. Search availability for current results.'
      : state === 'denied'
        ? 'Availability was not admitted for this stay. Continue with manual room selection.'
        : state === 'pending'
          ? 'Availability snapshot is still being prepared. Continue with manual room selection.'
          : 'No admitted availability snapshot for this stay. Continue with manual room selection.';
    return <p className="text-[12px] text-[#64748b]">{message}</p>;
  }

  const rows = stay.rows.map((row, roomIndex) => ({
    row,
    roomIndex,
    options: availabilityOptions(current!, roomIndex, paneConfig.roomTypes),
  }));
  const hasOptions = Boolean(onPatchGroup) && rows.some(({ options }) => options.length > 0);
  return (
    <div role="group" aria-label={`All-room availability for stay ${stayNumber}`} className="flex flex-col gap-1">
      <p className="text-[11px] text-[#64748b]">Read-only availability snapshot; not a quote.</p>
      {rows.map(({ row, roomIndex, options }) => options.length && onPatchGroup ? (
        <div key={row.id} className="flex flex-wrap gap-1">
          {options.map((room) => (
            <button
              key={room.code}
              type="button"
              className="rounded border border-[#cbd5e1] px-2 py-1 text-[12px] font-semibold text-[#334155] hover:bg-[#f8fafc]"
              aria-label={`Use ${room.label} for stay ${stayNumber}, room ${roomIndex + 1}`}
              onClick={() => {
                if (availabilityViewState(current!) !== 'ready') {
                  setLoad({ key, view: current! });
                  return;
                }
                onPatchGroup?.(row.id, {
                  roomPreference: room.code,
                  roomTypeCode: knownRoomCode(room.code) ?? undefined,
                  roomTypeSuggestions: [],
                  roomCodes: undefined,
                  rateCode: undefined,
                });
              }}
            >
              {`Use ${room.label} for stay ${stayNumber}, room ${roomIndex + 1}`}
            </button>
          ))}
        </div>
      ) : null)}
      {!hasOptions ? <p className="text-[12px] text-[#64748b]">No configured available room options. Continue with manual room selection.</p> : null}
    </div>
  );
}

export function QuoteStayStep({
  session,
  stays,
  stayReady,
  roomTotals,
  header,
  mealPlanForStay,
  setMealPlanFilters,
  paneConfig,
  availabilityReader,
  paneRoomTypes,
  strictRoomTypes,
  paneBoards,
  onPatchGroup,
  onStayAction,
  onPatchStayExtras,
  onSelectStayKey,
  children,
  workItemPane = null,
}: {
  session: QuoteSession;
  stays: Array<{ id: string; rows: StayGroupRequirement[] }>;
  stayReady: boolean;
  roomTotals: { rooms: number; guests: number };
  header: StaffQuoteHeader;
  mealPlanForStay: (stayId: string, rows: StayGroupRequirement[]) => QuoteBoard | 'all';
  setMealPlanFilters: Dispatch<SetStateAction<Record<string, QuoteBoard | 'all'>>>;
  paneConfig?: QuotePaneConfig | null;
  availabilityReader?: PaneStayAvailabilityReader | null;
  paneRoomTypes: QuotePaneRoomType[];
  strictRoomTypes: boolean;
  paneBoards?: QuotePaneBoard[];
  onPatchGroup?: (groupId: string, patch: Partial<StayGroupRequirement>) => void;
  onStayAction?: (action: QuoteStayAction) => void;
  onPatchStayExtras?: (stayKey: string, extras: Partial<StaffStayExtras>) => void;
  onSelectStayKey?: (stayKey: string) => void;
  children?: ReactNode;
  workItemPane?: WorkItemPaneControls | null;
}) {
  return (
    <Section step={2} title="Stay" id="quote-stay" action={<StepState state={stayReady ? 'Done' : 'Pending'} />}>
      {/* Hold every stay control while Undo/Reset refreshes; edits made then would be dropped. */}
      <fieldset disabled={workItemPane?.resetPending ?? false} className="contents">
      {stays.map((stay, index) => (
        <div key={stay.rows[0]?.id ?? stay.id} className="flex flex-col gap-2">
          <StayAskChrome session={session} stay={stay} onSelectStayKey={onSelectStayKey} />
          <StayCard
            stayId={stay.id}
            rows={stay.rows}
            index={index}
            stayCount={stays.length}
            extras={
              stay.rows[0] ? (
                <StayExtrasFields
                  header={header}
                  stayKey={stayKeyForGroup(stay.rows[0])}
                  stayNumber={index + 1}
                  onPatch={onPatchStayExtras}
                />
              ) : null
            }
            requestedRoomsTotal={
              [...new Set(stay.rows.map(stayIdOf))].reduce(
                (total, id) => total + (session.analysis?.requestedRoomsByStay?.[id] ?? 0),
                0,
              ) || session.analysis?.requestedRoomsByStay?.[stay.id]
            }
            mealPlan={mealPlanForStay(stay.id, stay.rows)}
            propertyCode={paneConfig?.propertyCode}
            roomTypes={paneRoomTypes}
            strictRoomTypes={strictRoomTypes}
            boards={paneBoards}
            onMealPlanChange={(value) =>
              setMealPlanFilters((current) => ({ ...current, [stay.id]: value }))
            }
            onPatch={onPatchGroup}
            onStayAction={onStayAction}
            evidence={session.analysis?.luna?.evidence}
            headerExtra={stayResetControl(stay.rows, workItemPane)}
          />
          <StayAvailabilityPanel
            session={session}
            stay={stay}
            stayNumber={index + 1}
            paneConfig={paneConfig}
            reader={availabilityReader}
            onPatchGroup={onPatchGroup}
          />
        </div>
      ))}
      {session.groups.length ? (
        <p className="text-center text-[12.5px] font-semibold text-[#475569]">
          {`${roomTotals.rooms} ${roomTotals.rooms === 1 ? 'room' : 'rooms'} · ${roomTotals.guests} ${roomTotals.guests === 1 ? 'guest' : 'guests'}`}
        </p>
      ) : null}
      <div className="flex flex-col gap-1">
        <SecondaryButton className="w-full" onClick={() => onStayAction?.({ type: 'add_stay', token: newQuoteToken() })}>
          + Add another date range
        </SecondaryButton>
        <p className="text-center text-[13px] text-[#64748b]">Each date range is searched and priced independently.</p>
      </div>
      {children}
      </fieldset>
    </Section>
  );
}

function extractionStayId(
  rows: StayGroupRequirement[],
  refs: WorkItemPaneControls['refs'] | null | undefined,
): string | null {
  for (const row of rows) {
    const stayId = refs?.[row.id]?.stayId ?? row.stayId;
    if (stayId && !stayId.startsWith('d:')) return stayId;
  }
  return null;
}

function stayResetControl(rows: StayGroupRequirement[], workItemPane: WorkItemPaneControls | null) {
  const stayId = extractionStayId(rows, workItemPane?.refs);
  if (!stayId || !workItemPane?.onResetStay) return null;
  if (!sectionHasStaffEdit(workItemPane.fieldProvenance, { type: 'stay', stayId })) return null;
  return (
    <WorkItemResetButton
      onClick={() => workItemPane.onResetStay?.(stayId)}
      pending={workItemPane.resetPending}
    />
  );
}
