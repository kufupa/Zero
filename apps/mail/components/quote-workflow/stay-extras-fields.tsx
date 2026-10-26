import { useEffect, useState } from 'react';
import { paneFieldClass } from '@/components/nava-pane/pane-ui';
import {
  EXTRA_AMOUNT_FORMAT_MESSAGE,
  parseCountInput,
  parseZarInput,
} from '@/lib/quote-workflow/zar-input';
import { staffStayExtrasFor } from '@/lib/quote-workflow/types';
import type {
  DinnerAddOnUnit,
  StaffExtraField,
  StaffQuoteHeader,
  StaffQuoteOtherUnit,
  StaffStayExtras,
} from '@/lib/quote-workflow/types';

function formatZarMinor(minor: number | undefined): string {
  return minor !== undefined && minor > 0 ? (minor / 100).toFixed(2).replace(/\.00$/, '') : '';
}

/**
 * A rand amount typed by staff. Text that cannot be read, or an amount over the cap, stays on screen with an
 * inline message and is reported to the quote gate. The saved amount is not changed by it.
 */
function ZarMinorInput({
  ariaLabel,
  minor,
  disabled = false,
  onMinorChange,
  onErrorChange,
}: {
  ariaLabel: string;
  minor: number | undefined;
  disabled?: boolean;
  onMinorChange: (minor: number | undefined) => void;
  /** Reports unreadable or over-cap text to the quote gate; null once the text reads cleanly. */
  onErrorChange?: (message: string | null) => void;
}) {
  const formatted = formatZarMinor(minor);
  const [draft, setDraft] = useState(formatted);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = (message: string | null) => {
    setError(message);
    onErrorChange?.(message);
  };
  useEffect(() => {
    if (!focused && !error) setDraft(formatted);
  }, [formatted, focused, error]);
  const apply = (raw: string) => {
    const result = parseZarInput(raw);
    if (result.status === 'ok') {
      report(null);
      onMinorChange(result.minor);
    } else if (result.status === 'empty') {
      report(null);
      onMinorChange(undefined);
    } else {
      report(result.status === 'partial' ? EXTRA_AMOUNT_FORMAT_MESSAGE : result.message);
    }
  };
  return (
    <>
      <input
        aria-label={ariaLabel}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        className={paneFieldClass}
        inputMode="decimal"
        value={focused || error ? draft : formatted}
        onFocus={() => {
          setDraft(formatted);
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          apply(draft.replace(/\.$/, ''));
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          apply(event.target.value);
        }}
      />
      {error ? <span className="mt-0.5 block text-[13px] font-normal text-[#b45309]">{error}</span> : null}
    </>
  );
}

/** A whole number of trips or days, up to max. Anything else is reported to the quote gate and not saved. */
function CountInput({
  ariaLabel,
  value,
  max,
  placeholder,
  onValueChange,
  onErrorChange,
}: {
  ariaLabel: string;
  value: number | undefined;
  max: number;
  placeholder?: string;
  onValueChange: (value: number | undefined) => void;
  onErrorChange?: (message: string | null) => void;
}) {
  const formatted = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(formatted);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = (message: string | null) => {
    setError(message);
    onErrorChange?.(message);
  };
  useEffect(() => {
    if (!focused && !error) setDraft(formatted);
  }, [formatted, focused, error]);
  const apply = (raw: string) => {
    const result = parseCountInput(raw, max);
    if (result.status === 'ok') {
      report(null);
      onValueChange(result.count);
    } else if (result.status === 'empty') {
      report(null);
      onValueChange(undefined);
    } else {
      report(result.message);
    }
  };
  return (
    <>
      <input
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        className={paneFieldClass}
        inputMode="numeric"
        placeholder={placeholder}
        value={focused || error ? draft : formatted}
        onFocus={() => {
          setDraft(formatted);
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          apply(draft);
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          apply(event.target.value);
        }}
      />
      {error ? <span className="mt-0.5 block text-[13px] font-normal text-[#b45309]">{error}</span> : null}
    </>
  );
}

function withoutFieldErrors(
  errors: Partial<Record<StaffExtraField, string>> | undefined,
  fields: StaffExtraField[],
): Partial<Record<StaffExtraField, string>> {
  const kept = { ...errors };
  for (const field of fields) delete kept[field];
  return kept;
}

