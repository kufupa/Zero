import { useState } from 'react';
import type { ContactField, StoredContact } from '@/lib/quote-workflow/backend-bind';
import type { WorkItemProvenanceMap } from '@/lib/quote-workflow/use-work-item';
import { Field, paneFieldClass, Section } from '../pane-ui';
import { WorkItemFieldProvenance } from '../screens/work-item-field-provenance';
import { WorkItemResetButton } from '../screens/work-item-reset-button';

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
  embedded = false,
  onEdit,
  fieldProvenance = null,
  onResetToAi,
  resetPending = false,
}: {
  contact: StoredContact | null;
  /** Only a quote prints this contact on a PDF; other mail types show it as the plain contact. */
  quote?: boolean;
  /** Keeps an existing card boundary when this editor is part of a larger workflow card. */
  embedded?: boolean;
  senderFallback?: Pick<StoredContact, 'name' | 'email'> | null;
  onEdit: (field: ContactField, value: string | null) => void;
  fieldProvenance?: WorkItemProvenanceMap | null;
  onResetToAi?: () => void;
  resetPending?: boolean;
}) {
  const [values, setValues] = useState<StoredContact>(() => ({
    ...NO_CONTACT,
    ...contact,
    name: contact?.name ?? senderFallback?.name ?? null,
    email: contact?.email ?? senderFallback?.email ?? null,
  }));
  const [correcting, setCorrecting] = useState(false);
  const title = quote ? 'Quote contact — printed on the PDF' : 'Contact';

  const content = (
    <>
      <dl className="grid grid-cols-2 gap-x-2.5 gap-y-2">
        {FIELDS.map(({ field, label, pii }) => {
          const value = values[field]?.trim() ?? '';
          return (
            <div key={field} data-contact-field={field} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-[11.5px] font-semibold text-[#64748b]">{label}</dt>
              <dd data-pii={pii || undefined} className="flex min-w-0 items-start gap-1 text-[13px] text-[#1e293b]">
                <span className="min-w-0 break-words">{value || '—'}</span>
                <WorkItemFieldProvenance
                  fieldValue={values[field]}
                  provenance={fieldProvenance?.[`contact.${field}`]}
                />
              </dd>
            </div>
          );
        })}
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#e2e8f0] pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-expanded={correcting}
            disabled={resetPending}
            onClick={() => setCorrecting((open) => !open)}
            className="rounded-[3px] text-[12.5px] font-semibold text-[#0066cc] hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:text-[#94a3b8]"
          >
            {correcting ? 'Done' : 'Edit'}
          </button>
          {onResetToAi ? <WorkItemResetButton onClick={onResetToAi} pending={resetPending} /> : null}
        </div>
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
                disabled={resetPending}
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
    </>
  );

  return embedded ? (
    <div id="quote-contact" role="group" aria-label={title} className="flex flex-col gap-3.5">
      <h4 className="text-[12px] font-semibold text-[#475569]">{title}</h4>
      <div className="flex flex-col gap-3.5">{content}</div>
    </div>
  ) : (
    <Section title={title} id="quote-contact">
      {content}
    </Section>
  );
}
