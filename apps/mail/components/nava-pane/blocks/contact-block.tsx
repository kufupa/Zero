import type { ContactField, StoredContact } from '@/lib/quote-workflow/backend-bind';
import { Field, paneFieldClass, Section } from '../pane-ui';
import { useEffect, useRef, useState } from 'react';
import { copyText } from '@/components/quote-workflow/hms-link-actions';
import { currentPaneOwner, trackPaneAction } from '@/lib/quote-workflow/pane-telemetry';

// pii: guest details the preview gate masks (data-pii). The email-named line can include an end client.
const FIELDS: Array<{ field: ContactField; label: string; pii: boolean }> = [
  { field: 'name', label: 'Name', pii: true },
  { field: 'email', label: 'Email', pii: true },
  { field: 'phone', label: 'Phone', pii: true },
];

const NO_CONTACT: StoredContact = {
  name: null,
  company: null,
  endClient: null,
  email: null,
  phone: null,
};

/**
 * Contact block (U16, R4): booker contact details are editable; the email-named agency/client is a read-only note so
 * the same party has one editable home under Booked by. Copies record only the field name, never the copied value.
 */
export function ContactBlock({
  contact,
  senderFallback,
  onEdit,
}: {
  contact: StoredContact | null;
  senderFallback?: Pick<StoredContact, 'name' | 'email'> | null;
  onEdit: (field: ContactField, value: string | null) => void;
}) {
  // The block is keyed by the mail and its work item, so a new mail or a landed read starts from its own values.
  const [values, setValues] = useState<StoredContact>(() => ({
    ...NO_CONTACT,
    ...contact,
    name: contact?.name ?? senderFallback?.name ?? null,
    email: contact?.email ?? senderFallback?.email ?? null,
  }));
  const [feedback, setFeedback] = useState<{ field: ContactField; copied: boolean } | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const namedInEmail = [values.company, values.endClient].map((value) => value?.trim()).filter(Boolean).join(' · ');

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
  const copy = (field: ContactField) => copyValue(field, values[field] ?? '');
  return (
    <Section title="Contact" id="quote-contact">
      <div className="grid grid-cols-2 gap-x-2.5 gap-y-2">
        {FIELDS.map(({ field, label, pii }) => (
          <Field key={field} label={label} htmlFor={`quote-contact-${field}`}>
            <div className="flex min-w-0 gap-1">
              <input
                id={`quote-contact-${field}`}
                data-pii={pii || undefined}
                className={`${paneFieldClass} min-w-0`}
                maxLength={200}
                value={values[field] ?? ''}
                onChange={(event) => {
                  const next = event.target.value;
                  setValues((prev) => ({ ...prev, [field]: next }));
                  onEdit(field, next.trim() || null);
                }}
              />
              <button
                type="button"
                className="h-8 shrink-0 rounded-[3px] border border-[#cbd5e1] px-1.5 text-[10px] font-medium text-[#0066cc] disabled:cursor-not-allowed disabled:text-[#94a3b8]"
                aria-label={(feedback?.field === field && feedback.copied ? 'Copied ' : 'Copy ') + label.toLowerCase()}
                disabled={!values[field]?.trim()}
                onClick={() => void copy(field)}
              >
                {feedback?.field === field && feedback.copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            {feedback?.field === field && !feedback.copied ? (
              <span role="status" className="text-[10px] text-amber-900">
                Couldn&apos;t copy {label.toLowerCase()}.
              </span>
            ) : null}
          </Field>
        ))}
        <div className="col-span-2 flex min-w-0 items-start justify-between gap-2 border-t border-[#e2e8f0] pt-2">
          <p id="quote-contact-named-email" data-pii className="min-w-0 text-[13px] text-[#475569]">
            <span className="font-semibold">Named in email:</span>
            {` ${namedInEmail || '—'}`}
          </p>
          <button
            type="button"
            className="h-7 shrink-0 rounded-[3px] border border-[#cbd5e1] px-1.5 text-[10px] font-medium text-[#0066cc] disabled:cursor-not-allowed disabled:text-[#94a3b8]"
            aria-label={feedback?.field === 'company' && feedback.copied ? 'Copied named in email' : 'Copy named in email'}
            disabled={!namedInEmail}
            onClick={() => void copyValue('company', namedInEmail)}
          >
            {feedback?.field === 'company' && feedback.copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </Section>
  );
}
