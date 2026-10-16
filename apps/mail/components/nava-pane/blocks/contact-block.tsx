import { useState } from 'react';
import type { ContactField, StoredContact } from '@/lib/quote-workflow/backend-bind';
import { Field, paneFieldClass, Section } from '../pane-ui';

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

/** Read-only guest and company details from the email; corrections are scoped to this request, never written to HMS. */
export function ContactBlock({
  contact,
  senderFallback,
  quote = true,
  onEdit,
}: {
  contact: StoredContact | null;
  /** Only a quote prints this contact on a PDF; other mail types show it as the plain contact. */
  quote?: boolean;
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

  return (
    <Section
      title={quote ? 'Quote contact — printed on the PDF' : 'Contact'}
      id="quote-contact"
    >
      <dl className="grid grid-cols-2 gap-x-2.5 gap-y-2">
        {FIELDS.map(({ field, label, pii }) => {
          const value = values[field]?.trim() ?? '';
          return (
            <div key={field} data-contact-field={field} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-[11.5px] font-semibold text-[#64748b]">{label}</dt>
              <dd data-pii={pii || undefined} className="flex min-w-0 items-start gap-1 text-[13px] text-[#1e293b]">
                <span className="min-w-0 break-words">{value || '—'}</span>
              </dd>
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
          {correcting ? 'Done' : 'Edit'}
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
