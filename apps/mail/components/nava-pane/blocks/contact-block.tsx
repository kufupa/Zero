import type { ContactField, StoredContact } from '@/lib/quote-workflow/backend-bind';
import { Field, paneFieldClass, Section } from '../pane-ui';
import { useEffect, useRef, useState } from 'react';
import { copyText } from '@/components/quote-workflow/hms-link-actions';
import { currentPaneOwner, trackPaneAction } from '@/lib/quote-workflow/pane-telemetry';

// pii: a guest detail the preview gate masks (data-pii). The company or agency is a business name.
const FIELDS: Array<{ field: ContactField; label: string; pii: boolean }> = [
  { field: 'name', label: 'Name', pii: true },
  { field: 'company', label: 'Company / agency', pii: false },
  { field: 'endClient', label: 'End client', pii: true },
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
 * Contact block (U16, R4): the core details from the email, at the top of the pane. Each field is editable, and each
 * change goes to onEdit as it is typed (the pane debounces it into one event). During extraction, the caller may provide
 * a verified external sender fallback for name and email. Copies record only the field name, never the copied value.
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

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async (field: ContactField) => {
    const value = values[field] ?? '';
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
      </div>
    </Section>
  );
}
