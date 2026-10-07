'use client';

import { useState } from 'react';
import type { BookingDraftReady, BookingRateCheck } from '@/lib/quote-workflow/types';

const fieldClass =
  'outline-hidden h-8 w-full rounded-xs border border-[#cbd5e1] bg-white px-2 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]';

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
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

export function BookingCards({ draft }: { draft: BookingDraftReady }) {
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
      <p className="text-[11px] text-[#64748b]">Quoted room and rate codes. Track, source and guarantee stay local until pane save ships.</p>
      {draft.draft.rateCheck.map((check, index) => (
        <RateCheckChip key={`${check.status}:${check.claimQuote}:${index}`} check={check} />
      ))}
      {draft.draft.missing.map((item) => (
        <p key={`${item.field}:${item.question}`} className="text-[11px] text-amber-800">
          {item.question}
        </p>
      ))}
      {draft.draft.rooms.map((room) => {
        const key = `${room.groupId}:${room.roomIndex}`;
        const choice = choices[key] ?? { track: '', sourceOfBusiness: '', guaranteeType: '' };
        const party = textValue(room.request.agency) || textValue(room.request.organization);
        return (
          <article
            key={key}
            className="shadow-xs flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3"
          >
            <h4 className="text-[12.5px] font-bold text-[#1e293b]">Room {room.roomIndex}</h4>
            <p className="text-[11px] text-[#64748b]">
              {textValue(room.request.arrival)} → {textValue(room.request.departure)}
            </p>
            <p className="text-[12px] text-[#1e293b]">
              {textValue(room.request.roomType)} · {textValue(room.request.ratePlan)}
            </p>
            {party ? <p className="text-[12px] font-semibold text-[#1e293b]">{party}</p> : null}
            <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
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
            <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
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
            <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
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
            {room.schemaErrors.map((error) => (
              <p key={error} className="text-[11px] text-amber-800">
                {error}
              </p>
            ))}
          </article>
        );
      })}
      <button
        type="button"
        disabled
        className="h-8 rounded-xs border border-[#cbd5e1] bg-[#f8fafc] px-2 text-[12px] font-semibold text-[#94a3b8]"
      >
        Save
      </button>
      <p className="text-[11px] text-[#64748b]">Saving from the pane is coming next — copy into HMS</p>
    </section>
  );
}
