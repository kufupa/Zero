import { useEffect, useRef, useState } from 'react';
import type { ContactField, StoredContact } from '@/lib/quote-workflow/backend-bind';
import { currentPaneOwner, trackPaneAction } from '@/lib/quote-workflow/pane-telemetry';
import { copyText } from '@/components/quote-workflow/hms-link-actions';
import { Field, paneFieldClass, Section, StepState } from '../pane-ui';

const FIELDS: Array<{ field: ContactField; label: string; pii: boolean }> = [
  { field: 'name', label: 'Name', pii: true },
  { field: 'email', label: 'Email', pii: true },
  { field: 'phone', label: 'Phone', pii: true },
  { field: 'company', label: 'Company', pii: false },
  { field: 'endClient', label: 'End client', pii: true },
];

const NO_CONTACT: StoredContact = {
  name: null,
  company: null,
  endClient: null,
  email: null,
  phone: null,
};

/** Read-only guest and company details from the email; corrections are scoped to this request, never written to HMS. */
export function ContactBlock({
  contact,
  senderFallback,
  onEdit,
}: {
  contact: StoredContact | null;
  senderFallback?: Pick<StoredContact, 'name' | 'email'> | null;
  onEdit: (field: ContactField, value: string | null) => void;
}) {
  const [values, setValues] = useState<StoredContact>(() => ({
    ...NO_CONTACT,
    ...contact,
    name: contact?.name ?? senderFallback?.name ?? null,
    email: contact?.email ?? senderFallback?.email ?? null,
  }));
  const [correcting, setCorrecting] = useState(false);
  const [feedback, setFeedback] = useState<{ field: ContactField; copied: boolean } | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ready = Boolean(values.name?.trim() || values.email?.trim());

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copyValue = async (field: ContactField, value: string) => {
    if (!value.trim()) return;
    // The owner is read before the clipboard write, so a switch of mail while it is pending does not move the copy.
    const owner = currentPaneOwner();
    const copied = await copyText(value);
    setFeedback({ field, copied });
    if (copied) trackPaneAction({ type: 'copy.contact', field }, owner);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setFeedback(null), 2000);
  };

  return (
    <Section
      title="Guest & contact"
      step={1}
      id="quote-contact"
      action={<StepState state={ready ? 'Done' : 'Pending'} />}
    >
      <dl className="grid grid-cols-2 gap-x-2.5 gap-y-2">
        {FIELDS.map(({ field, label, pii }) => {
          const value = values[field]?.trim() ?? '';
          return (
            <div key={field} data-contact-field={field} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-[11.5px] font-semibold text-[#64748b]">{label}</dt>
              <dd data-pii={pii || undefined} className="flex min-w-0 items-start justify-between gap-1 text-[13px] text-[#1e293b]">
                <span className="min-w-0 break-words">{value || '—'}</span>
                <button
                  type="button"
                  className="h-6 shrink-0 rounded-[3px] px-1.5 text-[10px] font-medium text-[#0066cc] disabled:cursor-not-allowed disabled:text-[#94a3b8]"
                  aria-label={(feedback?.field === field && feedback.copied ? 'Copied ' : 'Copy ') + label.toLowerCase()}
                  disabled={!value}
                  onClick={() => void copyValue(field, value)}
                >
                  {feedback?.field === field && feedback.copied ? 'Copied' : 'Copy'}
                </button>
              </dd>
              {feedback?.field === field && !feedback.copied ? (
                <span role="status" className="text-[10px] text-amber-900">
                  Couldn&apos;t copy {label.toLowerCase()}.
                </span>
              ) : null}
            </div>
          );
        })}
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#e2e8f0] pt-2">
        <button
          type="button"
          aria-expanded={correcting}
          onClick={() => setCorrecting((open) => !open)}
          className="rounded-[3px] text-[12.5px] font-semibold text-[#0066cc] hover:underline"
        >
          {correcting ? 'Hide corrections' : 'Correct'}
        </button>
        <p className="text-[11.5px] text-[#64748b]">Corrections save to this request only. HMS is not changed.</p>
      </div>
      {correcting ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {FIELDS.map(({ field, label, pii }) => (
            <Field key={field} label={label} htmlFor={`quote-contact-${field}`}>
              <input
                id={`quote-contact-${field}`}
                data-pii={pii || undefined}
                className={paneFieldClass}
                maxLength={200}
                value={values[field] ?? ''}
                onChange={(event) => {
                  const next = event.target.value;
                  setValues((prev) => ({ ...prev, [field]: next }));
                  onEdit(field, next.trim() || null);
                }}
              />
            </Field>
          ))}
        </div>
      ) : null}
    </Section>
  );
}
