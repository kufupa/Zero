'use client';

import { useId } from 'react';
import styles from './pane.module.css';
import fieldStyles from './field.module.css';

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
  return [option.value, option.label, option.meaning]
    .filter((part, index, parts) => part && parts.indexOf(part) === index)
    .join(' — ');
}

export function PaneField(props: PaneFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const review = props.review;
  const markerId = `${id}-ai`;
  const marker = review?.provenance === 'ai' && !('onChange' in review);
  const selectedChoice = props.control === 'combobox' ? props.options.find(option => option.value === props.value) : undefined;
  const choiceId = `${id}-choice`;
  const describedBy = [props.hint && hintId, props.error && errorId, marker && markerId, selectedChoice && choiceId].filter(Boolean).join(' ') || undefined;
  const common = { id, disabled: props.disabled, required: props.required, 'aria-invalid': Boolean(props.error), 'aria-describedby': describedBy };

  return <div className={styles.field}>
    <div className={styles.fieldHeading}>
      <label htmlFor={id}>{props.label}{props.required && <span aria-hidden="true"> *</span>}</label>
      {review?.provenance === 'ai' && ('onChange' in review ? <label className={styles.aiReview}>
        <input type="checkbox" checked={review.checked} disabled={props.disabled || review.disabled} onChange={event => review.onChange(event.target.checked)} aria-label={`${review.actionLabel}: ${props.label}`} />
        <span>AI generated · {review.actionLabel}</span>
      </label> : <span id={markerId} className={styles.aiReview} data-marker>AI generated</span>)}
    </div>
    {props.control === 'checkbox' ? <input {...common} type="checkbox" checked={props.value} onChange={event => props.onChange(event.target.checked)} />
      : props.control === 'textarea' ? <textarea {...common} value={props.value} placeholder={props.placeholder} onChange={event => props.onChange(event.target.value)} />
      : props.control === 'select' ? <select {...common} value={props.value} onChange={event => props.onChange(event.target.value)}>
        <option value="">{props.placeholder || 'Select'}</option>
        {props.value && !props.options.some(option => option.value === props.value) && <option value={props.value}>{props.value} — current value not in available options</option>}
        {props.options.map(option => <option key={option.value} value={option.value}>{choiceLabel(option)}</option>)}
      </select>
      : props.control === 'combobox' ? <>
        <div className={fieldStyles.choiceRow}>
          <input {...common} type="text" value={props.value} placeholder={props.placeholder} onChange={event => props.onChange(event.target.value)} />
          <select className={fieldStyles.choicePicker} aria-label={`Choose ${props.label}`} disabled={props.disabled || props.options.length === 0} value="" onChange={event => {
            const option = props.options[Number(event.target.value) - 1];
            if (option) props.onChange(option.value);
          }}>
            <option value="">Choose</option>
            {props.options.map((option, index) => <option key={`${option.value}-${index}`} value={String(index + 1)}>{choiceLabel(option)}</option>)}
          </select>
        </div>
        {selectedChoice && <small id={choiceId}>{choiceLabel(selectedChoice)}</small>}
      </>
      : <input {...common} type={props.control} value={props.value} placeholder={props.placeholder} min={'min' in props ? props.min : undefined} max={'max' in props ? props.max : undefined} step={'step' in props ? props.step : undefined} onChange={event => props.onChange(event.target.value)} />}
    {props.hint && <small id={hintId}>{props.hint}</small>}
    {props.error && <small id={errorId} className={styles.fieldError}>{props.error}</small>}
  </div>;
}
