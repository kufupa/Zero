'use client';

import { useEffect, useState } from 'react';
import type { BookingDraftReady, BookingRateCheck, StayGroupRequirement } from '@/lib/quote-workflow/types';

const fieldClass =
  'outline-hidden h-8 w-full rounded-xs border border-[#cbd5e1] bg-white px-2 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]';

const COPIED_MS = 1500;

const BOARD_LABELS: Record<string, string | undefined> = {
  room_only: 'Room only',
  bb: 'Bed & breakfast',
  dinner_bb: 'Dinner, bed & breakfast',
};

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
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

async function writeClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function RateCheckChip({ check }: { check: BookingRateCheck }) {
  if (check.status === 'match') {
    return (
      <p className="rounded-xs border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800">
        Price match
        {check.assumedTaxBasis ? ' · assumes VAT-inclusive' : ''}
      </p>
    );
  }
  if (check.status === 'mismatch') {
    return (
      <p className="rounded-xs border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
        Price mismatch: {check.claimQuote}
        {check.assumedTaxBasis ? ' · assumes VAT-inclusive' : ''}
      </p>
    );
  }
  return (
    <p className="rounded-xs border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
      Cannot check{check.reason ? `: ${check.reason}` : ''}
      {check.assumedTaxBasis ? ' · assumes VAT-inclusive' : ''}
    </p>
  );
}