/** Reports one stay extra's unreadable value without treating validation as a quote edit. */
function stayFieldErrorReporter(
  extras: StaffStayExtras,
  onPatch: ((stayKey: string, extras: Partial<StaffStayExtras>) => void) | undefined,
  stayKey: string,
  field: StaffExtraField,
) {
  return (message: string | null) => {
    const current = extras.fieldErrors ?? {};
    if ((current[field] ?? null) === message) return;
    const next: Partial<Record<StaffExtraField, string>> = { ...current };
    if (message) next[field] = message;
    else delete next[field];
    onPatch?.(stayKey, { fieldErrors: next });
  };
}

export function StayExtrasFields({
  header,
  stayKey,
  stayNumber,
  onPatch,
}: {
  header: StaffQuoteHeader;
  stayKey: string;
  stayNumber: number;
  onPatch?: (stayKey: string, extras: Partial<StaffStayExtras>) => void;
}) {
  const extras = staffStayExtrasFor(header, stayKey);
  const patch = (values: Partial<StaffStayExtras>) => onPatch?.(stayKey, values);
  const clearedErrors = (...fields: StaffExtraField[]) => withoutFieldErrors(extras.fieldErrors, fields);
  const otherNeedsLabel = Boolean(extras.otherEnabled && extras.other?.amountMinor) && !extras.other?.label?.trim();
  const chargeLine = (
    label: 'Shuttle' | 'Lunch allowance' | 'Dinner allowance' | 'Other',
    enabled: boolean,
    onEnabled: (checked: boolean) => void,
    amountLabel: string,
    amount: number | undefined,
    onAmountChange: (minor: number | undefined) => void,
    errorField: StaffExtraField,
    required = false,
  ) => (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(6rem,8rem)] items-center gap-x-2 gap-y-1.5 border-t border-[#e2e8f0] pt-2 first:border-t-0 first:pt-0">
      <label className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-[#475569]">
        <input
          type="checkbox"
          aria-label={label}
          checked={enabled}
          disabled={required}
          onChange={(event) => onEnabled(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      <ZarMinorInput
        ariaLabel={amountLabel}
        minor={amount}
        disabled={!enabled}
        onMinorChange={onAmountChange}
        onErrorChange={stayFieldErrorReporter(extras, onPatch, stayKey, errorField)}
      />
      {label === 'Shuttle' && enabled ? (
        <label className="col-span-2 grid grid-cols-[minmax(0,1fr)_minmax(6rem,8rem)] items-center gap-2 text-[13px] text-[#64748b]">
          <span>Trips</span>
          <CountInput
            ariaLabel="Shuttle trips"
            value={extras.shuttleTrips}
            max={50}
            placeholder="1"
            onValueChange={(shuttleTrips) => patch({ shuttleTrips })}
            onErrorChange={stayFieldErrorReporter(extras, onPatch, stayKey, 'shuttleTrips')}
          />
        </label>
      ) : null}
      {label === 'Lunch allowance' && enabled ? (
        <label className="col-span-2 grid grid-cols-[minmax(0,1fr)_minmax(6rem,8rem)] items-center gap-2 text-[13px] text-[#64748b]">
          <span>Note (optional)</span>
          <input
            aria-label="Lunch label"
            className={paneFieldClass}
            maxLength={120}
            value={extras.lunchAllowanceLabel ?? ''}
            onChange={(event) => patch({ lunchAllowanceLabel: event.target.value })}
          />
        </label>
      ) : null}
      {label === 'Dinner allowance' && enabled ? (
        <>
          <label className="col-span-2 grid grid-cols-[minmax(0,1fr)_minmax(6rem,8rem)] items-center gap-2 text-[13px] text-[#64748b]">
            <span>Charging unit</span>
            <select
              aria-label="Dinner add-on unit"
              className={paneFieldClass}
              value={extras.dinnerAllowanceUnit ?? ''}
              onChange={(event) => patch({ dinnerAllowanceUnit: event.target.value as DinnerAddOnUnit | undefined })}
            >
              <option value="">Choose a unit</option>
              <option value="per_person_per_night">Per person per night</option>
              <option value="per_room_per_night">Per room per night</option>
              <option value="per_person">Per person</option>
            </select>
          </label>
          <label className="col-span-2 grid grid-cols-[minmax(0,1fr)_minmax(6rem,8rem)] items-center gap-2 text-[13px] text-[#64748b]">
            <span>Label (optional)</span>
            <input
              aria-label="Dinner label"
              className={paneFieldClass}
              maxLength={120}
              value={extras.dinnerAllowanceLabel ?? ''}
              onChange={(event) => patch({ dinnerAllowanceLabel: event.target.value })}
            />
          </label>
        </>
      ) : null}
      {label === 'Other' ? (
        <>
          <label className="col-span-2 grid grid-cols-[minmax(0,1fr)_minmax(6rem,8rem)] items-center gap-2 text-[13px] text-[#64748b]">
            <span>Label</span>
            <input
              aria-label="Other label"
              aria-invalid={otherNeedsLabel || undefined}
              className={paneFieldClass}
              disabled={!enabled}
              maxLength={120}
              placeholder="e.g. Parking"
              value={extras.other?.label ?? ''}
              onChange={(event) =>
                patch({ other: { unit: extras.other?.unit ?? 'item', ...extras.other, label: event.target.value } })
              }
            />
          </label>
          <label className="col-span-2 grid grid-cols-[minmax(0,1fr)_minmax(6rem,8rem)] items-center gap-2 text-[13px] text-[#64748b]">
            <span>Unit</span>
            <select
              aria-label="Other unit"
              className={paneFieldClass}
              disabled={!enabled}
              value={extras.other?.unit ?? 'item'}
              onChange={(event) =>
                patch({
                  other: {
                    label: extras.other?.label ?? '',
                    amountMinor: extras.other?.amountMinor,
                    unit: event.target.value as StaffQuoteOtherUnit,
                  },
                })
              }
            >
              <option value="per_person_night">R per person per night</option>
              <option value="per_person">R per person</option>
              <option value="per_trip">R per trip</option>
              <option value="item">R once (item)</option>
            </select>
          </label>
          {otherNeedsLabel ? <p className="col-span-2 text-[13px] text-[#b45309]">Add a label for this amount.</p> : null}
        </>
      ) : null}
      {label === 'Dinner allowance' && required ? (
        <p className="col-span-2 text-[13px] text-[#475569]">
          {!(amount && amount > 0)
            ? 'Dinner price — enter amount'
            : !extras.dinnerAllowanceUnit
              ? 'Choose how the dinner price is charged.'
              : 'Run Get rates again to apply the dinner price before documents can be made.'}
        </p>
      ) : null}
    </div>
  );

  return (
    <section role="group" aria-label={`Extras for Stay ${stayNumber}`} className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2.5">
      <h5 className="text-[13px] font-semibold text-[#475569]">Extras</h5>
      {chargeLine(
        'Shuttle',
        extras.shuttleEnabled,
        (shuttleEnabled) =>
          patch({ shuttleEnabled, ...(!shuttleEnabled ? { fieldErrors: clearedErrors('shuttleAmount', 'shuttleTrips') } : {}) }),
        'Shuttle amount',
        extras.shuttleMinor,
        (shuttleMinor) => patch({ shuttleMinor }),
        'shuttleAmount',
      )}
      {chargeLine(
        'Lunch allowance',
        extras.lunchEnabled,
        (lunchEnabled) => patch({ lunchEnabled, ...(!lunchEnabled ? { fieldErrors: clearedErrors('lunchAllowance') } : {}) }),
        'Lunch allowance amount',
        extras.lunchAllowanceMinor,
        (lunchAllowanceMinor) => patch({ lunchAllowanceMinor }),
        'lunchAllowance',
      )}
      {chargeLine(
        'Dinner allowance',
        extras.dinnerEnabled,
        (dinnerEnabled) => patch({ dinnerEnabled, ...(!dinnerEnabled ? { fieldErrors: clearedErrors('dinnerAllowance') } : {}) }),
        'Dinner allowance amount',
        extras.dinnerAllowanceMinor,
        (dinnerAllowanceMinor) => patch({ dinnerAllowanceMinor }),
        'dinnerAllowance',
        Boolean(extras.dinnerAllowanceRequired),
      )}
      {chargeLine(
        'Other',
        extras.otherEnabled,
        (otherEnabled) => patch({ otherEnabled, ...(!otherEnabled ? { fieldErrors: clearedErrors('otherAmount') } : {}) }),
        'Other amount',
        extras.other?.amountMinor,
        (amountMinor) => patch({ other: { label: extras.other?.label ?? '', unit: extras.other?.unit ?? 'item', amountMinor } }),
        'otherAmount',
      )}
    </section>
  );
}
