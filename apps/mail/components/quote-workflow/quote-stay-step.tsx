import type { Dispatch, SetStateAction } from 'react';
import { Section, SecondaryButton, StepState } from '@/components/nava-pane/pane-ui';
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
  StaffQuoteHeader,
  StaffStayExtras,
  StayEditAction,
  StayGroupRequirement,
} from '@/lib/quote-workflow/types';
import { StayExtrasFields } from './stay-extras-fields';
import { StayCard } from './requirement-card';

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
      {askAction === 'amend' || askAction === 'cancel' ? (
        <SecondaryButton className="w-auto self-start" onClick={() => onSelectStayKey?.(stay.id)}>
          Find this booking
        </SecondaryButton>
      ) : null}
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
  paneRoomTypes,
  strictRoomTypes,
  paneBoards,
  onPatchGroup,
  onStayAction,
  onPatchStayExtras,
  onSelectStayKey,
}: {
  session: QuoteSession;
  stays: Array<{ id: string; rows: StayGroupRequirement[] }>;
  stayReady: boolean;
  roomTotals: { rooms: number; guests: number };
  header: StaffQuoteHeader;
  mealPlanForStay: (stayId: string, rows: StayGroupRequirement[]) => QuoteBoard | 'all';
  setMealPlanFilters: Dispatch<SetStateAction<Record<string, QuoteBoard | 'all'>>>;
  paneConfig?: QuotePaneConfig | null;
  paneRoomTypes: QuotePaneRoomType[];
  strictRoomTypes: boolean;
  paneBoards?: QuotePaneBoard[];
  onPatchGroup?: (groupId: string, patch: Partial<StayGroupRequirement>) => void;
  onStayAction?: (action: StayEditAction) => void;
  onPatchStayExtras?: (stayKey: string, extras: Partial<StaffStayExtras>) => void;
  onSelectStayKey?: (stayKey: string) => void;
}) {
  return (
    <Section step={3} title="Stay" id="quote-stay" action={<StepState state={stayReady ? 'Done' : 'Pending'} />}>
      {stays.map((stay, index) => (
        <div key={stay.rows[0]?.id ?? stay.id} className="flex flex-col gap-2">
          <StayAskChrome session={session} stay={stay} onSelectStayKey={onSelectStayKey} />
          <StayCard
            stayId={stay.id}
            rows={stay.rows}
            index={index}
            stayCount={stays.length}
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
          />
          {stay.rows[0] ? (
            <StayExtrasFields
              header={header}
              stayKey={stayKeyForGroup(stay.rows[0])}
              stayNumber={index + 1}
              onPatch={onPatchStayExtras}
            />
          ) : null}
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
    </Section>
  );
}
