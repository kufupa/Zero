import { addDays, addMonths, format, isValid, parseISO, subMonths } from 'date-fns';
import { ChevronLeft, ChevronRight, Moon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { DateRange } from 'react-day-picker';

import { Calendar } from '@/components/ui/calendar';
import { Field, FromEmailTag, LinkButton, paneFieldClass } from '@/components/nava-pane/pane-ui';
import type { FactProvenance } from '@/lib/quote-workflow/types';

const ISO = 'yyyy-MM-dd';
const QUICK_NIGHTS = [1, 2, 3, 7];

export type StayDatePatch = { arrivalDate?: string; departureDate?: string };

/** A stored yyyy-MM-dd date as a local Date, or undefined when it is empty or invalid. */
function toDate(iso: string): Date | undefined {
  if (!iso) return undefined;
  const date = parseISO(iso);
  return isValid(date) ? date : undefined;
}

/** Nights between two yyyy-MM-dd dates. Both parse as UTC midnight, so daylight saving cannot shift the count. */
function nightsFor(arrival: string, departure: string): number | null {
  if (!arrival || !departure) return null;
  const nights = (Date.parse(departure) - Date.parse(arrival)) / 86_400_000;
  return Number.isFinite(nights) ? nights : null;
}

// The shadcn calendar's own caption keeps its own month, so a controlled month needs our header instead.
function NoCaption() {
  return null;
}

const CALENDAR_CLASSES = {
  head_cell: 'w-8 pb-1 text-center text-[10px] font-bold text-[#64748b]',
  cell: 'relative h-8 w-8 p-0 text-center text-[12px]',
  day: 'h-8 w-8 rounded-[2px] p-0 text-[12px] font-normal hover:bg-[#e2e8f0] aria-selected:opacity-100',
  day_selected: 'bg-[#1a4332] font-bold text-white hover:bg-[#1a4332] hover:text-white focus:bg-[#1a4332] focus:text-white',
  day_range_middle: 'aria-selected:bg-[#eaf4ee] aria-selected:text-[#1a4332]',
  day_today: 'font-bold text-[#0066cc]',
};

const NAV_BUTTON = 'flex h-6 w-6 items-center justify-center rounded-[3px] border border-[#e2e8f0] bg-[#f8fafc] text-[#475569] hover:bg-[#e2e8f0]';

/** Where a value came from: the email gets the design's tag, staff and defaults get a small chip. */
export function ProvenanceFlag({ value }: { value?: FactProvenance }) {
  if (!value) return null;
  if (value === 'extracted') return <FromEmailTag />;
  const label = value === 'staff_corrected' ? 'Your note' : value === 'missing' ? 'Missing' : 'Default';
  return (
    <span className="rounded-xs bg-[#f1f5f9] px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#64748b]">
      {label}
    </span>
  );
}

function DateTile({
  caption,
  value,
  active,
  provenance,
  onClick,
}: {
  caption: string;
  value?: Date;
  active: boolean;
  provenance?: FactProvenance;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-col gap-0.5 border-b-2 px-2.5 py-2 text-left transition-colors hover:bg-[#f8fafc] ${
        active ? 'border-[#1a4332] bg-[#eaf4ee]' : 'border-transparent'
      }`}
    >
      <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.3px] text-[#64748b]">
        {caption}
        <ProvenanceFlag value={provenance} />
      </span>
      <span className={value ? 'text-[13px] font-bold text-[#1e293b]' : 'text-[13px] text-[#94a3b8]'}>
        {value ? format(value, 'EEE d MMM yyyy') : 'Pick a date'}
      </span>
    </button>
  );
}

/**
 * The arrival and departure of one stay. Two tiles show the dates; "Change dates" opens a calendar on the arrival
 * month, quick pills set the length, and the native date inputs stay available under "or type dates".
 */
export function StayDateRange({
  arrival,
  departure,
  provenance,
  onChange,
}: {
  /** yyyy-MM-dd, or '' when not set. */
  arrival: string;
  departure: string;
  provenance?: { arrival?: FactProvenance; departure?: FactProvenance };
  onChange: (patch: StayDatePatch) => void;
}) {
  const id = useId();
  const arrivalDate = toDate(arrival);
  const departureDate = toDate(departure);
  const nights = nightsFor(arrival, departure);
  const [open, setOpen] = useState(false);
  // Which tile the next calendar click fills in.
  const [end, setEnd] = useState<'arrival' | 'departure'>(arrival && !departure ? 'departure' : 'arrival');
  const [month, setMonth] = useState<Date>(() => arrivalDate ?? departureDate ?? new Date());

  // Follow the arrival month when the arrival changes, so the calendar opens on the stay, not today.
  useEffect(() => {
    const picked = toDate(arrival);
    if (picked) setMonth(picked);
  }, [arrival]);

  function openAt(next: 'arrival' | 'departure') {
    setOpen(true);
    setEnd(next);
  }

  function pickDay(day: Date) {
    const picked = format(day, ISO);
    if (end === 'departure' && arrival && picked > arrival) {
      onChange({ departureDate: picked });
      return;
    }
    if (end === 'arrival') {
      onChange({ arrivalDate: picked, departureDate: departure > picked ? departure : '' });
      setEnd('departure');
      return;
    }
    // A day on or before the arrival starts the stay again.
    onChange({ arrivalDate: picked, departureDate: '' });
  }

  function stayFor(n: number) {
    if (arrivalDate) onChange({ departureDate: format(addDays(arrivalDate, n), ISO) });
  }

  const range: DateRange = { from: arrivalDate, to: departureDate };
  const nightsText =
    nights === null
      ? 'Pick both dates'
      : nights > 0
        ? `${nights} ${nights === 1 ? 'night' : 'nights'}`
        : 'Check the dates';

  return (
    <div className="overflow-hidden rounded-[3px] border border-[#cbd5e1]">
      <div className="grid grid-cols-2 divide-x divide-[#e2e8f0]">
        <DateTile
          caption="Arrival date"
          value={arrivalDate}
          active={open && end === 'arrival'}
          provenance={provenance?.arrival}
          onClick={() => openAt('arrival')}
        />
        <DateTile
          caption="Departure date"
          value={departureDate}
          active={open && end === 'departure'}
          provenance={provenance?.departure}
          onClick={() => openAt('departure')}
        />
      </div>
      <div className="flex items-center justify-between border-t border-[#e2e8f0] bg-[#f8fafc] px-2.5 py-1.5 text-[11.5px] text-[#475569]">
        <span className="flex items-center gap-1.5">
          <Moon aria-hidden="true" className="h-3 w-3" />
          {nightsText}
        </span>
        <LinkButton ariaExpanded={open} onClick={() => setOpen((value) => !value)}>
          Change dates {open ? '▴' : '▾'}
        </LinkButton>
      </div>
      <div hidden={!open} className="space-y-2 border-t border-[#e2e8f0] bg-white p-2.5">
        {open ? (
          <>
            <div className="flex items-center justify-between">
              <button type="button" aria-label="Previous month" className={NAV_BUTTON} onClick={() => setMonth((m) => subMonths(m, 1))}>
                <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
              <span className="text-[12px] font-bold text-[#1e293b]">{format(month, 'MMMM yyyy')}</span>
              <button type="button" aria-label="Next month" className={NAV_BUTTON} onClick={() => setMonth((m) => addMonths(m, 1))}>
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </div>
            <Calendar
              mode="range"
              numberOfMonths={1}
              weekStartsOn={1}
              showOutsideDays={false}
              month={month}
              onMonthChange={setMonth}
              selected={range}
              onSelect={(_range, day) => pickDay(day)}
              components={{ Caption: NoCaption }}
              classNames={CALENDAR_CLASSES}
            />
            <div className="grid grid-cols-4 gap-1 border-t border-[#e2e8f0] pt-2">
              {QUICK_NIGHTS.map((n) => (
                <button
                  key={n}
                  type="button"
                  disabled={!arrivalDate}
                  aria-pressed={nights === n}
                  onClick={() => stayFor(n)}
                  className={`rounded-[2px] border py-1 text-[10.5px] transition-colors disabled:cursor-not-allowed disabled:text-[#cbd5e1] ${
                    nights === n
                      ? 'border-[#1a4332] bg-[#eaf4ee] font-bold text-[#1a4332]'
                      : 'border-[#e2e8f0] bg-[#f8fafc] text-[#475569] hover:bg-[#e2e8f0]'
                  }`}
                >
                  {n} {n === 1 ? 'night' : 'nights'}
                </button>
              ))}
            </div>
          </>
        ) : null}
        <p className="text-[11px] text-[#64748b]">or type dates</p>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Arrival" htmlFor={`${id}-arrival`}>
            <input
              id={`${id}-arrival`}
              type="date"
              aria-label="Arrival"
              className={paneFieldClass}
              value={arrival}
              onChange={(event) => onChange({ arrivalDate: event.target.value })}
            />
          </Field>
          <Field label="Departure" htmlFor={`${id}-departure`}>
            <input
              id={`${id}-departure`}
              type="date"
              aria-label="Departure"
              className={paneFieldClass}
              value={departure}
              onChange={(event) => onChange({ departureDate: event.target.value })}
            />
          </Field>
        </div>
      </div>
    </div>
  );
}