function CopyButton({ label, roomIndex, value }: { label: string; roomIndex: number; value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      disabled={!value}
      aria-label={`${copied ? 'Copied' : 'Copy'} ${label} for room ${roomIndex}`}
      onClick={() => {
        void writeClipboard(value).then((ok) => {
          if (ok) setCopied(true);
        });
      }}
      className="h-6 shrink-0 rounded-xs border border-[#cbd5e1] bg-white px-2 text-[11px] font-semibold text-[#0066cc] disabled:text-[#94a3b8]"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function CopyRow({ label, roomIndex, value }: { label: string; roomIndex: number; value: string }) {
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="w-32 shrink-0 text-[11.5px] font-semibold text-[#475569]">{label}</span>
      <span className="min-w-0 flex-1 break-words text-[#1e293b]">{value || 'Not set'}</span>
      <CopyButton label={label} roomIndex={roomIndex} value={value} />
    </div>
  );
}

export function BookingCards({
  draft,
  groups = [],
}: {
  draft: BookingDraftReady;
  groups?: StayGroupRequirement[];
}) {
  const [choices, setChoices] = useState<Record<string, { track: string; sourceOfBusiness: string; guaranteeType: string }>>(
    () =>
      Object.fromEntries(
        draft.draft.rooms.map((room) => {
          const key = `${room.groupId}:${room.roomIndex}`;
          return [
            key,
            {
              track: textValue(room.request.track),
              sourceOfBusiness: textValue(room.request.sourceOfBusiness),
              guaranteeType: textValue(room.request.guaranteeType),
            },
          ];
        }),
      ),
  );

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-bold uppercase tracking-wider text-[#475569]">Booking draft</h3>
      <p className="text-[11px] text-[#64748b]">
        Saving in HMS from here is switched off for now. Click Copy next to each field and paste it into HMS Guest Stay.
      </p>
      {draft.draft.rateCheck.map((check, index) => (
        <RateCheckChip key={`${check.status}:${check.claimQuote}:${index}`} check={check} />
      ))}
      {draft.draft.flags.map((flag) => (
        <p key={flag} className="rounded-xs border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
          {flag}
        </p>
      ))}
      {draft.draft.missing.map((item) => (
        <p key={`${item.field}:${item.question}`} className="text-[11px] text-amber-800">
          {item.question}
        </p>
      ))}
      {draft.draft.rooms.map((room) => {
        const key = `${room.groupId}:${room.roomIndex}`;
        const choice = choices[key] ?? { track: '', sourceOfBusiness: '', guaranteeType: '' };
        const request = room.request;
        const group = groups.find((item) => item.id === room.groupId);
        const arrival = textValue(request.arrival);
        const departure = textValue(request.departure);
        const childCount = Array.isArray(request.childAges) ? request.childAges.length : 0;
        const party = textValue(request.agency) || textValue(request.organization);
        const roomIndex = room.roomIndex;
        return (
          <article
            key={key}
            className="shadow-xs flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3"
          >
            <h4 className="text-[12.5px] font-bold text-[#1e293b]">Room {roomIndex}</h4>
            <CopyRow roomIndex={roomIndex} label="Arrival" value={arrival} />
            <CopyRow roomIndex={roomIndex} label="Departure" value={departure} />
            <CopyRow roomIndex={roomIndex} label="Nights" value={nightsBetween(arrival, departure)} />
            <CopyRow roomIndex={roomIndex} label="Adults" value={countValue(request.adults)} />
            <CopyRow roomIndex={roomIndex} label="Children" value={String(childCount)} />
            <CopyRow roomIndex={roomIndex} label="Room type" value={textValue(request.roomType)} />
            <CopyRow roomIndex={roomIndex} label="Rate code" value={textValue(request.ratePlan)} />
            <CopyRow roomIndex={roomIndex} label="Meal plan" value={BOARD_LABELS[group?.board ?? ''] ?? ''} />
            <CopyRow roomIndex={roomIndex} label="Last name" value={textValue(request.lastName)} />
            <CopyRow roomIndex={roomIndex} label="First name" value={textValue(request.firstName)} />
            <CopyRow roomIndex={roomIndex} label="Company or travel agent" value={party} />
            <div className="flex items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
                Source of business
                <select
                  aria-label="Source of business"
                  className={fieldClass}
                  value={choice.sourceOfBusiness}
                  onChange={(event) =>
                    setChoices((current) => ({
                      ...current,
                      [key]: { ...choice, sourceOfBusiness: event.target.value },
                    }))
                  }
                >
                  <option value="">Select source</option>
                  {draft.options.sourceOfBusiness.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <CopyButton label="Source of business" roomIndex={roomIndex} value={choice.sourceOfBusiness} />
            </div>
            <div className="flex items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
                Track
                <select
                  aria-label="Track"
                  className={fieldClass}
                  value={choice.track}
                  onChange={(event) =>
                    setChoices((current) => ({
                      ...current,
                      [key]: { ...choice, track: event.target.value },
                    }))
                  }
                >
                  <option value="">Select track</option>
                  {draft.options.track.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <CopyButton label="Track" roomIndex={roomIndex} value={choice.track} />
            </div>
            <div className="flex items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
                Guarantee
                <select
                  aria-label="Guarantee"
                  className={fieldClass}
                  value={choice.guaranteeType}
                  onChange={(event) =>
                    setChoices((current) => ({
                      ...current,
                      [key]: { ...choice, guaranteeType: event.target.value },
                    }))
                  }
                >
                  <option value="">Select guarantee</option>
                  {draft.options.guaranteeType.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <CopyButton label="Guarantee" roomIndex={roomIndex} value={choice.guaranteeType} />
            </div>
            <CopyRow
              roomIndex={roomIndex}
              label="Special requests"
              value={(group?.specialRequests ?? []).join('; ')}
            />
            {room.schemaErrors.map((error) => (
              <p key={error} className="text-[11px] text-amber-800">
                {error}
              </p>
            ))}
          </article>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled
          className="h-8 rounded-xs border border-[#cbd5e1] bg-[#f8fafc] px-2 text-[12px] font-semibold text-[#94a3b8]"
        >
          Preview
        </button>
        <button
          type="button"
          disabled
          className="h-8 rounded-xs border border-[#cbd5e1] bg-[#f8fafc] px-2 text-[12px] font-semibold text-[#94a3b8]"
        >
          Commit
        </button>
        <button
          type="button"
          disabled
          className="h-8 rounded-xs border border-[#cbd5e1] bg-[#f8fafc] px-2 text-[12px] font-semibold text-[#94a3b8]"
        >
          Save
        </button>
      </div>
      <p className="text-[11px] text-[#64748b]">Saving from the pane is coming next — copy into HMS</p>
    </section>
  );
}
