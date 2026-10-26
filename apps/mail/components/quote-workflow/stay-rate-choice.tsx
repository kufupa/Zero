import { Pencil } from 'lucide-react';
import { useId, useState } from 'react';

import { Field, paneFieldClass } from '@/components/nava-pane/pane-ui';

/** Sentinel for the Other choice. Not an HMS code — listed codes stay on the props. */
export const OTHER_RATE_VALUE = '__other_rate__';

const RATE_CODE_SHAPE = /^[A-Z0-9_-]{1,16}$/;
const RATE_CODE_MAX = 16;
const NOTE_MAX = 500;

export type StayRateOption = {
  rateCode: string;
  rateLabel?: string;
};

export type StayRateChoiceValue = {
  rateCode: string;
  source: 'listed' | 'other';
  authorisedBy: string;
};

function listedMatch(rates: readonly StayRateOption[], code: string): StayRateOption | undefined {
  const needle = code.trim().toUpperCase();
  if (!needle) return undefined;
  return rates.find((rate) => rate.rateCode.toUpperCase() === needle);
}

function optionLabel(rate: StayRateOption): string {
  const label = rate.rateLabel?.trim();
  if (!label || label === rate.rateCode) return rate.rateCode;
  return `${rate.rateCode}: ${label}`;
}

function readCustomCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Room-rate selector for one stay row. Other rate sits at the bottom of this list — never on the
 * "Showing rates for" filter. A typed code that HMS does not return stays selected; pencil-edit
 * keeps that selection and Authorised by.
 */
export function StayRateChoice({
  rates,
  value,
  onChange,
  disabled = false,
}: {
  rates: readonly StayRateOption[];
  value: StayRateChoiceValue;
  onChange: (next: StayRateChoiceValue) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [editingCustom, setEditingCustom] = useState(value.source === 'other' && !value.rateCode);
  const [draftCode, setDraftCode] = useState(value.rateCode);

  const match = listedMatch(rates, value.rateCode);
  const unmatchedCustom = value.source === 'other' && Boolean(value.rateCode) && !match;
  const otherOpen = value.source === 'other' && (editingCustom || !value.rateCode);
  const selectValue =
    value.source === 'other' && value.rateCode
      ? value.rateCode
      : value.source === 'other'
        ? OTHER_RATE_VALUE
        : value.rateCode;

  const commitCustom = (raw: string) => {
    const code = readCustomCode(raw);
    if (!code || !RATE_CODE_SHAPE.test(code)) {
      if (value.rateCode) {
        setDraftCode(value.rateCode);
        setEditingCustom(false);
      }
      return;
    }
    const listed = listedMatch(rates, code);
    onChange({
      rateCode: listed?.rateCode ?? code,
      source: 'other',
      authorisedBy: value.authorisedBy,
    });
    setDraftCode(listed?.rateCode ?? code);
    setEditingCustom(false);
  };

  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Room rate">
      <Field label="Rate code" htmlFor={`${id}-rate`}>
        <div className="flex items-center gap-1.5">
          <select
            id={`${id}-rate`}
            aria-label="Rate code"
            className={paneFieldClass}
            disabled={disabled}
            value={selectValue}
            onChange={(event) => {
              const next = event.target.value;
              if (next === OTHER_RATE_VALUE) {
                setDraftCode(value.source === 'other' ? value.rateCode : '');
                setEditingCustom(true);
                onChange({
                  rateCode: value.source === 'other' ? value.rateCode : '',
                  source: 'other',
                  authorisedBy: value.authorisedBy,
                });
                return;
              }
              const keepOther = value.source === 'other' && unmatchedCustom && next === value.rateCode;
              setEditingCustom(false);
              onChange({
                rateCode: next,
                source: keepOther ? 'other' : 'listed',
                authorisedBy: value.authorisedBy,
              });
            }}
          >
            <option value="">Choose a rate</option>
            {rates.map((rate) => (
              <option key={rate.rateCode} value={rate.rateCode}>
                {optionLabel(rate)}
              </option>
            ))}
            {unmatchedCustom ? <option value={value.rateCode}>{value.rateCode}</option> : null}
            <option value={OTHER_RATE_VALUE}>Other rate…</option>
          </select>
          {value.source === 'other' && value.rateCode && !otherOpen ? (
            <button
              type="button"
              aria-label="Edit rate code"
              title="Edit rate code"
              disabled={disabled}
              className="rounded-[3px] p-1 text-[#475569] hover:bg-[#f1f5f9]"
              onClick={() => {
                setDraftCode(value.rateCode);
                setEditingCustom(true);
              }}
            >
              <Pencil aria-hidden="true" className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </Field>
      {otherOpen ? (
        <Field label="Other rate code" htmlFor={`${id}-other`}>
          <input
            id={`${id}-other`}
            aria-label="Other rate code"
            maxLength={RATE_CODE_MAX}
            disabled={disabled}
            className={paneFieldClass}
            value={draftCode}
            onChange={(event) => setDraftCode(event.target.value)}
            onBlur={() => commitCustom(draftCode)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitCustom(draftCode);
              }
            }}
          />
        </Field>
      ) : null}
      {value.source === 'other' ? (
        <Field label="Authorised by" htmlFor={`${id}-note`} required>
          <input
            id={`${id}-note`}
            aria-label="Authorised by"
            maxLength={NOTE_MAX}
            disabled={disabled}
            className={paneFieldClass}
            value={value.authorisedBy}
            onChange={(event) => onChange({ ...value, source: 'other', authorisedBy: event.target.value })}
          />
        </Field>
      ) : null}
    </div>
  );
}
