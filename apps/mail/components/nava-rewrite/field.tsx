'use client';

import { useId } from 'react';
import styles from './pane.module.css';

type Choice = { value: string; label: string; meaning?: string | null };
type Review =
  | { provenance: 'ai'; kind: 'marker' }
  | { provenance: 'ai'; checked: boolean; onChange: (checked: boolean) => void; actionLabel: string; disabled?: boolean }
  | { provenance: 'staff' | 'hms' | 'unknown' };

type CommonField = {
  label: string;
  required?: boolean;
  disabled?: boolean;
  hint?: string;
  error?: string | null;
  review?: Review;
};

type TextField = {
  control: 'text' | 'number' | 'date' | 'textarea';
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  min?: string;
  max?: string;
  step?: string;
};
type ChoiceField = {
  control: 'select' | 'combobox';
  value: string;
  onChange: (value: string) => void;
  options: Choice[];
  placeholder?: string;
};
type CheckboxField = {
  control: 'checkbox';
  value: boolean;
  onChange: (value: boolean) => void;
};

export type PaneFieldProps = CommonField & (TextField | ChoiceField | CheckboxField);

function choiceLabel(option: Choice) {
  return option.meaning ? `${option.label} — ${option.meaning}` : option.label;
}

export function PaneField(props: PaneFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const review = props.review;
  const markerId = `${id}-ai`;
  const marker = review?.provenance === 'ai' && !('onChange' in review);
  const describedBy = [props.hint && hintId, props.error && errorId, marker && markerId].filter(Boolean).join(' ') || undefined;
  const common = { id, disabled: props.disabled, required: props.required, 'aria-invalid': Boolean(props.error), 'aria-describedby': describedBy };

  return <div className={styles.field}>
    <div className={styles.fieldHeading}>
      <label htmlFor={id}>{props.label}{props.required && <span aria-hidden="true"> *</span>}</label>
      {review?.provenance === 'ai' && ('onChange' in review ? <label className={styles.aiReview}>
        <input type="checkbox" checked={review.checked} disabled={props.disabled || review.disabled} onChange={event => review.onChange(event.target.checked)} aria-label={`${review.actionLabel}: ${props.label}`} />
        <span>AI generated · {review.actionLabel}</span>
      </label> : <label className={styles.aiReview} data-marker>
        <input type="checkbox" checked disabled aria-label={`AI generated: ${props.label}`} />
        <span id={markerId}>AI generated</span>
      </label>)}
    </div>
    {props.control === 'checkbox' ? <input {...common} type="checkbox" checked={props.value} onChange={event => props.onChange(event.target.checked)} />
      : props.control === 'textarea' ? <textarea {...common} value={props.value} placeholder={props.placeholder} onChange={event => props.onChange(event.target.value)} />
      : props.control === 'select' ? <select {...common} value={props.value} onChange={event => props.onChange(event.target.value)}>
        <option value="">{props.placeholder || 'Select'}</option>
        {props.value && !props.options.some(option => option.value === props.value) && <option value={props.value}>{props.value} — current value not in available options</option>}
        {props.options.map(option => <option key={option.value} value={option.value}>{choiceLabel(option)}</option>)}
      </select>
      : props.control === 'combobox' ? <>
        <input {...common} type="text" list={`${id}-options`} value={props.value} placeholder={props.placeholder} onChange={event => props.onChange(event.target.value)} />
        <datalist id={`${id}-options`}>{props.options.map(option => <option key={option.value} value={option.value} label={choiceLabel(option)} />)}</datalist>
      </>
      : <input {...common} type={props.control} value={props.value} placeholder={props.placeholder} min={'min' in props ? props.min : undefined} max={'max' in props ? props.max : undefined} step={'step' in props ? props.step : undefined} onChange={event => props.onChange(event.target.value)} />}
    {props.hint && <small id={hintId}>{props.hint}</small>}
    {props.error && <small id={errorId} className={styles.fieldError}>{props.error}</small>}
  </div>;
}
